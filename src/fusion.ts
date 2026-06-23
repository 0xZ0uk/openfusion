import { config } from "./config.js";
import { createModuleLogger } from "./logger.js";
import {
  JUDGE_SYSTEM_PROMPT,
  PANEL_SYSTEM_PROMPT,
  buildJudgeUserMessage,
  buildOuterSystemPrompt,
  formatSearchResults,
} from "./prompts.js";
import { searchWeb, SEARCH_TOOL } from "./search.js";
import type {
  FusionConfig,
  FusionResult,
  PanelJudgeResult,
  PanelResponse,
  LiteLLMCompletionRequest,
  LLMAdapter,
  Usage,
} from "./types.js";

const log = createModuleLogger("fusion");

interface FusionInput {
  messages: { role: string; content: string }[];
  fusionConfig: Required<FusionConfig>;
  llm: LLMAdapter;
}

function getLastUserMessage(
  messages: { role: string; content: string }[],
): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return last?.content ?? "";
}

/**
 * Run just the panel + judge stages (no outer model).
 * This is used by both non-streaming and streaming flows.
 */
export async function runFusionPanelJudge(
  input: FusionInput,
): Promise<PanelJudgeResult> {
  const { messages, fusionConfig, llm } = input;
  const { panel, judge, max_tokens, temperature } = fusionConfig;

  const pipelineStart = Date.now();
  log.info("Panel+judge pipeline start", {
    panel_models: panel,
    judge_model: judge,
    user_messages: messages.filter((m) => m.role === "user").length,
  });

  // ---- Step 1: parallel panel calls ----
  log.info("Panel stage: starting parallel calls", { count: panel.length });
  const panelMessages = [
    { role: "system" as const, content: PANEL_SYSTEM_PROMPT },
    ...messages as LiteLLMCompletionRequest["messages"],
  ];
  const panelParams: LiteLLMCompletionRequest[] = panel.map((model) => ({
    model,
    messages: panelMessages,
    temperature,
    max_tokens,
  }));

  const panelStart = Date.now();
  const panelSettled = await Promise.allSettled(
    panelParams.map((p) => llm.complete(p)),
  );
  const panelDuration = Date.now() - panelStart;

  const panelResponses: PanelResponse[] = [];
  let panelPromptTokens = 0;
  let panelCompletionTokens = 0;
  let panelFailures = 0;

  for (let i = 0; i < panel.length; i++) {
    const result = panelSettled[i];
    const modelName = panel[i];
    if (result.status === "fulfilled") {
      panelResponses.push({
        model: modelName,
        content: result.value.content,
      });
      if (result.value.usage) {
        panelPromptTokens += result.value.usage.prompt_tokens;
        panelCompletionTokens += result.value.usage.completion_tokens;
      }
      log.info("Panel model succeeded", {
        model: modelName,
        content_length: result.value.content.length,
        usage: result.value.usage,
      });
    } else {
      panelFailures++;
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      log.error("Panel model failed", { model: modelName, error: reason });
      panelResponses.push({
        model: modelName,
        content: `[Panel error: ${reason}]`,
        error: true,
      });
    }
  }

  log.info("Panel stage complete", {
    durationMs: panelDuration,
    successes: panel.length - panelFailures,
    failures: panelFailures,
    total_prompt_tokens: panelPromptTokens,
    total_completion_tokens: panelCompletionTokens,
  });

  // ---- Step 2: judge analysis ----
  log.info("Judge stage: starting analysis", { judge_model: judge });
  const judgeMessages = [
    { role: "system" as const, content: JUDGE_SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: buildJudgeUserMessage(messages, panelResponses),
    },
  ];

  const judgeStart = Date.now();
  const judgeResult = await llm.complete({
    model: judge,
    messages: judgeMessages,
    temperature: 0.5,
    max_tokens: Math.min(max_tokens, 4096),
    response_format: { type: "json_object" },
  });
  const judgeDuration = Date.now() - judgeStart;

  let analysis: Record<string, unknown>;
  try {
    analysis = JSON.parse(judgeResult.content);
    log.info("Judge analysis parsed successfully", {
      durationMs: judgeDuration,
      consensus_count: Array.isArray(analysis.consensus) ? analysis.consensus.length : 0,
      contradictions_count: Array.isArray(analysis.contradictions) ? analysis.contradictions.length : 0,
    });
  } catch {
    log.error("Judge returned invalid JSON", {
      content_preview: judgeResult.content.slice(0, 300),
    });
    analysis = {
      raw_analysis: judgeResult.content,
      summary: judgeResult.content,
    };
  }

  const totalPrompt =
    panelPromptTokens + (judgeResult.usage?.prompt_tokens ?? 0);
  const totalCompletion =
    panelCompletionTokens + (judgeResult.usage?.completion_tokens ?? 0);

  const totalDuration = Date.now() - pipelineStart;
  log.info("Panel+judge pipeline complete", {
    totalDurationMs: totalDuration,
    panelDurationMs: panelDuration,
    judgeDurationMs: judgeDuration,
    total_prompt_tokens: totalPrompt,
    total_completion_tokens: totalCompletion,
  });

  return {
    panelResponses,
    analysis: analysis as unknown as PanelJudgeResult["analysis"],
    judgeRawContent: judgeResult.content,
    usage: {
      prompt_tokens: totalPrompt,
      completion_tokens: totalCompletion,
      total_tokens: totalPrompt + totalCompletion,
    },
  };
}

/**
 * Build the outer model request params (used by both streaming and non-streaming paths).
 */
export function buildOuterModelRequest(
  judgeRawContent: string,
  messages: { role: string; content: string }[],
  outerModel: string,
  temperature: number,
  max_tokens: number,
  tools?: LiteLLMCompletionRequest["tools"],
): LiteLLMCompletionRequest {
  const outerSystemPrompt = buildOuterSystemPrompt(judgeRawContent);

  return {
    model: outerModel,
    messages: [
      { role: "system", content: outerSystemPrompt },
      ...messages,
    ] as LiteLLMCompletionRequest["messages"],
    temperature,
    max_tokens,
    ...(tools ? { tools } : {}),
  };
}

/**
 * Run just the outer model stage: resolve messages (including web search if enabled)
 * and return the final message array. The caller is responsible for the final LLM call
 * (streaming or non-streaming).
 */
export async function runOuterModel(
  judgeRawContent: string,
  messages: { role: string; content: string }[],
  fusionConfig: Required<FusionConfig>,
  llm: LLMAdapter,
): Promise<{
  resolvedMessages: LiteLLMCompletionRequest["messages"];
  usage: Usage;
}> {
  const { outer_model: outerModel, web_search, temperature, max_tokens } = fusionConfig;

  if (web_search && config.search.enabled) {
    log.info("Outer model: web search enabled");
    const outerReq = buildOuterModelRequest(
      judgeRawContent,
      messages,
      outerModel,
      temperature,
      max_tokens,
      [SEARCH_TOOL],
    );

    const resolved = await llm.resolveTools(outerReq, async (_name, args) => {
      const query = (args.query as string) || getLastUserMessage(messages);
      const results = await searchWeb(query);
      log.info("Outer model search handler", {
        query: query.slice(0, 100),
        results_count: results.length,
      });
      return formatSearchResults(results) || "No results found.";
    });

    return {
      resolvedMessages: resolved.messages,
      usage: resolved.usage,
    };
  }

  const outerReq = buildOuterModelRequest(
    judgeRawContent,
    messages,
    outerModel,
    temperature,
    max_tokens,
  );

  return {
    resolvedMessages: outerReq.messages,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Run the full Fusion pipeline (non-streaming):
 *   1. Parallel panel calls  →  panel responses
 *   2. Judge analysis        →  structured JSON
 *   3. Outer model           →  final composed answer (with optional search tool)
 */
export async function runFusion(input: FusionInput): Promise<FusionResult> {
  const { messages, fusionConfig, llm } = input;
  const { outer_model: outerModel } = fusionConfig;

  const totalStart = Date.now();

  // Panel + judge
  const { panelResponses, analysis, judgeRawContent, usage } =
    await runFusionPanelJudge(input);

  // Step 3: outer model (if configured)
  if (outerModel) {
    log.info("Outer model stage: starting", { outer_model: outerModel });
    const outerStart = Date.now();

    const outerResult = await runOuterModel(
      judgeRawContent,
      messages,
      fusionConfig,
      llm,
    );

    const finalResult = await llm.complete({
      model: outerModel,
      messages: outerResult.resolvedMessages,
      temperature: fusionConfig.temperature,
      max_tokens: fusionConfig.max_tokens,
    });

    const outerDuration = Date.now() - outerStart;
    const totalDuration = Date.now() - totalStart;

    const totalUsage = {
      prompt_tokens: usage.prompt_tokens + outerResult.usage.prompt_tokens + (finalResult.usage?.prompt_tokens ?? 0),
      completion_tokens: usage.completion_tokens + outerResult.usage.completion_tokens + (finalResult.usage?.completion_tokens ?? 0),
      total_tokens: usage.total_tokens + outerResult.usage.total_tokens + (finalResult.usage?.total_tokens ?? 0),
    };

    log.info("Fusion pipeline complete", {
      totalDurationMs: totalDuration,
      outerDurationMs: outerDuration,
      outer_model: outerModel,
      final_answer_length: finalResult.content.length,
      usage: totalUsage,
    });

    return {
      finalAnswer: finalResult.content,
      panelResponses,
      analysis,
      judgeRawContent,
      usage: totalUsage,
    };
  }

  // No outer model — return judge analysis as the answer
  const totalDuration = Date.now() - totalStart;
  log.info("Fusion pipeline complete (no outer model)", {
    totalDurationMs: totalDuration,
    usage,
  });

  return {
    finalAnswer: judgeRawContent,
    panelResponses,
    analysis,
    judgeRawContent,
    usage,
  };
}

/**
 * Resolve defaults and validate fusion config from a request.
 */
export function resolveFusionConfig(
  fusionConfig: FusionConfig | undefined,
  requestModel: string,
): Required<FusionConfig> {
  const defaults = config.defaults;

  let panel = fusionConfig?.panel ?? defaults.panel;
  if (panel.length === 0) panel = defaults.panel;
  if (panel.length > 8) panel = panel.slice(0, 8);

  return {
    panel,
    judge: fusionConfig?.judge ?? defaults.judge,
    outer_model: fusionConfig?.outer_model ?? defaults.outerModel,
    max_tokens: fusionConfig?.max_tokens ?? 4096,
    temperature: fusionConfig?.temperature ?? 0.7,
    web_search: fusionConfig?.web_search ?? false,
  };
}

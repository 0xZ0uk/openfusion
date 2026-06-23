import { config } from "./config.js";
import { callLiteLLM } from "./litellm.js";
import {
  JUDGE_SYSTEM_PROMPT,
  buildJudgeUserMessage,
  buildOuterSystemPrompt,
  formatSearchResults,
} from "./prompts.js";
import { searchWeb } from "./search.js";
import type {
  FusionConfig,
  FusionResult,
  PanelJudgeResult,
  PanelResponse,
  LiteLLMCompletionRequest,
} from "./types.js";

interface FusionInput {
  messages: { role: string; content: string }[];
  fusionConfig: Required<FusionConfig>;
}

function getLastUserMessage(
  messages: { role: string; content: string }[],
): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return last?.content ?? "";
}

/**
 * Step 0: Web search for relevant context.
 * Returns formatted context string (empty if disabled or no results).
 */
async function maybeSearch(
  messages: { role: string; content: string }[],
  webSearchEnabled: boolean,
): Promise<string> {
  if (!webSearchEnabled || !config.search.enabled) return "";

  const query = getLastUserMessage(messages);
  if (!query) return "";

  const results = await searchWeb(query);
  if (results.length === 0) return "";

  console.log(
    `[fusion] Web search returned ${results.length} results for: ${query.slice(60)}${query.length > 60 ? "…" : ""}`,
  );
  return formatSearchResults(results);
}

/**
 * Run just the panel + judge stages (no outer model).
 * This is used by both non-streaming and streaming flows.
 */
export async function runFusionPanelJudge(
  input: FusionInput,
): Promise<PanelJudgeResult> {
  const { messages, fusionConfig } = input;
  const { panel, judge, max_tokens, temperature, web_search } = fusionConfig;

  // Step 0: web search
  const searchContext = await maybeSearch(messages, web_search);

  // Build messages with search context for panel
  const panelMessages = searchContext
    ? [
        { role: "system" as const, content: searchContext },
        ...messages,
      ]
    : messages;

  // ---- Step 1: parallel panel calls ----
  const panelParams: LiteLLMCompletionRequest[] = panel.map((model) => ({
    model,
    messages: panelMessages,
    temperature,
    max_tokens,
  }));

  const panelSettled = await Promise.allSettled(
    panelParams.map((p) => callLiteLLM(p)),
  );

  const panelResponses: PanelResponse[] = [];
  let panelPromptTokens = 0;
  let panelCompletionTokens = 0;

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
    } else {
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      console.error(`[fusion] Panel model ${modelName} failed: ${reason}`);
      panelResponses.push({
        model: modelName,
        content: `[Panel error: ${reason}]`,
        error: true,
      });
    }
  }

  // ---- Step 2: judge analysis ----
  const judgeMessages = [
    { role: "system" as const, content: JUDGE_SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: buildJudgeUserMessage(panelMessages, panelResponses),
    },
  ];

  const judgeResult = await callLiteLLM({
    model: judge,
    messages: judgeMessages,
    temperature: 0.3, // low temp for objective analysis
    max_tokens: Math.min(max_tokens, 4096),
    response_format: { type: "json_object" },
  });

  let analysis: Record<string, unknown>;
  try {
    analysis = JSON.parse(judgeResult.content);
  } catch {
    console.error("[fusion] Judge returned invalid JSON, wrapping raw output");
    analysis = {
      raw_analysis: judgeResult.content,
      summary: judgeResult.content,
    };
  }

  const totalPrompt =
    panelPromptTokens + (judgeResult.usage?.prompt_tokens ?? 0);
  const totalCompletion =
    panelCompletionTokens + (judgeResult.usage?.completion_tokens ?? 0);

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
  searchContext: string,
  messages: { role: string; content: string }[],
  outerModel: string,
  temperature: number,
  max_tokens: number,
): LiteLLMCompletionRequest {
  const outerSystemPrompt = buildOuterSystemPrompt(
    judgeRawContent,
    searchContext,
  );
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");

  return {
    model: outerModel,
    messages: [
      { role: "system", content: outerSystemPrompt },
      ...(lastUserMsg
        ? [{ role: "user" as const, content: lastUserMsg.content }]
        : []),
    ],
    temperature,
    max_tokens,
  };
}

/**
 * Run the full Fusion pipeline (non-streaming):
 *   1. Web search (optional)
 *   2. Parallel panel calls  →  panel responses
 *   3. Judge analysis        →  structured JSON
 *   4. Outer model           →  final composed answer
 */
export async function runFusion(input: FusionInput): Promise<FusionResult> {
  const { messages, fusionConfig } = input;
  const { outer_model: outerModel } = fusionConfig;

  // Panel + judge
  const { panelResponses, analysis, judgeRawContent, usage } =
    await runFusionPanelJudge(input);

  // Step 0 shared — run search again for outer model context
  const searchContext = await maybeSearch(
    messages,
    fusionConfig.web_search,
  );

  // Step 3: outer model (if configured)
  if (outerModel) {
    const outerReq = buildOuterModelRequest(
      judgeRawContent,
      searchContext,
      messages,
      outerModel,
      fusionConfig.temperature,
      fusionConfig.max_tokens,
    );

    const outerResult = await callLiteLLM(outerReq);
    return {
      finalAnswer: outerResult.content,
      panelResponses,
      analysis,
      judgeRawContent,
      usage,
    };
  }

  // No outer model — return judge analysis as the answer
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
    web_search: fusionConfig?.web_search ?? true,
  };
}

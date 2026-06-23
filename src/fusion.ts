import { config } from "./config.js";
import { cleanResponse } from "./cleaner.js";
import { createModuleLogger } from "./logger.js";
import {
  JUDGE_SYSTEM_PROMPT,
  PANEL_SYSTEM_PROMPT,
  EXPLORER_PROMPT,
  COMPOSER_PROMPT,
  buildJudgeUserMessage,
  formatSearchResults,
} from "./prompts.js";
import { searchWeb, SEARCH_TOOL } from "./search.js";
import {
  EXPLORER_TOOLS,
  handleExplorerTool,
  extractExplorationContext,
  getExplorerCwd,
} from "./explorer.js";
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

export interface FusionInput {
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

// ──────────────────────────────────────────────
// Phase 1: Outer model explores the codebase
// ──────────────────────────────────────────────

export async function runExploration(
  input: FusionInput,
): Promise<{
  explorationContext: string;
  exploreUsage: Usage;
}> {
  const { messages, fusionConfig, llm } = input;
  const { outer_model: outerModel, temperature, max_tokens } = fusionConfig;

  if (!outerModel) {
    return { explorationContext: "", exploreUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  }

  const cwd = getExplorerCwd();
  log.info("Phase 1: Starting codebase exploration", {
    outer_model: outerModel,
    cwd,
  });

  const exploreReq: LiteLLMCompletionRequest = {
    model: outerModel,
    messages: [
      { role: "system", content: EXPLORER_PROMPT },
      ...messages,
    ] as LiteLLMCompletionRequest["messages"],
    temperature,
    max_tokens,
    tools: EXPLORER_TOOLS,
    tool_choice: "auto",
  };

  const exploreStart = Date.now();
  const resolved = await llm.resolveTools(exploreReq, async (name, args) => {
    return handleExplorerTool(name, args, cwd);
  });
  const exploreDuration = Date.now() - exploreStart;

  // Extract context from the resolved messages
  const explorationContext = extractExplorationContext(resolved.messages);

  log.info("Phase 1: Exploration complete", {
    durationMs: exploreDuration,
    context_length: explorationContext.length,
    tool_turns: resolved.messages.filter((m) => m.role === "tool").length,
    usage: resolved.usage,
  });

  return {
    explorationContext,
    exploreUsage: resolved.usage,
  };
}

// ──────────────────────────────────────────────
// Phase 2+3: Panel + Judge (shared by both paths)
// ──────────────────────────────────────────────

export async function runFusionPanelJudge(
  input: FusionInput & { explorationContext?: string },
): Promise<PanelJudgeResult> {
  const { messages, fusionConfig, llm, explorationContext } = input;
  const { panel, judge, max_tokens, temperature } = fusionConfig;

  const pipelineStart = Date.now();
  log.info("Phase 2: Panel+judge pipeline start", {
    panel_models: panel,
    judge_model: judge,
    has_exploration_context: !!explorationContext,
  });

  // ---- Phase 2: parallel panel calls ----
  log.info("Panel stage: starting parallel calls", { count: panel.length });

  // Build panel messages: exploration context + panel prompt + user messages
  const panelMessages: LiteLLMCompletionRequest["messages"] = [
    { role: "system", content: PANEL_SYSTEM_PROMPT },
  ];

  // Inject exploration context as a system message so panel models have data
  if (explorationContext) {
    panelMessages.push({
      role: "system",
      content: `## Codebase Exploration Findings\n\nHere is what was discovered about the codebase during initial exploration:\n\n${explorationContext}\n\n---\nAnalyze the above findings. Provide your own assessment.`,
    });
  }

  // Add the original user messages
  panelMessages.push(...messages as LiteLLMCompletionRequest["messages"]);

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
      const hasToolCalls = (result.value as any).tool_calls?.length > 0;
      const hasContent = result.value.content && result.value.content.length > 0;
      let content = result.value.content;
      if (!hasContent && hasToolCalls) {
        const toolNames = (result.value as any).tool_calls
          .map((tc: any) => tc.function?.name ?? "unknown")
          .join(", ");
        content = `[Model returned tool calls (${toolNames}) instead of text — response skipped]`;
        log.warn("Panel model returned tool calls instead of text", {
          model: modelName,
          tools: toolNames,
        });
      } else if (hasContent) {
        const cleaned = cleanResponse(content, modelName);
        if (cleaned !== content) {
          log.info("Panel model response cleaned", {
            model: modelName,
            before: content.length,
            after: cleaned.length,
          });
          content = cleaned;
        }
      }
      panelResponses.push({ model: modelName, content });
      if (result.value.usage) {
        panelPromptTokens += result.value.usage.prompt_tokens;
        panelCompletionTokens += result.value.usage.completion_tokens;
      }
      log.info("Panel model succeeded", {
        model: modelName,
        content_length: content.length,
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

  // ---- Phase 3: judge analysis ----
  log.info("Phase 3: Judge stage starting", { judge_model: judge });

  // Build judge messages with exploration context + panel responses
  let judgeUserContent = buildJudgeUserMessage(messages, panelResponses);
  if (explorationContext) {
    judgeUserContent =
      `## Codebase Exploration Context\n\n${explorationContext}\n\n---\n\n${judgeUserContent}`;
  }

  const judgeMessages = [
    { role: "system" as const, content: JUDGE_SYSTEM_PROMPT },
    { role: "user" as const, content: judgeUserContent },
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
      consensus_count: Array.isArray(analysis.consensus)
        ? analysis.consensus.length
        : 0,
      contradictions_count: Array.isArray(analysis.contradictions)
        ? analysis.contradictions.length
        : 0,
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

// ──────────────────────────────────────────────
// Phase 4: Outer model composes final answer
// ──────────────────────────────────────────────

/**
 * Build the Phase 4 composition request.
 * The outer model gets: COMPOSER_PROMPT + exploration context + panel responses +
 * judge analysis + original messages + explorer tools.
 */
export async function runComposition(
  judgeRawContent: string,
  panelResponses: PanelResponse[],
  explorationContext: string,
  messages: { role: string; content: string }[],
  fusionConfig: Required<FusionConfig>,
  llm: LLMAdapter,
): Promise<{ resolvedMessages: LiteLLMCompletionRequest["messages"]; usage: Usage }> {
  const { outer_model: outerModel, temperature, max_tokens } = fusionConfig;

  // Format panel responses for context
  const panelSummary = panelResponses
    .map(
      (r) =>
        `--- ${r.model} ---${r.error ? " [ERROR]" : ""}\n${r.content || "(no response)"}`,
    )
    .join("\n\n");

  const contextParts: string[] = [];
  if (explorationContext) {
    contextParts.push(`## Codebase Exploration\n${explorationContext}`);
  }
  contextParts.push(`## Panel Analyses\n${panelSummary}`);
  contextParts.push(`## Judge Evaluation\n${judgeRawContent}`);

  const cwd = getExplorerCwd();

  const composeReq: LiteLLMCompletionRequest = {
    model: outerModel,
    messages: [
      { role: "system", content: `${COMPOSER_PROMPT}\n\n${contextParts.join("\n\n")}` },
      // Include the user's original messages so the outer model remembers the request
      ...messages,
    ] as LiteLLMCompletionRequest["messages"],
    temperature,
    max_tokens,
    tools: EXPLORER_TOOLS,
    tool_choice: "auto",
  };

  const resolved = await llm.resolveTools(composeReq, async (name, args) => {
    return handleExplorerTool(name, args, cwd);
  });

  return {
    resolvedMessages: resolved.messages,
    usage: resolved.usage,
  };
}

// ──────────────────────────────────────────────
// Full pipeline (non-streaming)
// ──────────────────────────────────────────────

export async function runFusion(input: FusionInput): Promise<FusionResult> {
  const { messages, fusionConfig, llm } = input;
  const { outer_model: outerModel } = fusionConfig;

  const totalStart = Date.now();

  // Phase 1: Explore
  const { explorationContext, exploreUsage } = await runExploration(input);

  // Phase 2+3: Panel + Judge
  const { panelResponses, analysis, judgeRawContent, usage: pjUsage } =
    await runFusionPanelJudge({
      ...input,
      explorationContext,
    });

  // Phase 4: Compose
  if (outerModel) {
    log.info("Phase 4: Outer model composition starting", {
      outer_model: outerModel,
    });
    const composeStart = Date.now();

    const { usage: composeUsage } = await runComposition(
      judgeRawContent,
      panelResponses,
      explorationContext,
      messages,
      fusionConfig,
      llm,
    );

    // The last assistant message in resolvedMessages is the final answer
    // Actually, we need to extract it. Let's get it from a final complete call.
    // Re-run with just messages (no tools) to get clean final text
    const finalMessages = buildFinalMessages(
      judgeRawContent,
      panelResponses,
      explorationContext,
      messages,
      fusionConfig,
    );

    const finalResult = await llm.complete({
      model: outerModel,
      messages: finalMessages,
      temperature: fusionConfig.temperature,
      max_tokens: fusionConfig.max_tokens,
    });

    const cleanedAnswer = cleanResponse(finalResult.content, outerModel);
    if (cleanedAnswer !== finalResult.content) {
      log.info("Final answer cleaned", {
        before: finalResult.content.length,
        after: cleanedAnswer.length,
      });
    }

    const composeDuration = Date.now() - composeStart;
    const totalDuration = Date.now() - totalStart;

    const totalUsage = {
      prompt_tokens:
        exploreUsage.prompt_tokens +
        pjUsage.prompt_tokens +
        composeUsage.prompt_tokens +
        (finalResult.usage?.prompt_tokens ?? 0),
      completion_tokens:
        exploreUsage.completion_tokens +
        pjUsage.completion_tokens +
        composeUsage.completion_tokens +
        (finalResult.usage?.completion_tokens ?? 0),
      total_tokens:
        exploreUsage.total_tokens +
        pjUsage.total_tokens +
        composeUsage.total_tokens +
        (finalResult.usage?.total_tokens ?? 0),
    };

    log.info("Fusion pipeline complete", {
      totalDurationMs: totalDuration,
      composeDurationMs: composeDuration,
      outer_model: outerModel,
      final_answer_length: cleanedAnswer.length,
      usage: totalUsage,
    });

    return {
      finalAnswer: cleanedAnswer,
      panelResponses,
      analysis,
      judgeRawContent,
      usage: totalUsage,
    };
  }

  // No outer model — return judge analysis
  log.info("Fusion pipeline complete (no outer model)", {
    totalDurationMs: Date.now() - totalStart,
    usage: pjUsage,
  });

  return {
    finalAnswer: judgeRawContent,
    panelResponses,
    analysis,
    judgeRawContent,
    usage: pjUsage,
  };
}

/**
 * Build the final message array for the outer model's last call (no tools).
 * This gives the outer model one clean shot at producing the answer.
 */
function buildFinalMessages(
  judgeRawContent: string,
  panelResponses: PanelResponse[],
  explorationContext: string,
  messages: { role: string; content: string }[],
  fusionConfig: Required<FusionConfig>,
): LiteLLMCompletionRequest["messages"] {
  const panelSummary = panelResponses
    .map(
      (r) =>
        `--- ${r.model} ---${r.error ? " [ERROR]" : ""}\n${r.content || "(no response)"}`,
    )
    .join("\n\n");

  const contextParts: string[] = [];
  if (explorationContext) {
    contextParts.push(`## Codebase Exploration\n${explorationContext}`);
  }
  contextParts.push(`## Panel Analyses\n${panelSummary}`);
  contextParts.push(`## Judge Evaluation\n${judgeRawContent}`);

  return [
    {
      role: "system",
      content: `${COMPOSER_PROMPT}\n\n${contextParts.join("\n\n")}`,
    },
    ...messages,
  ] as LiteLLMCompletionRequest["messages"];
}

// ──────────────────────────────────────────────
// Config resolver
// ──────────────────────────────────────────────

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

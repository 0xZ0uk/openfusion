import { streamSSE } from "hono/streaming";
import { createModuleLogger } from "../logger.js";
import { cleanResponse } from "../cleaner.js";
import { runFusionPanelJudge, runExploration } from "../fusion.js";
import { COMPOSER_PROMPT } from "../prompts.js";
import type { LLMAdapter } from "../types.js";

const log = createModuleLogger("stream");

export async function handleFusionStream(
  c: any,
  messages: { role: string; content: string }[],
  fc: any,
  reqId: string,
  reqStart: number,
  llm: LLMAdapter,
) {
  const fusionId = `fusion-${reqId.split("-")[0]}`;

  return streamSSE(c, async (stream) => {
    try {
      // Phase 1: Outer model explores the codebase with tools
      log.info("Streaming: Phase 1 — exploration", { reqId });
      const { explorationContext } = await runExploration({
        messages,
        fusionConfig: fc,
        llm,
      });

      // Phase 2+3: Panel + Judge
      log.info("Streaming: Phase 2+3 — panel and judge", { reqId });
      const { panelResponses, analysis, judgeRawContent } =
        await runFusionPanelJudge({
          messages,
          fusionConfig: fc,
          llm,
          explorationContext,
        });

      // Phase 4: Compose — one call to synthesize the final answer
      // (No tool loop here — Phase 1 already explored the codebase)
      log.info("Streaming: Phase 4 — composition", { reqId });

      // Build the composition context
      const panelSummary = panelResponses
        .map(
          (r: any) =>
            `--- ${r.model} ---${r.error ? " [ERROR]" : ""}\n${r.content || "(no response)"}`,
        )
        .join("\n\n");

      const contextParts: string[] = [];
      if (explorationContext) {
        contextParts.push(`## Codebase Exploration\n${explorationContext}`);
      }
      contextParts.push(`## Panel Analyses\n${panelSummary}`);
      contextParts.push(`## Judge Evaluation\n${judgeRawContent}`);

      const compositionMessages = [
        {
          role: "system" as const,
          content: `${COMPOSER_PROMPT}\n\n${contextParts.join("\n\n")}`,
        },
        ...messages,
      ];

      const composeStart = Date.now();
      const composeResult = await llm.complete({
        model: fc.outer_model,
        messages: compositionMessages,
        temperature: fc.temperature,
        max_tokens: fc.max_tokens,
      });

      log.info("Phase 4: composition complete", {
        durationMs: Date.now() - composeStart,
        content_length: composeResult.content.length,
      });

      const rawContent = composeResult.content ?? "";

      // Clean agent artifacts from the final answer
      const cleanedContent = cleanResponse(rawContent, fc.outer_model);
      if (cleanedContent !== rawContent) {
        log.info("Streaming: final answer cleaned", {
          before: rawContent.length,
          after: cleanedContent.length,
        });
      }

      // Role-first chunk (OpenAI convention)
      stream.writeSSE({
        data: JSON.stringify({
          id: fusionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: fc.outer_model,
          choices: [
            { index: 0, delta: { role: "assistant" }, finish_reason: null },
          ],
        }),
      });

      // Stream the cleaned response
      if (cleanedContent) {
        stream.writeSSE({
          data: JSON.stringify({
            id: fusionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: fc.outer_model,
            choices: [
              {
                index: 0,
                delta: { content: cleanedContent },
                finish_reason: null,
              },
            ],
          }),
        });
      }

      // Finish chunk
      stream.writeSSE({
        data: JSON.stringify({
          id: fusionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: fc.outer_model,
          choices: [
            { index: 0, delta: {}, finish_reason: "stop" },
          ],
        }),
      });

      // Fusion metadata
      stream.writeSSE({
        data: JSON.stringify({
          id: fusionId,
          object: "fusion.metadata",
          fusion_metadata: {
            panel: fc.panel,
            judge: fc.judge,
            web_search: fc.web_search,
            panel_responses: panelResponses.map((r: any) => ({
              model: r.model,
              error: r.error ?? false,
              content_length: r.content.length,
            })),
            analysis,
          },
        }),
      });

      stream.writeSSE({ data: "[DONE]" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Streaming fusion error", {
        reqId,
        error: message,
        durationMs: Date.now() - reqStart,
      });
      stream.writeSSE({
        data: JSON.stringify({
          error: {
            message: `Fusion stream failed: ${message}`,
            type: "fusion_error",
          },
        }),
      });
      stream.writeSSE({ data: "[DONE]" });
    }
  });
}

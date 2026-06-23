import { streamSSE } from "hono/streaming";
import { createModuleLogger } from "../logger.js";
import { cleanResponse } from "../cleaner.js";
import { runFusionPanelJudge, runOuterModel } from "../fusion.js";
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
      // 1. Panel + judge (internal, not streamed)
      log.info("Streaming: running panel+judge phase", { reqId });
      const { panelResponses, analysis, judgeRawContent } =
        await runFusionPanelJudge({
          messages,
          fusionConfig: fc,
          llm,
        });

      // 2. No outer model → return judge analysis directly
      if (!fc.outer_model) {
        log.info("Streaming: no outer model, returning judge analysis", { reqId });
        stream.writeSSE({
          data: JSON.stringify({
            id: fusionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: fc.judge,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: judgeRawContent },
                finish_reason: "stop",
              },
            ],
          }),
        });
        stream.writeSSE({ data: "[DONE]" });
        return;
      }

      // 3. Resolve outer model messages (including web search if enabled)
      log.info("Streaming: resolving outer model messages", { reqId });
      const outerResult = await runOuterModel(
        judgeRawContent,
        messages,
        fc,
        llm,
      );

      // 4. Collect outer model response (non-streaming), clean it, then stream
      log.info("Streaming: collecting outer model response", {
        reqId,
        outer_model: fc.outer_model,
      });

      const outerModelResult = await llm.complete({
        model: fc.outer_model,
        messages: outerResult.resolvedMessages,
        temperature: fc.temperature,
        max_tokens: fc.max_tokens,
      });

      const cleanedContent = cleanResponse(outerModelResult.content, fc.outer_model);
      if (cleanedContent !== outerModelResult.content) {
        log.info("Streaming: outer model response cleaned", {
          model: fc.outer_model,
          before: outerModelResult.content.length,
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

      // Stream the cleaned response in a single chunk
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

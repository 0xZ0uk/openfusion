import { streamSSE } from "hono/streaming";
import { createModuleLogger } from "../logger.js";
import { runFusionPanelJudge, runOuterModel } from "../fusion.js";
import { callLiteLLMStream } from "../litellm.js";
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

      // 4. Stream outer model
      log.info("Streaming: starting outer model stream", {
        reqId,
        outer_model: fc.outer_model,
      });

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

      let streamedContent = "";
      for await (const chunk of callLiteLLMStream({
        model: fc.outer_model,
        messages: outerResult.resolvedMessages,
        temperature: fc.temperature,
        max_tokens: fc.max_tokens,
      })) {
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
          streamedContent += choice.delta.content;
          stream.writeSSE({
            data: JSON.stringify({
              id: fusionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: fc.outer_model,
              choices: [
                {
                  index: 0,
                  delta: { content: choice.delta.content },
                  finish_reason: null,
                },
              ],
            }),
          });
        }
        if (choice?.finish_reason) {
          stream.writeSSE({
            data: JSON.stringify({
              id: fusionId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: fc.outer_model,
              choices: [
                { index: 0, delta: {}, finish_reason: choice.finish_reason },
              ],
            }),
          });
        }
      }

      log.info("Streaming: outer model stream complete", {
        reqId,
        durationMs: Date.now() - reqStart,
        content_length: streamedContent.length,
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

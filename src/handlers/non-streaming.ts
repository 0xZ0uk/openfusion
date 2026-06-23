import { createModuleLogger } from "../logger.js";
import { runFusion } from "../fusion.js";
import type { LLMAdapter } from "../types.js";

const log = createModuleLogger("nonstream");

export async function handleFusionNonStream(
  c: any,
  messages: { role: string; content: string }[],
  fc: any,
  reqId: string,
  reqStart: number,
  llm: LLMAdapter,
) {
  try {
    const result = await runFusion({
      messages,
      fusionConfig: fc,
      llm,
    });

    const durationMs = Date.now() - reqStart;
    log.info("Non-streaming fusion response sent", {
      reqId,
      durationMs,
      final_answer_length: result.finalAnswer.length,
      usage: result.usage,
    });

    return c.json({
      id: `fusion-${reqId.split("-")[0]}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: fc.outer_model || fc.judge,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.finalAnswer },
          finish_reason: "stop",
        },
      ],
      usage: result.usage,
      fusion_metadata: {
        panel: fc.panel,
        judge: fc.judge,
        web_search: fc.web_search,
        panel_responses: result.panelResponses.map((r: any) => ({
          model: r.model,
          error: r.error ?? false,
          content_length: r.content.length,
        })),
        analysis: result.analysis,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Non-streaming fusion pipeline error", {
      reqId,
      error: message,
      durationMs: Date.now() - reqStart,
    });
    return c.json(
      {
        error: {
          message: `Fusion pipeline failed: ${message}`,
          type: "fusion_error",
        },
      },
      502,
    );
  }
}

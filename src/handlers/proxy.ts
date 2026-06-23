import { config } from "../config.js";
import { createModuleLogger } from "../logger.js";

const log = createModuleLogger("proxy");

export async function proxyToLiteLLM(c: any, body: Record<string, unknown>, reqId: string) {
  const { stream, ...rest } = body as any;
  const litellmUrl = `${config.litellm.baseUrl}/v1/chat/completions`;

  try {
    log.info("Proxying to LiteLLM", {
      reqId,
      model: rest.model,
      stream: !!stream,
      messages: rest.messages?.length,
    });

    const proxyStart = Date.now();
    const resp = await fetch(litellmUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.litellm.apiKey}`,
      },
      body: JSON.stringify(rest),
    });

    if (stream) {
      log.info("LiteLLM proxy stream response", {
        reqId,
        status: resp.status,
        durationMs: Date.now() - proxyStart,
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers,
      });
    }

    const data = await resp.json();
    log.info("LiteLLM proxy response", {
      reqId,
      status: resp.status,
      durationMs: Date.now() - proxyStart,
      model: data.model,
      usage: data.usage,
    });
    return c.json(data, resp.status as any);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("LiteLLM proxy error", { reqId, error: message });
    return c.json({ error: `LiteLLM proxy error: ${message}` }, 502);
  }
}

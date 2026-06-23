import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { config } from "./config.js";
import { createModuleLogger } from "./logger.js";
import {
  runFusion,
  runFusionPanelJudge,
  resolveFusionConfig,
  buildOuterModelRequest,
} from "./fusion.js";
import { callLiteLLMStream, resolveTools } from "./litellm.js";
import { searchWeb, SEARCH_TOOL } from "./search.js";
import { formatSearchResults } from "./prompts.js";

const appLog = createModuleLogger("app");

// ---- Zod schemas ----

const messageSchema = z.object({
  role: z.string(),
  content: z.string(),
});

const fusionConfigSchema = z.object({
  panel: z.array(z.string()).min(1).max(8).optional(),
  judge: z.string().optional(),
  outer_model: z.string().optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  web_search: z.boolean().optional(),
});

const fusionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(messageSchema).min(1),
  fusion_config: fusionConfigSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
});

// ---- App ----

const app = new Hono();

app.use("*", cors());

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/v1/models", async (c) => {
  try {
    const resp = await fetch(`${config.litellm.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${config.litellm.apiKey}` },
    });
    const data = await resp.json();
    return c.json(data);
  } catch {
    return c.json({ error: "Cannot reach LiteLLM proxy" }, 502);
  }
});

// ---- Main handler ----

app.post("/v1/chat/completions", async (c) => {
  const reqStart = Date.now();
  const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (config.server.apiKey) {
    const auth = c.req.header("Authorization");
    if (
      !auth ||
      !auth.startsWith("Bearer ") ||
      auth.slice(7) !== config.server.apiKey
    ) {
      appLog.warn("Request rejected: unauthorized", { reqId, ip: c.req.header("x-forwarded-for") });
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  const body = await c.req.json().catch(() => null);
  if (!body) {
    appLog.warn("Request rejected: invalid JSON", { reqId });
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = fusionRequestSchema.safeParse(body);
  if (!parsed.success) {
    appLog.warn("Request rejected: validation failed", {
      reqId,
      issues: parsed.error.issues,
    });
    return c.json(
      { error: "Validation failed", details: parsed.error.issues },
      400,
    );
  }

  const { messages, fusion_config, temperature, max_tokens, stream } =
    parsed.data;
  const isFusion = fusion_config !== undefined || parsed.data.model === "fusion";

  appLog.info("Request received", {
    reqId,
    model: parsed.data.model,
    isFusion,
    stream: !!stream,
    messages: messages.length,
    user_message_count: messages.filter((m) => m.role === "user").length,
  });

  if (!isFusion) {
    appLog.info("Proxying request to LiteLLM", { reqId, model: parsed.data.model });
    return proxyToLiteLLM(c, parsed.data, reqId);
  }

  const fc = resolveFusionConfig(fusion_config, parsed.data.model);
  if (temperature !== undefined) fc.temperature = temperature;
  if (max_tokens !== undefined) fc.max_tokens = max_tokens;

  appLog.info("Fusion request configured", {
    reqId,
    panel: fc.panel,
    judge: fc.judge,
    outer_model: fc.outer_model,
    web_search: fc.web_search,
    temperature: fc.temperature,
    max_tokens: fc.max_tokens,
  });

  if (stream) {
    return handleFusionStream(c, parsed.data, fc, reqId, reqStart);
  }

  return handleFusionNonStream(c, parsed.data, fc, reqId, reqStart);
});

// ---- Non-streaming fusion ----

async function handleFusionNonStream(
  c: any,
  data: z.infer<typeof fusionRequestSchema>,
  fc: Required<z.infer<typeof fusionConfigSchema>>,
  reqId: string,
  reqStart: number,
) {
  try {
    const result = await runFusion({
      messages: data.messages as { role: string; content: string }[],
      fusionConfig: fc as any,
    });

    const durationMs = Date.now() - reqStart;
    appLog.info("Non-streaming fusion response sent", {
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
    appLog.error("Non-streaming fusion pipeline error", {
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

// ---- Streaming fusion ----

async function handleFusionStream(
  c: any,
  data: z.infer<typeof fusionRequestSchema>,
  fc: Required<z.infer<typeof fusionConfigSchema>>,
  reqId: string,
  reqStart: number,
) {
  const messages = data.messages as { role: string; content: string }[];
  const fusionId = `fusion-${reqId.split("-")[0]}`;

  return streamSSE(c, async (stream) => {
    try {
      // 1. Panel + judge (internal, not streamed)
      appLog.info("Streaming: running panel+judge phase", { reqId });
      const { panelResponses, analysis, judgeRawContent } =
        await runFusionPanelJudge({
          messages,
          fusionConfig: fc as any,
        });

      // 2. No outer model → return judge analysis directly
      if (!fc.outer_model) {
        appLog.info("Streaming: no outer model, returning judge analysis", { reqId });
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

      // 3. If web_search enabled, let the LLM decide whether to search before streaming
      const searchEnabled = fc.web_search && config.search.enabled;
      let outerReq: ReturnType<typeof buildOuterModelRequest>;

      if (searchEnabled) {
        appLog.info("Streaming: resolving tools with web search", { reqId });
        outerReq = buildOuterModelRequest(
          judgeRawContent,
          messages,
          fc.outer_model,
          fc.temperature,
          fc.max_tokens,
          [SEARCH_TOOL],
        );

        const getQuery = () => {
          const last = [...messages].reverse().find((m) => m.role === "user");
          return last?.content ?? "";
        };

        const { messages: resolvedMessages } = await resolveTools(
          outerReq,
          async (_name, args) => {
            const query = (args.query as string) || getQuery();
            const results = await searchWeb(query);
            appLog.info("Streaming: web search handler", {
              reqId,
              query: query.slice(0, 100),
              results_count: results.length,
            });
            return formatSearchResults(results) || "No results found.";
          },
        );
        // Use the resolved messages (which include tool results) directly
        outerReq = { ...outerReq, messages: resolvedMessages, tools: undefined };
      } else {
        outerReq = buildOuterModelRequest(
          judgeRawContent,
          messages,
          fc.outer_model,
          fc.temperature,
          fc.max_tokens,
        );
      }

      // 4. Stream outer model
      appLog.info("Streaming: starting outer model stream", {
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
      for await (const chunk of callLiteLLMStream(outerReq)) {
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

      appLog.info("Streaming: outer model stream complete", {
        reqId,
        durationMs: Date.now() - reqStart,
        content_length: streamedContent.length,
      });

      // 4. Fusion metadata
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
      appLog.error("Streaming fusion error", {
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

// ---- Proxy to LiteLLM ----

async function proxyToLiteLLM(c: any, body: Record<string, unknown>, reqId: string) {
  const { stream, ...rest } = body as any;
  const litellmUrl = `${config.litellm.baseUrl}/v1/chat/completions`;

  try {
    appLog.info("Proxying to LiteLLM", {
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
      appLog.info("LiteLLM proxy stream response", {
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
    appLog.info("LiteLLM proxy response", {
      reqId,
      status: resp.status,
      durationMs: Date.now() - proxyStart,
      model: data.model,
      usage: data.usage,
    });
    return c.json(data, resp.status as any);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appLog.error("LiteLLM proxy error", { reqId, error: message });
    return c.json({ error: `LiteLLM proxy error: ${message}` }, 502);
  }
}

// ---- Start ----

const { host, port } = config.server;

console.log(`\n  🧬 Fusion Service`);
console.log(`  ───────────────`);
console.log(`  Listening : ${host}:${port}`);
console.log(`  LiteLLM   : ${config.litellm.baseUrl}`);
if (config.search.braveApiKey) {
  console.log(`  Search    : Brave Search API + DDG fallback`);
} else {
  console.log(`  Search    : DuckDuckGo (no Brave key set)`);
}
console.log(`  Defaults  : panel=${config.defaults.panel.join(", ")}`);
console.log(`              judge=${config.defaults.judge}`);
console.log(`              outer=${config.defaults.outerModel}`);
console.log(`\n  POST /v1/chat/completions  — Fusion endpoint (streaming supported)`);
console.log(`  GET  /health              — Health check\n`);

serve(
  {
    port,
    hostname: host,
    fetch: app.fetch,
  },
  (info) => {
    console.log(`  ➜ Server ready at http://${info.address}:${info.port}`);
  },
);

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { config } from "./config.js";
import {
  runFusion,
  runFusionPanelJudge,
  resolveFusionConfig,
  buildOuterModelRequest,
} from "./fusion.js";
import { callLiteLLMStream } from "./litellm.js";

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
  if (config.server.apiKey) {
    const auth = c.req.header("Authorization");
    if (
      !auth ||
      !auth.startsWith("Bearer ") ||
      auth.slice(7) !== config.server.apiKey
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const parsed = fusionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.issues },
      400,
    );
  }

  const { messages, fusion_config, temperature, max_tokens, stream } =
    parsed.data;
  const isFusion = fusion_config !== undefined || parsed.data.model === "fusion";

  if (!isFusion) {
    return proxyToLiteLLM(c, parsed.data);
  }

  const fc = resolveFusionConfig(fusion_config, parsed.data.model);
  if (temperature !== undefined) fc.temperature = temperature;
  if (max_tokens !== undefined) fc.max_tokens = max_tokens;

  if (stream) {
    return handleFusionStream(c, parsed.data, fc);
  }

  return handleFusionNonStream(c, parsed.data, fc);
});

// ---- Non-streaming fusion ----

async function handleFusionNonStream(
  c: any,
  data: z.infer<typeof fusionRequestSchema>,
  fc: Required<z.infer<typeof fusionConfigSchema>>,
) {
  try {
    const result = await runFusion({
      messages: data.messages as { role: string; content: string }[],
      fusionConfig: fc as any,
    });

    return c.json({
      id: `fusion-${Date.now()}`,
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
    console.error("[fusion] Pipeline error:", message);
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
) {
  const messages = data.messages as { role: string; content: string }[];
  const fusionId = `fusion-${Date.now()}`;

  return streamSSE(c, async (stream) => {
    try {
      // 1. Panel + judge (internal, not streamed)
      const { panelResponses, analysis, judgeRawContent } =
        await runFusionPanelJudge({
          messages,
          fusionConfig: fc as any,
        });

      // 2. No outer model → return judge analysis directly
      if (!fc.outer_model) {
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

      // 3. Stream outer model
      const outerReq = buildOuterModelRequest(
        judgeRawContent,
        "",
        messages,
        fc.outer_model,
        fc.temperature,
        fc.max_tokens,
      );

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

      for await (const chunk of callLiteLLMStream(outerReq)) {
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
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
      console.error("[fusion-stream] Error:", message);
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

async function proxyToLiteLLM(c: any, body: Record<string, unknown>) {
  const { stream, ...rest } = body as any;
  const litellmUrl = `${config.litellm.baseUrl}/v1/chat/completions`;

  try {
    const resp = await fetch(litellmUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.litellm.apiKey}`,
      },
      body: JSON.stringify(rest),
    });

    if (stream) {
      return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers,
      });
    }

    const data = await resp.json();
    return c.json(data, resp.status as any);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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

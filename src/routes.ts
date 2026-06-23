import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { config } from "./config.js";
import { createModuleLogger } from "./logger.js";
import { resolveFusionConfig } from "./fusion.js";
import { createLLMAdapter } from "./litellm.js";
import { checkAuth } from "./auth.js";
import { handleFusionNonStream } from "./handlers/non-streaming.js";
import { handleFusionStream } from "./handlers/streaming.js";
import { proxyToLiteLLM } from "./handlers/proxy.js";

const log = createModuleLogger("routes");
const llm = createLLMAdapter();

// ---- Zod schemas ----

const messageSchema = z.object({
  role: z.string(),
  content: z.string().nullable().optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
}).passthrough();

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
  tools: z.array(z.any()).optional(),
  tool_choice: z.union([z.string(), z.record(z.any())]).optional(),
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

  if (!checkAuth(c)) {
    log.warn("Request rejected: unauthorized", { reqId, ip: c.req.header("x-forwarded-for") });
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json().catch(() => null);
  if (!body) {
    log.warn("Request rejected: invalid JSON", { reqId });
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = fusionRequestSchema.safeParse(body);
  if (!parsed.success) {
    log.warn("Request rejected: validation failed", {
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

  log.info("Request received", {
    reqId,
    model: parsed.data.model,
    isFusion,
    stream: !!stream,
    messages: messages.length,
    user_message_count: messages.filter((m) => m.role === "user").length,
  });

  if (!isFusion) {
    log.info("Proxying request to LiteLLM", { reqId, model: parsed.data.model });
    return proxyToLiteLLM(c, body, reqId);
  }

  const fc = resolveFusionConfig(fusion_config, parsed.data.model);
  if (temperature !== undefined) fc.temperature = temperature;
  if (max_tokens !== undefined) fc.max_tokens = max_tokens;

  log.info("Fusion request configured", {
    reqId,
    panel: fc.panel,
    judge: fc.judge,
    outer_model: fc.outer_model,
    web_search: fc.web_search,
    temperature: fc.temperature,
    max_tokens: fc.max_tokens,
  });

  if (stream) {
    return handleFusionStream(
      c,
      messages as { role: string; content: string }[],
      fc,
      reqId,
      reqStart,
      llm,
    );
  }

  return handleFusionNonStream(
    c,
    messages as { role: string; content: string }[],
    fc,
    reqId,
    reqStart,
    llm,
  );
});

export { app };

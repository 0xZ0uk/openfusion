import { registerProvider } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";
import { cors } from "hono/cors";

// ── API provider registration for pi-ai ──
// pi-ai needs OpenAI-compatible stream functions registered before model calls work.
// Register the built-in openai_completions stream functions.

const { registerApiProvider, streamOpenAICompletions, streamSimpleOpenAICompletions } =
  await import("@earendil-works/pi-ai");

registerApiProvider(
  {
    api: "openai-completions",
    stream: streamOpenAICompletions,
    streamSimple: streamSimpleOpenAICompletions,
  },
  "fusion",
);

// ── LiteLLM provider registration ──
// Register as "openai" so pi-ai recognizes the provider and looks for OPENAI_API_KEY.
// The baseUrl points at our LiteLLM proxy instead of OpenAI.

registerProvider("openai", {
  api: "openai-completions",
  baseUrl: process.env.LITELLM_BASE_URL
    ? process.env.LITELLM_BASE_URL.replace(/\/+$/, "") + "/v1"
    : "http://localhost:4000/v1",
  apiKey: process.env.LITELLM_API_KEY,
});

// Models are referenced as: litellm/<model-name>
// e.g. "litellm/mimo-v2.5", "litellm/deepseek-v4-flash"

// ── Hono app ──

const app = new Hono();
app.use("*", cors());
app.route("/", flue());

export default app;

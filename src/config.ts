import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  LITELLM_BASE_URL: z.string().url().default("http://localhost:4000"),
  LITELLM_API_KEY: z.string().default("sk-litellm"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4040),
  FUSION_API_KEY: z.string().optional(),

  // Default models (overridable per-request)
  DEFAULT_PANEL: z.string().default("anthropic/claude-sonnet-4,openai/gpt-4o,google/gemini-2.5-pro"),
  DEFAULT_JUDGE: z.string().default("anthropic/claude-sonnet-4"),
  DEFAULT_OUTER_MODEL: z.string().default("anthropic/claude-sonnet-4"),

  // Web search
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  WEB_SEARCH_ENABLED: z.coerce.boolean().default(true),
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment config:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  const env = result.data;

  return {
    litellm: {
      baseUrl: env.LITELLM_BASE_URL.replace(/\/+$/, ""),
      apiKey: env.LITELLM_API_KEY,
    },
    server: {
      host: env.HOST,
      port: env.PORT,
      apiKey: env.FUSION_API_KEY,
    },
    defaults: {
      panel: env.DEFAULT_PANEL.split(",").map((s) => s.trim()).filter(Boolean),
      judge: env.DEFAULT_JUDGE,
      outerModel: env.DEFAULT_OUTER_MODEL,
    },
    search: {
      braveApiKey: env.BRAVE_SEARCH_API_KEY,
      enabled: env.WEB_SEARCH_ENABLED,
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
export const config = loadConfig();

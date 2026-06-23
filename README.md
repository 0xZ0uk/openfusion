# Openfusion 🧬

**Multi-model deliberation — bring your own models and keys.**

Openfusion is a self-hosted proxy that runs a panel of LLMs in parallel, lets a judge model analyze their responses, and composes a final answer. Think OpenRouter Fusion, but running against **your own providers** through your existing LiteLLM proxy.

```
Your App → Openfusion → LiteLLM (your proxy)
                            ├── Anthropic / OpenAI / Google
                            ├── your keys, your billing
                            └── your data, your infra
```

## Why

Single-model answers have blind spots. Running a panel of models surfaces consensus, contradictions, coverage gaps, and unique insights that one model alone would miss. Openfusion makes this a drop-in API — any OpenAI-compatible client can use it.

**You own everything:** the API keys, the data, the infrastructure. No third-party router sees your prompts.

## How it works

```
┌─────────────┐     ┌──────────────────────────────────────┐     ┌──────────┐
│  Client      │────▶│  Openfusion                          │────▶│ LiteLLM  │
│  OpenAI SDK  │     │                                      │     │ (proxy)  │
└─────────────┘     │  1. Web search for context (optional)  │     └──────────┘
                    │  2. Parallel panel calls (3-8 models)  │
                    │  3. Judge compares → structured JSON   │
                    │  4. Outer model writes final answer    │
                    │  5. Returns standard OpenAI response   │
                    └──────────────────────────────────────┘
```

The judge analyzes: **consensus** (what most models agreed on), **contradictions** (where they diverged), **coverage gaps** (what some covered that others missed), **unique insights**, and **blind spots** (what nobody addressed).

## Features

- **OpenAI-compatible API** — works with any OpenAI SDK, Vercel AI SDK, curl, etc.
- **Streaming support** — SSE streaming for the outer model's final answer
- **Web search** — Brave Search API (primary) with DuckDuckGo fallback for panel and judge context
- **Your providers** — routes through LiteLLM, so you use your own keys for any provider
- **LiteLLM passthrough** — non-fusion requests proxy straight through, so you can use it as your single endpoint
- **Docker** — multi-stage build, ready for Dokploy or any container runtime

## Quickstart

### Prerequisites

- Node.js 22+
- A running [LiteLLM](https://litellm.ai) proxy with your providers configured

### Run locally

```bash
git clone https://github.com/0xZ0uk/openfusion.git
cd openfusion
cp .env.example .env
# Edit .env: set LITELLM_BASE_URL and LITELLM_API_KEY
pnpm install
pnpm run dev
```

### Run with Docker

```bash
docker build -t openfusion .
docker run -p 4040:4040 \
  -e LITELLM_BASE_URL=http://host.docker.internal:4000 \
  -e LITELLM_API_KEY=sk-... \
  openfusion
```

## Configuration

| Env var | Default | Description |
|---|---|---|
| `LITELLM_BASE_URL` | `http://localhost:4000` | Your LiteLLM proxy URL |
| `LITELLM_API_KEY` | `sk-litellm` | LiteLLM API key |
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `4040` | Server port |
| `FUSION_API_KEY` | — | If set, clients must send this as Bearer token |
| `DEFAULT_PANEL` | `anthropic/claude-sonnet-4,openai/gpt-4o,google/gemini-2.5-pro` | Comma-separated default panel models |
| `DEFAULT_JUDGE` | `anthropic/claude-sonnet-4` | Default judge model |
| `DEFAULT_OUTER_MODEL` | `anthropic/claude-sonnet-4` | Default outer model |
| `BRAVE_SEARCH_API_KEY` | — | [Brave Search API](https://brave.com/search/api/) key. Falls back to DuckDuckGo if unset |
| `WEB_SEARCH_ENABLED` | `true` | Toggle web search globally |

## API

### POST `/v1/chat/completions`

Standard OpenAI chat completion endpoint. To trigger fusion, include `fusion_config`:

```json
{
  "model": "fusion",
  "messages": [
    { "role": "user", "content": "Compare serverless and traditional databases." }
  ],
  "fusion_config": {
    "panel": ["anthropic/claude-sonnet-4", "openai/gpt-4o", "google/gemini-2.5-pro"],
    "judge": "anthropic/claude-sonnet-4",
    "outer_model": "anthropic/claude-sonnet-4",
    "web_search": true
  }
}
```

**Response** — standard OpenAI shape with `fusion_metadata` extension:

```json
{
  "id": "fusion-1741234567",
  "object": "chat.completion",
  "model": "anthropic/claude-sonnet-4",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 4500, "completion_tokens": 800, "total_tokens": 5300 },
  "fusion_metadata": {
    "panel": ["anthropic/claude-sonnet-4", ...],
    "judge": "anthropic/claude-sonnet-4",
    "web_search": true,
    "panel_responses": [
      { "model": "anthropic/claude-sonnet-4", "error": false, "content_length": 1204 }
    ],
    "analysis": {
      "consensus": [...],
      "contradictions": [...],
      "coverage_gaps": [...],
      "unique_insights": [...],
      "blind_spots": [...],
      "summary": "..."
    }
  }
}
```

### Streaming

Add `"stream": true` to receive the outer model's output as SSE:

```
data: {"id":"fusion-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}
data: {"id":"fusion-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"..."}}]}
data: {"id":"fusion-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: {"id":"fusion-...","object":"fusion.metadata","fusion_metadata":{...}}
data: [DONE]
```

### Passthrough mode

Omit `fusion_config` and use any model name — Openfusion proxies directly to LiteLLM. This means you can point all your tools at Openfusion and use fusion only when you need it.

```bash
curl http://localhost:4040/v1/chat/completions \
  -d '{ "model": "anthropic/claude-sonnet-4", "messages": [{"role":"user","content":"Hello"}] }'
```

## Fusion config reference

| Field | Default | Description |
|---|---|---|
| `panel` | `DEFAULT_PANEL` env | Array of 1–8 model names for the panel |
| `judge` | `DEFAULT_JUDGE` env | Model that analyzes panel responses |
| `outer_model` | `DEFAULT_OUTER_MODEL` env | Model that writes the final answer. Omit to return judge analysis directly |
| `max_tokens` | `4096` | Max output tokens per inner call |
| `temperature` | `0.7` | Sampling temperature (judge uses 0.3) |
| `web_search` | `true` | Enable/disable web search for context |

## Deployment

### Dokploy

```yaml
# docker-compose service
openfusion:
  build: .
  ports:
    - "4040:4040"
  environment:
    - LITELLM_BASE_URL=http://litellm:4000
    - LITELLM_API_KEY=${LITELLM_API_KEY}
    - BRAVE_SEARCH_API_KEY=${BRAVE_SEARCH_API_KEY}
  restart: unless-stopped
```

### Architecture with LiteLLM

```
Client → Openfusion (:4040) → LiteLLM (:4000) → Providers
                                  │
                              Postgres (keys, spend, logs)
```

Openfusion talks to LiteLLM over your internal Docker network. No changes needed to LiteLLM's config.

## Project structure

```
openfusion/
├── src/
│   ├── config.ts      # Env config with Zod validation
│   ├── fusion.ts      # Core pipeline: panel → judge → outer model
│   ├── index.ts       # Hono server + routes
│   ├── litellm.ts     # LiteLLM proxy client
│   ├── prompts.ts     # Judge prompt + message builders
│   ├── search.ts      # Brave Search + DuckDuckGo fallback
│   └── types.ts       # Type definitions
├── Dockerfile
├── .env.example
└── package.json
```

## Roadmap

- [ ] **Web fetch** — follow links from search results for deeper context
- [ ] **Tool auto-injection** — model decides whether to invoke fusion (like OpenRouter's pattern)
- [ ] **Per-model tool calling** — give panel models web_search as a callable tool
- [ ] **Concurrent request queue** — rate limiting and request pooling
- [ ] **Usage tracking** — per-request cost breakdown by panel model

---

Built with [Hono](https://hono.dev) + [LiteLLM](https://litellm.ai). Inspired by [OpenRouter Fusion](https://openrouter.ai/openrouter/fusion).

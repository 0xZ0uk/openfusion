# PRD: Agent-Harness Fusion — Openfusion v2

**Status:** Draft v1  
**Date:** 2026-06-23  
**Author:** Pedro + Orbit  

---

## 1. Executive Summary

Openfusion v1 is a self-hosted multi-model deliberation proxy. It intercepts OpenAI-compatible chat completions and runs a custom pipeline: parallel panel calls → judge analysis → outer model composition. The pipeline works in theory but has persistent quality issues in practice — coding-agent models emit tool calls and agent directives instead of plain text, the custom tool-loop implementation has bugs, and the output is unreliable.

Openfusion v2 replaces the custom pipeline with **Flue**, an agent harness framework from the Astro team. Instead of fighting models to produce plain text, we embrace their agentic nature: the outer agent has real tools (read, write, bash, git, search), and when it needs deeper analysis, it spawns a fusion panel as **subagents**. The panel members and judge are lightweight agents with no tools — they analyze what the outer agent discovered. This is a multi-agent system where the harness handles tool loops, sessions, and subagent coordination.

---

## 2. Problems with v1

| Problem | Root Cause | Impact |
|---|---|---|
| Panel models emit tool calls / XML / agent directives as text | Coding-agent models are trained to use tools; our prompt can't suppress it | Judge analyzes garbage, output is incoherent |
| Tool-calling loop is buggy | `resolveTools()` doesn't push final assistant message to returned array | Model's answer is generated but lost; duplicate calls add latency |
| Pipeline takes 4+ minutes for one request | Phase 1 explores, Phase 4 re-explores; no parallelism for panel (sequential model responses) | SSE connection times out, user sees no output |
| No session/state management | Openfusion is stateless — each request starts fresh | Can't maintain conversation context across turns |
| Custom tool implementation is fragile | Path traversal guards, binary detection, text-only checks in `explorer.ts` | Edge cases, maintenance burden |

---

## 3. Solution: Flue-Based Multi-Agent Architecture

### 3.1 High-Level Architecture

```
User (terminal / CLI)
  │
  ▼
┌─────────────────────────────────────────────┐
│           Outer Agent (Coder)                │
│  Model: primary coding model (via LiteLLM)   │
│  Tools: read, write, bash, glob, search, git │
│  Skills: fusion-panel, code-review, test     │
│  Sandbox: local()                            │
│                                              │
│  When faced with complex analysis:           │
│    → invoke("fusion-panel")                  │
│      → Panel Agent 1 (analyze context)       │
│      → Panel Agent 2 (analyze context)       │
│      → Panel Agent 3 (analyze context)       │
│      → Judge Agent (evaluate panel)          │
│    → structured analysis returned             │
│    → continues with better context            │
└─────────────────────────────────────────────┘
  │
  ▼
LiteLLM Proxy (ai.blugg.pt)
  │
  ▼
Your Providers (Yunwu, Anthropic, OpenAI, Google...)
```

### 3.2 Components

#### 3.2.1 Model Provider Registration

Flue uses `@earendil-works/pi-ai` for model resolution. We register our LiteLLM proxy as a custom provider:

```
registerProvider("litellm", {
  api: "openai-chat",
  baseUrl: "https://ai.blugg.pt/v1",
  apiKey: process.env.LITELLM_API_KEY,
});
```

All agent models are referenced as `litellm/<model-name>` (e.g. `litellm/mimo-v2.5`, `litellm/deepseek-v4-flash`).

#### 3.2.2 Outer Agent (Coder)

The primary agent the user interacts with. Has full tool access and the fusion-panel skill.

- **Model:** Configurable, default `mimo-v2.5`
- **Sandbox:** `local()` — controlled filesystem access in cwd
- **Tools:**
  - `read_file` — read files with size limits
  - `write_file` — create/edit files
  - `bash` — run shell commands (tests, builds, git)
  - `glob` — find files by pattern
  - `search_text` — grep within files
  - `git_status` / `git_diff` / `git_commit` — git operations
  - `list_directory` — explore project structure
- **Skills:**
  - `fusion-panel` — multi-model deliberation (see §3.2.5)
  - `code-review` — structured code review workflow
  - `test-writing` — test generation patterns
- **Instructions:** Defines the agent's behavior, coding style, tool usage guidelines

#### 3.2.3 Fusion Panel Agents

Panel members are lightweight agents with NO tools. They receive the outer agent's exploration context and produce individual analyses.

- **Models:** Configurable panel (default: deepseek-v4-flash, mimo-v2.5, step-3.7-flash, nemotron-3-super-120b-a12b)
- **Tools:** None
- **Instructions:** Analyze the provided context. Identify patterns, architecture decisions, potential issues, improvement opportunities. Return plain text analysis.

#### 3.2.4 Judge Agent

Evaluates and compares panel responses.

- **Model:** Configurable (default: deepseek-v4-flash)
- **Tools:** None
- **Instructions:** Compare the panel responses. Identify consensus, contradictions, coverage gaps, unique insights, blind spots. Return structured JSON.
- **Output format:** Same structured analysis as current Openfusion (consensus[], contradictions[], coverage_gaps[], unique_insights[], blind_spots[], summary)

#### 3.2.5 Fusion-Panel Skill

A reusable Flue skill that orchestrates the panel + judge workflow.

```typescript
// skills/fusion-panel/SKILL.md
# Fusion Panel

Invoke this when you need multi-model deliberation on a complex question.

## Workflow
1. You provide the context (codebase exploration, question, etc.)
2. Panel agents analyze it in parallel
3. Judge agent evaluates their responses
4. Structured analysis is returned to you

## When to use
- Complex architecture questions
- Code review with multiple perspectives
- Design decisions with trade-offs
- Debugging hard problems
```

The skill is implemented as a Flue workflow or subagent invocation that:
1. Spawns N panel subagents in parallel (Flue handles concurrency)
2. Collects their responses
3. Spawns judge subagent with all panel responses
4. Returns structured analysis to the outer agent

---

## 4. User Experience

### 4.1 CLI Mode

```bash
# Start a session in the current directory
fusion dev

# Or use Flue's CLI
npx flue dev
```

Opens an interactive terminal session (like OpenCode). The user types requests, the outer agent uses tools and optionally invokes the fusion panel.

### 4.2 API Mode (backward compatible)

Openfusion v2 still exposes the `/v1/chat/completions` endpoint for integration with existing tools (OpenCode, cursor, etc.). The passthrough mode works identically. Fusion requests are handled by the outer agent.

### 4.3 Session Persistence

Flue provides built-in session management. Each conversation is a session that persists across turns. The agent maintains context about the codebase, previous actions, and user preferences.

---

## 5. Implementation Plan

### Phase 1: Foundation (Days 1-3)

- [ ] Install `@flue/runtime` and `@flue/cli`
- [ ] Configure model provider for LiteLLM
- [ ] Define basic tools: `read_file`, `list_directory`, `glob`, `search_text`, `bash`
- [ ] Create outer agent definition with instructions
- [ ] Verify: agent starts, takes instructions, uses tools correctly

**Deliverable:** A working CLI agent that can explore a codebase and answer questions using tools.

### Phase 2: Fusion Panel Skill (Days 4-6)

- [ ] Define panel agent profiles (no tools, analysis instructions)
- [ ] Define judge agent profile (JSON output, evaluation instructions)
- [ ] Implement `fusion-panel` skill using Flue's subagent invocation
- [ ] Wire skill into outer agent's available skills
- [ ] Test: agent invokes fusion panel for complex analysis

**Deliverable:** The outer agent can optionally invoke multi-model deliberation.

### Phase 3: API Compatibility (Days 7-8)

- [ ] Port `/v1/chat/completions` endpoint to work with Flue runtime
- [ ] Streaming support via Flue's stream handling
- [ ] Passthrough mode (non-fusion requests → LiteLLM)
- [ ] Fusion config via request body triggers subagent flow

**Deliverable:** Backward-compatible API that existing Openfusion clients can use.

### Phase 4: Polish (Days 9-10)

- [ ] Additional tools: `write_file`, `git_status`, `git_commit`, `git_diff`
- [ ] Skills: `code-review`, `test-writing`
- [ ] Sandbox hardening (path restrictions, execution limits)
- [ ] Session persistence (optional: Postgres adapter)
- [ ] Error handling and recovery

**Deliverable:** Production-ready coding agent with fusion capabilities.

---

## 6. Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Framework | Flue (`@flue/runtime`) | Built-in harness, subagents, sandbox, sessions. Astro team quality. |
| Model routing | LiteLLM via `registerProvider()` | Reuse existing proxy. All models accessible through one endpoint. |
| Panel parallelism | Flue subagent `invoke()` | Flue handles concurrent subagent execution. |
| No tools for panel/judge | Explicit zero-tool agents | Eliminates the tool-calling noise that broke v1. |
| Fusion as a skill | Not part of the core agent | The outer agent decides when to use it. Keeps the base agent lean. |

---

## 7. Open Questions

- What's the fallback when a panel model fails (timeout, error)?
- Should the judge agent have web_search tool like OpenRouter's fusion?
- How do we handle the cost of N panel calls per fusion invocation?
- Should we cache fusion results for identical queries?
- Do we need a UI, or is CLI + API sufficient?

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Flue is beta software | Pin to version, contribute fixes upstream if needed |
| pi-ai model catalog doesn't recognize all LiteLLM models | `registerProvider()` with custom baseUrl works for unknown models |
| Subagent latency adds up | Parallel panel execution; optimize model choices |
| Users expect OpenCode parity | Scope v2 as "Openfusion + basic coding agent" — feature parity comes later |

# Slice 02: Fusion Panel as Subagent Skill

**Phase:** 2  
**Estimate:** 3 days  
**Dependencies:** SLICE_01  

## Description

Build the fusion panel as a reusable Flue skill. Panel member agents (no tools) analyze the outer agent's exploration context in parallel, a judge agent evaluates their responses, and the structured analysis is returned to the outer agent. The outer agent can invoke this skill when it needs multi-model deliberation.

This slice delivers the core value of Openfusion: multi-model analysis as a team of subagents. The outer agent gains the ability to request deep, multi-perspective analysis on complex questions.

---

## Issues

### O2-006: Define panel agent profiles

Create lightweight agent profiles for panel members using `defineAgentProfile()`. Each panel member:
- Has NO tools
- Receives the exploration context as input
- Returns a plain-text analysis
- Uses a different model (configurable)

Default panel:
- Panelist 1: `litellm/deepseek-v4-flash`
- Panelist 2: `litellm/mimo-v2.5`
- Panelist 3: `litellm/step-3.7-flash`
- Panelist 4: `litellm/nemotron-3-super-120b-a12b`

The instructions tell them: "Analyze the provided codebase context. Identify patterns, architecture decisions, potential issues, and improvement opportunities. Return plain text only — do not request tools."

**Acceptance criteria:**
- `defineAgentProfile()` creates valid panel profiles
- Panel agents return analysis text without attempting tool calls
- Panel agents can be invoked individually via `invoke()`

### O2-007: Define judge agent profile

Create a judge agent profile with:
- NO tools
- Instructions to compare panel responses
- Structured JSON output format

The judge receives all panel responses plus the original context. It produces JSON with: consensus, contradictions, coverage_gaps, unique_insights, blind_spots, summary (same schema as current Openfusion judge but adapted for Flue).

**Acceptance criteria:**
- Judge agent returns valid JSON matching the schema
- Judge evaluates and compares panel responses correctly
- Judge handles cases where some panel members failed or returned errors

### O2-008: Implement fusion-panel skill with parallel subagent invocation

Create the `fusion-panel` skill using Flue's skill system (`SKILL.md` + implementation). The skill:

1. Accepts the exploration context and question as input
2. Spawns all panel subagents in parallel (Flue `invoke()`)
3. Waits for all panel responses (with timeout)
4. Spawns the judge subagent with all panel responses
5. Returns the structured analysis

Handle partial failures: if a panel agent errors, use a placeholder and let the judge proceed.

**Acceptance criteria:**
- Skill can be loaded by the outer agent
- Panel agents run in parallel
- Judge evaluates all available responses
- Structured analysis is returned to the caller
- Timeout handling for slow panel agents

### O2-009: Wire fusion-panel skill into outer agent

Register the fusion-panel skill in the outer agent's `defineAgent()` definition. Update the agent's instructions to describe when and how to use the skill.

**Acceptance criteria:**
- Outer agent lists fusion-panel as an available skill
- Agent invokes the skill when asked "analyze this in depth" or similar
- Agent receives the analysis and can discuss it
- Agent can use the analysis to make better decisions

### O2-010: Integration test — complex codebase analysis

End-to-end test: start a session, ask the agent to analyze a non-trivial codebase, verify the fusion panel is invoked, and confirm the output is coherent and useful.

**Acceptance criteria:**
- Full fusion pipeline executes (explore → panel → judge → compose)
- Output is a coherent analysis, not garbled tool calls
- Total pipeline time is reasonable (< 2 min)
- No agent artifacts leak into the final output

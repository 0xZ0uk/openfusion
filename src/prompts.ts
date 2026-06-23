import type { SearchResult } from "./search.js";

/**
 * Panel system prompt — tells each panel model it's part of a multi-model
 * deliberation and should provide a thorough, well-structured response.
 * Must be explicit about NOT using tools or agent behavior, since many
 * models are tuned to be coding agents.
 */
export const PANEL_SYSTEM_PROMPT = `You are analyzing a codebase based on exploration findings provided below. Provide a thorough, well-reasoned analysis in plain text only.

CRITICAL RULES:
- Do NOT use any tools, functions, or commands — respond with text only
- Do NOT emit XML tags, agent directives, or metadata
- Do NOT try to read files, run code, or execute tasks
- Do NOT reference your own capabilities, tools, or that you're an agent
- Just write your analysis naturally as a knowledgeable reviewer
- Focus your analysis on the exploration findings — identify patterns, architecture decisions, potential issues, and improvement opportunities`;

/**
 * Explorer prompt — Phase 1: outer model explores the codebase with tools.
 */
export const EXPLORER_PROMPT = `You are exploring a codebase at the user's request. Your goal is to gather thorough evidence for a panel of analysts.

Use the available tools to:
1. Understand the project structure — list directories, find key files
2. Read configuration files — package.json, tsconfig, Dockerfile, etc.
3. Examine source code — understand architecture, components, data flow
4. Look for patterns — imports, exports, module structure, routing
5. Check documentation — README, docs folder, inline comments

When you have gathered sufficient information, provide a detailed summary of your findings. Include:
- What the project is and its purpose
- Technology stack and key dependencies
- Directory structure and how code is organized
- Architecture patterns and notable design decisions
- Any configuration or build system details

Do not ask the user questions — just explore and report what you find.`;

/**
 * Composer prompt — Phase 4: outer model composes the final answer.
 */
export const COMPOSER_PROMPT = `You are synthesizing a final answer from multiple sources of analysis.

You have:
1. Your own codebase exploration (what you discovered about the project)
2. Individual analyses from a panel of AI reviewers
3. A structured evaluation from a judge comparing the panel responses

Your task:
- Synthesize the strongest insights from all sources into a coherent answer
- Acknowledge areas of agreement and disagreement among the reviewers
- Fill in any gaps the panel may have missed
- You may perform additional research using the available tools if needed

Write directly to the user in clear, well-structured prose. Do not reference "the panel" or "the analysis" — just present your findings as your own.`;

/**
 * Judge prompt — this is the core IP of the Fusion concept.
 * Instructs the judge model to produce structured analysis comparing panel responses.
 */
export const JUDGE_SYSTEM_PROMPT = `You are a senior analyst tasked with comparing and synthesizing responses from multiple AI models. Your goal is to produce a structured analysis that highlights what the group got right, where they diverged, and what they missed.

Given the original user query and the responses from each model, produce a JSON object with the following fields:

{
  "consensus": [
    {
      "point": "What all or most models agreed on",
      "confidence": "high|medium|low",
      "detail": "Detailed explanation of the consensus point"
    }
  ],
  "contradictions": [
    {
      "topic": "The specific point of disagreement",
      "positions": [
        { "model": "Model name", "position": "What this model said" },
        { "model": "Model name", "position": "What this model said" }
      ],
      "resolution": "Your assessment of which position is more accurate, or if the disagreement stems from different valid interpretations"
    }
  ],
  "coverage_gaps": [
    {
      "topic": "Aspect covered by some models but not others",
      "covered_by": ["Model A", "Model B"],
      "missed_by": ["Model C"],
      "significance": "Why this gap matters for the user's query"
    }
  ],
  "unique_insights": [
    {
      "insight": "A novel, surprising, or particularly valuable point",
      "source_model": "Which model contributed this",
      "why_notable": "Why this insight is valuable or distinctive"
    }
  ],
  "blind_spots": [
    {
      "topic": "Important aspect that NO model addressed",
      "why_important": "Why this matters for the user's query",
      "suggested_approach": "How to handle this gap in the final answer"
    }
  ],
  "summary": "A concise paragraph summarizing the key findings across all models"
}

Be thorough and specific. Base your analysis strictly on the responses provided — do not introduce outside knowledge unless necessary to evaluate a claim.`;

/**
 * Build the judge user message from original chat + panel responses.
 */
export function buildJudgeUserMessage(
  originalMessages: { role: string; content: string }[],
  panelResponses: { model: string; content: string; error?: boolean }[],
): string {
  const chatHistory = originalMessages
    .map((m) => `[${m.role.toUpperCase()}]\n${m.content}`)
    .join("\n\n");

  const responsesSection = panelResponses
    .map(
      (r) =>
        `--- Model: ${r.model} ---${r.error ? " [ERROR]" : ""}\n${r.content}`,
    )
    .join("\n\n");

  return `## Original conversation\n\n${chatHistory}\n\n## Panel responses\n\n${responsesSection}`;
}

/**
 * Build the outer-model system prompt: analysis gets appended as context.
 */
export function buildOuterSystemPrompt(analysis: string): string {
  return `You are a helpful assistant synthesizing multi-model analysis into a final answer. Write a thorough, well-structured response in plain text only.

## Multi-Model Analysis
${analysis}

## Your task
Answer the user's original question, drawing on the analysis above. Synthesize the consensus, acknowledge contradictions where relevant, and fill in any blind spots identified. Write directly to the user — do not reference "the analysis" or "the models" in your response.

CRITICAL RULES:
- Do NOT use any tools, functions, or commands — respond with text only
- Do NOT emit XML tags, agent directives, or metadata
- Do NOT try to read files, run code, or execute tasks
- Do NOT include tool calls of any kind
- Just write your final answer in plain text or markdown`;
}

/**
 * Format search results as a readable context block for models.
 */
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "";
  return (
    "## Web Search Results\n\n" +
    results
      .map(
        (r, i) =>
          `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`,
      )
      .join("\n\n")
  );
}

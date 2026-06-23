import type { SearchResult } from "./search.js";

/**
 * Panel system prompt — tells each panel model it's part of a multi-model
 * deliberation and should provide a thorough, well-structured response.
 */
export const PANEL_SYSTEM_PROMPT = `You are participating in a multi-model panel answering a user's query. Provide a thorough, well-reasoned response.

Structure your answer clearly with specific details, examples, and reasoning. Aim for depth — cover multiple angles of the question.

Do not mention that you're part of a panel or that your response will be compared. Just answer the user directly as yourself.`;

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
  return `You are a helpful assistant. Below is a multi-model analysis of the user's query. Use it to write a thorough, well-structured final answer.

## Multi-Model Analysis
${analysis}

## Your task
Answer the user's original question, drawing on the analysis above. Synthesize the consensus, acknowledge contradictions where relevant, and fill in any blind spots identified. Write directly to the user — do not reference "the analysis" or "the models" in your response.

When you need current or factual information beyond your knowledge, use the available search tool to look it up. Do not search for information you already know or for conversational/non-factual queries.`;
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

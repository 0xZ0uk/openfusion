import type { SearchResult } from "./search.js";
/**
 * Judge prompt — this is the core IP of the Fusion concept.
 * Instructs the judge model to produce structured analysis comparing panel responses.
 */
export declare const JUDGE_SYSTEM_PROMPT = "You are a senior analyst tasked with comparing and synthesizing responses from multiple AI models. Your goal is to produce a structured analysis that highlights what the group got right, where they diverged, and what they missed.\n\nGiven the original user query and the responses from each model, produce a JSON object with the following fields:\n\n{\n  \"consensus\": [\n    {\n      \"point\": \"What all or most models agreed on\",\n      \"confidence\": \"high|medium|low\",\n      \"detail\": \"Detailed explanation of the consensus point\"\n    }\n  ],\n  \"contradictions\": [\n    {\n      \"topic\": \"The specific point of disagreement\",\n      \"positions\": [\n        { \"model\": \"Model name\", \"position\": \"What this model said\" },\n        { \"model\": \"Model name\", \"position\": \"What this model said\" }\n      ],\n      \"resolution\": \"Your assessment of which position is more accurate, or if the disagreement stems from different valid interpretations\"\n    }\n  ],\n  \"coverage_gaps\": [\n    {\n      \"topic\": \"Aspect covered by some models but not others\",\n      \"covered_by\": [\"Model A\", \"Model B\"],\n      \"missed_by\": [\"Model C\"],\n      \"significance\": \"Why this gap matters for the user's query\"\n    }\n  ],\n  \"unique_insights\": [\n    {\n      \"insight\": \"A novel, surprising, or particularly valuable point\",\n      \"source_model\": \"Which model contributed this\",\n      \"why_notable\": \"Why this insight is valuable or distinctive\"\n    }\n  ],\n  \"blind_spots\": [\n    {\n      \"topic\": \"Important aspect that NO model addressed\",\n      \"why_important\": \"Why this matters for the user's query\",\n      \"suggested_approach\": \"How to handle this gap in the final answer\"\n    }\n  ],\n  \"summary\": \"A concise paragraph summarizing the key findings across all models\"\n}\n\nBe thorough and specific. Base your analysis strictly on the responses provided \u2014 do not introduce outside knowledge unless necessary to evaluate a claim.";
/**
 * Build the judge user message from original chat + panel responses.
 */
export declare function buildJudgeUserMessage(originalMessages: {
    role: string;
    content: string;
}[], panelResponses: {
    model: string;
    content: string;
    error?: boolean;
}[]): string;
/**
 * Build the outer-model system prompt: analysis gets appended as context.
 */
export declare function buildOuterSystemPrompt(analysis: string, searchContext: string): string;
/**
 * Format search results as a readable context block for models.
 */
export declare function formatSearchResults(results: SearchResult[]): string;
//# sourceMappingURL=prompts.d.ts.map
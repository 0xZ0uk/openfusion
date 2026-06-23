import type { FusionConfig, FusionResult, PanelJudgeResult, LiteLLMCompletionRequest } from "./types.js";
interface FusionInput {
    messages: {
        role: string;
        content: string;
    }[];
    fusionConfig: Required<FusionConfig>;
}
/**
 * Run just the panel + judge stages (no outer model).
 * This is used by both non-streaming and streaming flows.
 */
export declare function runFusionPanelJudge(input: FusionInput): Promise<PanelJudgeResult>;
/**
 * Build the outer model request params (used by both streaming and non-streaming paths).
 */
export declare function buildOuterModelRequest(judgeRawContent: string, searchContext: string, messages: {
    role: string;
    content: string;
}[], outerModel: string, temperature: number, max_tokens: number): LiteLLMCompletionRequest;
/**
 * Run the full Fusion pipeline (non-streaming):
 *   1. Web search (optional)
 *   2. Parallel panel calls  →  panel responses
 *   3. Judge analysis        →  structured JSON
 *   4. Outer model           →  final composed answer
 */
export declare function runFusion(input: FusionInput): Promise<FusionResult>;
/**
 * Resolve defaults and validate fusion config from a request.
 */
export declare function resolveFusionConfig(fusionConfig: FusionConfig | undefined, requestModel: string): Required<FusionConfig>;
export {};
//# sourceMappingURL=fusion.d.ts.map
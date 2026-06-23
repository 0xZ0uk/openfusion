import type { LiteLLMCompletionRequest } from "./types.js";
export interface CallResult {
    content: string;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
/**
 * Non-streaming call to a single model via LiteLLM proxy.
 */
export declare function callLiteLLM(params: LiteLLMCompletionRequest): Promise<CallResult>;
/**
 * Streaming call. Returns an async iterable of OpenAI chat completion chunks.
 */
export declare function callLiteLLMStream(params: LiteLLMCompletionRequest): AsyncGenerator<any>;
//# sourceMappingURL=litellm.d.ts.map
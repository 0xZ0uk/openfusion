import OpenAI from "openai";
import { config } from "./config.js";
/**
 * Thin wrapper around LiteLLM's OpenAI-compatible API.
 * LiteLLM handles provider routing, key management, and failover.
 */
let _client = null;
function getClient() {
    if (!_client) {
        _client = new OpenAI({
            apiKey: config.litellm.apiKey,
            baseURL: `${config.litellm.baseUrl}/v1`,
            maxRetries: 1,
            timeout: 120_000, // 2 min per model call
        });
    }
    return _client;
}
/**
 * Non-streaming call to a single model via LiteLLM proxy.
 */
export async function callLiteLLM(params) {
    const client = getClient();
    const body = {
        model: params.model,
        messages: params.messages,
        temperature: params.temperature,
        max_tokens: params.max_tokens,
    };
    if (params.response_format) {
        body.response_format = params.response_format;
    }
    const response = await client.chat.completions.create(body);
    const choice = response.choices?.[0];
    if (!choice?.message?.content) {
        throw new Error(`Empty response from model ${params.model}`);
    }
    return {
        content: choice.message.content,
        usage: response.usage
            ? {
                prompt_tokens: response.usage.prompt_tokens ?? 0,
                completion_tokens: response.usage.completion_tokens ?? 0,
                total_tokens: response.usage.total_tokens ?? 0,
            }
            : undefined,
    };
}
/**
 * Streaming call. Returns an async iterable of OpenAI chat completion chunks.
 */
export async function* callLiteLLMStream(params) {
    const client = getClient();
    const body = {
        model: params.model,
        messages: params.messages,
        temperature: params.temperature ?? 0.7,
        max_tokens: params.max_tokens ?? 4096,
        stream: true,
    };
    const stream = await client.chat.completions.create(body);
    for await (const chunk of stream) {
        yield chunk;
    }
}
//# sourceMappingURL=litellm.js.map
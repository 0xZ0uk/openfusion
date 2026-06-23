import OpenAI from "openai";
import { config } from "./config.js";
import { createModuleLogger } from "./logger.js";
import type { LiteLLMCompletionRequest, ToolCall } from "./types.js";

const log = createModuleLogger("litellm");

/**
 * Thin wrapper around LiteLLM's OpenAI-compatible API.
 * LiteLLM handles provider routing, key management, and failover.
 */
let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: config.litellm.apiKey,
      baseURL: `${config.litellm.baseUrl}/v1`,
      maxRetries: 1,
      timeout: 120_000,
      defaultHeaders: {
        "User-Agent": "fusion-service",
      },
      fetch: globalThis.fetch as any,
    });
  }
  return _client;
}

export interface CallResult {
  content: string;
  tool_calls?: ToolCall[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Non-streaming call to a single model via LiteLLM proxy.
 */
export async function callLiteLLM(
  params: LiteLLMCompletionRequest,
): Promise<CallResult> {
  const client = getClient();
  const modelName = params.model;
  const msgCount = params.messages.length;

  log.info("LLM call start", {
    model: modelName,
    messages: msgCount,
    tools: params.tools?.length ?? 0,
    response_format: params.response_format?.type,
  });

  const body: Record<string, unknown> = {
    model: modelName,
    messages: params.messages,
    temperature: params.temperature,
    max_tokens: params.max_tokens,
  };

  if (params.response_format) {
    body.response_format = params.response_format;
  }
  if (params.tools) {
    body.tools = params.tools;
  }
  if (params.tool_choice) {
    body.tool_choice = params.tool_choice;
  }

  const startTime = Date.now();
  const response = await client.chat.completions.create(body as any);
  const durationMs = Date.now() - startTime;

  const choice = response.choices?.[0];
  const msg = choice?.message;

  const toolCalls = msg?.tool_calls
    ?.filter((tc: any) => tc.type === "function")
    .map((tc: any) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

  if (!msg?.content && !toolCalls?.length) {
    log.error("Empty response from model", {
      model: modelName,
      durationMs,
      finish_reason: choice?.finish_reason,
    });
    throw new Error(`Empty response from model ${modelName}`);
  }

  const contentLen = msg?.content?.length ?? 0;
  log.info("LLM call complete", {
    model: modelName,
    durationMs,
    content_length: contentLen,
    tool_calls: toolCalls?.length ?? 0,
    finish_reason: choice?.finish_reason,
    usage: response.usage
      ? {
          prompt: response.usage.prompt_tokens,
          completion: response.usage.completion_tokens,
          total: response.usage.total_tokens,
        }
      : undefined,
  });

  log.debug("LLM response content", {
    model: modelName,
    content_preview: msg?.content?.slice(0, 200),
    tool_calls: toolCalls?.map((tc) => ({
      name: tc.function.name,
      args_preview: tc.function.arguments.slice(0, 100),
    })),
  });

  return {
    content: msg?.content ?? "",
    tool_calls: toolCalls?.length ? toolCalls : undefined,
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
export async function* callLiteLLMStream(
  params: LiteLLMCompletionRequest,
): AsyncGenerator<any> {
  const client = getClient();
  const modelName = params.model;

  log.info("LLM stream start", {
    model: modelName,
    messages: params.messages.length,
  });

  const body: Record<string, unknown> = {
    model: modelName,
    messages: params.messages,
    temperature: params.temperature ?? 0.7,
    max_tokens: params.max_tokens ?? 4096,
    stream: true,
  };

  const startTime = Date.now();
  const stream = await client.chat.completions.create(body as any) as any;

  let chunkCount = 0;
  let fullContent = "";

  for await (const chunk of stream) {
    chunkCount++;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) fullContent += delta;
    yield chunk;
  }

  const durationMs = Date.now() - startTime;
  log.info("LLM stream complete", {
    model: modelName,
    durationMs,
    chunks: chunkCount,
    content_length: fullContent.length,
  });
}

/**
 * Execute a tool call and return the result as a tool message.
 */
export interface ToolHandler {
  (name: string, args: Record<string, unknown>): Promise<string>;
}

/**
 * Tool-calling loop: calls the LLM with tools, executes any tool calls,
 * feeds results back, and repeats until the LLM returns a final text answer.
 * Max 3 tool-calling turns to prevent infinite loops.
 */
export async function callLiteLLMWithTools(
  params: LiteLLMCompletionRequest,
  toolHandler: ToolHandler,
  maxTurns = 3,
): Promise<CallResult> {
  const messages = [...params.messages];
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  log.info("LLM tool loop start", {
    model: params.model,
    maxTurns,
    initial_messages: messages.length,
  });

  for (let turn = 0; turn < maxTurns; turn++) {
    log.info("LLM tool loop turn", { model: params.model, turn: turn + 1 });
    const result = await callLiteLLM({ ...params, messages });

    if (result.usage) {
      totalUsage.prompt_tokens += result.usage.prompt_tokens;
      totalUsage.completion_tokens += result.usage.completion_tokens;
      totalUsage.total_tokens += result.usage.total_tokens;
    }

    // If the model returned text content with no more tool calls, we're done
    if (!result.tool_calls || result.tool_calls.length === 0) {
      log.info("LLM tool loop complete", {
        model: params.model,
        turns: turn + 1,
        usage: totalUsage,
      });
      return { content: result.content, usage: totalUsage };
    }

    log.info("LLM tool calls requested", {
      model: params.model,
      turn: turn + 1,
      tool_count: result.tool_calls.length,
      tools: result.tool_calls.map((tc) => tc.function.name),
    });

    // Add the assistant message with tool calls
    messages.push({
      role: "assistant",
      content: result.content || null as any,
      tool_calls: result.tool_calls,
    });

    // Execute each tool call and add results
    for (const tc of result.tool_calls) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(tc.function.arguments);
      } catch {
        parsed = {};
      }
      log.info("Executing tool", {
        model: params.model,
        tool: tc.function.name,
        args: parsed,
      });
      const toolResult = await toolHandler(tc.function.name, parsed);
      log.info("Tool result", {
        model: params.model,
        tool: tc.function.name,
        result_length: toolResult.length,
      });
      messages.push({
        role: "tool",
        content: toolResult,
        tool_call_id: tc.id,
      });
    }
  }

  // Exceeded max turns — do one final call without tools to get text output
  log.warn("LLM tool loop max turns reached, final forced call", {
    model: params.model,
    maxTurns,
  });
  const finalResult = await callLiteLLM({
    ...params,
    messages,
    tools: undefined,
    tool_choice: undefined,
  });

  if (finalResult.usage) {
    totalUsage.prompt_tokens += finalResult.usage.prompt_tokens;
    totalUsage.completion_tokens += finalResult.usage.completion_tokens;
    totalUsage.total_tokens += finalResult.usage.total_tokens;
  }

  return { content: finalResult.content, usage: totalUsage };
}

/**
 * Run tool-calling loop and return the final messages array (with tool results).
 * The caller can then use these messages for streaming without tools.
 */
export async function resolveTools(
  params: LiteLLMCompletionRequest,
  toolHandler: ToolHandler,
  maxTurns = 3,
): Promise<{
  messages: LiteLLMCompletionRequest["messages"];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}> {
  const messages = [...params.messages];
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  log.info("Resolve tools start", {
    model: params.model,
    maxTurns,
    initial_messages: messages.length,
  });

  for (let turn = 0; turn < maxTurns; turn++) {
    log.info("Resolve tools turn", { model: params.model, turn: turn + 1 });
    const result = await callLiteLLM({ ...params, messages });

    if (result.usage) {
      totalUsage.prompt_tokens += result.usage.prompt_tokens;
      totalUsage.completion_tokens += result.usage.completion_tokens;
      totalUsage.total_tokens += result.usage.total_tokens;
    }

    if (!result.tool_calls || result.tool_calls.length === 0) {
      log.info("Resolve tools complete", {
        model: params.model,
        turns: turn + 1,
        usage: totalUsage,
      });
      return { messages, usage: totalUsage };
    }

    log.info("Resolve tools calls", {
      model: params.model,
      turn: turn + 1,
      tool_count: result.tool_calls.length,
      tools: result.tool_calls.map((tc) => tc.function.name),
    });

    messages.push({
      role: "assistant",
      content: result.content || null as any,
      tool_calls: result.tool_calls,
    });

    for (const tc of result.tool_calls) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(tc.function.arguments);
      } catch {
        parsed = {};
      }
      log.info("Resolve tools executing tool", {
        tool: tc.function.name,
        args: parsed,
      });
      const toolResult = await toolHandler(tc.function.name, parsed);
      log.info("Resolve tools tool result", {
        tool: tc.function.name,
        result_length: toolResult.length,
      });
      messages.push({
        role: "tool",
        content: toolResult,
        tool_call_id: tc.id,
      });
    }
  }

  log.warn("Resolve tools max turns reached", { model: params.model, maxTurns });
  return { messages, usage: totalUsage };
}

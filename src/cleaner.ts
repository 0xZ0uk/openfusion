/**
 * Clean agent artifacts from model responses.
 *
 * Many coding-agent models emit tool calls, agent directives, and metadata
 * inline in their text output even when instructed not to. This strips the
 * most common patterns before passing responses to the judge or client.
 */

const AGENT_PATTERNS: RegExp[] = [
  // XML-style tool calls: <tool_call><function=name>...</tool_call>
  /<tool_call>[\s\S]*?<\/tool_call>/gi,

  // Self-contained function tags: <function=name>...</function>
  /<function=\w+>[\s\S]*?<\/function>/gi,

  // Standalone parameter tags: <parameter=name>value</parameter>
  /<parameter=\w+>[\s\S]*?<\/parameter>/gi,

  // ctx_* agent function calls: ctx_overview(...), ctx_shell(...), ctx_search(...)
  /\bctx_\w+\s*\([\s\S]*?\)\s*/gi,

  // dc-specific message IDs: <dcp-message-id>m0002</dcp-message-id>
  /<dcp?-message-id>[\s\S]*?<\/dcp?-message-id>/gi,

  // [agent: ...] blocks
  /\[agent:\s*[\w_]+\][\s\S]*?(?=\[|$)/gi,

  // Standalone agent JSON blocks: {"task": "..."} or {"subagent_type": "..."}
  /\{(?:\s*"(?:task|subagent_type|description|prompt)"\s*:[\s\S]*?\})\s*/gi,
];

/**
 * Strip agent artifacts from a model response string.
 * Returns cleaned text. If the result is empty after stripping,
 * returns a descriptive placeholder.
 */
export function cleanResponse(raw: string, modelName?: string): string {
  if (!raw) return raw;

  let cleaned = raw;

  for (const pattern of AGENT_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }

  // Clean up excessive whitespace from removed blocks
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  if (!cleaned) {
    return modelName
      ? `[${modelName} returned agent directives only — content unavailable]`
      : "[Response contained agent directives only — content unavailable]";
  }

  return cleaned;
}

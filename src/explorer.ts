import { createModuleLogger } from "./logger.js";
import type { LiteLLMCompletionRequest } from "./types.js";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import { execSync } from "node:child_process";

const log = createModuleLogger("explorer");

// ---- Tool definitions ----

const readFileTool = {
  type: "function" as const,
  function: {
    name: "read_file",
    description:
      "Read the contents of a file. Use this to inspect source code, config files, docs, etc.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file (relative to project root)",
        },
      },
      required: ["path"],
    },
  },
};

const listDirTool = {
  type: "function" as const,
  function: {
    name: "list_directory",
    description:
      "List files and directories in a directory. Use this to explore project structure.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path (relative to project root). Defaults to root.",
        },
      },
      required: [],
    },
  },
};

const globTool = {
  type: "function" as const,
  function: {
    name: "glob",
    description:
      "Find files matching a glob pattern. Use this to locate specific file types or configuration files.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Glob pattern (e.g. '**/*.ts', '**/package.json', '**/*.md')",
        },
        path: {
          type: "string",
          description: "Base directory for the search (defaults to project root)",
        },
      },
      required: ["pattern"],
    },
  },
};

const searchTextTool = {
  type: "function" as const,
  function: {
    name: "search_text",
    description:
      "Search for text/regex within files. Use this to find imports, function definitions, patterns, etc.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Search pattern (regex supported)",
        },
        path: {
          type: "string",
          description: "Directory to search (defaults to project root)",
        },
        file_glob: {
          type: "string",
          description: "Only search files matching this glob (e.g. '*.ts', '*.json')",
        },
      },
      required: ["pattern"],
    },
  },
};

export const EXPLORER_TOOLS = [readFileTool, listDirTool, globTool, searchTextTool];

// ---- Safety ----

const MAX_FILE_SIZE = 100 * 1024; // 100KB

function resolvePath(requestedPath: string, cwd: string): string {
  // If absolute, just resolve it. Otherwise resolve relative to cwd.
  const resolved = requestedPath.startsWith(sep)
    ? resolve(requestedPath)
    : resolve(join(cwd, requestedPath));

  // Prevent directory traversal outside allowed roots
  // We allow: cwd and its subdirectories
  const allowed = resolve(cwd);
  if (!resolved.startsWith(allowed + sep) && resolved !== allowed) {
    // Also allow /tmp, /home, /root etc — the user's machine
    // But warn about paths far from cwd
    const rel = relative(cwd, resolved);
    if (rel.startsWith("..") && !resolved.startsWith("/home") && !resolved.startsWith("/root") && !resolved.startsWith("/tmp")) {
      throw new Error(`Path traversal blocked: ${requestedPath}`);
    }
  }
  return resolved;
}

async function isTextFile(filePath: string): Promise<boolean> {
  try {
    const fd = await import("node:fs/promises").then(m => m.open(filePath, "r"));
    const buf = Buffer.alloc(8192);
    await fd.read(buf, 0, 8192, 0);
    await fd.close();
    return !buf.includes(0);
  } catch {
    return false;
  }
}

// ---- Tool handlers ----

async function handleReadFile(filePath: string, cwd: string): Promise<string> {
  const resolved = resolvePath(filePath, cwd);
  const s = await stat(resolved);
  if (!s.isFile()) return `Not a file: ${filePath}`;
  if (s.size > MAX_FILE_SIZE) {
    return `File too large (${(s.size / 1024).toFixed(0)}KB). Max: ${MAX_FILE_SIZE / 1024}KB. Use search_text or glob instead.`;
  }
  if (!(await isTextFile(resolved))) {
    return `Binary file: ${filePath}. Cannot display contents.`;
  }
  const content = await readFile(resolved, "utf-8");
  log.info("Read file", { path: filePath, size: content.length });
  return `\`\`\`\n// ${filePath}\n${content}\n\`\`\``;
}

async function handleListDir(dirPath: string | undefined, cwd: string): Promise<string> {
  const resolved = dirPath ? resolvePath(dirPath, cwd) : cwd;
  const entries = await readdir(resolved, { withFileTypes: true });
  const listing = entries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => {
      const prefix = e.isDirectory() ? "📁" : "📄";
      return `${prefix} ${e.name}`;
    })
    .join("\n");
  return listing || "(empty directory)";
}

async function handleGlob(pattern: string, basePath: string | undefined, cwd: string): Promise<string> {
  const base = basePath ? resolvePath(basePath, cwd) : cwd;
  try {
    const result = execSync(`find ${base} -path '*/node_modules' -prune -o -path '*/.git' -prune -o -name '${pattern.replace(/\*/g, "*").replace(/\?/g, "?")}' -print 2>/dev/null | head -50`, {
      encoding: "utf-8",
      timeout: 10_000,
    });
    const lines = result.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return "No matching files found.";
    return lines.map((l) => relative(cwd, l) || l).join("\n");
  } catch {
    // Fallback: simple find
    try {
      const result = execSync(`find ${base} -path '*/node_modules' -prune -o -path '*/.git' -prune -o -name "${pattern}" -print 2>/dev/null | head -50`, {
        encoding: "utf-8",
        timeout: 10_000,
      });
      const lines = result.trim().split("\n").filter(Boolean);
      return lines.length > 0 ? lines.join("\n") : "No matching files found.";
    } catch {
      return "No matching files found (search error).";
    }
  }
}

async function handleSearch(
  pattern: string,
  dirPath: string | undefined,
  fileGlob: string | undefined,
  cwd: string,
): Promise<string> {
  const base = dirPath ? resolvePath(dirPath, cwd) : cwd;
  try {
    let cmd: string;
    if (fileGlob) {
      cmd = `rg -l --no-heading '${pattern.replace(/'/g, "'\\''")}' -g '${fileGlob}' ${base} 2>/dev/null | head -30`;
    } else {
      cmd = `rg -l --no-heading '${pattern.replace(/'/g, "'\\''")}' ${base} 2>/dev/null | head -30`;
    }
    const result = execSync(cmd, {
      encoding: "utf-8",
      timeout: 15_000,
    });
    const lines = result.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return "No matches found.";
    return lines.map((l) => relative(cwd, l) || l).join("\n");
  } catch {
    return "Search failed or no matches found.";
  }
}

// ---- Public API ----

export interface ExplorerContext {
  summary: string;
  toolResults: string[];
}

/**
 * Resolve path for explorer tools (public, for validation).
 */
export function getExplorerCwd(): string {
  return process.cwd();
}

/**
 * Handle a tool call from the explorer phase.
 */
export async function handleExplorerTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  log.info("Explorer tool call", { tool: name, args });
  try {
    switch (name) {
      case "read_file":
        return await handleReadFile(args.path as string, cwd);
      case "list_directory":
        return await handleListDir(args.path as string, cwd);
      case "glob":
        return await handleGlob(args.pattern as string, args.path as string, cwd);
      case "search_text":
        return await handleSearch(
          args.pattern as string,
          args.path as string,
          args.file_glob as string,
          cwd,
        );
      default:
        return `Unknown tool: ${name}. Available tools: read_file, list_directory, glob, search_text.`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Explorer tool error", { tool: name, error: msg });
    return `Error: ${msg}`;
  }
}

/**
 * Extract exploration context from resolved message history.
 * Returns a formatted string with the exploration summary and tool results.
 */
export function extractExplorationContext(
  messages: LiteLLMCompletionRequest["messages"],
): string {
  // Find the last meaningful assistant message (summary)
  const assistantMsgs = messages.filter(
    (m) => m.role === "assistant" && m.content && m.content.length > 20,
  );
  const summary = assistantMsgs.length > 0
    ? assistantMsgs[assistantMsgs.length - 1].content ?? ""
    : "";

  // Collect tool results
  const toolResults = messages
    .filter((m) => m.role === "tool" && m.content)
    .map((m) => m.content ?? "");

  const parts: string[] = [];

  if (summary) {
    parts.push(`## Exploration Summary\n\n${summary}\n`);
  }

  if (toolResults.length > 0) {
    parts.push(
      `## Discovered Files and Findings\n\n${toolResults.join("\n\n")}`,
    );
  }

  return parts.join("\n\n");
}

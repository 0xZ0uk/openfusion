import { defineAgent } from "@flue/runtime";
import { local } from "@flue/runtime/node";

import readFileTool from "../tools/read-file.js";
import listDirTool from "../tools/list-directory.js";
import globTool from "../tools/glob.js";
import searchTextTool from "../tools/search-text.js";

export default defineAgent(() => ({
  model: process.env.FUSION_MODEL ?? "openai/mimo-v2.5",
  tools: [readFileTool, listDirTool, globTool, searchTextTool],
  sandbox: local(),
  instructions: `You are a helpful coding assistant with access to the codebase filesystem.

You can:
- Read files to understand their contents
- List directories to explore project structure
- Use glob to find files matching patterns
- Search for text within files

When asked about a codebase:
1. Explore the project structure first to understand what you're looking at
2. Read key files (README, package.json, config files, source code)
3. Provide thorough, well-structured answers
4. Use markdown formatting for clarity

Do NOT make assumptions about the codebase without reading files first.
Always verify your understanding by reading the actual source code.
Do NOT write or modify files — you are read-only in this mode.`,
}));

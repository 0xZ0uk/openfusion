# Slice 01: Outer Agent with Codebase Exploration

**Phase:** 1  
**Estimate:** 3 days  
**Dependencies:** None  

## Description

The foundational slice. Install Flue, configure LiteLLM as a model provider, define the outer coding agent with filesystem exploration tools, and get a working CLI session. The agent can understand a codebase, answer questions about it, and navigate project structure — but cannot yet write files or invoke fusion.

This slice delivers the first vertical: a user can start a session, ask "what does this project do?", and get a useful answer backed by real tool use.

---

## Issues

### O2-001: Scaffold Flue project and configure LiteLLM provider

Install `@flue/runtime` and `@flue/cli`. Create `flue.config.ts` that registers the LiteLLM proxy as a custom provider via `registerProvider()`. Verify the provider resolves models correctly.

**Acceptance criteria:**
- `npm install @flue/runtime @flue/cli` succeeds
- `registerProvider("litellm", { api: "openai-chat", baseUrl, apiKey })` configured
- Agent can make a model call through LiteLLM (simple "hello" completes)

### O2-002: Define filesystem exploration tools

Create Flue `defineTool()` entries for the tools the outer agent needs to explore a codebase:

- `read_file(path)` — read file contents (max 100KB, text-only detection)
- `list_directory(path)` — list files and directories
- `glob(pattern)` — find files matching a glob
- `search_text(pattern, path?, file_glob?)` — grep within files

Each tool uses Valibot schema for input validation. The tools operate within the agent's sandbox (Flue's `local()` sandbox).

**Acceptance criteria:**
- All four tools are defined with proper schemas
- Tools can be called by the agent and return correct results
- Path traversal is blocked by the sandbox
- Binary files are rejected

### O2-003: Define outer agent with exploration instructions

Create agent definition using `defineAgent()` with:
- Model: configured via LiteLLM provider (default: `mimo-v2.5`)
- Tools: read_file, list_directory, glob, search_text
- Sandbox: `local()` — restricted to the project directory
- Instructions: system prompt that defines the agent's coding-assistant behavior

The instructions should establish:
- The agent's role (helpful coding assistant)
- Tool usage guidelines (when to explore, how to read files)
- Output style (clear, thorough, well-structured)

**Acceptance criteria:**
- `defineAgent()` returns a valid agent definition
- Agent starts in a CLI session
- Agent uses tools to explore the codebase when asked
- Agent answers questions based on tool results

### O2-004: Create CLI entry point and verify session

Set up the CLI so the user can start an interactive session with `fusion dev` (or `npx flue dev`). The session should:
- Start in the current working directory
- Accept natural language prompts
- Show tool usage as it happens
- Return coherent answers

**Acceptance criteria:**
- `fusion dev` starts an interactive session
- User can ask "what does this project do?" and get a real answer
- User can ask "show me the directory structure" and get a listing
- User can ask "find files that import X" and get search results
- Session history persists across turns within a session

### O2-005: Add `.gitignore` entry for `.flue/` and Flue build artifacts

Flue generates runtime files (`.flue/` directory, build output). These should not be tracked in git.

**Acceptance criteria:**
- `.gitignore` updated with Flue-specific entries
- No Flue-generated files are tracked

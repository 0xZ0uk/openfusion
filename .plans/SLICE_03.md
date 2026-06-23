# Slice 03: Write/Edit Tools + API Compatibility

**Phase:** 3  
**Estimate:** 2 days  
**Dependencies:** SLICE_02  

## Description

Add write/edit capabilities to the outer agent so it can modify code, run commands, and use git. Then port the `/v1/chat/completions` API from Openfusion v1 to work with the Flue-based agent, maintaining backward compatibility for existing clients (OpenCode, Cursor, etc.).

This slice makes the agent truly useful as a coding assistant — it can read, write, test, and commit code — and ensures existing integrations still work.

---

## Issues

### O2-011: Implement write_file and bash tools

Create two new tools:

- `write_file(path, content)` — write content to a file (with safety checks: max file size, binary detection, confirmation for overwrites)
- `bash(command)` — execute a shell command with timeout and output capture (restricted to safe commands, no interactive processes)

Both tools operate within the Flue sandbox.

**Acceptance criteria:**
- Agent can create new files
- Agent can edit existing files
- Agent can run shell commands (ls, cat, npm test, etc.)
- Long-running commands timeout gracefully
- Dangerous commands (rm -rf /, etc.) are blocked by the sandbox

### O2-012: Implement git tools

Create git helper tools:

- `git_status()` — show working tree status
- `git_diff(path?)` — show unstaged diff
- `git_commit(message)` — stage all and commit
- `git_log(count?)` — show recent commit history

**Acceptance criteria:**
- Agent can check git status
- Agent can view diffs before committing
- Agent can commit changes with a message
- Agent can view recent commit history

### O2-013: Port /v1/chat/completions endpoint to Flue

Replace the current custom pipeline handler with a Flue-based handler. The endpoint should:

- Accept standard OpenAI-compatible chat completion requests
- Detect fusion requests (via `fusion_config` or `model: "fusion"`)
- Route non-fusion requests to LiteLLM passthrough
- Route fusion requests through the Flue agent pipeline:
  1. Create a Flue session
  2. Submit the request to the outer agent
  3. Return the response in OpenAI format

**Acceptance criteria:**
- `POST /v1/chat/completions` works with standard OpenAI clients
- Passthrough mode (no fusion_config) proxies to LiteLLM correctly
- Fusion mode triggers the Flue agent pipeline
- Response format matches OpenAI chat completion schema

### O2-014: Streaming support for API endpoint

Implement SSE streaming for the API endpoint. The outer agent's response is streamed as OpenAI-compatible chunks. For fusion requests, the panel+judge phases complete silently, and only the outer agent's final composition is streamed.

**Acceptance criteria:**
- `stream: true` returns SSE stream
- Stream format matches OpenAI chat completion chunk schema
- Panel+judge phases are not streamed (they complete silently)
- Only the final outer agent output is streamed

### O2-015: Backward compatibility smoke test

Verify that existing Openfusion clients (OpenCode, curl scripts, test suite) work against the new endpoint.

**Acceptance criteria:**
- OpenCode passthrough mode works (tools flow through)
- Fusion requests return structured responses
- All v1 API features are supported
- No regressions in response format

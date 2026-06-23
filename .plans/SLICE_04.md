# Slice 04: Production Hardening + Skills

**Phase:** 4  
**Estimate:** 2 days  
**Dependencies:** SLICE_03  

## Description

Harden the agent for production use. Add session persistence so conversations survive restarts. Tighten sandbox security. Implement error handling and recovery patterns. Add additional skills (code-review, test-writing) that the outer agent can use for specialized tasks. Optimize performance.

This slice turns the prototype into a reliable daily-driver tool.

---

## Issues

### O2-016: Session persistence with Postgres

Flue supports pluggable session stores. Add Postgres persistence so sessions survive agent restarts. Sessions include conversation history, agent state, and in-progress work.

**Acceptance criteria:**
- Sessions persist across `fusion dev` restarts
- Postgres connection configured via env vars
- Session history is queryable
- Session cleanup (expired sessions are archived/deleted)

### O2-017: Sandbox hardening

Review and harden the Flue sandbox configuration:

- Restrict bash commands to a safe allowlist
- Set max execution time per tool call (30s default, configurable)
- Set max file size for read/write (1MB read, 500KB write)
- Block path traversal outside the project directory
- Rate-limit tool calls (max 20 per minute)

**Acceptance criteria:**
- Dangerous commands are blocked
- Slow commands are timed out
- Large files are rejected with clear error messages
- Path traversal attempts are logged and blocked

### O2-018: Error handling and recovery

Implement robust error handling:

- Model call failures → retry with fallback model
- Tool execution failures → clear error message to agent
- Session crashes → auto-recovery on restart
- Subagent failures → graceful degradation (fewer panel members)
- Timeout handling per pipeline phase

**Acceptance criteria:**
- Agent recovers from transient model failures
- Panel continues with 2+ members even if some fail
- Session survives an agent crash
- Error messages are useful, not cryptic stack traces

### O2-019: Code-review skill

Create a reusable `code-review` skill as a `SKILL.md` + implementation. The skill:

1. Takes a file path or diff as input
2. Analyzes the code for issues (bugs, style, security, performance)
3. Returns structured feedback with severity levels
4. Can optionally invoke the fusion panel for complex reviews

**Acceptance criteria:**
- Skill is registered and loadable
- Agent invokes it on "review this file" requests
- Feedback is structured and actionable
- Skill can request fusion panel for complex cases

### O2-020: Test-writing skill

Create a `test-writing` skill that:

1. Takes a file path as input
2. Analyzes the code and identifies testable units
3. Generates test files using the project's test framework
4. Runs the tests and reports results
5. Iterates on failures until tests pass or gives up

**Acceptance criteria:**
- Skill detects the project's test framework (vitest, jest, etc.)
- Generates proper test files
- Runs tests and reports pass/fail
- Iterates on failures with fixes
- Gives up after N failed attempts instead of looping forever

### O2-021: Performance optimization

Profile and optimize the pipeline:

- Reduce panel model max_tokens to speed up slow models
- Implement response caching for repeated fusion queries
- Add parallel model calls for panel members (Flue should handle this, verify)
- Optimize exploration phase to hit tools faster and summarize sooner

**Acceptance criteria:**
- Typical fusion pipeline completes in < 60s (down from 4+ min)
- CLI feels responsive (first tool results within 5s)
- No regression in output quality

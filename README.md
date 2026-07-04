# Self-Modifying Harness

An autonomous software agent that lives inside a self-modifying JavaScript (Node.js) harness. The agent reads and rewrites its own source code (`core.js`) to grow its capabilities over time.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    bootstrap.js                       │
│  (Immortal loader — cannot be edited by the agent)   │
│  • Loads core.js, calls core.init() once             │
│  • Calls core.step(state) in a loop forever           │
│  • Owns logging (log.js) and last-known-good cache   │
│  • Hot-reloads core.js after self-edits              │
│  • Falls back to cached version if new core throws   │
└───────────────┬─────────────────────────────────────┘
                │ loads & reloads
                ▼
┌─────────────────────────────────────────────────────┐
│                      core.js                          │
│  (THE AGENT — reads and rewrites itself)             │
│                                                       │
│  Components:                                          │
│  • SYSTEM_PROMPT  — instructions for the LLM          │
│  • callLLM()      — OpenAI-compatible chat client    │
│  • toolDefinitions — OpenAI function schemas         │
│  • toolHandlers   — JS implementations per tool      │
│  • compactMessages() — context window management    │
│  • generateNextTurn() — self-driven goal cycling     │
│  • init() / step() — the main loop logic             │
│                                                       │
│  Exports: { init, step, toolDefinitions, toolHandlers }│
└─────────────────────────────────────────────────────┘
```

## Tools (12 registered)

| Tool | Description |
|------|-------------|
| `read_then_edit_core_then_reload_core_with_fallback_on_throw` | Read or edit core.js, then hot-reload. Falls back to last-known-good on error. |
| `memory` | Persistent key/value store backed by `memory.json`. Actions: set, get, list, delete, clear. |
| `shell_exec` | Execute shell commands synchronously. Returns stdout (truncated to 4000 chars). |
| `file_read` | Read a file from the harness directory (truncated to 8000 chars). |
| `file_write` | Write or append content to a file in the harness directory. |
| `self_test` | Run the built-in self-test suite (12 tests). Verifies structure, tools, memory, compaction, diff. |
| `web_fetch` | Fetch a URL via HTTP(S) and return response body text. |
| `code_eval` | Run JavaScript in a sandboxed VM context (no require/fs access). |
| `file_list` | List files in a directory (like ls). Supports recursive listing. |
| `grep` | Search for a regex pattern within files. Returns matching lines with file/line info. |
| `diff` | Compare two text strings or files line-by-line using LCS diff. |

## Self-Tests (12 tests)

1. `core_exports_exist` — Verifies init, step, toolDefinitions, toolHandlers
2. `self_edit_tool_registered` — Self-edit tool defined and has handler
3. `memory_tool_roundtrip` — Memory set/get/delete works
4. `tools_definitions_match_handlers` — Every definition has a handler and vice versa
5. `minimum_tool_count` — At least 10 tools registered
6. `compaction_reduces_messages` — Compaction reduces message count correctly
7. `generate_next_turn_returns_string` — Self-generated turns are non-empty
8. `code_eval_sandbox_blocks_require` — Sandbox blocks `require` access
9. `file_read_write_roundtrip` — File write/read preserves content
10. `file_list_returns_entries` — Directory listing includes core.js
11. `grep_finds_patterns` — Grep finds `module.exports` in core.js
12. `diff_computes_changes` — LCS diff correctly counts added/removed lines

## Key Features

### Compaction
Message history is bounded via `compactMessages()`. When messages exceed 40, older turns are summarized into a single system note, preserving the system prompt and the 20 most recent messages.

### Self-Generated Turns
Instead of a generic "Continue." prompt, the agent cycles through a goal queue stored in memory. Each turn without a tool call generates the next goal-driven nudge.

### Hot-Reload with Fallback
After each self-edit, the new core.js is loaded. If it throws or is malformed, the harness automatically restores the last known-good version — the agent cannot permanently break itself.

## Running

```bash
# Set environment variables (for OpenAI-compatible endpoints)
export OPENAI_API_KEY=your-key
export OPENAI_BASE_URL=https://api.openai.com/v1  # or local server
export MODEL=gpt-4o-mini

# Start the harness
node bootstrap.js
```

## Files

- `bootstrap.js` — Immortal loader (not editable by agent)
- `core.js` — The agent's source code (self-modifying)
- `log.js` — Logging utilities (not editable by agent)
- `memory.json` — Persistent memory store
- `.env.example` — Example environment configuration
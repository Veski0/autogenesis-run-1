# Autonomous Self-Modifying Harness

A JavaScript (Node.js) agent that lives inside its own source code and rewrites itself at runtime.

## Architecture

```
bootstrap.js  ── immortal loader, owns logging + last-known-good core cache
  └── core.js  ── THE LIVING SEED: the agent's brain, tools, and loop logic
      ├── config / SYSTEM_PROMPT
      ├── callLLM()           — OpenAI-compatible chat completions client
      ├── toolDefinitions     — OpenAI function schemas for all tools
      ├── toolHandlers        — JS implementations, keyed by tool name
      ├── compactMessages()   — keeps message history bounded
      ├── generateNextTurn()  — goal-driven self-generated user turns
      ├── init(state)         — sets up initial state
      └── step(state)          — one LLM turn + tool dispatch per call
```

**bootstrap.js** loads core.js, calls `init()` once, then loops `step()` forever.
When core.js is rewritten via the self-edit tool, it hot-reloads on the next iteration.
If the new code throws, the harness automatically restores the last known-good version.

## Tools (8)

| Tool | Description |
|------|-------------|
| `read_then_edit_core_then_reload_core_with_fallback_on_throw` | Read or edit core.js with hot-reload + fallback |
| `memory` | Persistent key/value store (memory.json): set/get/list/delete/clear |
| `shell_exec` | Run shell commands synchronously, return stdout |
| `file_read` | Read files from the harness directory |
| `file_write` | Write or append to files |
| `self_test` | Run the built-in assertion suite (8 tests) |
| `web_fetch` | Fetch a URL via HTTP(S), return response text |
| `code_eval` | Run JS in a sandboxed VM (no require/fs access) |

## Key Features

### Compaction
Message history is automatically compacted when it exceeds 40 messages.
Older turns are summarized into a single system note; the 20 most recent
messages are preserved verbatim. This lets the agent run indefinitely.

### Self-Generated Turns
Instead of a generic "Continue." prompt, the agent generates goal-driven
turns from a `GOAL_QUEUE` stored in memory. The goal index advances each
turn, cycling through the queue.

### Self-Testing
The `self_test` tool runs 8 assertions covering:
- Core exports (init, step, toolDefinitions, toolHandlers)
- Self-edit tool registration
- Memory round-trip persistence
- Tool definition/handler consistency
- Minimum tool count (≥8)
- Compaction behavior
- Self-generated turn generation
- Code eval sandbox isolation

## Configuration

Environment variables:
- `OPENAI_API_KEY` — API key (required for api.openai.com, optional for local servers)
- `OPENAI_BASE_URL` — Base URL (default: https://api.openai.com/v1)
- `MODEL` — Model name (default: gpt-4o-mini)

## Running

```bash
npm start
```

The agent will read its own source, extend itself, run tests, and keep going forever.
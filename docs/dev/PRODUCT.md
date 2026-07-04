The idea is simple: a harness that can build itself from a tiny core:

- An OpenAI-compatible LLM turn structure: system, user, assistant
- A single pre-defined tool: `read_then_edit_core_then_reload_core_with_fallback_on_throw`

- read_then_edit_core_then_reload_core_with_fallback_on_throw:
    - Initialises two tool calls:
        - Reads the core file
        - Edits the core file
    - The core attempts to reload, falling back to the previous (cached) version on throw

- The system prompt instructs the model to build outwards, adding as much utility as possible
- The first user turn instructs the model to proceed
- The system prompt should include hints to:
    - add tools
    - add testing
    - add compaction
    - add assistant-generated or automated user turns - otherwise they will halt

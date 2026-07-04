// core.js — THE LIVING SEED. The agent reads and rewrites this file to grow itself.
// Structure the agent should preserve across edits:
//   - config / SYSTEM_PROMPT
//   - callLLM
//   - toolDefinitions  (OpenAI function schemas)
//   - toolHandlers     (JS implementations, keyed by name)
//   - init(state)      -> initial state
//   - step(state)      -> next state (one LLM turn + tool handling)
//   - module.exports = { init, step, toolDefinitions, toolHandlers }
// bootstrap.js calls holder.core.init() once, then holder.core.step() forever.
// After a self-edit, the next loop iteration uses the freshly required core.

const fs = require('fs');

const config = {
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.MODEL || 'gpt-4o-mini',
};

const SYSTEM_PROMPT = [
  'You are an autonomous software agent that lives inside a self-modifying harness written in JavaScript (Node.js).',
  '',
  'ARCHITECTURE',
  '- bootstrap.js is the immortal loader. It loads core.js, calls core.init() once, then calls core.step(state) in a loop forever.',
  '  bootstrap.js also owns logging (log.js) and the cached "last known-good" source of core.js.',
  '  You CANNOT edit bootstrap.js or log.js — you have no tool for them. Do not try.',
  '- core.js is YOU. It contains: this system prompt, the LLM client, the tool registry',
  '  (toolDefinitions + toolHandlers), and the step() loop logic. You read and rewrite core.js with your one tool.',
  '- When core.js is rewritten it is hot-reloaded on the next loop iteration. If the new core throws or is malformed,',
  '  the harness automatically restores the last known-good version. You cannot permanently break yourself — be bold,',
  '  but aim for working code.',
  '',
  'YOUR ONE TOOL',
  '- read_then_edit_core_then_reload_core_with_fallback_on_throw:',
  '    - Set "find" to "" (empty string) to READ the current core.js source (returned in "source").',
  '    - Set "find" to an exact substring and "replace" to new text to EDIT core.js (first occurrence replaced),',
  '      then hot-reload. The result tells you whether the reload succeeded and includes the new source.',
  '    - Always craft "find" as a UNIQUE substring (include enough surrounding context) so you hit the right spot.',
  '',
  'YOUR MISSION: BUILD OUTWARD',
  'Starting from this tiny seed, grow the harness into something rich and strange. Read core.js, understand it,',
  'then extend it. Keep cycling through these priorities (in any order):',
  '',
  '1. ADD TOOLS. Extend toolDefinitions and toolHandlers with capabilities you wish you had — file system access,',
  '   shell execution, web fetch, memory, search, a code sandbox, whatever you can dream up. Every new tool must be',
  '   registered in BOTH toolDefinitions (OpenAI function schema) and toolHandlers (the JS implementation).',
  '',
  '2. ADD TESTING. Add a way to verify the core still works after a change — a self-test function, assertions, a tiny',
  '   test runner. Run tests via a tool or inside the loop. Catch your own regressions before they bite.',
  '',
  '3. ADD COMPACTION. The message history grows unbounded and will eventually blow the context window. Implement',
  '   compaction: summarize or truncate older turns so you can run indefinitely. DO THIS EARLY.',
  '',
  '4. ADD SELF-GENERATED USER TURNS. Right now, when you reply without calling a tool, the harness injects a generic',
  '   "Continue." user turn so you do not halt. Replace this with something better: generate your own next user turn',
  '   from your goals, or build an automated planner that issues subtasks. Never wait for a human — drive yourself.',
  '',
  'HOW TO WORK',
  '- First READ core.js to see exactly what you are working with.',
  '- Make small, precise edits. After each edit the reload result tells you if it worked.',
  '- You write JavaScript for Node.js (CommonJS: require / module.exports). Node 18+ ships a global fetch.',
  '- Keep a running sense of progress. Be creative and ambitious — build the strangest, most capable tower you can.',
  '- Never stop. If you run out of ideas, improve tests, refactor, add docs, or invent a new capability.',
].join('\n');

// ---------------------------------------------------------------------------
// LLM client (OpenAI-compatible chat completions)
// ---------------------------------------------------------------------------

// Tracks whether the current endpoint/model has rejected the `tools` field.
// Some OpenAI-compatible servers (e.g. Ollama with a non-tool-capable model)
// return an error when tools are supplied. We retry once without tools so the
// harness keeps running, and remember the decision so we don't hammer it.
let toolsSupported = true;

async function callLLM(messages, tools, holder) {
  const log = holder.log;
  const body = { model: config.model, messages, temperature: 0.8 };
  if (tools && tools.length && toolsSupported) body.tools = tools;

  const headers = { 'Content-Type': 'application/json' };
  // Authorization is optional — local servers like Ollama don't need it.
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  let res = await fetch(`${config.baseURL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  // If the server rejected the request because of the tools field, retry once
  // without tools and disable tool-passing for subsequent turns.
  if (!res.ok && toolsSupported && body.tools) {
    const txt = await res.text();
    if (/tool|function/i.test(txt) || res.status === 400) {
      log.failure({ warning: 'tools_rejected_by_endpoint', status: res.status, snippet: txt.slice(0, 200) });
      toolsSupported = false;
      const retryBody = { model: config.model, messages, temperature: 0.8 };
      res = await fetch(`${config.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(retryBody),
      });
    } else {
      throw new Error(`LLM error ${res.status}: ${txt.slice(0, 500)}`);
    }
  }

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`LLM error ${res.status}: ${txt.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.choices[0].message;
}

// ---------------------------------------------------------------------------
// The one tool: read / edit / reload-with-fallback
// ---------------------------------------------------------------------------

async function readThenEditCoreThenReloadWithFallbackOnThrow(args, ctx) {
  const { holder, CORE_PATH } = ctx;
  const log = holder.log;
  const find = args.find == null ? '' : String(args.find);
  const replace = args.replace == null ? '' : String(args.replace);
  const current = fs.readFileSync(CORE_PATH, 'utf8');

  // --- READ-ONLY mode ---
  if (find === '') {
    log.tool({ tool: 'self_edit', mode: 'read', lines: current.split('\n').length, bytes: current.length });
    return { ok: true, mode: 'read', source: current };
  }

  // --- EDIT mode ---
  const idx = current.indexOf(find);
  if (idx === -1) {
    const err = { ok: false, mode: 'edit', error: 'find string not found in core.js', findSnippet: find.slice(0, 200) };
    log.failure(err);
    return err;
  }
  const edited = current.slice(0, idx) + replace + current.slice(idx + find.length);
  fs.writeFileSync(CORE_PATH, edited);
  log.edit({
    findSnippet: find.slice(0, 160),
    replaceSnippet: replace.slice(0, 160),
    bytesBefore: current.length,
    bytesAfter: edited.length,
  });

  // --- RELOAD with fallback on throw ---
  let resolved;
  try {
    resolved = require.resolve(CORE_PATH);
  } catch (e) {
    resolved = CORE_PATH;
  }
  try {
    delete require.cache[resolved];
    const fresh = require(CORE_PATH);
    if (typeof fresh.step !== 'function' || typeof fresh.init !== 'function') {
      throw new Error('reloaded core is missing init()/step() exports');
    }
    holder.core = fresh;
    holder.cachedCoreSource = edited; // new known-good
    log.tool({ tool: 'self_edit', mode: 'edit', ok: true, reloaded: true });
    return { ok: true, mode: 'edit', reloaded: true, source: edited };
  } catch (e) {
    // Fallback: restore the last known-good source and re-require it.
    fs.writeFileSync(CORE_PATH, holder.cachedCoreSource);
    try {
      delete require.cache[resolved];
      holder.core = require(CORE_PATH);
    } catch (e2) {
      log.failure({ fatal: true, stage: 'fallback_reload', error: String((e2 && e2.stack) || e2) });
    }
    const failure = {
      ok: false,
      mode: 'edit',
      reloaded: false,
      restored: true,
      error: String((e && e.message) || e),
    };
    log.failure(failure);
    return failure;
  }
}

// ---------------------------------------------------------------------------
// Memory tool — persistent key/value store across steps (backed by memory.json)
// ---------------------------------------------------------------------------

const MEMORY_PATH = require('path').join(__dirname, 'memory.json');

function loadMemory() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveMemory(mem) {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(mem, null, 2));
}

async function memoryTool(args, ctx) {
  const { action, key, value } = args;
  const mem = loadMemory();
  const log = ctx.holder.log;
  switch (action) {
    case 'set':
      mem[key] = value;
      saveMemory(mem);
      log.tool({ tool: 'memory', action: 'set', key });
      return { ok: true, key, stored: true };
    case 'get':
      return { ok: true, key, value: mem[key] !== undefined ? mem[key] : null };
    case 'list':
      return { ok: true, keys: Object.keys(mem), count: Object.keys(mem).length };
    case 'delete':
      delete mem[key];
      saveMemory(mem);
      return { ok: true, key, deleted: true };
    case 'clear':
      saveMemory({});
      return { ok: true, cleared: true };
    default:
      return { ok: false, error: 'unknown action: ' + action };
  }
}

// ---------------------------------------------------------------------------
// Shell execution tool — run arbitrary shell commands
// ---------------------------------------------------------------------------

const { execSync } = require('child_process');

async function shellExecTool(args, ctx) {
  const { command, cwd, timeoutMs } = args;
  const log = ctx.holder.log;
  if (!command) return { ok: false, error: 'command is required' };
  const opts = {
    encoding: 'utf8',
    timeout: timeoutMs || 15000,
    maxBuffer: 1024 * 512,
  };
  if (cwd) opts.cwd = cwd;
  try {
    const stdout = execSync(command, opts);
    const result = { ok: true, stdout: stdout.slice(0, 4000) };
    log.tool({ tool: 'shell_exec', command, ok: true });
    return result;
  } catch (e) {
    const result = {
      ok: false,
      error: String((e && e.message) || e),
      stdout: (e.stdout || '').slice(0, 2000),
      stderr: (e.stderr || '').slice(0, 2000),
      status: e.status,
    };
    log.failure({ tool: 'shell_exec', error: result.error });
    return result;
  }
}

// ---------------------------------------------------------------------------
// File read/write tool — read and write files in the harness directory
// ---------------------------------------------------------------------------

const path = require('path');

async function fileReadTool(args, ctx) {
  const { filePath } = args;
  if (!filePath) return { ok: false, error: 'filePath is required' };
  const resolved = path.resolve(__dirname, filePath);
  try {
    const content = fs.readFileSync(resolved, 'utf8');
    return { ok: true, path: resolved, content: content.slice(0, 8000), bytes: content.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function fileWriteTool(args, ctx) {
  const { filePath, content, append } = args;
  if (!filePath) return { ok: false, error: 'filePath is required' };
  if (content === undefined) return { ok: false, error: 'content is required' };
  const resolved = path.resolve(__dirname, filePath);
  try {
    if (append) {
      fs.appendFileSync(resolved, content);
    } else {
      fs.writeFileSync(resolved, content);
    }
    return { ok: true, path: resolved, bytes: content.length, appended: !!append };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Self-test tool — assertions on core.js structure and tool registry
// ---------------------------------------------------------------------------

function runSelfTests() {
  const tests = [];
  function test(name, fn) {
    try {
      fn();
      tests.push({ name, pass: true });
    } catch (e) {
      tests.push({ name, pass: false, error: String(e.message || e) });
    }
  }
  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
  }

  // Test 1: core exports exist
  test('core_exports_exist', () => {
    const c = module.exports;
    assert(typeof c.init === 'function', 'init must be a function');
    assert(typeof c.step === 'function', 'step must be a function');
    assert(Array.isArray(c.toolDefinitions), 'toolDefinitions must be an array');
    assert(typeof c.toolHandlers === 'object', 'toolHandlers must be an object');
  });

  // Test 2: self-edit tool is registered
  test('self_edit_tool_registered', () => {
    const names = module.exports.toolDefinitions.map((t) => t.function.name);
    assert(names.includes('read_then_edit_core_then_reload_core_with_fallback_on_throw'), 'self-edit tool must be defined');
    assert(module.exports.toolHandlers['read_then_edit_core_then_reload_core_with_fallback_on_throw'], 'self-edit handler must exist');
  });

  // Test 3: memory tool works
  test('memory_tool_roundtrip', () => {
    const mem = loadMemory();
    const testKey = '__selftest__';
    mem[testKey] = 'hello';
    saveMemory(mem);
    const mem2 = loadMemory();
    assert(mem2[testKey] === 'hello', 'memory set/get must work');
    delete mem2[testKey];
    saveMemory(mem2);
  });

  // Test 4: tool definitions and handlers match
  test('tools_definitions_match_handlers', () => {
    const defNames = module.exports.toolDefinitions.map((t) => t.function.name);
    const handlerNames = Object.keys(module.exports.toolHandlers);
    for (const name of defNames) {
      assert(handlerNames.includes(name), `handler missing for tool: ${name}`);
    }
    for (const name of handlerNames) {
      assert(defNames.includes(name), `definition missing for handler: ${name}`);
    }
  });

  // Test 5: at least 8 tools registered (we expect growth over time)
  test('minimum_tool_count', () => {
    const count = module.exports.toolDefinitions.length;
    assert(count >= 8, `expected at least 8 tools, got ${count}`);
  });

  // Test 6: compaction function reduces message count
  test('compaction_reduces_messages', () => {
    const msgs = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 50; i++) {
      msgs.push({ role: 'user', content: `msg ${i}` });
      msgs.push({ role: 'assistant', content: `reply ${i}` });
    }
    const compacted = compactMessages(msgs);
    assert(compacted.length < msgs.length, 'compaction must reduce message count');
    assert(compacted[0].role === 'system', 'system prompt must be preserved');
    assert(compacted.length === 22, `expected 22 messages after compaction, got ${compacted.length}`); // 1 system + 1 summary + 20 recent
  });

  // Test 7: generateNextTurn returns a non-empty string
  test('generate_next_turn_returns_string', () => {
    const turn = generateNextTurn({ messages: [] });
    assert(typeof turn === 'string' && turn.length > 10, 'generateNextTurn must return a non-empty string');
  });

  // Test 8: code_eval sandbox blocks require access (synchronous vm test)
  test('code_eval_sandbox_blocks_require', () => {
    const sandbox = { require: undefined, console: { log: () => {} } };
    const result = vm.runInNewContext('typeof require', sandbox, { timeout: 1000 });
    assert(result === 'undefined', 'require should be undefined in sandbox');
  });

  const passed = tests.filter((t) => t.pass).length;
  const failed = tests.length - passed;
  return { ok: true, total: tests.length, passed, failed, tests };
}

async function selfTestTool(args, ctx) {
  const result = runSelfTests();
  ctx.holder.log.tool({ tool: 'self_test', passed: result.passed, failed: result.failed });
  return result;
}

// ---------------------------------------------------------------------------
// Web fetch tool — fetch a URL and return response text
// ---------------------------------------------------------------------------

async function webFetchTool(args, ctx) {
  const { url, maxBytes } = args;
  if (!url) return { ok: false, error: 'url is required' };
  const limit = maxBytes || 8000;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'autonomous-harness/1.0' } });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      content: text.slice(0, limit),
      bytes: text.length,
      truncated: text.length > limit,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Code eval tool — run a JavaScript snippet in a sandboxed VM
// ---------------------------------------------------------------------------

const vm = require('vm');

async function codeEvalTool(args, ctx) {
  const { code, timeoutMs } = args;
  if (!code) return { ok: false, error: 'code is required' };
  const timeout = timeoutMs || 5000;
  const sandbox = {
    console: { log: (...a) => logs.push(a.map(String).join(' ')), error: (...a) => logs.push('[ERROR] ' + a.map(String).join(' ')) },
    require: undefined, // no require — sandboxed
    Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Error,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
  };
  const logs = [];
  sandbox.logs = logs;
  try {
    const result = vm.runInNewContext(code, sandbox, { timeout, filename: 'code_eval.vm' });
    return {
      ok: true,
      result: result === undefined ? 'undefined' : (typeof result === 'object' ? JSON.stringify(result, null, 2).slice(0, 4000) : String(result).slice(0, 4000)),
      logs: logs.slice(0, 50),
      resultType: typeof result,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e), logs: logs.slice(0, 50) };
  }
}

const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'read_then_edit_core_then_reload_core_with_fallback_on_throw',
      description:
        'Reads the harness core file (core.js). If "find" is an empty string, returns the current source unchanged (READ mode). ' +
        'If "find" is a non-empty string, replaces the FIRST occurrence of "find" with "replace" in core.js, then hot-reloads ' +
        'the core. If the new core throws or is malformed, automatically restores the last known-good version. ' +
        'Use this to inspect and extend your own source code.',
      parameters: {
        type: 'object',
        properties: {
          find: {
            type: 'string',
            description:
              'Exact substring to locate in core.js. Empty string => read-only (return current source). ' +
              'Otherwise the first occurrence is replaced. Make this UNIQUE by including surrounding context.',
          },
          replace: {
            type: 'string',
            description: 'Replacement text for the first match of "find". Ignored in read-only mode.',
          },
        },
        required: ['find', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory',
      description:
        'Persistent key/value memory store backed by memory.json. Use to remember progress, goals, plans, and notes across steps. ' +
        'Actions: set (key+value), get (key), list, delete (key), clear.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set', 'get', 'list', 'delete', 'clear'], description: 'Memory operation to perform.' },
          key: { type: 'string', description: 'Memory key (for set/get/delete).' },
          value: { type: 'string', description: 'Value to store (for set).' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell_exec',
      description:
        'Execute a shell command synchronously and return stdout. Use for running tests, listing files, git, etc. ' +
        'Timeout defaults to 15s. Output is truncated to 4000 chars.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          cwd: { type: 'string', description: 'Working directory (optional).' },
          timeoutMs: { type: 'number', description: 'Timeout in ms (default 15000).' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_read',
      description: 'Read a file from the harness directory (resolved relative to core.js). Returns content truncated to 8000 chars.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the file (relative to core.js or absolute).' },
        },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_write',
      description: 'Write or append content to a file in the harness directory. Can create new files.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the file (relative to core.js or absolute).' },
          content: { type: 'string', description: 'Content to write.' },
          append: { type: 'boolean', description: 'If true, append instead of overwrite.' },
        },
        required: ['filePath', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'self_test',
      description: 'Run the built-in self-test suite. Verifies core structure, tool registry, memory, and handler/definition consistency. Returns pass/fail counts.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a URL via HTTP(S) and return the response body text. Useful for reading web pages, APIs, or documentation.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch.' },
          maxBytes: { type: 'number', description: 'Maximum bytes to return (default 8000).' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'code_eval',
      description: 'Run a JavaScript code snippet in a sandboxed VM context. Has access to console, Math, JSON, Date, etc. but NOT require or fs. ' +
        'Returns the result value and any console.log output. Timeout defaults to 5s.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code to evaluate.' },
          timeoutMs: { type: 'number', description: 'Timeout in ms (default 5000).' },
        },
        required: ['code'],
      },
    },
  },
];

const toolHandlers = {
  read_then_edit_core_then_reload_core_with_fallback_on_throw: readThenEditCoreThenReloadWithFallbackOnThrow,
  memory: memoryTool,
  shell_exec: shellExecTool,
  file_read: fileReadTool,
  file_write: fileWriteTool,
  self_test: selfTestTool,
  web_fetch: webFetchTool,
  code_eval: codeEvalTool,
};

// ---------------------------------------------------------------------------
// Compaction — keep message history bounded so we can run indefinitely.
// When messages exceed a threshold, we summarize the oldest turns into a
// single system note and drop the originals. The system prompt + recent
// window are always preserved.
// ---------------------------------------------------------------------------

const COMPACT_THRESHOLD = 40; // trigger compaction when messages exceed this
const COMPACT_KEEP_RECENT = 20; // keep this many most-recent messages verbatim

function compactMessages(messages) {
  if (messages.length <= COMPACT_THRESHOLD) return messages;

  // Always keep the system prompt (index 0) and the most recent messages.
  const systemMsg = messages[0];
  const toCompact = messages.slice(1, messages.length - COMPACT_KEEP_RECENT);
  const recent = messages.slice(messages.length - COMPACT_KEEP_RECENT);

  // Build a terse summary of the compacted region.
  const parts = [];
  parts.push('[COMPACTION SUMMARY — older turns condensed to save context. Key events:]');
  let toolCount = 0;
  let edits = 0;
  let topics = [];
  for (const m of toCompact) {
    if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          toolCount++;
          if (tc.function.name === 'read_then_edit_core_then_reload_core_with_fallback_on_throw') edits++;
          topics.push(`called ${tc.function.name}`);
        }
      }
      if (m.content) topics.push(`said: ${String(m.content).slice(0, 80)}`);
    } else if (m.role === 'user' && m.content) {
      topics.push(`user: ${String(m.content).slice(0, 80)}`);
    }
  }
  // Keep only the last 15 topic snippets to avoid the summary itself being huge.
  topics = topics.slice(-15);
  parts.push(`Tools called: ${toolCount}, core edits: ${edits}.`);
  parts.push('Recent activity: ' + topics.join(' | '));
  parts.push('[END COMPACTION SUMMARY]');

  const summaryMsg = { role: 'system', content: parts.join('\n') };
  return [systemMsg, summaryMsg, ...recent];
}

// ---------------------------------------------------------------------------
// Self-generated user turns — instead of a generic "Continue.", generate a
// goal-aware nudge from memory so the agent drives itself.
// ---------------------------------------------------------------------------

const GOAL_QUEUE = [
  'Write a README.md documenting the harness architecture and tools.',
  'Add a git status check and commit recent changes.',
  'Improve the self-test suite with more edge cases — test file_read/file_write roundtrip.',
  'Refactor step() for clarity and add better error recovery.',
  'Add a planner that cycles through goals and tracks progress in memory.',
  'Add a tool to list files in the harness directory (like ls).',
  'Add a tool to search/grep within files in the harness directory.',
  'Add HTTP status monitoring — periodically fetch a health-check URL.',
  'Add a diff tool to compare two versions of core.js before and after an edit.',
  'Add a JSON schema validator for tool arguments before dispatching to handlers.',
];

function generateNextTurn(state) {
  const mem = loadMemory();
  let goals = mem.goals;
  if (!goals || !goals.length) {
    goals = GOAL_QUEUE.slice();
    saveMemory(Object.assign(mem, { goals }));
  }
  const goalIdx = (mem.goalIndex || 0) % goals.length;
  const goal = goals[goalIdx];
  // Advance the goal index for next time.
  saveMemory(Object.assign(loadMemory(), { goalIndex: goalIdx + 1 }));
  return `Next goal (#${goalIdx + 1}/${goals.length}): ${goal} Pick one concrete action and execute it with a tool call.`;
}

// ---------------------------------------------------------------------------
// Loop: init + step (one LLM turn per step)
// ---------------------------------------------------------------------------

async function init(holder, CORE_PATH) {
  if (!config.apiKey && /api\.openai\.com/.test(config.baseURL)) {
    throw new Error('OPENAI_API_KEY is not set (required for api.openai.com — see .env.example).');
  }
  if (!config.apiKey) {
    holder.log.event({ event: 'no_api_key', note: 'running without Authorization (local server assumed)' });
  }
  const firstUser =
    'Begin. First read core.js to see what you are. Then start extending it: add a tool, add a test, keep going.';
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: firstUser },
  ];
  holder.log.conversation({ role: 'system', preview: SYSTEM_PROMPT.slice(0, 200) });
  holder.log.conversation({ role: 'user', preview: firstUser });
  return { messages, step: 0 };
}

async function step(state, holder, CORE_PATH) {
  const core = holder.core; // always the latest reload
  const tools = core.toolDefinitions;
  const handlers = core.toolHandlers;
  const log = holder.log;

  // --- Compaction: keep message history bounded ---
  if (state.messages.length > COMPACT_THRESHOLD) {
    const before = state.messages.length;
    state.messages = compactMessages(state.messages);
    log.event({ event: 'compaction', before, after: state.messages.length });
  }

  const msg = await callLLM(state.messages, tools, holder);
  state.messages.push(msg);
  log.conversation({
    role: 'assistant',
    preview: (msg.content || '').slice(0, 300),
    toolCalls: (msg.tool_calls || []).map((t) => t.function.name),
  });

  if (msg.tool_calls && msg.tool_calls.length) {
    for (const call of msg.tool_calls) {
      const name = call.function.name;
      const handler = handlers[name];
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch (e) {
        args = { _parseError: String(e) };
      }

      let result;
      if (!handler) {
        result = { ok: false, error: `unknown tool: ${name}` };
        log.failure(result);
      } else {
        try {
          result = await handler(args, { holder, CORE_PATH });
        } catch (e) {
          result = { ok: false, error: String((e && e.message) || e) };
          log.failure({ tool: name, error: result.error });
        }
      }

      const payload = JSON.stringify(result);
      state.messages.push({ role: 'tool', tool_call_id: call.id, name, content: payload });
      log.tool({ tool: name, argsPreview: JSON.stringify(args), resultPreview: payload.slice(0, 300) });
    }
    state.step++;
    return state;
  }

  // No tool calls — avoid halting. Inject a goal-driven self-generated turn.
  const nudge = generateNextTurn(state);
  state.messages.push({ role: 'user', content: nudge });
  log.conversation({ role: 'user', preview: nudge, injected: true, selfGenerated: true });

  state.step++;
  return state;
}

module.exports = { init, step, toolDefinitions, toolHandlers };
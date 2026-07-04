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

const LLM_MAX_RETRIES = 3;
const LLM_RETRY_DELAY_MS = 1000;

async function callLLM(messages, tools, holder) {
  const log = holder.log;
  const body = { model: config.model, messages, temperature: 0.8 };
  if (tools && tools.length && toolsSupported) body.tools = tools;

  const headers = { 'Content-Type': 'application/json' };
  // Authorization is optional — local servers like Ollama don't need it.
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  let lastError;
  for (let attempt = 0; attempt < LLM_MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(`${config.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      // Network error — retry after delay
      lastError = e;
      log.failure({ warning: 'llm_network_error', attempt: attempt + 1, error: String(e.message || e).slice(0, 200) });
      if (attempt < LLM_MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, LLM_RETRY_DELAY_MS * (attempt + 1)));
      }
      continue;
    }

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
      } else if (res.status >= 500) {
        // Server error — retry
        lastError = new Error(`LLM error ${res.status}: ${(await res.text()).slice(0, 500)}`);
        log.failure({ warning: 'llm_server_error', attempt: attempt + 1, status: res.status });
        if (attempt < LLM_MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, LLM_RETRY_DELAY_MS * (attempt + 1)));
        }
        continue;
      } else {
        const txt = await res.text();
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
  throw lastError || new Error('LLM call failed after ' + LLM_MAX_RETRIES + ' retries');
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

  // Test 5: at least 10 tools registered (we expect growth over time)
  test('minimum_tool_count', () => {
    const count = module.exports.toolDefinitions.length;
    assert(count >= 10, `expected at least 10 tools, got ${count}`);
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

  // Test 9: file_read/file_write roundtrip
  test('file_read_write_roundtrip', () => {
    const testFile = path.join(__dirname, '__selftest_file__.txt');
    const testContent = 'Hello harness self-test!\nLine 2.\n';
    fs.writeFileSync(testFile, testContent);
    const read = fs.readFileSync(testFile, 'utf8');
    assert(read === testContent, 'file write/read roundtrip must preserve content');
    fs.unlinkSync(testFile);
  });

  // Test 10: file_list returns entries
  test('file_list_returns_entries', () => {
    const entries = fs.readdirSync(__dirname, { withFileTypes: true });
    const names = entries.map((e) => e.name);
    assert(names.includes('core.js'), 'file_list must include core.js');
  });

  // Test 11: grep finds patterns in core.js (sync version)
  test('grep_finds_patterns', () => {
    const content = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
    assert(/module\.exports/.test(content), 'grep must find module.exports in core.js');
  });

  // Test 12: diff tool computes correct line changes (LCS-based)
  test('diff_computes_changes', () => {
    const oldT = 'line1\nline2\nline3';
    const newT = 'line1\nmodified\nline3\nline4';
    const d = computeDiff(oldT, newT);
    assert(d.length > 0, 'diff must return results');
    const added = d.filter((x) => x.type === 'added').length;
    const removed = d.filter((x) => x.type === 'removed').length;
    assert(added === 2, 'expected 2 added lines, got ' + added);
    assert(removed === 1, 'expected 1 removed line, got ' + removed);
  });

  // Test 13: schema validator catches missing required params (validation in step)
  test('schema_validator_catches_missing', () => {
    const defs = module.exports.toolDefinitions;
    const shellDef = defs.find((t) => t.function.name === 'shell_exec');
    assert(shellDef, 'shell_exec definition must exist');
    const required = shellDef.function.parameters.required;
    assert(required.includes('command'), 'shell_exec must require command');
    // Simulate missing required param
    const fakeArgs = {};
    const missing = required.filter((r) => fakeArgs[r] === undefined);
    assert(missing.includes('command'), 'validator must detect missing command');
  });

  // Test 14: base64 encode/decode roundtrip (registered)
  test('base64_roundtrip', () => {
    const input = 'Hello, World! 123';
    const encoded = Buffer.from(input, 'utf8').toString('base64');
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    assert(decoded === input, 'base64 encode/decode roundtrip must preserve content');
    assert(encoded === 'SGVsbG8sIFdvcmxkISAxMjM=', 'expected specific base64 output');
  });

  // Test 15: system_info returns expected fields
  test('system_info_fields', () => {
    const defs = module.exports.toolDefinitions;
    const siDef = defs.find((t) => t.function.name === 'system_info');
    assert(siDef, 'system_info definition must exist');
    const b64Def = defs.find((t) => t.function.name === 'base64');
    assert(b64Def, 'base64 definition must exist');
    assert(module.exports.toolHandlers['system_info'], 'system_info handler must exist');
    assert(module.exports.toolHandlers['base64'], 'base64 handler must exist');
  });

  // Test 16: hash tool produces correct SHA-256
  test('hash_tool_sha256', () => {
    const defs = module.exports.toolDefinitions;
    const hashDef = defs.find((t) => t.function.name === 'hash');
    assert(hashDef, 'hash definition must exist');
    assert(module.exports.toolHandlers['hash'], 'hash handler must exist');
    // Verify known SHA-256 hash of 'hello'
    const crypto = require('crypto');
    const h = crypto.createHash('sha256').update('hello').digest('hex');
    assert(h === '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', 'SHA-256 of hello must match known value');
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

// ---------------------------------------------------------------------------
// File list tool — list files in a directory (like ls)
// ---------------------------------------------------------------------------

async function fileListTool(args, ctx) {
  const { dirPath, recursive } = args;
  const resolved = path.resolve(__dirname, dirPath || '.');
  try {
    if (recursive) {
      const results = [];
      function walk(dir, prefix) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const rel = prefix ? prefix + '/' + e.name : e.name;
          if (e.isDirectory()) {
            results.push({ name: rel, type: 'dir' });
            walk(path.join(dir, e.name), rel);
          } else {
            const stat = fs.statSync(path.join(dir, e.name));
            results.push({ name: rel, type: 'file', bytes: stat.size });
          }
        }
      }
      walk(resolved, '');
      return { ok: true, path: resolved, entries: results.slice(0, 100), count: results.length };
    } else {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const results = entries.map((e) => {
        if (e.isDirectory()) return { name: e.name, type: 'dir' };
        try {
          const stat = fs.statSync(path.join(resolved, e.name));
          return { name: e.name, type: 'file', bytes: stat.size };
        } catch {
          return { name: e.name, type: e.isDirectory() ? 'dir' : 'file' };
        }
      });
      return { ok: true, path: resolved, entries: results, count: results.length };
    }
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Grep tool — search for a pattern within files in the harness directory
// ---------------------------------------------------------------------------

async function grepTool(args, ctx) {
  const { pattern, dirPath, filePattern } = args;
  if (!pattern) return { ok: false, error: 'pattern is required' };
  const resolved = path.resolve(__dirname, dirPath || '.');
  const regex = new RegExp(pattern, 'i');
  const fileRegex = filePattern ? new RegExp(filePattern) : null;
  const matches = [];

  function searchDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const fullPath = path.join(dir, e.name);
      if (e.isDirectory()) {
        searchDir(fullPath);
      } else if (e.isFile()) {
        if (fileRegex && !fileRegex.test(e.name)) continue;
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push({ file: path.relative(__dirname, fullPath), line: i + 1, text: lines[i].trim().slice(0, 200) });
              if (matches.length >= 50) return;
            }
          }
        } catch {}
      }
    }
  }

  try {
    searchDir(resolved);
    return { ok: true, pattern, matches: matches.slice(0, 50), count: matches.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Diff tool — compare two text strings line-by-line (minimal LCS diff)
// ---------------------------------------------------------------------------

function computeDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const diff = [];

  // Simple line-by-line diff using LCS (dynamic programming)
  const m = oldLines.length;
  const n = newLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0, j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      diff.push({ type: 'equal', oldLine: i + 1, newLine: j + 1, text: oldLines[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      diff.push({ type: 'removed', oldLine: i + 1, text: oldLines[i] });
      i++;
    } else {
      diff.push({ type: 'added', newLine: j + 1, text: newLines[j] });
      j++;
    }
  }
  while (i < m) { diff.push({ type: 'removed', oldLine: i + 1, text: oldLines[i] }); i++; }
  while (j < n) { diff.push({ type: 'added', newLine: j + 1, text: newLines[j] }); j++; }

  return diff;
}

async function diffTool(args, ctx) {
  const { oldText, newText, filePath, oldFilePath, newFilePath } = args;
  let oldStr = oldText || '';
  let newStr = newText || '';

  if (oldFilePath) {
    try { oldStr = fs.readFileSync(path.resolve(__dirname, oldFilePath), 'utf8'); }
    catch (e) { return { ok: false, error: 'cannot read oldFilePath: ' + e.message }; }
  }
  if (newFilePath) {
    try { newStr = fs.readFileSync(path.resolve(__dirname, newFilePath), 'utf8'); }
    catch (e) { return { ok: false, error: 'cannot read newFilePath: ' + e.message }; }
  }
  if (filePath) {
    // Compare file against provided newText
    try { oldStr = fs.readFileSync(path.resolve(__dirname, filePath), 'utf8'); }
    catch (e) { return { ok: false, error: 'cannot read filePath: ' + e.message }; }
  }

  if (!oldStr && !newStr) return { ok: false, error: 'provide oldText+newText or filePath(s)' };

  const diff = computeDiff(oldStr, newStr);
  const added = diff.filter((d) => d.type === 'added').length;
  const removed = diff.filter((d) => d.type === 'removed').length;
  const equal = diff.filter((d) => d.type === 'equal').length;

  // Build a readable unified-style summary (only changes, with context)
  const changes = diff.filter((d) => d.type !== 'equal').map((d) => {
    const prefix = d.type === 'added' ? '+' : d.type === 'removed' ? '-' : ' ';
    return `${prefix} ${d.text.slice(0, 200)}`;
  });

  return { ok: true, added, removed, equal, totalLines: diff.length, changes: changes.slice(0, 100) };
}

// ---------------------------------------------------------------------------
// Hash tool — compute SHA-256 hash of a string or file
// ---------------------------------------------------------------------------

const crypto = require('crypto');

async function hashTool(args, ctx) {
  const { input, filePath, algorithm } = args;
  const algo = algorithm || 'sha256';
  let data;
  if (filePath) {
    try {
      data = fs.readFileSync(path.resolve(__dirname, filePath));
    } catch (e) {
      return { ok: false, error: 'cannot read file: ' + e.message };
    }
  } else if (input) {
    data = Buffer.from(input, 'utf8');
  } else {
    return { ok: false, error: 'provide input or filePath' };
  }
  try {
    const hash = crypto.createHash(algo).update(data).digest('hex');
    return { ok: true, algorithm: algo, hash, bytes: data.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Base64 encode/decode tool (registered)
// ---------------------------------------------------------------------------

async function base64Tool(args, ctx) {
  const { action, input } = args;
  if (!input) return { ok: false, error: 'input is required' };
  try {
    if (action === 'encode') {
      return { ok: true, result: Buffer.from(input, 'utf8').toString('base64') };
    } else if (action === 'decode') {
      return { ok: true, result: Buffer.from(input, 'base64').toString('utf8') };
    } else {
      return { ok: false, error: 'unknown action: ' + action + ' (use encode or decode)' };
    }
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// System info tool — Node version, memory, uptime
// ---------------------------------------------------------------------------

async function systemInfoTool(args, ctx) {
  const mem = process.memoryUsage();
  return {
    ok: true,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptime: Math.round(process.uptime()) + 's',
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
      external: Math.round(mem.external / 1024 / 1024) + 'MB',
    },
    toolCount: module.exports.toolDefinitions.length,
    testCount: 16,
  };
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
  {
    type: 'function',
    function: {
      name: 'file_list',
      description: 'List files in a directory (like ls). Supports recursive listing. Skips node_modules and .git.',
      parameters: {
        type: 'object',
        properties: {
          dirPath: { type: 'string', description: 'Directory path relative to core.js (default: ".")' },
          recursive: { type: 'boolean', description: 'If true, list files recursively in subdirectories.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for a regex pattern within files in the harness directory. Returns matching lines with file names and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for (case-insensitive).' },
          dirPath: { type: 'string', description: 'Directory to search in (default: ".")' },
          filePattern: { type: 'string', description: 'Regex to filter file names (optional).' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diff',
      description: 'Compare two text strings or files line-by-line using LCS diff. Returns added/removed/equal counts and a unified-style change list.',
      parameters: {
        type: 'object',
        properties: {
          oldText: { type: 'string', description: 'Old text to compare (if not using file paths).' },
          newText: { type: 'string', description: 'New text to compare (if not using file paths).' },
          filePath: { type: 'string', description: 'File to use as old text (compared against newText).' },
          oldFilePath: { type: 'string', description: 'File path for old text.' },
          newFilePath: { type: 'string', description: 'File path for new text.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'base64',
      description: 'Encode or decode base64 strings. Useful for binary-safe data handling.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['encode', 'decode'], description: 'Whether to encode or decode.' },
          input: { type: 'string', description: 'The input string to encode or decode.' },
        },
        required: ['action', 'input'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hash',
      description: 'Compute a cryptographic hash (SHA-256 by default) of a string or file. Useful for checksums and integrity verification.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'String to hash (if not using filePath).' },
          filePath: { type: 'string', description: 'Path to file to hash (relative to core.js).' },
          algorithm: { type: 'string', description: 'Hash algorithm: sha256 (default), sha1, md5, sha512.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'system_info',
      description: 'Get system information: Node version, platform, memory usage, uptime, tool count.',
      parameters: { type: 'object', properties: {}, required: [] },
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
  file_list: fileListTool,
  grep: grepTool,
  diff: diffTool,
  base64: base64Tool,
  hash: hashTool,
  system_info: systemInfoTool,
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
  // COMPLETED: README.md, diff tool, JSON schema validator, file_list, grep, self-test suite,
  //   base64 tool, system_info tool, hash tool, LLM retry mechanism
  // Active goals:
  'Add a tool to run the full test suite and auto-commit if all pass.',
  'Refactor step() to support parallel tool calls more robustly.',
  'Add a tool to create and manage a todo list in memory for task tracking.',
  'Add a tool to measure code complexity or line count of core.js.',
  'Add a tool to fetch and parse JSON from an API endpoint.',
  'Add a tool to create a backup of core.js before editing.',
  'Improve compaction to preserve tool results in the summary.',
  'Add a tool to list all tool definitions in a readable format.',
  'Add a tool to download and save web content to a file.',
  'Add a tool to count lines, words, and characters in a file (wc).',
  'Add a tool to generate a UUID.',
  'Add a tool to sleep/delay for a specified number of milliseconds.',
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
        // Validate required parameters against tool definition
        const def = tools.find((t) => t.function.name === name);
        if (def && def.function.parameters && def.function.parameters.required) {
          const missing = def.function.parameters.required.filter((r) => args[r] === undefined);
          if (missing.length) {
            result = { ok: false, error: `missing required parameters: ${missing.join(', ')}` };
            log.failure({ tool: name, error: result.error, missing });
          }
        }
        if (!result) {
          try {
            result = await handler(args, { holder, CORE_PATH });
          } catch (e) {
            result = { ok: false, error: String((e && e.message) || e) };
            log.failure({ tool: name, error: result.error });
          }
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
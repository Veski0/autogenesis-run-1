// log.js — stable logging the agent cannot (and should not) edit away.
// Writes JSONL streams into logs/ and mirrors a colourised trail to stdout.

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.resolve(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const ts = () => new Date().toISOString();

function write(file, obj) {
  fs.appendFileSync(path.join(LOG_DIR, file), JSON.stringify({ ...obj, t: ts() }) + '\n');
}

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', gray: '\x1b[90m',
  cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', magenta: '\x1b[35m',
};

function oneLine(s, n = 160) {
  return String(s == null ? '' : s).replace(/\n/g, ' ').slice(0, n);
}

module.exports = {
  conversation(o) {
    write('conversation.jsonl', o);
    const tag = o.role.toUpperCase();
    const color = o.role === 'assistant' ? C.cyan : o.role === 'user' ? C.green : C.magenta;
    const note = o.injected ? ' (injected)' : '';
    console.log(`${C.gray}${ts()}${C.reset} ${color}${tag}${note}${C.reset} ${oneLine(o.preview)}`);
    if (o.toolCalls && o.toolCalls.length) {
      console.log(`  ${C.yellow}tools: ${o.toolCalls.join(', ')}${C.reset}`);
    }
  },
  tool(o) {
    write('tools.jsonl', o);
    console.log(`${C.gray}${ts()}${C.reset} ${C.yellow}TOOL${C.reset} ${o.tool} ${C.gray}(args ${oneLine(o.argsPreview, 80)})${C.reset}`);
  },
  edit(o) {
    write('edits.jsonl', o);
    console.log(`${C.gray}${ts()}${C.reset} ${C.magenta}EDIT${C.reset} ${o.bytesBefore}->${o.bytesAfter}b  ${C.gray}${oneLine(o.findSnippet, 60)}${C.reset}`);
  },
  failure(o) {
    write('failures.jsonl', o);
    console.log(`${C.gray}${ts()}${C.reset} ${C.red}FAIL${C.reset} ${oneLine(o.error || JSON.stringify(o), 140)}`);
  },
  event(o) {
    write('events.jsonl', o);
    const rest = JSON.stringify({ ...o, event: undefined });
    console.log(`${C.gray}${ts()}${C.reset} ${C.dim}EVENT${C.reset} ${o.event} ${oneLine(rest, 80)}`);
  },
};
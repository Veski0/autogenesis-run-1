#!/usr/bin/env node
// bootstrap.js — the immortal loader. Never edited by the agent.
// Owns: .env loading, logging, the cached "last known-good" core source,
// and the loop that calls core.init() once then core.step() forever.

const fs = require('fs');
const path = require('path');

// --- minimal .env loader (no dependencies) ---
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const CORE_PATH = path.resolve(__dirname, 'core.js');
const log = require('./log.js');

// The holder is passed into every core step. It is the stable bridge across
// reloads: the agent swaps holder.core, but holder itself (and its log +
// cached source) persists for the lifetime of the process.
const holder = {
  core: require(CORE_PATH),
  log,
  cachedCoreSource: fs.readFileSync(CORE_PATH, 'utf8'),
};

const MAX_STEPS = process.env.MAX_STEPS ? parseInt(process.env.MAX_STEPS, 10) : Infinity;

(async () => {
  log.event({ event: 'bootstrap', model: process.env.MODEL, maxSteps: MAX_STEPS });
  let state = await holder.core.init(holder, CORE_PATH);
  while (state.step < MAX_STEPS) {
    state = await holder.core.step(state, holder, CORE_PATH);
  }
  log.event({ event: 'max_steps_reached', step: state.step });
})().catch((e) => {
  log.failure({ fatal: true, error: String((e && e.stack) || e) });
  process.exit(1);
});
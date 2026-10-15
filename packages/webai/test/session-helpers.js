import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '../src/session.js';

const made = [];
process.setMaxListeners(100); // one exit listener per session


/** Script prelude: `out(...events)` prints one JSON line the fake adapter's parse() returns as events. */
const PRELUDE = 'const out=(...e)=>console.log(JSON.stringify({events:e}));';

export function adapter(script, extra = {}) {
  return {
    name: 'fake',
    label: 'Fake',
    bin: null,
    presetSessionId: false,
    command: () => ({ cmd: process.execPath, args: ['-e', PRELUDE + script] }),
    parse: (msg) => msg.events ?? [],
    ...extra,
  };
}

export function make(agents, { logger, files } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-session-'));
  for (const [f, s] of Object.entries(files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), s);
  }
  const session = new AgentSession({ root, agents, stateDir: '.webai', logger });
  made.push({ root, session });
  return { s: session, root };
}

export function cleanup() {
  for (const { root, session } of made.splice(0)) {
    session.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Resolves with the next event of `type` (or the first one matching `pred`). */
export function next(s, type, ms = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (unsub(), reject(new Error(`timeout waiting for ${type}`))), ms);
    const unsub = s.subscribe((ev) => {
      if (ev.type !== type) return;
      clearTimeout(timer);
      unsub();
      resolve(ev);
    });
  });
}

/** The run is over (the process closed), not only its done event seen. */
export async function settled(s) {
  while (s.busy) await new Promise((r) => setTimeout(r, 5));
}

export function collect(s) {
  const evs = [];
  s.subscribe((ev) => evs.push(ev));
  return evs;
}

export const msg = (message = 'hi') => ({ message });

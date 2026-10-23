import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { History } from './history.js';
import { buildPrompt } from './prompt.js';

const MAX_EVENTS = 1000;

const SYSTEM_PROMPT = `You are connected to a browser overlay of a website running in development.
The user points at an element on the rendered page and asks for a change.
Each message carries the element's CSS selector, its text and an HTML excerpt,
and, when the framework provides it, its source location (file:line:col from
the data-webai-src attribute). Without a source location, find the element in
the sources by its text, classes and structure first.
Make the change directly in the source files, keep the edit minimal and in
the style of the surrounding code. The page reloads by itself, never start
a dev server or a build. Don't write code that imports a package which isn't
installed: install it first, or use something else. If a tool you need is denied
or missing, say so and never claim something ran that didn't.
When done, answer briefly (one or two sentences) in the user's language,
saying what you changed and where.`;

/**
 * Conversations with agents. Each agent (Claude, Codex, …) has its own session;
 * switching between them doesn't discard context: going back to an agent resumes
 * its last conversation. The event history is shared so the chat in the panel
 * stays continuous, and it is mirrored to `.webai/`, so it survives a page reload
 * and a dev server restart.
 */
export { buildPrompt };

export class AgentSession {
  constructor({ root, agents, stateDir, logger }) {
    this.root = root;
    this.agents = agents; // { name: adapter }
    this.logger = logger;
    this.dir = path.resolve(root, stateDir);
    this.events = [];
    this.seq = 0;
    this.listeners = new Set();
    this.proc = null;
    this.pending = new Map(); // permission requests waiting for an answer: id -> { input }
    this.available = {}; // name -> version, or null when the CLI is missing
    this.state = { sessions: {} };
    this.settings = { agent: Object.keys(agents)[0] };
    this.prepared = new Set(); // agents whose prepare() has already run
    this.onExit = () => this.dispose();
    process.on('exit', this.onExit);
    this.load();
    this.history = new History(root, this.dir);
  }

  /** A version of the files; tells the panels when there is a new one. */
  version(label, { reload = false } = {}) {
    try {
      const list = this.history.snapshot(label);
      if (list) this.emit({ type: 'history', current: list.current, count: list.versions.length, reload });
    } catch (err) {
      this.logger?.warn?.(`webai: version history: ${err.message}`);
    }
  }

  /** Back or forward to a version of the files (not while the agent works). */
  restoreVersion(index) {
    if (this.busy) throw Object.assign(new Error('The agent is still working.'), { status: 409 });
    const list = this.history.restore(Number(index));
    const v = list.versions[list.current];
    this.emit({ type: 'status', text: `Version ${list.current + 1} of ${list.versions.length}: ${v.label}` });
    this.emit({ type: 'history', current: list.current, count: list.versions.length, reload: true });
    return list;
  }

  get busy() {
    return this.proc != null;
  }

  get agent() {
    return this.agents[this.settings.agent];
  }

  /** The current agent's session. */
  get current() {
    const name = this.settings.agent;
    this.state.sessions[name] ??= this.freshSession();
    return this.state.sessions[name];
  }

  freshSession() {
    return { sessionId: this.agent.presetSessionId ? randomUUID() : null, started: false, totalCostUsd: 0 };
  }

  load() {
    const read = (file) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8'));
      } catch {
        return null;
      }
    };
    const settings = read('settings.json');
    if (settings) this.settings = this.sanitize(settings);
    const saved = read('session.json');
    if (saved?.sessions) this.state = saved;

    const file = path.join(this.dir, 'transcript.jsonl');
    let lines;
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      return;
    }
    for (const line of lines.slice(-MAX_EVENTS)) {
      try {
        const ev = JSON.parse(line);
        this.events.push(ev);
        this.seq = Math.max(this.seq, ev.seq);
      } catch {} // truncated line after a crash: skip it, the rest of the history is valid
    }
    // A question left over from a previous run can't be answered any more.
    const answered = new Set(this.events.filter((e) => e.type === 'permission-answer').map((e) => e.id));
    for (const e of this.events.filter((e) => e.type === 'permission' && !answered.has(e.id))) {
      this.events.push({ type: 'permission-answer', id: e.id, allow: false, cancelled: true, seq: ++this.seq, ts: Date.now() });
    }
    // The file only grows; on startup trim it to what gets loaded anyway.
    if (lines.length > MAX_EVENTS) fs.writeFileSync(file, this.events.map((ev) => JSON.stringify(ev) + '\n').join(''));
  }

  /** Detects which CLIs are installed. An unavailable agent cannot be selected. */
  async detect() {
    await Promise.all(
      Object.entries(this.agents).map(async ([name, agent]) => {
        this.available[name] = agent.bin ? await probe(agent.bin, agent.versionArgs ?? ['--version'], this.root) : 'custom command';
      }),
    );
    if (!this.available[this.settings.agent]) {
      const first = Object.keys(this.agents).find((n) => this.available[n]);
      if (first) this.settings.agent = first;
    }
    return this.available;
  }

  write(file, data) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, file), JSON.stringify(data, null, 2));
  }

  saveState() {
    this.write('session.json', this.state);
  }

  /** Text deltas only stream to clients; the history gets the finished block. */
  emit(ev) {
    ev = { ...ev, seq: ++this.seq, ts: Date.now() };
    if (ev.type !== 'delta') {
      this.events.push(ev);
      if (this.events.length > MAX_EVENTS) this.events.shift();
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(path.join(this.dir, 'transcript.jsonl'), JSON.stringify(ev) + '\n');
    }
    for (const fn of this.listeners) fn(ev);
    // After the agent's answer, what it changed is a version named after your message.
    if (ev.type === 'done' && this.pendingVersion) {
      const label = this.pendingVersion;
      this.pendingVersion = null;
      this.version(label, { reload: true });
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Accepts only registered agents and values the given adapter offers. */
  sanitize(input) {
    const out = { agent: this.agents[input?.agent] ? input.agent : this.settings?.agent ?? Object.keys(this.agents)[0] };
    for (const [name, agent] of Object.entries(this.agents)) {
      const picked = {};
      for (const [key, spec] of Object.entries(agent.settings ?? {})) {
        const value = input?.[name]?.[key];
        if (!value || typeof value !== 'string' || spec.readonly) continue;
        if (spec.type === 'text') picked[key] = value.trim().slice(0, 1000);
        else if (spec.some((c) => c.value === value && !c.disabled)) picked[key] = value;
      }
      out[name] = picked;
    }
    return out;
  }

  setSettings(input) {
    if (this.busy && input.agent && input.agent !== this.settings.agent) {
      throw Object.assign(new Error('Cannot switch agents while one is working.'), { status: 409 });
    }
    if (input.agent && this.available[input.agent] === null) {
      throw Object.assign(new Error(`${this.agents[input.agent].label} is not installed.`), { status: 400 });
    }
    const before = this.settings.agent;
    const merged = { ...this.settings, agent: input.agent ?? before };
    for (const name of Object.keys(this.agents)) {
      if (input[name]) merged[name] = { ...this.settings[name], ...input[name] };
    }
    const previous = JSON.stringify(this.settings);
    this.settings = this.sanitize(merged);
    this.write('settings.json', this.settings);
    if (JSON.stringify(this.settings) !== previous) {
      // Settings changes from the browser (mainly the custom command) should show in the terminal too.
      this.logger?.info(`Overlay settings: ${JSON.stringify(this.settings)}`);
    }
    if (this.settings.agent !== before) {
      const resumed = this.current.started;
      this.emit({
        type: 'status',
        text: `Switched to ${this.agent.label}. ${resumed ? 'Resuming its previous conversation.' : "Starting its own conversation, it doesn't know the other agents' context."}`,
      });
    }
    return this.settings;
  }

  snapshot() {
    const agents = Object.entries(this.agents).map(([name, a]) => ({
      name,
      label: a.label ?? name,
      version: this.available[name],
      settings: a.settings ?? {},
    }));
    return {
      agent: this.agent.label ?? this.settings.agent,
      agents,
      settings: this.settings,
      session: { id: this.current.sessionId, started: this.current.started, totalCostUsd: this.current.totalCostUsd ?? 0 },
      busy: this.busy,
    };
  }

  send({ message, element, page }) {
    if (this.busy) throw new Error('The agent is still working on the previous message.');
    if (this.available[this.settings.agent] === null) throw new Error(`${this.agent.label} is not installed.`);
    const settings = this.settings[this.settings.agent];
    // The files before the agent touches them: the first version, or your edits since the last.
    this.version(this.history.state.versions.length ? 'Your edits' : 'Start');
    this.pendingVersion = message;
    this.emit({ type: 'user', text: message, element, page, agent: this.settings.agent, settings });
    this.run(buildPrompt({ message, element, page }), false);
  }

  run(prompt, retried) {
    const agent = this.agent;
    const session = this.current;
    const resume = session.started && session.sessionId != null;
    this.prepare(agent);
    const text = agent.wrapPrompt?.(prompt, { systemPrompt: SYSTEM_PROMPT, resume }) ?? prompt;
    let spec;
    try {
      spec = agent.command({
        sessionId: session.sessionId,
        resume,
        systemPrompt: SYSTEM_PROMPT,
        settings: this.settings[this.settings.agent] ?? {},
        prompt: text,
        root: this.root,
      });
    } catch (err) {
      this.emit({ type: 'done', ok: false, error: err.message });
      return;
    }
    const { cmd, args, stdin, promptInArgs, env, cleanup, interactive, input } = spec;
    this.emit({ type: 'status', text: `${agent.label} is working…`, busy: true });
    const ctx = { root: this.root };

    const proc = spawn(cmd, stdin || promptInArgs ? args : [...args, text], {
      cwd: this.root,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group: stop() also kills children (sh -c, pipelines).
      detached: process.platform !== 'win32',
    });
    proc.cleanup = cleanup; // cleanup outside the process (container), see killGroup
    this.proc = proc;
    let stderr = '';
    let buffer = '';
    let finished = false;
    // After "New" or stop() the old process's output no longer belongs to the conversation.
    const current = () => this.proc === proc;
    // An adapter or disk write error must not crash the dev server.
    const guard = (fn) => (...a) => {
      try {
        fn(...a);
      } catch (err) {
        if (!current()) return;
        this.proc = null;
        killGroup(proc, 'SIGTERM');
        this.emit({ type: 'done', ok: false, error: `Error processing output: ${err.message}` });
      }
    };

    const handleLine = (line) => {
      if (!current() || (!line && !agent.raw)) return;
      let msg = line;
      if (!agent.raw) {
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
      }
      for (let ev of agent.parse(msg, ctx)) {
        if (ev.type === 'session') {
          // The agent confirmed (or assigned) the conversation ID, resume it next time.
          session.sessionId = ev.id ?? session.sessionId;
          session.started = true;
          this.saveState();
          continue;
        }
        if (ev.type === 'permission') {
          // The tool's input (a whole file for Write) stays here: the answer must echo it back.
          this.pending.set(ev.id, { input: ev.input });
          ev = { ...ev, input: undefined };
        }
        if (ev.type === 'permission-answer') {
          if (!this.pending.delete(ev.id)) continue;
        }
        if (ev.type === 'done') {
          finished = true;
          ev = this.priceTurn(ev, session);
          // The agent waits for more input on stdin; the turn is over.
          if (interactive) proc.stdin.end();
        }
        this.emit(ev);
      }
    };

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', guard((chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(agent.raw ? line : line.trim());
      }
    }));
    // Otherwise the last line without \n would stay in the buffer.
    proc.stdout.on('end', guard(() => {
      if (buffer) handleLine(agent.raw ? buffer : buffer.trim());
      buffer = '';
    }));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => (stderr += chunk));

    proc.on('error', (err) => {
      if (!current()) return;
      this.proc = null;
      this.emit({ type: 'done', ok: false, error: `Failed to start "${cmd}": ${err.message}` });
    });
    proc.on('close', guard((code, signal) => {
      if (!current()) return;
      this.proc = null;
      this.cancelPending();
      if (!retried && resume && agent.isMissingSession?.(stderr)) {
        // The session disappeared from disk (deleted history, another machine): start a new one.
        Object.assign(session, this.freshSession());
        this.saveState();
        this.emit({ type: 'status', text: 'Previous session not found, starting a new one.' });
        this.run(prompt, true);
        return;
      }
      // Claude exits cleanly with code 0 on SIGINT, so the signal may not be visible.
      const stopped = signal != null || this.stopping === proc;
      if (!finished && agent.onExit) {
        ctx.stderr = stderr;
        for (const ev of agent.onExit({ code, signal: stopped ? signal ?? 'SIGINT' : null }, ctx)) this.emit(ev);
        return;
      }
      if (!finished) {
        const error = stopped ? 'Stopped.' : stderr.trim().slice(-800) || `Agent exited with code ${code}.`;
        this.emit({ type: 'done', ok: false, error });
      }
    }));

    // stdin errors (EPIPE after the agent exited) must not crash the dev server.
    proc.stdin.on('error', () => {});
    if (interactive) proc.stdin.write(input(text));
    else if (stdin) proc.stdin.end(text);
    else proc.stdin.end();
  }

  /** The user's answer to a `permission` event; the agent continues or tries something else. */
  answerPermission(id, allow) {
    const request = this.pending.get(id);
    if (!request || !this.proc) throw Object.assign(new Error('That question is no longer open.'), { status: 404 });
    this.pending.delete(id);
    this.proc.stdin.write(this.agent.answer({ requestId: id, input: request.input }, !!allow));
    this.emit({ type: 'permission-answer', id, allow: !!allow });
  }

  /** Questions that can't be answered any more (the turn ended, Stop, a new conversation). */
  cancelPending() {
    for (const id of this.pending.keys()) this.emit({ type: 'permission-answer', id, allow: false, cancelled: true });
    this.pending.clear();
  }

  /** Once per server run: links the skills the agent looks for in the project. */
  prepare(agent) {
    if (!agent.prepare || this.prepared.has(agent.name)) return;
    this.prepared.add(agent.name);
    try {
      const created = agent.prepare({ root: this.root });
      if (created.length) {
        this.emit({ type: 'status', text: `Skills for ${agent.label}: ${created.join(', ')}` });
        this.logger?.info(`Created for ${agent.label}: ${created.join(', ')}`);
      }
    } catch (err) {
      this.emit({ type: 'status', text: `Failed to prepare skills for ${agent.label}: ${err.message}` });
    }
  }

  /** Claude reports the cumulative session cost; derive the cost of one message from it. */
  priceTurn(ev, session) {
    if (ev.totalCostUsd == null || ev.costUsd != null) return ev;
    const costUsd = Math.max(0, ev.totalCostUsd - (session.totalCostUsd ?? 0));
    session.totalCostUsd = ev.totalCostUsd;
    this.saveState();
    return { ...ev, costUsd };
  }

  stop() {
    if (!this.proc) return false;
    const proc = this.proc;
    this.stopping = proc;
    killGroup(proc, 'SIGINT');
    setTimeout(() => proc.exitCode == null && proc.signalCode == null && killGroup(proc, 'SIGTERM'), 3000).unref();
    return true;
  }

  /** Server shutdown: the agent runs in its own process group and wouldn't exit by itself. */
  dispose() {
    // Synchronous: also called from process.on('exit'), where async work never finishes.
    if (this.proc) killGroup(this.proc, 'SIGTERM', { sync: true });
    this.proc = null;
    process.off('exit', this.onExit);
  }

  /** New conversation for all agents. */
  reset() {
    this.stop();
    this.proc = null; // this discards the exiting process's output (see current() in run)
    this.pending.clear();
    this.state = { sessions: {} };
    this.saveState();
    this.events = [];
    fs.rmSync(path.join(this.dir, 'transcript.jsonl'), { force: true });
    this.emit({ type: 'reset' });
  }
}

function killGroup(proc, sig, { sync = false } = {}) {
  try {
    // Negative PID = the whole process group (spawn with detached).
    process.kill(process.platform === 'win32' ? proc.pid : -proc.pid, sig);
  } catch {}
  // Agent in a container: killing the `docker compose run` client doesn't stop the container.
  if (proc.cleanup && !proc.cleaned) {
    proc.cleaned = true;
    const { cmd, args } = proc.cleanup;
    if (sync) spawnSync(cmd, args, { stdio: 'ignore', timeout: 10000 });
    else spawn(cmd, args, { stdio: 'ignore' }).on('error', () => {});
  }
}

function probe(bin, args, cwd) {
  return new Promise((resolve) => {
    let out = '';
    // cwd: `docker compose` looks for the compose file from the project root upwards.
    const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    // An agent in Docker starts a container, hence the longer timeout.
    const timer = setTimeout(() => proc.kill(), 15000);
    proc.stdout.on('data', (c) => (out += c));
    proc.on('error', () => (clearTimeout(timer), resolve(null)));
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const line = out.trim().split('\n')[0];
      resolve(line.match(/\d+\.\d+[\w.-]*/)?.[0] ?? (line || bin));
    });
  });
}

/** "Claude Code ✓, Codex ✗, …" for the startup log. */
export function describeAgents(session) {
  return Object.entries(session.agents)
    .map(([name, a]) => `${a.label ?? name} ${session.available[name] ? '✓' : '✗'}`)
    .join(', ');
}

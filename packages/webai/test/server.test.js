import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { customAgent } from '../src/agents/custom.js';
import { createMiddleware } from '../src/server.js';
import { AgentSession } from '../src/session.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'webai-'));

/** Middleware on a random port; returns a function for a request with the given Host. */
async function serve(session, opts) {
  const mw = createMiddleware(session, 'T', opts);
  const server = http.createServer((req, res) => mw(req, res, () => res.writeHead(404).end()));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const request = (method, url, { host = `localhost:${port}`, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ port, method, path: url, headers: { host, 'x-webai-token': 'T', origin: `http://${host}`, 'content-type': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.end(body);
    });
  return { request, close: () => server.close() };
}

test('server: rejects a foreign Host (DNS rebinding), bad JSON is 400', async () => {
  const session = new AgentSession({ root: tmp(), agents: { custom: customAgent() }, stateDir: '.webai' });
  const { request, close } = await serve(session);
  try {
    assert.equal((await request('GET', '/__webai/state')).status, 200);
    assert.equal((await request('GET', '/__webai/state', { host: 'evil.example:80' })).status, 403);
    assert.equal((await request('POST', '/__webai/send', { body: '{nope' })).status, 400);
    assert.equal((await request('POST', '/__webai/send', { body: '{"message":5}' })).status, 400);
  } finally {
    close();
  }
});

test('session: "New" during a run discards the old process output', async () => {
  const session = new AgentSession({ root: tmp(), agents: { custom: customAgent({ command: 'sleep 0.3; echo OLD' }) }, stateDir: '.webai' });
  await session.detect();
  const seen = [];
  session.subscribe((ev) => seen.push(ev));
  session.send({ message: 'x' });
  session.reset();
  assert.equal(session.busy, false);
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(!seen.some((ev) => ev.text?.includes('OLD')), 'old process output leaked into the new conversation');
});

test("session: a corrupted history line doesn't discard the rest", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.webai'));
  const line = (seq) => JSON.stringify({ type: 'status', text: `s${seq}`, seq }) + '\n';
  fs.writeFileSync(path.join(root, '.webai/transcript.jsonl'), line(1) + '{"type":"sta\n' + line(3));
  const session = new AgentSession({ root, agents: { custom: customAgent() }, stateDir: '.webai' });
  assert.deepEqual(session.events.map((e) => e.seq), [1, 3]);
  session.dispose();
});

test('session: a stopped agent reports "Stopped." even when it exits with code 0', async () => {
  // Like claude: on SIGINT it cleans up and exits with code 0.
  const agent = { ...customAgent({ command: "trap 'exit 0' INT; sleep 5 & wait" }) };
  const session = new AgentSession({ root: tmp(), agents: { custom: agent }, stateDir: '.webai' });
  await session.detect();
  const done = new Promise((resolve) => session.subscribe((ev) => ev.type === 'done' && resolve(ev)));
  session.send({ message: 'x' });
  await new Promise((r) => setTimeout(r, 200));
  session.stop();
  assert.equal((await done).error, 'Stopped.');
});

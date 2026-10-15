import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './worker.js';

const req = (body, origin = 'http://localhost:4500') =>
  new Request('https://proxy.example/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  });

test('proxy: foreign origin is rejected, unlisted model is replaced, tries the next one on 429', async (t) => {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, model: body.model, auth: init.headers.Authorization, keys: Object.keys(body).sort() });
    return new Response('{}', { status: sent.length === 1 ? 429 : 200 });
  });
  const env = { UPSTREAM_KEY: 'sk-test', ALLOWED_MODELS: 'free-a,free-b', MODEL: 'free-a' };

  assert.equal((await worker.fetch(req({}, 'https://evil.example'), env)).status, 403);
  assert.equal(sent.length, 0);

  const res = await worker.fetch(req({ model: 'paid/expensive', messages: [], temperature: 2, max_tokens: 99999 }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:4500');
  assert.deepEqual(sent.map((s) => s.model), ['free-a', 'free-b']);
  assert.equal(sent[0].auth, 'Bearer sk-test');
  assert.deepEqual(sent[0].keys, ['max_tokens', 'messages', 'model', 'stream']); // temperature and others are dropped
});

test('proxy: request too large and too many requests from one IP', async () => {
  const env = { MAX_BODY_BYTES: '50', RATE_PER_MINUTE: '1000' };
  assert.equal((await worker.fetch(req({ messages: [{ content: 'x'.repeat(100) }] }), env)).status, 413);
  const limited = { RATE_LIMITER: { limit: async () => ({ success: false }) } };
  assert.equal((await worker.fetch(req({}), limited)).status, 429);
});

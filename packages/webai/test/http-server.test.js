import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BRIDGE_TOKEN_FILE, createBridgeHandler, createMiddleware, createProxyMiddleware, json, pageAllowed, routeOf } from '../src/server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'webai-http-'));

function stubSession(over = {}) {
  const subs = new Set();
  return {
    busy: false,
    events: [{ seq: 1, type: 'status' }, { seq: 2, type: 'status' }, { seq: 3, type: 'status' }],
    sent: [],
    snapshot: () => ({ snap: true }),
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    subs,
    send(b) {
      this.sent.push(b);
    },
    setSettings: (s) => ({ got: s }),
    stop: () => true,
    history: { list: () => [{ index: 0 }] },
    restoreVersion: (i) => ({ restored: i }),
    reset() {
      this.wasReset = true;
    },
    ...over,
  };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, close: () => (server.closeAllConnections(), server.close()) };
}

function request(port, method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', method, path: url, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function api(session, opts, fn) {
  const mw = createMiddleware(session, 'T', opts);
  const s = await listen((req, res) => mw(req, res, () => res.writeHead(404, { 'x-next': '1' }).end()));
  const call = (method, url, { host = `localhost:${s.port}`, headers = {}, body } = {}) =>
    request(s.port, method, url, { headers: { host, 'x-webai-token': 'T', origin: `http://${host}`, 'content-type': 'application/json', ...headers }, body });
  try {
    await fn(call, s);
  } finally {
    s.close();
  }
}

test('server: non-API paths go to next, wrong token is 403', async () => {
  await api(stubSession(), undefined, async (call) => {
    assert.equal((await call('GET', '/other')).headers['x-next'], '1');
    assert.equal((await call('GET', '/__webai/state', { headers: { 'x-webai-token': 'bad' } })).status, 403);
  });
});

test('server: token in the query string', async () => {
  const session = stubSession();
  const mw = createMiddleware(session, 'T');
  const s = await listen((req, res) => mw(req, res, () => res.end()));
  try {
    const ok = await request(s.port, 'GET', '/__webai/state?token=T', { headers: { host: `localhost:${s.port}` } });
    assert.equal(ok.status, 200);
    const bad = await request(s.port, 'GET', '/__webai/state?token=X', { headers: { host: `localhost:${s.port}` } });
    assert.equal(bad.status, 403);
  } finally {
    s.close();
  }
});

test('server: API routes with a stub session', async () => {
  const session = stubSession();
  await api(session, undefined, async (call) => {
    assert.deepEqual(JSON.parse((await call('GET', '/__webai/state')).body), { snap: true });
    assert.deepEqual(JSON.parse((await call('GET', '/__webai/history')).body), [{ index: 0 }]);
    assert.deepEqual(JSON.parse((await call('POST', '/__webai/stop')).body), { stopped: true });
    assert.deepEqual(JSON.parse((await call('POST', '/__webai/settings', { body: '{"a":1}' })).body), { settings: { got: { a: 1 } } });
    assert.deepEqual(JSON.parse((await call('POST', '/__webai/history/restore', { body: '{"index":2}' })).body), { restored: 2 });
    assert.equal((await call('POST', '/__webai/history/restore', { body: '{"index":"2"}' })).status, 400);
    assert.equal((await call('POST', '/__webai/reset')).status, 200);
    assert.equal(session.wasReset, true);
    assert.equal((await call('GET', '/__webai/nope')).status, 404);

    assert.equal((await call('POST', '/__webai/send', { body: '{"message":"  "}' })).status, 400);
    assert.equal((await call('POST', '/__webai/send', { body: '{"message":"hi"}' })).status, 202);
    assert.equal(session.sent[0].message, 'hi');
    session.busy = true;
    assert.equal((await call('POST', '/__webai/send', { body: '{"message":"hi"}' })).status, 409);
    session.busy = false;
  });
});

test('server: readJson errors and handler error statuses', async () => {
  const session = stubSession({
    setSettings() {
      throw Object.assign(new Error('teapot'), { status: 418 });
    },
    stop() {
      throw new Error('boom');
    },
  });
  await api(session, undefined, async (call) => {
    assert.equal((await call('POST', '/__webai/send', { body: '{bad' })).status, 400);
    assert.equal((await call('POST', '/__webai/send', { body: '[1]' })).status, 400);
    assert.equal((await call('POST', '/__webai/send', { body: 'null' })).status, 400);
    assert.equal((await call('POST', '/__webai/send', { body: '' })).status, 400); // {} → empty message
    const r = await call('POST', '/__webai/settings', { body: '{}' });
    assert.equal(r.status, 418);
    assert.equal(JSON.parse(r.body).error, 'teapot');
    assert.equal((await call('POST', '/__webai/stop')).status, 500);
    const big = await call('POST', '/__webai/send', { body: JSON.stringify({ message: 'x'.repeat(1_100_000) }) }).catch((e) => ({ status: e.code }));
    assert.ok(big.status === 400 || big.status === 'ECONNRESET' || big.status === 'EPIPE', String(big.status));
  });
});

test('server: SSE events replay, Last-Event-ID, live events, ping and cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const session = stubSession();
  const mw = createMiddleware(session, 'T');
  const s = await listen((req, res) => mw(req, res, () => res.end()));
  try {
    const get = (url, extra = {}) =>
      new Promise((resolve) => {
        const req = http.request({ port: s.port, host: '127.0.0.1', path: url, headers: { host: `localhost:${s.port}`, 'x-webai-token': 'T', ...extra } }, (res) => {
          let data = '';
          let ticked = false;
          res.on('data', (c) => {
            data += c;
            if (data.includes('event: ready') && !ticked) {
              ticked = true;
              session.subs.forEach((fn) => fn({ seq: 9, type: 'live' }));
              t.mock.timers.tick(20000);
              setTimeout(() => (req.destroy(), resolve({ res, data })), 50);
            }
          });
        });
        req.end();
      });
    const a = await get('/__webai/events?since=1');
    assert.equal(a.res.headers['content-type'], 'text/event-stream');
    assert.ok(!a.data.includes('id: 1\n') && a.data.includes('id: 2\n') && a.data.includes('id: 3\n'));
    assert.ok(a.data.includes('"live"') && a.data.includes(': ping'));
    const b = await get('/__webai/events', { 'last-event-id': '2' });
    assert.ok(!b.data.includes('id: 2\n') && b.data.includes('id: 3\n'));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(session.subs.size, 0);
  } finally {
    s.close();
  }
});

test('server: Origin, Sec-Fetch-Site and Host checks', async () => {
  await api(stubSession(), undefined, async (call, s) => {
    const h = `localhost:${s.port}`;
    assert.equal((await call('GET', '/__webai/state', { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
    assert.equal((await call('GET', '/__webai/state', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await call('GET', '/__webai/state', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal((await call('GET', '/__webai/state', { headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await call('GET', '/__webai/state', { headers: { origin: 'not a url' } })).status, 403);
    assert.equal((await call('GET', '/__webai/state', { headers: { origin: `http://${h}` } })).status, 200);
    // no Origin: fine for GET, not for POST
    const noOrigin = (method) => request(s.port, method, '/__webai/reset', { headers: { host: h, 'x-webai-token': 'T' } });
    assert.equal((await noOrigin('POST')).status, 403);
    assert.equal((await request(s.port, 'GET', '/__webai/state', { headers: { host: h, 'x-webai-token': 'T' } })).status, 200);
    // host that is not a valid URL authority
    assert.equal((await call('GET', '/__webai/state', { host: 'a b' })).status, 403);
  });
});

test('server: allowRemote skips the host check, trustProxy reads X-Forwarded-*', async () => {
  await api(stubSession(), { allowRemote: true }, async (call) => {
    assert.equal((await call('GET', '/__webai/state', { host: 'evil.example' })).status, 200);
    assert.equal((await call('GET', '/__webai/state', { host: 'evil.example', headers: { origin: 'http://other.example' } })).status, 403);
  });
  await api(stubSession(), { trustProxy: true }, async (call, s) => {
    const fwd = (host, xff, origin) => call('GET', '/__webai/state', { host: `localhost:${s.port}`, headers: { 'x-forwarded-host': host, 'x-forwarded-for': xff, origin } });
    assert.equal((await fwd('localhost:3000, proxy', '127.0.0.1, 10.0.0.1', 'http://localhost:3000')).status, 200);
    assert.equal((await fwd('localhost:3000', '8.8.8.8', 'http://localhost:3000')).status, 403);
    assert.equal((await fwd('evil.example', '127.0.0.1', 'http://evil.example')).status, 403);
  });
  await api(stubSession(), { trustProxy: false }, async (call, s) => {
    // forwarded headers are ignored without trustProxy
    const r = await call('GET', '/__webai/state', { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-for': '8.8.8.8' } });
    assert.equal(r.status, 200);
  });
});

test('server: pageAllowed edge cases and helpers', () => {
  assert.equal(pageAllowed({ socket: {}, headers: {}, method: 'GET' }), false);
  const req = (remote, headers) => ({ socket: { remoteAddress: remote }, headers: { host: 'localhost:1', ...headers }, method: 'GET' });
  assert.equal(pageAllowed(req('::1')), true);
  assert.equal(pageAllowed(req('::ffff:127.0.0.1')), true);
  assert.equal(pageAllowed(req('10.0.0.5')), false);
  assert.equal(pageAllowed(req('10.0.0.5'), { allowRemote: true }), true);
  assert.equal(pageAllowed(req('10.0.0.5', { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost:1' }), { trustProxy: true }), false);
  assert.equal(routeOf({ url: '/__webai/state?x=1' }), '/state');
  assert.equal(routeOf({ url: '/other' }), null);
});

test('server: json helper', async () => {
  const s = await listen((req, res) => json(res, 201, { a: 1 }));
  try {
    const r = await request(s.port, 'GET', '/');
    assert.equal(r.status, 201);
    assert.equal(r.headers['content-type'], 'application/json');
  } finally {
    s.close();
  }
});

test('server: bridge handler', async () => {
  const session = stubSession();
  const h = createBridgeHandler(session, 'BT', () => 'agents!');
  const s = await listen(h);
  try {
    assert.equal((await request(s.port, 'GET', '/elsewhere')).status, 404);
    assert.deepEqual(JSON.parse((await request(s.port, 'GET', '/__webai/health')).body), { agents: 'agents!' });
    assert.equal((await request(s.port, 'GET', '/__webai/state')).status, 403);
    assert.equal((await request(s.port, 'GET', '/__webai/state', { headers: { 'x-webai-token': 'BT', origin: 'http://x' } })).status, 403);
    assert.equal((await request(s.port, 'GET', '/__webai/state', { headers: { 'x-webai-token': 'BT' } })).status, 200);
    // health needs GET: a POST falls through to the token check
    assert.equal((await request(s.port, 'POST', '/__webai/health')).status, 403);
  } finally {
    s.close();
  }
});

test('server: proxy middleware forwards to the bridge', async () => {
  const root = tmp();
  const seen = [];
  const bridge = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    if (req.url.startsWith('/__webai/cut')) {
      // answers while the body is still coming, then resets the connection
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      setTimeout(() => req.socket.resetAndDestroy(), 30);
      return;
    }
    req.on('end', () => {
      seen.push({ url: req.url, token: req.headers['x-webai-token'], body, lei: req.headers['last-event-id'], ct: req.headers['content-type'] });
      if (req.url.startsWith('/__webai/rejected')) return json(res, 403, {});
      json(res, 200, { ok: true, body });
    });
  });
  const mw = createProxyMiddleware({ token: 'T', bridge: `http://127.0.0.1:${bridge.port}`, root, stateDir: '.webai' });
  const front = await listen((req, res) => mw(req, res, () => res.writeHead(404, { 'x-next': '1' }).end()));
  const hdr = { host: `localhost:${front.port}`, 'x-webai-token': 'T', origin: `http://localhost:${front.port}` };
  try {
    assert.equal((await request(front.port, 'GET', '/plain')).headers['x-next'], '1');
    assert.equal((await request(front.port, 'GET', '/__webai/state', { headers: { ...hdr, 'x-webai-token': 'no' } })).status, 403);
    const missing = await request(front.port, 'GET', '/__webai/state', { headers: hdr });
    assert.equal(missing.status, 502);
    assert.match(JSON.parse(missing.body).error, /missing \.webai\/bridge-token/);

    fs.mkdirSync(path.join(root, '.webai'));
    fs.writeFileSync(path.join(root, '.webai', BRIDGE_TOKEN_FILE), 'BRIDGE\n');
    const ok = await request(front.port, 'POST', '/__webai/send?a=1', {
      headers: { ...hdr, 'content-type': 'application/json', 'last-event-id': '7' },
      body: '{"m":1}',
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(seen.at(-1), { url: '/__webai/send?a=1', token: 'BRIDGE', body: '{"m":1}', lei: '7', ct: 'application/json' });

    const rejected = await request(front.port, 'GET', '/__webai/rejected', { headers: hdr });
    assert.equal(rejected.status, 502);
    assert.match(JSON.parse(rejected.body).error, /rejected the token/);

    // the bridge resets the connection after it already answered: the response is just ended
    const cut = await new Promise((resolve) => {
      const r = http.request({ port: front.port, host: '127.0.0.1', method: 'POST', path: '/__webai/cut', headers: hdr }, (res) => {
        res.resume();
        res.on('close', () => resolve('closed'));
      });
      r.on('error', () => resolve('reqerror'));
      const t = setInterval(() => r.write('x'.repeat(1000)), 5);
      setTimeout(() => resolve('timeout'), 3000).unref();
      r.on('close', () => clearInterval(t));
    });
    assert.equal(cut, 'closed');

    // SSE without a request body: only the bridge response going away can end it
    const sse = await new Promise((resolve) => {
      http.get({ port: front.port, host: '127.0.0.1', path: '/__webai/cut-sse', headers: hdr }, (res) => {
        res.resume();
        res.on('close', () => resolve('closed'));
      }).on('error', () => resolve('closed'));
      setTimeout(() => resolve('hanging'), 3000).unref();
    });
    assert.equal(sse, 'closed');

    bridge.close();
    await new Promise((r) => setTimeout(r, 50));
    const down = await request(front.port, 'GET', '/__webai/state', { headers: hdr });
    assert.equal(down.status, 502);
    assert.match(JSON.parse(down.body).error, /not responding/);
  } finally {
    front.close();
    bridge.close();
  }
});

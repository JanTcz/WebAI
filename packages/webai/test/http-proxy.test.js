import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { proxyTo } from '../src/proxy.js';

const listenOn = async (server) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, close: () => (server.closeAllConnections?.(), server.close()) };
};

function get(port, url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', path: url, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Raw upgrade handshake: returns what the client receives until the socket closes or `until` matches. */
function rawUpgrade(port, payloadAfterHead = '', until = /echo:/) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    sock.on('data', (c) => {
      data += c;
      if (until.test(data)) sock.destroy();
    });
    sock.on('close', () => resolve(data));
    sock.on('error', () => resolve(data));
    sock.write(`GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: http://front\r\n\r\n${payloadAfterHead}`);
  });
}

/** An "upstream" that answers upgrades with 101 and echoes what it gets. */
function echoUpgrade(server) {
  server.on('upgrade', (req, socket, head) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.write(`echo:origin=${req.headers.origin}:host=${req.headers.host}:head=${head.toString()}:`);
    socket.on('data', (d) => socket.write(`echo:${d}`));
    socket.on('end', () => socket.end()); // http servers keep half-open sockets by default
  });
}

async function closedPort() {
  const s = await listenOn(http.createServer());
  const port = s.port;
  await new Promise((r) => s.server.close(r));
  return port;
}

test('proxy: forwards requests, rewrites Location, strips hop-by-hop headers, identity encoding for pages', async () => {
  const seen = [];
  const upstream = await listenOn(http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      const origin = `http://127.0.0.1:${upstream.port}`;
      switch (req.url) {
        case '/abs': res.writeHead(302, { location: `${origin}/next?x=1`, 'proxy-connection': 'x', 'x-up': '1' }); break;
        case '/root': res.writeHead(302, { location: origin }); break;
        case '/other': res.writeHead(302, { location: 'https://example.com/' }); break;
        case '/rel': res.writeHead(302, { location: '/local' }); break;
        default: res.writeHead(200, 'Custom', { 'content-type': 'text/plain' });
      }
      res.end('upstream:' + body);
    });
  }));
  const proxy = await listenOn(http.createServer(proxyTo(`http://127.0.0.1:${upstream.port}`)));
  try {
    const r = await get(proxy.port, '/abs', { headers: { accept: 'text/html', 'accept-encoding': 'gzip', origin: 'http://front', host: 'front' } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/next?x=1');
    assert.equal(r.headers['x-up'], '1');
    assert.equal(r.headers['proxy-connection'], undefined);
    assert.equal(seen[0].headers['accept-encoding'], 'identity');
    assert.equal(seen[0].headers.origin, `http://127.0.0.1:${upstream.port}`);
    assert.equal(seen[0].headers.host, `127.0.0.1:${upstream.port}`);

    assert.equal((await get(proxy.port, '/root')).headers.location, '/');
    assert.equal((await get(proxy.port, '/other')).headers.location, 'https://example.com/');
    assert.equal((await get(proxy.port, '/rel')).headers.location, '/local');

    const post = await get(proxy.port, '/echo?a=b', { method: 'POST', body: 'payload', headers: { 'accept-encoding': 'gzip' } });
    assert.deepEqual([post.status, post.body], [200, 'upstream:payload']);
    assert.equal(seen.at(-1).url, '/echo?a=b');
    assert.equal(seen.at(-1).headers['accept-encoding'], 'gzip'); // not a page: left alone
    assert.equal(seen.at(-1).headers.origin, undefined);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('proxy: 502 page when the upstream is down, connection dropped when it dies mid-response', async () => {
  const dead = await closedPort();
  const proxyDown = await listenOn(http.createServer(proxyTo(`http://127.0.0.1:${dead}`)));
  try {
    const r = await get(proxyDown.port, '/');
    assert.equal(r.status, 502);
    assert.match(r.body, /not responding \(ECONNREFUSED\)/);
  } finally {
    proxyDown.close();
  }

  // the upstream answers, then resets the connection while the request body is still being sent
  const upstream = await listenOn(http.createServer((req, res) => {
    res.writeHead(200);
    res.write('partial');
    setTimeout(() => req.socket.resetAndDestroy(), 30);
  }));
  const proxy = await listenOn(http.createServer(proxyTo(`http://127.0.0.1:${upstream.port}`)));
  try {
    const outcome = await new Promise((resolve) => {
      const req = http.request({ port: proxy.port, host: '127.0.0.1', method: 'POST', path: '/' }, (res) => {
        res.resume();
        res.on('close', () => resolve('closed'));
      });
      req.on('error', () => resolve('error'));
      const t = setInterval(() => req.write('x'.repeat(1000)), 5);
      req.on('close', () => clearInterval(t));
      setTimeout(() => resolve('timeout'), 3000).unref();
    });
    assert.notEqual(outcome, 'timeout');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('proxy: WebSocket upgrade is passed through in both directions, including bytes after the head', async () => {
  const up = http.createServer();
  echoUpgrade(up);
  const upstream = await listenOn(up);
  const handler = proxyTo(`http://127.0.0.1:${upstream.port}`);
  const front = http.createServer(handler);
  front.on('upgrade', handler.upgrade);
  const proxy = await listenOn(front);
  try {
    const out = await rawUpgrade(proxy.port, 'early', /echo:origin=[^]*head=early:/);
    assert.match(out, /^HTTP\/1\.1 101/);
    assert.ok(out.includes(`echo:origin=http://127.0.0.1:${upstream.port}:host=127.0.0.1:${upstream.port}:head=early:`), out);

    const noHead = await rawUpgrade(proxy.port);
    assert.ok(noHead.includes('head=:'));
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('proxy: upgrade to a dead upstream closes the client socket (default ports 80 and 443)', async () => {
  for (const target of [`http://127.0.0.1:${await closedPort()}`, 'http://127.0.0.1', 'https://127.0.0.1']) {
    const handler = proxyTo(target);
    const front = http.createServer(handler);
    front.on('upgrade', handler.upgrade);
    const proxy = await listenOn(front);
    try {
      const out = await rawUpgrade(proxy.port, '', /never/);
      assert.equal(out, '');
    } finally {
      proxy.close();
    }
  }
});

test('proxy: https upstream (requests and WebSocket upgrade over TLS)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  } catch {
    return t.skip('openssl is not available');
  }
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const secure = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`secure:${req.url}`);
  });
  echoUpgrade(secure);
  const upstream = await listenOn(secure);
  const handler = proxyTo(`https://localhost:${upstream.port}`);
  const front = http.createServer(handler);
  front.on('upgrade', handler.upgrade);
  const proxy = await listenOn(front);
  try {
    const r = await get(proxy.port, '/hello');
    assert.deepEqual([r.status, r.body], [200, 'secure:/hello']);
    // the bytes after the head arrive either in `head` or as a following data event, depending on TLS record boundaries
    const out = await rawUpgrade(proxy.port, 'tls', /tls/);
    assert.match(out, /^HTTP\/1\.1 101/);
    assert.match(out, /tls/);
  } finally {
    if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    proxy.close();
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('proxy: an upstream error without a code is reported by its message', async (t) => {
  const handler = proxyTo('http://127.0.0.1:9');
  const proxy = await listenOn(http.createServer(handler));
  t.mock.method(http, 'request', () => {
    const fake = new PassThrough();
    queueMicrotask(() => fake.emit('error', new Error('weird failure')));
    return fake;
  });
  try {
    const r = await fetch(`http://127.0.0.1:${proxy.port}/`);
    assert.equal(r.status, 502);
    assert.match(await r.text(), /not responding \(weird failure\)/);
  } finally {
    proxy.close();
  }
});

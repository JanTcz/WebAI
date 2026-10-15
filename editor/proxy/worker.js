// Proxy for the browser editor: visitors need no key or account.
// A Cloudflare Worker accepts `POST /v1/chat/completions` from allowed origins,
// lets through only free models, limits request size and rate, and forwards
// them to UPSTREAM_URL (OpenRouter by default) with the key from the UPSTREAM_KEY secret.
//
// Deployment: see README.md next to this file.

const DEFAULTS = {
  UPSTREAM_URL: 'https://openrouter.ai/api/v1',
  MODEL: 'poolside/laguna-s-2.1:free',
  // Comma-separated; a trailing `*` = prefix.
  ALLOWED_ORIGINS: 'https://jantcz.github.io,http://localhost:4500,http://127.0.0.1:4500',
  ALLOWED_MODELS: 'poolside/laguna-s-2.1:free,cohere/north-mini-code:free,nvidia/nemotron-3-super-120b-a12b:free,kilo-auto/free',
  MAX_BODY_BYTES: '200000',
  MAX_TOKENS: '4096',
  RATE_PER_MINUTE: '20',
};

// Fallback limit within a single Worker instance; the RATE_LIMITER binding is the reliable one.
const hits = new Map();

export default {
  async fetch(request, env = {}) {
    const cfg = { ...DEFAULTS, ...env };
    const origin = request.headers.get('Origin') ?? '';
    const cors = corsHeaders(origin, cfg);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(cors ?? {}) } });

    const { pathname } = new URL(request.url);
    if (pathname === '/health') return json(200, { ok: true, model: cfg.MODEL });
    if (!cors) return json(403, { error: { message: 'This proxy only serves the WebAI Editor.' } });
    if (request.method === 'GET' && pathname.endsWith('/models')) {
      // The model list for the editor's model select.
      const res = await fetch(`${cfg.UPSTREAM_URL.replace(/\/$/, '')}/models`);
      return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600', ...cors } });
    }
    if (request.method !== 'POST' || !pathname.endsWith('/chat/completions')) return json(404, { error: { message: 'Not found' } });

    const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
    if (!(await allow(ip, env, Number(cfg.RATE_PER_MINUTE)))) {
      return json(429, { error: { message: 'Too many requests from your address, try again in a minute.' } });
    }

    const raw = await request.text();
    if (raw.length > Number(cfg.MAX_BODY_BYTES)) return json(413, { error: { message: 'The conversation is too long, start a new one ("New").' } });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: { message: 'Invalid JSON.' } });
    }

    // Only what the editor needs; other parameters (and other models) are dropped.
    const allowed = cfg.ALLOWED_MODELS.split(',').map((m) => m.trim());
    const upstreamBody = {
      model: allowed.includes(body.model) ? body.model : cfg.MODEL,
      messages: Array.isArray(body.messages) ? body.messages : [],
      ...(Array.isArray(body.tools) ? { tools: body.tools, tool_choice: 'auto' } : {}),
      max_tokens: Math.min(Number(body.max_tokens) || Number(cfg.MAX_TOKENS), Number(cfg.MAX_TOKENS)),
      stream: false,
    };

    // Free models are often overloaded (429): try the next one on the list so the visitor doesn't have to.
    const candidates = [upstreamBody.model, ...allowed.filter((m) => m !== upstreamBody.model)];
    let res;
    for (const model of candidates.slice(0, 4)) {
      res = await fetch(`${cfg.UPSTREAM_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.UPSTREAM_KEY ? { Authorization: `Bearer ${cfg.UPSTREAM_KEY}` } : {}),
          'HTTP-Referer': 'https://github.com/JanTcz/WebAI',
          'X-Title': 'WebAI Editor',
        },
        body: JSON.stringify({ ...upstreamBody, model }),
      });
      if (res.status !== 429 && res.status < 500) break;
    }
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json', ...cors } });
  },
};

function corsHeaders(origin, cfg) {
  const ok = cfg.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).some((o) => (o.endsWith('*') ? origin.startsWith(o.slice(0, -1)) : origin === o));
  if (!ok) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function allow(ip, env, perMinute) {
  if (env.RATE_LIMITER) return (await env.RATE_LIMITER.limit({ key: ip })).success;
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  // Forget addresses that went quiet, the map would otherwise only grow.
  if (hits.size > 1000) for (const [key, times] of hits) if (now - times.at(-1) >= 60_000) hits.delete(key);
  return recent.length <= perMinute;
}

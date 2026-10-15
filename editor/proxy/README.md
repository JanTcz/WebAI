# Editor proxy

With it, editor visitors need no key, no account and nothing to install.
Free models can't be called directly from the browser: OpenRouter needs a key,
Kilo Gateway doesn't allow CORS, Pollinations wants a sign-in and OpenCode Zen
is free only from the OpenCode client.

It forwards to OpenRouter by default (`UPSTREAM_URL`, with the key from the
`UPSTREAM_KEY` secret). With `UPSTREAM_URL=https://ai-gateway.kilo.ai/api/v1`
it uses Kilo Gateway's free models and needs no key; that's what the published
editor does.

What it enforces (`worker.js`):

- only allowed origins may call it (`ALLOWED_ORIGINS`);
- only models from `ALLOWED_MODELS` (free ones) pass, others are replaced
  with the default; of the parameters only `messages`, `tools` and a capped
  `max_tokens` pass;
- request size (`MAX_BODY_BYTES`) and requests per IP (the `RATE_LIMITER`
  binding, 20 per minute);
- an overloaded free model (429) is replaced with the next one on the list.

## Deployment (Cloudflare Workers, free plan)

```bash
cd editor/proxy
npx wrangler login
npx wrangler secret put UPSTREAM_KEY      # key from openrouter.ai/keys
npx wrangler deploy                       # prints https://webai-demo-proxy.<account>.workers.dev
```

Put the URL (`…workers.dev/v1`) into `<meta name="webai-proxy">` in
`editor/index.html`, and add the editor's origin to `ALLOWED_ORIGINS` in
`wrangler.toml` if it isn't there (`https://jantcz.github.io` is).

Recommendation: use a key with a credit limit of 0 (in the key settings on
OpenRouter), so it can't pay for any paid model even if it leaks.
Free models have a daily per-account limit shared by all visitors.

## Locally

```bash
npm run editor:proxy   # :4510, target and key from the UPSTREAM_URL, UPSTREAM_KEY variables
npm run editor       # :4500/editor/ uses the local proxy automatically
```

`UPSTREAM_URL=https://ai-gateway.kilo.ai/api/v1` works without a key: Kilo
Gateway serves its free models anonymously, 200 requests per hour per IP (all
visitors of a proxy share its IP). Free models may log prompts, so don't send
personal data through them.

## Without a proxy

Without any proxy (empty `<meta name="webai-proxy">`) the editor offers
"Sign in with OpenRouter": OAuth PKCE straight from the browser, the key
belongs to the visitor's account.

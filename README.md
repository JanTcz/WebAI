<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="webai" height="56">
  </picture>
</h1>

[![test](https://github.com/JanTcz/WebAI/actions/workflows/test.yml/badge.svg)](https://github.com/JanTcz/WebAI/actions/workflows/test.yml)
[![coverage: 100%](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/JanTcz/WebAI/actions/workflows/test.yml "Lines, branches and functions of the core; npm test fails below 100 %")
[![npm](https://img.shields.io/npm/v/@jantcz/webai)](https://www.npmjs.com/package/@jantcz/webai)
[![Socket Badge](https://socket.dev/api/badge/npm/package/@jantcz/webai)](https://socket.dev/npm/package/@jantcz/webai)

### ▶ [Open the WebAI Editor](https://jantcz.github.io/WebAI/editor/) — edit any website in your browser, no install, no account

**Edit your website by talking to it.** Shift+click any element (or the
floating ✦ button), describe the change, and an AI agent edits the source code.
All messages go to **one conversation**, so the agent keeps its context.

Three ways to use it:

- **[WebAI Editor](https://jantcz.github.io/WebAI/editor/)**, in the browser:
  drop a website's folder or ZIP, click and talk, download the result. Nothing
  to install, no account, no API key; the files stay in your browser.
- **`npx @jantcz/webai`** for any site on your machine: a folder of HTML files,
  or in front of a dev server that is already running (Next.js, Django, Rails,
  Laravel, Hugo, …). Or as a **Docker image** when there's no Node.
- **A plugin** for your dev server: **Vite** (React, Vue, Svelte, SvelteKit,
  Solid, …), **Astro**, **Next.js**.

Locally the agent is the coding CLI you already use: Claude Code, Codex,
Gemini CLI, OpenCode, Pi, any command of your own, or the built-in agent
(free models with no key, OpenRouter, or a local Ollama).

**What's different** from other click-to-edit AI tools:

- **Your own coding agent with your own login:** whatever CLI you already use,
  with your skills and subscription, not a hosted model you pay for again.
- **One continuous conversation:** "a bit smaller still" refers to the last
  change, across page reloads and dev server restarts.
- **Nothing in production:** dev-only; the build has no script, no
  attributes, no trace of it (the Astro example's tests check that).
- **Exact source location** where the framework allows it: Astro templates
  (from Astro's own compiler) and static HTML get `file:line:column`; elsewhere
  the agent finds the element by its selector, text and HTML.
- **Version history:** ◀ ▶ in the panel step back and forward through every
  answer's changes, without touching your git repository.

```
packages/webai/      @jantcz/webai: the core and every way to run it (no build step, plain ESM)
  src/               core: createWebai(), the overlay's API, sessions, version history
  src/agents/        adapters: claude, codex, gemini, opencode, pi, webai (built-in), custom ("Other")
  src/client/        the in-browser overlay (shadow DOM, no dependencies)
  src/astro/ vite.js next/   framework plugins
  src/cli.js proxy.js static.js   the `webai` command
  bin/               webai (CLI), webai-agent (built-in agent)
  agents/            skills and subagents shared by all CLIs
examples/            astro (a page about webai), vite-react, next, static
editor/              the WebAI Editor: files in browser storage, agent in the browser
docker/              the webai image, agents in a container (OpenCode, Pi)
```

## Getting started

### Any site: the CLI

```bash
npx @jantcz/webai ./site                               # a folder of HTML files
npx @jantcz/webai --target http://localhost:3000       # a dev server that's already running
```

It opens on http://localhost:4300. A static folder gets exact source positions
and the page reloads after every change. With `--target` it's a reverse proxy:
pages get the overlay, everything else (including the dev server's own hot
reload over WebSockets) passes through. `--root` sets the project the agent
edits (default: the folder, or the current directory with `--target`), options
come from `webai.config.mjs` there. `npx @jantcz/webai --help` lists the rest.

### Docker

```bash
docker run --rm -it -p 127.0.0.1:4300:4300 -v "$PWD":/site ghcr.io/jantcz/webai
docker run --rm -it -p 127.0.0.1:4300:4300 -v "$PWD":/site ghcr.io/jantcz/webai --target http://host.docker.internal:3000 --root /site
```

The image is built for amd64 and arm64 on every release
(`.github/workflows/release.yml`); `docker build -f docker/webai.Dockerfile -t webai .`
builds it from this repository.

The image has the CLI, git (for the version history) and the built-in agent
with free models; no coding CLI and no login from the host. Publish the port on
`127.0.0.1` only: the overlay has to accept the browser coming in over the
Docker network.

### Vite

```bash
npm i -D @jantcz/webai
```

```js
// vite.config.js
import webai from '@jantcz/webai/vite';

export default defineConfig({ plugins: [react(), webai()] });
```

Only in `vite dev`. The overlay goes into every HTML page the dev server sends,
SPA or server-rendered (SvelteKit). Vite's hot reload shows the changes.

### Astro

```js
// astro.config.mjs
import webai from '@jantcz/webai/astro';

export default defineConfig({
  integrations: [
    webai({
      triggers: ['shift-click'],          // + 'contextmenu' (right click), 'alt-click'
      claude: {
        permissionMode: 'acceptEdits',    // may edit files, no shell
        allowedTools: ['Bash(npm run check)'],
        model: 'claude-sonnet-5-5',
      },
    }),
  ],
});
```

Every element of an `.astro` template gets its exact source position. Requires
Astro 7; on older Astro the overlay works without positions.

### Next.js

```js
// next.config.mjs
import { withWebai } from '@jantcz/webai/next';

export default withWebai({ /* your config */ });
```

```jsx
// app/layout.jsx, inside <body>
import { WebaiScript } from '@jantcz/webai/next/script';

<body>{children}<WebaiScript /></body>
```

Only in `next dev`. Next.js has no hook for middleware of its own, so the
overlay's API runs beside it on port 4399 (`withWebai(config, { port })`) and a
rewrite sends `/__webai/*` there; Fast Refresh shows the changes. Without
touching the code, `npx @jantcz/webai --target http://localhost:3000` works too.

### Any other Node server

```js
import { createWebai } from '@jantcz/webai';

const webai = createWebai({ root: process.cwd() });
app.use(webai.middleware);   // the overlay's API and scripts under /__webai/
app.use(webai.injector);     // adds the overlay to HTML pages
console.log(await webai.ready());
```

### Releasing

Bump `version` in `packages/webai/package.json`, commit, then push a tag `v<version>`.
`.github/workflows/release.yml` runs the tests and publishes `@jantcz/webai` to npm
(Trusted Publishing with provenance, no token) and `ghcr.io/jantcz/webai`.

### This repository

```bash
npm install --prefix examples/astro
npm run dev          # http://localhost:4321, Shift+click an element
npm test             # the core with 100 % coverage, the editor, the Astro example's build
```

`examples/` also has `vite-react`, `next` and `static` (`npm install && npm run dev` in each).
The Astro example's acceptance tests mainly check that nothing leaks into
`astro build`: no JavaScript, no `data-webai-src`.

## WebAI Editor (`editor/`)

Edit any website with nothing to install: it runs entirely in the browser. The
site's files (folders, several pages, images) live in the browser's Cache
Storage and a service worker (`sw.js`) serves the preview at `preview/…`, so
relative paths and links between pages work. Shift+click opens the same
overlay as the local tools, only instead of a dev server it talks to a small
harness in `editor.js`: a loop over an OpenAI-compatible `/chat/completions`
with the tools `list_files`, `read_file`, `edit_file`, `write_file`,
`delete_file`, `search_images` and `add_image`. The preview reloads after
every edit. No server, no Docker.

```bash
npm run editor:proxy # proxy on :4510 (see editor/proxy/README.md)
npm run editor       # http://localhost:4500/editor/
```

- **Your own site:** **Upload** takes files or a ZIP, and you can also drag
  in a whole folder. An upload containing `index.html` (also inside a single
  top-level folder, as ZIPs usually have) replaces the site; anything else is
  added to it. **Download ZIP** returns clean sources without annotations or
  the overlay. Limits: 10 MB per file, 50 MB per site. The ZIP code has no
  dependencies (`CompressionStream`).
- **Images:** ask for "a photo of …" and the agent searches openly licensed
  images on Openverse (no key, limits per visitor), saves the chosen one into
  the site and adds the credit line its license requires.
- **Versions:** ◀ ▶ in the panel, kept in the browser's storage.
- **The visitor needs nothing:** the published editor calls a small proxy that
  forwards to the free models of Kilo Gateway (no key needed) and rate-limits
  per IP; it only adds the CORS headers the gateway lacks. Calling a free model
  directly from the browser doesn't work: OpenRouter needs a key, Kilo Gateway
  doesn't allow CORS, Pollinations wants a sign-in, OpenCode Zen is free only
  from the OpenCode client and Puter.js needs an account. `editor/proxy/` has a
  proxy you can deploy yourself as a Cloudflare Worker (OpenRouter with your
  key, or Kilo Gateway without one). Like any public endpoint without accounts,
  the proxy can be called by scripts too; its rate limits keep that to the free
  tier anyway. When a free model is overloaded or answers with nothing, the
  editor switches to the next one.
- In ⚙ you can switch to **OpenRouter**: "Sign in with OpenRouter" right under
  the provider (OAuth PKCE straight from the browser) or your own key; or to a
  custom endpoint (e.g. a local Ollama with `OLLAMA_ORIGINS=*`).
- **Deployment:** the editor is static and imports the overlay from
  `../packages/`, so GitHub Pages serving the repo root (Deploy from a branch,
  `main`, `/`) publishes it at `https://jantcz.github.io/WebAI/editor/` with no
  build step (`/demo/` redirects there). The proxy URL goes into
  `<meta name="webai-proxy">` in `editor/index.html`.
- The overlay gets the harness through `cfg.transport` (`request` +
  `subscribe`); the default transport is HTTP + SSE to the dev server.
- Service workers don't run in Firefox private windows; the editor says so.

## Development in Docker

For a dev server in a container (here the Astro example): the dev server runs
in the container, the AI agents on the host. Otherwise the
container would need its own install and login for every CLI (Claude Code keeps
its macOS login in the Keychain, which a container can't reach) and wouldn't
see `~/.claude` or `~/.codex` with your skills and MCP servers.

```bash
npm run bridge       # on the host, keep it running (port 4400)
npm run docker       # = docker compose up, http://localhost:4321
```

```
browser ──/__webai/*──▶ astro dev (container) ──proxy──▶ webai bridge (host) ──▶ claude -p …
                               │                                 │
                               └──── same directory via bind mount ┘
```

- **The bridge owns the whole conversation** (`AgentSession`, `.webai/`); the
  container only authenticates the browser and forwards the request. Through
  the API the container can't choose what runs on the host: it can't send a
  command or `allowedTools`, only a prompt.
- **The container is not a security boundary against the host, though.** It
  has the project mounted read-write, so it can change anything the host later
  loads or runs: `package.json` scripts, `webai.config.mjs` (on the next bridge
  start), `CLAUDE.md`. That's why Claude runs in the bridge without project
  settings (`--setting-sources user --strict-mcp-config`), so hooks, allowed
  commands and MCP servers from `.claude/` and `.mcp.json` don't apply. Docker
  here separates environments (Node, native binaries), not untrusted code.
- **Token:** the bridge writes a fresh one to `.webai/bridge-token` on start.
  The project is mounted, so the dev server can read it; restarting the bridge
  is fine, the token is read on every request. The bridge listens only on
  `127.0.0.1` and rejects requests with an `Origin` header (i.e. straight from
  a browser).
- **Configuration** lives in `examples/astro/webai.config.mjs`. Both
  `astro.config.mjs` and the bridge read it, so it applies the same in and out
  of the container. After a change, restart the bridge (not the container).
- **"Other"** (custom command) has its command locked in the bridge: from the
  panel it could run anything on the host. Set it in the config
  (`custom: { command: '…' }`); `custom: { editable: true }` unlocks it.
- `node_modules` are in a volume (the ones from macOS have native binaries for
  another OS); `npm ci` runs only when `package-lock.json` changes.
- Linux without Docker Desktop: `npm run bridge -- --host 172.17.0.1` (the
  `docker0` address); `host-gateway` is already in compose.

Outside Docker nothing changes: without `WEBAI_BRIDGE`, the dev server runs
the agents directly. The bridge works for every plugin (`bridge` option or
`WEBAI_BRIDGE`); `npx @jantcz/webai bridge --root <project>` starts it.

## Agents in a container: OpenCode and Pi

Claude Code, Codex and Gemini CLI run on the host with your login. OpenCode
and Pi run in the `agents` container (`docker/agents.Dockerfile`): they need
nothing from the host and their tools see only this repo. Every message runs
`docker compose run --rm agents <cli> …` (about 1.5 s extra); conversations
and model catalogs persist in the `agents-home` volume.

```bash
docker compose --profile agents build   # once, then npm run dev / docker is enough
```

| | Model | What you need |
|---|---|---|
| **OpenCode** | `-free` models from OpenCode Zen (default DeepSeek V4.1 Flash) | **nothing**: no account, no key |
| **Pi** | anything Pi supports (OpenRouter, MiniMax, Anthropic, …) | a key in `.env` (see `.env.example`) |

- **OpenCode for free** works only from the OpenCode client (calling the API
  directly returns `FreeTierError`), hence a separate adapter. The model list
  changes; current one: `docker compose run --rm agents opencode models opencode`.
  Permissions are passed via `OPENCODE_CONFIG_CONTENT`: edits yes, shell and
  web no. Skills are read from `.agents/skills/`.
- **Pi** gets the skills via `--skill`, tools without `bash`, and
  `--no-approve` (it doesn't load extensions and settings from the project's
  `.pi/`). Free on OpenRouter are e.g. `poolside/laguna-s-2.1:free` or
  `cohere/north-mini-code:free` (they still need a key). **MiniMax** wasn't
  free anywhere in October 2026: via OpenRouter it costs ~$0.30 / $1.20 per
  million input / output tokens.
- Without Docker: leave out `docker` in `webai.config.mjs` and the agent runs
  on the host (`opencode`, `pi` in PATH).

## Built-in agent (no CLI needed)

Pick **Built-in** in ⚙ when no coding CLI is installed. It's a small loop
(`bin/webai-agent.js`) over any OpenAI-compatible API with file tools on the
project (list, search, read, edit, write, delete) and openly licensed images from
Openverse; no shell, and no access outside the project, to `.env*`,
`node_modules`, `.git` or `dist`.

- **Kilo Gateway** (default): free models without a key; when one is busy, the
  next takes over. A rate limit that asks for a short wait (`Retry-After` up to
  5 s) gets it first, on the same model.
- **OpenRouter**: set `OPENROUTER_API_KEY` (or `WEBAI_API_KEY`) where the dev
  server (or the CLI) runs. Keys never go into the project's files.
- **Custom**: any OpenAI-compatible endpoint, e.g. `http://localhost:11434/v1`
  for Ollama.

```js
webai({ webai: { provider: 'openrouter', model: 'poolside/laguna-s-2.1:free' } })
```

The conversation is kept in `.webai/agent/<session>.json`.

## Panel settings (⚙)

- **CLI:** when the dev server starts, it detects what's installed
  (`<cli> --version`). Missing CLIs are greyed out. Each agent has **its own
  conversation**; switching away and back resumes its context.
- **Other:** a custom command run through the shell in the project root, set
  in the config (`custom: { command: 'aider --yes --message {prompt}' }`). The
  prompt goes to stdin or replaces `{prompt}`; `{session}` is a stable
  conversation ID. The output is shown as the answer. `custom: { editable: true }`
  lets you change the command in the panel too; it's off by default because any
  script on the dev page can read the overlay's token. Every settings change is
  also printed to the terminal.
- **Model and effort** (Claude: haiku/sonnet/opus). Switching the model
  mid-conversation works, but the next message is a one-off more expensive:
  the new model writes the whole context into its cache again (measured: a
  follow-up on Haiku ~$0.001, the first one after switching to Sonnet ~$0.31).
- **Element picking:** Shift+click, Alt+click, right click. **Panel:** left/right.
  Drag the panel by its header, resize it from any corner; a double click on
  the header docks it back.

Agent settings are in `.webai/settings.json`, UI preferences in `localStorage`.

## Skills and subagents (`packages/webai/agents/`)

| | What it does |
|---|---|
| skill `element-edit` | how to get from `[Selected element]` to where text and styles really live (props, content collections, data), with or without a source position; careful with shared components |
| skill `web-styling` | tokens instead of raw values, WCAG AA contrast, existing breakpoints |
| skill `czech-copy` | Czech typography: „quotes“, non-breaking spaces, dashes |
| skill `stock-images` | openly licensed photos from Openverse, saved into the project, with alt text and the credit their license requires |
| skill `verify-change` | verifying without starting servers, honestly reporting what wasn't verified |
| subagent `a11y-reviewer` | accessibility review, read-only |
| subagent `copy-editor` | proofreading Czech copy, read-only |

Claude Code gets them via `--plugin-dir` (names `webai:…`, verified). Codex
and Gemini look for skills only inside the project, so on first use they are
linked into `.agents/skills/` (and `.gemini/agents/`; for Codex,
`.codex/agents/*.toml` is generated). Existing files are never overwritten.

## How it works

**Identifying the element.** Instead of hand-written `data-testid`s, every
HTML element in an `.astro` template is tagged in dev mode with
`data-webai-src="src/components/Hero.astro:9:7"`. Astro's old Go compiler did
this itself (`data-astro-source-*`), but the Rust compiler behind Astro 7
ignores `annotateSourceFile`. Hence a custom Vite plugin over the AST from
`@astrojs/compiler-rs`. Position units differ between its versions (0.3 bytes,
0.5 JS string characters), so the plugin checks each position against the
actual `<tag`. A broken template is left alone and Astro shows the error.
Static HTML (the CLI's folder mode, the editor) is tagged the same way. Pages
from other frameworks (React, Vue, Next.js, server templates) have no
positions: the agent gets the CSS selector, text and an HTML excerpt and finds
the element in the sources itself, which a coding agent does in one or two
searches. It also gets the `data-testid` if there is one, and, in Astro, the
chain of files the component is nested in.

**One conversation.** The first message calls `claude -p --session-id <uuid>`,
every next one `claude -p --resume <uuid>`. The UUID is in
`.webai/session.json`, so the conversation survives a page reload and a dev
server restart. The "New" button (double-click) starts a clean session. The
chat history is in `.webai/transcript.jsonl`.

**Version history.** Before each message the files are saved as a version
(the first one is "Start", later ones "Your edits" when you changed something
yourself), and after the answer as a version named after your message. ◀ ▶
in the panel header move between them (the agent must not be working); hover
`v3/5` for the label. Going back and then sending a new message drops the
versions after it, as in an editor's undo. Your own edits are never lost: when
you go to another version, they are first kept as a version at the end. The
versions are in a git repository of their own, `.webai/history.git`, so your
project's repository, index and history are never touched; the project's
`.gitignore` applies, and `.webai/`, `node_modules/`, `dist/`, `.astro/` are
left out. Without git installed there are no versions; everything else works.
The WebAI Editor keeps its versions in the browser's storage.

**Reloads while working.** The framework's hot reload shows the changes (an
`.astro` edit reloads the whole page); the CLI reloads the page after the
agent's answer. The panel reopens from `sessionStorage` and catches up on what
the agent did meanwhile via SSE.

**Permissions.** Claude runs in `acceptEdits`: it may edit files, no shell.
Bash isn't offered at all unless allowed in `claude.allowedTools`, so it
doesn't even try. Codex runs with `--sandbox workspace-write`, Gemini with
`--approval-mode auto_edit`.

**Security.** The `/__webai/*` endpoints run an agent with write access (and
"Other" runs any command). Therefore they:

- require a random token from the injected script;
- reject a foreign `Origin` and `Sec-Fetch-Site: cross-site` or `same-site`
  (another port on localhost);
- accept connections only from this machine with Host `localhost`/`127.0.0.1`,
  even when `--host` exposes the site to the network. This also
  prevents DNS rebinding. Behind the Next.js rewrite the browser's address and
  host come from `X-Forwarded-For`/`-Host`, trusted only from this machine.

The token reaches the page in `/__webai/boot.js`, which is served only under
the same rules.

**Prompt injection.** The selected element's text and HTML go to an agent that
can write files. On sites that show content from others (comments, a CMS,
imported data), that content could carry instructions for the agent. Review
what the agent changed, as with any AI edit.

`allowRemote: true` allows access from other devices; "Other" then can't be
changed from the panel. The dev server in the container (bridge) skips the
address check, since the browser comes in through the Docker network. That's
why compose binds the port to `127.0.0.1`.

**Processes.** The agent runs in its own process group: "Stop" also ends its
children (`sh -c` with a pipeline), and the agent is stopped when the dev
server restarts or exits. Output of a process interrupted by "New" doesn't
leak into the new conversation.

**Changes to the package's `src/`** (server, adapters) aren't picked up at
runtime; restart the dev server (in Docker, just the bridge). The client
(`src/client/`) reloads by itself.

Requires Node 20+.

## Adapter status

| | Status |
|---|---|
| Claude Code | verified live (edits, resuming, model switching, skills) |
| Other | verified live + tests (`{prompt}` quoting) |
| OpenCode (Docker) | verified live: file edit, shell denied, resuming via `--session`, free models without an account |
| Pi (Docker) | startup and parser per the Pi 1.2.0 docs; not verified with a model (no key) |
| Codex, Gemini CLI | written from docs and sources, **not verified live**: mainly the option order of `codex exec … resume <id>` and `gemini --session-id`. Codex reports tokens, not cost. |

Custom adapter: `agents: [myAdapter]` in the options, interface in `src/index.d.ts`.

## License

Free for noncommercial use under [PolyForm Noncommercial 1.0.0](LICENSE).
Commercial use (company websites, client work) costs EUR 5 per website, once;
terms in [COMMERCIAL.md](COMMERCIAL.md), pay at
[buymeacoffee.com/jant.cz](https://buymeacoffee.com/jant.cz). An earlier
prototype published on GitLab before October 15, 2026 was released under MIT
and stays under it.

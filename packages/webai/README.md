# @jantcz/webai

[![Socket Badge](https://socket.dev/api/badge/npm/package/@jantcz/webai)](https://socket.dev/npm/package/@jantcz/webai)

Shift+click any element on your site, say what to change, and an AI coding
agent edits the source: Claude Code, Codex, Gemini CLI, OpenCode, Pi, your own
command, or a built-in agent with free models. Development only: nothing ends
up in your build.

```bash
npx @jantcz/webai ./site                           # a folder of HTML files
npx @jantcz/webai --target http://localhost:3000   # in front of any running dev server
```

```js
import webai from '@jantcz/webai/vite';            // vite.config: plugins: [webai()]
import webai from '@jantcz/webai/astro';           // astro.config: integrations: [webai()]
import { withWebai } from '@jantcz/webai/next';    // next.config: export default withWebai(config)
import { createWebai } from '@jantcz/webai';       // any Node server: app.use(createWebai().middleware)
```

No install at all: the [WebAI Editor](https://jantcz.github.io/WebAI/editor/)
edits any website in the browser.

Documentation, examples and Docker: https://github.com/JanTcz/WebAI

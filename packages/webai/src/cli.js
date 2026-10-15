import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_PORT as BRIDGE_PORT, startBridge } from './bridge.js';
import { CONFIG_FILE, consoleLogger, loadConfig } from './config.js';
import { createWebai } from './core.js';
import { proxyTo } from './proxy.js';
import { staticFiles } from './static.js';

export const DEFAULT_PORT = 4300;

export const HELP = `webai: click an element on your site, tell an AI agent what to change.

  webai [dir]              a folder of static files (default: the current one)
  webai --target <url>     a dev server that is already running, e.g. http://localhost:3000
  webai bridge             agents on this machine for a dev server in a container

Options:
  --port <n>         default ${DEFAULT_PORT} (bridge: ${BRIDGE_PORT})
  --host <addr>      default 127.0.0.1
  --root <dir>       the project the agent edits (default: the folder, or the current one with --target)
  --config <file>    options (default export), default <root>/${CONFIG_FILE}
  --allow-remote     let other machines use the overlay (in a container: the Docker network)
  --open             open the browser
  -h, --help

Agents: Claude Code, Codex, Gemini CLI, OpenCode, Pi when installed, and the
built-in agent (free models, no key). Switch between them in the panel (⚙).`;

/** Runs the CLI; resolves to `{ url, close }` once it listens, or `null` after --help. */
export async function main(argv = process.argv.slice(2), { logger = consoleLogger, print = console.log } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      target: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
      root: { type: 'string' },
      config: { type: 'string' },
      'allow-remote': { type: 'boolean', default: false },
      open: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    print(HELP);
    return null;
  }

  if (positionals[0] === 'bridge') {
    const root = path.resolve(values.root ?? positionals[1] ?? '.');
    const { server, close } = await startBridge({ root, port: Number(values.port ?? BRIDGE_PORT), host: values.host, config: values.config, logger });
    return { url: `http://${values.host}:${server.address().port}`, close };
  }

  const dir = values.target ? null : path.resolve(positionals[0] ?? '.');
  if (dir && !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${dir} is not a folder.`);
  const root = path.resolve(values.root ?? dir ?? '.');
  const options = await loadConfig(root, values.config, logger);
  const w = createWebai({ ...options, root, logger, reload: true, allowRemote: values['allow-remote'] || options.allowRemote });
  const handler = values.target ? proxyTo(values.target) : staticFiles(dir);

  const server = http.createServer((req, res) => chain([w.middleware, w.injector], req, res, () => handler(req, res)));
  if (handler.upgrade) server.on('upgrade', handler.upgrade);
  const port = Number(values.port ?? DEFAULT_PORT);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, values.host, resolve);
  });
  const url = `http://${values.host === '0.0.0.0' ? 'localhost' : values.host}:${server.address().port}/`;
  logger.info(`${values.target ? `${values.target} through` : `${dir} on`} ${url}`);
  logger.info(await w.ready());
  if (values.open) openBrowser(url);

  const close = () => {
    w.dispose();
    server.close();
    server.closeAllConnections();
  };
  return { url, close, server };
}

/** The `webai` command: runs `main`, stops on Ctrl+C, reports errors without a stack trace. */
export async function run(argv = process.argv.slice(2), { exit = process.exit, onSignal = process.on.bind(process), logger = consoleLogger } = {}) {
  try {
    const running = await main(argv, { logger });
    for (const sig of ['SIGINT', 'SIGTERM']) onSignal(sig, () => (running?.close(), exit(0)));
    return running;
  } catch (err) {
    logger.error(err.code === 'EADDRINUSE' ? `Port ${err.port} is in use. Choose another with --port.` : err.message);
    exit(1);
    return null;
  }
}

/** Connect-style middlewares one after another, then `done`. */
export function chain(middlewares, req, res, done) {
  const run = (i) => (i < middlewares.length ? middlewares[i](req, res, () => run(i + 1)) : done());
  run(0);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

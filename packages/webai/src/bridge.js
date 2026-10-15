import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { resolveAgents } from './agents/index.js';
import { CONFIG_FILE, consoleLogger, loadConfig } from './config.js';
import { BRIDGE_TOKEN_FILE, createBridgeHandler } from './server.js';
import { AgentSession, describeAgents } from './session.js';

export const DEFAULT_PORT = 4400;
export { CONFIG_FILE };

/**
 * Bridge for developing in Docker: the dev server runs in a container, agents
 * (claude, codex, …) on the host, where their logins and configuration live.
 * The bridge holds the whole conversation; the container only forwards overlay requests.
 *
 * The token is written to `<root>/.webai/bridge-token`. The project is mounted
 * into the container, so the dev server can read it. Agent commands are set by
 * the config on the host; the container sends only the prompt through the API.
 *
 * The container can still write to the project, including `.claude/settings.json`
 * (hooks, allowed commands) or `.mcp.json`. Claude on the host therefore runs only
 * with user settings (`--setting-sources user`, `--strict-mcp-config`).
 */
export async function startBridge({ root, port = DEFAULT_PORT, host = '127.0.0.1', config, logger = consoleLogger }) {
  root = path.resolve(root);
  const options = await loadConfig(root, config, logger);
  const stateDir = options.stateDir ?? '.webai';
  const agents = resolveAgents({
    ...options,
    // A custom command from the browser would mean an arbitrary command on the host.
    custom: { editable: false, ...options.custom },
    claude: { projectSettings: false, ...options.claude },
  });
  const session = new AgentSession({ root, agents, stateDir, logger });
  await session.detect();

  const token = randomBytes(24).toString('hex');
  const server = http.createServer(createBridgeHandler(session, token, () => describeAgents(session)));
  await new Promise((resolve, reject) => {
    server.once('error', (err) => (session.dispose(), reject(err)));
    server.listen(port, host, resolve);
  });
  // Only after a successful listen: a failed second bridge must not overwrite the running one's token.
  const tokenFile = path.join(root, stateDir, BRIDGE_TOKEN_FILE);
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.rmSync(tokenFile, { force: true }); // mode only applies to a newly created file
  fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  logger.info(`Bridge for ${root} on http://${host}:${server.address().port}. Agents: ${describeAgents(session)}.`);

  const close = () => {
    session.dispose();
    try {
      // Only if the token is still ours (another bridge may have overwritten it meanwhile).
      if (fs.readFileSync(tokenFile, 'utf8').trim() === token) fs.rmSync(tokenFile);
    } catch {}
    server.close();
    server.closeAllConnections();
  };
  return { server, session, close };
}

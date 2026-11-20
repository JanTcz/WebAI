// How `webai mcp` finds the running instance: a file in the project's state folder.
// The dev server writes `<root>/.webai/mcp.json` ({ url, token }) once a page reports in;
// a bridge (dev server in Docker) keeps the token in `bridge-token`, its address is given with --bridge.

import fs from 'node:fs';
import path from 'node:path';
import { BRIDGE_TOKEN_FILE } from '../server.js';

export const MCP_ENDPOINT_FILE = 'mcp.json';

/** The address the tools reach this machine's server on: the page's port, always on loopback. */
export function loopbackUrl(origin) {
  const url = new URL(origin);
  url.hostname = '127.0.0.1';
  return url.origin;
}

export function writeEndpoint(dir, { url, token }) {
  const file = path.join(dir, MCP_ENDPOINT_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(file, { force: true }); // mode only applies to a newly created file
  fs.writeFileSync(file, JSON.stringify({ url, token, pid: process.pid }) + '\n', { mode: 0o600 });
}

/** Removes the file, but only if it is still ours (another dev server may have taken it over). */
export function removeEndpoint(dir, token) {
  const file = path.join(dir, MCP_ENDPOINT_FILE);
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.rmSync(file);
  } catch {}
}

/** `{ url, token }` of the running instance; throws an Error saying what to start when there is none. */
export function readEndpoint({ root, stateDir = '.webai', bridge }) {
  const dir = path.resolve(root, stateDir);
  if (bridge) {
    try {
      return { url: bridge, token: fs.readFileSync(path.join(dir, BRIDGE_TOKEN_FILE), 'utf8').trim() };
    } catch {
      throw new Error(`No bridge token in ${dir}. Start the bridge for this project on the host: npx webai bridge --root ${root}`);
    }
  }
  try {
    const { url, token } = JSON.parse(fs.readFileSync(path.join(dir, MCP_ENDPOINT_FILE), 'utf8'));
    return { url, token };
  } catch {
    throw new Error(
      `No running WebAI found for ${root} (missing ${path.join(dir, MCP_ENDPOINT_FILE)}). `
      + 'Start the dev server with the webai plugin, and open the site in a browser; the file appears when the first page loads.',
    );
  }
}

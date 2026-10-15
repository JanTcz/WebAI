import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONFIG_FILE = 'webai.config.mjs';

/** Options from `webai.config.mjs` in the project (or `config`), `{}` when there is none. */
export async function loadConfig(root, config, logger = consoleLogger) {
  const file = config ? path.resolve(config) : path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    if (config) throw new Error(`Config ${file} does not exist.`);
    return {};
  }
  logger.info(`Config: ${file}`);
  const mod = await import(pathToFileURL(file).href);
  return mod.default ?? {};
}

export const consoleLogger = {
  info: (msg) => console.log(`[webai] ${msg}`),
  warn: (msg) => console.warn(`[webai] ${msg}`),
  error: (msg) => console.error(`[webai] ${msg}`),
};

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.js';

// The real bridge on its fixed default port 4400, which may be taken on this machine.
test('bridge subcommand without port or folder: default port 4400, current folder', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webai-cli-')));
  const cwd = process.cwd();
  const logger = { info() {}, warn() {}, error() {} };
  process.chdir(dir);
  try {
    const running = await main(['bridge'], { logger });
    assert.equal(running.url, 'http://127.0.0.1:4400');
    assert.ok(fs.existsSync(path.join(dir, '.webai', 'bridge-token')));
    running.close();
  } catch (err) {
    assert.equal(err.code, 'EADDRINUSE');
    assert.equal(err.port, 4400);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

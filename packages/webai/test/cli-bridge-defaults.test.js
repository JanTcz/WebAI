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

test('bridge: Claude is not interactive, the container must not be able to approve its own tools', async () => {
  const { startBridge } = await import('../src/bridge.js');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webai-bridge-')));
  const logger = { info() {}, warn() {}, error() {} };
  const bridge = await startBridge({ root: dir, port: 0, logger });
  try {
    const c = bridge.session.agents.claude.command({ sessionId: 'x', resume: false, systemPrompt: 's' });
    assert.ok(!c.interactive && !c.args.includes('--permission-prompt-tool'));
    assert.ok(c.args.includes('--disallowedTools'));
  } finally {
    bridge.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

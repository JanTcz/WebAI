import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inside, matchEdit } from '../bin/webai-agent.js';
import { webaiAgent } from '../src/agents/webai.js';

test('built-in agent: tools reach only the project, not its secrets or generated folders', () => {
  assert.equal(inside('src/pages/index.astro').rel, 'src/pages/index.astro');
  assert.equal(inside('/src/a.css').rel, 'src/a.css'); // absolute = from the project root
  for (const bad of ['../outside.txt', '../../etc/passwd', 'src/../../x', 'node_modules/x/index.js', '.git/config', '.env', '.env.local', 'dist/index.html', '.webai/session.json', '', 42]) {
    assert.equal(inside(bad), null, String(bad));
  }
});

test('built-in agent: edits match despite indentation and quote style', () => {
  const src = '<ul>\n  <li>“Hi”</li>\n</ul>\n';
  const edit = matchEdit(src, '      <li>"Hi"</li>\n</ul>', '      <li>"Hi"</li>\n  <li>New</li>\n</ul>');
  assert.equal(src.replace(edit.old, () => edit.new), '<ul>\n  <li>“Hi”</li>\n  <li>New</li>\n</ul>\n');
});

test('built-in agent: Kilo by default, free fallbacks only for the default model, custom endpoint only for custom', () => {
  const agent = webaiAgent();
  const args = (settings, resume = false) => agent.command({ sessionId: 's1', resume, systemPrompt: 'SYS', settings, prompt: 'p' }).args;
  const def = args({});
  assert.equal(def[def.indexOf('--base-url') + 1], 'https://ai-gateway.kilo.ai/api/v1');
  assert.ok(def.includes('--fallbacks'));
  assert.ok(!def.includes('--resume'));
  const picked = args({ model: 'cohere/north-mini-code:free' }, true);
  assert.equal(picked[picked.indexOf('--model') + 1], 'cohere/north-mini-code:free');
  assert.ok(!picked.includes('--fallbacks'));
  assert.ok(picked.includes('--resume'));
  const custom = args({ provider: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'qwen' });
  assert.equal(custom[custom.indexOf('--base-url') + 1], 'http://localhost:11434/v1');
  const notCustom = args({ provider: 'openrouter', baseUrl: 'http://evil.example' });
  assert.equal(notCustom[notCustom.indexOf('--base-url') + 1], 'https://openrouter.ai/api/v1');
  assert.deepEqual(agent.parse({ type: 'text', text: 'hi' }), [{ type: 'text', text: 'hi' }]);
});

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// react is not installed here, and mock.module cannot mock a package that does not resolve:
// a resolve hook points the bare specifier at a stub module instead.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== 'react') return next(specifier, context);
    return { url: 'data:text/javascript,export const createElement = (...args) => ({ args });', shortCircuit: true };
  },
});
const mod = await import('../src/next/script.js');
hooks.deregister();

test('WebaiScript renders the boot script only in development', () => {
  const old = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';
    assert.deepEqual(mod.WebaiScript(), { args: ['script', { type: 'module', src: '/__webai/boot.js', async: true }] });
    assert.equal(mod.default, mod.WebaiScript);
    process.env.NODE_ENV = 'production';
    assert.equal(mod.WebaiScript(), null);
  } finally {
    process.env.NODE_ENV = old;
  }
});

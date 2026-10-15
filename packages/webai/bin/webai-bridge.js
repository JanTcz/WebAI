#!/usr/bin/env node
// Kept for existing setups: the same as `webai bridge`.
import { run } from '../src/cli.js';

run(['bridge', ...process.argv.slice(2)]);

// Packs @jantcz/webai to a tarball and installs it WITHOUT saving into another project
// (its package.json and lockfile stay untouched): `npm run pack:local -- ../codiak-platform/web`
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const target = process.argv[2];
if (!target || !fs.existsSync(path.join(target, 'package.json'))) {
  console.error('Usage: npm run pack:local -- <project folder with a package.json>');
  process.exit(1);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-pack-'));
const [file] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dir], { cwd: 'packages/webai', encoding: 'utf8' })).map((p) => p.filename);
execFileSync('npm', ['install', '--no-save', path.join(dir, file)], { cwd: target, stdio: 'inherit' });
console.log(`Installed ${file} into ${path.resolve(target)} (not saved). Restart its dev server.`);

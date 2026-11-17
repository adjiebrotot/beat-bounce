#!/usr/bin/env node
// Writes public/third-party-licenses.txt: the license of each library that the site ships.
//   node tools/licenses.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['three', 'postprocessing', '@tonejs/midi', 'midi-file', 'array-flatten', 'mp4-muxer'];

const parts = ['Beat Bounce ships these third-party libraries. Each keeps its own license.\n'];
for (const name of PACKAGES) {
  // direct dependencies sit in node_modules/, their own dependencies in pnpm's hoisted folder
  const dir = [path.join(ROOT, 'node_modules', name), path.join(ROOT, 'node_modules', '.pnpm', 'node_modules', name)].find((d) => fs.existsSync(d));
  if (!dir) throw new Error(`${name} is not installed`);
  const pj = path.join(dir, 'package.json');
  const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
  const file = fs.readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  parts.push(`${'='.repeat(80)}\n${meta.name} ${meta.version} (${meta.license})\n${meta.homepage ?? ''}\n${'='.repeat(80)}\n\n${file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : ''}\n`);
}
const vendored = fs.readFileSync(path.join(ROOT, 'src', 'vendor', 'realism-effects.js'), 'utf8');
const header = vendored.slice(0, vendored.indexOf('*/')).replace(/^\/?\s?\*\s?/gm, '').trim();
parts.push(`${'='.repeat(80)}\nrealism-effects 1.1.2 (MIT), vendored in src/vendor/\nhttps://github.com/0beqz/realism-effects\n${'='.repeat(80)}\n\n${header}\n`);
const out = path.join(ROOT, 'public', 'third-party-licenses.txt');
fs.writeFileSync(out, parts.join('\n'));
console.log(`wrote ${path.relative(ROOT, out)}`);

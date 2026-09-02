#!/usr/bin/env node
// scripts/verify-syntax.mjs — parse every module in the app as an ES MODULE, and fail on the first
// file that does not.
//
//   node scripts/verify-syntax.mjs
//
// WHY `node --check` IS NOT ENOUGH. The app's files are `.js` with no package.json to declare a
// type, so `--check` decides how to parse each one by guessing, and a file it parses as CommonJS
// can report clean while the browser — which always parses `<script type="module">` imports as
// ESM — throws. That is exactly what happened on the first Sattva → Glow merge: a patch hunk landed
// inside a comment block in js/investors/live.js, `node --check` passed every file, and the suite's
// first `import()` died with "Unexpected token '{'" and no file name. `vm.SourceTextModule` parses
// each file the way the browser will and names the file that failed.
//
// Glow-owned (see CLAUDE.md, "This dashboard is a downstream of Sattva"): the upstream sync runs it
// after every merge, and it is the first thing to run when a page goes blank after one.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

if (typeof vm.SourceTextModule !== 'function') {
  console.error('vm.SourceTextModule is unavailable — run with: node --experimental-vm-modules scripts/verify-syntax.mjs');
  process.exit(2);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = [...walk('public/js'), ...walk('worker'), ...walk('scripts')];
let bad = 0;
for (const f of files) {
  try {
    // Constructing the module parses it; nothing is linked or evaluated.
    new vm.SourceTextModule(readFileSync(f, 'utf8'), { identifier: f });
  } catch (err) {
    bad++;
    console.log(`FAIL  ${f} — ${err.message}`);
  }
}
console.log(bad ? `${bad} of ${files.length} files do not parse as ES modules.` : `PASS  ${files.length} files parse as ES modules.`);
process.exit(bad ? 1 : 0);

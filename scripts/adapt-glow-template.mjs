// Mechanical deployment substitutions after a real upstream merge. Semantic
// conflicts remain conflicts and are opened as draft PRs for review.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
export function adaptGlowText(old, path = '') {
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(old)) return old;
  let next = old.replaceAll('techmuns/Sattva-Central-Research', 'techmuns/Glow-Central-Research')
    .replaceAll('sattva-central-research.tech-441.workers.dev', 'glow-central-research.tech-441.workers.dev')
    .replaceAll('1329567087', '1339395437').replaceAll('Sattva Central Research', 'Glow Central Research')
    .replaceAll('Sattva Ventures', 'Glow Ventures')
    .replaceAll('/assets/brand/sattva-ventures-wordmark.png', '/assets/brand/glow-ventures-wordmark.svg')
    .replaceAll('/assets/brand/sattva-ventures-mark.svg', '/assets/brand/favicon.svg')
    // WHAT A WORKBOOK IS CALLED LEAVES THIS DEPLOYMENT WITH THE READER, so every download name is
    // rewritten — the quoted and the templated form, and the notebook's own `download =`. This rule
    // used to be the single-quoted `filename:` alone, so a reader exporting Breakouts, All Alerts,
    // Super Investors, Public Chatter, Telegram or the notebook from here got a file named after
    // the other deployment. Two kinds of `sattva-` are deliberately NOT touched: the postMessage
    // channel and the notebook's IndexedDB/BroadcastChannel names, which are protocol and durable
    // storage identities — renaming either would break the bridge or orphan saved notebooks — and
    // the `sattva-*` CSS class names, which nobody sees. The `^sattva-` strip in `screener.js`
    // derives a bookmark section FROM an export name, so it has to move with them or every section
    // silently gains a prefix.
    .replaceAll("filename: 'sattva-", "filename: 'glow-")
    .replaceAll('filename: `sattva-', 'filename: `glow-')
    .replaceAll("exportName: 'sattva-", "exportName: 'glow-")
    .replaceAll('exportName: `sattva-', 'exportName: `glow-')
    .replaceAll("exportName = 'sattva-", "exportName = 'glow-")
    .replaceAll('download = `sattva-notebook-', 'download = `glow-notebook-')
    .replaceAll('/^sattva-/', '/^glow-/')
    .replaceAll('Sattva Research', 'Glow Research').replaceAll('SATTVA CENTRAL RESEARCH', 'GLOW CENTRAL RESEARCH')
    .replaceAll("'Sattva-Central-Research'", "'Glow-Central-Research'");
  if (basename(path) === 'wrangler.jsonc') next = next
    .replace(/("name"\s*:\s*")sattva-central-research(")/g, '$1glow-central-research$2')
    .replace(/("namespace_id"\s*:\s*")17(\d{2})(")/g, (_, prefix, suffix, end) => `${prefix}18${suffix}${end}`);
  return next;
}
export function adaptGlowTemplate(root = process.cwd()) {
  const adapt = path => {
    const old = readFileSync(path, 'utf8'), next = adaptGlowText(old, path);
    if (next !== old) writeFileSync(path, next);
  };
  // SKIP BY PATH, NOT BY DIRECTORY NAME. This excluded any directory called `data`, which was
  // meant to be the committed captures in `public/data` — and also silently excluded
  // `public/js/data`, the largest source directory in the app. Every deployment identifier under
  // it survived each sync unadapted: `breakout-live-shared.js` shipped pointing the collector at
  // the OTHER deployment's Worker, which its own origin check would then refuse.
  const skipped = new Set([join(root, 'public', 'data'), join(root, 'public', 'assets')]);
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && !skipped.has(p) && !['node_modules', '.git'].includes(e.name)) walk(p);
      else if (/\.(js|mjs|cjs|py|yml|html|jsonc)$/.test(e.name) &&
        !['adapt-glow-template.mjs', 'sync-upstream.yml', 'sync-bulk-deals.mjs'].includes(e.name) && !e.name.startsWith('verify-')) adapt(p);
    }
  };
  for (const dir of ['public', 'worker', 'scripts', '.github']) walk(join(root, dir));
  for (const file of ['wrangler.jsonc']) adapt(join(root, file));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) adaptGlowTemplate();

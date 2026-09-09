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
    .replaceAll("filename: 'sattva-", "filename: 'glow-")
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
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && !['data', 'assets', 'node_modules', '.git'].includes(e.name)) walk(p);
      else if (/\.(js|mjs|cjs|py|yml|html|jsonc)$/.test(e.name) &&
        !['adapt-glow-template.mjs', 'sync-upstream.yml'].includes(e.name) && !e.name.startsWith('verify-')) adapt(p);
    }
  };
  for (const dir of ['public', 'worker', 'scripts', '.github']) walk(join(root, dir));
  for (const file of ['wrangler.jsonc']) adapt(join(root, file));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) adaptGlowTemplate();

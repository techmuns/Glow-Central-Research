// Mechanical deployment substitutions after a real upstream merge. Semantic
// conflicts remain conflicts and are opened as draft PRs for review.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs|cjs|py|yml)$/.test(e.name) && !['adapt-glow-template.mjs', 'sync-upstream.yml'].includes(e.name)) {
      const old = readFileSync(p, 'utf8');
      // Never make a conflicted source appear resolved.
      if (/^(<<<<<<<|=======|>>>>>>>)/m.test(old)) continue;
      const next = old.replaceAll('techmuns/Sattva-Central-Research', 'techmuns/Glow-Central-Research')
        .replaceAll('sattva-central-research.tech-441.workers.dev', 'glow-central-research.tech-441.workers.dev')
        .replaceAll('1329567087', '1339395437').replaceAll('Sattva Central Research', 'Glow Central Research')
        .replaceAll('Sattva Ventures', 'Glow Ventures')
        .replaceAll('/assets/brand/sattva-ventures-wordmark.png', '/assets/brand/glow-ventures-wordmark.svg')
        .replaceAll('/assets/brand/sattva-ventures-mark.svg', '/assets/brand/favicon.svg')
        .replaceAll('Sattva Research', 'Glow Research').replaceAll('SATTVA CENTRAL RESEARCH', 'GLOW CENTRAL RESEARCH').replaceAll("'Sattva-Central-Research'", "'Glow-Central-Research'");
      if (next !== old) writeFileSync(p, next);
    }
  }
}
for (const dir of ['public/js', 'worker', 'scripts', '.github']) walk(dir);

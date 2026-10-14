// Review-branch preparation only. No push, collector, deployment or data-file write.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const file = 'docs/GLOW-TEMPLATE-BASELINE.json';
const baseline = JSON.parse(readFileSync(file, 'utf8'));
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const [before, after, output] = process.argv.slice(2);
if (before === '--record') {
  if (!sha(after)) throw Error('Invalid template revision');
  writeFileSync(file, `${JSON.stringify({ ...baseline, revision: after, syncedOn: new Date().toISOString().slice(0, 10) }, null, 2)}\n`);
} else {
  if (!sha(before) || !sha(after) || !output) throw Error('Provide two template revisions and a patch path');
  const protectedPaths = [...baseline.preserve, file, 'docs/GLOW-TEMPLATE-SYNC.md', '.github/workflows/sync-upstream.yml', 'scripts/prepare-glow-template-patch.mjs'];
  const patch = execFileSync('git', ['diff', '--binary', '--no-renames', before, after, '--', '.',
    ...protectedPaths.map(path => `:(exclude)${path}`)], { maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(output, patch);
}

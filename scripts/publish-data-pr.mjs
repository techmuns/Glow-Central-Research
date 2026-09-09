// Compatibility entrypoint for Glow capture workflows; all writers share the reviewed PR gates.
import { execFileSync } from 'node:child_process';
const [name, ...paths] = process.argv.slice(2);
if (!/^[a-z-]+$/.test(name || '') || !paths.length || paths.some(p => !p.startsWith('public/data/') || p.split('/').includes('..'))) throw new Error('Expected a refresh name and explicit public/data paths');
execFileSync('git', ['config', 'user.name', 'github-actions[bot]']);
execFileSync('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
execFileSync('git', ['add', '--', ...paths]);
if (execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim()) {
  execFileSync(process.execPath, ['scripts/data-pr.mjs', `Refresh ${name} data`], { stdio: 'inherit' });
} else console.log('No data changes');

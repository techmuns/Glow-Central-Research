// Generated data follows the same branch, verification and review gates as code.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const DATA_REPOSITORY = 'techmuns/Glow-Central-Research';
export const dataPath = path => typeof path === 'string' && (path === 'public/data/shareholding-filings.json.gz' || /^public\/data\/.+\.(?:json|jsonl|csv|ndjson)$/.test(path)) && !path.split('/').some(part => ['.', '..', ''].includes(part)) && !/[\\\r\n]/.test(path);
export function dataBranch(runId = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT || '1') {
  if (!/^\d+$/.test(runId || '') || !/^\d+$/.test(attempt)) throw Error('A capture run identity is required');
  return `codex/data-${runId}-${attempt}`;
}
const command = (cwd, exe, args) => execFileSync(exe, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export function openPreparedDataPr({ cwd = process.cwd(), branch, title, run = command } = {}) {
  if (process.env.GITHUB_REPOSITORY !== DATA_REPOSITORY || !/^codex\/data-\d+-\d+(?:-news-\d+)?$/.test(branch || ''))
    throw Error('Unexpected data publication repository or branch');
  const files = run(cwd, 'git', ['diff', '--name-only', 'origin/main...HEAD']).split('\n').filter(Boolean);
  if (!files.length || files.some(path => !dataPath(path))) throw Error('Data PR contains files outside the generated-data boundary');
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'glow-data-pr-'));
  try {
    const body = join(scratch, 'body.md');
    writeFileSync(body, 'Retain the captured source records and collection health. Source publication dates remain unchanged.\n\nThis generated-data update must pass Verify and automated review before merging. Incomplete collection remains visible; this PR does not certify complete source coverage.\n');
    const url = run(cwd, 'gh', ['pr', 'create', '--repo', DATA_REPOSITORY, '--head', branch, '--base', 'main', '--title', title, '--body-file', body]);
    writeFileSync(body, '<!-- glow-data-review -->\n@codex review\n\nReview this generated-data update for identity, retained history and truthful collection status.\n');
    run(cwd, 'gh', ['pr', 'comment', url, '--repo', DATA_REPOSITORY, '--body-file', body]);
    // GITHUB_TOKEN-created PRs do not trigger pull_request workflows. Explicit
    // dispatch verifies their exact branch; the completion workflow checks the SHA.
    run(cwd, 'gh', ['workflow', 'run', 'verify.yml', '--repo', DATA_REPOSITORY, '--ref', branch]);
    return url;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
export function publishStagedData({ cwd = process.cwd(), title = 'Refresh retained dashboard data', run = command } = {}) {
  const files = run(cwd, 'git', ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  if (!files.length) return null;
  if (files.some(path => !dataPath(path))) throw Error('Refusing to publish non-data files');
  const branch = dataBranch();
  run(cwd, 'git', ['switch', '-c', branch]);
  run(cwd, 'git', ['commit', '-m', title]);
  run(cwd, 'git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  return openPreparedDataPr({ cwd, branch, title, run });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main' ||
      process.env.GITHUB_REPOSITORY !== DATA_REPOSITORY || resolve(process.env.GITHUB_WORKSPACE || '') !== process.cwd())
    throw Error('Data publication requires the Glow main Actions checkout');
  console.log(publishStagedData({ title: process.argv[2] || `${process.env.GITHUB_WORKFLOW}: retained data update` }) || 'No changed data');
}

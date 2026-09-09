// Runs trusted main-branch code only; never checks out or executes PR contents.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_REPOSITORY, dataPath } from './data-pr.mjs';
const reviewer = login => /^chatgpt-codex-connector(?:\[bot\])?$/.test(login || '');
export function dataReviewDecision({ pr, files, checks, runs, reviews, inline, comments }) {
  if (pr.state !== 'OPEN' || pr.isCrossRepository || pr.baseRefName !== 'main' ||
      pr.headRepository?.nameWithOwner !== DATA_REPOSITORY ||
      !/^codex\/data-\d+-\d+(?:-news-\d+)?$/.test(pr.headRefName || '') ||
      files.length !== pr.changedFiles || !files.length || files.some(f => !dataPath(f.filename))) return 'scope';
  if (pr.mergeable !== 'MERGEABLE' || pr.isDraft) return 'merge-gate';
  const current = runs.filter(r => r.headSha === pr.headRefOid).sort((a, b) => b.databaseId - a.databaseId)[0];
  if (!current || current.status !== 'completed' || current.conclusion !== 'success') return 'verification';
  const latest = new Map();
  for (const check of checks.slice().sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))) latest.set(check.name, check);
  for (const name of ['contracts', 'browser', 'portfolio-research']) if (latest.get(name)?.conclusion !== 'success') return 'verification';
  if ([...latest.values()].some(c => c.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(c.conclusion))) return 'checks';
  const completed = comments.some(c => reviewer(c.user?.login) && c.body.includes('codex-pull-request-review-summary') &&
    c.body.includes('Completed') && c.body.includes(`\`${pr.headRefOid.slice(0, 7)}\``));
  if (!completed) return 'review-pending-or-unavailable';
  if (inline.length || reviews.some(r => ['CHANGES_REQUESTED', 'COMMENTED'].includes(r.state))) return 'review-feedback';
  const informational = c => reviewer(c.user?.login) && (c.body.includes('codex-pull-request-review-summary') || c.body.startsWith('You have reached your Codex usage limits')) ||
    /^cloudflare-workers-and-pages(?:\[bot\])?$/.test(c.user?.login || '') && c.body.startsWith('## Deploying with') ||
    c.user?.login === pr.author?.login && c.body.startsWith('<!-- glow-data-review -->');
  if (comments.some(c => !informational(c))) return 'review-feedback';
  return 'ready';
}
export function mergeDataPr(event) {
  if (process.env.GITHUB_REPOSITORY !== DATA_REPOSITORY) throw Error('Unexpected repository');
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const json = (...args) => JSON.parse(gh(...args));
  const pages = path => json('api', path, '--paginate', '--slurp').flat();
  let number = event.pull_request?.number || (event.issue?.pull_request ? event.issue.number : null);
  if (event.workflow_run) {
    const wr = event.workflow_run;
    if (wr.name !== 'Verify' || wr.conclusion !== 'success' || (wr.repository?.full_name && wr.repository.full_name !== DATA_REPOSITORY) ||
        !/^codex\/data-\d+-\d+(?:-news-\d+)?$/.test(wr.head_branch || '')) return 'unrelated-run';
    const matches = json('pr', 'list', '--repo', DATA_REPOSITORY, '--state', 'open', '--head', wr.head_branch, '--json', 'number');
    if (matches.length !== 1) return 'no-unique-pr';
    number = matches[0].number;
  }
  if (!Number.isSafeInteger(number) || number < 1) return 'unrelated-event';
  const pr = json('pr', 'view', String(number), '--repo', DATA_REPOSITORY, '--json',
    'state,isDraft,isCrossRepository,headRefName,headRefOid,headRepository,baseRefName,changedFiles,mergeable,author');
  if (!pr.headRefName.startsWith('codex/data-')) return 'unrelated-pr';
  const input = { pr, files: pages(`repos/${DATA_REPOSITORY}/pulls/${number}/files`),
    checks: json('api', `repos/${DATA_REPOSITORY}/commits/${pr.headRefOid}/check-runs?per_page=100`, '--paginate', '--slurp').flatMap(page => page.check_runs),
    runs: json('run', 'list', '--repo', DATA_REPOSITORY, '--workflow', 'verify.yml', '--branch', pr.headRefName,
      '--limit', '30', '--json', 'databaseId,headSha,status,conclusion'),
    reviews: pages(`repos/${DATA_REPOSITORY}/pulls/${number}/reviews`), inline: pages(`repos/${DATA_REPOSITORY}/pulls/${number}/comments`),
    comments: pages(`repos/${DATA_REPOSITORY}/issues/${number}/comments`) };
  const decision = dataReviewDecision(input);
  if (decision === 'ready') gh('pr', 'merge', String(number), '--repo', DATA_REPOSITORY, '--merge', '--match-head-commit', pr.headRefOid);
  return decision;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  console.log(mergeDataPr(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))));

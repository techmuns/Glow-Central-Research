// Scheduled captures use the same PR gates as code changes. Never push a capture onto main.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [name, ...paths] = process.argv.slice(2);
if (!/^[a-z-]+$/.test(name || '') || !paths.length || paths.some((p) => !p.startsWith('public/data/'))) throw new Error('Expected a refresh name and explicit public/data paths');
if (!process.env.GH_TOKEN || !process.env.GITHUB_RUN_ID) throw new Error('A workflow run and SYNC_PUSH_TOKEN are required');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const gh = (...args) => run('gh', args), git = (...args) => run('git', args);
git('config', 'user.name', 'github-actions[bot]');
git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
git('add', '--', ...paths);
if (!git('diff', '--cached', '--name-only')) { console.log('No data changes'); process.exit(0); }
const branch = `codex/${name}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
git('switch', '-c', branch);
git('commit', '-m', `Refresh ${name} (${new Date().toISOString().slice(0, 10)})`);
git('push', 'origin', `HEAD:refs/heads/${branch}`);
const bodyPath = '/tmp/data-refresh-pr.md';
writeFileSync(bodyPath, `Refresh the captured ${name} data. The collector preserves dated last-good records and records failed reads.\n\nValidation: source shape/reconciliation checks during capture, holdings coverage audit in the run summary, and the repository PR checks. Coverage exceptions remain visible in the dashboard.\n\nThis automation reviews the changed file scope and check results. It does not claim automated code-review approval. Required reviews and unresolved review threads prevent merging.\n`);
const url = gh('pr', 'create', '--base', 'main', '--head', branch, '--title', `Refresh ${name} data`, '--body-file', bodyPath);
console.log(url);
// Allow checks/review integrations to register. Polls are bounded, and no required gate is bypassed.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await sleep(60000);
for (let attempt = 0; attempt < 40; attempt++) {
  const pr = JSON.parse(gh('pr', 'view', url, '--json', 'number,headRefOid,mergeStateStatus,reviewDecision,statusCheckRollup,files,reviews'));
  if (pr.files.some((f) => !paths.some((p) => f.path === p || f.path.startsWith(`${p.replace(/\/$/, '')}/`)))) throw new Error(`Unexpected changed files; review ${url}`);
  const checks = pr.statusCheckRollup || [];
  const pending = checks.some((c) => c.status && c.status !== 'COMPLETED' || c.state === 'PENDING');
  const failed = checks.some((c) => c.conclusion && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.conclusion) || c.state === 'FAILURE' || c.state === 'ERROR');
  const lastReviews = new Map((pr.reviews || []).map((r) => [r.author?.login, r.state]));
  if (failed || pr.reviewDecision === 'CHANGES_REQUESTED' || [...lastReviews.values()].includes('CHANGES_REQUESTED')) throw new Error(`Checks or review require attention: ${url}`);
  const contracts = checks.find((c) => c.name === 'contracts' && c.conclusion === 'SUCCESS');
  if (!pending && contracts && pr.reviewDecision !== 'REVIEW_REQUIRED' && pr.mergeStateStatus === 'CLEAN') {
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    const review = JSON.parse(gh('api', 'graphql', '-f', `query=query { repository(owner: "${owner}", name: "${repo}") { pullRequest(number: ${pr.number}) { reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage } } } } }`));
    const threads = review.data.repository.pullRequest.reviewThreads;
    if (threads.pageInfo.hasNextPage || threads.nodes.some((t) => !t.isResolved)) throw new Error(`Unresolved review feedback: ${url}`);
    gh('pr', 'merge', url, '--squash', '--delete-branch', '--match-head-commit', pr.headRefOid);
    console.log(`Merged ${url}`); process.exit(0);
  }
  await sleep(20000);
}
throw new Error(`PR left open awaiting checks, conflict resolution or required review: ${url}`);

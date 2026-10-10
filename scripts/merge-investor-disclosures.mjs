#!/usr/bin/env node
// GITHUB_TOKEN PRs do not trigger pull_request workflows. Explicit dispatch does.
// Always verify the exact commit and leave feedback/review gates for a person.
import { execFileSync } from 'node:child_process';
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const json = (...args) => JSON.parse(gh(...args));
import { REPOSITORY, validateCapturePr } from './prepare-investor-disclosures.mjs';
const number = Number(process.env.INVESTOR_PR_NUMBER);
if (!Number.isSafeInteger(number) || number <= 0) throw new Error('INVESTOR_PR_NUMBER is required');
const repo = process.env.GITHUB_REPOSITORY;
if (repo !== REPOSITORY) throw new Error('Unexpected repository');
const pr = validateCapturePr(json('pr', 'view', String(number), '--json', 'state,headRefOid,headRefName,headRepository,isCrossRepository,baseRefName,files'));
const previousRuns = new Set(json('run', 'list', '--workflow', 'verify.yml', '--branch', pr.headRefName, '--limit', '30', '--json', 'databaseId').map((r) => r.databaseId));
gh('workflow', 'run', 'verify.yml', '--ref', pr.headRefName);
// Verify's complete portfolio job allows 50 minutes including setup. The archive must
// wait for those unchanged checks, rather than abandon a healthy run after 20 minutes.
const timeout = Number(process.env.INVESTOR_VERIFY_TIMEOUT_MS || 55 * 60000);
if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 55 * 60000) throw new Error('Invalid verification timeout');
const deadline = Date.now() + timeout;
const pause = () => new Promise((r) => setTimeout(r, Math.max(0, Math.min(20000, deadline - Date.now()))));
let run;
while (Date.now() < deadline) {
  const runs = json('run', 'list', '--workflow', 'verify.yml', '--branch', pr.headRefName, '--event', 'workflow_dispatch', '--limit', '30', '--json', 'databaseId,headSha,status,conclusion');
  run = runs.find((r) => !previousRuns.has(r.databaseId) && r.headSha === pr.headRefOid);
  if (run?.status === 'completed') break;
  await pause();
}
if (run?.status !== 'completed' || run.conclusion !== 'success') throw new Error('Verification did not pass; public disclosure PR remains open');
while (true) {
  const checks = json('api', `repos/${repo}/commits/${pr.headRefOid}/check-runs`, '--paginate', '--slurp').flatMap((p) => p.check_runs);
  if (checks.some((c) => c.status === 'completed' && !['success', 'neutral', 'skipped'].includes(c.conclusion))) throw new Error('Another check failed; public disclosure PR remains open');
  if (checks.every((c) => c.status === 'completed')) break;
  if (Date.now() >= deadline) throw new Error('Another check is still pending; next scheduled run will retry the public disclosure PR');
  await pause();
}
const pages = (path) => json('api', path, '--paginate', '--slurp').flat();
const reviews = pages(`repos/${repo}/pulls/${number}/reviews`);
const inline = pages(`repos/${repo}/pulls/${number}/comments`);
const comments = pages(`repos/${repo}/issues/${number}/comments`);
const informational = (comment) =>
  (comment.user?.login === 'cloudflare-workers-and-pages[bot]' && comment.body.startsWith('## Deploying with')) ||
  (comment.user?.login === 'chatgpt-codex-connector[bot]' && comment.body.startsWith('You have reached your Codex usage limits for code reviews.'));
if (reviews.some((r) => ['CHANGES_REQUESTED', 'COMMENTED'].includes(r.state)) || inline.length || comments.some((c) => !informational(c))) {
  console.log('Review feedback is present; leaving the public disclosure PR open for review.');
  process.exit(0);
}
// GitHub enforces branch protection. No --admin and no bypass of required review/check gates.
gh('pr', 'merge', String(number), '--squash', '--match-head-commit', pr.headRefOid);
console.log(`Merged public disclosure PR #${number} after Verify run ${run.databaseId}. Informational deployment/review-quota notices are not review approvals.`);

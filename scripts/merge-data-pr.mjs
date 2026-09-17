// Runs trusted main-branch code only; never checks out or executes PR contents.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_REPOSITORY, dataPath } from './data-pr.mjs';
const reviewer = login => /^chatgpt-codex-connector(?:\[bot\])?$/.test(login || '');
// Anyone GitHub already lets merge this by hand. The gate must not be stricter than that, and it
// must not be looser: the PR's own author cannot stand in for its reviewer.
const writer = association => ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association);
export function dataReviewDecision({ pr, files, checks, runs, reviews, inline, comments }) {
  if (pr.state !== 'OPEN' || pr.isCrossRepository || pr.baseRefName !== 'main' ||
      pr.headRepository?.nameWithOwner !== DATA_REPOSITORY ||
      !/^codex\/data-\d+-\d+(?:-news-\d+)?$/.test(pr.headRefName || '') ||
      files.length !== pr.changedFiles || !files.length || files.some(f => !dataPath(f.filename))) return 'scope';
  if (pr.mergeable !== 'MERGEABLE' || pr.isDraft) return 'merge-gate';
  // TWO VERIFY RUNS SHARE EVERY CAPTURE COMMIT, AND ONLY ONE OF THEM RAN. A PR opened with the
  // Actions token gets a `pull_request` run that GitHub creates and never executes — it sits at
  // `action_required`, awaiting an approval nobody gives — beside the dispatched run that did the
  // work (see openPreparedDataPr). Both carry the head SHA, and the never-run one usually has the
  // higher id, so "the newest run for this commit" picked a run that measured nothing and every
  // capture read as unverified. Measured on 17 September 2026: 483 open capture PRs, three green
  // jobs on each, and this gate answering `verification` to all of them — including one a person
  // had approved. A run that never executed is not evidence either way; only runs that ran count,
  // and the newest of those decides, so an executed failure still blocks.
  const executed = runs.filter(r => r.headSha === pr.headRefOid && !['action_required', 'skipped'].includes(r.conclusion));
  const current = executed.sort((a, b) => b.databaseId - a.databaseId)[0];
  if (!current || current.status !== 'completed' || current.conclusion !== 'success') return 'verification';
  const latest = new Map();
  for (const check of checks.slice().sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))) latest.set(check.name, check);
  for (const name of ['contracts', 'browser', 'portfolio-research']) if (latest.get(name)?.conclusion !== 'success') return 'verification';
  if ([...latest.values()].some(c => c.status !== 'completed' || !['success', 'neutral', 'skipped'].includes(c.conclusion))) return 'checks';
  const completed = comments.some(c => reviewer(c.user?.login) && c.body.includes('codex-pull-request-review-summary') &&
    c.body.includes('Completed') && c.body.includes(`\`${pr.headRefOid.slice(0, 7)}\``));
  // A PERSON'S OWN APPROVAL IS A REVIEW. The Codex connector is the reviewer this repository asks
  // for first, and where it cannot answer — it says so itself, in those words — a review from
  // somebody who could merge this by hand is the same evidence a human reviewer has always been.
  // It is bound to THIS head commit, exactly as the Codex summary is: an approval of an earlier
  // capture is not an approval of this one, and these branches are one capture each.
  //
  // Measured on 10 September 2026: the connector answers a PR raised by a PERSON, and answers every
  // one of these with "To use Codex here, create a Codex account and connect to github" — because
  // the author is `github-actions[bot]`, which has no Codex account to connect. So this is not a
  // wait that a quota reset or a busy day ends; nothing about a capture PR will ever satisfy it.
  const approved = reviews.some(r => r.state === 'APPROVED' && r.commit_id === pr.headRefOid &&
    writer(r.author_association) && r.user?.login !== pr.author?.login);
  // "Has not answered yet" and "cannot answer here" are different states, and only the second is a
  // stop: a spent quota is answered tomorrow, an unreviewable author never is. Neither state
  // merges, but the run must be able to say which one it is, or the whole dashboard's data quietly
  // stops advancing with nothing on the repository saying why.
  if (!completed && !approved) {
    // SILENCE IS THE SAME ANSWER AS THE NOTICE. This branch is reached only once Verify has run
    // to completion — twenty minutes and more after the review was requested — and the connector
    // answers a PR it will review within a couple of minutes. Measured on 17 September 2026: 483
    // capture PRs over four days and not one comment from it on any of them, while the same app
    // answered every person-authored PR with its quota notice. A reviewer that has said nothing
    // by then is not one that has not answered yet; the run has to say so, or the data stops
    // advancing with every gate quietly reading "pending".
    const heard = comments.filter(c => reviewer(c.user?.login));
    return !heard.length || heard.some(c => /to use codex here/i.test(c.body)) ? 'review-unavailable' : 'review-pending-or-unavailable';
  }
  if (inline.length || reviews.some(r => ['CHANGES_REQUESTED', 'COMMENTED'].includes(r.state))) return 'review-feedback';
  // An app saying it cannot review here is not review feedback to address; it is the reason a
  // person's approval is standing in for it.
  const informational = c => reviewer(c.user?.login) && (c.body.includes('codex-pull-request-review-summary') ||
      c.body.startsWith('You have reached your Codex usage limits') || /to use codex here/i.test(c.body)) ||
    /^cloudflare-workers-and-pages(?:\[bot\])?$/.test(c.user?.login || '') && c.body.startsWith('## Deploying with') ||
    c.user?.login === pr.author?.login && c.body.startsWith('<!-- glow-data-review -->');
  if (comments.some(c => !informational(c))) return 'review-feedback';
  return 'ready';
}
// GITHUB COMPUTES MERGEABILITY LAZILY, AND "NOT YET" IS NOT "CONFLICTING". The first read of a
// PR nobody has looked at answers `UNKNOWN` and starts the computation in the background; a read
// a few seconds later answers MERGEABLE or CONFLICTING. Measured on 17 September 2026: two freshly
// green capture PRs read UNKNOWN on the first look and MERGEABLE on the second — and this gate,
// which runs once per event and is not re-triggered by GitHub finishing the computation, had
// answered `merge-gate` to both. On the approval path that is a person's approval silently doing
// nothing. Ask again, briefly, before concluding; a real conflict answers CONFLICTING at once.
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function resolveMergeability(read, { attempts = 6, waitMs = 5000, sleep = sleepSync } = {}) {
  let pr = read();
  for (let i = 1; i < attempts && pr.mergeable === 'UNKNOWN'; i++) { sleep(waitMs); pr = read(); }
  return pr;
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
  const pr = resolveMergeability(() => json('pr', 'view', String(number), '--repo', DATA_REPOSITORY, '--json',
    'state,isDraft,isCrossRepository,headRefName,headRefOid,headRepository,baseRefName,changedFiles,mergeable,author'));
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
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const decision = mergeDataPr(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')));
  console.log(decision);
  // Only the state that will never resolve on its own is annotated; a PR still waiting for CI or
  // for the reviewer is ordinary and stays quiet.
  if (decision === 'review-unavailable') console.log('::warning::The Codex reviewer cannot review this pull request, so this captured data waits for a review that will not arrive on its own. ' +
    'Approve the pull request and it merges. Until somebody does, the published dashboard stops advancing.');
}

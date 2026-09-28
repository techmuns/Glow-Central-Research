# BSE collection and recovery

The 28 September 2026 investigation found HTTP 403 from both BSE endpoints in the
scheduled collection environment. The unchanged adapter read the directory and
complete announcement results locally. This indicates an environment-dependent
access failure; the exact BSE rejection rule is unconfirmed. Retrying a denied
request or using a cached company directory does not repair announcement access.

## Qualify the collection host

Use an always-on host with a stable network connection permitted to access BSE;
obtain source approval or allowlisting where required. Verify access before
switching collection. Changing runner labels alone is not proof of a remedy.

On the proposed host, in a checkout of the merged repository:

```sh
node scripts/check-bse-access.mjs
```

This read-only check validates the complete company directory against retained
identities, all ten configured categories for yesterday in India, and a full year
of Kalpataru (522287) filings across at least two pages. It requires actual records
and consistent counts and rejects access denial, wrong issuer/category/date,
duplicates and truncation. It writes no captures and dispatches no workflows.
`BSE_PROBE_TO=YYYY-MM-DD` selects another completed day with known filings;
`BSE_PROBE_SCRIP=NNNNNN` selects another directory-verified issuer with more than
50 filings during the preceding year. Save the output with the host identity and
repeat it at another time before relying on the connection.

The host must support the existing Linux jobs: Node 22, Git, npm, Chrome available
as `google-chrome`, and GitHub Actions checkout/setup-node/artifact actions. The
company-history collector shares a job with Screener trade capture, so its Chrome
and authenticated Screener access must also work. Keeping that combined job avoids
introducing a second writer racing on its capture files. A single runner serializes
both jobs; provision enough capacity for the existing cadence.

GitHub documents [runner networking](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#ip-addresses)
and [runner security](https://docs.github.com/en/actions/reference/security/secure-use).
This repository is public. Do not attach a persistent self-hosted machine to it:
untrusted pull-request workflows can compromise that machine. Use managed ephemeral
runners with a fixed permitted outbound connection and appropriate access isolation;
confirm the owner's hosting plan supports this before activation. Runner registration requires
the repository owner's/admin access; the current coding connection is not an admin.

## Activate the verified host

After the owner approves the specific host and production switch, set the repository
Actions variable `BSE_COLLECTION_RUNNER` to its unique runner label. Both
`announcements-refresh.yml` and `insider-trades-refresh.yml` use this one setting.
With the variable unset they retain `ubuntu-latest`. The code change neither
registers a host nor switches production routing on its own. CI continues on
GitHub-hosted runners. Do not select an arbitrary replacement runner as a supposed
fix without the qualification above.

The existing schedules and publication pipeline remain responsible for collection.
The exchange capture automatically resumes two days before its last complete date
(21 September for the observed 23 September watermark), preserving the monthly
archive. Company capture retains its own coverage ranges and retry state. Its
existing backoff can delay a failed company for up to 24 hours. Let the next due
scheduled attempt run, or obtain exact authorization for a targeted production
retry; never clear history, errors or watermarks to manufacture a green result.

## Changing page totals

Both collectors now restart a walk when BSE changes its declared total mid-read.
There are at most three attempts, separated by one second. The exchange walk
restarts only the affected category; company history restarts only that issuer.
Only the successful attempt's rows are returned, and request counts include failed
attempts. HTTP 403, invalid data, duplicate records, wrong filters and exhausted
pagination still fail. The original strict adapter and its checks remain intact.
If the count keeps changing, no completeness watermark advances. Retaining partial
exchange windows independently is not implemented by this change.

## Verify recovery

After an authorized switch, inspect normal scheduled runs on the selected host.
Require successful directory and announcement reads, complete declared counts,
published archive/head updates, and BSE company successes as their retries become
due. Check a known missing filing in the deployed reader, retaining its source
date and exchange document link. Verify another scheduled run without an open
dashboard. CI or a local probe alone cannot establish production recovery.

Until those checks pass, keep the BSE outage visible. The existing NSE fallback can
supply overlapping disclosures but does not prove BSE coverage. Configured-category
success also does not independently prove BSE has added no new categories.

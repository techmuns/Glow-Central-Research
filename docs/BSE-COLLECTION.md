# BSE collection and recovery

The 28 September 2026 investigation found HTTP 403 from both BSE endpoints in the
scheduled collection environment. The unchanged adapter read the directory and
complete announcement results locally. This indicates an environment-dependent
access failure, not proof that GitHub's network is banned. A public BSE client
reported the same failure beginning on 23 September and restored server access
with a current browser User-Agent and `Sec-Fetch-Site: same-site` on 24 September
([request-header fix](https://github.com/BennyThadikaran/BseIndiaApi/commit/14e1661ae818ac56ad806e48c7c78eb82162ed39),
[incident and confirmation](https://github.com/BennyThadikaran/BseIndiaApi/issues/17)).
The shared request profile now includes those headers and BSE's website origin.
The directory and both announcement collectors use that same profile.

## Keep collection on free GitHub Actions

This repository is public. Its standard `ubuntu-latest` runner minutes are
[free](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Keep `BSE_COLLECTION_RUNNER` unset. No replacement server, paid runner, proxy,
subscription or API key is needed to test the corrected public request profile.
The separate access-check workflow creates no artifacts or caches and only reads
public data; it cannot publish captures, change retry state or dispatch collection.

`BSE read-only access check` compares the previous and current request profiles on
the same standard runner. A failed previous profile is recorded; the job passes
only when the current profile validates every requested result. Run it from a
pull request changing the BSE adapter/checks, or use its read-only manual dispatch.
A matching local command is:

```sh
node scripts/check-bse-request-profile.mjs
```

To check only the current profile:

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
50 filings during the preceding year. A successful probe proves access for those
requests at that time; verify normal scheduled collection before declaring recovery.

## Preserve automatic recovery

The existing schedules and publication pipeline remain responsible for collection.
The exchange capture automatically resumes two days before its last complete date
(21 September for the observed 23 September watermark), preserving the monthly
archive. Company capture retains its own coverage ranges and retry state. Its
existing backoff can delay a failed company for up to 24 hours. Let the next due
scheduled attempt run, or obtain exact authorization for a targeted production
retry; never clear history, errors or watermarks to manufacture a green result.

## Other free sources

- NSE's [official announcements RSS feed](https://www.nseindia.com/static/rss-feed)
  already feeds the dashboard and its retained daily archive. A GitHub Actions
  capture on 28 September successfully read 1,414 announcements. A later local
  read contained 2,395 items, including Kalpataru's order announcement. This is a
  rolling recent NSE window, not BSE-only coverage or an exhaustive history.
- Screener's public company page exposed Kalpataru's 28 September order notice
  without login, linking to its original BSE document. Its anonymous recent endpoint
  returned only five records. The search interface requests a free account. It is
  a candidate supplemental discovery source, not an integrated collector or proof
  that all historical announcements were checked. Keep publisher summaries separate
  from the original filing text and never advance BSE coverage from this short list.

Standard runner minutes being free does not make additional paid services or excess
artifact/cache storage free. Do not introduce those costs for this recovery. GitHub
schedules are best-effort: retain overlapping source windows and show stale or failed
checks instead of promising guaranteed real-time delivery.

## Changing page totals

Both collectors separate completed dates from today (India time), so new filings
cannot repeatedly invalidate a long historical walk. Within a category or issuer,
only the affected date window restarts when BSE changes its declared total mid-read.
There are at most three attempts per window, separated by one second. A successful
history window stays in memory while today's smaller walk retries.

The exchange collector retains fully validated pages if a later page fails, along
with successful categories. A partial window has no claimed declared total and is
listed under `failedWindows`. The existing reader receives a named `BSE collection`
failure, so these useful rows remain visible with incomplete-source status. Only
contiguous, fully checked windows advance `lastCompleteTo`; a good live day cannot
jump over a historical gap. A partial snapshot cannot use its requested end date
as a completeness watermark. The existing health gate runs after publication and
keeps the workflow red while any category/window remains incomplete.

Successful windows use only their final consistent attempt. Partial windows retain
distinct observations from validated pages of the bounded attempts. Counts are
summed across disjoint windows; request counts include failed attempts. Duplicate
NEWSIDs across windows still fail. Invalid rows are never exposed by the adapter's
page callback. HTTP 403 and malformed data are recorded without retry traffic;
zero captured rows still cannot replace a good snapshot. The strict adapter,
read-only qualification command and company-history collector continue to require
complete results. Company failures retain their existing records and retry state.

## Verify recovery

After the header fix is merged, inspect normal scheduled runs on GitHub Actions.
Require successful directory and announcement reads, complete declared counts,
published archive/head updates, and BSE company successes as their retries become
due. Check a known missing filing in the deployed reader, retaining its source
date and exchange document link. Verify another scheduled run without an open
dashboard. CI or a local probe alone cannot establish production recovery.

Until those checks pass, keep the BSE outage visible. The existing NSE fallback can
supply overlapping disclosures but does not prove BSE coverage. Configured-category
success also does not independently prove BSE has added no new categories.

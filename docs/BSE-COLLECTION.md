# BSE collection and recovery

## What BSE refuses (measured 1 October 2026)

`api.bseindia.com` sits behind an Akamai bot filter that answers with an HTML
"Access Denied" 403. It tightened twice in a week:

- **23 September 2026.** A public BSE client reported 403s and restored access with a
  current browser User-Agent and `Sec-Fetch-Site: same-site`
  ([request-header fix](https://github.com/BennyThadikaran/BseIndiaApi/commit/14e1661ae818ac56ad806e48c7c78eb82162ed39),
  [incident](https://github.com/BennyThadikaran/BseIndiaApi/issues/17)). This repository
  adopted those headers on 28 September; the read-only access check then passed on GitHub
  runners three times, the last at 04:24 UTC on 29 September.
- **29 September 2026, during the day (UTC).** The same check failed at 22:09 UTC with the
  unchanged profile, and every BSE read from GitHub has been refused since: announcements,
  the company directory, bulk/block deals and the shareholding index.

The 1 October investigation changed one header at a time, from a cloud host, with both
`curl` and Node's `fetch` (the collectors' client):

| Request change | curl | Node `fetch` |
|---|---|---|
| Full current-browser profile (`bseRequestHeaders()`) | accepted | accepted |
| Referer `https://www.bseindia.com/corporates/ann.html` | **refused** | **refused** |
| No Referer | redirected (301) | redirected (301) |
| No Accept-Language | refused | accepted (Node sends `*`) |
| No `sec-ch-ua` client hints | refused | accepted |
| Chrome 138 or older | refused | accepted |

The rule that broke collection is the Referer. `/corporates/ann.html` is the page BSE retired
when it rebuilt its site (it now redirects to `/corporates/ann`), so only scripts still send
it; the old profile with only the Referer changed was accepted, and the new profile with only
that Referer restored was refused. Under the site's referrer policy a browser on any BSE page
sends just the origin, `https://www.bseindia.com/`, to the API host, so that is the value now
sent — the faithful one, and the one a site rebuild cannot retire. The other rows show the
filter also scores how browser-like a request is, so the profile leaves it nothing to count:
it is what a current desktop Chrome sends from BSE's own page, with Accept-Language, client
hints and fetch metadata, and the Chrome version is **derived from the date** (one release
behind Chrome's four-week schedule) so it cannot age into the "old browser" range.

GitHub's network was never shown to be banned: the same runner type read every category on
the morning of 29 September, and the refusals follow the request, not the host.

One profile serves every BSE read — `bseRequestHeaders()` in `worker/bse-ann.mjs`, used by the
directory, the exchange-wide and company-history announcement walks, bulk/block deals and the
shareholding index (`exchangeRequestHeaders()` in `scripts/lib/exchange-deals.mjs`). Filing
documents on `www.bseindia.com` were accepted with either the old or the new headers. Offline
coverage: `node scripts/verify-bse-request-profile.mjs`.

## When BSE refuses again

No request profile is permanent: BSE can add a rule on any day, and did twice in one week.

1. Run the **BSE read-only access check** workflow (manual dispatch), or locally
   `node scripts/check-bse-request-profile.mjs`. Its first output is a diagnosis: the current
   profile, then the same profile with each header and each header group removed, the retired
   Referer and a Chrome a year old, one request each, with `required` naming what a refusal
   turns on. A redirect is never followed and a 200 challenge page is never read as access.
2. If one header or value explains it, change `bseRequestHeaders()` to what a current Chrome
   sends from BSE's own page, and let the check and the scheduled jobs confirm it.
3. If the current profile is refused and no single header explains it (`required: null`), the
   cause is outside the headers — cookies, network or a new policy. Do not rotate disguises
   to get past a deliberate block: fall back to the sources below and decide on licensed access.

Until direct reads succeed, the Screener and NSE recoveries keep filings arriving, and the
health checks keep the BSE gap visible.

## What "permanent" can mean

A public website's bot filter is BSE's to change, so direct collection is kept faithful to a
real browser, self-updating and quick to diagnose, never guaranteed. The independent recovery
sources below keep filings flowing during an outage. A contractual guarantee needs licensed
access to BSE's announcement data, directly or through a data vendor; that is a cost decision
for the owners, not a code change.

## Keep collection on free GitHub Actions

This repository is public. Its standard `ubuntu-latest` runner minutes are
[free](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Keep `BSE_COLLECTION_RUNNER` unset. No replacement server, paid runner, proxy,
subscription or API key is needed to test the corrected public request profile.
The separate access-check workflow creates no artifacts or caches and only reads
public data; it cannot publish captures, change retry state or dispatch collection.

`BSE read-only access check` first prints the one-header-at-a-time diagnosis above,
then compares the previous (29 September) and current request profiles on the same
standard runner. A failed previous profile is recorded; the job passes only when the
current profile validates every requested result. Run it from a pull request changing
the BSE adapter/checks, or use its read-only manual dispatch. A matching local command is:

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

A long outage leaves a backlog that one walk cannot finish inside the collection
step's 12-minute limit, and a stopped run writes nothing. On 1 October 2026 the
first Sattva run after the header fix read every page it asked for, but its
twelve-day backlog (21 September to 2 October) outlasted the step, so every later
run would have restarted the same walk. The collector now reads closed history in
windows of `ANN_CHUNK_DAYS` days (default 3), oldest first, and starts no new walk
once `ANN_BUDGET_MS` (default 8 minutes) is spent. It writes what it completed,
names each unread window as a `budget` failure (so the capture stays visibly
partial and the run stays red), and moves the watermark only past complete
windows. A window that would end exactly on the previous watermark also reads the
next day, so the days each run re-reads for late filings never use up a window
without progress. The next run resumes there, so any backlog shrinks on every run.
`verify-bse-collection.mjs` covers the split, the stop, the watermark and the resume.

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

## Independent announcement recovery (1 October 2026)

The 29 September Bharat Parenterals board outcome exposed two separate failures: the
exchange-wide BSE job stopped on a refused company-directory read before fetching filings,
and the successful Muns company response omitted that filing. A successful provider response
is not evidence that every exchange filing is present.

`scrape-bse-announcements.mjs` now continues announcement reads with saved verified company
identities when the directory fails. Unknown issuers retain their BSE code. Failed capture
attempts preserve existing rows and successful coverage timestamps while publishing the
failure. Only validated zero counts across all configured categories mean a quiet interval.

The existing two-hour announcements workflow independently runs
`scripts/collect-screener-announcements.mjs public/data`, using the existing Screener login
secrets in the runner. It reads **All announcements**, not the editorial Important view or
a portfolio watchlist. It retains original BSE/NSE document links and source timestamps;
Historical date headings use the publisher response clock; missing individual times remain
unknown. Notices without attachments retain a clearly labelled issuer or exchange reference instead of
a fabricated document link. Screener-generated summaries are excluded. Neither source failure prevents publication of
the other source's retained progress. The workflow remains failed when either source fails.

Recovery uses fixed timestamp windows and the publisher's same-timestamp pagination offset.
Records are archived before their cursor is saved; interrupted writes replay safely. Each
run prioritises new arrivals, then rotates through unfinished intervals. It overlaps two
hours and reconciles the past seven days daily for late additions. Initial coverage starts
seven days back or two days before BSE's older successful date watermark, whichever is
earlier. A 600-page / twelve-minute budget leaves explicit unfinished windows for later
runs; it never marks those windows complete. Pagination is paced at no more than one page every 2.5 seconds. Source refusals end the
run with their HTTP status recorded. A source Retry-After is respected; a rate limit without
one waits at least thirty minutes before the saved cursor is eligible again.

`public/data/screener-announcements.json` holds source check/error state, verified windows,
pending cursors and a seven-day recent head. Monthly `announcements-archive/` files retain
all recovered records without expiry. Large months use the existing content-addressed JSON
parts, verified before publication and reconstructed by readers with integrity checks;
recovery cannot grow one month beyond the hosting asset limit. The dashboard reads this head automatically and
uses the same company/date/type/search/export filters. Its source warning remains visible
while BSE is stale even when the backup is working. The independent filings-health workflow
also checks recovery freshness, failures and unfinished/gapped coverage. GitHub Actions
notification delivery depends on the operator's repository notification settings.

This is publisher-index coverage, not a certification of an exhaustive exchange archive.
Screener can also omit or delay a filing; notices added more than seven days late may require
a separate historical reconciliation. Exchange/category inventory and company identity
limitations remain explicit. No system can guarantee source availability or completeness.

Validation: `verify-announcement-recovery.mjs`, `verify-bse-collection.mjs`,
`verify-filings-health.mjs` and `verify-corporate-stream-ui.mjs` exercise interruption, ties,
late arrivals, refusal/cooldown, failed writes, retained history, identities, independent
health, source-failure display, exact-company recovery and returning-session upgrades.
The existing **Screener access check** workflow's `announcements_probe` mode reads the
29 September 10:40–11:10 UTC interval into runner temporary storage and verifies the reported
Bharat Parenterals PDF. Adding `announcements_probe_full` checks the entire recent recovery
window. A failed probe retains its public records and checkpoint as a three-day artifact;
`announcements_probe_resume` resumes that staging run without restarting history.
Both modes use temporary storage and do not publish data or change watchlists. Manual production
backfills, retries or deployments still need explicit authorization for that exact action.

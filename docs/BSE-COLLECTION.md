# BSE collection and independent announcement recovery

BSE collection separates closed historical dates from the live Indian calendar day.
Only an affected category/date or company/date walk restarts when the source changes
its declared page total. Each walk permits at most three attempts, one second apart;
access denials and malformed records are failures, not reasons for repeated requests.
The shared request headers follow BSE's website context (origin, referer, same-site).

The exchange collector preserves fully validated pages and successful categories
when another window fails. `failedWindows` names incomplete intervals; only a
contiguous sequence of complete windows advances `lastCompleteTo`. Successful,
validated zero counts represent a quiet interval. Failures retain saved rows and
successful timestamps and record the failed attempt. Monthly archives never expire.

Sattva's existing company-directory validation remains authoritative. A refused or
incomplete directory retains its verified timestamp, explicitly reports partial
identity coverage and keeps unknown issuers under their BSE code. It never prevents
source filings from being retained. Company-history reads still require a complete
walk and use their existing retry schedule and durable coverage ranges.

## Independent publisher index

The existing two-hour announcements workflow separately reads Screener's authenticated
**All announcements** index using the repository's existing Screener credentials.
This does not change a watchlist. Original filing titles, timestamps and BSE/NSE links
join the normal announcement stream; generated publisher summaries are excluded.
Notices without documents retain a labelled reference page, never a fabricated PDF.
Missing source times stay missing; date headings use the publisher response clock.

Recovery saves fixed timestamp windows and same-timestamp pagination offsets. It
archives records before committing the corresponding cursor, so interrupted writes
replay safely. New arrivals are prioritized before rotating unfinished windows.
Collection overlaps two hours and reconciles the past seven days daily. Initial
history begins seven days back or two days before BSE's older successful watermark.
A twelve-minute/600-page budget keeps unfinished intervals explicit for future runs.
Requests are at least 2.5 seconds apart. Refusals stop the run; Retry-After persists,
and a rate limit without that header waits at least thirty minutes.

`public/data/screener-announcements.json` holds an explicitly unavailable bootstrap
until actual capture, then source status, verified intervals, unfinished cursors and
a seven-day head. All recovered history is also stored in `announcements-archive/`.
Large months use verified, content-addressed JSON parts without dropping records.
Both readers and subsequent captures reconstruct all parts and reject corruption.

A failure in one collector does not discard the other's saved progress. Health checks
run after publication and report each source's failures, stale checks and historical
gaps independently. A working backup never certifies exhaustive BSE/NSE coverage.
The screen and export distinguish original documents from source reference pages.
Late omissions older than the seven-day reconciliation window can remain unavailable.

## Validation and operations

Local fixtures cover page drift, interruption, cursor ties, late additions, cooldowns,
failed writes, unknown issuers, archive integrity, source health and reader upgrades:
`verify-bse-collection.mjs`, `verify-announcement-recovery.mjs`,
`verify-announcement-directory-fallback.mjs`, `verify-filings-health.mjs` and
`verify-corporate-stream-ui.mjs`.

`check-bse-access.mjs` and the BSE read-only access-check workflow validate the public
directory, configured categories and multi-page company history. They write no
capture data and dispatch no production collection. Keep the standard runner unless
an explicitly selected alternative passes this qualification. A successful probe
establishes access at that time, not continuous production recovery.

After release, inspect the normal scheduled publications and actual source watermarks.
Do not clear checkpoints or label recovery complete based only on CI. Manual production
backfills, retries, resumptions, deployments or restarts need authorization for that
exact action. The existing schedule continues without an open dashboard.

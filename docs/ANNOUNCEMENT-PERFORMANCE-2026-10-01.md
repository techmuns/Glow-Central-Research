# Announcement rendering and dashboard audit — 1 October 2026

The announcement table already mounted only 40 rows. Its freezes came from repeated browser
preparation of the complete captured history, not thousands of DOM rows. The existing GitHub
Actions / Worker alert pool serves AI Alerts and All Alerts; the direct corporate filing reader
still combines BSE, company captures and NSE in the browser. This change adds no service or cost.

## Fix

- Announcement and insider row caches no longer depend on unrelated scope-picker object identities.
- NSE returns stable arrays for unchanged reading windows, with the IST cutoff in the cache key.
  Archive observation precedence, supplements and concurrent live corrections remain unchanged.
  Combining all archive arrivals into one reversed merge was rejected during review: an unresolved
  newer correction must keep the identity it inherited before an older observation arrives.
- Announcement projections, complete unions, sorting and publication comparison run in small
  batches. Shared downloads continue when a view closes; obsolete paints cannot write into the
  next tab. Concurrent archive publications are serialized, and input changes during preparation
  are rechecked before publishing.
- Preparation before painting is explicitly enabled for Corporate Announcements. News retains
  its existing publication lifecycle and keeps its filters mounted during partial source loads;
  its publisher browser suite verifies that shared rendering changes do not regress this behavior.
- Status-only company archive checks preserve array identity. Metadata reads reuse the prepared
  result instead of rebuilding it. All source checks, cadence and retention remain unchanged.
- The table's idle search work now warms the company search control's actual normalized index.
  Previously it built an unused plain-text index, leaving the first search to process all records.
- The service-worker release advances; an existing controlled-session test verifies automatic
  replacement of cached filing modules without clearing browser storage.

## Local evidence

Same-machine Chrome tests use captured data at base commit `2f5f2cc21` and block external APIs and
production writes. Times are lab observations, not production percentiles or coverage guarantees.

| Check | Before | After |
| --- | --- | --- |
| Return to announcements with 44,986 eligible rows | 3,513 ms; longest task 3,479 ms | 284 ms; longest task 245 ms |
| Fully settled stream, 160,414 eligible rows | Separate larger stress case | 426–467 ms return; longest task 404–446 ms; 40 mounted rows |
| First text search on the larger stream | 609–782 ms with the unused warmed index | 48–75 ms with the matching index warmed |
| NSE tab in the short sweep | 206 ms | 60 ms |

The large cold announcement visit took 2.3–3.1 seconds while captures populated progressively. Cold
data preparation is still work; slicing keeps input opportunities between batches. The default
All time view and all captured history remain available. Large global sorts took 0.35–0.47 seconds
in that stress test and are not claimed to be instantaneous.

The expanded iframe audit visits all 17 active tabs across 36 routes/views: alerts, bookmarks,
earnings, concalls, chatter, technicals, investors, IPOs, announcements/actions, NSE, insider trades,
news, mutual funds, macro, economy and both Family Book views. It verifies zero application
exceptions and exercises search, sorting, native wheel scrolling, deep/end scrolling, live row
replacement, resizing, offscreen search and complete/filtered export. Most tab visits were below
100 ms. In this static fallback audit, cold Universe News took 865 ms and All Alerts 4.8 seconds;
the latter used raw captures because the local fixture has no Worker alert-pool API. This does not
measure authenticated production delivery or certify freshness of upstream sources.

## Server-prepared Alerts delivery

Read-only production checks returned HTTP 504 after 25 seconds from `/api/alert-pool/index`.
The published pool build itself had succeeded. Running the same delivery code locally against
its actual GitHub artifact reproduced an incompatible storage request: `Range: bytes=-327701`
returned HTTP 200 for the complete 157,717,824-byte ZIP, which the bounded reader correctly refused.

GitHub's Azure blob host supports absolute offsets, as documented in Microsoft's
[range-header formats](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-the-range-header-for-blob-service-operations).
The reader now probes `bytes=0-0` to obtain the exact ZIP length and requests its tail using explicit
start/end offsets. It validates Content-Range, retains bounded reads, refuses full-body responses,
and keeps credentials confined to GitHub. No paid source, service or storage is added.

The corrected local handler read the actual artifact `11150145165` successfully (HTTP 200), using
405,397 storage bytes for the index lookup, without downloading the 158 MB archive. The native
Worker fixture now deliberately ignores suffix ranges like the real host and verifies absolute
ranges, directory reuse, unchanged decoded shard contents, immutable caches, 304s and failures.
Publication time, source-revision checks and fallback behavior stay intact; a readable pool is
not treated as proof that its sources are current or complete.

The production rollout exposed a second layer: Cloudflare's automatic fetch cache could return
valid 206 headers while taking roughly 15 seconds to deliver a 30-byte header near the end of
the archive. The index still hit its 25-second deadline. An isolated hosted preview reproduced
the delay: the same 30-byte read took 15,751 ms normally and 1,431 ms with `cache: 'no-store'`.
Bypassing that cache for storage range requests avoids its full-object fill; the separate
directory, index and member Cache API caches remain unchanged. Cloudflare documents this
[outgoing-request cache bypass](https://developers.cloudflare.com/workers/runtime-apis/fetch/).
The complete cold index path then succeeded in the hosted preview in 2,188–5,568 ms (GitHub metadata
was supplied by the fixture; the signed storage reads and decoding ran on Cloudflare).

The native Worker regression models a fetch cache that downloads the whole ZIP before returning
a valid 206 slice. It failed with four full downloads before the bypass and verifies zero full
downloads after the fix, alongside the existing member-cache and conditional-read assertions.

After deployment, read-only API verification returned the index in 6,253 ms and the current-day
shard in 3,588 ms, both cache misses. Conditional repeats returned 304 in 58–63 ms, and all five
pooled feed revisions matched the capture registry at that check.

The final browser check exposed a separate startup handoff: the statement book can change
`bookName` or `legalName` while preserving ticker, display name, ISIN and sector. Alerts correctly
abandons the obsolete news-matching context, but the portfolio's change signal omitted those
two fields. No replacement read started, leaving the five prepared feeds marked as reading.
All Alerts now compares its complete requested context on portfolio notifications, including
before a first report exists. The shared membership signal stays unchanged so unrelated tabs
do not remount for a name-only handoff. Prices, holding weights and check-only changes still
do not invalidate Alerts. An isolated browser using read-only live requests confirmed that
restarting the changed context adopts the prepared feeds.

The regression holds the index response, performs this same-name/ticker book handoff, and
verifies that the replacement consumes the prepared shard without fetching raw captures.
It also verifies that quote/status updates leave the existing controls mounted.

## Data integrity

An independent comparison against the previous implementation merged all 707 company archive
files (146,280 rows). Every serialized field and row position matched, with SHA-256
`0f50dcddcbb67350a907265b570aae47ceb88daf3fc3598d7432fcf60b034194`.
The three monthly BSE archives also matched exactly (204 rows).

`verify-announcement-preparation.mjs` compares synchronous and sliced output on 24,000 records,
including repeated unlinked notices, revisions, provenance and older history; it also checks
concurrent arrivals, scope-cache reuse, retained records after an empty response and prepared
search normalization. NSE tests cover quiet IST midnight rollover, same-count corrections,
equal-observation archive precedence and overlapping live/history loads.

The corporate browser suite covers automatic arrivals while reading, source failures, scope
isolation, company selection, same-count archive corrections, missing attachments, original
links, dates, filtered exports, mobile layout, hidden-tab polling and existing-session upgrades.
The shared ownership suite checks that hidden views do not retain rendering jobs.

No collection frequency, backfill, retention, source, identity rule or source-health label is
reduced to achieve these timings. No manual production run, restart or deployment is involved.

## Cold startup and announcement delivery follow-up

A fresh production All Alerts / Universe visit displayed its first rows in 2,078 ms. The previously
reported 23–26 seconds describes all background feeds settling, not a blank screen for that duration.
Some independent feeds can still take longer to finish checking.

The pool reader now starts artifact discovery, source-revision checks and device checks together.
It still verifies all three before adopting a prepared feed. The Worker reads each stored member's
local ZIP header and payload in one bounded range request, saving one serial storage round trip on
an uncached member. A large ZIP extra field uses the validated two-request fallback. Size limits,
Content-Range checks, gzip delivery, immutable member caching and full-body refusal are preserved.

The backup announcement head is now an explicit dependency of the announcement pool. A changed
backup capture makes only that feed use its current capture until the next ordinary pool build.
Capture revisions also include collection attempts, successful/page checks and recovery progress,
so a new failed check cannot keep the previous status merely because last-good rows did not change.
The capture-status edge cache and dashboard service-worker release both advance.

Before publication, a separate check compares the backup head with the collected announcement
events. It recognizes original documents among all merged source links and BSE's alternate URLs
for the same PDF. Notices without a document must retain their own company/date/time/title/reference
identity. A missing notice fails the build. The existing member verifier then checks that the
written shards preserve the collected events exactly; no browser-side audit work is added.

At base commit `8cc6f8510`, all 16,560 captured backup notices were represented in the prepared
daily feed, including 124 explicitly unavailable attachments. The independent recovery run
`36872738558` completed 34 pages with no pending intervals at 14:01 UTC on 1 October. Direct BSE
date-index requests still returned HTTP 403. These results establish delivery of the captured
backup records, not exhaustive exchange coverage. BSE failures and missing documents remain
visible; the existing free source, collection cadence and reconciliation history are unchanged.

Regressions cover newer backup arrivals, failed attempts with unchanged last-good data, concurrent
index/status reads, bounded one-request member delivery, large extra fields, incorrect local
filenames, merged source links, missing reference-only notices and a returning controlled browser
receiving the new backup dependency from its previously immutable module cache.

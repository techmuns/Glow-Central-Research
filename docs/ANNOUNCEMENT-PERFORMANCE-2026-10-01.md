# Announcement rendering and dashboard audit — 1 October 2026

The announcement table already mounted only 40 rows. Its freezes came from repeated browser
preparation of the complete captured history, not thousands of DOM rows. The existing GitHub
Actions / Worker alert pool serves AI Alerts and All Alerts; the direct corporate filing reader
still combines BSE, company captures and NSE in the browser. This change adds no service or cost.

## Fix

- Announcement and insider row caches no longer depend on unrelated scope-picker object identities.
- NSE returns stable arrays for unchanged reading windows, with the IST cutoff in the cache key.
  Archive responses combine once per batch; observation precedence, supplements and concurrent
  live corrections are preserved.
- Announcement projections, complete unions, sorting and publication comparison run in small
  batches. Shared downloads continue when a view closes; obsolete paints cannot write into the
  next tab. Concurrent archive publications are serialized, and input changes during preparation
  are rechecked before publishing.
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
| Fully settled stream, 160,414 eligible rows | Separate larger stress case | 426 ms return; longest task 404 ms; 40 mounted rows |
| First text search on the larger stream | 609–782 ms with the unused warmed index | 48–55 ms with the matching index warmed |
| NSE tab in the short sweep | 206 ms | 60 ms |

The large cold announcement visit took 2.3 seconds while captures populated progressively. Cold
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

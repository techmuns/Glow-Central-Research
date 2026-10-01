# All Alerts on an empty new day — 2 October 2026

After 18:30 UTC (midnight in India) All Alerts opened slowly, and the Verify browser job failed on
every pull request opened in that window: `daily-alerts?scope=universe` reached its first paint at
26.3 seconds on CI with a 4,850 ms main-thread task (run 36910782499), against an 1,800 ms budget.

## What actually changed at midnight

Nothing in the reading path switched at midnight. The bounded Today read was always the expensive
part; the new day made it visible.

- **Before midnight** Today already has rows from the exchange feeds, so the table paints them in
  about a second while the rest of the collection carries on behind it. Measured locally on the
  shipped captures at 22:40 IST: first paint 0.8–1.5 s, every source settled at 11–13 s.
- **After midnight** nothing captured is dated Today yet, and the table keeps its placeholders until
  every pending read completes (the reading contract in `CLAUDE.md`). The reader then waits for the
  whole live collection, and the performance suite, which measures long tasks until shortly after
  the first paint, counts every task in it.
- **In production** the precomputed pool normally answers Today. A pool built for another day is
  not used (`alert-pool.js`), so from midnight until the first pool build of the new IST day every
  reader takes the live path.

## Where the live collection spent its time

Profiled on the shipped captures with the page clock pinned after IST midnight:

1. **The company-news companion index was built three or four times per open.** The bounded reader
   unions every retained story's identities across the head, every archive month and the publisher
   rows (about 350,000 rows and 30 MB of compact indexes) to find date-correction companions. Each
   reader operation rebuilt it — the seed, the refresh immediately after it, the second collection a
   book update starts — and the News tab's reader of the same day built its own.
2. **Every publisher announcement re-read every retained story in every news reader.** The market
   archive arrived one month per call, each month was an announcement, and each made every
   publisher join warm and rebuild itself, uncoalesced, through `includes`, which parsed each
   story's URL and hashed its identities twice.
3. **BSE announcements were reported failed on every refreshing collection.**
   `withAnnouncementLookups().refreshSnapshot()` resolved to nothing, so `refreshFilings` threw
   reading `.available`. The failure path then read the feed without warming it, which classified
   every retained filing in one task: 2.2 seconds at 4x CPU throttle. That is the task CI measured.
4. Smaller synchronous steps: the recovery-capture merge, the announcement merge before `meta()`,
   and news joins read by a partial assembly or a market-news warm-up before they were prepared.

## Fix

- `news-working-set.js` builds the companion index once per set of inputs and shares it. The key is
  the reading window, every capture's content digest and the publisher rows' readings. An unchanged
  refresh and a second reader of the same day adopt the finished index. A changed capture, publisher
  row or window builds a new one. Readers waiting on a build share it; it is cancelled only when no
  reader waits, and kept only while one holds it. Per-row query readings are memoised on the row.
- `portfolio-publisher-news.js` memoises each story's match per identity list and runs one warm-up
  at a time, folding announcements that arrive meanwhile into one more.
- `market-news.js` adds `loadRemaining()` for the two readers that walk the whole archive. It
  fetches the months a few at a time, applies them in manifest order, stops at the first unreadable
  month as the one-month walk does, merges once and announces once.
- `announcements-extra.js` returns the capture's own refresh result and merges the recovery capture
  in slices. `daily-alerts.js` prepares announcement merges and news joins in slices before
  synchronous reads, re-warms announcements if their merge moved during the warm-up, and warms a
  feed's retained rows on the failure path too.

Nothing collected, retained, ordered or shown changes. Today still shows exactly the rows dated
today, older history stays behind the period choices, and the status of a feed whose capture really
is incomplete is still reported. The BSE feed now reports its real state rather than a TypeError.

## Measured

Local Chrome on the shipped captures, external APIs blocked, page clock pinned ten minutes after IST
midnight. These are lab figures, not production percentiles.

| Check | main | this change |
| --- | --- | --- |
| All Alerts opened from News, every source settled | 9.7–10.1 s; longest task 500–520 ms | 6.2–6.7 s; longest task 76–170 ms |
| Same, 4x CPU throttle | 38.6 s; longest task 2,210 ms | 26.4 s; longest task 314 ms |
| All Alerts as the first page (the new test) | 9.7–15.5 s; longest task 437–647 ms; all 65 news index parts read more than once | 7.0 s; longest task 81–93 ms; each part read once |
| Company-news and TradingView requests per open | 340 (92 MB) | 210 (64 MB) |
| Full sweep, All Alerts route (real clock) | 10.5 s; 502 ms | 4.9 s; 279 ms |
| Full sweep, AI Alerts / Bookmarks after it | 1,345 ms / 2,189 ms longest task | 0 / 65 ms |

## Not yet as fast as before midnight

On an empty day the reader still waits for the whole live collection: about 7 seconds locally, against
about one second to the first rows before midnight. The live path reads every feed's complete
retained history whatever the window, and the placeholder contract holds the table until the last
source answers. Closing the gap needs one of these, each a product decision:

- **A pool for the new IST day promptly after midnight.** The pool is the fast path; today it is
  rebuilt after captures and on a best-effort half-hourly schedule.
- **A different empty-day presentation** while sources are still being read.
- **A window-aware live collection** that reads and classifies only what the window and its
  companions need.

## Tests

- `scripts/verify-tab-performance-ui.mjs` opens All Alerts with the page clock pinned ten minutes
  after the next IST midnight, in UTC as the runners are. It measures every long task through the
  last source, not just the first paint, against the same 1,800 ms budget. It also asserts that no
  retained news part is read twice, which fails on the old code on any machine.
- `scripts/verify-news-working-set.mjs` checks the shared index against an independently built one:
  same projections, no rebuild on refresh or for a second reader, a rebuild for another day, a
  changed capture or an index nobody holds. The existing 1/3/14/30-day full-history equivalence
  still passes.
- `scripts/verify-publisher-news-delivery.mjs` checks `loadRemaining()` against the month-by-month
  walk, including a story in two months and a failing month, with a single announcement.
- `scripts/verify-announcement-lookups.mjs` checks that the refresh result reaches the caller.

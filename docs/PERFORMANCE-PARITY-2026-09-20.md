# Glow performance parity audit — 20 September 2026

Glow already contained the major Sattva performance work when this audit began. Glow PRs
[#1060](https://github.com/techmuns/Glow-Central-Research/pull/1060) and
[#1255](https://github.com/techmuns/Glow-Central-Research/pull/1255) imported the shared code through
Sattva baseline `955324e5`. This audit compared Glow `3c15bfa26` with Sattva `4ef141d9d` and the
recent merged upstream PRs. It fixes remaining pool delivery/reuse issues without replacing
Glow's portfolio, newsletter, fund controls, AI trigger filters or captured history.

## What was already present

| Upstream work | Glow status at audit start |
| --- | --- |
| #172–#176: lazy feed loading, memoised keyword scans, request deduplication, snapshot-first investors, stream parsing, returning-reader upgrades | Present through #1060 |
| #178–#204: saved alert restoration, virtualised lists, bounded DOM, stable geometry/navigation, quieter rendering and faster Universe loading | Present through #1060, including subsequent correctness fixes |
| #217–#220: stable alert restoration, reused AI rankings/cards and bounded Earnings table ownership | Present; Glow's local extensions retained |
| #222: bounded news working sets, reduced retained memory, lossless public caches | Present through #1255 |
| #226: memoised per-row readings and prewarmed readers | Present through #1255 |
| #227: sliced alert assembly and AI ranking | Present through #1255 |
| #228 and #230: GitHub-runner alert pool, compressed shards, byte-range artifact delivery and correct treatment of old device entries | Present through #1255; builds and the production index were readable during this audit |
| #231: easier scrollbar dragging | Glow already has its own 14 px table tracks and minimum thumb lengths; preserve those changes |
| #232, #234, #235: newsletter/filing detail and AI card presentation | These are subsequent presentation changes, not missing performance infrastructure. Glow's own newsletter and card design remain |

The automatically prepared draft sync #1260 contained unresolved conflicts and upstream-only data
files. It is not needed to obtain the performance infrastructure above and is not merged by this
audit. No new upstream ancestry is claimed by these focused fixes.

## How much runs off the browser

GitHub Actions normalises and classifies technicals, announcements, insider trades, company news
and market news into one derived alert-pool artifact. All Alerts requests only the selected days;
AI Alerts requests compact evidence shards. Cloudflare serves each compressed member by byte range.

The browser still handles current portfolio/watchlist attribution, filters, sorting, AI ranking
and rendering. Ranking is sliced and reused; private holdings stay in their existing reader.
All history, undated records, newer/unverified captures and live-route feeds retain their own
source paths. This is substantial shared precomputation, not a claim of zero frontend work.

## Gaps fixed

1. **Unchanged builds repeated download/decoding.** Each upload changes the artifact URL. The reader
   previously threw away all decoded shards on every new artifact despite the builder already
   publishing content hashes. It now retains identical contract/member/hash entries, checks the
   new capture revisions and source health, and downloads changed shards only. This reuse is within
   an open session. On reload, HTTP caching still depends on the artifact URL. Invalid or absent
   hashes use the existing artifact-local path; memory remains bounded to the current reads.
2. **Cancellation disabled the shortcut.** Leaving a view while its shard queue was active entered
   the same one-minute backoff as an actual failed download. Abandoned/superseded reads now stop
   without that penalty. Real errors still back off, and older work cannot overwrite newer results.
3. **Cold exchange cache forced raw history processing.** Production capture status reported
   `exchangeDeals: not-cached` even while a pool had the scheduled exchange artifact. Cold status
   now verifies the same trusted artifact metadata selected by delivery, without downloading the
   archive. Warm status still describes the actually served cache, including a retained fallback.
   Failure to verify never becomes a successful source check.
4. **Older discovery context was omitted.** The exact-card comparison failed on unchanged main for
   ICICIBANK: a 5 September market-wide story left the 14-day trigger window by 20 September, but
   still belonged in company context after attribution. The pool filtered it before attribution.
   Contract v2 keeps market-wide stories across the bounded context horizon, preserving their full
   discovery records. Attribution and priority rules are unchanged. Older contracts are declined.
5. **Code-only upgrades could wait for a capture/schedule.** Relevant code and builder changes now
   trigger the existing pool build after merging to main. Contract-specific edge keys avoid serving
   an earlier format from cache during the upgrade; the normal source fallback bridges the gap.

## Evidence and limits

All measurements below use this checkout's captures or explicit local fixtures. They are not
production latency guarantees and do not establish complete upstream source coverage.

- The original real-data exact-pool test reproduced the ICICIBANK context mismatch in a separate
  copy of unchanged main. After the correction, all **204 Universe cards and 99 Portfolio cards**
  match the full-history rankings, including every compared score, evidence field and context.
- Today, Last 3/7/30 days match the full-history reference: **270 / 13,198 / 47,172 / 145,435 events**,
  respectively. Counts, ordering, provenance, source health and both scopes are compared.
- The local browser reads Today from one approximately **88 KiB compressed day shard**, with no
  raw pooled capture downloaded, and paints the same rows and totals as the fallback. The browser
  ranking matches too. An unchanged subsequent artifact reuses **37 AI shards with zero shard
  requests**, while capture status is still checked. A seven-shard fixture with one changed member
  makes **one request instead of seven** and exposes the corrected rows.
- The native Worker test verifies cold exchange identity with **two metadata requests and no archive
  download**, warm-cache reuse, honest failure, gzip delivery, byte-range pool reads and 304s.
- The existing-session test starts with an older service-worker/module cache and verifies that the
  open session receives the new alert-pool reader while retaining the selected theme.
- A 24-view local iframe sweep completed without application exceptions, covering full-data search,
  sort, offscreen export, native scrolling, variable row heights, live updates and disposal. The
  static fallback's slower cases remain visible: All Alerts settled in about 4.5 s in that sweep;
  the cold pool avoids its capture/classification work when revisions match.
- A separate local static-origin trace measured LCP **1.62 s**, CLS **0.00** and 36 ms of forced
  layout. Render-blocking resources had no estimated LCP saving. This is a fallback-path lab
  observation, not a production percentile or a before/after speed claim.

Read-only production inspection found successful recent pool builds and a readable index, but
some capture revisions had moved beyond that build. Company-news source status was already failed;
the pool correctly retained that status. The optimisation does not repair those upstream capture
failures or call stale inputs current. During the browser comparison, one fallback announcement
archive check was partial on the local origin; its source-chip comparison was explicitly skipped.
The exact offline contract suite compares the corresponding source fields without that skip.

Verification lives in `verify-alert-pool-cache.mjs`, `verify-alert-pool.mjs`,
`verify-alert-pool-ui.mjs`, `verify-alert-pool-worker.mjs`, `verify-exchange-deals.mjs`,
`verify-exchange-worker-runtime.mjs` and `verify-dashboard-performance-ui.mjs`, alongside the
existing Glow isolation, memory, workflow health and application-update checks. CI runs the full
repository Verify workflow before merge. No manual production run, restart or deployment is part
of this audit.

# Glow deployment and Sattva template sync

Audited on 9 September 2026; template baseline advanced on 16 September 2026 to
`techmuns/Sattva-Central-Research` commit `cf7eb444` — see *Sync of 16 September 2026* below.
The original audit baseline was `542081ef` (merged PR #160, with PR #159 calendar/checkpoint fixes).

## What is shared

The shared dashboard includes light/dark appearance, Bookmarks, streaming Ask Research,
portfolio-aware AI Alerts and All Alerts, scope/watchlist tools, archived publisher news,
Screener con-calls and operating insights, private summary reader, IPO and filing collectors,
continuous capture recovery, source connection/health reporting and service-worker upgrades.
All merged upstream source is included in Git history; subsequent syncs compare against that
history rather than replaying years of changes.

## What belongs to Glow

- Worker: `glow-central-research`; repository: `techmuns/Glow-Central-Research`.
- Research dispatch and authenticated Actions artifacts use Glow's repository and immutable
  repository ID `1339395437`. Durable Objects are local to this Worker. All shared edge-cache keys include a Glow deployment prefix. Rate-limit namespaces
  `1801` and `1802` are distinct from Sattva's `1701` and `1702`.
- Glow palette, wordmark, Family Book, My Managers, Mutual Funds and macro research remain.
  Glow PR #18’s Changes view retains its manager/investor audiences, eight periods and separate
  trade and holdings-comparison evidence. Glow PRs #20, #21, #22, #23, #25, #26 and #27 also remain: compact technicals,
  Indian-calendar short activity windows and shareable Bulk/Block period selection,
  shared technical/volume/proximity/trend filters, official NSE/BSE reports and artifact delivery, investor/manager coverage audits, verified
  associated-entity evidence, and retirement of the mock Earnings Surprise view.
  Unknown source cells remain unconfirmed; explicit non-disclosure can establish a disclosure
  disappearance but never proves a sale. Official reports retain venue, category, side and price
  through the template archive layer. Repeated reads reuse the unchanged combined history.
  Its public Sattva bulk/block fallback is intentionally retained when Glow’s four-category
  capture fails; it copies market deals only, with its own source date and failure status.
  This explicit fallback is excluded from mechanical repository-name substitutions.
- The portfolio producer is **techmuns/GlowVentures**, not Sattva-Family. Daily `series-refresh`
  checks out that private repository with `GLOWVENTURES_READ_TOKEN`, builds the statement book,
  checks it, and builds manager summaries. `family-book-sync` delegates to this same producer.
- The 9 September refresh reads GlowVentures revision `e3561b5`; the source's statement period
  remains **29 August 2026**. It contains 170 research equity companies, 166 NSE tickers and four
  uncovered/tickerless lines. All 170 have ISINs. Missing ISINs are filled only by exact ticker
  matches against the retained NSE equity/SME directory; conflicting identities fail the build.

`/api/family-portfolio` projects names and identifiers from this deployment's own assets.
The same-origin `/glow-bridge.html` reader rechecks the matching company list and statement
book for each question/weight refresh. It never connects to Sattva's authenticated iframe.
A changed or unavailable source cannot silently become a replacement portfolio. The newer
shared transport, validation, cancellation and scope propagation work with this Glow adapter.

A successful read proves that the currently deployed snapshot was read; **it does not make the
underlying statement current or establish today's broker ownership**. Statement dates remain
visible. Weights use the complete deduplicated **research equity statement book**, including
uncovered holdings, rather than total family NAV. Any missing or ambiguous mark disables all
weights. Null costs/P&L stay unknown, duplicate reports count once, and the ring-fenced promoter
holding remains outside consolidated totals. Family Book retains the original detailed book
and supplies its own dated research evidence. This does not change the pre-existing publication
of Glow's book assets; no new authenticated/private-archive access is claimed.

The filing index uses Glow's book for portfolio priority: 167 capture identities are resolved,
with three unresolved holdings explicitly named. Existing archived documents, check times and
watermarks remain unchanged. Upstream saved registrations are excluded; only Glow's own registry
can enroll additional capture companies. Building a new book also reconciles this metadata.

The legacy `sync-family-book.mjs` / `resolve-portfolio-companies.mjs` workbook fixture utilities
are retained for upstream regression tests. Their CLI cannot overwrite Glow's portfolio.
Use `build-book.mjs` / `check-book.mjs` / `build-managers.mjs` for Glow production data.

## Credentials and settings to add

### Glow setup on 10 September 2026

The operator has added `CLAUDE_KEY`, the Screener login secrets, and the Glow watchlist
variables: ID `10873837`, exact name `G Screen`. A live Ask Research request completed
successfully through Bedrock, and the authenticated Screener access check succeeded.
`SYNC_PUSH_TOKEN` was updated by the operator; its write permissions have not been
independently proven by this access check. Paid summaries and X remain deferred.

The manual **Screener access check** workflow checks access and plans membership changes
without changing the watchlist by default. For an explicitly authorized membership sync,
select `sync_watchlist: true` and repeat `10873837` in `watchlist_id`. The supplied ID must
match the configured deployment variable before the workflow can continue. It verifies the
watchlist name and both management/export views before importing or removing companies,
then reads them again to verify the result. A new empty watchlist has no export form;
the reader accepts this only when both views have no company rows and the expected
management controls are present. No watchlist is created or renamed.

The current statement supplies 168 candidates through its existing `listed` flag and two
other holdings excluded by that flag. The producer also marks unresolved ordinary equity
as `listed: true`, so eligibility is not independent proof of an exchange listing. Missing
imports are reported as a partial sync by count; an unsuccessful import does not establish
that a holding is unavailable at the provider.
Credentials and downloaded holdings stay in the runner; logs contain counts only.
This manual operation does not activate paid summaries, X, or a scheduled membership sync.

The [authorized initial sync](https://github.com/techmuns/Glow-Central-Research/actions/runs/34409208209)
imported and verified 167 companies against their exported ISINs, with no unrelated members.
One unresolved candidate was not matched by Screener's import or company search. All 170
dashboard holdings remain present and matched the live Glow portfolio by ISIN. This record
describes the 29 August statement snapshot, not present-day ownership or complete feed coverage.

### Original migration inventory (9 September 2026)

This inventory compares **secret names**, not encrypted values. Nothing was copied between
accounts, and no production secret or paid collector was activated during the code sync.

| Location | Name | Glow action |
| --- | --- | --- |
| Cloudflare Worker secret | `CLAUDE_KEY` | Add the Bedrock bearer key used for the configured Claude model if Glow should use the same research provider. Keep it server-side. `CLAUDE_API_KEY` is a legacy alias; do not add both. |
| GitHub Actions secrets | `SCREENER_USERNAME`, `SCREENER_PASSWORD` | Add the credentials for the intended Glow Screener account. Required for authenticated con-call/calendar, operating insights and paid summary collection. |
| GitHub Actions variables | `SCREENER_WATCHLIST_ID`, `SCREENER_WATCHLIST_NAME` | Configure an existing **Glow** watchlist by numeric URL ID and exact name. There is no Sattva watchlist fallback. |
| GitHub Actions variable and Worker setting | `SCREENER_SUMMARIES_ENABLED` | Set `true` in both only when enabling paid private summaries. The Worker accepts this as a secret or variable. |
| Cloudflare Worker secret | `SCREENER_SUMMARY_READER_EMAILS` | Set comma-separated allowed reader emails for private summaries. The reader's Munshot/Muns session is verified through the Muns profile API. |
| GitHub Actions secret | `X_COOKIES` or `X_ACCOUNTS` | Optional X capture authentication. The collector prefers `X_COOKIES` containing the intended account's own session. Otherwise, `X_ACCOUNTS` supplies one login as `username:password:email:email_password`; only the first configured account is used. These are credentials, not the monitored handles list. |
| GitHub Actions secret, already present | `SYNC_PUSH_TOKEN` | Correct its permissions: Glow **Contents, Workflows and Pull requests: read/write**. Current upstream-sync logs show PR creation denied. A PAT/App token is needed for pushed PRs to trigger verification workflows. |

Existing credentials to keep:

- Worker `MUNS_TOKEN`: existing Muns services and fallback research provider.
- Worker `GH_DISPATCH_TOKEN`: already installed; must target Glow with **Actions: read/write**.
  This audit did not dispatch a production run to test its value/scopes.
- Actions `GLOWVENTURES_READ_TOKEN`: read-only Contents access to **GlowVentures**, already used
  by the daily producer. It replaces Sattva's `FAMILY_HOLDINGS_TOKEN` / `FAMILY_REPO_TOKEN` needs.

Sattva's Actions `CLAUDE_API_KEY` is not consumed by a production workflow, so an Actions copy
is unnecessary. X capture can be opted out with the Actions variable `X_CAPTURE_ENABLED=false`.
Public Telegram
collection needs no secret; optional `TELEGRAM_CREDENTIALS` is absent from both audited repos.
The existing Cloudflare Git deployment integration does not require adding an Actions deploy key.

**Screener isolation matters:** Sattva uses watchlist `10850427`, named `S Screen`. Pointing a
Glow membership sync there would replace Sattva's selections. Use a separate Glow watchlist.
Paid summary accounting is per deployment while the provider's allowance is per account: two
enabled collectors sharing a paid login need a coordinated account budget. A dedicated Glow
account is the straightforward setup. Keep summaries disabled until that choice is resolved.
The watchlist reconciliation script remains an explicitly invoked operation, not an added
scheduled mutation.

Configure repository secrets/variables in
[Glow Actions settings](https://github.com/techmuns/Glow-Central-Research/settings/secrets/actions)
and Worker settings for `glow-central-research` in the Tech Cloudflare account. Never put
credentials in repository files, frontend assets, PR text or chat.

## Generated-data publication

Scheduled repository writers commit on `codex/data-*` branches and open PRs with an explicit
Verify dispatch and automated review request. Company-news publication still reconciles captured
records with the latest main in disposable worktrees, preserving competing records and source
health. It reports `review-pending` until the PR merges; a capture or PR is not deployed data.
The review controller reads trusted main-branch code, checks the exact proposed SHA and only
merges data-only PRs with successful verification and completed review without feedback.

A failed check, conflicting update, review finding or unavailable reviewer leaves the PR open.
Codex review quota was exhausted during this migration; future generated-data PRs need completed
review after availability returns, or a disclosed local review by an operator following the
repository workflow. A quota notice is never approval. Captures stay in their review branches
(and the company-news workflow's uploaded artifact) while publication is pending. Repository
Actions must permit PR creation; no extra publication PAT is required because CI is explicitly
dispatched with `GITHUB_TOKEN`.

## Sync of 16 September 2026

Template baseline advanced from `542081ef` to `cf7eb444` — the first sync since 9 September, and
79 upstream commits across 185 files. It is overwhelmingly performance and reliability work:
memoised alert assembly, a sharded repeat-visit alert cache, virtualised list geometry, bounded
Earnings ownership, a snapshot floor under the investor route, and the split of `failureFor` into
`failureFor` / `uncheckedFor`. Six decisions in it are Glow's and a later sync must not reverse
them by taking the template side again:

1. **`scripts/fixtures/family-book.json` stays Glow's retained copy.** It is Sattva's family book
   and is kept only so the template's resolver regression still runs. `worker/portfolio-resolver.mjs`
   is byte-identical on both sides, so the older input loses no coverage, while the template's newer
   book carries per-line tickers that change every `matchedBy` in Glow's own paired expectation
   fixture — which four research checks also read as their stand-in book.
2. **The investor card reports a gap, and the coverage audit reports both.** The template's
   `failureFor` split is adopted whole: the card shows a book or says none is published, and never
   an amber failure over holdings it is drawing. Glow's `js/investors/integrity.js` reads
   `failureFor(slug) || uncheckedFor(slug)`, because a retained book whose latest check failed is
   exactly what its "Refresh failed; last successful book retained" line exists to report.
3. **`verify-technical-filters-ui.mjs` and `verify-technical-filters-context.mjs` are two files.**
   The template's standalone check serves itself and CI invokes it; Glow's exported one runs inside
   `verify-glow-parity-ui.mjs`'s origin against the real book. Merging them drops the call.
4. **Deployment identity in `verify-*` scripts is hand-checked.** `adapt-glow-template.mjs` skips
   those files deliberately, so `verify-glow-parity.mjs` now scans `scripts/` for foreign repository
   names, Worker hosts and repository ids, with the four deliberate exceptions named in it.
5. **A settled loader makes a feed cacheable, not a successful one.** Glow's insider capture carries
   failed companies, so its loader legitimately rejects on every collection; gating the normalised
   feed cache on success alone left All Alerts re-sorting the whole retained pool on every scope
   change. See the note above `settledLoads` in `js/data/daily-alerts.js`.
6. **Ask Research keeps its stand-down, through ONE switch.** It was already off here, by hard-coded
   `opacity-30 select-none pointer-events-none` on `.research-layout` — invisible, unnamed and
   unrevivable. The template's flag now owns that decision alone: `isComingSoon()` in
   `js/tabs/ask-research.js`, with `enable_research=1` or `__ENABLE_RESEARCH__` turning the real tab
   on, which is how the checks that drive the live composer ask for it. What a reader sees is
   unchanged. Turning the tab back on for customers is a deployment decision, not a code change.
7. **The per-tab live-quote button is gone with the template's own change**, replaced by the Refresh
   registry over one collected `/api/breakouts` capture. Glow's filter check asserted that a price
   refresh named exactly the chip selection; there is no per-row request left to narrow, so it
   asserts the button's absence and that nothing asks for quotes per row. `readChipState` now folds
   an unrecognised chip id back to its group's default, because such an id reached the predicates
   and emptied the table while the chip bar highlighted nothing.
8. **Every download is named for this deployment.** `adaptGlowTemplate` rewrote only the
   single-quoted `filename:` form, so Breakouts, All Alerts, Super Investors, Public Chatter,
   Telegram and the notebook all exported `sattva-*.xlsx` from here. The rule now covers the
   templated forms, the notebook's `download =`, and the `^sattva-` strip that derives a bookmark
   section from an export name. The postMessage channel, the IndexedDB/BroadcastChannel names and
   the `sattva-*` CSS classes are deliberately untouched — protocol, durable storage and invisible.
9. **A modal taller than the window caps its own body.** `#modal-content` in `public/index.html`
   carries `max-height` and its own scroller, because the centred overlay put a long panel's close
   button above the scrollable area where no click could reach it.

Two upstream checks needed their budgets widened for this deployment's data volume rather than their
claims changed: the All Alerts arrival highlight expires at ~24s here against a 25s budget, and the
repeat-visit window is written off the collection's path, so `whenAlertWindowSaved()` is the signal
to wait on instead of a sleep.

## Future upgrades

`Sync from Sattva` checks merged upstream changes every six hours and on manual invocation.
Changes only to Sattva capture data are skipped. It prepares a `codex/sattva-sync-*` **merge commit and pull request**, preserving every existing
Glow capture (including nested archives), applying product/repository substitutions, rebuilding
Tailwind and checking the Glow contract. Newly introduced upstream portfolio caches are excluded.
It does not push to main. Conflicts or failed checks produce a draft requiring resolution;
missing PR permission produces an actionable error with the branch preserved.

The full Verify workflow and review gates still govern each PR. This is automatic PR preparation,
not a claim that arbitrary future changes can merge without adaptation. Review shared code
changes, preserve the Glow adapter and extensions, address actionable bot feedback, and merge
when checks pass. Use a merge commit so upstream ancestry remains known. The existing deployment
pipeline may run on merge; other production actions require explicit authorization.

Upstream operational documents retained in this repository describe the template's history.
Their Sattva activation records, credential names and private workbook assumptions do not
supersede this Glow deployment contract or authorize production changes here.

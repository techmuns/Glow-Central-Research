# Glow deployment and Sattva template sync

Audited on 9 September 2026; template baseline advanced on 16 September 2026 to
`techmuns/Sattva-Central-Research` commit `cf7eb444` and on 18 September 2026 to `955324e5` (the last
code commit being `7c0947be`, PR #230) — see *Sync of 16 September 2026* and *Sync of 18 September
2026* below.
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

### The dated evidence — `public/data/book-ledger.json`

`glowData.ts` is a set of RESTATEMENTS: one row per holding as the newest statement marks it. It
carries no trade, no dividend and no realised gain, because GlowVentures keeps a value (which
supersedes) apart from an event (which accumulates). Those events live one level down, in the
statement archive its extractor writes under `public/audit/` — one directory per document, each
`document.json` carrying that statement's parsed `transactions`, `capitalGains` and `income` rows,
which its own Transactions and Capital Gains pages read at runtime.

`scripts/lib/glow-archive.mjs` reads the same directories with **that repository's own two rules**,
reproduced rather than reinvented: authoritative precedence per account (a manager publishing both
a transaction statement and an investor report is read from one, never both) and a dated-row key
that carries each row's ORDINAL among identical rows on its own document (a repeat within one
document is data; a repeat across two is a duplicate). `build-book.mjs` writes the result beside
the book. Nothing is derived: `settledAmount` picks whichever amount the row carries in the
upstream's own order, and a row that printed none keeps `null`.

| | |
| --- | --- |
| shape | `{ _provenance, source, builtFrom, asOf, window, transactions[], lots[], income[] }` |
| built by | `scripts/build-book.mjs`, from `$GLOWVENTURES_DIR/public/audit/` |
| checked by | `scripts/check-book.mjs` — see below |
| read by | `js/data/book.js` (`loadLedger`, `transactionsFor`, `lotsFor`, `incomeFor`), and only by the Family Book's Direct Equity view |
| size | ~630 KB against the book's ~420 KB |

**It is a second FILE and must not become a second TRUTH.** It is separate only because it is
630 KB that one sub-view reads, and `book.json` is a bootstrap file every visitor fetches — the
same cost CLAUDE.md records for "a 347KB shareholdings file read by one sub-view". So `book.json`
carries `equityLedger`, the META alone (~3 KB): the window, the counts, the accounts with and
without a transaction statement, and the security keys the tape, lots and income rows reach. Every
coverage sentence on the page is said from that, without a byte of the rows being fetched.
`check-book.mjs` then refuses the pair whenever they could disagree — a stale copy (`asOf` or
`builtFrom` out of step), a count the meta overstates, a trade against an account the book does not
carry, a string where a figure belongs, a coverage list that is not the rows' own, or a day's sale
whose realised gain is attributed to more than one row. Both files are committed by the same
`series-refresh` run.

**THE WINDOW IS THE STATEMENTS' AND IS NOT A HOLDING PERIOD.** These statements cover one financial
year to date (2026-04-01 to 2026-08-13 on the shipped capture, across 12 of 51 accounts), so the
earliest BUY on the tape is not when a holding was started. `window` carries `declaredFrom`/`To`
(what the statements say they cover) apart from `observedFrom`/`To` (the dates actually present),
because one account's statement declares no period at all and a window taken from the rows alone
would read as a coverage claim nobody made. A company bought years ago and untouched since
correctly shows no trade; the Direct Equity view's *First buy* column therefore reads the
statements' own dated lot register (`heldSince`, the oldest unit still held — three positions in
this corpus) and is a dash everywhere else, never the first date on the tape.

**A realised gain belongs to a DAY'S sale, not to each printed row of it.** The capital gain
statement settles a day's sale against however many purchase lots it consumed and prints one figure
per lot; the transaction statement prints the same sale as one row, or occasionally two. Each
`(account, security, date)` is attributed once, to the first row, and the rest carry a
`realizedNote` saying where the figure went. `equityLedger.realised` reports the two totals side by
side and never merged: `inLots` is what the capital gain statements determined, `onTape` is how
much of it is attributable to a printed sale row, and the difference is the lots whose sale the
transaction statements do not print.

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

Scheduled repository writers commit captured data straight to `main`, exactly as they do on the
template: a commit, then `git push origin HEAD:main` with a fetch-and-rebase retry so two writers
landing together lose nothing. Company-news publication reconciles captured records with the latest
main in disposable worktrees and pushes the result to main itself. Verify runs on every push to
main and reports; Cloudflare's Git integration deploys main.

Between 9 and 17 September 2026 the writers instead opened a `codex/data-*` pull request per
capture and a review controller merged only verified, reviewed ones. The Codex connector does not
review a PR raised by `github-actions[bot]`, so 1,091 capture PRs were open on 17 September and the
live site sat on 9 September prices. That gate is retired: `data-pr-review.yml`, `data-pr.mjs`,
`merge-data-pr.mjs` and `publish-data-pr.mjs` are gone, `verify-glow-isolation.mjs` asserts that
every workflow staging `public/data` pushes to main through the retry, and
`scripts/recover-capture-backlog.mjs` unions any stranded `codex/data-*` branches back in, feed by
feed, should that ever happen again. Every refresh workflow that exists on both sides is
byte-identical to Sattva's again, so the template sync no longer conflicts on them.

The sync workflow itself still opens a pull request for the template merge — code changes are
reviewed — but keeps one open at a time: a new sync closes the older `codex/sattva-sync-*` drafts
as superseded and leaves their branches in place.

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
10. **A peer question's anchor has to be a company THIS book holds.** The template's reasoning check
   now expects a "businesses similar to X" question to reach the source-backed comparison, and reads
   its own live book; Glow's copy injects the frozen `template-portfolio-companies.json` fixture, and
   the two lists differ by 43 companies. The comparison branch learns what the named business is from
   that company's own source rows, so an anchor the book does not hold has none, and the question is
   answered as a portfolio-wide reading instead — the honest answer, not a miss, and identical on both
   sides of this merge. The held anchor here is Tejas Networks; the template's Supreme Industries stays
   beside it as the unheld case, and `expectedKind` derives from whether the book holds the anchor
   rather than from the words "similar to".
11. **A card carrying `content-visibility: auto` is read with `textContent`, never `innerText`.** The
   template's embedded-frame optimisation lets an AI Alerts card off the fold skip its own layout, so
   `innerText` — which reads what is rendered — answers with an empty string over a card whose markup
   holds the text. What a check asserts is what the card says, which must not depend on where the page
   is scrolled.

Two upstream checks needed their budgets widened for this deployment's data volume rather than their
claims changed: the All Alerts arrival highlight expires at ~24s here against a 25s budget, and the
repeat-visit window is written off the collection's path, so `whenAlertWindowSaved()` is the signal
to wait on instead of a sleep.

## Sync of 18 September 2026

Template baseline advanced from `cf7eb444` to `955324e5` (Sattva PRs #220–#230 and the bounded-history
commits between them): the work that makes the dashboard fast by moving the alert collection off the
browser. Sattva's own numbers, on its captures: AI Alerts Universe cold open ~2,400 ms → 131 ms of
longest main-thread task (#227); All Alerts re-entry 4,278 ms → 588 ms (#226); and with the pool
(#228) All Alerts on Today reads one gzip shard instead of the news head, the archives and the
exchange captures, and AI Alerts ranks from the pool's 55,000 events instead of 200,000 without
classifying a row. What arrived, and how each piece lands here:

- **The precomputed alert pool (#228, #230).** `alert-pool-refresh.yml` builds the pool on the runner
  after every capture workflow and publishes ONE Actions artifact; `worker/alert-pool.mjs` serves its
  members by byte range from `env.GH_REPO` with `env.GH_DISPATCH_TOKEN` (Glow's own repository and
  the token already installed on the Worker — no new secret); `js/data/alert-pool.js` seeds the alert
  collectors from it only while every capture it reads carries the revision `/api/capture-status`
  reports now. All ten workflow names the trigger lists exist here under the same names. Nothing is
  committed: the artifact has three-day retention and a member URL carries its artifact id.
- **Sliced rankings, hot-path caches and bounded news working sets (#222, #226, #227)** merged
  cleanly except where Glow had changed the same lines, resolved as below.
- **The driver layer (#225) is DATA here, not a card section.** Sattva's `js/data/alert-drivers.js`
  answers the same question Glow's owner asked for on 17 September — *does this change the earnings
  assumption, the valuation or the thesis?* — and Glow answered it first, with `impactOf()`, the two
  bullets on every card and the three trigger chips (#1115, #1128). Both cannot be on one card. The
  card keeps Glow's `briefMarkup` (`data-ai-brief`, `data-ai-impact-line`, the `[data-ai-impact]`
  chips); `card.drivers` is still computed by `driversOf(card)` so the template's contract tests in
  `verify-ai-alerts.mjs` and the fixture block in `verify-ui.mjs` run unchanged, and the template's
  rendered-card assertions on `[data-ai-drivers]` are the one block dropped from
  `verify-ai-alerts-ui.mjs`, together with the `keywordIds: ['fraud']` its fixture put on every
  announcement to feed that section — under Glow's trigger chips that keyword made every card bear
  on the thesis and failed the count (its `verify-ui.mjs` counterpart skips by itself when no card
  carries the section). A later sync must not swap the card back to `driversMarkup`.
- **The newsletter stays Glow's, whole.** Sattva's team brief was ported from Glow's and then moved
  on its own (#224, and its 18 September "fold per filing, carry late captures forward" commit);
  Glow's went further the same morning — the week ahead, one update per announcement with AI notes,
  the portfolio's day above the global scan — and is the superset (1,757 lines against 1,017).
  `worker/newsletter-*.mjs`, `js/ui/newsletter.js`, `js/data/newsletter-shared.js`, both newsletter
  checks and `scripts/fixtures/newsletter/` are Glow's own files at `origin/main`; Sattva's four new
  fixtures and its versions of the shared ones were not adopted. The one template fix carried across
  is `saveLastRoute`, which lives in `core/state.js` and not on the router — the old call threw into
  its own catch and left `?newsletter=manage` in the saved route.
- **`sw.js`'s cache key** is Glow's markers followed by the template's new ones
  (`…-sattva-newsletter-v2-bounded-history-memory-v5-hot-path-caches-v1-sliced-rankings-v1-alert-pool-v1`),
  as the rule above already says: Glow's lead, the template's follow, nothing dropped.
- **`daily-alerts.js`** keeps decision 5 (`settledLoads`, not `loadedFeeds`, gates the normalised
  feed cache) inside the template's new cache entry, keeps `alertWindowWrite` /
  `whenAlertWindowSaved()` around the template's sliced assembly, and keeps Glow's `periodEnd` import
  beside the template's slices. **`filings.js`** keeps Glow's `bulkNewer` (the bulk/block fallback
  adopts a newer deal list even when the insider capture has not moved) beside the template's
  `queryRevision` projection change; the early return honours both. **`ai-alerts.js`**'s generator
  keeps Glow's `companyMetadata` option. **`filings-tab.js`** keeps `headConfig(ctx)` inside the
  template's preserve-reading-position branch.
- **`verify-breakouts.mjs`** carried the template's repository in two fixture `GH_REPO` values
  (#221); adapted by hand, as decision 4 requires, or `verify-glow-parity.mjs` fails on it.
- **`theme.css` and `wrangler.jsonc`** are Glow's on every conflicted line (the dark-mode primary
  button ink, `DASHBOARD_ORIGIN`, the `1804` limiter namespace); `index.html`'s two conflicts were
  comment-only and take the template's wording.
- **Captures:** every `public/data` path is Glow's own at `origin/main`, and the 83 shard, day and
  archive files Sattva's captures had added were dropped, not adopted — the sync workflow restores
  only paths that exist on both sides, so a review of its PR must still drop upstream-added data.

## Future upgrades

Public Chatter received a targeted backport on 21 September 2026 of Sattva PRs #248 and #255:
source-count-based Mixed/Neutral/Bullish/Bearish summaries, honest unknown readings, saved-alert
and notification corrections, exact-topic AI-card dialog links, and newest-first mention cards
that continue as the reader scrolls. Publication time determines ordering, including time-zone
offsets; undated items remain last. The window summary stays separate from the latest mention.
This does not advance the full template baseline or adopt Sattva captures. Glow's portfolio,
AI impact controls, deployment cache markers and additional tabs remain its own.

The [20 September performance audit](PERFORMANCE-PARITY-2026-09-20.md) checks the shared speed work
through Sattva PR #230 and the later presentation changes. It adds content-hash reuse for unchanged
pool members, cancellation isolation, metadata-only cold exchange verification and the v2 pool's
market-wide discovery context. Preserve these on a later template merge. The v2 contract and its
contract-scoped edge keys must advance together; a v1 pool cannot establish complete AI context.

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


## Targeted price-feed update: 21 September 2026

Ports the minute-primary quote modules from Sattva commit
`115c06b084ce5bb4935cd0cae14bb344c67be0e5`, including reviewed identity mappings,
separate provider feed/last-trade timestamps, and safe exchange handover. This
is a targeted update; it does not advance the whole template baseline above.

- Upstox is primary every minute in market collection hours; the existing GitHub
  capture remains the 15-minute fallback and supplies completed daily bases.
- “Muns API” is the customer price-service label. Raw provider records, original
  source times, missing coverage and detailed Sources provenance remain intact.
- The minute alarm, four-day compact archive and latest-price index belong to
  Glow's own Worker/objects. The browser reads current prices only, every 15 seconds
  while visible and on opening/return/reconnection.
- Glow's repo, OIDC ID, portfolio adapter, newsletter, existing rate-limit namespaces
  and extra tabs remain unchanged. No Sattva captures, holdings or secrets are copied.
- Glow's dated daily-grade fallback and `technicals.rowFor()` remain supported.
  Daily grades never acquire a current-session date from a minute quote.
- The service-worker cache advances so returning sessions load the new modules.

Read-only setup check on 21 September: GitHub has `UPSTOX_ACCESS_TOKEN` and
`UPSTOX_BACKUP_ENABLED=true`. The operator then added `UPSTOX_ACCESS_TOKEN` to
the Glow Worker; a second read-only name listing confirmed it is present. This
confirms configuration only; successful primary quotes still need deployment verification.
Manual credential changes or production-run dispatch are not authorized by this
code update. The existing merge-triggered publishing/bootstrap pipeline is used.
See [BREAKOUT-CAPTURE.md](BREAKOUT-CAPTURE.md) for setup and retention details.

## Glow-owned: KPIs in play on AI Alerts (23 September 2026)

Glow's AI Alerts cards name which of the company's own sector KPIs their evidence bears on, from the
desk's sector → KPI ontology. Preserve it on a template merge; Sattva does not carry it.

- Glow-only files: `scripts/fixtures/sector-kpi-ontology.yaml`, `scripts/lib/yaml-lite.mjs`,
  `scripts/lib/screener-classification.mjs`, `scripts/classify-companies.mjs`,
  `scripts/build-sector-kpis.mjs`, `public/js/data/sector-kpis-shared.js`,
  `public/js/data/kpi-impact.js`, `public/data/company-classification.json`,
  `public/data/sector-kpis.json`, `scripts/verify-kpi-impact.mjs`, `scripts/verify-kpi-impact-ui.mjs`.
- Hunks in shared files: `card.kpis` and the ontology load in `js/data/ai-alerts.js`; `kpiMarkup()`
  and the bookmark detail in `js/tabs/ai-alerts.js`; KPI names in `matchesSearch`; the earnings
  event's `basis`/`metrics` and the con-call event's `tags` in `js/data/daily-alerts.js`; the source
  registry row; the two CI steps; the service-worker marker `glow-kpi-impact-v1`.
- The same change fixes two false-alert readings in the shared `js/data/filing-signals.js` (SEBI
  takeover-regulation disclosures read as Acquisition; court and tax orders read as orders won). It
  is a template-quality fix and is a candidate to offer upstream; until then keep it on merge.
- No credential, route, workflow schedule or capture was added. Classification is refreshed by the
  script, run by hand or from a later workflow.

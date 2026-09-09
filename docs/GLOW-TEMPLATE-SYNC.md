# Glow deployment and Sattva template sync

Audited on 9 September 2026. Template baseline: `techmuns/Sattva-Central-Research` commit
`670e464e63135f90308883cbd13861aa00610754` (merged PR #158).

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
  repository ID `1339395437`. Durable Objects are local to this Worker. Rate-limit namespaces
  `1801` and `1802` are distinct from Sattva's `1701` and `1702`.
- Glow palette, wordmark, Family Book, My Managers, Mutual Funds and macro research remain.
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

The legacy `sync-family-book.mjs` / `resolve-portfolio-companies.mjs` workbook fixture utilities
are retained for upstream regression tests. Their CLI cannot overwrite Glow's portfolio.
Use `build-book.mjs` / `check-book.mjs` / `build-managers.mjs` for Glow production data.

## Credentials and settings to add

This inventory compares **secret names**, not encrypted values. Nothing was copied between
accounts, and no production secret or paid collector was activated during the code sync.

| Location | Name | Glow action |
| --- | --- | --- |
| Cloudflare Worker secret | `CLAUDE_KEY` | Add the Bedrock bearer key used for the configured Claude model if Glow should use the same research provider. Keep it server-side. `CLAUDE_API_KEY` is a legacy alias; do not add both. |
| GitHub Actions secrets | `SCREENER_USERNAME`, `SCREENER_PASSWORD` | Add the credentials for the intended Glow Screener account. Required for authenticated con-call/calendar, operating insights and paid summary collection. |
| GitHub Actions variables | `SCREENER_WATCHLIST_ID`, `SCREENER_WATCHLIST_NAME` | Configure an existing **Glow** watchlist by numeric URL ID and exact name. There is no Sattva watchlist fallback. |
| GitHub Actions variable and Worker setting | `SCREENER_SUMMARIES_ENABLED` | Set `true` in both only when enabling paid private summaries. The Worker accepts this as a secret or variable. |
| Cloudflare Worker secret | `SCREENER_SUMMARY_READER_EMAILS` | Set comma-separated allowed reader emails for private summaries. The reader's Munshot/Muns session is verified through the Muns profile API. |
| GitHub Actions secret | `X_ACCOUNTS` | Add the desired X account list for social capture. Optional to core research. |
| GitHub Actions secret, already present | `SYNC_PUSH_TOKEN` | Correct its permissions: Glow **Contents, Workflows and Pull requests: read/write**. Current upstream-sync logs show PR creation denied. A PAT/App token is needed for pushed PRs to trigger verification workflows. |

Existing credentials to keep:

- Worker `MUNS_TOKEN`: existing Muns services and fallback research provider.
- Worker `GH_DISPATCH_TOKEN`: already installed; must target Glow with **Actions: read/write**.
  This audit did not dispatch a production run to test its value/scopes.
- Actions `GLOWVENTURES_READ_TOKEN`: read-only Contents access to **GlowVentures**, already used
  by the daily producer. It replaces Sattva's `FAMILY_HOLDINGS_TOKEN` / `FAMILY_REPO_TOKEN` needs.

Sattva's Actions `CLAUDE_API_KEY` is not consumed by a production workflow, so an Actions copy
is unnecessary. `X_COOKIES` is a legacy unused input, not a required credential. Public Telegram
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

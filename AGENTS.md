# Project instructions

Read `CLAUDE.md` for the repository's implementation conventions and
`docs/INTELLIGENCE-RELIABILITY.md` for the data reliability requirements.

## Standing user requirement: current data and continuous history

Recorded on 6 September 2026. The user expects to open Glow Central Research and
see up-to-date information, with no data silently missed as time advances. This
applies to every dashboard tab and scope, explicitly including NSE Filings and
Insider Trades (bulk deals, block deals, SAST and insider disclosures).

- Refresh relevant data automatically on opening, returning after inactivity and
  while visible, according to the source's documented cadence. Manual Refresh
  must not be necessary for ordinary freshness.
- Collect and retain source records independently of an open browser. Resume
  interrupted collection, reconcile missed intervals where the source permits,
  and preserve previously captured history through refreshes and date rollovers.
- Treat freshness and completeness as separate requirements. A connected server,
  recent file timestamp or successful subset cannot establish that all relevant
  sources, companies, categories and pages were successfully checked.
- Show the actual source check time and any stale, failed, partial or unavailable
  state accurately. Never label incomplete or failed checks “Up to date”.
- Do not silently discard records through pagination, identity matching, scope
  changes or display windows. Disclose capture start dates, retention limits and
  unrecoverable source gaps; do not claim an exhaustive archive without evidence.
- Evaluate future data changes against the acceptance criteria in
  `docs/INTELLIGENCE-RELIABILITY.md`. Recording this requirement does not certify
  current production compliance or authorize production interventions.

## Standing budget requirement: company-news search

Recorded on 1 October 2026. Company news (`company-news-refresh.yml`: the identity walk and the
global enrichment) used to call `fastapi.muns.io/tools/news-search`, where every query is a paid
Brave Search call on a shared account. In September 2026 the workflow ran 10-20 times a day in each
Central Research dashboard and made roughly 200,000 paid searches, about ten times the account's
normal month. The owner's requirements:

- Company news uses free sources: Google News search (`NEWS_PROVIDER=google`, worker/free-news.mjs)
  and the Upstox News API with the owner's read-only Analytics Token (`UPSTOX_ANALYTICS_TOKEN`).
  The Worker's `/api/news` uses Google too (`NEWS_PROVIDER` in wrangler.jsonc). Do not route company
  news back to the paid Muns/Brave search without the owner's agreement.

- Because the sources are free, portfolio companies are searched every 2 hours, around the clock,
  every day (06:11, 08:11 ... 04:11 IST). The complete universe is searched in the Sunday 06:11 IST
  slot.
- The global (international) search takes at most 20 queries per walk, stalest first.
- Walks are at least 2 hours apart and at most 14 in any 24 hours, whatever starts the run: the
  schedule, `news-recovery.yml`, the browser capture watchdog or a Refresh click. The workflow's
  `gate` job enforces it; only a manual run with the `force` input overrides it.
- Google News is an unofficial feed: keep requests paced (2 seconds apart). A refusal holds the
  walk for a minute and asks once more; a second refusal stops it until the next walk. GitHub drops
  many scheduled runs here, so `news-recovery.yml` starts a walk once the capture is 2 hours 10
  minutes old. Health, the browser watchdog and the Sources page call company news overdue after 4
  hours (two walks); a Refresh click starts a walk only when the capture is over 2 hours old. Do not add schedules or loosen the gate
  unless the owner agrees.

## Standing newsletter requirement (22 October 2026)

- Daily portfolio emails must contain only reports published within the edition's stated
  reporting window. Never email historical backlog, including newly captured old records,
  unsent records from earlier editions, migration recovery or test sends.
- Keep older records and source-reading work in the dashboard archive. Collection/history
  completeness is not permission to resend history by email.
- Refuse an edition before any email if it requires more than six parts. Never send a
  truncated plan or silently omit current eligible records to meet that limit.
- Busy current editions use one explicitly labelled overview email linking the complete
  immutable PDF when the full inline edition would exceed six emails or a single body.
  Preserve every eligible report, source link, note and supplemental row in that PDF;
  verify its publication before sending. Keep the six-email circuit breaker on frozen
  recovery plans and never convert/replay an already claimed failed historical edition.
- Recheck retained delivery plans against these rules before recovery. Retire historical
  or oversized plans without sending more parts; preserve prior outcomes and evidence.
  Scheduled recovery also expires three hours after the original edition time, so a
  failed current edition cannot be replayed as old email on a later day.

## Investor newsletter reading requirement (26 October 2026)

The email must be useful in the inbox: distinct material developments, source-grounded
summaries, supported implications and upcoming decisions. New GitHub-prepared editions use
the investor reading layer with at most three size-bounded emails, with all developments
represented; they must not fall back to a counts-only PDF notification. Preserve every source
record/link, correction, reference item, table and source limitation in the verified immutable
report and retained history. The concise descriptions are an explicitly abbreviated reading
layer, not source deletion or evidence of exhaustive collection. Repeated versions share an
event; changed terms and unknown new evidence must remain visible. Public previews use saved
readings without paid model calls. Existing frozen delivery plans keep their original bodies,
identities, six-part safety gate and historical/expiry safeguards; never replay a retired plan.
See docs/NEWSLETTER-INVESTOR-BRIEF.md. This supersedes the earlier inline-packing rule for new
editions and does not authorize manual production sends, restarts or recovery runs.

## Repository workflow

Portfolio and Watchlist are companion tables. Apply shared table additions and improvements
to both in the same change: controls, presentation, research columns, editing, live refresh
and export. Verify both tables. Keep holding-specific fields on Portfolio and Watchlist's
Source and planned entry price on Watchlist; preserve their existing shared company edits.

Changes under `public/js/` must advance the release version in `public/sw.js`: returning
dashboards serve those modules from an immutable cache. Verify an existing session upgrades;
a fresh asset response alone does not prove that returning readers received the change.

Glow is the downstream template deployment. See docs/GLOW-TEMPLATE-SYNC.md for
Glow-owned portfolio, credentials and sync rules. Sattva production activation
records do not authorize changes to Glow credentials or production runs.

- For every repository change, create a `codex/*` branch and raise a pull request.
- Never commit, push or reset directly on `main`; merge through pull requests.
- Wait for required CI checks and automated reviewer/bot feedback, address
  actionable feedback, and merge automatically once the required checks pass.
  Honor explicit requests to leave a PR open and all required review gates.
- If automated review is unavailable, review the diff locally and disclose that
  limitation. Do not claim automated approval or bypass a required review gate.
- Test locally or in staging by default. A merge may trigger the existing
  deployment pipeline. Other production deployments, restarts, data changes,
  retries, resumptions or cancellations require explicit authorization for that
  exact action; implementing a fix is not such authorization.

## Background processing budget — 15 October 2026

Keep static hosting on Cloudflare. The user requires scheduled collection, calculations and retained background-job state on GitHub, using standard free public-repository Actions runners. Do not move these jobs or storage back into Cloudflare Workers, Durable Objects, D1, R2 or paid Workers Builds. Preserve private-source authorization and encryption; public repository artifacts are not private storage. Do not introduce another paid service or runner. See docs/GITHUB-MUTUAL-FUNDS.md for the implemented MF transfer and its operational boundaries.

The morning brief retains explicitly dated quotes and explanations for the latest completed
trading session. This price context cannot admit old news, filings, trades or arbitrary older sessions.

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

- Portfolio companies are searched every 2 hours from 10:11 to 18:11 IST on weekdays, and once at
  06:11 IST every day before the pre-market. Nothing runs between 18:11 and 06:11. The complete
  universe is searched on Sundays at 06:11 IST.
- The global (international) search takes at most 40 queries per walk, stalest first.
- Walks are at least 2 hours apart and at most 8 in any 24 hours, whatever starts the run: the
  schedule, `news-recovery.yml`, the browser capture watchdog or a Refresh click. The workflow's
  `gate` job enforces it; only a manual run with the `force` input overrides it.
- Google News is an unofficial feed: keep requests paced (2 seconds apart) and stop a walk on a
  429. Headlines between walks come from the other free feeds (TradingView, Moneycontrol, RSS,
  exchange filings, Telegram, X). Do not shorten the company-news windows (26-hour recovery,
  health and click limits) or add schedules unless the owner agrees.

## Repository workflow

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

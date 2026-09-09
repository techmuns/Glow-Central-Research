# Super-investor and manager coverage

The dashboard tracks public disclosures and the family's manager statements. It cannot establish a complete real-time portfolio from those sources. A recent download is not evidence that an underlying report is current or complete.

## Rules applied throughout the dashboard

- Compare consecutive completed calendar quarters. A July or August filing updates individual companies; it is not a complete quarterly portfolio.
- Preserve `reported`, `filing_due`, `not_disclosed` and `unknown` separately. Legacy nulls remain unknown. Only explicit non-disclosure supports “newly disclosed” / “no longer disclosed”; neither proves a trade. Unknown/awaited rows are excluded from activity signals and quarterly consensus.
- Keep source fetch time, report period and manually verified evidence date separate. A failed capture retains the last successful book and its original time, with the failure beside it. A shrinking investor directory retains previously tracked names pending review. Older quarterly columns are retained when the source's rolling window advances.
- A positive disclosed stake with a zero or missing source valuation makes its book total unavailable. Source valuation columns remain attributable to Finology; they are not transaction values.
- Resolve public trades by exact legal name, allowing punctuation and equivalent legal suffixes. Ambiguous names do not match. Associated funds remain attributed to their legal holder, separately from the investor's personal holdings and the family's accounts.

## Scheduled operation

`investor-refresh.yml` captures the full investor directory every six hours, independently of market-price collection. The daily `series-refresh.yml` copies the manager archive from GlowVentures and records `syncedAt` separately from each statement's date. The existing evening insider-trades capture retains the shared bulk/block feed. No production workflow was manually dispatched to validate this change.

These three capture workflows publish through `codex/*` PRs using the existing `SYNC_PUSH_TOKEN`. The publisher verifies the changed file scope, waits for the contracts job and all registered checks, checks required reviews and unresolved review threads, and merges only a clean PR at the checked commit. A failed check, conflict or review gate leaves the PR open and fails the run. It does not bypass branch protection or claim automated code-review approval. The existing Cloudflare Git integration publishes merged assets.

`scripts/audit-holdings.mjs` evaluates every investor and manager, writes `/tmp/holdings-audit.json`, and adds a per-book exception list to the Actions run summary. Investor runs upload the report as an artifact. Broken or overdue ingestion fails the run after preserving/publishing usable data and failure metadata. The dashboard's expandable coverage table computes ages at view time; a stale generated audit cannot make it green.

Freshness targets in `public/js/data/holdings-integrity.js` are operating policies, not legal filing deadlines: investor check 30 hours, manager archive sync 36 hours, bulk/block capture 72 hours, PMS report 40 days, AMC holdings 45 days. Source checks do not remove disclosure gaps. Reviewing a dated relationship does not establish that all related legal entities have been found.

## Verified example and current source gaps

The 9 September 2026 check fetched usable dated portfolios for 88 of 90 directory entries. Rafiyudeen Narudeen Saeyd and Sunil Talwar returned empty, undated bodies. The current manager archive contains 29 managers: six PMS mandates, 13 alternative/private funds and ten mutual-fund houses. Syncing the current archive did not advance its older July statements.

`public/data/holding-evidence.json` holds individually checked primary records and relationship evidence. The first record is Singularity Equity Fund I's TIL disclosure: 1,109,190 shares / 1.35%, as of 6 August 2026, in the [BSE public shareholding table](https://www.bseindia.com/corporates/shppublicshareholder?scripcd=505196&qtrid=130.01&QtrName=6-Aug-26). [Singularity AMC](https://singularityamc.com/) identifies Madhusudan Kela as Mentor & IC Chairman. This is an associated fund position, not proof of personal ownership, a June purchase, or today's position. The record is dated and labelled manually verified; it is not automatically refreshed by the Finology capture.

## Work still required for broader completeness

1. Connect an authorized primary exchange or licensed disclosure feed covering the full listed-company universe, including new companies not already held. The direct BSE API returned HTTP 403 in the read-only test; a manually readable page is not a reliable automated service contract. Current exchange evidence is individually checked, not a full reconciliation feed.
2. Build and review a legal-entity register for every investor and manager: person, family/HUF, trust, investment company, fund and scheme must stay distinct, with source-backed relationships. The current directory names alone cannot prove associated-entity completeness. Add checked relationships to the common evidence registry; do not add fuzzy substring aliases.
3. Obtain recurring holdings and transaction statements for each family account, plus manager-supplied AIF look-through where available. NAV or fund-unit holdings do not establish a fund's underlying stocks. These documents must arrive in GlowVentures before this dashboard can sync them.
4. Reconcile every incoming primary filing by ISIN, legal holder and effective date; retain revisions and source links. Queue conflicts or missing source records for review. A bulk-deal purchase remains an event until an applicable holdings disclosure confirms the position.

Until those inputs are connected and reconciled, the product explicitly reports incomplete coverage. The defensible commitment is that detected gaps remain visible and refresh failures do not silently remove data, rather than a guarantee that no public holding can ever be missing.

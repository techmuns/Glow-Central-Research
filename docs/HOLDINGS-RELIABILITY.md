# Super-investor and manager public holdings

The dashboard checks original exchange shareholding filings alongside Finology across every tracked investor and manager. It discovers positions outside the existing source books. Every attributed row retains the legal holder, security identifier, holding date, filing date, source URL and successful check time.

## Public capture and reconciliation

`scripts/capture-shareholdings.mjs` reads the BSE all-company shareholding index and NSE equity/SME corporate shareholding indexes. It follows the original issuer XBRL attachments. The provisional NSE SDD testing feed is explicitly rejected. The rolling discovery window covers the two completed quarter ends and subsequent disclosures; previously captured filings are retained. This is the companies present in those indexes, not an assertion that every listed issuer filed successfully.

The parser joins XBRL facts by dimensions and holding date. It distinguishes report preparation from the share-count context, and converts raw ratios and inline scaling to percentage points. PAC, custodian/DR and beneficial-ownership relationship tables do not establish the named person's direct holding. Missing, malformed or inconsistent rows remain explicit exceptions. The archive stores public holder names and figures, with source-file hashes; PANs, addresses and account identifiers are not copied.

ISIN, legal holder and effective date define comparisons. Source-book symbols and exact company names resolve only to unique exchange identities, prioritizing the corresponding holding date; historical ISIN changes do not erase a valid match at that date. An obsolete NSE index ISIN is accepted only if the original filing's symbol and ISIN agree with a separate NSE security master, or its scrip, symbol and ISIN agree with the retained BSE master. This exception is recorded in the evidence. Conflicting figures remain visible as separate source rows; the screen does not select or add them. Revised filing URLs and changed bytes at the same URL retain prior versions. A later issuer filing makes older attributed records historical, even if it no longer names that holder.

`scripts/reconcile-shareholdings.mjs` builds `public/data/public-holdings.json` from the compressed archive, source books, manager directory and evidence registry. It checks both directions: additional exchange disclosures, different percentages, and source-book positions without matching primary evidence. Only matching completed quarter ends are compared with Finology. Off-cycle filings remain separately dated. Reported bulk/block trades remain events, without becoming current holdings.

## Legal entities

`public/data/holding-evidence.json` contains reviewed legal-name and relationship mappings with original institution or issuer sources. Directory names match exactly after punctuation and equivalent legal-suffix normalization. Reviewed full names can identify the same person; a fund, company, trust or family entity keeps its own legal holder. An explicitly linked fund may appear in both investor and manager profiles. No entity is inferred from a surname or partial match. For individual investor profiles, a directory-name match in a new company needs reviewed legal identity evidence; otherwise it enters the identity review queue. Existing source-book context supports exact names in known companies. Possible additional connections enter the review queue. Relationship evidence expires for automatic attribution after 90 days until reviewed again.

The registry is extensible for all tracked profiles; the initial verified links are not a claim that every associated entity has been found. Add relationships only with source evidence, through a reviewed code/data PR, then rebuild the public report. A related fund's positions do not establish personal or account ownership.

## Screens, alerts and operation

Every investor and manager workspace has an Exchange disclosures tab with company/holder search and evidence export. Investor holdings also show a compact list of recent exchange disclosures. Coverage & unresolved gaps lists every tracked profile and a searchable public review queue. Ask Research receives the same dated evidence and coverage. The global application watcher checks the published report every five minutes and adds in-app notifications for newly attributed disclosures or new conflicting figures; the initial backlog is suppressed.

`investor-refresh.yml` runs every six hours. It captures Finology, reads new/failed/partial exchange filings, refreshes older successful reads after seven days, reconciles the result, and writes the per-profile audit. It publishes usable data and failures through the existing checked `codex/*` PR workflow. Index failures, transport failures, unread filings and parse exceptions remain visible. Outages or unfinished capture fail the run after publication; issuer data and identifier exceptions remain in the review queue. A run timeout cannot certify completeness, and the dashboard flags stale capture times independently.

Publication uses the existing GitHub Actions token and shared data-PR publisher. It requests verification and code review; the existing data-PR review workflow merges only when its exact-commit CI and review requirements are met. Missing review or failed checks leave the update pending. Branch protection is not bypassed. The existing Cloudflare Git integration publishes merged assets. No manual production capture or deployment is needed for this implementation.

## Meaning and remaining limits

A source download time is not a holding date. Blank source cells retain `reported`, `filing_due`, `not_disclosed` or `unknown` status; missing cells never prove a sale. Quarterly comparisons use consecutive completed calendar quarters. Unusable valuation inputs keep book totals unavailable.

The dashboard cannot establish undisclosed positions or changes made after a filing. Exchange availability, issuer errors, unresolved legal identities and the finite discovery window remain limitations. All are reflected in dated evidence and review/coverage status. The commitment is to automatically discover and reconcile available public evidence, preserve successful reads, and expose gaps instead of presenting an apparently complete portfolio.

The TIL example is now discovered through original exchange XBRL: Singularity Equity Fund I disclosed 1,109,190 shares (1.35%) as of 6 August 2026. Its association with Madhusudan Kela is evidenced separately. This does not establish a June purchase date or today's position. Current capture counts and exceptions live in the generated public report and Actions audit, rather than a hand-maintained count here.

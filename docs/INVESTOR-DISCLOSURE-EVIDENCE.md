# Investor disclosures and changes

Superstar Investors retains its All Investors default. Changes combines two visibly separate
readings: dated public bulk/block trades matched to tracked investor names, and changes between
consecutive completed quarterly disclosures. A quarter-end observation is never a trade date.
Unknown, missing, conflicting and filing-due cells cannot establish purchases or sales. Only
explicit non-disclosure can establish a disappearance from a shareholding pattern. Positive
reported stakes with missing or zero valuations make the aggregate valuation unavailable.

Exact names allow punctuation and equivalent legal suffixes; ambiguous names stay unmatched.
An associated entity requires an explicitly reviewed relationship and a public evidence URL,
renewed within 90 days. No Glow private manager, statement, account or relationship dataset is
imported. Original NSE/BSE holdings show the named legal holder, security identifier, holding
date, filing time, check time and source links. Conflicting exchange figures stay separate and
enter the coverage review. Search and exports use the same disclosure predicate.

Finology books retain their existing daily capture and automatic reader revalidation. Failed
books and investors missing from the latest directory retain previous evidence and their real
source check time. Older quarterly columns survive rolling source windows. The coverage review
is behind How this is derived, while the source age remains visible on the page.

The new `investor-disclosures-refresh.yml` workflow is scheduled every six hours and runs after
changes to its implementation, tracked books or reviewed relationships. It reads the BSE and
NSE equities/SME indexes, starts with two completed quarters and later disclosed dates, and
retains every captured version. This is a capture starting window, not proof of an exhaustive
historical archive. Public source blocking, truncated indexes, unresolved identities, partial
parsing and pending filings remain explicit. The capture never claims complete public holdings.

A run attempts at most 600 filings and checkpoints before reads and every 25 outcomes. Unread
older filings survive calendar rollover; pending work rotates by last attempt. The next run
restores a trusted main-workflow checkpoint and an existing capture PR before collecting. Raw
archives and reconciled evidence publish only through a `codex/*` PR with exact-commit Verify,
required checks and review gates. An artifact is saved before publication so a blocked PR does
not lose collection progress. No production retry, account mutation or manual dispatch is
needed to test this implementation; tests use local public-source fixtures.

The general contract verifies archive shape, retained evidence and reader behavior. The capture
workflow additionally reproduces reconciliation against the exact books and relationships it
used before opening a PR. A later Finology capture can make an earlier comparison outdated;
per-source check dates disclose that, and a new scheduled reconciliation updates it.

Validation: `verify-super-investors.mjs`, `verify-holdings-integrity.mjs`,
`verify-investor-changes.mjs`, `verify-public-holdings.mjs`,
`verify-investor-publishing.mjs`, `verify-super-investors-ui.mjs`. The returning-session
service-worker check also imports the changed investor view before and after cache adoption.

Publication currently enforces a 24 MiB compressed static-asset ceiling and a 256 MiB expanded
restore limit. Exceeding a limit fails publication and retains the checkpoint; it never prunes
older disclosures to make the file fit. Storage must be expanded before further publication.

Before the first scheduled capture, `public-holdings.json` is an explicit `not-started` manifest with null source-check dates and no records. Readers expose that state without a missing asset request, and never adopt it as a successful empty disclosure capture or overwrite previously saved evidence.

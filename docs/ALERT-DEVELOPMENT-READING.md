# Shared alert developments and excerpt notes

Updated 24 September 2026. AI Alerts and All Alerts use Sattva's existing semantic story engine.
Glow's presentation and note workflow are adapted without installing its separate heuristic
matcher. Story/development IDs, 180-day device history, material-update sequence, first source
date and archive/resurfacing rules remain authoritative.

## Presentation and sources

A checked development prefers its company filing when one is available, then the existing lead.
Choosing a later filing cannot move its first publication time forward. Distinct filing documents
cannot combine solely because they have the same category/text; actual document identity is
required before the model can group two filings. Unreviewed news can use the existing exact-copy
fallback. Other uncertain matches stay separate. The filing-claim helper is shared so both views
select the same concise source statement without rewriting it.

All Alerts displays one row per checked development or exact copy group. Every original stays
in `storyReports`: source filters apply before grouping; search, date, direction, importance and
company-relationship filters inspect all members. Expandable source links retain the source date,
headline and readable filing route. The displayed item count is distinct from the original source
count. Export expands all original reports, including rows outside the mounted window.

Large presentation builds yield in slices and stop publishing when their view is abandoned;
underlying source collection and history continue. Existing rows remain visible while the new
projection is prepared. Already-cached decisions load without forcing a new review. Visible
material items can request the existing bounded semantic review; its own budget still applies.

## “So what? · AI excerpt reading”

The optional note reads the displayed company statement/headline/detail, company/sector and
fiscal-year context. **It does not read the linked PDF or full article.** It must not be described
as equivalent to the newsletter's source-document reader. The visible label and explanation
state this narrower basis; the original source is linked alongside it. News requires confirmed
company attribution. Private/portfolio-only rows and price/volume-only measurements cannot
request a note.

Only visible material items are queued, in batches of at most eight. Painting, search and export
alone do not start model calls. The server exposes a same-origin POST route; GET/prefetch cannot
invoke it. Responses are bounded, must finish normally and must contain string notes within the
length limit. Unsupported figures, categorical predictions, advice and share-price calls are
withheld. Fiscal-year context cannot justify an otherwise unsupported monetary figure. Numeric
and wording guards reduce errors; they cannot certify semantic correctness.

Notes are keyed by normalized input, policy version and fiscal-year context, shared across
concurrent readers and cached for 60 days. Changed evidence or fiscal context changes the key.
Missing credentials, refusals, incomplete responses, budget exhaustion and timeouts are explicit
absence states; none removes the source development. The response and request contain no model
credential. The new fixed Durable Object uses the already-provisioned class and independent SQL
storage; it does not migrate or reset story history, newsletter data or private Family data.

The durable allowance is **1,200 new note attempts per Indian calendar day**, charged before
model I/O, including failed/uncertain attempts. The route additionally limits requests per address.
This is a request-count allowance, **not a monetary cap**. It is separate from the newsletter's
USD 1/day and USD 25/month news budget, and from the existing semantic-story budget. No global
AI financial ceiling is claimed. Existing Bedrock configuration supplies the note model.

## Verification

`verify-alert-development-view.mjs` covers distinct filings, exchange-first leads, stable first
dates and IDs, full source membership, sliced/synchronous equivalence, cancellation and order-book
vocabulary. The existing semantic story suite covers 100 reports, later approvals/figures,
corrections, archive behavior and restarts. `verify-alert-notes.mjs` checks the contract, server
budget/cache/concurrency, route boundaries and browser sharing with fixture model replies.

The real browser suites cover cached-session upgrades, changed leads, archived copies, material
resurfacing, All Alerts source conservation/export, filters, scrolling and mobile layouts. These
checks do not send live model requests or establish live inference accuracy. A deployment check
must stay read-only; it must not generate paid notes just to verify the release.

The precomputed pool keeps contract v3 and records a separate classification-policy marker. A reader declines old/unmarked policies and uses the complete source path until the normal main-branch pool workflow publishes the new policy. Updating vocabulary does not silently retain grades from an older rule set.

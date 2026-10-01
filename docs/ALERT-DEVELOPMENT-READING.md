# Shared alert developments and factual summaries

Updated 1 October 2026. AI Alerts and All Alerts
use Sattva's existing semantic story engine. Glow's presentation and note workflow are adapted
without installing its separate heuristic matcher. Story/development IDs, 180-day device
history, material-update sequence, first source date and archive/resurfacing rules remain
authoritative.

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

## Optional AI summaries

Visible substantive corporate filings and results may receive a short factual summary when
captured text adds useful detail beyond the headline. News, routine notices, measurements and
headline-only records do not make a model request. Private/portfolio-only rows stay excluded.
The summary reads supplied text only: **linked PDFs and full articles have not been read**.
The original source remains available. This is separate from the newsletter document reader.

Only visible material items are queued, in batches of at most eight. Painting, search and export
alone do not start model calls. The same-origin POST route rejects cross-origin requests;
GET/prefetch cannot generate a summary. Completed replies use a strict nullable-string schema.
An explicit no-summary response removes the entire summary section. Actual failures stay named.
Unsupported figures, advice and share-price calls are withheld. Numeric and wording guards
reduce errors; they cannot certify semantic correctness or live model quality.

The content key includes the new `sattva-alert-summary:v1` prompt namespace and only the source
fields supplied to the model. Current fiscal years and unrelated metadata do not change it.
Successful summaries and attempt receipts do not expire. Earlier implication notes retain their
old keys and are never relabelled as factual summaries. No stored history is deleted.

The durable allowance remains **1,200 new attempts per Indian calendar day**, charged before
provider I/O. Budget and attempt receipts are reserved in one synchronous storage transaction.
Concurrent readers share the pending response. Terminal results, including rejected output and
unnecessary summaries, are never purchased again for unchanged content. Temporary provider
failures share backoff across reloads and restarts, with a maximum of three paid attempts per
content key. Source corrections can create a new key. This request allowance is not a monetary
cap and remains separate from newsletter and semantic-story budgets.

Missing keys, refusals, quota exhaustion, incomplete responses, daily budget exhaustion and
timeouts remain explicit. “No AI service here” describes a static deployment; a Worker's own
failure is `unavailable`, and missing service configuration is `no-service`. The existing object,
provider pin and private Family boundaries remain unchanged. RPC results are ordinary objects,
including when a caller supplies an ID such as `__proto__`.

### The note model: gpt-6-luna

Notes are written by OpenAI's `gpt-6-luna` on the Worker's existing `OPENAI_API_KEY` secret, with
the newsletter's own first-pass settings: Responses API, reasoning off, a strict JSON schema, no
tools, `store:false`, the standard tier and at most 1,200 output tokens per batch of up to eight.
Both providers receive the same rules and the same items word for word. `ALERT_NOTES_AI_PROVIDER`
(`"openai"` in `wrangler.jsonc`) pins the provider and fails closed: without the OpenAI key a card
reads *no model key*, and the notes never move silently to a costlier model. Bedrock Claude
(`CLAUDE_KEY`) writes them only where it is pinned, or where nothing is pinned and no OpenAI key
exists. A provider failure is reported, never retried on the other provider. `noteProvider()` in
`worker/alert-notes-store.mjs` is the one rule.

At Luna's standard rates checked on 24 September 2026 (USD 0.10 input, 0.125 cache-write and
0.50 output per million tokens) the daily allowance bounds note spending to under USD 3 a day even
if every attempt were a single maximum-size item priced at the cache-write rate with full output;
a typical single-item request is about 2.6 KB, so ordinary use costs cents. That is a derived
estimate from request bytes, not a spending ledger or a cap.

### Why no note appeared before 24 September 2026

The store built its answer with `Object.create(null)`, and Workers RPC cannot serialise an object
without `Object.prototype` ("Could not serialize object of type Object"). Every call therefore
failed at the Durable Object boundary, even for items that needed no model; the route answered
`503 notes-unavailable`, and the page printed that as *this copy of the dashboard has no AI
service*, permanently for the session. Node tests passed because they never cross RPC. The store
now returns ordinary objects (copied from safe internal dictionaries), the route logs the underlying error, and the
browser no longer calls a Worker's failure "no AI service". **Anything a Durable Object RPC method
returns must be ordinary objects and arrays.**

A free, read-only deployment check: POST one item with an unknown `kind` to `/api/alert-notes`
with the dashboard's own `Origin`. A healthy deployment answers `200` with `missing.<id>:
"invalid"` and asks no model; `503 notes-unavailable` means the store itself is failing.

## Verification

`verify-alert-development-view.mjs` covers distinct filings, exchange-first leads, stable first
dates and IDs, full source membership, sliced/synchronous equivalence, cancellation and order-book
vocabulary. The existing semantic story suite covers 100 reports, later approvals/figures,
corrections, archive behavior and restarts. `verify-alert-notes.mjs` checks the contract, server
budget/cache/concurrency, the OpenAI request and every OpenAI failure state, the provider pin,
RPC-safe answers, route boundaries and browser sharing with fixture model replies.
`verify-alert-summaries-ui.mjs` checks viewport-only generation, skipped sections, export and repaint neutrality, reload reuse and mobile layout.
`verify-alert-notes-runtime.mjs` drives the real route and Durable Object over RPC and SQLite in
workerd, with OpenAI replaced by a fixture; it fails on the pre-fix store with the live `503`.

The real browser suites cover cached-session upgrades, changed leads, archived copies, material
resurfacing, All Alerts source conservation/export, filters, scrolling and mobile layouts. These
checks do not send live model requests or establish live inference accuracy. A deployment check
must stay read-only; it must not generate paid notes just to verify the release.

The precomputed pool keeps contract v3 and records a separate classification-policy marker. A reader declines old/unmarked policies and uses the complete source path until the normal main-branch pool workflow publishes the new policy. Updating vocabulary does not silently retain grades from an older rule set.

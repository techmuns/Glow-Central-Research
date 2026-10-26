# Investor newsletter: inbox reading and complete evidence

Implemented for the 26 October 2026 request to make the portfolio newsletter concise,
actionable and sustainable without losing information. This supersedes volume-driven
inline packing and the counts-only report fallback for **new GitHub-prepared editions**.
It preserves the strict publication window, existing schedules, providers and budgets.

## Reading contract

`newsletter-editorial.mjs` derives a reading layer from the complete brief; it never deletes
source rows. Corporate announcements, ownership disclosures, business developments and
large price moves appear as distinct events. Explicit reference pages without an estimate
revision, option chains, generic IPO guides/roundups, known wrong-entity matches and broker
authorship of research on other issuers stay in the complete report. Calendar-only notices
join the scheduled-calendar context. Unknown announcements stay eligible: an unread generic
filing must not disappear merely because its materiality cannot yet be assessed.

The explicit regression cases are Indian Bank versus South Indian Bank/HDFC's generic
"Indian bank" description; Lupin versus the Netflix title; City Union versus a civic union;
and Motilal Oswal as research author rather than researched issuer. A source reading that
cannot establish its issuer's connection cannot supply an investor summary. These guards
are not a universal entity-understanding guarantee; other unverified reporting remains
labelled. Related-entity reports explicitly leave parent exposure unconfirmed.

Risk/regulatory disclosures and consequential operating/capital developments lead; volume
of reporting does not raise priority. Importance is not positive/negative sentiment. In
particular, a meeting to consider a dividend is not a declaration or an automatic "Good".

The email gives a short factual description, an existing grounded AI note where available,
supported potential impact and material unknowns. Without an AI note, read document facts
can be shown as source facts. Unread headlines remain unverified leads. Existing grounded
news notes can appear in previews without another model request. Price context retains its
supported reason or explicit unknown state. All markets, upcoming calendar entries and
corporate-action dates fit with the first email where possible; an explicit count and link
to the complete tables replaces those supplements when necessary.

`newsletter-investor-email.mjs` preserves the original 640px paper, serif masthead and company
headings, double rules, indigo accents, lavender background and dark footer. Shared style
tokens prevent the compact view from drifting from the established newsletter. Each event
has one short description, supported impact and next unknown when available, and a source
link. A grounded summary replaces the repeated headline. A short coverage note links to
the full diagnostics; reference and reading counters do not clutter every event.
`renderInvestorEmails` first packs detailed event descriptions, then, if necessary,
abbreviated descriptions. Long discovery URLs can point to the evidence report in compact
mode. Every distinct eligible event remains represented. The maximum is three bodies of
90,000 UTF-8 bytes; an unrepresentable edition fails before provider I/O rather than
returning a partial plan. The ordinary target is one email per morning/evening edition.

Every part links the same immutable PDF. Its cover counts developments and retained sources,
its investment briefing leads with the investor reading, and its complete source register
preserves original headlines, captured snippets, all links, available notes, reference records, prices,
tables and actual source checks. Old saved PDFs are not rewritten. Retained records outside
the printed publication window remain in history, not newly emailed as catch-up.

## Grouping, versions and acknowledgements

Exact same-publisher headlines are now treated as copies subject to the existing time,
figure, issuer, relationship and stage guards. Matching read document bytes can establish
copies across exchange timestamps. Generic subjects and time proximity alone cannot.
Changed amount, counterparty, date, status, conditions or ownership prevent unsafe merging.
Distinct CEAT loan-conversion/investment fixtures remain separate.

Semantic news checking runs after source attachment, in independent company batches rather
than admitting only the first 80 reports of an edition. Each request retains its existing
80-report/96KB input limits. The old 24KB escaped source-register guard no longer applies:
long archived URLs and read facts do not consume the grouping prompt or compact inbox.
Complete headline/summary inputs still fit as a whole company or remain explicitly unchecked.
At most four batches are attempted per build, with the existing
configured news provider, cache and dollar admission control; no new service or fallback is
introduced. Partial/failed grouping retains all reports and its actual coverage count.

Document hashes or structured facts supply version
aliases in the existing acknowledged-item ledger. All participating versions must be known
before an event is treated as previously covered; unknown new evidence cannot be hidden by
an older member. Changed source bytes/facts create a new version. Headlines alone never
establish a previously delivered version: separate approvals or orders can share an identical
long title. The existing
ledger retains ordinary transport identities for ten days and event-version hashes durably,
independently of permanent source history and delivery-log pruning.
This is conservative copy suppression, not a claim that all paraphrases are understood.

The first accepted report-linked email acknowledges the complete verified report's source
identities. Later emails continue its reading layer. Before any provider submission the
GitHub outbox still verifies the exact PDF publication. A failed publication acknowledges
nothing. Frozen recovery bodies, RFC Message-IDs, recipients, confirmations and uncertain
outcomes remain unchanged. The six-part legacy gate, three-hour scheduled expiry and
historical-backlog refusal remain in force; no old incident is enrolled for replay.

## Source reading and cost

The existing encrypted GitHub SQLite queue gains a priority column in place, preserving
completed results and pending jobs. Publications in the last 72 hours lead background reads,
then importance and actual publication time set their order; late discovery does not make
an old risk disclosure current. The three-day reading priority accommodates ordinary weekends
without changing any newsletter eligibility window. Current consequential filings lead,
with one slot per bounded six-job batch reserved for the oldest due job. Foreground reads
prioritise the current edition. The batch size and provider allowances do not increase.
Read filing-document hashes reuse completed same-issuer/same-kind results with matching
policy versions; news keeps its existing article/headline/model/policy cache. Summary admission
checks readable evidence before spending its 40-item allowance,
so pending leaders cannot exclude a readable item later in the edition.

Known direct source links are preferred to publisher homepages. Legacy Google RSS addresses
can resolve locally from their encoded publisher address; opaque addresses may use at most
two explicit redirects. Every destination must pass the existing HTTPS publisher allow-list;
private addresses, credentials, unsupported destinations and Google interstitial bodies
cannot become article content. Unresolved or restricted links remain explicit pending states
with backoff. No paid crawler/search provider, new credential, paywall bypass, expanded news
search schedule or new Cloudflare processing/storage binding is introduced.
An in-place link-policy upgrade gives formerly unsupported pending links one ordinary retry;
later discoveries preserve their backoff and never reset a reading lease or completed job.

Source capture, document reading, grouping and answer availability remain distinct. The email
opens with partial source coverage, unread counts and unavailable AI notes where applicable.
A new render time cannot make an old or incomplete capture current. This change does not
certify exhaustive upstream collection, live OCR quality or statistical model accuracy.

## Validation

`verify-newsletter-investor.mjs` replays the customer's attribution/noise examples, exact
copies, corrected versions, acknowledged restarts, the forty-pending-before-readable case,
queue migration/priority/fairness, free wrapper resolution and private-target rejection.
It checks that 180 distinct material disclosures fit a few bounded emails with every event
and every report source identity retained. The existing content, event, market, price-reason,
PDF, source-link, delivery, encrypted GitHub and runtime checks remain required.

`verify-newsletter-multipart.mjs` explicitly freezes legacy multipart fixture bodies for its
SMTP/recovery regressions, while current-edition cases exercise the investor planner and
publication guard. Preview generation uses the same current reading layer with no email
or paid model calls. Local rendered HTML and PDF examples are retained under `.cache/` for
desktop/mobile and pagination inspection. Fixture replies prove contracts, not live model
accuracy. Normal merge-triggered deployment and scheduled preparation deliver the update;
manual production sends or recovery runs require separate explicit authorization.

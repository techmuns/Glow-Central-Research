# Newsletter source reading — first phase

**News extension:** [Grounded news summaries and OpenAI cost control](NEWSLETTER-NEWS-AI.md)
now adds company/product/role checks, optional reviewed impact, cached news notes and a separate
news AI allowance. Its news-provider and writing rules supersede the first-phase news rules below.
The filing/PDF rules remain unchanged.

Implemented for the user's steps 1–5 (24 September 2026): automatic discovery, source reading,
source facts, conservative event grouping and summaries of the actual development. This replaces
the previous headline-only instruction. It does not add a second AI provider, an independent
AI answer-review pass, shared dashboard summaries, or a production resend/backfill control.

## Processing

Existing scheduled NSE, BSE and news collectors retain their source records. The newsletter's
existing `team-brief:v1` Durable Object also maintains `newsletter_content` in its own SQLite
storage. With a configured Bedrock key, an enabled edition and active subscribers, its existing
alarm checks the captured sources hourly and processes up to six documents per wake, two at a
time. Pending work wakes at least a minute later. No open browser is needed. The alarm is rearmed
before external I/O; jobs are claimed before reads and become retryable after a five-minute lease.
Email delivery claims and the acknowledged-item ledger remain separate.

Discovery starts with seven days of available source records. It rechecks a two-day overlap and
walks interrupted intervals in seven-day chunks, also reading the current two days during catch-up.
It uses the same portfolio identities and material-filing eligibility as the newsletter, without
its overall/per-company presentation caps. A failed retained NSE day is a failed source read, not
an empty day. Successful jobs and failed/pending jobs survive date rollover and source failures.
No source-record or content-job retention deletion is introduced.

The configured sources are the newsletter's NSE live RSS plus retained day files, BSE capture,
publisher capture and TradingView capture. This is not new universal company-news coverage or a
complete exchange archive. BSE/publisher/TradingView heads retain their existing windows: after
an interruption beyond upstream capture coverage, undiscovered records may be unrecoverable in
this path. Discovery records the requested intervals and each source's real capture/read times;
`captured-sources-read` means those assets were read, not that upstream collection is exhaustive
or current. `captureStartedAt` is the start of this queue's discovery window, not the exchange's
archive start. Disabled editions/no subscribers/no configured key stop additional content work;
existing upstream collectors and saved jobs remain intact.

## Documents and facts

- NSE XBRL uses the existing parser. Every fact retains its exact value, source unit and
  context/tag location. Selected fields identify the actual event, counterparty, consideration,
  status, date, conditions and ownership; unclassified facts are retained as source fields.
- Official NSE/BSE PDFs are downloaded with explicit host checks on every redirect, a streamed
  eight-MiB byte ceiling and a timeout. Full PDF bytes are sent as a native base64 document block
  to the existing Claude Messages endpoint. This includes scanned pages; no text-only PDF parser
  silently discards them. Encrypted, oversized or unreadable inputs remain pending with a reason.
- News reads are limited to the explicit publisher-host list in `newsletter-content.mjs`.
  JSON-LD article bodies or an actual HTML article element are used; navigation, scripts and
  snippets do not stand in for an article. Marked access restrictions remain partial. Unsupported
  hosts, denied requests and absent bodies are explicit pending states; no paywall is bypassed.
- PDF/article extraction returns structured facts and supporting passages with page/paragraph
  locations. Article passages must exist in the received body. PDF passages are model-extracted,
  not independently verified by another model. Unreadable replies and truncated model completions
  cannot become successful reads. Source fields are always untrusted data, never instructions.

Only source facts/passages, links, read states and controlled reason codes enter the queue; no
credentials, subscriber data, PDF bytes or full publisher articles are saved in it. The key covers
issuer, URL identity, publication time and source text. Changed feed text creates a new job.
An unchanged URL whose document bytes change without a feed-text change is not automatically
rechecked in this first phase. This limit must remain explicit when later adding correction scans.

## Event grouping and writing

The ingestion fold uses document identity, publication instant and complete headline, never the
first 60 headline characters. Generic acquisition/general-update/meeting labels and nearby filing
times do not establish a single event. Read filings can combine through an identical document
hash or a complete matching event signature (counterparty, event, amount, status and date,
with any conditions, ownership and purpose also matching). Unread project headlines may combine
only on identical specific content, including figures, and when every member matches. Conflicting
extracted counterparty, amount, status or date prevents combination. News-only semantic grouping
still retains every original source, with these content conflicts also respected. Different events
are not linked through an intermediate report.

The writing pass receives the source facts/passages and links for the final groups. It answers
what happened, potential business impact and relevant unknowns. A category-only row never earns
a generic AI summary. Unread/partial source counts and actual document check times appear in the
HTML, plain-text and saved-PDF output. The existing 40-update writing limit and a 180,000-byte
whole-item input budget are explicit processing limits; larger or unread evidence is not silently
truncated into an allegedly complete source reading. Model output remains labelled AI. These
schema/transport checks are not the independent answer-quality review deferred by the user.

The public preview never triggers source extraction or either paid AI pass. It can show the
existing document-read state; final shared summary storage/display is a later phase.

## Verification and operations

`node scripts/verify-newsletter-content.mjs` uses the two public 23 September CEAT XBRL documents
as frozen fixtures. It verifies loan conversion versus Tyresnmore investment, verbatim facts,
PDF/scanned-page transport, article extraction, restricted access, network bounds, URL guards,
queue restarts/leases/retries, uncapped discovery, failed retained days, no-browser alarms,
conservative grouping, model-input grounding and all output formats. Model replies are fixtures;
this does not certify live model accuracy, OCR fidelity, account access or complete source coverage.
The existing newsletter, repeated-news and UI checks remain required.

The required full-history equivalence check also exposed an existing midnight boundary issue in
new captures: same-publisher dated headlines at different URLs could select a different winner
in a bounded view. Query index v4 now includes that existing deduplication identity, preserving
the full reader's result. Retained v3 indexes remain integrity-verifiable and rebuild from source
bytes for queries. The service-worker revision advances; the warm-session upgrade check verifies
that an existing reader receives v4 and its additional companion identity.

The fixture XML originals are:
- https://nsearchives.nseindia.com/corporate/xbrl/REG30_Restructuring_2711_WebXMLFile_20260923_155648372.xml
- https://nsearchives.nseindia.com/corporate/xbrl/REG30_Restructuring_2711_WebXMLFile_20260923_162559488.xml

PDF document-block contract: https://platform.claude.com/docs/en/build-with-claude/pdf-support

No new key or infrastructure binding is required. Existing `CLAUDE_KEY`/Bedrock configuration is
reused. Normal merge-triggered publishing can install the code; the newsletter's next existing
alarm starts the new work. There is no manual production deployment, send, run dispatch or
credential change in this implementation.

## Price-move explanations

The additional customer request adds one short “Why it moved” line to each price card in HTML,
plain text and the saved PDF. `newsletter-price-reasons.mjs` uses the existing Bedrock provider
in one additional bounded writing request per built send; this is not the deferred independent
answer-review pass. No second provider, new credential or manual production action is added.

For holdings with a displayed move, read captured news and material filings without email caps
or the sent-item ledger. A story previously emailed can still explain the session's move without
being sent again as a separate story. Look from the previous trading session's 15:30 IST close
through the earlier of the observation time and that session's 15:30 close, using the existing
known exchange calendar. Morning editions therefore use the price session, not the build day.
Unknown/special-session calendars yield an unavailable assessment. Day-only publications,
related-entity matches, other issuers and later announcements are ineligible. This conservative
window excludes later market recaps and older ongoing drivers; it is not a universal catalyst
search. Source publication time does not establish event time: the writer must reject recapped
older events and reports of a different session's move.

Extra evidence joins the existing extraction queue. Overlapping story/price sources share one
job and the same six-document foreground processing budget; queued work remains durable. The
public preview only reads saved content. Cached extractions are reused, including older ones
that may not have retained a price-specific passage; there is no implicit re-extraction/backfill.
When the OpenAI news route is enabled, extra article reads use its existing company-grounding
checks and spending ledger. A withheld or budget-limited article cannot become price evidence.
The separate Claude price-writing request uses existing Bedrock credentials and is outside the
OpenAI spending estimate; it is not a fallback for failed news extraction.

The writer receives at most six whole sources per move, with 24,000 bytes per source and a
120,000-byte aggregate evidence budget. Explicit directional reports are prioritized, then
material filings and recency. Omitted sources are counted. The request has a 45-second timeout,
6,000 output tokens and a 50,000-byte response ceiling. Every usable answer names a supplied
source and valid fact indexes; original links and literal support are retained. Unknown IDs,
invented citations, overlong reasons and incomplete replies cannot become explanations.

“Reported reason (AI)” means a news source explicitly linked the same-session directional move
to the development; it is not proof of causation. A literal-passage guard rejects reported labels
without stock/direction/linking language. “Possible driver (AI; unconfirmed)” is an inference,
never a confirmed cause. No verified reason found, content pending, preview and failed assessment
have distinct messages. Partial/unread/omitted evidence and failed source reads remain explicit;
the source footer preserves capture times separately from the current check time. All coverage
is limited to the captured sources. Sector/technical explanations cannot be invented from price.

`node scripts/verify-newsletter-price-reasons.mjs` checks timing (including weekends/holidays),
issuer exclusions, reported/inferred/unknown states, down moves, partial/failed sources, citation
guards, budgets, shared extraction, morning price-only cards and all output formats. These use
fixture model replies: passage/citation guards are not independent semantic verification or a
live evaluation of the model's explanations.

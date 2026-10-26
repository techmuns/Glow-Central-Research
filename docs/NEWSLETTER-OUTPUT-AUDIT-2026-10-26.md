# Newsletter output audit — 26 October 2026

Evidence: the user's 202-page morning PDF, built at 12:24 IST. Its investment briefing
contains 372 entries and 372 primary links (pages 2–54), including ten repeated exact
primary URLs. The cover records 600 source items, of which 594 were unread. This is an
output audit, not certification of the underlying reports or exhaustive collection.

## Additional defects and correction

- Document identity and generated extraction wording competed during grouping. Verified
  document copies now consolidate first, retaining every original row and delivery key.
  Each document representative is supplied once to the final event-summary writer.
- Exchange wrappers split the same board meeting when one omitted the period or used a
  different date format. Event identity now compares the issuer's existing canonical
  ticker, explicit meeting date and normalized financial period. Read XBRL meeting dates
  and periods take precedence over stale captured headlines. Partial agendas cannot
  invent missing words. Different dates, quarters and capital proposals remain distinct.
- Bharat's 23 October EGM original voting report, revised classification disclosure and
  dated scrutinizer report appeared as separate events. They now retain one dated EGM
  event, all constituent report links, and every document version. The revised disclosure
  leads. Changed bytes are never treated as a document copy. Unordered conflicting
  versions are explicitly unresolved, rather than silently selecting a current figure.
  An unread generic “Revised Voting Result” without an identifiable meeting remains
  separate until source evidence establishes its event; proximity alone is insufficient.
- Lupin's Goa FDA inspection appeared as a filing plus two publisher developments; its
  Brian Savage appointment appeared twice. Explicit regulator/site/stage/count and named
  person/role evidence consolidate these cases. Different observation counts, dated
  inspections, sites, people, roles and conflicting read terms remain distinct.
- Specific named acquisition objects and the same named legacy-software partnership can
  consolidate matching reports within a source day. An incomplete acquisition object
  cannot automatically match a more detailed different object. Unknown news still needs
  existing source/model evidence; broad word overlap cannot establish event identity.
- The briefing printed entire extraction arrays, including repeated voting outcomes,
  administrative dates and registration details. It now uses a concise source reading;
  complete saved fields remain in the source register, once per document version.
  Qualified source facts remain distinct from AI summaries and unread headline leads.
- Quote pages, daily competitor comparisons, weekly results-calendar roundups and the demonstrated automated technical
  rating templates crowded out business developments. These remain in the full register.
  Named credit downgrades, fundamental changes and substantive price explanations remain
  eligible. Rating language alone does not establish an institutional credit action.
- A read containing only administrative fields cannot fall back to a raw field dump in
  email. The captured headline retains an explicit factual-summary-unavailable status;
  the saved fields remain in the source register.
- A preview note implied grouping existed only in sent editions. Both now share the
  deterministic document/event pipeline. Optional existing model news review is identified
  separately, with no model calls from preview rendering.

## Preservation and cost

The existing email palette, masthead, widths and dashboard UI are unchanged. Each reading
retains its primary report and the other constituent reports' exact source links; aliases
and supporting attachments remain in the complete source register. Existing immutable
short-link publication guards apply to every emitted shortcut. The three-body / 90 KB
per-body limit remains fail-closed; no partial event plan is returned.

Issuer identity comes from the existing portfolio/exchange mapping. The Munshot stock-search
Worker integration already uses `user_index: 124` and the Worker-held token; it is not an
identity-enrichment job. This change adds no search requests, providers, model calls, reading
batch capacity, schedules or spending limits. Source extraction and optional scheduled AI
continue under their existing configuration. Saved unread records remain pending, not
misrepresented as verified summaries. Historical sent emails and immutable PDFs are retained.

## Release checks

`scripts/fixtures/newsletter/output-2026-10-26.json` preserves 36 exact readings and links
from the supplied PDF. `scripts/verify-newsletter-output.mjs` checks the above positive
cases, negative identity cases, correction/version retention, one final writer item per
event, unique document evidence, concise prose, exact constituent source links and no
source mutation. It runs in required CI with the existing investor regression suite.
Full retained-capture checks also require every eligible event and source delivery key to
survive email packing. All tests use fixtures/local captures and no live search, model or
mail calls. These tests cannot certify the truth of unread sources or unknown future
paraphrases; uncertain identity remains visible rather than silently discarded.

A read-only pre-release check of the live morning preview confirmed that the existing
Bharat correction excerpt omitted the unchanged-votes qualification. The new bounded
voting-results note uses the explicit saved classification-only condition, preserves
stated capital approvals, and remains whole even in the 100-character packing tier.
A conflicting/unordered document version cannot supply this note. Structured meeting
identity also works without a date or event type in the captured headline: read source
fields are evaluated first. These bounded source notes take priority over generic model
wording, so an AI paragraph cannot override or truncate their substantive qualifications.
All cases have mandatory regression assertions.

## Live-reading follow-up

The post-release read-only check confirmed one Bharat EGM row with all three constituent
reports, one Aurobindo meeting row with both exchanges, one same-window Lupin inspection
row and one Brian Savage appointment row. Varroc's meeting was already covered and stayed
out of the inbox; both original exchange links remained in the full source register.

The check also exposed administrative prose in newly read notices. The source-reading
adapter now omits explicitly administrative recipient, identifier, filing-rule and
trading-window fields from the reading while retaining them in the register. Material
amounts, counterparties, ownership and business conditions remain. DCW's actual two-agenda
notice becomes one prospective meeting sentence with its read date, financial-results
agenda and proposed buyback intact. Bharat's original call invitation retains the read
30 October / 4:00 P.M. IST schedule and Q2FY27 period even at the densest tier. Missing or
invalid dates/times, cancellations, changed status and unknown business counterparties
cannot receive these complete source notes. This uses saved fields only; no search,
model, mail, collection cadence or provider budget is added.

The complete live source register additionally exposed DCW's read PDF/form copies as
separate board and earnings-call events. Their saved date, clock and financial-period
fields now establish identity before summary selection. A narrowly verified plain
results/buyback agenda can match its exchange form; unmatched amounts, conditions,
counterparties and other proposals remain separate. Routine call identity normalizes
02:00 P.M. and 14:00, preserves the PDF's explicit timezone and proposed/subject-to-change
qualification, and rejects changed dates, times, periods, stages and explicit timezones.
The identity and reading adapters share the same guards. Structured fields without a
timezone disclose that absence; none is inferred. Added replay cases retain both
constituent original links and require these distinctions before release.

Automated review identified three additional edge cases, now replayed explicitly: a
second invalid clock in the same sentence, a separately extracted rescheduled date,
and substantive event text beginning with a filing-address prefix. Multi-clock and
unreconciled-date readings cannot be certified as complete; address exclusions are
scoped to metadata fields and never discard an event fact.

Follow-up automated review also required whole-fact administrative matching, admission
of validated sparse invitations before the calendar exclusion, and preservation of
compatible periods across name/agenda and PDF/form sources. The final adapter checks
these cases and full timezone names explicitly. Unknown timezone-bearing text and
conflicting source periods cannot act as wildcards; a guidance suffix remains a
material condition rather than boilerplate. All findings have fixture regressions.

A final review case confirms that explicit PDF financial periods take precedence over
stale or missing headlines and are compared with the form's period. June/September
conflicts remain separate; month names, numeric quarter ends and ISO dates normalize
together. Multiple contradictory read periods cannot be silently selected. Letter-date
exclusions also require a complete valid letter date, so a mixed reschedule clause
cannot hide behind an administrative prefix.

The final period adapter compares fiscal labels without inferring an issuer's fiscal
calendar. Q1/Q2 and H1/H2 conflicts remain distinct; compatible quarter/half-year
components and two-/four-digit FY labels retain all known terms in one call reading.
Calendar-month and fiscal-label periods are not declared equivalent without evidence.
Plain results/buyback agendas match as normalized sets regardless of extraction order.
All accepted proposed, subject-to-change and not-yet-completed statuses survive the
consolidated reading; absent conditions are never added. Matching also retains a known
headline period when read fields omit it and rejects source reschedules/cancellations
before a generic exchange wrapper can override those facts.

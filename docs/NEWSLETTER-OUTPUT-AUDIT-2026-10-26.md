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
- Quote pages, daily competitor comparisons, and the demonstrated automated technical
  rating templates crowded out business developments. These remain in the full register.
  Named credit downgrades, fundamental changes and substantive price explanations remain
  eligible. Rating language alone does not establish an institutional credit action.
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

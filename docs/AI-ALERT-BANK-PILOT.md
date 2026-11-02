# Universe bank alert pilot

The pilot appears above the existing AI Alerts queue in **Universe**. It consolidates one
anchor bank's last seven Indian calendar dates into Company, Named peers and Banking industry.
The existing company ranking and the other scopes keep their existing behavior.

## Anchor and peers

Jammu & Kashmir Bank (`J&KBANK`) was the largest **bank** holding in the verified Glow statement
snapshot dated 29 October 2026. The largest equity holding overall was National Stock Exchange
of India, which is not a bank. The pilot's selection is fixed and dated; it does not assert today's
broker ownership. No position sizes are copied into the pilot or its download.

Peers are every other company classified as `industry: Banks` in the existing Universe. This
includes public, private and small finance banks, rather than every financial-services company.
Abbreviated screener labels are expanded for the named banks. The exact peer set is shown in the
coverage disclosure and full download. Missing Universe classifications are disclosed.

## Evidence and reading brief

Current AI Alerts rank structured evidence deterministically, while optional factual AI summaries
and story grouping use model prompts. The UI and Markdown download include those exact existing
prompts from `alert-notes-shared.js` (the OpenAI variant) and `alert-stories-shared.js`, alongside the
pilot's complete reading brief from `public/js/data/ai-alert-bank-pilot.js`. The pilot does not add
a model, paid-search, enrichment-provider or collector call.

The pilot reuses the same normalized Universe report as AI Alerts. Unlike company ranking, it
also retains companyless market news in the seven-date interval. Named peer records retain the
peer's name. Explicit company mentions in source headlines/excerpts are resolved using the
existing company-news attribution policy; an uncertain search-query match does not establish an
issuer event. Banking/RBI reporting can join Industry without mentioning the anchor. Incidental
word matches such as “banks on”, vote banks and unrelated foreign market wraps are excluded.
This is a bounded lexical relevance policy, not a guarantee of semantic recall.

The precomputed AI transport includes every company-news record for the pilot's seven dates,
including uncertain search-query matches whose literal text names another bank. A policy revision
prevents an older, narrower artifact from silently supplying an incomplete pilot. Until the normal
artifact pipeline publishes that policy, readers use the existing source-reader fallback. Company
ranking continues to refuse unconfirmed issuer attribution.

Source materiality and specific banking topics lead the preview. Three rows per section are a
preview only: expansion and download contain every matching record. Routine observations remain
available. Same-link/headline delivery copies combine with their source names and event IDs;
different headline corrections survive. Separately linked syndicated reports are not claimed as
independent confirmation. Source URLs and dates are retained. No context changes the anchor's
score, sentiment, confluence, earnings assumptions or investment recommendation.

## Freshness, history and limits

The seven-date window includes today and re-ages on the existing IST rollover. Existing 90-second
visible/focus/reconnect source checks update the pilot without another collection request.
Pending or failed sources retain earlier context; current stable identities win corrections.
Peer/industry records never enter a narrower scope through provisional Universe narrowing.
The service-worker release advances so returning sessions receive the new modules.

Source as-of values, pending/failed/stale states and coverage notes remain visible. A successful
capture check does not certify all companies, categories, pages or every relevant news source.
Undated records cannot establish a last-week publication and are excluded. An empty section
means no matching dated evidence was loaded. Retained source archives and the 14-day company
alert window are unchanged.

## Verification

- `node scripts/verify-ai-alert-bank-pilot.mjs` checks attribution, aliases, companyless RBI news,
  boundaries, corrections, failures, complete exports, unchanged ranking and scope isolation.
- `scripts/verify-ai-alert-bank-pilot-ui.mjs` drives the real AI Alerts tab over local fixtures:
  three groups, source links, download, automatic arrivals, expanded state, scope switches and
  narrow-screen layout.
- Existing AI Alerts, reliability, theme-exposure and returning-session service-worker suites
  cover the shared paths. No production collection, run retry or manual deployment is part of
  the pilot.

Broader rollout remains a separate product decision after this one-bank Universe output is
assessed.

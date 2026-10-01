# Company feed recovery — 1 October 2026

The per-company failures are distinct from BSE's HTTP 403 outage. The current
provider returned `not-found` for ten announcement and eleven document feeds.
Existing global Screener ALL-announcement recovery continues independently.

## Verified repairs

- HEG's current NSE symbol is HEGAM (ISIN INE545A01024). Use the verified current
  symbol for documents as well as announcements; retain files under the original
  portfolio ticker so previously captured documents remain accessible.
- Dhoot's Screener URL `/company/id/1286088/consolidated/` identifies DHOOTTRANS,
  BSE 544867. Reuse the shared reviewed URL parser instead of collecting `ID`.
- The public company pages were read successfully for HEGAM, DHOOTTRANS,
  JBCHEPHARM, BAGMANE, VERTIS, 543225 (Altius), INDIGRID, MINDSPACE, EMBASSY,
  BIRET and NHIT. They expose original annual reports, concall transcripts,
  quarterly-result links and recent exchange notices without a paid API.

On a primary-provider `not-found` result, scheduled capture reads that company's
public Screener page. Exact NSE-symbol or BSE-code links must verify its identity.
Both source kinds share one bounded page request. Parsing failures cannot become
successful empty collections. Historical documents and notices are merged into
their existing durable files. A symbol correction does not purge domestic history.
Primary authentication failures remain failures; the fallback does not conceal them.

The page's recent announcements are **not a complete date-window response**.
They are saved with independent provider attribution, primary-provider error and
actual check time. The checkpoint leaves historical ranges open and polls again
on the ordinary two-hour cadence. Sources shows partial recovery, not “Up to date”.
The existing paginated ALL-announcement collector remains the broader continuous
backup; direct BSE availability and historical gaps stay separately visible.
Public report-page availability likewise does not certify an exhaustive issuer archive.

## Three unresolved security lines

- INE666D13019 is the Borosil Renewables warrant line. Its issuer equity is
  INE666D01022 / BORORENEW / BSE 502219, also present in the portfolio. Only the
  announcement relationship changes; the holding's security and valuation do not.
- INE0LTR01029 is Everest Fleet Private Limited equity.
- INE0LTR03090 is Everest Fleet Private Limited's Series B preference security,
  dated 18 April 2043, matching the book label “Efpl Pref 18042043”.

The exact security descriptions were checked in the NSDL-derived `ISIN.csv` in
the [archived ISIN dataset](https://zenodo.org/records/15121981). This is historical
identity evidence, not proof of current listing or security status. Everest's
[official site](https://everestfleet.com/) and
[shareholder notices](https://everestfleet.com/newsroom/) identify the private
issuer. The two Everest securities therefore receive reviewed issuer-name news
searches and official-page links, with explicit unavailable listed-equity filing
coverage. No exchange ticker is invented. Existing news entity IDs and archives
are retained. These mappings do not claim access to nonpublic shareholder notices.

## Validation and operation

`node scripts/verify-company-feed-recovery.mjs` checks exact identities, malformed
pages, unsafe URLs, source dates, no AI-summary ingestion, free fallback request
coalescing, preserved documents, incomplete-history reporting and outage retention.
Existing capture, domestic-reader, health, news and portfolio checks also apply.
The manually dispatched `Company feed access check` runs the same public-page
reader on GitHub with read-only repository permissions, no secrets and no data
publication. `node scripts/check-company-feed-access.mjs` runs that probe locally.

No paid service, credential, collection schedule or manual production operation is
introduced. At its next normal run, capture gives existing 404 failures one attempt
with the newly available fallback instead of waiting out the obsolete backoff.
That attempt records real source results; deployment alone never certifies recovery.

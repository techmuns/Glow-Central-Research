# Newsletter market accuracy — 24 September 2026

The 23 September customer report showed correct index levels with incorrect daily
changes. `readMarkets` requested five daily bars but subtracted Yahoo's
`meta.chartPreviousClose`, the reference at the beginning of that range. That also
affected global indices, currencies, commodities and yields.

The screenshot supplies these regression cases:

| Index | Level | NSE previous close | Daily points | Daily percent |
| --- | ---: | ---: | ---: | ---: |
| Nifty 50 | 23,446.80 | 23,329.00 | +117.80 | +0.50% |
| Nifty Bank | 56,548.90 | 56,215.55 | +333.35 | +0.59% |
| Nifty 500 | 22,935.10 | 22,794.20 | +140.90 | +0.62% |

## Source and comparison rules

`worker/newsletter-markets.mjs` owns quote validation. Yahoo comparisons require
the immediately preceding dated unadjusted daily bar in an ordered daily series.
The quote's session must be represented in that series. A null prior bar, missing
session, invalid value or conflicting explicit previous close withholds the
daily change. For Indian indices, the existing known exchange calendar also
checks the predecessor date. Unknown calendars are not certified. No range
reference, older non-null bar, opening price or adjusted close substitutes for it.

The captured `yahoo-nifty-missing-close.json` is an actual public-source response
read during this investigation. Its 22 and 23 September daily closes are null.
A separate one-day/minute request returned `previousClose: 23414.3`, also different
from the screenshot's NSE previous close. Switching to that field alone would not
establish accuracy. The fixture retains these missing bars; its expected result is
a dated level with no daily change until another valid source supplies one.

Indian indices use the existing `UPSTOX_ACCESS_TOKEN` Worker secret. One bounded
V3 full-quote request reads all eight exact cash-index instrument keys, checked
against the public NSE/BSE instrument masters. The response must match both key
and its master trading symbol or index name. `prev_close_price` explicitly supplies
the previous trading session's close and must agree with last price minus
`net_change`. OHLC close may be the current session's close and is never used
as the previous-session reference. A valid last-trade time is required;
request/feed time alone cannot date an old index level. No browser credential,
new subscription, credential change or extra collection schedule is introduced.

Each usable primary row is compared with Yahoo's same-session row. Preceding
closes must agree within floating-point/quote-rounding tolerance: max(0.011,
0.0001% of the reference). Closing levels use the same tolerance; intraday prices
from different seconds are not compared. A prior-close disagreement withholds the
change; a closing-level disagreement withholds the level and changes. Never
average providers or combine one's level with the other's previous close.
Missing/invalid/stale primary rows fall back individually and say single source.
An unavailable cross-check does not claim verification. Provider authentication,
partial reads and failures appear in source coverage.

Every HTML, text and PDF row retains its full source date/time and provider, plus
single-source/cross-check status and any withheld-change reason. Earlier and
delayed observations stay labelled. Global quotes older than four days or still
preceding a provider session that opened more than 20 minutes ago are earlier
quotes, excluded from the headline summary; an intraday observation cannot become
a close just because the market shut. Section headings do not promise today's
close. A macro-series fallback retains its own date and never conceals a known
provider conflict. Stale or unverified rows are excluded from the headline glance.
Delivery summaries retain unavailable, unverified and conflict identities.

## Verification and limits

Run `node scripts/verify-newsletter-markets.mjs`, `verify-newsletter.mjs` and
`verify-newsletter-ui.mjs`. The first covers the customer figures, captured global
and incomplete Yahoo responses, session/date boundaries, identity validation,
partial/error/duplicate Upstox responses, credential isolation and HTML/text/PDF
output. It runs in the existing Verify workflow. The UI suite drives the real
newsletter routes, preview, PDF and delivery stubs locally.

Fixtures prove the validation behavior, not perpetual provider correctness or
production-token acceptance. Same-provider errors, exchange corrections and
missing upstream data remain possible. The correct failure mode is an explicit
gap, never a manufactured percentage. Existing delivered emails and saved PDFs
are historical records; this change does not resend or rewrite them. Normal
future builds receive the correction through the existing merge-triggered deploy.

References: [Upstox full quotes](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/)
and [instrument identities](https://upstox.com/developer/api-documentation/instruments/).

## Existing CI reliability gate

The full-history versus bounded-news check also exposed a pre-existing failure in
23 September captures: the same International Trade Administration headline and
source date appeared at different URLs on either side of IST midnight. The
canonicalizer deduplicated on publisher/date/headline, while the bounded index
looked only for URL/TradingView companions. The narrow view therefore chose a
record the full history had already deduplicated away.

Index version 4 now includes the canonicalizer's shared story identity. Its
fingerprints select extra source records only; they never delete or merge them.
Existing company-scoped canonicalization still decides the output. Old indexes
fall back to verified source parts and rebuild locally. The shipped-capture
comparison stays intact, a small midnight fixture reproduces the bug, and the
service-worker release advances with a returning-session module-upgrade test.

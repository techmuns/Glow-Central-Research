# Newsletter market accuracy — 24 September 2026

<<<<<<< HEAD
The 23 September customer report showed correct index levels with incorrect daily
=======
The upstream Glow investigation and Sattva parity audit identified correct index levels with incorrect daily
>>>>>>> sattva/main
changes. `readMarkets` requested five daily bars but subtracted Yahoo's
`meta.chartPreviousClose`, the reference at the beginning of that range. That also
affected global indices, currencies, commodities and yields.

<<<<<<< HEAD
The screenshot supplies these regression cases:
=======
Captured public-source fixtures from Glow supply these regression cases:
>>>>>>> sattva/main

| Index | Level | NSE previous close | Daily points | Daily percent |
| --- | ---: | ---: | ---: | ---: |
| Nifty 50 | 23,446.80 | 23,329.00 | +117.80 | +0.50% |
| Nifty Bank | 56,548.90 | 56,215.55 | +333.35 | +0.59% |
| Nifty 500 | 22,935.10 | 22,794.20 | +140.90 | +0.62% |

## Source and comparison rules

<<<<<<< HEAD
`worker/newsletter-markets.mjs` owns quote validation. Global rows first use Yahoo's
published daily quote comparison from the same response: `fulldayPrice`,
`fulldayChange` and `fulldayChangePercent`. The price must exactly equal the dated
`regularMarketPrice`; identity, instrument type, currency and timezone must match
the configured instrument. The implied reference must be positive and both supplied
percentages must agree with the arithmetic within 0.00051 percentage points. The
final percent is calculated from price and point change to avoid double rounding
(S&P's reported −0.755% represents −58.61 / 7,764.64 = −0.75% at two decimals).
Missing numbers never become zero; extended-session/mismatched prices, non-finite
values and contradictions cannot supply a change.

This is **provider-reported**, not an independent cross-check or an observed dated
previous close. Rows say “quoted daily change”; delivery summaries retain the
identities in `quotesReportedChanges`. No additional request is needed. For cash
indices, an available preceding dated close is still checked for contradiction.
Currencies and rolling futures use their quoted comparison because a historical
bar can use a different fixing or contract. If their quote comparison is missing,
we do not substitute a chart-based daily move. In the captured 24 September Brent
response, that substitution would incorrectly show −2.60% instead of +2.32%.

Indian indices continue to require the exchange/calendar rules below. A captured
Nifty quote's otherwise coherent +32.50 / +0.139% also uses the wrong reference,
so global quote enrichment must never override India's verified exchange path.
Where global cash quote fields are absent, the immediately preceding dated,
unadjusted daily bar can supply the comparison. The quote's session must be
represented in an ordered daily series. A null prior bar, missing session,
invalid value or conflicting explicit previous close withholds that fallback.
For India, the known exchange calendar also checks the predecessor date. Unknown
calendars are not certified. No range reference, older non-null bar, opening price
or adjusted close substitutes for a daily comparison.
The captured `yahoo-nifty-missing-close.json` is an actual public-source response
read during this investigation. Its 22 and 23 September daily closes are null.
A separate one-day/minute request returned `previousClose: 23414.3`, also different
from the screenshot's NSE previous close. Switching to that field alone would not
=======
`worker/newsletter-markets.mjs` owns quote validation. Yahoo comparisons require
the immediately preceding dated unadjusted daily bar in an ordered daily series.
The quote's session must be represented in that series. A null prior bar, missing
session, invalid value or conflicting explicit previous close withholds the
daily change. For Indian indices, the existing known exchange calendar also
checks the predecessor date. Unknown calendars are not certified. No range
reference, older non-null bar, opening price or adjusted close substitutes for it.

The captured `yahoo-nifty-missing-close.json` is an actual public-source response
retained by the upstream Glow investigation. Its 22 and 23 September daily closes are null.
A separate one-day/minute request returned `previousClose: 23414.3`, also different
from the captured NSE previous close. Switching to that field alone would not
>>>>>>> sattva/main
establish accuracy. The fixture retains these missing bars; its expected result is
a dated level with no daily change until another valid source supplies one.

Indian indices also use the existing `UPSTOX_ACCESS_TOKEN` Worker secret. One bounded
V3 full-quote request reads all eight exact cash-index instrument keys, checked
against the public NSE/BSE instrument masters. The response must match both key
and its master trading symbol or index name. `prev_close_price` explicitly supplies
the previous trading session's close and must agree with last price minus
`net_change`. OHLC close may be the current session's close and is never used
as the previous-session reference. A valid last-trade time is required;
request/feed time alone cannot date an old index level. No browser credential,
new subscription, credential change or extra collection schedule is introduced.

The official NSE `allIndices` snapshot supplies seven NSE indices in one bounded,
unauthenticated request; Sensex is never substituted with an NSE instrument. Its
own timestamp, previous close, point change and percentage are validated. The
published percentage is retained only when consistent with the rounding interval
<<<<<<< HEAD
of its two-decimal levels (material for India VIX). A read-only 23 September
snapshot confirms Nifty IT −0.87% and India VIX 10.29 / −6.41%, additional Yahoo
=======
of its two-decimal levels (material for India VIX). The retained 23 September
snapshot records Nifty IT −0.87% and India VIX 10.29 / −6.41%, additional Yahoo
>>>>>>> sattva/main
errors beyond the three screenshot comparisons. Both source fixtures are retained.
Blocked/unavailable exchange reads fall back without access-control workarounds.

A usable exchange row is preferred. If either independent provider corroborates
it, a third-provider outlier is recorded without hiding the corroborated exchange
figure. With no agreement, conflicting figures are withheld; an exchange-only row
is explicitly single source. Each usable primary row is compared with Yahoo's same-session row. Preceding
closes must agree within floating-point/quote-rounding tolerance: max(0.011,
0.0001% of the reference). Closing levels use the same tolerance; intraday prices
from different seconds are not compared. A prior-close disagreement withholds the
change; a closing-level disagreement withholds the level and changes. Never
<<<<<<< HEAD
average providers or combine unmatched providers' levels and previous closes. The
strictly matched Nasdaq EOD enrichment below is the sole explicit exception.
=======
average providers or combine one's level with the other's previous close.
>>>>>>> sattva/main
Missing/invalid/stale primary rows fall back individually and say single source.
An unavailable cross-check does not claim verification. Provider authentication,
partial reads and failures appear in source coverage.

<<<<<<< HEAD
Yahoo's published feed delays are recorded separately from observation age:
Nikkei/Shanghai/NYMEX/COMEX/ICE Futures US 30 minutes, Taiwan/Korea 20 minutes,
Hang Seng/Cboe/Sensex 15 minutes. An intraday delayed feed cannot say Live just
because its observation is recent. Completed quotes retain Close and the feed
delay. Source: [Yahoo exchange coverage](https://help.yahoo.com/kb/SLN2310.html),
checked 24 September 2026; provider terms and entitlements still apply.

=======
>>>>>>> sattva/main
Every HTML, text and PDF row retains its full source date/time and provider, plus
single-source/cross-check status and any withheld-change reason. Earlier and
delayed observations stay labelled. Global quotes older than four days or still
preceding a provider session that opened more than 20 minutes ago are earlier
quotes, excluded from the headline summary; an intraday observation cannot become
a close just because the market shut. Section headings do not promise today's
<<<<<<< HEAD
close. A macro-series fallback retains its own date and never conceals a known
provider conflict. Stale or unverified rows are excluded from the headline glance.
=======
close. Sattva has no macro-series store; an unavailable source cannot acquire a stored fallback. Stale or unverified rows are excluded from the headline glance.
>>>>>>> sattva/main
Delivery summaries retain unavailable, unverified and conflict identities.

## Verification and limits

Run `node scripts/verify-newsletter-markets.mjs`, `verify-newsletter.mjs` and
<<<<<<< HEAD
`verify-newsletter-ui.mjs`. The first covers all fifteen captured published global quote comparisons, the original customer figures, captured global
=======
`verify-newsletter-ui.mjs`. The first covers the customer figures, captured global
>>>>>>> sattva/main
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

## Additional source coverage

The public [BSE Indices Sensex page](https://www.bseindices.com/indices-details/code/16)
uses `AsiaIndicesGraphData` with index code 16 and the daily (`flag=1`) series.
The newsletter now reads this same public feed once, with an eight-second timeout,
a 256 KiB response cap and no credentials or redirects. Its `Scrip` must be exactly
`BSE SENSEX`. The chart's `PreClose` and `LatestVal` must be positive, and LatestVal
must agree with the last dated cash-session `value`. Pre-open `value1` observations
are never used. Dates must be ordered, unique and in one session; future points,
missing cash values and incoherent headers are rejected.

The captured 24 September response exposes why its header clock must not date a
quote: `LatestTime` still says 09:00:59 while the last cash point is 09:38:38.
The parser uses the point's full date/time in IST. At that point Sensex is 74,267.72
against 74,828.25, or −560.53 / −0.75%. BSE participates in the same exchange-first
<<<<<<< HEAD
reconciliation as NSE, including withholding unresolved disagreements. A local
read of the public feeds also verified all eight Indian indices with current
exchange quotes; this is a dated observation, not a perpetual availability claim.
=======
reconciliation as NSE, including withholding unresolved disagreements. The upstream Glow PR reported all eight Indian indices during its own dated public-feed check; this port does not certify present source availability.
>>>>>>> sattva/main

Upstox's [global instrument master](https://assets.upstox.com/market-quote/instruments/exchange/global.json.gz)
and [API announcement](https://upstox.com/developer/api-documentation/announcements/global-instruments/)
identify four exact additional cash benchmarks in this newsletter: `^GSPC`, `^DJI`,
`^N225` and `^HSI`. A separate four-key full-quote request prevents a global API
failure from invalidating the existing eight-key Indian request. No new token or
subscription is installed. The key, symbol, last-trade timestamp, previous close
and point-change arithmetic are checked for every row. Failed row identities and
reasons are retained in delivery summaries; customer outputs keep source coverage.

Global dates use the exchange timezone, including US daylight saving. The standard
cash-session close thresholds are 16:00 New York, 15:30 Tokyo and 16:10 Hong Kong
(after its closing auction). A preceding weekday quote becomes earlier once the
next ordinary session opens. This is conservative: unknown holidays and shortened
sessions are not certified as current closes. Upstox's documented 15-minute Nikkei
and Hang Seng delay stays visible. A delayed quote can fill an otherwise missing
comparison but never becomes a close or enters the headline glance.

`IXIX` in that master is US Tech 100, **not Nasdaq Composite**. Its Brent indicator
is also a different product from Yahoo's Brent futures contract. Neither is used
as a substitute. USD/INR feeds can have different daily fixing boundaries, so that
<<<<<<< HEAD
indicator is not silently interchanged either. Kospi, DXY,
=======
indicator is not silently interchanged either. Nasdaq Composite, Kospi, DXY,
>>>>>>> sattva/main
USD/JPY, USD/INR and US 10-year yield therefore still depend on their existing
validated feeds. Broader coverage needs a source with those exact instruments,
dated previous closes and appropriate access; no source guarantees perfect data.

<<<<<<< HEAD
## Nasdaq closing-comparison enrichment

`worker/newsletter-market-enrichment.mjs` reads the public
[Nasdaq Composite history table](https://indexes.nasdaq.com/Index/History/COMP)
using the same read-only `POST /Index/HistoryData` form as that page: `id=COMP`,
`timeOfDay=EOD`, and seven calendar days ending on the quote's session. COMP is
the price-return Nasdaq Composite, not NDX/Nasdaq-100. The fixed request establishes
the instrument identity (the response does not echo its symbol); USD, the quote's
identity and the matching current close are also mandatory. No credentials,
redirect following or additional subscription is introduced. One request, an
eight-second timeout and a 64 KiB body limit bound its cost and failure impact.

This is enrichment of a missing closing comparison, not replacement of a quote.
Yahoo must still supply the Nasdaq quote, its full timestamp, a closing observation
at or after 16:00 New York, and the exact immediately preceding daily-series date.
The null bar is never skipped. Nasdaq's complete, descending EOD records must begin
with those same two dates, have valid positive levels, coherent high/low values,
and agree with its own published net change. The two current closes must match
at their displayed two-decimal precision. Any explicit Yahoo previous close must
also agree; known conflicts cannot be repaired away. Missing, duplicate, future,
out-of-range, partial and out-of-order history is rejected. Its midnight date
markers never replace the original market observation's time.

Only after these checks is the previous close normalized to the index's published
two-decimal precision and the missing daily change filled. The level, original
provider and source timestamp stay intact. HTML, text and PDF say `daily change:
Nasdaq history` and `level cross-checked`; this does not claim that two independent
sources supplied the daily change. Coverage and delivery summaries record attempts,
successful enrichment and failures. An outage leaves the existing dated quote and
unverified-change label; a confirmed closing-level disagreement withholds the level
and cannot fall through to an older series-store value.

The captured 23 September fixtures reproduce 26,936.04 versus 27,244.28, a daily
change of −308.24 / −1.13%. Both the public endpoint and the same request from an
isolated Cloudflare development preview returned these records on 24 September.
This is evidence for the integration, not a guarantee of perpetual source coverage.
The regression suite covers dates, DST/weekends, failures, contradictory values,
credential isolation and all three customer output formats. Other instruments are
not substituted or inferred from this feed, and their remaining gaps stay explicit.

=======
>>>>>>> sattva/main
Session references: [NYSE](https://www.nyse.com/trade/trading-information),
[JPX](https://www.jpx.co.jp/english/equities/trading/domestic/01.html),
[HKEX](https://www.hkex.com.hk/Services/Trading-hours-and-Severe-Weather-Arrangements/Trading-Hours/Securities-Market).

The market suite additionally exercises the actual BSE response, pre-open exclusion,
malformed and oversized replies, date rollover/DST, exact global identities,
independent batch failure, conflict handling and HTML/text/PDF provenance.
Indian close labels also require a known session calendar: unknown Muhurat hours
or future-year calendars cannot turn an intraday point into the next morning's
close merely because it occurred after the ordinary 15:30 cutoff.

<<<<<<< HEAD
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


## Published-quote regression evidence

`yahoo-published-global-2026-09-24.json` retains the fifteen actual global chart
responses captured around 08:49 UTC. The fixture verifies S&P 500 −58.61 / −0.75%,
Dow −352.10 / −0.68%, Nasdaq −308.24 / −1.13%, Kospi +63.01 / +0.90%, USD/JPY
+0.14 / +0.09%, USD/INR +0.21 / +0.22%, and US 10-year yield +14.6 bp / +2.94%.
The currency/commodity values describe their own captured times, not permanent
expected current values. Tests cover all fifteen rows through HTML, text, PDF and
the delivery summary, plus malformed/contradictory fields, exact identities,
stale/future timestamps, published zero, cash-reference conflicts and the original
NSE regressions. Nasdaq history remains a fallback when the quote fields are absent;
tests explicitly remove those fields from a copy of the original capture to exercise
that path. A complete quote avoids the extra history request.

A read-only Cloudflare development-preview check at 08:56 UTC on 24 September
returned all 23 market rows with prices and comparisons: seven NSE, one BSE and
fifteen Yahoo published quotes, no missing comparisons, stored substitutes or
conflicts. The actual source timestamps and documented delays remained on each
row. This is a point-in-time source check, not a guarantee of future availability.
=======

Ported from Glow #1285 and #1291, retaining Sattva’s portfolio, branding, readable filing links, subscriber ledger and existing schedule. Validation is local with injected source responses; no production send or manual deployment is needed.
>>>>>>> sattva/main

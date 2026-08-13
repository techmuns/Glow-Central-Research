# Data Contracts

Every JSON file the dashboard reads, its exact shape, field types, units, refresh cadence and
the real source it will be wired to. This document is how live data gets connected — treat it as
the interface, and change the doc and the producer together.

## Conventions

- **Currency** — Indian rupees. Fields ending `Cr` are in **crore** (1 Cr = 10,000,000).
  Fields named `price`, `avgPrice`, `lastPrice`, `high52w`, `value` are absolute rupees.
- **Percentages** — stored as numbers, already in percent. `12.4` means 12.4%, not 0.124.
  Fields ending `Pct` follow this rule without exception.
- **Dates** — `YYYY-MM-DD` (ISO date, no time) for report/as-of dates.
- **Timestamps** — full ISO 8601 with the IST offset, e.g. `2026-08-10T09:12:00+05:30`.
- **Tickers** — NSE symbols, uppercase, no `.NS` suffix. The ticker is the join key across
  every file in this document.
- All files are loaded once at startup by `public/js/app.js` and exposed to tabs as
  `ctx.data.<key>`. The key for each file is listed in its section below.

### Loading map

| `ctx.data` key | File |
| --- | --- |
| `portfolio` | `public/data/portfolio.json` |
| `portfolioCompanies` | `public/data/portfolio-companies.json` |
| `universe` | `public/data/universe.json` |
| `earnings` | `public/data/mock/earnings.json` |
| `earningsCalendar` | `public/data/mock/earnings-calendar.json` |
| `superinvestors` | `public/data/mock/superinvestors.json` |
| `institutions` | `public/data/mock/institutions.json` |
| `filedHoldings` | `public/data/institution-holdings.json` |
| `fundFlows` | `public/data/mock/fund-flows.json` |
| `transactions` | `public/data/mock/transactions.json` |

`universe.json` is loaded twice over: the raw screener rows stay on `ctx.data.universeRaw`, and
`ctx.data.universe` carries the adapted `{ ticker, name, marketCap, sector, industry }` shape the
older tabs were built against (see `js/data/universe.js`).

`earnings.json` follows the same pattern: the full payload stays on `ctx.data.earningsRaw` and
primes `js/data/earnings.js` (so the module never refetches it), while `ctx.data.earnings` carries
the flat one-row-per-company summary that Breakouts → Earnings Surprise was written against.

**Not in that map:** several heavy feeds are fetched lazily by their own data modules the first
time their tab mounts, then cached for the life of the page — the other tabs shouldn't pay for
data they never read. All of them revalidate rather than re-download; see *Conditional delivery
and the device store*.

| File | Loaded by | Size |
| --- | --- | --- |
| `technicals.json`, `atr-history.json`, `technicals-source.json` | `js/data/technicals.js` (Breakouts, global search) | ~800KB |
| `chatter-valuepickr.json`, `chatter-telegram.json` | `js/data/chatter.js` (Public Chatter) | ~160KB |
| `portfolio-history.json` | `js/data/portfolio.js` (Portfolio Analytics) | ~285KB |
| `earnings-live.json`, `mc-ticker-map.json`, `result-returns.json` | `js/data/earnings-live.js` (Earnings Hub) | ~1.2MB |

The three Super Investors files load at bootstrap and seed `js/data/investors.js` through
`prime()`, because the investor grid needs all three together on first paint.

> **Mock vs real.** Everything under `public/data/mock/` is placeholder data so the shell has
> something to render. Outside `mock/`: `technicals.json`, `atr-history.json`,
> `portfolio-history.json`, `earnings-live.json`, `mc-ticker-map.json` and `result-returns.json`
> are **live** (scraped on a schedule, and the Earnings Hub is live per-request on top of that),
> `universe.json` is a **real**
> NSE-500 screener export refreshed by hand, and `portfolio.json` is user config whose `qty` and
> `avgPrice` are *derived* from the ledger rather than typed in.
>
> **Portfolio Analytics is the one workspace that mixes the two inside a single number.** The
> ledger is synthetic — which trades were made, and when. Every price in it is real: execution
> prices are actual Yahoo closes on real trading days, positions are marked to market from the
> live technicals feed, and the equity curve is built from `portfolio-history.json`. The split
> ribbon on all four sub-views states both halves, because a flat "mock data" badge would
> understate the numbers and a "live" badge would overstate them.

---

## `public/data/technicals.json` — LIVE

**The dashboard's one genuinely live feed.** Written by `scripts/scrape-technicals.mjs`, refreshed
weekdays at 07:00 IST by `.github/workflows/technicals-refresh.yml`, and consumed by
`public/js/data/technicals.js`, which scores every row through `public/js/scoring/tech-scoring.js`.

### The universe is the index PLUS the book, and that is not cosmetic

The scrape's input is the **union** of `universe.json` (the NSE-500 screener export) and every
listed line in `portfolio-companies.json`. It used to be the export alone, which quietly made this
file *the Nifty 500 and nothing else* — so a holding outside the index had no price series, no
score, no Breakouts row and nothing in the global search, and **no surface said the index was the
reason**. Only 55 of the book's 123 listed companies are constituents, so nearly half the book was
invisible in Portfolio scope on the one tab that scores technicals. A company is scraped because it
is held, whatever index it is or is not in.

A row that came from the book and not the export carries `listSource: "book"` and, having no
screener row behind it, **no market cap and no FII/DII holding change**. Those stay null: the market
cap renders as an em dash and the institutional-activity rule scores `na` with its full `max`.
Neither is a zero — `na` means "we never had the figure", and a zero would mean "no institutional
buying", which is a different and false claim.

Root is an **object** with a metadata header and a `companies` array.

```jsonc
{
  "generated_at": "2026-08-13T13:56:03.304Z",
  "source": "Yahoo Finance",
  "index_symbol": "^CRSLDX",
  "index_close": 23723.55,
  "index_6m_return": 0.0113,
  "market_breadth": { "advances": 143, "declines": 177, "unchanged": 200, "ad_ratio": 0.81, "universe": 520 },
  "company_count": 603,
  "nse500_count": 535,
  "book_count": 68,
  "partial_refresh": null,
  "failures": 17,
  "companies": [ /* … */ ]
}
```

| Header field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `generated_at` | string | ISO 8601 UTC | When the scrape finished. Drives the gradient "Last Refresh" card. |
| `source` | string | — | Always `"Yahoo Finance"` today. |
| `index_symbol` | string | — | `^CRSLDX` — Nifty 500 on Yahoo. |
| `index_close` | number | index points | Latest index close. |
| `index_6m_return` | number | **fraction**, not percent | `0.0113` = +1.13% over ~126 trading days. |
| `market_breadth` | object \| null | counts | Advances / declines / unchanged, plus `ad_ratio` (advances ÷ declines, null when declines is 0). **NSE-500 rows only** — breadth is a statement about the index, so the held non-constituents are excluded rather than quietly folded into a figure still labelled "Nifty 500". |
| `company_count` | number | count | Rows in `companies`, including failures. |
| `nse500_count` | number | count | Of those, the ones from the screener export. |
| `book_count` | number | count | Of those, the held companies the index does not carry. Drives `coverage().label`, which is why the Breakouts notes read *"NSE 500 + 68 held"* rather than *"NSE 500"*. |
| `partial_refresh` | object \| null | — | Non-null only after a `TECH_FILL_GAPS=1` run — see below. Its presence means `generated_at` describes when the file was written, **not** when most of its rows were priced. |
| `failures` | number | count | Rows carrying an `error` instead of indicators. |

### `TECH_FILL_GAPS=1` — scraping only what is missing

`TECH_FILL_GAPS=1 node scripts/scrape-technicals.mjs` fetches only the companies the committed file
does not already carry successfully, and merges them in. Adding names to the book should not cost a
600-company re-fetch of tickers priced hours ago, and the re-fetch is not free for Yahoo either.

Two rules make the merge honest:

- **A row carrying an `error` counts as a gap and is retried**, and the row being retried is dropped
  from the carry-over set — otherwise a successful retry would land beside the stale failure it
  replaces and the file would hold that ticker twice.
- **Everything else is carried byte-for-byte, including the NSE delivery %.** A gap-fill has no way
  to re-collect delivery figures for rows it did not fetch, and blanking them would turn a real
  measurement into an `na`. `partial_refresh` records `added`, `carried_over` and the timestamp, so
  one `generated_at` never silently stands for two runs.

### SME symbols: NSE says `-SM`, Yahoo does not

NSE suffixes SME-platform symbols (`ALPEXSOLAR-SM`, `SAHANA-SM`); Yahoo carries them under the bare
symbol. Left alone, `ALPEXSOLAR-SM.NS` returns a **one-bar stub** — which reads exactly like a
delisting, because the ticker is right, the exchange is right, and the company simply appears to
have no history. The scrape now strips the suffix as a fallback before trying `.BO`; both of those
have 270 bars under the bare symbol.

### `companies[]` — a company that scraped successfully

Every numeric field is `null` when it could not be computed (usually too little history). The
scoring model treats `null` as **N/A**, which scores 0 out of that rule's max — it never
substitutes a guess.

**Identity and pass-through (from `universe.json`, or from the book — see `listSource`)**

| Field | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `ticker` | string | — | NSE symbol, uppercase. Join key everywhere. |
| `name` | string | — | Company name. |
| `listSource` | `"nse500"` \| `"book"` | — | Which list put this company in the scrape. **`"book"` means the four fields below are null and cannot be filled** — there is no screener row behind it. |
| `screenerUrl` | string | — | Screener.in company page; the drill panel's "View on Screener.in" link. |
| `marketCap` | string \| null | display text | Verbatim from the screener export, e.g. `"27,582 Cr."`. Null on a `book` row. |
| `sector`, `broadSector`, `industry` | string \| null | — | Classification. A `book` row carries the statement's sector and no industry. |
| `chg_fii_hold` | number \| null | **percentage points** | Change in FII holding, latest period. Scored by Institutional Activity. Null on a `book` row, where the rule scores `na` — never a zero, which would read as "no institutional buying". |
| `chg_dii_hold` | number \| null | **percentage points** | Change in DII holding. Same. |

**Delivery % (NSE bhavcopy)**

| Field | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `delivery_avg_recent` | number \| null | percent | Mean DELIV_PER over the recent half of the ~30-day window. |
| `delivery_avg_older` | number \| null | percent | Mean over the older half. |
| `delivery_trend_diff` | number \| null | **percentage points** | `recent − older`. > 1 pp passes the Delivery Percentage rule. |
| `delivery_days_count` | number | count | Trading days matched for this ticker. Fewer than 6 → the rule reports N/A. |

**Liquidity**

| Field | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `adtv_20d_cr` | number \| null | ₹ crore | 20-day average daily traded value. |
| `fno_eligible` | boolean | — | In the NSE F&O underlying list. `false` for all today — the static list is not shipped. |
| `bid_ask_spread_pct` | number \| null | percent | From Yahoo chart meta. Null in practice — Yahoo carries no NSE Level-1. |
| `bid_ask_spread_pct_est` | number \| null | percent | Abdi–Ranaldo estimate from 30 days of OHLC. |
| `impact_cost_pct_est_5cr` | number \| null | percent | Expected price move on a ₹5 crore order, from the Amihud illiquidity ratio over 30 days. |
| `liquidity_tier` | string \| null | — | Band derived from `adtv_20d_cr`. |

> These four are computed by the ported pipeline but **not scored by the technicals model** —
> they belong to a Sentiment & Liquidity pillar that this dashboard has not built. They are kept
> so the feed stays a faithful port and a later prompt can use them without a re-scrape.

**Price and trend**

| Field | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `cmp` | number | ₹ | Latest close. |
| `pct_change_today` | number \| null | percent | vs the previous close. Feeds `market_breadth`. |
| `ema50` | number | ₹ | 50-day exponential moving average. |
| `sma50` | number | ₹ | 50-day simple moving average. |
| `sma200` | number \| null | ₹ | 200-day SMA. Null below 200 bars of history. |
| `above_50ema` | boolean | — | `cmp > ema50`. |
| `above_200dma` | boolean \| null | — | `cmp > sma200`. **`false` is the model's only hard fail.** |
| `golden_cross` | boolean \| null | — | `sma50 > sma200`. |
| `death_cross` | boolean \| null | — | `sma50 < sma200`. |
| `bars_count` | number | count | Trading bars fetched. Under 60 the company is recorded as an error instead. |

**Momentum**

| Field | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `rsi14` | number \| null | 0–100 | Wilder RSI over 14 closes. |
| `macd` | object \| null | — | `{ line, signal, above_zero, positive_crossover }`. `line` = EMA(12) − EMA(26); `signal` = EMA(9) of the line; `positive_crossover` is true only on the day the line crossed above. |
| `adx14` | number \| null | 0–100 | Wilder ADX(14). |
| `return_6m` | number \| null | **fraction** | Stock return over ~126 trading days. |
| `return_6m_index` | number \| null | **fraction** | Nifty 500 over the same window. |
| `relative_strength_6m` | number \| null | **fraction** | `return_6m − return_6m_index`. Positive = outperforming. |

**Volume, range and risk**

| Field | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `avg_volume_20d` | number | shares | Average of the prior 20 sessions, excluding today. |
| `volume_ratio_today` | number \| null | multiple | Today ÷ 20-day average. `1.5` = 1.5×. |
| `high_52w`, `low_52w` | number | ₹ | Extremes of the last 250 closes. |
| `high_proximity_pct` | number \| null | **ratio 0–1** | `cmp ÷ high_52w`. `0.93` means 7% below the high. Distance % = `(1 − value) × 100`. |
| `atr14_pct` | number \| null | percent of price | Wilder ATR(14) ÷ close × 100. |
| `beta_1y` | number \| null | multiple | Covariance of stock vs index daily returns ÷ index variance, over up to 252 **date-aligned** pairs. |

**Pattern detection** — each is an object or `null` when history is too short.

| Field | Shape | Meaning |
| --- | --- | --- |
| `higher_highs_lows` | `{ higher_high, higher_low, pattern_present, recent_high, recent_low, prior_high, prior_low, timeframe, window_weeks }` | Daily bars aggregated to weekly, recent 13 weeks vs prior 13. `pattern_present` requires both a higher high and a higher low. |
| `consolidation_breakout` | `{ base_range_pct, tight_base, breaks_out, volume_confirm, today_close, base_max, today_volume_ratio, quality }` | Base = prior 30 sessions excluding today. `quality` is `strong` \| `weak_base` \| `low_volume` \| `no_breakout` and drives the Strong Breakouts sub-view. |
| `base_formation` | `{ drawdown_pct, tightness_pct, healthy_base }` | Over the last 60 closes. Healthy = drawdown < 15% **and** closing-range SD < 4% of mean. |

### `companies[]` — a company that failed

```jsonc
{ "ticker": "BAGMANE", "name": "Bagmane Prime REIT", "screenerUrl": "…", "error": "ticker not found" }
```

Only those four fields. The model returns `totalPoints: 0, totalMax: 0` with `tickerError` set,
and the UI ranks the row last and labels it "no data" — it is never dropped silently or
back-filled. Common causes: a recent listing with fewer than 60 bars, or a ticker renamed or
demerged since the universe export.

**Refresh cadence** — weekdays 07:00 IST via GitHub Actions, plus manual `workflow_dispatch`.
**Real source** — Yahoo Finance Chart v8 (`TICKER.NS`, falling back to `.BO`) and the Nifty 500
index `^CRSLDX`; NSE `sec_bhavdata_full` for delivery %.
**Consumed by** — the whole Breakouts / Technical tab, and the global search drill from any tab.

---

## `public/data/atr-history.json`

The ATR Stability rule needs a *trend*, not just today's level. This accumulator grows one
snapshot per scrape. Root is an **object** keyed by ticker.

```jsonc
{ "TITAN": [ { "date": "2026-08-10", "atr_pct": 1.92 } ] }
```

| Field | Type | Unit | Notes |
| --- | --- | --- | --- |
| *(key)* | string | ticker | NSE symbol. |
| `[].date` | string | `YYYY-MM-DD` | Scrape date. One entry per ticker per day — a same-day re-run replaces it. |
| `[].atr_pct` | number | percent of price | That day's `atr14_pct`. |

Trimmed to the most recent **30** entries per ticker. The rule needs **≥ 10** before it will call
the trend `declining` / `stable` / `rising`; below that it scores on the absolute level alone and
says the trend is still building. A capped `TECH_LIMIT` run deliberately skips this file so a
partial run cannot poison the accumulator.

**Refresh cadence** — one snapshot per full technicals run.
**Consumed by** — `data/technicals.js`, attached to each row as `atr_history`.

---

## `public/data/technicals-source.json` — optional overlay

Ships **empty**. If a TradingView scrape is wired up later, it writes per-ticker indicator values
here and `data/technicals.js` overwrites `rsi14`, `adx14`, `ema50`, `sma50` and `sma200` from it,
recording which fields were replaced in `row._source_tech_fields` so the drill panel's Source chip
points at TradingView instead of the Yahoo-computed path.

```jsonc
{
  "generated_at": null,
  "source": "TradingView · Technical Analysis",
  "total_companies_covered": 0,
  "companies": {
    "TITAN": { "oscillators": { "rsi_14": 75.0, "adx_14": 50.5 }, "moving_averages": { "ema_50": 4605, "sma_50": 4519, "sma_200": 4199 } }
  }
}
```

**Status** — not yet built. The file is committed empty so the loader has something valid to read
and the contract is visible; nothing on the dashboard is currently sourced from TradingView.

---

## `POST /api/live-prices` — Cloudflare Worker route

On-demand intraday quotes behind the Breakouts tab's "Refresh prices" button. Session-only:
nothing is written to the repo, and the committed EOD feed is unaffected. Implemented in
`worker/index.js`, so it exists under `npx wrangler dev` / a deployed Worker but **not** under a
plain static preview — the button says so rather than erroring.

**Request** — `{ "tickers": ["TITAN", "RELIANCE"] }`. Deduplicated, uppercased, **capped at 60**.
An empty list returns `400`.

**Response `200`**

```jsonc
{
  "generated_at": "2026-08-10T10:12:00.000Z",
  "source": "Munshot quote API (on-demand refresh)",
  "ticker_count": 2,
  "prices": {
    "TITAN": {
      "current": 5100, "open": 4980, "prevClose": 4941,
      "dayHigh": 5122, "dayLow": 4975,
      "week52High": 5180, "week52Low": 2925,
      "ma50": 4519, "ma200": 4199,
      "vol10d": 1284000, "marketCap": 452800, "yearlyChangePct": 41.2
    }
  }
}
```

Every price field is a number or `null`. A ticker whose quote failed is simply absent from
`prices` — one bad symbol never fails the batch.

**Errors** — `405` non-POST · `400` bad body or no tickers · **`502` when zero quotes came back**.
That last one matters: a refresh that fetched nothing is a failure, not an empty "fresh" feed, so
the UI keeps the prices already on screen instead of blanking the display.

---

## `public/data/portfolio-companies.json` — REAL, the book the Portfolio scope means

Every company the family office holds directly, as at the statement date, resolved to NSE symbols.
This is what the **Portfolio / Universe toggle filters by** on every research tab: Earnings Hub,
Con-call, Breakouts, Public Chatter, Institutions and Superstar Investors all ask *"is this ticker
one of ours?"* and this file is the answer. Loaded at bootstrap onto `ctx.data.portfolioCompanies`
and primed into `js/data/coverage.js`.

**It is NOT the ledger, and the two must not be merged.** `portfolio.json` holds twelve positions
with quantities and costs and drives Portfolio Analytics, where a FIFO replay reconciles against it
and `verify-ui.mjs` asserts two identities numerically. Widening that file to 142 lines would break
both identities and invent quantities nobody supplied. The statement this file came from was given
as names only — value and weight were explicitly out of scope — so it carries names only. Two
different questions, two files:

| | `portfolio-companies.json` | `portfolio.json` |
| --- | --- | --- |
| Answers | *is this company one of ours?* | *how much of it do we own, at what cost?* |
| Lines | 142 | 12 |
| Fields | name, ticker, sector | + qty, avgPrice, conviction tier |
| Drives | the Portfolio scope on the research tabs | Portfolio Analytics, the FIFO replay, the equity curve |

```jsonc
{
  "_provenance": "…",
  "asOf": "2026-06-30",
  "source": "family office direct-equity statement",
  "count": 142, "resolved": 123, "unlisted": 11, "bseOnly": 5, "unresolved": 3,
  "holdings": [
    { "name": "Mangalore Petrochemicals and Refinery", "ticker": "MRPL", "sector": "Unclassified",
      "listed": true, "matchedName": "MANGALORE REFINERY & PETROCHEMICALS", "matchedBy": "confirmed:yahoo" },
    { "name": "Turtlemint Fintech Solutions", "ticker": null, "sector": "Financials",
      "listed": false, "reason": "unlisted — private company, held directly" }
  ]
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `asOf` | string | Statement date, `YYYY-MM-DD`. |
| `count` / `resolved` / `unlisted` / `bseOnly` / `unresolved` | number | `resolved + unlisted + bseOnly + unresolved === count`, asserted by the suite. |
| `holdings[].name` | string | **The statement's own wording**, never the exchange's. This is what the reader recognises. |
| `holdings[].ticker` | string \| **null** | NSE symbol, or `null` — see below. |
| `holdings[].sector` | string | From the statement; `Unclassified` where it gave none. |
| `holdings[].listed` | boolean | Whether the company is listed at all, which is a different fact from whether we resolved it. |
| `holdings[].matchedName` | string | The name on the feed the symbol came from — the audit trail for a fuzzy match. |
| `holdings[].matchedBy` | string | How it resolved: `exact:` / `prefix:` + the source, `yahoo-search`, or `confirmed:yahoo` for one checked by hand. |
| `holdings[].reason` | string | Present **only** when `ticker` is null. Why no symbol exists, in the words the UI prints. |

### `ticker: null` is a real holding, and it is kept

Nineteen of the 142 have no NSE symbol. They are still owned. Dropping them would make "Portfolio"
quietly mean *"the 123 we happen to have a feed for"*, with nothing on screen saying so — the same
class of error as rendering a missing value as zero. So they stay in the file with a `reason`, and
the tabs surface them as **held but not covered**:

| Why | Lines |
| --- | --- |
| Unlisted — private company, held directly | 5 · Turtlemint, OnEMI, Standard Engineering Technology, Finbud, AvenuesAI |
| Demerged entity, not listed as at the book date | 4 · the Vedanta aluminium / power / iron & steel / oil & gas lines |
| Warrants, not the equity line | 2 · Vikram Kamats, Alpex Solar |
| BSE-only — every feed wired here is keyed by NSE symbol | 5 · Concord Control Systems, Ashika Credit Capital, Sanjivani Paranteral, Glittke Granites, Vikram Kamats |
| No symbol found on either exchange | 3 · String Metaverse, Nisus Finance Services (SME), Future Supply Chain Solutions (delisted after insolvency) |

`coverageNote()` in `js/data/coverage.js` is the one place that sentence is written, and
`scopeSummary({ book })` prints the denominator in the pill beside every scoped table — *"Portfolio
· 96 of 142 reported"*. A count with no denominator is the thing to avoid: 96 rows looks complete
until you know the book is 142.

### Resolution — `scripts/resolve-portfolio-companies.mjs`

Run it to rebuild the file; `--net` lets it reach Yahoo's symbol search for the leftovers.

It matches against the feeds already in the repo (StockScans' con-call index, the Moneycontrol
ticker map, the screener export) before going out to the network, exact match first, then a
`squash()`ed prefix match — Moneycontrol truncates names to about fifteen characters, so *"Mangalore
Petrochemicals and Refinery"* has to reach *"MANGALORE REFINERY & PETRO…"* somehow. Ten symbols that
prefix-matching would have got wrong or missed are pinned in a `CONFIRMED` table, each checked
against Yahoo by hand, and the not-listed lines are pinned in `NOT_LISTED_EQUITY` so a future run
cannot quietly "resolve" a private company to a same-named listed one.

**A collision guard fails the run rather than shipping a silent merge.** Two book lines that resolve
to one symbol means one of them is wrong, and the pair that proved it is *Allcargo Global* and
*Allcargo Logistics* — genuinely two companies, `AGL` and `ALLCARGO`. Without the guard one would
have inherited the other's rows and the reader would have seen a holding they do not own.

**Refresh cadence** — when the statement changes; re-run the resolver and commit the diff.
**Real source** — the family office's direct-equity statement.
**Consumed by** — `js/data/coverage.js`, and through it every tab's `forScope()` and the header search.

---

## `public/data/portfolio.json`

The tracked holdings. Root is an **object**, not an array.

**`qty` and `avgPrice` are DERIVED, not typed in.** They are written by
`scripts/gen-mock-transactions.mjs` from a FIFO replay of the ledger, which is what makes
`sum(open lots) === qty` hold by construction rather than by luck. Editing them by hand puts the
position table and the ledger into disagreement, and `scripts/verify-ui.mjs` fails when they
disagree. The holdings *list* — tickers, names, sectors, conviction tiers — is user config and is
preserved across regeneration.

There is deliberately **no `lastPrice` and no `high52w`**. Those were placeholders; positions are
now marked to market from `technicals.json` (`cmp` and `high_52w`). A position missing from that
feed is marked at cost, flagged `priced: false`, tagged "at cost" in the UI and excluded from the
equity curve — never marked at zero, which would invent a −100% position.

```jsonc
{
  "_provenance": "…",
  "asOf": "2026-08-06",
  "basis": "FIFO, charges folded into cost",
  "holdings": [
    {
      "ticker": "HDFCBANK",
      "name": "HDFC Bank Ltd",
      "qty": 300,
      "avgPrice": 892.77,
      "sector": "Financials",
      "convictionTier": "Core"
    }
  ]
}
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `asOf` | string | `YYYY-MM-DD` | Date of the last ledger row. |
| `basis` | string | — | Cost-basis convention, stated so an importer cannot assume weighted-average. |
| `holdings[].ticker` | string | NSE symbol | Join key. |
| `holdings[].name` | string | — | Full company name. |
| `holdings[].qty` | number | shares | **Derived.** Sum of open FIFO lots. |
| `holdings[].avgPrice` | number | ₹ per share | **Derived.** FIFO cost of open lots ÷ quantity, buy-side charges included. |
| `holdings[].sector` | string | — | User config; falls back to the technicals feed. |
| `holdings[].convictionTier` | string | `Core` \| `High Conviction` \| `Tracking` | User config. An input, not a score. |

**Refresh cadence** — holdings list user-edited; `qty` / `avgPrice` regenerated with the ledger.
**Real source** — the user, or a broker import.
**Consumed by** — `js/data/portfolio.js` (which primes from `app.js`), every tab's Portfolio scope filter.

---

## `public/data/portfolio-history.json` — LIVE

**Three years of real daily closes.** Written by `scripts/scrape-portfolio-history.mjs`, refreshed
weekdays 07:00 IST alongside the technicals scrape, and consumed by `js/data/portfolio.js` to build
the equity curve, the drawdown series and the benchmark comparison.

This file is real because the alternative is the worst thing in the dashboard to fake: a max
drawdown from an invented price series looks exactly like a measured one, and unlike a mock revenue
figure nothing contradicts it.

```jsonc
{
  "_provenance": "REAL DATA. Daily closing prices from Yahoo Finance …",
  "generated_at": "2026-08-11T…Z",
  "source": "Yahoo Finance",
  "years": 3,
  "from": "2023-08-11",
  "to": "2026-08-10",
  "trading_days": 741,
  "ticker_count": 12,
  "requested_count": 13,
  "failure_count": 1,
  "failures": [
    { "ticker": "TATAMOTORS", "symbol": "TATAMOTORS.NS", "reason": "ticker not found",
      "inUniverse": false, "kind": "holding" }
  ],
  "benchmark": { "symbol": "^CRSLDX", "name": "Nifty 500",
                 "points": [{ "d": "2023-08-11", "c": 19428.05 }] },
  "series": { "HDFCBANK": [{ "d": "2023-08-11", "c": 812.4 }] }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `series[ticker][]` | `{ d, c }` | ISO date and closing price in ₹. Oldest first. |
| `benchmark.points[]` | `{ d, c }` | Nifty 500 (`^CRSLDX`) on the same calendar. |
| `failures[]` | array | **Load-bearing.** Every ticker Yahoo would not serve, with the reason. The UI names these positions as excluded from the curve and carries them at running cost; it never silently shortens the curve. |
| `trading_days` | number | Union of all dates across every series. |

**Two things about this file that are easy to get wrong:**

1. **Yahoo's `close` is back-adjusted** for splits and bonuses. Historical prices are restated in
   today's share terms. So a ledger may carry a corporate-action row **only** for an action the
   series was adjusted for; an invented split on a real ticker doubles the quantity while the price
   series stays put, and the curve jumps 100% on a day nothing happened. See
   `scripts/gen-mock-transactions.mjs`, which puts both synthetic actions on the one holding with no
   price series at all.
2. Where an action row *does* exist, `dailyPositions()` in `js/portfolio/lots.js` returns
   `valuationQtyByDate` — the holding expressed in **current share terms** — and the curve values
   against that. Against a back-adjusted series the two corrections cancel exactly.

**Refresh cadence** — weekdays 07:00 IST, `.github/workflows/technicals-refresh.yml`.
**Real source** — Yahoo Finance Chart v8 (`query1.finance.yahoo.com`), via `scripts/lib/yahoo.mjs`.
**Consumed by** — `js/data/portfolio.js` → Drawdown (all three sub-views) and Overview's benchmark line.
**Bootstrap note** — the scraper derives its ticker list from `portfolio.json` + the ledger. A ticker
about to enter the ledger is not in it yet, so `EXTRA_TICKERS=ASIANPAINT node scripts/scrape-portfolio-history.mjs`
breaks that one-time deadlock.

---

## `public/data/universe.json`

The coverage universe: **535 companies, the real NSE-500 Screener export**. Root is an **array**,
with Screener.in's own column names and display-formatted values — kept verbatim so the scraper
reads exactly what the export provides.

```jsonc
[
  {
    "Company": "P & G Hygiene",
    "Screener URL": "https://www.screener.in/company/PGHH/",
    "Market Cap": "27,582 Cr.",
    "Broad Sector": "Fast Moving Consumer Goods",
    "Sector": "Fast Moving Consumer Goods",
    "Broad Industry": "Personal Products",
    "Industry": "Personal Care",
    "Chg in FII Hold": "0.01 %",
    "Chg in DII Hold": "-0.38 %"
  }
]
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `Company` | string | — | Display name. |
| `Screener URL` | string | — | **The ticker source.** `/company/<TICKER>/` is parsed out; that slug is the join key across every other file. A numeric slug (3 rows) is a BSE code for a company with no NSE listing — the scraper goes straight to `.BO` for those. |
| `Market Cap` | string | display text | e.g. `"27,582 Cr."`. Parsed to a number by `parseMarketCapCr()`. |
| `Broad Sector`, `Sector` | string | — | Coarse and standard sector. |
| `Broad Industry`, `Industry` | string | — | Coarse and fine industry. |
| `Chg in FII Hold` | string | percent text | e.g. `"-0.25 %"`. Parsed by `parsePercentValue()` → `chg_fii_hold`. |
| `Chg in DII Hold` | string | percent text | → `chg_dii_hold`. |

The upstream Screener export carries ~50 columns (ratios, quarterly series, shareholding series).
Only the nine above are kept — they are everything the scraper and this dashboard read, and
trimming takes the file from ~1MB to ~163KB on a static site with no build step.

**Adapter.** `js/data/universe.js` converts these rows into the simpler
`{ ticker, name, marketCap, sector, industry, screenerUrl, chgFiiHold, chgDiiHold }` shape that the
eight mock tabs already consume, so swapping in the real export required no changes to them.
Read `ctx.data.universeRaw` if you need a screener column the adapter doesn't expose.

**Refresh cadence** — manual re-export. NSE 500 constituents change quarterly; the FII/DII columns
change with each shareholding filing.
**Real source** — Screener.in screen export over the NSE 500.
**Consumed by** — the technicals scraper (its input list), global search, and every tab's Universe
scope.

---

## `GET /api/earnings` — LIVE, the Earnings Hub feed

**The dashboard's second genuinely live surface, and the only one that is live per-request rather
than per-schedule.** Served by `worker/index.js`, which proxies Moneycontrol's Rapid Results API
through `worker/mc.mjs` and caches the normalised result at the edge for 30 seconds.

```
GET /api/earnings?subType=yoy|qoq&category=all|std|con
```

```jsonc
{
  "ok": true,
  "degraded": null,                       // a string when serving the fallback — see below
  "latestResultDate": "2026-08-10",
  "count": 1319,
  "meta": { "quarter": "Q1 FY26-27", "currentPeriod": "Jun 26", "priorPeriod": "Jun 25",
            "source": "Moneycontrol — Rapid Results", "fetchedAt": "2026-08-11T…Z",
            "contentTag": "d04fdba9b88b5439",     // == the ETag; see "Conditional delivery"
            "structureTag": "8c514c34cec2ebfb" }, // identity + reported figures, price EXCLUDED
  "rows": [
    { "scId": "IC8", "name": "Vodafone Idea", "ticker": "IDEA",
      "resultDate": "2026-08-10", "ltp": 13.26, "changePct": 2.63,
      "exchange": "N", "basis": "Consolidated", "sectorSlug": "telecommunication-service-provider",
      "revenue":    { "current": 11689, "prior": 11023, "reportedPct": 6,  "kind": "normal",        "pct": 6 },
      "netProfit":  { "current": -3754, "prior": -6608, "reportedPct": 43, "kind": "loss-narrowed", "pct": 43 } }
  ]
}
```

### `kind` — the field that stops the table lying

Moneycontrol reports growth as a plain percentage even when the sign flips between periods. In a
full quarter that is **169 of 1,319 companies (13%)**, and the number does not mean what it looks
like. Every metric is therefore classified:

| `kind` | Meaning | `pct` |
| --- | --- | --- |
| `normal` | Profit in both periods. The only case where a growth rate is meaningful. | the percentage |
| `loss-narrowed` / `loss-widened` | Loss in both periods. "+43%" describes the size of the loss, not profit growth. | reported, but labelled |
| `turnaround` | Loss → profit. A change across zero is not a growth rate. | **null** |
| `slipped-to-loss` | Profit → loss. Same. | **null** |
| `from-zero`, `flat`, `na` | No prior base, or nothing to compare. | **null** |

The UI renders a signed percentage only for `normal`; everything else is a labelled pill. Getting
this wrong would paint Wockhardt's loss-to-profit recovery as a green "+199%" growth rate.

**Identity is resolved on the fly for companies the map has never seen.** A company that reports
today is by definition not in a map built yesterday — and those are exactly the rows at the top of
a live results table. The Worker resolves up to 40 unknown codes per cache window against the price
feed and merges them in, so the freshest rows arrive with a ticker, an industry and a share count
rather than three dashes. `meta.resolvedOnTheFly` reports how many. The scheduled job still
maintains the durable map; this only covers the gap between filings and the next run.

**Degraded mode** — if the upstream fails or changes shape, the Worker serves the committed
snapshot with `degraded` set to a human-readable reason, and the tab swaps its green "Live" ribbon
for an amber "Showing the last snapshot" one. An empty feed is never served as success, because
"no results" and "we could not reach the source" are different claims.

### `seq` — the upstream's own order, and why it is data

Every row carries `seq`, the index Moneycontrol returned it at. `resultDate` is a **date**, but
filings arrive through the day and the upstream is sorted latest-first at that finer granularity.
Sorting our copy by `resultDate` alone therefore needs a tie-break, and any tie-break we invent is
a different list from the one Moneycontrol shows — an early version broke ties on the size of the
profit move, so "Latest Results" opened on neither the latest filings nor the same order as the
source. `seq` is stamped in `worker/mc.mjs` so the live route, the committed snapshot and the
browser all agree, and `dateSortValue()` in `js/data/earnings-live.js` encodes
`(resultDate desc, seq asc)` into the Date column's single sort key.

### `subType` — one filing, two questions

`subType=yoy` compares the quarter against the same quarter a year earlier; `subType=qoq` compares
it against the quarter before. **The current-period figures are byte-identical between the two** —
only `prior`, `reportedPct`, `pct` and `kind` change. The Earnings Hub exposes this as a YoY/QoQ
toggle and mirrors it into the URL as `?period=`.

Three rules follow from that, and all three exist because the two payloads look the same:

1. **The response's `meta.subType` is authoritative, not the request.** `setSubType()` in
   `js/data/earnings-live.js` refuses a payload whose `meta.subType` is not what it asked for.
   Serving YoY under QoQ headers is the one error nothing downstream could catch — the visible
   current-period column would be correct.
2. **The change fingerprint covers `prior` as well as `current`**, for the same reason: a checksum
   over the current period alone cannot tell the two sub-types apart.
3. **There is no QoQ snapshot, deliberately.** `earnings-live.json` is YoY. A committed QoQ file
   would be indistinguishable from a live one while comparing against a stale quarter, so when the
   live route is unreachable the tab says QoQ is unavailable rather than falling back.

A `kind` can differ between the two for the same company — Unichem Labs' Q1 is a `turnaround`
YoY (−10 → 41) and a plain `normal` +272% QoQ (11 → 41). That is not an inconsistency; it is the
two questions having different answers.

**Consumed by** — `js/data/earnings-live.js` → the Earnings Hub.

---

## `GET /api/earnings?fields=prices` — the polling projection

The same feed with everything that does not move stripped out: **~30KB against 1.1MB.**

```jsonc
{
  "ok": true,
  "fields": "prices",
  "structureTag": "8c514c34cec2ebfb",   // the full feed's identity + reported figures
  "latestResultDate": "2026-08-11",
  "count": 1488,
  "degraded": null,
  "prices": { "CHC": [1191, 6.43], "IC8": [13.26, 2.63] },   // scId -> [ltp, changePct]
  "meta": { "subType": "yoy", "category": "all", "quarter": "Q1 FY26-27",
            "currentPeriod": "Jun 26", "priorPeriod": "Jun 25",
            "source": "…", "fetchedAt": "…", "contentTag": "579cfa7abe7ebfb8" }
}
```

Two-element arrays rather than objects on purpose: `"CHC":[1191,6.43]` is 20 bytes where
`{"ltp":1191,"changePct":6.43}` is 44, and there are ~1,500 of them.

**Why this exists when every route is already conditional.** The results feed is the one place a
304 buys nothing: `ltp` moves on every tick during market hours, so the full representation
genuinely changes every 30 seconds even when not one reported figure has. Splitting the volatile
field out means the poll carries only what actually moved.

`structureTag` is a tag over identity and the reported figures with the **traded price
deliberately excluded** (`structureTagOf` in `worker/index.js`). The client re-fetches the full
feed exactly when it moves, which is when a company has filed or revised — so a filing still
reaches the screen on the very next tick. `js/data/earnings-live.js` folds the prices onto the
payload it holds and re-ingests through the same `joinRow`, because market cap is `shares × price`
and return-since-result is measured against the result-day close: both move with the price, and
recomputing them anywhere else is how the two would drift.

**The con-call route deliberately has no equivalent.** Nothing on a con-call row moves on a tick,
so the conditional GET does the whole job there; a merge path that could drift from the server's
truth would be complexity bought for nothing.

---

## Conditional delivery and the device store

Every `GET /api/*` route answers with a content-derived `ETag` and answers a matching
`If-None-Match` with a **bodyless 304** (`worker/http.mjs`, shared by the Worker and any local
stand-in so the two cannot drift). The dashboard keeps the last payload it received in IndexedDB
and paints from it before touching the network.

Measured in Chromium, Earnings Hub: **cold 2,388KB → reload 5KB → one unchanged poll 0.3KB.**
Before this, one open tab pulled 1,135KB per tick — about 136MB an hour — to be told nothing
had changed.

| Field / key | Where | Meaning |
| --- | --- | --- |
| `ETag` / `meta.contentTag` | every `/api/*` response | the payload's content tag. Identical values, so a caller that cannot read the header (cross-origin without `expose-headers`) finds it in the body. |
| `meta.structureTag` | `/api/earnings`, both representations | identity + reported figures, price excluded. |
| `x-sattva-cache` | every `/api/*` response | `miss` / `hit` / `derived` / `fallback`, and `…-304` when the body was withheld. |
| `sattva-cache` → `payloads` | IndexedDB | `{ tag, savedAt, value }` under `earnings:<subType>`, `earnings:<subType>:prices`, `concalls`, `calendar:<date>`. |

The rules that make it safe to trust:

- **The tag covers content, never delivery.** `VOLATILE_KEYS` in `worker/http.mjs` drops
  `fetchedAt`, `servedAt`, `resolvedOnTheFly`, `unresolved`, `headFresh` and `contentTag` itself
  before hashing. Include any of them and the tag changes on every request while the payload does
  not, so the 304 never fires and the whole scheme silently does nothing. The test that catches
  this is a tag that survives an **edge-cache expiry**, where the Worker really has gone back
  upstream and re-stamped the timestamps.
- **The store holds the server's own bytes under the server's own tag.** Price updates from the
  projection are folded into memory and never written back. A locally patched value under a tag
  that no longer describes it would make the next 304 a lie.
- **Two freshness facts, never merged.** `meta.fetchedAt` is when the upstream was read;
  `meta.checkedAt` is when we last confirmed that reading was still current. A 304 moves the
  second and not the first. `meta.origin` (`live` / `store` / `snapshot`) says where the paint on
  screen came from, and `deliveryNote()` in `js/ui/sources.js` renders all three behind each
  tab's Live pill.
- **The client must not send `If-None-Match` itself.** Chromium aborts a hand-rolled conditional
  fetch whose response is a 304 with `net::ERR_ABORTED`; because pollers swallow optional errors,
  the symptom is a feed that quietly stops updating rather than an error. `conditionalJson` uses
  `cache: 'no-cache'` and lets the browser send the validator, then compares the response ETag
  against the stored one before reading the body so an unchanged tick still skips the parse.
- **A store miss is not an error** — it means "fetch it". Private windows and disabled storage
  fall back to an in-memory Map; `isPersistent()` reports which, and the UI says so.

---

## `GET /api/concalls` — LIVE, the con-call scan (StockScans)

```jsonc
{
  "ok": true, "degraded": null,
  "rows": [{ "companyKey": "164", "companyId": "NSE:EPL", "ticker": "EPL", "name": "EPL Ltd",
             "industry": "Packaging - FMCG/Consumers", "when": "2026-08-11T18:00:00+05:30",
             "date": "2026-08-11", "resultScore": 61.7, "sentimentTier": 3, "notesReady": true,
             "tags": ["▲ Revenue guidance raised to high teens", "…"],
             "ssUrl": "as-…pdf", "pptSsUrl": "…pdf" }],
  "upcoming": [{ "ticker": "LANDMARK", "name": "Landmark Cars Ltd", "when": "2026-08-12T09:00:00+05:30" }],
  "today":    { "day": "2026-08-12", "rows": [ … ] },
  "meta": { "quarter": 202606, "total": 877, "headRows": 50, "tailRows": 827, "truncated": false,
            "fetchedAt": "2026-08-11T…Z", "contentTag": "2a4926653eb47e5e" }
}
```

`upcoming` is what the **Upcoming Concalls** overlay renders: every call StockScans have listed
but not yet seen held, grouped by `date` in the browser and shown newest-day-first. `today` is a
strict SUBSET of `upcoming`'s entries for the current date — the ones still ahead of now (43 of
today's 64, in the pull above) — so the overlay uses `upcoming` alone. Merging them would
double-count and then need de-duplicating for nothing: the 09:00 call still belongs on today's
page at 15:00, it has simply already happened.

The body carries **no "served at" stamp**, deliberately: it would differ on every request while
the content did not, so the ETag would never match and the 304 this route depends on would never
fire. `meta.fetchedAt` — when StockScans was actually read — is the honest freshness signal, and
the client stamps its own `checkedAt` on every poll, 304s included.

**The scores are StockScans', not ours.** `resultScore` (0–100), `sentimentTier` (0–4) and the
`tags` bullets are their analysis of each call, reproduced unchanged. The tier bands in
`public/js/data/stockscans-shared.js` — 80 Excellent / 60 Strong / 40 Average / 20 Weak / Poor,
and 4 Bullish → 0 Bearish — are lifted from their own client so a label we print is a label they
print. See *Reproducing someone else's analysis* in CLAUDE.md before touching any of it.

### Two caches on one route, because the feed is newest-first

A quarter is ~880 calls over 18 pages of 50. Re-pulling all eighteen every 30 seconds to catch one
new row would be slow and rude. But `when` descends monotonically from offset 0 — verified across
a full quarter — so **a call that has just been analysed can only appear on page one**:

| Part | Offsets | TTL | Why |
| --- | --- | --- | --- |
| head | 0–49 | 30s | the freshness path; everything new lands here |
| tail | 50+ | 10 min | it cannot change |
| schedule | — | 2 min | today + upcoming, two small calls |

The head is merged **over** the tail (`mergeScans`), keyed on `companyKey|when`, so a row whose
analysis landed between the two fetches is taken from the head with its score rather than from the
tail without one. Steady state is one upstream request per 30 seconds instead of eighteen.

### The change worth repainting for is not a new row

A call joins the feed when it is **held** and gains its score some minutes later. So the client's
fingerprint covers `resultScore`, `sentimentTier`, `notesReady` and the tag count as well as
identity, and `newArrivals()` counts *newly analysed* as an arrival alongside *newly listed*.
`resultScore: null` renders **pending**, never zero — a zero would claim StockScans had assessed
the call and found it worthless.

**Upstream**: `POST /api/company/concall-scan` (body `{offset}`), `POST …/upcoming`, `GET …/today`
on `www.stockscans.in`. No auth, no bot wall, `robots.txt: Allow: /` — it answers a Cloudflare
Worker the same way it answers a laptop, unlike the Moneycontrol calendar page.

**Consumed by** — `js/data/concall-scans.js` → the Con-call tab: the scan table, and the
**Upcoming Concalls** overlay built from `upcoming`.

---

## `public/data/concall-scans.json` — the con-call snapshot

Same payload shape as the route above, committed by `scripts/scrape-concalls.mjs` (~460 KB). First
paint and the Worker's fallback, exactly like the earnings snapshot — not what makes the tab
fresh. The script refuses to write an empty file.

---

## Concall Deep Dive — a SEPARATE dashboard, called on demand

The **Deep Dive** column on the scan table hands one company to a different Cloudflare Worker,
which runs its own LLM pipeline over that company's call and publishes a report. This dashboard
triggers it, mirrors its progress, and lays out what it returns. **Nothing here goes through our
Worker, nothing is cached in `public/data/`, and nothing is committed.**

**Client** — `public/js/data/deep-dive.js` (transport) and `public/js/concall/deep-dive.js` (panel).

### Where the base URL lives

`https://concall-sattva.tech-441.workers.dev`, set as `window.SATTVA_DEEPDIVE_URL` in
`public/index.html`. That Worker has no custom domain, so the address is whatever Cloudflare
assigned it and nothing can derive it — which is why it is written down rather than constructed.

`baseUrl()` reads `localStorage['sattva:deepdive-base']` **first** and falls back to the global, so
a reader (or the verification suite) can point the column somewhere else without touching the
page. If neither is set the column renders a *Connect* step instead of a broken button.

### The three routes it uses — and only one of them costs anything

| Call | Sends | Returns | Cost |
| --- | --- | --- | --- |
| `GET /api/summary` | — | `{ ok, version, count, summaries[] }` — every report they already hold, with `slug`, `ticker`, `company`, `quarter`, `verdict`, `generated_at` | free |
| `GET /api/report?slug=` | — | `{ ok, slug, status, stage?, message?, report?, partial? }` | free |
| `POST /api/analyze` | `{ company, ticker?, force? }` | `{ ok, slug, status }` — `status: "done"` means a cached report was reused and no run started | **a real LLM + compute run** |

`status` is one of `queued` \| `running` \| `done` \| `error` \| `unknown`. **`unknown` is not a
failure** right after a dispatch — it is KV propagation lag, and the panel shows it as the first
step of the checklist. Polling is every 4s with a 25-minute ceiling, just past their own ~20.

**A running response carries a bare stage key and nothing else** — `{ ok, slug, status: "running",
stage: "research" }`. There is no `message` field, so anything that looks like one on screen would
have been written here. `STAGES` in `public/js/data/deep-dive.js` is their own key → label →
percentage table, copied from their frontend, and the panel renders their screen from it: label,
percentage, bar and a seven-step checklist. An unrecognised key resolves to the first stage rather
than blanking the panel.

**Reopening reattaches by itself.** `resume(slug)` polls and never dispatches, so it is safe to run
unprompted: closing the panel leaves the run alone upstream, and opening it again lands on live
progress, or on the finished report, or — if the slug has aged out of their store — quietly on the
confirm step.

`slug` is **always theirs**, derived server-side. Never construct one here. It is remembered per
ticker in `localStorage` under `sattva:deepdive-slugs` so closing the panel and reopening
reattaches to a run in flight rather than dispatching a second one, and `<BASE>/#/report/<slug>`
deep-links to their own rendering.

### A DISPATCH COSTS MONEY; A READ DOES NOT. The integration is built on that line

Their `POST /api/analyze` is **unauthenticated** and every accepted call dispatches a real LLM +
compute run. The reads are plain GETs with no pipeline behind them. So:

- **Nothing that costs a run ever fires on its own.** No poller registers this, no row triggers it
  on render, the cell is a button and nothing else, and the first click opens a **confirm** step
  that says a run costs compute before anything is sent. "Re-run from scratch" on a finished report
  returns to that same confirm step rather than dispatching on the click.
- **The free index IS fetched unprompted**, once per page load — never polled, never per row. It
  is what lets a row say *"report ready"* instead of making the reader pay to find out. Rows it
  names get a filled button and open through `resume(slug)`, which only polls.
- Reopening a panel uses `resume(slug)` too. Their API would dedup a second `POST` anyway, but not
  asking at all is the version that cannot cost a run through a bug of ours.
- The dot on an outlined button means *this browser* has dispatched a run for that ticker; the
  filled button means *they* hold a finished report. Different facts, different marks.

### The report is theirs, and the renderer never pretends otherwise

Same rule as the StockScans scores above and the Trendlyne holding values below: we reproduce, we
do not recompute. The panel adds no scoring, no re-banding and no judgement, says whose analysis it
is at the top of every finished report, and links to their own rendering of it.

**The renderer is shape-driven, not field-driven.** `report`'s schema lives in *their* repo and is
expected to grow, so sections render **in their own key order** — reordering them would be this
dashboard editing their report — and each is drawn from its *shape*: a uniform array of short
scalars becomes a table, an array carrying prose becomes cards titled by their first field, a flat
object becomes a definition grid. Nothing keys off a field name except `meta`, which is provenance
and gets a purpose-built strip, and two cosmetic hints (`*_url` renders as a link, `quote` renders
as a blockquote). A section they add next month arrives laid out rather than dropped or dumped as
JSON. Today's payload is `meta`, `about`, `concall`, `key_takeaways`, `thesis`, `anti_thesis`,
`financials`, `valuation`, `next_steps`, `earnings`, `call_over_call` — **none of that list is
hard-coded anywhere.**

Every string is escaped and only `http(s)` values ever become anchors — this is external content
and none of it reaches the DOM as markup.

**Quoted speech is real speech.** A report carries transcript quotes attributed to named
executives and named sell-side analysts. That is the opposite of the synthetic-speech case
CLAUDE.md forbids: the words are lifted from a filed transcript by their pipeline, not invented,
nothing here edits them, and `meta.sources.transcript_url` links the filing they came from. If
that ever stopped being true, this panel would have to stop rendering quotes rather than caveat
them.

**The panel is titled from our row; the report is titled from theirs.** If `report.meta.ticker`
contradicts the row's ticker, the panel says so in a rose banner instead of quietly presenting one
company's analysis under another's name. That is the worst failure this feature could have, and a
slug is resolved in two places (their index, and this browser's memory of a dispatch), so it is
checked rather than assumed.

`partial: true` means they could not fill every field; the panel says so in amber rather than
rendering the gaps as if complete.

---

## `GET /api/earnings-calendar` — LIVE, who is *scheduled* to report

```
GET /api/earnings-calendar?date=YYYY-MM-DD&from=YYYY-MM-DD&to=YYYY-MM-DD
```

```jsonc
{
  "ok": true,
  "date": "2026-08-13",
  "from": "2026-08-06", "to": "2026-08-27",   // strip window; defaults to date-7 .. date+14
  "asOnDate": "11/08/2026",                    // Moneycontrol's own "schedule as on"
  "scheduledCount": 206,                       // COMPLETE count for `date`
  "listCap": 20, "capped": true,               // …and how many of them we can name
  "days": [{ "date": "2026-08-13", "displayDate": "13 Aug", "count": 206 }],
  "rows": [{ "scId": "SE20", "name": "Solar Industries India", "ticker": "SOLARINDS",
             "industry": "Commodity Chemicals", "resultDate": "2026-08-13",
             "quarter": "Q1 FY26-27", "time": null, "ltp": 18770, "changePct": -1.2,
             "marketCap": 169849.83, "mcUrl": "https://…" }]
}
```

**Two upstreams, and the asymmetry between them is the whole story.**

| What | Where from | Complete? |
| --- | --- | --- |
| The count on each date | `api.moneycontrol.com/mcapi/v1/earnings/result-calendar?fromDate&toDate&indexId=N` | **Yes** — clean JSON, unpaginated, not behind Akamai |
| The company list for a date | the calendar page's `__NEXT_DATA__` server props | **No** — the 20 largest by market cap |

The list cannot be widened. `?page=`, `?limit=`, `?pageNo=` and every other name are echoed back into
Next.js's `query` and ignored; `/_next/data/<buildId>/…json` — the route the site's own "load more"
uses — is 503'd by Akamai for non-browser clients; and every plausible JSON path under
`/mcapi/v1/earnings/` 404s. So `scheduledCount` and `rows.length` are different numbers on a busy
day, both travel in the payload, and **the UI must print both**. Twenty rows under a bare heading
would assert that twenty companies report when two hundred do.

**Identity is resolved live, always.** A company that has not reported yet is by definition absent
from a map built from companies that have, so almost every calendar row would arrive with no ticker.
The Worker resolves them per cache window, bounded by the page's own 20-row cap.

### The Akamai wall — why the list is usually a capture

`api.moneycontrol.com` is open. `www.moneycontrol.com` is behind Akamai Bot Manager, and it does
not answer everyone the same way: an ordinary client (a laptop, a GitHub runner) gets the real
server-rendered page, while a **Cloudflare Worker gets HTTP 200 with a body that carries no
`__NEXT_DATA__` at all**. Since the company list exists only inside that page, the deployed Worker
cannot read it — which is exactly what shipped broken the first time, showing counts and an amber
"the page shape has changed".

So the list has two possible origins, and the payload names which one it used:

| `listSource` | Where from | UI |
| --- | --- | --- |
| `live` | the calendar page, read at request time | green **Live** pill |
| `snapshot` | `public/data/earnings-calendar.json`, captured by the scheduled job | sky **Captured** pill + the capture's age under the table |

`fetchCalendarDay()` throws a typed `CalendarPageBlocked` for "200 but no app payload" and a plain
`Error` for "Next.js payload present but `resultCalendarData` missing" — the first falls back, the
second is a genuine shape change and should be fixed rather than papered over.

**The counts stay live in both cases.** That is the safeguard: if the schedule has moved since the
capture, the live count and the captured list disagree in front of the reader instead of agreeing
with each other and being wrong together. Cached 5 minutes at the edge — a schedule moves in hours,
not ticks.

> An earlier version of this file said there was deliberately no snapshot, on the grounds that a
> stale schedule looks exactly like a fresh one. That was right about the danger and wrong about the
> remedy: the fix for "you cannot tell how old this is" is to stamp it, not to have no fallback.

---

## `public/data/earnings-calendar.json` — the calendar capture

Written by `scripts/scrape-calendar.mjs`, which runs on the GitHub runner where the calendar page
answers normally. Default window is today−3 to today+21; only dates with a non-zero count are
fetched, so a three-week window costs ~15 page requests, not 25.

```jsonc
{
  "capturedAt": "2026-08-11T17:33:56.533Z",   // the UI prints this as a relative age
  "from": "2026-08-08", "to": "2026-09-01",
  "listCap": 20,
  "days":   [{ "date": "2026-08-13", "displayDate": "13 Aug", "count": 206 }],
  "byDate": { "2026-08-13": { "rows": [...], "scheduledCount": 206, "capped": true, "asOnDate": "11/08/2026" } }
}
```

**A run that captured nothing leaves the previous file alone** and exits non-zero. Overwriting a
good capture with an empty one would make the tab say "nobody reports" rather than "we did not
manage" — the same class of error as serving an empty live feed as success.

**`time` is null, not "Time Not Available".** That is the upstream's string for "unknown"; carrying
it into a Time column would render a sentence where a clock belongs. Null renders as a dash, which
already means *not known* everywhere else here.

**Consumed by** — `js/data/earnings-calendar.js` → the Earnings Hub's Calendar view.

---

## `public/data/earnings-live.json` — the snapshot

The same payload shape as the route above, committed by `scripts/scrape-earnings.mjs`. Two jobs:
**first paint** (so the table is populated before any network round-trip, and works on a plain
`python3 -m http.server`) and the **Worker's fallback**. The live poll replaces it within seconds.

YoY only — see the `subType` rules above for why there is no QoQ counterpart.

Refreshing it more often would not make the tab fresher — the tab is live off the route. It only
bounds how stale the fallback can be. ~900 KB.

---

## `public/data/mc-ticker-map.json` — the join

`scID → { ticker, bseId, fullName, industry, shares, mktCapAtBuild }`, resolved from
`priceapi.moneycontrol.com`. **This file is the whole integration.** Moneycontrol identifies
companies by its own code and truncates display names to 15 characters — "Jubilant Pharmo",
"Embassy Develop" — so neither is usable as a join key without silently mis-joining look-alikes.

Two things worth knowing:

- **It is incremental.** Entries are written once; a rerun costs one request per never-before-seen
  company. A full build of 1,319 took about six minutes; a daily run costs a handful.
- **`shares` is stored, market cap is not.** The browser computes `shares × live price` on every
  poll, so the MCap column is current rather than as-of the last refresh. Verified against
  Moneycontrol's own figure: 887,786,160 × ₹5,131.70 = ₹455,585 Cr, exactly what they publish.
  `REFRESH_ALL=1` re-resolves everything, which is how share counts pick up a buyback or an issue.

Anything with no NSEID lands in `unresolved` and renders without a ticker. Current coverage:
**1,319 of 1,319 resolved, 0 unresolved.** ~190 KB.

---

## `public/data/result-returns.json` — the base of the return column

`TICKER@YYYY-MM-DD → { close, pricedOn }`, from Yahoo, written by
`scripts/scrape-result-returns.mjs`.

"Return since result" is `(price now − close on the result date) / close on the result date`. The
second half arrives live with every poll; the first half is a closing price on a date already past
and **will never change again**. So it is cached once and never recomputed, and the column is live
without anyone refetching a single historical price.

**Convention:** the base is the **close on the result date** — the last price at which the market
could trade without knowing the numbers, since Indian results are usually announced after the
close. If that day was not a trading day the previous close is used, and `pricedOn` records which.
Keys in `failures` render as "—", never 0%. Current coverage: **1,312 of 1,319**. ~80 KB.

---

## `public/data/mock/earnings.json` — MOCK, real-shaped

Eight quarters of results per company: everything the 15-rule Result Quality & Growth model in
`js/scoring/earnings-scoring.js` scores. Root is an **object** with a metadata envelope and a
`companies[]` array.

> **Illustrative data.** The 120 company names, tickers, sectors, industries and market caps are
> real — stride-sampled from `universe.json`. **Every financial figure is synthetic**, produced by
> `scripts/gen-mock-earnings.mjs` from a seeded PRNG (`SEED = 20260810`, so the file regenerates
> byte-identically). No number in this file is a reported figure. The UI is required to say so —
> see *Provenance surface* below.

```jsonc
{
  "_provenance": "ILLUSTRATIVE DATA. Company names, tickers, sectors and market caps are real …",
  "generated_at": "2026-08-10T10:41:45.675Z",
  "generator": "scripts/gen-mock-earnings.mjs",
  "seed": 20260810,
  "source": "Mock data",              // the flag the UI keys every honesty marker off
  "quarter": "Q1FY27",
  "season_start": "2026-07-10",
  "season_end": "2026-08-08",
  "company_count": 120,
  "companies": [
    {
      "ticker": "PGHH", "name": "P & G Hygiene",
      "sector": "Fast Moving Consumer Goods", "industry": "Personal Products",
      "marketCap": 27582, "screenerUrl": "https://www.screener.in/company/PGHH/",
      "quarter": "Q1FY27", "reportedOn": "2026-07-31",
      "archetype": "decelerating",
      "quarters": [                    // exactly 8, OLDEST FIRST; index -1 is the latest
        {
          "quarter": "Q2FY25",
          "revenue": 718.7, "operatingProfit": 120.9, "opm": 16.82,
          "netProfit": 76.3, "npm": 10.61, "eps": 2.3,
          "otherIncome": 10.8, "pbt": 103.2, "taxExpense": 26.9, "exceptionalItems": 0
        }
        // … 7 more
      ],
      "consensus": { "eps": 2.36, "revenue": 786.5 },
      "segments": [{ "name": "Home care", "revenue": 279.6, "share": 37.3 }]
    }
  ]
}
```

### Envelope

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `_provenance` | string | — | Plain-English statement of what is real and what is not. Shown verbatim nowhere; it exists so the file is self-describing on disk. |
| `generated_at` | string | ISO 8601 UTC | Generation time. **Not a filing time** — the freshness card must say so while `source` is mock. |
| `generator` | string | repo path | Named in the Sources modal. Omit on a real feed. |
| `seed` | number | — | PRNG seed. Omit on a real feed. |
| `source` | string | free text | **The honesty switch.** `js/data/earnings.js` sets `meta().isMock = source.toLowerCase().includes('mock')`. Every ribbon, badge and export banner keys off it. A real feed sets e.g. `"BSE/NSE corporate filings"` and all mock markers disappear on their own. |
| `quarter` | string | `Q<n>FY<yy>` | The season being reported, e.g. `Q1FY27` = Apr–Jun 2026. |
| `season_start` / `season_end` | string | `YYYY-MM-DD` | Range the `reportedOn` dates fall in. |
| `company_count` | number | — | Must equal `companies.length`. |

### `companies[]`

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `ticker` | string | NSE symbol | Join key against `universe.json` and `technicals.json`. Uppercased for lookup. |
| `name` / `sector` / `industry` | string | — | Real, from `universe.json`. |
| `marketCap` | number | ₹ crore | Real. Drives the Quality & Growth scatter's x-axis. |
| `screenerUrl` | string | URL | Deep link in the drill panel header. |
| `quarter` | string | `Q<n>FY<yy>` | The quarter this company just reported. |
| `reportedOn` | string | `YYYY-MM-DD` | Declaration date. Orders the Latest Results table. |
| `archetype` | string | see below | **Generator artefact.** Records which behaviour profile produced the numbers. A real feed omits it; nothing in the UI scores off it. |
| `quarters[]` | array | exactly 8 | **Oldest first.** The model reads `at(-1)` = latest, `at(-2)` = previous, `at(-5)` = year-ago. Fewer than 5 entries makes every YoY rule return `na`. |
| `consensus` | object | — | `{ eps, revenue }`. Street estimates for the latest quarter. Absent ⇒ both Surprise rules return `na`. |
| `segments[]` | array | — | `{ name, revenue, share }`. Revenue split for the latest quarter, rendered as the drill panel's share bar. Optional; the bar is skipped when absent. |

### `companies[].quarters[]`

| Field | Type | Unit | Notes |
| --- | --- | --- | --- |
| `quarter` | string | `Q<n>FY<yy>` | Label for the mini-table column. |
| `revenue` | number | ₹ crore | Consolidated. |
| `operatingProfit` | number | ₹ crore | EBITDA less depreciation — the operating line. May be negative. |
| `opm` | number | percent | `operatingProfit ÷ revenue × 100`, pre-rounded to 2dp. The margin rules read this field rather than recomputing, so a real feed must supply it (or the loader must derive it). |
| `netProfit` | number | ₹ crore | PAT. Negative ⇒ `pat_yoy` hard-fails and the row carries a red flag. |
| `npm` | number | percent | `netProfit ÷ revenue × 100`, 2dp. |
| `eps` | number | ₹ per share | Reported EPS. |
| `otherIncome` | number | ₹ crore | Non-operating income. |
| `pbt` | number | ₹ crore | Profit before tax. `other_inc` and `tax_rate` return `na` when this is ≤ 0. |
| `taxExpense` | number | ₹ crore | Current + deferred. |
| `exceptionalItems` | number | ₹ crore | `0` means a clean quarter. Any non-zero value fails `exceptional`, gain or charge. |

`archetype` is one of `compounder`, `steady`, `accelerating`, `decelerating`, `cyclical`,
`pressured`, `lossmaker`, `turnaround`.

### Provenance surface

While `source` contains "mock", four things are contractually required to say so — §6 of the
brief. All four read `meta().isMock`; none needs touching when the real feed lands:

1. a persistent amber ribbon at the top of every Earnings Hub sub-view;
2. the gradient freshness card reading **"Mock data · Generated `<date>` · not a filing time"**;
3. the Sources modal listing all three earnings rows as `mock` and naming the generator script;
4. an amber banner as row 1 of **every sheet** in the Excel export.

The drill panel adds a fifth: an amber "Illustrative figures" note above the quarterly series.

### Wiring the real feed

Swapping in real filings is a **one-file change plus one path**:

1. Write the real payload to `public/data/earnings.json` in exactly the shape above, with
   `source` set to something that does not contain "mock" (e.g. `"BSE/NSE corporate filings"`),
   and drop `generator`, `seed` and `archetype`.
2. Point `EARNINGS_PATH` in `js/data/earnings.js` and the `earnings` entry in `DATA_SOURCES`
   (`js/app.js`) at the new path.
3. Flip the three `status: 'mock'` entries in `js/ui/sources.js` to `live`.

Nothing else changes: the scoring model, all three sub-views, the drill, the scans, the export
and the poller already read this shape. To poll a live endpoint instead of a file, swap
`live.mockFetcher(EARNINGS_PATH, …)` for `live.realFetcher('/api/earnings')` in `registerPoller`.

**Refresh cadence** — event-driven during results season (Jan/Apr/Jul/Oct), then idle. The
in-page poller re-reads and **re-scores** every 45s while the tab is open and visible.
**Real source** — BSE/NSE corporate filings for the reported figures; Screener.in or Trendlyne
for consensus estimates.
**Consumed by** — Earnings Hub (all three sub-views), Breakouts → Earnings Surprise.

> **Legacy adapter.** Breakouts → Earnings Surprise predates this shape and reads a flat
> one-row-per-company summary (`ticker`, `revenueCr`, `revenueYoyPct`, `netProfitCr`,
> `epsActual`, `epsEstimate`, `surprisePct`, `resultTag`, …). `adaptLegacySummary()` in
> `js/data/earnings.js` derives it, and `app.js` hands the result to `ctx.data.earnings` — so
> that view needed no changes and needs none when the real feed lands. `ctx.data.earningsRaw`
> carries the full payload. Same pattern as `js/data/universe.js`.

---

## `public/data/mock/earnings-calendar.json` — MOCK

Companies **yet to report** this season. Drives the Earnings Hub's upcoming-results strip only;
nothing is scored off it.

```jsonc
{
  "_provenance": "ILLUSTRATIVE DATA. Company names and tickers are real; the scheduled dates are synthetic …",
  "generated_at": "2026-08-10T10:41:45.693Z",
  "generator": "scripts/gen-mock-earnings.mjs",
  "seed": 20260810,
  "source": "Mock data",
  "from": "2026-08-11",
  "to": "2026-09-09",
  "quarter": "Q1FY27",
  "event_count": 52,
  "events": [
    {
      "ticker": "IRCTC", "name": "I R C T C", "sector": "Consumer Services",
      "marketCap": 41596, "date": "2026-08-11", "quarter": "Q1FY27", "confirmed": true
    }
  ]
}
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `from` / `to` | string | `YYYY-MM-DD` | Window the events span. |
| `event_count` | number | — | Must equal `events.length`. |
| `events[].ticker` / `name` / `sector` | string | — | Real, from `universe.json`. |
| `events[].marketCap` | number | ₹ crore | Real. Orders the strip — biggest first within a day. |
| `events[].date` | string | `YYYY-MM-DD` | **Synthetic.** Board-meeting date. |
| `events[].confirmed` | boolean | — | `true` = exchange-confirmed, `false` = expected. Rendered as a dashed vs solid chip. |

The file is **optional**: `js/data/earnings.js` catches a failed fetch and falls back to
`{ events: [] }`, which hides the strip rather than breaking the tab.

**Refresh cadence** — daily during results season.
**Real source** — NSE/BSE board-meeting filings.
**Consumed by** — Earnings Hub → Latest Results (the upcoming strip).

---

## Retired: the synthetic transcript corpus

`concall-calls.json` (2.0MB of generated transcripts), `concall-keywords.json` and
`catalysts.json` are **gone**, along with `js/data/concalls.js`, the keyword engine, the keyword
editor, the Con-call Deep Dive workspace and `scripts/gen-mock-concalls.mjs`.

They powered four sub-views of the Con-call tab — Live Feed, Keyword Scan, Catalysts, Deep Dive —
on invented speech attributed to fictional speakers, because no open source publishes full
transcript text. That put a synthetic half and a live half in one tab, held apart by an amber
ribbon. The tab is now one live table off StockScans plus the schedule overlay, with one
provenance and no ribbon.

**If a real transcript feed is ever wired**, BSE's filed transcript PDFs are the source, and the
engine and workspace are recoverable from git history — pointed at real text rather than
generated text, which is the only version worth having. Their contracts are in that history too.

## `public/data/mock/chatter-valuepickr.json` — MOCK

40 forum threads, one per company. Root is an object with a metadata envelope and `threads[]`.

> **Illustrative data.** Company names, tickers and sectors are real. Every thread, post, count
> and sentiment reading is synthetic, from `scripts/gen-mock-chatter.mjs` (`SEED = 20260812`).
> **Every handle is fictional** and the thread URLs do not resolve — the same rule the con-call
> analysts follow, for the same reason: a forum handle belongs to a real person, and attaching
> invented opinions to one misattributes speech.

```jsonc
{
  "_provenance": "ILLUSTRATIVE DATA … ALL HANDLES ARE FICTIONAL …",
  "generated_at": "2026-08-11T04:00:00.000Z",
  "generator": "scripts/gen-mock-chatter.mjs",
  "seed": 20260812,
  "source": "Mock data",            // the flag the UI keys every honesty marker off
  "as_of": "2026-08-11",
  "thread_count": 40,
  "threads": [
    {
      "threadId": "vp-001", "ticker": "PGHH", "name": "P & G Hygiene",
      "sector": "Fast Moving Consumer Goods",
      "title": "P & G Hygiene — what the market is missing",
      "url": "https://forum.valuepickr.com/t/p-g-hygiene/48221",
      "category": "Company analysis",
      "createdAt": "2024-03-18T12:04:00+05:30",
      "lastPostAt": "2026-08-10T19:41:00+05:30",
      "postCount": 412, "participantCount": 37,
      "posts7d": 24, "postsPrior7d": 11,
      "weeklyPosts12w": [9, 14, 7, 12, 18, 11, 6, 15, 9, 13, 11, 24],
      "sentiment": 0.42,
      "topContributors": [{ "handle": "value_ledger", "posts": 9 }],
      "recentPosts": [
        { "handle": "moat_diary", "at": "2026-08-10T19:41:00+05:30",
          "text": "Added a tracking position…", "sentiment": 0.35, "likes": 12 }
      ],
      "claims": [
        { "text": "Capacity expansion announced in the last exchange filing.",
          "kind": "fact", "at": "2026-08-02T11:12:00+05:30" }
      ]
    }
  ]
}
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `threadId` | string | `vp-NNN` | Stable key; used in the URL and the drill. |
| `ticker` / `name` / `sector` | string | — | Real. `ticker` is the join key to technicals. |
| `title` / `url` / `category` | string | — | **Synthetic.** The URL does not resolve. |
| `createdAt` / `lastPostAt` | string | ISO 8601 +05:30 | `createdAt` drives "first mention" on Trending. |
| `postCount` | number | count | Lifetime posts. |
| `participantCount` | number | count | Distinct posters over the window — **reach**, which is a different question from post volume. |
| `posts7d` / `postsPrior7d` | number | count | **The raw inputs momentum is derived from.** No momentum field is stored. |
| `weeklyPosts12w` | number[] | 12 counts | Oldest first; the drill's sparkline. Last element equals `posts7d`. |
| `sentiment` | number | −1 … +1 | Thread-level mean. |
| `topContributors[]` | array | `{ handle, posts }` | **Fictional handles.** |
| `recentPosts[]` | array | `{ handle, at, text, sentiment, likes }` | **Fictional handles, invented text.** |
| `claims[]` | array | `{ text, kind, at }` | `kind` is `fact` \| `speculation` \| `question`. Kept separate in the UI: a post asserting something is not the same as one wondering about it, and flattening the three would make speculation look like research. |

**Refresh cadence** — every 15 minutes. **Real source** — a ValuePickr crawler.
**Consumed by** — Public Chatter → ValuePickr and Trending.

---

## `public/data/mock/chatter-telegram.json` — MOCK

25 public groups. Same envelope, `groups[]`.

```jsonc
{
  "_provenance": "ILLUSTRATIVE DATA … ALL HANDLES AND GROUP NAMES ARE FICTIONAL …",
  "generated_at": "2026-08-11T04:00:00.000Z",
  "generator": "scripts/gen-mock-chatter.mjs",
  "seed": 20260812,
  "source": "Mock data",
  "group_count": 25,
  "groups": [
    {
      "groupId": "tg-001", "name": "Momentum Signals", "memberCount": 41200,
      "ticker": "ULTRACEMCO", "companyName": "UltraTech Cem.", "sector": "Construction Materials",
      "messages24h": 723, "messagesPrior24h": 189,
      "uniqueSenders24h": 8, "sentiment": 0.71, "forwardRatio": 0.76,
      "profile": "pumpy",
      "recentMessages": [
        { "handle": "swing_desk", "at": "2026-08-11T14:02:00+05:30",
          "text": "Breakout on the daily…", "sentiment": 0.68 }
      ]
    }
  ]
}
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `groupId` | string | `tg-NNN` | Stable key. |
| `name` | string | — | **Fictional group name.** |
| `memberCount` | number | count | |
| `ticker` / `companyName` / `sector` | string | — | Real company. |
| `messages24h` / `messagesPrior24h` | number | count | Volume and the prior day, for the spike ratio. |
| `uniqueSenders24h` | number | count | **Load-bearing.** Volume ÷ senders is what separates a discussion from a wall. |
| `forwardRatio` | number | 0 … 1 | Share of messages that are forwards rather than original posts. |
| `sentiment` | number | −1 … +1 | Mean across the window. |
| `profile` | string | see below | **Generator artefact** — which shape the group was built to have, kept so a reviewer can see whether the flag agrees. A real feed omits it, and nothing scores off it. |
| `recentMessages[]` | array | `{ handle, at, text, sentiment }` | **Fictional handles.** |

`profile` is one of `pumpy`, `borderline`, `normal`, `quiet`. Borderline groups exist on purpose:
a heuristic that only ever returns 0 or 3 is recognising two hand-built clusters, not
discriminating. The shipped set spans all four risk levels.

### The pump-risk heuristic — `js/chatter/pump-risk.js`

**No risk level is stored in the file.** It is computed at render time from the fields above, and
recomputed on every live tick, because another burst can tip a group over.

A group must first clear a **volume gate**: at least `MIN_MESSAGES_24H` (120) messages in 24h
*and* at least `MIN_VOLUME_SPIKE` (1.8×) the previous day. Without the gate the level is 0
whatever the other ratios say — sender ratios on a quiet group are noise.

Past the gate, each of three signals adds one level:

| Signal | Threshold | What it means |
| --- | --- | --- |
| Few senders, many messages | ≥ 12 messages per distinct sender | Real discussion converges near 2–4 per person. |
| Mostly forwarded | ≥ 50% forwards | Circulated, not written. |
| Uniformly bullish | mean sentiment ≥ +0.55 | Genuine discussion contains disagreement. |

`pumpRisk(group)` returns `{ level, label, gate, reasons[], firedCount, msgsPerSender, spike }`.
`reasons` carries **every** criterion, fired or not, with its measured value — the UI is required
to show them, because a risk number nobody can check is just a verdict. Thresholds are exported
as `THRESHOLDS` so the help modal quotes the same constants the code uses.

It is a **heuristic, not a finding**: it says a posting pattern is consistent with coordination,
never that a pump is happening.

**Refresh cadence** — near real-time. **Real source** — Telegram Bot API over subscribed groups.
**Consumed by** — Public Chatter → Telegram and Trending.

### The chatter live tick

`js/data/chatter.js` registers an 8s poller. Like the con-call ticker it does **not** re-fetch
either file: it picks the busiest threads and groups, increments their counters, recomputes
momentum and pump risk, and returns `{ at, events[], total }`. `live.mockFetcher` would
re-download both files every tick and jitter their numbers — and a jittered post count sitting
beside the quoted post text would simply disagree with it.

---

## `public/data/institution-holdings.json` — REAL, filed shareholdings

Every Indian company a tracked institution appears in, with what the company **filed** with the
exchanges. Written by `scripts/scrape-institution-holdings.mjs` off Trendlyne's superstar pages.

```jsonc
{
  "source": "Trendlyne — Superstar Shareholders (…)",
  "generator": "scripts/scrape-institution-holdings.mjs",
  "generated_at": "2026-08-12T…Z",
  "quarter": "Q1FY27", "quarterLabel": "Jun 2026",
  "institutions": [{
    "investorId": "smallcap-world-fund-inc",
    "name": "Smallcap World Fund Inc", "house": "Capital Group", "category": "FII",
    "trendlyneId": 54015,
    "sourceUrl": "https://trendlyne.com/portfolio/superstar-shareholders/54015/latest/…/",
    "latestQuarter": "Q1FY27", "latestQuarterLabel": "Jun 2026",
    "quarters":      ["Q1FY27", "Q4FY26", … 9 deep],
    "quarterLabels": ["Jun 2026", "Mar 2026", …],
    "stocksHeld": 37,            // holdings carrying a value — the portfolio
    "portfolioValueCr": 35818,   // their sum; cross-checked against Trendlyne's own figure
    "filedThisQuarter": 36,      // how many have actually filed for Jun 2026
    "awaitingFiling": ["JBCHEPHARM"],
    "holdings": [{
      "ticker": "AEGISLOG", "name": "Aegis Logistics",
      "sector": "Oil, Gas & Consumable Fuels", "industry": "Trading - Gas", "inUniverse": true,
      "qty": 8732412,            // FILED
      "holdingPct": 2.5,         // FILED — null where the company has not filed this quarter
      "valueCr": 1104.2,         // TRENDLYNE'S DERIVATION, not ours
      "changePp": 0.2,           // Trendlyne's published change for the quarter
      "changeNote": null,        // their label where no number applies — see below
      "pctDelta": 0.2,           // ours: this quarter's filed % minus last quarter's
      "pctByQuarter": { "Q1FY27": 2.5, "Q4FY26": 2.3, … },
      "url": "https://trendlyne.com/equity/share-holding/35/AEGISLOG/latest/…/"
    }],
    "former": [ … same shape, companies with history but no current position … ]
  }]
}
```

### Which numbers are filings, and which one is not

A shareholding filing discloses a **share count and a percentage of the company**. It never
discloses a rupee amount. So `qty` and `holdingPct` are the filing itself; `valueCr` is
**Trendlyne's derivation** — holding % × market cap — reproduced unchanged and labelled as theirs
on every surface it reaches, including the column header (`Value (Trendlyne)`), the stat card, the
drill's Provenance group and row 1 of the exported sheet. The same rule as the StockScans con-call
scores: reproduce, attribute, never re-derive.

`pctDelta` **is** ours, and it is only the difference between two filed percentages — never a
stand-in for `changePp`. On the Jun 2026 pull the two agree on every row, which is a useful check
that the history columns are being read in the right order.

### A blank percentage means NOT FILED, not sold

Companies file within weeks of a quarter closing, and not all at once. A holding can carry a share
count and a value while its percentage for the newest quarter is still outstanding — Trendlyne
label that row **Filing Awaited**, and one of the 37 Jun-2026 holdings is in exactly that state.
`holdingPct: null` renders as *not filed yet*; a zero there would report a live position as exited.

`changeNote` carries their label wherever a number does not apply. Three seen in the wild:
**New**, **Below 1% first time**, **Filing Awaited**. A filing only names holders above 1%, so
crossing that line in either direction is a disclosure event, not necessarily a trade.

### The run fails rather than shipping a wrong total

Trendlyne state the holding count and the portfolio value in prose on the page. The scraper
computes both from the rows it parsed and **refuses to write the file if they disagree** — the
parse dropping or double-counting a row is the failure mode that would otherwise look like a
clean run. They agree to the rupee on the Jun 2026 pull: 37 holdings, ₹35,818.0 Cr.

Two traps the parser is built around, both of which produce a *plausible* wrong answer:

- **Balance the `<table>` tags.** Each row has an expandable child table, so cutting at the first
  `</table>` yields three rows out of seventy-two and looks like it worked. Check the row count.
- **Key on the per-row equity link, not the visible name.** The child rows repeat the same figures
  shifted by one column and would double every holding; the link is also where the NSE ticker
  comes from, which the truncated display name cannot give.

### Adding a fund

One entry in `FUNDS` in `scripts/scrape-institution-holdings.mjs` — the `id` and `slug` come
straight out of the Trendlyne URL — then re-run it. No UI change: the Institutions view renders a
fund picker as soon as there is more than one.

---

## `GET /api/chatter` — LIVE, retail chatter (SentimentDash)

A read-through proxy onto the SentimentDash API: companies and topics trending across ValuePickr,
TradingQnA and Google News over a rolling 30 days, ranked by mention count and keyword-scored for
sentiment. Public, unauthenticated, CORS-open. Re-scraped twice daily at **01:30 and 13:30 UTC**,
so the edge holds 30 minutes and polling faster than hourly asks a question whose answer cannot
have changed.

### Four traps, and what this repo does about each

1. **`changePct` is a change in MENTION COUNT, not a price move.** There is no price, market cap
   or return anywhere in that API. It is renamed `mentionsChangePct` in `normaliseEntry`, and no
   field called `changePct` survives onto our entry — so nothing downstream can render it as a
   return by reading the field name. It must never be coloured like a P&L or given a ₹.
2. **Their `ticker` is a forum-topic slug, not an exchange symbol** — `zomato`, `fiis`,
   `3b-blackbio-dx` — and their `exchange` / `sector` are empty strings on essentially every
   entry. It travels as `slug`. Our `ticker` is null unless the resolver found a real NSE symbol.
3. **About a third of entries are not companies.** Entries are discovered bottom-up from forum
   topics, so the list carries brokers (`guggenheim`, `td-cowen`), themes (`nuclear-energy`,
   `defence`) and bare words (`value`, `growth`, `income`). In one of their runs the "top mover"
   was a broker and the "most bullish" was the word *Growth*. `overview.mostBullish` and
   `overview.topMover` are reproduced under their own names, and any surface showing them has to
   survive that or not show them.
4. **Sentiment skews ~80% neutral** (14% bullish, 6% bearish) and is keyword-scored, not
   model-scored. A design assuming a balanced bull/bear split will look broken. `reddit` is a
   valid source key that is currently 0 everywhere — it stays in the vocabulary because their
   schema has it.

Also: `sparkline` is a per-**run** series (up to 12 points, oldest first), not a per-day one. Points
are scrape runs, so nothing may put a time axis under it.

### The resolver — how "is this a company?" is decided

`buildResolverIndex()` + `resolveEntry()` in `sentiment-shared.js`. An entry is a company **when
its slug or name resolves to a symbol we already cover** — `universe.json` or the book. Everything
else is not rejected: it carries `ticker: null` and a stated reason, exactly as a book line with no
NSE symbol does in `coverage.js`.

Deliberately **not** a hand-kept list of brokers and themes to exclude — such a list is
unfalsifiable, rots silently, and makes the answer depend on what someone remembered to type.

Matching is **exact only**, unlike `resolve-portfolio-companies.mjs`, which prefix-matches. The
book is 142 lines checked by hand against a statement; this is an open-ended stream of forum topics
where `value`, `growth` and `defence` are real entries. A wrong symbol here does not fail loudly —
it files someone else's forum posts under a company you hold. An unresolved entry costs a row in
the second section; a mis-resolved one corrupts the first.

Verified against the real `universe.json` + book: `tata-motors`→`TMCV`, `hind-aeronautics`→`HAL`,
`infosys`→`INFY`, `crizac`→`CRIZAC`, `allcargo-logistics`→`ALLCARGO`, while `guggenheim`,
`td-cowen`, `nuclear-energy`, `defence`, `value`, `growth` and `fiis` all correctly resolve to
nothing.

### Response

```jsonc
{
  "ok": true, "reason": null,
  "generatedAt": "2026-08-13T14:35:02.862Z", "window": "30d",
  "overview": { "totalPosts": 603, "totalEntries": 219, "marketMood": { … },
                "mostBullish": { … }, "topMover": { … }, "sourceTotals": { … } },
  "total": 219,
  "entries": [ { "slug": "fiis", "name": "FIIs", "rank": 1, "mentions": 22,
                 "mentionsPrev": 21, "mentionsChangePct": 4.8, "direction": "up",
                 "sentiment": { … }, "sources": { … }, "activeSources": [ … ],
                 "sourceLabel": "Google News · TradingQnA", "sparkline": [ … ] } ],
  "health": { "status": "ok", "ageSeconds": 4211 }
}
```

`health.ageSeconds` is **their** figure, from their `/health` route — how stale the scrape is
according to the only clock that is authoritative about it, rather than a subtraction between
their `generatedAt` and ours.

### Failure is reported by kind, and a failed read is never an empty one

`entries: []` only ever travels with `ok: false` and a `reason`. Upstream failures return **200
with `ok: false`** — the request to *our* Worker succeeded — cached 15 seconds rather than 30
minutes, so a corrected configuration takes effect at once.

| `reason` | Means | Fix |
| --- | --- | --- |
| `no-base` | `env.SENTIMENT_BASE` is unset | set it — see below |
| `bad-base` | set, but not an http(s) URL | correct the value |
| `not-found` | 404 — wrong base, or the route moved | check the base ends in `/v1` |
| `unreachable` / `timeout` | could not reach it | wait; retried 3× with backoff |
| `upstream` | it answered with an error status | wait; 502/503/504 are retried |
| `shape` | answered, but not in the documented shape | their contract changed |

### The base URL is configuration, and its absence is a state

`env.SENTIMENT_BASE`, e.g. `https://sentimentdash-api.<subdomain>.workers.dev/v1`. A plain `var`
in `wrangler.jsonc`, not a secret — the endpoint is public and unauthenticated, so there is
nothing to leak. **There is no default and no guess**: a wrong base 404s in a way indistinguishable
from an outage and sends diagnosis in the wrong direction. Override per run with
`npx wrangler dev --var SENTIMENT_BASE:https://…/v1`.

### What the tab does with it

One view, two sections, `subviews: []`. **Covered companies** — the resolved half, scope-aware,
rows opening the technicals drill. **Not in our coverage** — everything else, whole in both scopes,
because a list with no tickers cannot be filtered by one.

Measured on a real 219-entry run: **45 covered, 174 not, 8 of them in the book.**

The synthetic corpus this tab used to render is deleted, not parked under a ribbon — the same
resolution the Con-call tab reached. Gone with it:

- **The Telegram sub-view**, because no live Telegram source exists.
- **The pump-risk heuristic**, because its gate is `MIN_MESSAGES_24H = 120` and this feed carries
  ~600 posts per scrape across 219 entries — the busiest entry in a real run had 22 mentions in
  *thirty days*. Every row would score "Clear", which is not a clean bill of health but a
  fabricated one. `pump-risk.js`, `chatter.js`, `gen-mock-chatter.mjs` and the two mock JSON files
  are in git history at `ce2aa18..`.

**Alerts fire only for book holdings, and only on first appearance.** The other two feeds announce
every arrival; chatter would otherwise fill the stack with brokers and themes and train the reader
to dismiss the component, results alerts included. The alert text carries the mention count and
their sentiment word, never `mentionsChangePct` — a percentage in a one-line notification is
exactly where it would be read as a price move.

---

## `GET /api/super-investors` and `/api/super-investors/{slug}` — LIVE, filed holdings (Finology)

The whole **Superstar Investors** view. Two routes on this Worker, proxying the Ticker Finology
super-investor API at `https://devde.muns.io` — the one upstream in this dashboard that needs a
credential.

**Modules** — `worker/finology.mjs` (HTTP client) · `public/js/data/finology-shared.js` (pure shape
guards, imported by both sides) · `public/js/data/super-investors.js` (browser feed) ·
`public/js/investors/live.js` (the view).

### The Worker exists to hold the token

`Authorization: Bearer …` is required upstream. A token in front-end code is a token published, so
the browser calls this Worker and the Worker adds the header from `env.MUNS_TOKEN`. Nothing under
`public/` has ever seen it — the same arrangement as `/api/live-prices`.

```bash
npx wrangler secret put MUNS_TOKEN     # production
echo 'MUNS_TOKEN="…"' >> .dev.vars     # local; .dev.vars is gitignored
```

`env.MUNS_BASE` overrides the upstream host, which is how local development and `verify-ui.mjs`
point at a stand-in instead of scraping somebody else's production on every run.

### Shapes

`GET /api/super-investors` → `{ ok, source, fetchedAt, count, dropped, investors[] }`, each
investor `{ name, slug, bio, imageUrl }`. `dropped` counts rows the upstream returned without a
usable slug — the slug is the only way to fetch a book, so a card without one is a dead end and is
not rendered. Reporting the count keeps `count` and what is on screen from disagreeing silently.

`GET /api/super-investors/{slug}` → `{ ok, source, fetchedAt, name, slug, netWorthCr, activeStocks,
totalStocks, quarters[], holdings[] }`, each holding `{ company, companySlug, quarterlyHoldings,
valueCr }`. `quarters` is the ordered column set, newest first, and keys `quarterlyHoldings`.

Slugs are `[a-z0-9-]` only — anything else is a 400 here rather than a 400 upstream. An unknown
investor is a 404.

### A BLANK QUARTER MEANS NOT DISCLOSED, NEVER ZERO

Finology print `-` where a holder is absent from that quarter's shareholding pattern. Indian
companies only name holders above a threshold, so a real position below it is **invisible in the
filing**. `null` therefore travels unchanged all the way to the cell, which renders an em dash and
is excluded from every total.

Two consequences that are easy to get wrong:

- A position disappearing is **"no longer disclosed"**, not "sold". The UI says exactly that.
- `deriveMoves` classifies an appearance as `new` and a disappearance as `exited` but gives
  **neither a percentage-point figure**. Printing ±the whole holding would invent a trade size.

### One derived figure, and it is labelled

`deriveMoves()` subtracts the prior quarter's disclosed percentage from the latest, per company.
That is the only computation this dashboard performs on the feed; everything else is reproduced.
It appears under the heading **Change (derived)**, and the stat card and help modal say so. An
investor with only one published quarter is not comparable and contributes nothing, rather than
counting as entirely new.

`valueCr` is **Finology's** derivation from a percentage and a market cap — a shareholding filing
never states a rupee amount. Same relation as Trendlyne's value column on Institutions: reproduced,
headed **Value (Finology)**, never recomputed.

The combined-book total sums only positions **still disclosed in the latest quarter**, and only
those carrying a value, and says how many of each. Summing all history produced a card reading
`0 holdings` beside `₹793 Cr book`; the count and the total now use the same set.

### Caching, and why the fan-out is on the client

Each upstream call is a live scrape of finology.in, and shareholding data moves once a quarter. So
the edge holds each response for **six hours** and the browser revalidates against our ETag for a
bodyless 304. Each book is stored on the device under its own key (`investor:<slug>`), so a quarter
landing for one investor does not invalidate the other fifty.

The list is one request and each book is another; the client walks them **four at a time**,
painting as they land. There is deliberately no `?full=1` that would fetch every book in one
request — a cold cache would become sixty simultaneous page reads on their service.

### Failure is reported by kind

An upstream or credential failure returns **200 with `ok: false` and a `reason`** — the same shape
`/api/concalls` uses for `degraded`, because the request to *this* Worker succeeded and the body is
what explains the rest. `reason` is one of `no-token`, `unauthorised`, `route-missing`, `timeout`, `unreachable`,
`upstream`, `shape`; the view renders a named explanation for each, and `no-token` /
`unauthorised` name the `wrangler secret put` that fixes them.

**`route-missing` versus `not-found`.** A 404 means different things on the two routes, so they are
not one reason. On `/super-investors/{slug}` it means no such investor. On the bare list route
there is no investor being looked up, so the only thing it can mean is that **the endpoint is not
deployed on the host being called** — which is exactly what happened in production: the token was
correct, and `devde.muns.io` returned 404 because it has no such route. Conflating the two made the
panel say *"No such investor"* about a missing deployment.

**Transient failures are retried.** The upstream is a live scrape and visibly flaps — observed
returning 502, then timing out, then 200, within a minute. `call()` makes up to `ATTEMPTS` (3)
attempts with a 15s ceiling each and 400ms/1200ms backoff, retrying only `unreachable`, `timeout`
and 502/503/504. A 401 or a 404 is an answer, not a blip, and is never retried. Error responses are cached for **15 seconds**, not six
hours, so pasting a working token takes effect immediately.

`holdings: []` never travels without `ok: false` beside it — a book that failed to load must not be
able to read as an investor who holds nothing. The card says "could not be read" instead.

---

## `public/data/mock/superinvestors.json` and `institutions.json` — MOCK

> **`superinvestors.json` no longer reaches the Superstar Investors view.** That view is live off
> Finology (above). The file is still loaded because Fund Flows reads the institution side of it;
> the individual half is now unused by any panel.

Eight named individual investors and eight fund houses, each with four quarters of positions.
Identical shape; institutions add `house`, `manager`, `category`, `aumCr`, `schemeCount` and
`topSectors`.

> ### Attribution — read this before wiring anything
>
> **The names are real. The positions are not.**
>
> Ashish Kacholia, Dolly Khanna, Vijay Kedia, Mukul Agrawal, Akash Bhanshali, Anil Kumar Goel,
> Sunil Singhania and Porinju Veliyath are real public investors. Small Cap World Fund, Bandhan,
> LIC and the rest are real funds. Their **actual** shareholdings are disclosed in quarterly
> exchange filings and aggregated by Trendlyne, Ticker Finology and AMFI.
>
> Every ticker, quantity and holding percentage in these files is **synthetic**, from
> `scripts/gen-mock-investors.mjs` (`SEED = 20260813`). "Dolly Khanna holds 2.4% of X" here is a
> false statement about a real person's finances. It is only defensible because the dashboard
> says so on every surface that renders it: the tab ribbon, the workspace banner on all four
> tabs, and row 1 of every exported sheet. **If you add a surface, add the marker.**
>
> These files contain **numbers and positions only.** There is deliberately no `rationale`,
> `commentary`, `quote`, `thesis` or `why` field, and none may be added while the data is
> synthetic. Inventing a position is bounded and labelled; inventing a sentence a named person
> supposedly said is putting words in a real mouth, and no ribbon fixes that. This is the same
> rule that makes every speaker in the con-call transcripts fictional.

```jsonc
{
  "_provenance": "ILLUSTRATIVE DATA. The investor and fund names here are REAL public figures …",
  "generated_at": "2026-08-11T04:10:00.000Z",
  "generator": "scripts/gen-mock-investors.mjs",
  "seed": 20260813,
  "source": "Mock data",
  "as_of": "2026-06-30",              // the shareholding cut-off the latest quarter reflects
  "quarter": "Q1FY27",
  "quarters": ["Q1FY27", "Q4FY26", "Q3FY26", "Q2FY26"],   // NEWEST FIRST
  "investor_count": 8,
  "investors": [
    {
      "investorId": "dolly-khanna", "name": "Dolly Khanna", "type": "individual",
      "since": "2008",
      "quarters": ["Q1FY27", "Q4FY26", "Q3FY26", "Q2FY26"],
      "stocksHeld": 14, "portfolioValueCr": 3052.4,
      "prevPortfolioValueCr": 2894.1, "valueChangePct": 5.5,
      "topHolding": "Some Company Ltd",
      "holdings": [
        {
          "ticker": "XYZ", "name": "Some Company Ltd", "sector": "Chemicals",
          "quarter": "Q1FY27",
          "qty": 1840000, "holdingPct": 2.31, "valueCr": 336.2,
          "qtyDelta": 240000, "holdingPctDelta": 0.3, "action": "Buy"
        }
      ]
    }
  ]
}
```

### `investors[]` / `institutions[]`

| Field | Type | Notes |
| --- | --- | --- |
| `investorId` | string | Slug. Used in `?holder=` and as the workspace key. |
| `name` | string | **Real person or fund.** |
| `type` | string | `individual` \| `institution`. |
| `since` | string \| null | Year first tracked. `null` for institutions. |
| `quarters[]` | string[] | Newest first — the order the UI reads them in. |
| `stocksHeld` / `portfolioValueCr` | number | Latest quarter, positions with `holdingPct > 0`. |
| `prevPortfolioValueCr` / `valueChangePct` | number \| null | Against the previous quarter. |
| `topHolding` | string \| null | Largest position by derived value. |
| `house` / `manager` / `category` | string \| null | **Institutions only.** `category` is `FII` \| `DII` \| `Domestic MF`. |
| `aumCr` / `schemeCount` | number | **Institutions only.** |
| `topSectors[]` | array | **Institutions only.** `{ sector, sharePct }` — the mandate view. |

### `holdings[]` — one row per company **per quarter**

| Field | Type | Unit | Notes |
| --- | --- | --- | --- |
| `ticker` / `name` / `sector` | string | — | Real company. |
| `quarter` | string | `Q<n>FY<yy>` | |
| `qty` | number | shares | **Synthetic.** Derived from `holdingPct` against a fixed share count per company, so the series is internally consistent: `qtyDelta` equals this quarter's `qty` minus last quarter's, exactly. |
| `holdingPct` | number | percent of the company | **Synthetic.** Sized by position *value* first and then converted, because drawing the percentage directly produces "3% of a ₹6.7 lakh crore bank" — a ₹20,000 crore position for one individual. |
| `valueCr` | number | ₹ crore | **DERIVED, not disclosed.** `holdingPct × marketCap`. A filing gives a percentage and never a rupee amount, so this moves with the market as well as with the position. Every view that shows it says so. |
| `qtyDelta` | number | shares | Signed, vs the previous quarter. `0` in the oldest quarter. |
| `holdingPctDelta` | number | percentage points | Signed. |
| `action` | string | see below | **Derived from `holdingPctDelta`, not drawn independently** — a reader checking the arithmetic finds it holds. |

`action` is `New` (0% → >0%), `Exit` (>0% → 0%), `Buy` (Δ > +0.01pp), `Sell` (Δ < −0.01pp) or
`Hold`. A row with `holdingPct: 0` only appears when it is the `Exit` itself.

### How a real quarterly shareholding scrape maps in

Exchange filings publish, per company per quarter, a shareholder table listing every holder above
1% with their share count and percentage. That is **company-major**; these files are
**holder-major**. The transform is a pivot plus two derivations:

1. **Scrape company-major.** For each company and quarter, pull the shareholder rows: holder name,
   share count, percentage. Ticker Finology and Trendlyne already aggregate this; the raw source is
   the BSE/NSE shareholding-pattern filing.
2. **Match holder names to `investorId`.** This is the only genuinely hard step — filings render the
   same person inconsistently (`DOLLY KHANNA`, `Dolly Khanna .`, jointly-held variants) and funds
   appear scheme by scheme. Keep an alias table keyed by `investorId`; do not fuzzy-match silently,
   because a wrong match attributes a real position to the wrong real person.
3. **Pivot to holder-major** and sort each holder's rows newest-quarter first.
4. **Derive `qtyDelta`, `holdingPctDelta` and `action`** by walking each `(holder, ticker)` series —
   never take an `action` field from the source, so the label and the numbers cannot disagree.
5. **Derive `valueCr`** as `holdingPct × marketCap` at the reporting date, and keep saying it is
   derived.
6. Set `source` to something that does not contain "mock", drop `generator` and `seed`, and every
   illustrative marker disappears on its own.

**Refresh cadence** — quarterly, 3–6 weeks after quarter end.
**Real source** — Ticker Finology / Trendlyne / BSE shareholding patterns; AMFI for MF schemes.
**Consumed by** — Super Investors → Superstar Investors, Institutions, Fund Flows, and the
per-investor workspace.

---

## `public/data/mock/fund-flows.json` — MOCK

24 months of net flows, ₹ crore.

```jsonc
{
  "_provenance": "ILLUSTRATIVE DATA. Every flow figure is synthetic …",
  "generator": "scripts/gen-mock-investors.mjs",
  "seed": 20260813,
  "source": "Mock data",
  "unit": "INR crore, net",
  "month_count": 24,
  "months": [
    {
      "month": "2026-08",
      "fiiNetCr": -18420,
      "diiNetCr": 24310,
      "mf": { "equityCr": 31200, "smallCapCr": 4180, "midCapCr": 5640, "largeCapCr": 8390 }
    }
  ]
}
```

| Field | Type | Unit | Notes |
| --- | --- | --- | --- |
| `month` | string | `YYYY-MM` | Ascending. |
| `fiiNetCr` | number | ₹ crore, **signed** | Negative is net selling. The chart's zero line is load-bearing. |
| `diiNetCr` | number | ₹ crore, signed | Generated anti-correlated with FII, which is how the two usually behave. |
| `mf.*` | number | ₹ crore | Category net inflows. Non-negative in the shipped set. |

**Refresh cadence** — monthly. **Real source** — NSE/BSE publish FII/DII net flows; AMFI publishes
category flows. **Consumed by** — Super Investors → Fund Flows.

---

## What the Trending and Fund Flows views join

Both views put synthetic data beside **real** data from the technicals scrape, and both label
which is which in the sub-header. The join key is always the ticker.

| View | Synthetic columns | Real columns (from `technicals.json`) |
| --- | --- | --- |
| Public Chatter → Trending | mentions, momentum, sentiment, source split, first mention | technical score /24, `pct_change_today`, 52-week proximity, `relative_strength_6m` |
| Super Investors → Fund Flows | tracked holders, their stakes, net action | `chg_fii_hold`, `chg_dii_hold`, combined, `delivery_trend_diff`, technical score /24 |

A company with chatter or a tracked holder but no row in the NSE-500 universe shows `—` in the
real columns rather than a zero. The chatter-vs-price quadrant therefore has one invented axis and
one measured one; the view says so, because that is exactly the kind of chart that gets
screenshotted without its caption.

---

## `public/data/mock/transactions.json` — MOCK ledger, REAL prices

The buy/sell/dividend/corporate-action ledger. Root is an **array**, 113 rows across three
financial years. Regenerate with `node scripts/gen-mock-transactions.mjs` (seeded — the output is
byte-identical, so a diff means a real change).

**What is synthetic and what is not.** Which trades were made and when is invented. Every
execution price is a real Yahoo close for that ticker on that trading day (from
`portfolio-history.json`) plus a few basis points of slippage, and every trade date is snapped to a
real trading day. That is deliberate: a buy recorded at a price the stock never traded at would make
the equity curve step at the trade date — a visible artefact in a risk chart. Charges use the real
Indian delivery-equity rate card.

```jsonc
[
  { "id": "t-016", "date": "2024-03-19", "ticker": "CDSL",
    "name": "Central Depository Services Ltd", "type": "Buy",
    "qty": 40, "price": 840.77, "value": 33630.80, "charges": 39.88 },

  { "id": "t-052", "date": "2024-08-06", "ticker": "TATAMOTORS", "name": "Tata Motors Ltd",
    "type": "Bonus", "qty": 110, "price": 0, "value": 0, "charges": 0, "ratio": 2 }
]
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `id` | string | `t-NNN` | Stable, and assigned in date order. |
| `date` | string | `YYYY-MM-DD` | A real trading day. |
| `ticker` / `name` | string | — | |
| `type` | string | `Buy` \| `Sell` \| `Dividend` \| `Bonus` \| `Split` | |
| `qty` | number | shares | Always positive. On a `Bonus`/`Split` it is the shares *added*, for display; the engine reads `ratio`. |
| `price` | number | ₹ per share | Execution price. On a `Dividend` it is the per-share amount. Zero on corporate actions. |
| `value` | number | ₹ | `qty × price`, excluding charges. |
| `charges` | number | ₹ | STT + exchange + GST + SEBI + stamp (buys) + DP (sells). **Folded into the cost basis on a buy** and **deducted from proceeds on a sell**, apportioned across the lots consumed. |
| `ratio` | number | multiplier | `Bonus`/`Split` only. `2` = a 1:1 bonus or a 1:2 split. |

**How the ledger is consumed.** `js/portfolio/lots.js` replays it once per page load:

- Buys open a lot at `(qty × price + charges) / qty`.
- Sells consume the **oldest open lots first**, emitting one realised row per lot matched, each
  carrying its own `buyDate`, `heldDays` and `term` (`long` above 365 days).
- Dividends are **income**, tracked separately and never folded into the basis — doing so would
  disguise income as a cheaper purchase.
- Bonuses and splits **adjust the open lots in place**: quantity multiplied, cost per share divided,
  total cost unchanged, acquisition date preserved. Creating a zero-price "buy" for bonus shares
  would reset the holding-period clock and misclassify a later sale as short term.
- A sell larger than the holding, or an unrecognised type, lands in `book.errors[]` — never dropped.

**The two identities**, asserted numerically in `scripts/verify-ui.mjs`:
`sum(open lot quantities) === position quantity`, and
`realised + unrealised + dividends === total P&L` — per position, not merely in aggregate.

**CSV round trip.** Transaction History → Import / Export exports and re-imports the exact column
set `id,date,ticker,name,type,qty,price,value,charges,ratio`. Import parses in the browser, previews
what it parsed, names every rejected row with its line number and reason, and trial-replays before
offering to apply. **An applied import lives until reload** — this is a static site with no server to
write the file — and the UI says so rather than letting the work vanish silently.

**Refresh cadence** — event-driven, per trade.
**Real source** — broker contract notes (Zerodha / Groww / ICICI Direct import).
**Consumed by** — `js/data/portfolio.js`, `js/portfolio/lots.js`, all four Portfolio Analytics tabs.

---

### Wiring the real ledger

1. Replace `public/data/mock/transactions.json` with the real rows, same shape.
2. Regenerate `portfolio.json`'s `qty`/`avgPrice` from a FIFO replay (or run the generator with the
   real ledger in place, which does both).
3. Run `node scripts/scrape-portfolio-history.mjs` so the curve covers every ticker the new ledger
   touches; anything Yahoo will not serve lands in `failures[]` and the UI names it.
4. Update the two `mock` rows in `js/ui/sources.js` to `static` or `live`.
5. Replace the split ribbon's ledger clause in `js/portfolio/chrome.js` — it is one function, and
   all four sub-views read it.
6. Re-run `node scripts/verify-ui.mjs`; the reconciliation identities must still hold.

---

## Adding a new data file

1. Drop the JSON in `public/data/` (or `public/data/mock/` if it's placeholder data).
2. Add one line to `DATA_SOURCES` in `public/js/app.js` — the key becomes `ctx.data.<key>`.
3. Document it here: shape, field types, units, cadence, real source, consumers.

For anything that should update without a page reload, register a poller with
`live.register(id, { intervalMs, fetcher })` instead of adding it to `DATA_SOURCES`.

# Data Contracts

Every JSON file the dashboard reads, its exact shape, field types, units, refresh cadence and
the real source it will be wired to. This document is how live data gets connected in later
prompts — treat it as the interface, and change the doc and the producer together.

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
| `universe` | `public/data/universe.json` |
| `earnings` | `public/data/mock/earnings.json` |
| `earningsCalendar` | `public/data/mock/earnings-calendar.json` |
| `concallFeed` | `public/data/mock/concall-feed.json` |
| `concallKeywords` | `public/data/mock/concall-keywords.json` |
| `chatter` | `public/data/mock/chatter.json` |
| `superinvestors` | `public/data/mock/superinvestors.json` |
| `institutions` | `public/data/mock/institutions.json` |
| `transactions` | `public/data/mock/transactions.json` |

`universe.json` is loaded twice over: the raw screener rows stay on `ctx.data.universeRaw`, and
`ctx.data.universe` carries the adapted `{ ticker, name, marketCap, sector, industry }` shape the
older tabs were built against (see `js/data/universe.js`).

`earnings.json` follows the same pattern: the full payload stays on `ctx.data.earningsRaw` and
primes `js/data/earnings.js` (so the module never refetches it), while `ctx.data.earnings` carries
the flat one-row-per-company summary that Breakouts → Earnings Surprise was written against.

**Not in that map:** `technicals.json`, `atr-history.json` and `technicals-source.json` are fetched
lazily by `js/data/technicals.js` the first time the Breakouts tab (or a global search) needs them,
then cached for the life of the page. They are ~800KB together — the other eight tabs shouldn't pay
for that on first paint.

> **Mock vs real.** Everything under `public/data/mock/` is hand-written placeholder data so the
> shell has something to render. Outside `mock/`: `technicals.json` and `atr-history.json` are
> **live** (scraped on a schedule), `universe.json` is a **real** NSE-500 screener export refreshed
> by hand, and `portfolio.json` is user config whose contents are still placeholder.

---

## `public/data/technicals.json` — LIVE

**The dashboard's one genuinely live feed.** Written by `scripts/scrape-technicals.mjs`, refreshed
weekdays at 07:00 IST by `.github/workflows/technicals-refresh.yml`, and consumed by
`public/js/data/technicals.js`, which scores every row through `public/js/scoring/tech-scoring.js`.

Root is an **object** with a metadata header and a `companies` array.

```jsonc
{
  "generated_at": "2026-08-10T09:58:26.417Z",
  "source": "Yahoo Finance",
  "index_symbol": "^CRSLDX",
  "index_close": 23723.55,
  "index_6m_return": 0.0113,
  "market_breadth": { "advances": 248, "declines": 269, "unchanged": 3, "ad_ratio": 0.92, "universe": 520 },
  "company_count": 535,
  "failures": 15,
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
| `market_breadth` | object \| null | counts | Advances / declines / unchanged across the scored universe, plus `ad_ratio` (advances ÷ declines, null when declines is 0). |
| `company_count` | number | count | Rows in `companies`, including failures. |
| `failures` | number | count | Rows carrying an `error` instead of indicators. |

### `companies[]` — a company that scraped successfully

Every numeric field is `null` when it could not be computed (usually too little history). The
scoring model treats `null` as **N/A**, which scores 0 out of that rule's max — it never
substitutes a guess.

**Identity and pass-through (from `universe.json`)**

| Field | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `ticker` | string | — | NSE symbol, uppercase. Join key everywhere. |
| `name` | string | — | Company name. |
| `screenerUrl` | string | — | Screener.in company page; the drill panel's "View on Screener.in" link. |
| `marketCap` | string | display text | Verbatim from the screener export, e.g. `"27,582 Cr."`. |
| `sector`, `broadSector`, `industry` | string | — | Classification. |
| `chg_fii_hold` | number \| null | **percentage points** | Change in FII holding, latest period. Scored by Institutional Activity. |
| `chg_dii_hold` | number \| null | **percentage points** | Change in DII holding. |

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

## `public/data/portfolio.json`

The user's tracked holdings. Root is an **object**, not an array.

```jsonc
{
  "asOf": "2026-08-07",
  "holdings": [
    {
      "ticker": "HDFCBANK",
      "name": "HDFC Bank Ltd",
      "qty": 300,
      "avgPrice": 1652.40,
      "lastPrice": 1874.55,
      "high52w": 1962.30,
      "sector": "Financials",
      "convictionTier": "Core"
    }
  ]
}
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `asOf` | string | `YYYY-MM-DD` | Date the holdings snapshot is accurate to. |
| `holdings[].ticker` | string | NSE symbol | Join key. |
| `holdings[].name` | string | — | Full company name. |
| `holdings[].qty` | number | shares | Integer. |
| `holdings[].avgPrice` | number | ₹ per share | Weighted average cost. |
| `holdings[].lastPrice` | number | ₹ per share | **Placeholder.** Superseded by `technicals.json` in prompt 2. |
| `holdings[].high52w` | number | ₹ per share | **Placeholder.** Superseded by `technicals.json` in prompt 2. |
| `holdings[].sector` | string | — | Should match `universe.json` sector for the same ticker. |
| `holdings[].convictionTier` | string | `Core` \| `High Conviction` \| `Tracking` | Drives the conviction grouping in Position By. |

**Refresh cadence** — user-edited; no automated refresh. `lastPrice` / `high52w` become derived
values once the technicals feed exists.
**Real source** — the user (manually, or a broker import in prompt 7).
**Consumed by** — every tab (for the Portfolio scope filter), Overview, Position By,
Transaction History, Drawdown.

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

## `public/data/mock/concall-feed.json`

Rolling con-call transcript feed. Root is an **array**, newest first.

```jsonc
[
  {
    "id": "cc-001", "ticker": "TATAMOTORS", "company": "Tata Motors Ltd",
    "timestamp": "2026-08-10T09:12:00+05:30",
    "type": "keyword-hit", "keyword": "guidance",
    "text": "Management reiterated FY27 EBITDA margin guidance of 8.5-9.5% …",
    "sentiment": "neutral"
  }
]
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `id` | string | — | Stable unique id; used for dedup across polls. |
| `ticker` / `company` | string | — | |
| `timestamp` | string | ISO 8601 +05:30 | When the line was said/ingested. |
| `type` | string | `keyword-hit` \| `highlight` \| `transcript` | `keyword-hit` rows must have a `keyword`. |
| `keyword` | string \| null | matches a `concall-keywords.json` `id` | `null` for non-keyword rows. |
| `text` | string | — | The commentary line. Rendered escaped. |
| `sentiment` | string | `positive` \| `neutral` \| `negative` | Model-scored in prompt 5. |

**Refresh cadence** — this is the feed that should feel live: polled every **12 s** while the
Con-call tab is mounted and the document is visible.
**Real source** — exchange filing transcripts + live con-call audio transcription (prompt 5).
**Consumed by** — Con-call → Live Feed and Catalysts.

---

## `public/data/mock/concall-keywords.json`

The default keyword set for transcript scanning. Root is an **array** of exactly 9 entries
today; the set becomes user-editable in prompt 5.

```jsonc
[ { "id": "guidance", "label": "Guidance", "hits": 21, "trend": "up" } ]
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `id` | string | kebab-case | Join key against `concall-feed.json.keyword`. |
| `label` | string | — | Display name. |
| `hits` | number | count | Occurrences over a trailing 7-day window. |
| `trend` | string | `up` \| `flat` \| `down` | Direction vs the previous 7-day window. |

**Default 9 keywords** — `guidance`, `margin`, `capex`, `order-book`, `attrition`,
`debt-reduction`, `capacity-expansion`, `management-change`, `pricing-pressure`.

**Refresh cadence** — `hits`/`trend` recomputed whenever the feed refreshes; the keyword list
itself is user config.
**Real source** — derived from the transcript corpus; the list is user-owned.
**Consumed by** — Con-call → Keyword Scan (and Catalysts, which filters the feed to the
catalyst-shaped subset: `guidance`, `capex`, `capacity-expansion`, `debt-reduction`,
`order-book`).

---

## `public/data/mock/chatter.json`

Community sentiment. Root is an **object** with three independent arrays.

```jsonc
{ "valuepickr": [...], "telegram": [...], "trending": [...] }
```

### `valuepickr[]`

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `id` | string | — | Stable unique id. |
| `ticker` / `company` | string | — | |
| `thread` | string | — | Thread title. |
| `excerpt` | string | — | Post snippet. Rendered escaped. |
| `author` | string | — | Forum username. |
| `postedAt` | string | ISO 8601 +05:30 | |
| `replies` | number | count | Replies on the thread. |
| `sentiment` | string | `positive` \| `neutral` \| `negative` | |

### `telegram[]`

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `id` | string | — | Stable unique id. |
| `channel` | string | — | Channel display name. |
| `ticker` / `company` | string | — | |
| `message` | string | — | Message body. Rendered escaped. |
| `postedAt` | string | ISO 8601 +05:30 | |
| `forwards` | number | count | Forward count, a rough reach proxy. |

### `trending[]`

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `ticker` / `company` | string | — | |
| `mentions24h` | number | count | Mentions across all sources in the last 24h. |
| `mentionsChangePct` | number | percent | vs the prior 24h. Signed. |
| `sentimentScore` | number | −1.0 … +1.0 | Aggregate sentiment. **Not a percentage.** |

**Refresh cadence** — ValuePickr every 15 min, Telegram near-real-time, `trending` recomputed
hourly.
**Real source** — ValuePickr forum (`forum.valuepickr.com`) crawler; Telegram Bot API for
subscribed channels; `trending` is derived from both.
**Consumed by** — Public Chatter (one sub-view per array).

---

## `public/data/mock/superinvestors.json`

Disclosed superstar-investor position changes. Root is an **array**, one row per
investor × company × quarter.

```jsonc
[
  {
    "id": "si-1", "investor": "Ashish Kacholia", "investorType": "Superstar Investor",
    "ticker": "POLYCAB", "company": "Polycab India Ltd",
    "action": "Buy", "qtyChange": 42000,
    "pctHolding": 1.8, "pctHoldingChange": 0.2, "asOf": "2026-06-30"
  }
]
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `id` | string | — | Stable unique id. |
| `investor` | string | — | Investor / fund name. |
| `investorType` | string | `Superstar Investor` \| `Fund Manager` | |
| `ticker` / `company` | string | — | |
| `action` | string | `Buy` \| `Sell` \| `New` \| `Exit` \| `Hold` | `New` = first disclosure, `Exit` = fully out. |
| `qtyChange` | number | shares | Signed. `0` for `Hold`. |
| `pctHolding` | number | percent of company equity | Post-change holding. `0` after an `Exit`. |
| `pctHoldingChange` | number | percentage points | Signed change vs the prior quarter. |
| `asOf` | string | `YYYY-MM-DD` | Quarter-end the disclosure covers. |

**Refresh cadence** — quarterly, ~3–6 weeks after each quarter end as shareholding patterns
are filed.
**Real source** — **Ticker Finology** (`ticker.finology.in`) superstar-investor pages, cross-checked
against BSE/NSE shareholding pattern filings.
**Consumed by** — Super Investors → Superstar Investors.

---

## `public/data/mock/institutions.json`

Institutional shareholding by company. Root is an **array**, one row per company per quarter.

```jsonc
[
  {
    "ticker": "RELIANCE", "company": "Reliance Industries Ltd", "quarter": "Q1FY27",
    "fiiPct": 22.4, "fiiChangeQoqPct": 0.3,
    "diiPct": 18.9, "diiChangeQoqPct": 0.6,
    "mfPct": 9.1
  }
]
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `ticker` / `company` | string | — | |
| `quarter` | string | `Q<n>FY<yy>` | |
| `fiiPct` | number | percent of equity | Foreign institutional holding. |
| `fiiChangeQoqPct` | number | percentage points | Signed change vs prior quarter. |
| `diiPct` | number | percent of equity | Domestic institutional holding. |
| `diiChangeQoqPct` | number | percentage points | Signed. |
| `mfPct` | number | percent of equity | Mutual fund holding — a **subset of** `diiPct`, not additive to it. |

**Refresh cadence** — quarterly, with the shareholding pattern filings.
**Real source** — **AMFI** monthly portfolio disclosures and **Trendlyne** / BSE shareholding
pattern filings.
**Consumed by** — Super Investors → Institutions and Fund Flows (which derives
`netFlowPct = fiiChangeQoqPct + diiChangeQoqPct`), Breakouts → FII Accumulation.

---

## `public/data/mock/transactions.json`

The buy/sell ledger behind the portfolio. Root is an **array**.

```jsonc
[
  { "id": "t-001", "date": "2025-08-14", "ticker": "TATAMOTORS", "name": "Tata Motors Ltd",
    "type": "Buy", "qty": 350, "price": 890.10, "value": 311535.00 }
]
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `id` | string | — | Stable unique id. |
| `date` | string | `YYYY-MM-DD` | Trade date. |
| `ticker` / `name` | string | — | |
| `type` | string | `Buy` \| `Sell` | |
| `qty` | number | shares | Always positive; direction comes from `type`. |
| `price` | number | ₹ per share | Execution price. |
| `value` | number | ₹ | `qty × price`. Excludes brokerage and charges today; prompt 7 adds a separate charges field rather than folding it in here. |

**Refresh cadence** — event-driven, on each trade.
**Real source** — broker contract notes (Zerodha / Groww / ICICI Direct import, prompt 7).
**Consumed by** — Transaction History; prompt 7 also uses it for FIFO cost basis and realised P&L.

---

## Adding a new data file

1. Drop the JSON in `public/data/` (or `public/data/mock/` if it's placeholder data).
2. Add one line to `DATA_SOURCES` in `public/js/app.js` — the key becomes `ctx.data.<key>`.
3. Document it here: shape, field types, units, cadence, real source, consumers.

For anything that should update without a page reload, register a poller with
`live.register(id, { intervalMs, fetcher })` instead of adding it to `DATA_SOURCES`.

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
| `concallFeed` | `public/data/mock/concall-feed.json` |
| `concallKeywords` | `public/data/mock/concall-keywords.json` |
| `chatter` | `public/data/mock/chatter.json` |
| `superinvestors` | `public/data/mock/superinvestors.json` |
| `institutions` | `public/data/mock/institutions.json` |
| `transactions` | `public/data/mock/transactions.json` |

> **Mock vs real.** Everything under `public/data/mock/` is hand-written placeholder data so
> the shell has something to render. `portfolio.json` and `universe.json` sit outside `mock/`
> because they are user/config data rather than scraped feeds — but their current contents are
> still placeholders.

---

## `public/data/technicals.json` — NOT MOCKED

**This file does not exist yet.** It is the one genuinely live feed and arrives in **prompt 2**
(Yahoo Finance EOD across the NSE 500, refreshed by a Node 22 script in `scripts/` via GitHub
Actions). Nothing in this repo fabricates technical indicator values: the Technical Scanner and
Strong Breakouts sub-views deliberately render a "Pending" state until this file lands, rather
than showing invented numbers.

Its contract will be defined in prompt 2 and documented here at that time. Expect at minimum:
per-ticker last close, volume, 50/100/200-DMA, 52-week high/low, and a derived breakout flag.

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

Coverage universe. Root is an **array**.

```jsonc
[
  { "ticker": "RELIANCE", "name": "Reliance Industries Ltd", "marketCap": 1912450, "sector": "Energy", "industry": "Refineries & Marketing" }
]
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `ticker` | string | NSE symbol | Join key. |
| `name` | string | — | Full company name. |
| `marketCap` | number | **₹ crore** | e.g. `1912450` = ₹19.12 lakh crore. |
| `sector` | string | — | Broad sector. |
| `industry` | string | — | Finer classification within the sector. |

**Refresh cadence** — quarterly for constituents, daily for `marketCap` once live.
**Real source** — NSE 500 constituent list; market cap from the prompt-2 Yahoo Finance pipeline.
**Consumed by** — global search typeahead, Breakouts, Position By (market-cap bands), Overview
(Universe scope).

---

## `public/data/mock/earnings.json`

Latest reported quarterly results. Root is an **array**, one row per company per quarter.

```jsonc
[
  {
    "ticker": "RELIANCE", "name": "Reliance Industries Ltd", "sector": "Energy",
    "quarter": "Q1FY27", "reportDate": "2026-07-18",
    "revenueCr": 255000, "revenueYoyPct": 6.2, "revenueQoqPct": 2.1,
    "netProfitCr": 19800, "netProfitYoyPct": 8.4,
    "epsActual": 29.4, "epsEstimate": 28.6, "surprisePct": 2.8,
    "resultTag": "Beat"
  }
]
```

| Field | Type | Unit / values | Notes |
| --- | --- | --- | --- |
| `ticker` / `name` / `sector` | string | — | |
| `quarter` | string | `Q<n>FY<yy>` | Indian fiscal quarter, e.g. `Q1FY27` = Apr–Jun 2026. |
| `reportDate` | string | `YYYY-MM-DD` | Date results were declared. |
| `revenueCr` | number | ₹ crore | Consolidated revenue. |
| `revenueYoyPct` | number | percent | vs same quarter last year. Signed. |
| `revenueQoqPct` | number | percent | vs previous quarter. Signed. |
| `netProfitCr` | number | ₹ crore | Consolidated PAT. |
| `netProfitYoyPct` | number | percent | Signed. |
| `epsActual` | number | ₹ per share | Reported EPS for the quarter. |
| `epsEstimate` | number | ₹ per share | Consensus estimate. |
| `surprisePct` | number | percent | `(epsActual - epsEstimate) / epsEstimate * 100`. Signed. |
| `resultTag` | string | `Beat` \| `Miss` \| `In-line` | Derived from `surprisePct`; thresholds finalised in prompt 4. |

**Refresh cadence** — event-driven during results season (Jan/Apr/Jul/Oct), then idle.
**Real source** — BSE/NSE corporate filings for the reported figures; Screener.in or Trendlyne
for consensus estimates.
**Consumed by** — Earnings Hub (all three sub-views), Breakouts → Earnings Surprise.

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

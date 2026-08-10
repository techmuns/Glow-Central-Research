# Sattva Central Research — Product Spec

An Indian-equities research and portfolio analytics dashboard. Static site, no build step,
no framework, no npm dependencies for the app itself. Hosted as a Cloudflare Worker that
serves `public/` and (later) a few `/api/*` routes.

---

## 1. Navigation model

Three levels, so nothing important is ever more than two clicks away and the user never has
to scroll to find a section.

### (a) Workspace — left rail dropdown

A styled dropdown button at the top of the left rail (custom menu, not a bare `<select>`)
showing the current workspace and a chevron.

| Workspace | id | Default |
| --- | --- | --- |
| Research Central | `research` | ✅ |
| Portfolio Analytics | `portfolio` | |

### (b) Section — top tabs

Underline indicator that animates between tabs; active tab in the brand teal, inactive slate
with hover. Order is fixed:

**Research Central**
1. Earnings Hub
2. Con-call *(Deep Dive lives inside this tab)*
3. Public Chatter
4. Breakouts / Technical
5. Super Investors

**Portfolio Analytics**
1. Overview
2. Position By
3. Transaction History
4. Drawdown

### (c) Sub-view — left rail list

Rendered under the workspace dropdown as a vertical nav with an active-state pill and an
optional right-aligned count badge.

| Tab | Sub-views |
| --- | --- |
| Earnings Hub | Latest Results · Result Scans · Quality & Growth |
| Con-call | Live Feed · Keyword Scan · Catalysts · Deep Dive |
| Public Chatter | ValuePickr · Telegram · Trending |
| Breakouts / Technical | Technical Scanner · Strong Breakouts · FII Accumulation · Earnings Surprise |
| Super Investors | Superstar Investors · Institutions · Fund Flows |
| Overview | Positions · Allocation |
| Position By | Sector · Market Cap · Conviction |
| Transaction History | All · Buys · Sells |
| Drawdown | Portfolio · Per Position |

Under 1024px the rail collapses to a dropdown above the content.

---

## 2. Global scope toggle — Portfolio ⇄ Universe

A segmented control in the header (right side, before the Live pill). It is **global**: it
applies to every tab in both workspaces.

- Stored as `state.scope` (`"portfolio" | "universe"`), persisted to `localStorage`, and
  carried in the URL as `?scope=`.
- Every tab module reads `ctx.scope` and must visibly reflect it — the scope chip in each
  panel header states which scope is active and how many rows it covers.
- Portfolio holdings come from `public/data/portfolio.json`; the universe from
  `public/data/universe.json`.
- Changing scope never loses the current tab or sub-view.

---

## 3. Routing

Hash-based and shareable:

```
#/<workspace>/<tab>/<subview>?scope=<portfolio|universe>
#/research/breakouts/strong-breakouts?scope=portfolio
```

- Unknown workspace / tab / sub-view falls back to the first valid option at that level;
  a completely unknown route lands on `#/research/earnings-hub/latest-results`.
- With no hash present, the last route is restored from `localStorage`.
- Browser back/forward work; scope changes and route normalisation use `replaceState` so they
  don't pollute history.

---

## 4. Header

Sticky, full-width, on a glass/blur background.

- **Left** — 44px rounded-xl teal→emerald gradient mark reading "SC", then
  "Sattva Central Research" (`font-display`, extrabold) with a workspace-aware subtitle.
- **Centre** — global search, placeholder "Search any company, theme or investor…", with a
  ⌘K / Ctrl-K badge and shortcut. Typeahead over the merged universe + portfolio company list.
  Selecting a result calls the `openCompany(ticker)` stub in `ui/components.js` — later
  prompts turn that into a real company view.
- **Right** — the Portfolio/Universe segmented toggle, a "Live" pill with a pulsing dot and
  last-tick time, and an "Updated <relative time>" chip.

---

## 5. Design system

Aligned to the LKP Stock Screener's visual language. Tokens live in `:root` in
`public/index.html`.

**Brand ramp: indigo → purple → pink.** Emerald / amber / rose are reserved strictly for
semantic rule states (pass / partial / fail) and are never used as brand colours.

| Token | Value | Use |
| --- | --- | --- |
| `--brand-500` | `#6366f1` | indigo, brand ramp start |
| `--brand-600` | `#4f46e5` | indigo-600, links and actions |
| `--brand-mid` | `#a855f7` | purple, brand ramp middle |
| `--brand-end` | `#ec4899` | pink, brand ramp end |
| `--accent-600` | `#4f46e5` | accent for links/actions |
| `--positive` | `#059669` | emerald — pass |
| `--caution` | `#d97706` | amber — partial |
| `--negative` | `#e11d48` | rose — fail |
| `--hard-fail` | `#be123c` | rose-700 — hard fail |
| `--neutral` | `#64748b` | slate — n/a |
| `--page-bg` | `#f8fafc` | page background |

- Page background carries three radial gradients, all ≤ 12% opacity: violet top-left, pink
  top-right, sky bottom-right.
- Surfaces: white, `rounded-2xl`, `shadow-sm`, `ring-1 ring-slate-100`.
- Content column is `max-w-[1400px] mx-auto px-6`.
- Top-tab indicator: a 3px indigo→purple bar that scales in with a springy
  `cubic-bezier(0.34, 1.56, 0.64, 1)` transition.
- `font-variant-numeric: tabular-nums` on every number-bearing cell.
- Light theme only. Fully responsive; tables scroll horizontally inside their own container so
  the page body never scrolls sideways.
- Fonts: Inter (400–800) for body, Plus Jakarta Sans (600–800) for headings via `.font-display`.

### The screener kit (`public/js/ui/screener.js`, `visual.js`)

Every tab is assembled from five components rather than hand-rolled:

- `statStrip(cards)` — 4-up KPI row; card 4 is always the gradient freshness hero. Cards may
  carry a `?` help modal explaining the metric.
- `topCards({ title, items, valueFormat, onSelect })` — the Top-10 hero grid, click-through to
  the drill panel. `valueFormat` is `'score'` (value/max, tier-coloured) or `'metric'`.
- `scoreTable(config)` — search, filter select, watchlist, sortable sticky head, export,
  optional Score and Signals columns, row click-through.
- `openDrill(config)` — right-slide detail panel with grouped rule/detail cards.
- `openModal(html, { size })` — centred modal.

Plus `sectionHead`, `roadmapStrip`, `pendingPanel`, and the shared visual vocabulary in
`visual.js`: `avatarFor`, `scoreTier`, `scoreBadgeClass`, `tierLabel`, `tierColor`,
`statusPill`, `signalDots`, `legendStrip`.

Chrome primitives (tab bar, rail, scope toggle, search, live badge) remain in
`public/js/ui/components.js`.

### Honesty rules

Presentation must never imply data the dashboard does not have:

1. No fabricated numbers to fill a component — an un-landed feed gets `pendingPanel()` and no
   ranking grid.
2. Signal dots are direct readings of reported figures, not modelled judgements. A
   points-based score only appears once its model exists and is documented.
3. Derived figures say they are derived, and say how.
4. Help modals state what is mock, what is live, and which prompt wires it.

### The Sources modal

The header's "Sources" button opens a modal generated from `public/js/ui/sources.js`, listing
every source grouped by the tabs it serves, with what it feeds, its refresh cadence, a link,
and an honest status (`live` / `mock` / `pending`). Adding a data source means updating
`docs/DATA-CONTRACTS.md`, `js/app.js` and `sources.js` together.

---

## 6. Live update engine (`public/js/core/live.js`)

A small pub/sub polling store so tabs just subscribe.

```js
live.register(id, { intervalMs, fetcher });
live.subscribe(id, cb);   // returns an unsubscribe fn
live.unsubscribe(id, cb);
live.start(id);           // call from render()
live.stop(id);            // call from destroy()
live.onGlobalTick(cb);    // header Live pill
```

- Pollers run only while their tab is mounted **and** the document is visible; they pause on
  `visibilitychange` and refetch immediately on return.
- Exponential backoff on error, capped at 60s. Errors never throw into the UI — the last good
  data stays on screen.
- `mockFetcher(path)` reads a static JSON file and jitters numbers slightly so liveness is
  visible in development. `realFetcher(url)` has the same signature, so swapping a tab to a
  real endpoint is a one-line change at the call site.

---

## 7. Tabs and planned features

### Earnings Hub — `earnings-hub`
Quarterly results, scans and quality/growth signals.
- Auto-parsed result PDFs (revenue, PAT, margin extraction)
- Beat/miss scoring vs Street estimates
- Segment-wise revenue break-up
- Quality & growth composite score (ROE, ROCE, consistency)
- Saved scans and custom result alerts
- Historical per-company result trend charts

### Con-call — `concall`
Live transcript feed, keyword scanning, catalyst tracking, Deep Dive.
- Live transcript ingestion from exchange filings
- Custom keyword sets with instant alerts (default 9 keywords ship today)
- Sentiment scoring per management commentary line
- Catalyst tagging (guidance raise/cut, capex, M&A)
- Deep Dive: full transcript + quarter-over-quarter diff
- Management tone/consistency scoring over time

### Public Chatter — `public-chatter`
Community sentiment.
- Real-time ValuePickr thread crawler with dedup
- Telegram channel ingestion via bot API
- NLP sentiment scoring per post
- Ticker-level chatter velocity alerts
- Spam / promotional post filtering
- Cross-source mention aggregation

### Breakouts / Technical — `breakouts`
Technical scans across coverage. **This is the one genuinely live feed.**
- Live EOD price/volume feed (Yahoo Finance, NSE 500)
- 50/100/200-DMA breakout detection
- Volume surge & momentum scoring
- 52-week-high proximity scanner
- Sector-relative strength ranking
- FII/DII flow overlays on price action

### Super Investors — `super-investors`
Superstar holdings, institutional ownership, fund flows.
- Quarterly shareholding scrape (Ticker Finology)
- Per-investor portfolio pages with history
- New-entry / full-exit alerting
- AMFI + Trendlyne mutual fund flow overlay
- Investor conviction scoring vs position size
- Cross-investor overlap heatmap

### Overview — `overview`
- Live mark-to-market from the technicals feed
- XIRR and absolute return per position
- Realised vs unrealised P&L split
- Benchmark comparison (Nifty 50 / Nifty 500)
- Dividend and corporate-action adjustments
- Allocation drift alerts vs target weights

### Position By — `position-by`
- Donut + treemap allocation charts
- Target vs actual weight drift tracking
- Concentration risk flags (top-5 weight, single-name cap)
- Custom user-defined grouping tags
- Slice-level XIRR contribution
- Rebalancing suggestions

### Transaction History — `transactions`
- Broker contract-note import (Zerodha / Groww / ICICI Direct)
- FIFO cost-basis and realised P&L computation
- Capital gains statement (STCG / LTCG split)
- Charges & brokerage reconciliation
- Corporate action adjustments (splits, bonus)
- CSV / XLSX export

### Drawdown — `drawdown`
- Daily portfolio equity curve with peak/trough markers
- Max drawdown and recovery-time statistics
- Underwater plot vs Nifty 50
- Per-position drawdown from true rolling 52w high
- Volatility and downside-deviation metrics
- Drawdown alerts at user-set thresholds

---

## 8. Roadmap

| # | Prompt | Scope |
| --- | --- | --- |
| 1 | **Foundation + shell** | File layout, nav model, scope toggle, routing, design system, UI primitives, live engine, mock data, placeholder panels, docs. ✅ *this prompt* |
| 2 | Technicals/breakouts data pipeline | Live Yahoo Finance EOD across NSE 500, Node 22 scripts in `scripts/`, GitHub Actions refresh, produces `public/data/technicals.json`. |
| 3 | Breakouts / Technical tab UI | Real scanner, breakout detection, momentum heatmap, wired to the prompt-2 feed. |
| 4 | Earnings Hub | Result parsing, beat/miss scoring, quality & growth composite. |
| 5 | Con-call + Deep Dive | Transcript ingestion, editable keyword sets, catalysts, full Deep Dive panel. |
| 6 | Public Chatter + Super Investors / Institutions | ValuePickr + Telegram crawlers, Ticker Finology / AMFI / Trendlyne scrapes. |
| 7 | Portfolio Analytics + polish and QA | Real P&L, XIRR, allocation charts, drawdown curves, broker import, final QA pass. |

---

## 9. Module interface contract

Every tab and portfolio module exports exactly this, so the shell stays generic:

```js
export const meta = { id, title, subtitle, subviews: [{ id, label, badge? }] };
export function render(ctx);   // ctx = { scope, subview, root, live, data }
export function destroy();     // detach listeners/pollers; called on nav away
```

`ctx.root` is the content host element, already emptied by the previous tab's teardown.
`ctx.data` is the fully-loaded data set (see `docs/DATA-CONTRACTS.md`).
`ctx.live` is the live engine module.

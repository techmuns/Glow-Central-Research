# Glow Central Research — Product Spec

An Indian-equities research and portfolio analytics dashboard. Static runtime, no bundler,
no framework, no npm dependencies for the app itself. Tailwind is precompiled into a committed
same-origin stylesheet, so deployment still serves `public/` directly. Hosted as a Cloudflare
Worker that serves those assets and the live `/api/*` routes.

---

## 1. Navigation model

Three levels, so nothing important is ever more than two clicks away and the user never has
to scroll to find a section.

### (a) Workspace — no switcher in the chrome

Only Research Central is offered, so there is nothing to pick; the control is gone from the
header. Portfolio Analytics still routes by URL (`WORKSPACES` marks it `hidden: true`).

| Workspace | id | Default |
| --- | --- | --- |
| Research Central | `research` | ✅ |
| Portfolio Analytics | `portfolio` | |

### (b) Section — top tabs

A springy champagne underline scales in under the active tab; active tab in deep gold,
inactive slate with hover. Order is fixed:

**Research Central**
1. Ask Research *(the default landing tab)*
2. AI Alerts
3. General Alerts
4. Earnings Hub
5. Con-call
6. Public Chatter
7. Breakouts / Technical
8. Super Investors
9. Mutual Funds
10. News
11. Corp Announcements
12. Insider Trades

**Portfolio Analytics**
1. Overview
2. Position By
3. Transaction History
4. Drawdown

### (c) Sub-view — one dropdown, at every width

A styled dropdown button (custom menu, not a bare `<select>`) above the content, kickered
*View*, showing the current sub-view and a chevron. There is no left rail: the content column
spans the full 1400px on every tab.

| Tab | Sub-views |
| --- | --- |
| AI Alerts | *(none — one ranked queue, so the picker is hidden)* |
| General Alerts | *(none — one stream, so the picker is hidden)* |
| Ask Research | *(none — one conversation workspace, so the picker is hidden)* |
| Earnings Hub | *(none — one table, so the picker is hidden)* |
| Con-call | *(no sub-views)* — one scan table, with no schedule or feed-status chips above it |
| Public Chatter | *(no shell sub-views)* — in-page **Coverage** and **Not in coverage** tabs, one table at a time |
| Breakouts / Technical | Strong Breakouts *(default)* · Technical Scanner · FII Accumulation · Earnings Surprise |
| Super Investors | Superstar Investors · Institutions |
| News · Corp Announcements · Insider Trades | *(no sub-views)* — one table each, off the shared filings renderer |
| Overview | Positions · Allocation |
| Position By | Sector · Market Cap · Conviction |
| Transaction History | All · Buys · Sells |
| Drawdown | Portfolio · Per Position |

Portfolio Analytics' four tabs are built and still route by URL, but the workspace switcher has been
removed from the chrome, so Research Central's tabs are the whole navigation for now.

**Ask Research is first, and first is the default.** The shell falls back to `ws.tabs[0]` for an
unknown or absent tab, so the order of the `WORKSPACES` array *is* the landing page — there is no
second place recording it that could disagree with the array.

The picker is the same control at every width. It used to be a 240px left rail above 1024px and
a dropdown below it — the rail cost the content 240px of its 1400px, permanently, to show at most
four short labels, while the tables beside it are the widest things in this dashboard and were
scrolling inside their own containers to fit what was left. Measured on removal: Breakouts goes
from a 248px inner scroll to **none**, Super Investors 380px → 116px, Portfolio Overview
453px → 189px.

A tab with `subviews: []` renders no picker at all.

---

## 1b. The header

Brand, the scope toggle, one status pill and a refresh button — nothing else.

- **One status pill**, `● Live · updated 4m ago`, on the last tick of a poller that actually
  reached a server. It replaced a green "Live · just now" chip and a white "Updated 52 minutes
  ago" chip, which claimed different things about the same subject; the green one tracked a
  heartbeat that asks nothing of any server, so it read "just now" regardless.
- **The status pill is passive.** It reports freshness without opening a provenance or delivery
  explainer. Detailed source metadata remains in the source registry for audits and exports.
- **A refresh button** re-checks every live feed on demand and reports what it found — "Up to
  date" or "3 new" — rather than spinning and vanishing.
- **No global search box.** A company is reached from its own tab's table.

## 1c. Live alerts

New data announces itself in the lower-right corner: a company filing a result, a con-call gaining
its StockScans analysis, or a book holding appearing in the retail-chatter feed for the first time.
The alerts fire whatever tab is open, because those feeds are watched app-wide rather than only
while their tab is mounted.

Chatter alerts are limited to book holdings, unlike the other two. The feed carries brokers and
themes as well as companies, and a stack of "Guggenheim was mentioned" cards would teach the reader
to dismiss the component — results alerts included.

They never announce the same event twice, they cap the visible stack, they sit **behind** the drill
panel, the workspace and modals, and they inherit the tables' honesty rules — a swing across zero
is described in words rather than as a percentage that does not exist, and a con-call awaiting
analysis says so rather than showing a score of nil.

---

## 2. Global scope toggle — Portfolio · Watchlist · Universe

A segmented control in the header (right side, before the Live pill). It is **global**: it
applies to every tab in both workspaces.

**Three scopes, in priority order, widest last.** That order reads left to right as *mine, watched,
everything*, and **Portfolio is the default** — the first question on opening a dashboard about your
own money is what your own money did, and "every listed company" is the widest possible answer to
that. The vocabulary lives in one place, `js/data/scope.js`; `state.js` and `router.js` import it
rather than repeating the string pair, so a fourth scope is a change in one file.

- Held as `state.scope` (`"portfolio" | "watchlist" | "universe"`) and carried in the URL as
  `?scope=`. **It is session state and is deliberately NOT persisted.** It used to be, and the
  effect was that one afternoon spent in Universe made Universe the scope the dashboard opened in
  for ever after — a default any single click permanently overrides is an initial value, not a
  default. So **every open starts on Portfolio**, while a shared `?scope=` link still wins (the URL
  is read before anything saved) and a reload still holds its scope (the shell keeps `?scope=` in
  the address bar at all times, so reloading is a URL with a scope on it rather than a fresh open).
  An unrecognised value in a shared link falls back to the session's scope rather than silently
  redefining what is on screen.
- Every tab module reads `ctx.scope` and must visibly reflect it — the scope chip in each
  panel header states which scope is active and how many rows it covers.
- **Portfolio means the book**: `public/data/portfolio-companies.json`, the family office's
  listed direct-equity book, rebuilt daily from `techmuns/GlowVentures` (upstream reads it from `techmuns/Sattva-Family`) one line per equity
  ISIN and read through `js/data/coverage.js`. The universe is
  `public/data/universe.json`. `portfolio.json` is the *ledger* — twelve positions with quantities
  and costs — and drives Portfolio Analytics only; the scope filter does not read it.
- The pencil beside the segmented control edits whichever scope is active. Portfolio and Universe
  keep device-local additions and exclusions over those committed defaults; Watchlist edits the
  same company list as the stars in the tables. The search box calls the Worker, which adds the
  Muns credential server-side and returns Indian company names and NSE tickers. Editing the
  Portfolio scope never adds a quantity or cost to the separate Portfolio Analytics ledger.
- **The chip states the denominator, because no feed covers the whole book** — *"Portfolio · 96 of
  142 reported"*. Nineteen lines carry no NSE symbol (unlisted, warrants, the Vedanta demerger
  entities, BSE-only, unresolved); they are kept with a stated reason and shown as held-but-not-
  covered rather than dropped.
- **Watchlist means the companies the reader starred**, read through `js/core/watchlist.js`. The
  star in every `scoreTable` marks a **company**, not a row: `key(row)` identifies the row and
  `watchKey(row)` the company, and the two are allowed to differ, so three announcements from one
  filer are three rows and one watched company and starring any of them fills the star on all three.
  Entries are `{ ticker, name, addedAt }`, so a watched company can be named even where the feed in
  front of you does not carry it.
- **An empty watchlist is answered by the shell, once, for every tab** — `watchlistEmptyPanel()`,
  saying there are zero watchlist companies and offering **Add companies to watchlist**, which opens
  the same Watchlist editor as the header pencil without leaving the current tab or scope. A table
  reading *"no results match your filters"* over a list nobody has added to would send the reader
  hunting for a filter to clear.
  The shell decides teardown against what it will actually mount, so the un-mounted tab is destroyed
  rather than left painting into the content host.
- A row with no company carries **no star at all** rather than one that files a row id, or a company
  name, as though it were a symbol: Superstar Investors (whose upstream discloses names and no
  symbols) and Public Chatter's unresolved half both opt out.
- Changing scope never loses the current tab or sub-view.

---

## 3. Routing

Hash-based and shareable:

```
#/<workspace>/<tab>/<subview>?scope=<portfolio|watchlist|universe>
#/research/breakouts/strong-breakouts?scope=portfolio
```

- Unknown workspace / tab / sub-view falls back to the first valid option at that level;
  a completely unknown route lands on `#/research/ask-research`.
- With no hash present, the last route is restored from `localStorage`.
- Browser back/forward work; scope changes and route normalisation use `replaceState` so they
  don't pollute history.
- A tab may add its own query params for filter state (`?bo=strong&vol=1.5`), which makes a
  filtered view shareable. The shell preserves them across a scope change and clears them when
  the tab or sub-view changes; `ctx.setParams()` writes them without a history entry.

---

## 4. Header — the detail

Sticky, full-width, on a glass/blur background. See §1b for what it carries and why; this is the
layout.

- **Left** — 48px rounded-xl champagne gradient mark reading "SC" in ink, then
  "Glow Central Research" (`font-display`, extrabold) with a workspace-aware subtitle.
- **Right** — the Portfolio/Universe segmented toggle, then the passive status pill (pulsing dot,
  `Live · updated <relative time>`), then the refresh button.
- **Centre** — nothing. The global search box, the separate Sources button and the second
  "Updated …" chip were removed; the middle of the header is deliberately empty so the brand and
  the two live controls are the only things competing for attention.

Live alerts are **not** in the header — they are a stack in the lower-right corner, so an arriving
result never reflows the chrome or shifts what the reader is pointing at. See §1c.

---

## 5. Design system

Aligned to the LKP Stock Screener's visual language. Tokens live in `:root` in
`public/index.html`.

**Brand ramp: champagne — gold → champagne → pale champagne.** Emerald / amber / rose are
reserved strictly for semantic rule states (pass / partial / fail) and are never used as brand
colours. The Tailwind scales `indigo` / `purple` / `pink` are redefined as the brand ramp slots
in `tailwind.config.cjs` (the source of the committed stylesheet), so those names describe a role
rather than a hue — see `CLAUDE.md`.

| Token | Value | Use |
| --- | --- | --- |
| `--brand-500` | `#c3a962` | champagne-600, brand ramp start (fill only) |
| `--brand-600` | `#8a6a1c` | deep gold, links and actions |
| `--brand-mid` | `#d9c48f` | champagne-500, brand ramp middle (fill only) |
| `--brand-end` | `#ecdcae` | champagne-400, brand ramp end (fill only) |
| `--brand-ink` | `#1a1830` | the text the brand gradient carries — never white |
| `--accent-600` | `#8a6a1c` | accent for links/actions |
| `--positive` | `#047857` | emerald — pass |
| `--caution` | `#9a5c09` | amber — partial |
| `--negative` | `#b91c1c` | rose — fail |
| `--hard-fail` | `#991b1b` | rose-700 — hard fail |
| `--neutral` | `#6b6880` | warm slate — n/a |
| `--page-bg` | `#f4f2ec` | page background |

- Page background is parchment under a faint 32px rule grid at 5% ink.
- Surfaces: white, `rounded-2xl`, `shadow-sm`, `ring-1 ring-slate-100`.
- Content column is `max-w-[1400px] mx-auto px-6`.
- Top-tab indicator: a 3px champagne bar that scales in with a springy
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

Plus `sectionHead`, `pendingPanel`, and the shared visual vocabulary in
`visual.js`: `avatarFor`, `scoreTier`, `scoreBadgeClass`, `tierLabel`, `tierColor`,
`statusPill`, `signalDots`, `legendStrip`.

Chrome primitives (tab bar, scope toggle, search, live badge) remain in
`public/js/ui/components.js`.

### Honesty rules

Presentation must never imply data the dashboard does not have:

1. No fabricated numbers to fill a component — an un-landed feed gets `pendingPanel()` and no
   ranking grid.
2. Signal dots are direct readings of reported figures, not modelled judgements. A
   points-based score only appears once its model exists and is documented.
3. Derived figures say they are derived, and say how.
4. Help modals state what is mock, what is live, and which prompt wires it.

### Source registry

`public/js/ui/sources.js` remains the canonical source registry, listing every source grouped by
the tabs it serves, with what it feeds, its refresh cadence, a link, and an honest status
(`live` / `static` / `mock` / `pending`). The registry is data for audits and export disclosures;
passive status labels do not open it in a popup. Adding a data source means updating
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

### Ask Research — `ask-research` (server-configured, single view)
A two-column conversation workspace and the default landing tab. Every question builds a bounded
runtime packet through the canonical data modules behind the other nine Research Central tabs plus
the hidden Portfolio Analytics workspace. Every registered source contributes its status, coverage,
as-of metadata and provenance; question-matched rows are included within the Worker request bound,
so one slow or unavailable feed is reported rather than silently omitted.

The Worker sends the packet to Muns' `/query-router` with `llm_type: local_llm` and `stream: true`
for the shortest first-token delay. Operators can explicitly select `hosted_llm` with
`MUNS_LLM_TYPE` when answer quality matters more than latency.
It forwards each upstream NDJSON text chunk immediately, while the answer cites material dashboard
claims by page. A Muns session token is a Worker secret; the browser never receives it, and the paid
route is same-origin, size-bounded and rate-limited. Conversation history stays in device
`localStorage`; the provider has no web-search contract, so the workspace makes no web-research
claim or control. Every source retains status, coverage and provenance inside a 13,000-character
evidence budget measured on what the model receives; the skeleton may take at most 60% of it, and
the rest is spent on rows — the companies the question names first, from every source that carries
them — so the request stays within the local model's 8K-token context. UI-only routes and the
duplicate catalog are omitted from the model prompt, but remain in the browser for source chips.
The dashboard's own AI Alerts ranking is one of the fifteen sources, so a question about the
strongest evidence across tabs is answered by the same deterministic model the tab shows.

### Earnings Hub — `earnings-hub` (LIVE, single view)
One table: every company that has reported this quarter, newest first. Ten columns —
`Date · Company · Rev cur · Rev prior · Rev % · PAT cur · PAT prior · PAT % · MCap · Basis` —
because a growth percentage without the two figures it came from hides both the scale and the
sign. Ticker and industry sit on the second line of the company cell; gross profit stays in the
feed and the Excel export but is not a column. A YoY/QoQ toggle repoints the comparison, and a
second dropdown filters consolidated vs standalone. Rows are not clickable — there is no drill,
because the figures it held are now columns. Live off Moneycontrol Rapid Results, polled every
30s.

A second view, **Earnings Calendar**, answers the opposite question: who is *scheduled* to report.
A date strip carries the complete all-exchange count per date; the table follows every 20-row page
published by Moneycontrol for the selected date. Past dates remain schedules here; filed results
remain in **Earnings Reported**.
- Auto-parsed result PDFs (revenue, PAT, margin extraction)
- Beat/miss scoring vs Street estimates
- Segment-wise revenue break-up
- Quality & growth composite score (ROE, ROCE, consistency)
- Saved scans and custom result alerts
- Historical per-company result trend charts

### Con-call — `concall`
One screen, live off StockScans: every earnings call held this quarter with their result score,
sentiment tier and highlight bullets, reproduced unchanged and attributed. The section heading has
no Upcoming Concalls or Live/call-count chips; the table is the view.

Four sub-views that ran on a synthetic transcript corpus — Live Feed, Keyword Scan, Catalysts and
Deep Dive — were removed rather than kept behind a ribbon; see `docs/HANDOFF.md` §5c.
- Live transcript ingestion from BSE's filed transcript PDFs — the prerequisite for everything below
- Custom keyword sets scanned against real transcript text
- Sentiment scoring per management commentary line
- Catalyst tagging (guidance raise/cut, capex, M&A)
- Deep Dive: full transcript + quarter-over-quarter diff
- Management tone/consistency scoring over time

### Public Chatter — `public-chatter`
Community sentiment.
- Simple in-page tabs: **Coverage** (default) and **Not in coverage**, each owning its table and its own sentiment selector
- Clicking a company or its mention count opens the underlying mentions, newest first, with a direct link to every source item
- No summary-card row; coverage, posts, market mood and scrape timing appear as footnotes below the tables
- Real-time ValuePickr thread crawler with dedup
- Telegram channel ingestion via bot API
- NLP sentiment scoring per post
- Ticker-level chatter velocity alerts
- Spam / promotional post filtering
- Cross-source mention aggregation

### Breakouts / Technical — `breakouts`
Technical scans across coverage. **This is the one genuinely live feed — shipped in prompt 3.**

Sixteen rules, 24 points, five categories, scored by `js/scoring/tech-scoring.js` from a daily
Yahoo Finance EOD scrape of the NSE 500 plus NSE bhavcopy delivery data. A close below the
200 DMA is the model's only hard fail.

| Category | Rules (points) |
| --- | --- |
| Trend Strength | Price Above 50 EMA (2) · Price Above 200 DMA (2, **hard fail** below) · Golden Cross (1) · Higher Highs–Higher Lows (1) |
| Momentum | RSI 14 (2) · MACD (2) · ADX 14 (1) · Relative Strength vs Nifty 500 (2) |
| Volume | Volume Breakout (2) · Delivery Percentage (1) · Institutional Activity (1) |
| Breakout | 52-Week High Proximity (2) · Breakout from Consolidation (2) · Base Formation (1) |
| Risk | Beta (1) · ATR Stability (1) |

No sub-view here carries a stat strip: the two or three counts and the gradient freshness hero
became one small passive **Live** pill in the section head. The pill is green only while the capture is inside the
schedule's worst case (72 hours — Friday's capture is still current on Monday); past that it is
amber and prints the age, and on Earnings Surprise it is amber regardless, reading *Mock earnings ·
live technicals*.

Sub-views: **Strong Breakouts** (6-week base breakouts, URL-reflected filter chips) — first in the
picker and so the view the tab opens on — then **Technical Scanner** (the full scored universe),
**FII Accumulation** (shareholding changes joined to the score), **Earnings Surprise** (mock
earnings beside the live score, deliberately not blended).

Every Strong Breakouts filter group leads with **All** and defaults to it, so the sub-view opens on
the widest answer it can give. The trend filter used to ship on *Above 200 DMA only*, which meant a
breakout below the primary trend line was absent from a table that gave no sign it was withholding
anything; it is now one click away instead of the default. **All** under Breakout strength is every
breakout grade — a company whose base has not broken out is not a fourth grade, and the line under
the chips prints the matched count over every company with a detectable base.

Still to come — this list is now the only place the gap is recorded, since the dashed *Wiring
roadmap* card that used to close each tab has been removed from the UI:
- Intraday refresh via the live-quote endpoint
- Sector-relative strength ranking
- Saved scans and threshold alerts
- Historical score trend per company
- TradingView indicator overlay (`technicals-source.json`)

### Super Investors — `super-investors`
Superstar holdings and institutional ownership.

**Under Portfolio, Superstar Investors opens on My Managers.** The family asked for it in so many
words — *"what my managers are doing, can I see that? I'm more interested in the portfolio managers I
have access to"* — so the first in-page tab under the Portfolio scope is the family's own managers,
not ninety public investors it has no relationship with: every PMS mandate, alternative fund and
mutual fund house its wealth-platform statements show it invested with, as cards grouped by kind
(mandates, funds, fund houses) in the same design as the investor cards, each opening a workspace.
A mandate's workspace carries its newest statement (Holdings), the change against the statement
before it *by quantity* with the trades that produced each move (This period), the dated tape
(Trades), the manager's own fact-sheet returns (Performance) and its accounts (Profile). An
alternative fund carries its units, returns, bridges, commitments and distributions — and, where the
fund also files >1% stakes with the exchanges, a link to its Finology book. A fund house carries what
each scheme holds from the AMC's monthly disclosure, with the family's share of each underlying
derived and labelled. Under Watchlist the section is offered last and its moves narrow to the starred
symbols; under Universe it is not offered, because that scope means every tracked investor. The data
is `public/data/managers.json`, copied daily from GlowVentures beside the book (see
`docs/DATA-CONTRACTS.md`, GLOW-OWNED).

**Quarterly Changes carries the family's managers first.** Under Portfolio and Watchlist a *Your
managers this period* block — the same six ranked lists, over the mandates' statement-to-statement
moves — sits above the superstar roll-up, and every company row opens every mandate's before/now
quantity and weight with the trades in the window. Only PMS mandates enter it: a fund publishes no
portfolio, and a mutual fund's disclosure is a share of the fund. Nothing is scored.

**Superstar Investors has three in-page tabs of its own.** *All Investors* opens first with only the investor
cards. *Quarterly Changes* follows with the cross-book roll-up, so a reader can see companies bought
or sold down by more than one tracked investor, new entrants, the largest increases and reductions,
and positions no longer disclosed without opening ninety books one at a time. *Data Table* sits
after Quarterly Changes and owns the complete all-disclosed-positions grid, including search,
investor/change filters, watchlist control and Excel export. The chosen in-page tab survives scope
changes and live-data repaints until the reader leaves Super Investors.

The view stays intentionally quiet around that content: it renders no per-view cache/status pill,
scope-count tag, progressive-reading strip, or source/action badge in an investor workspace. Scope
and refresh already live in the global header; the workspace header is the investor name and tabs.

Every company in Quarterly Changes is clickable. Its popup names every relevant superstar
investor across the full book set and shows status, previous stake, current stake, derived change
and current Finology position value, so abbreviated labels such as `+1` never hide the answer.
The value is current position value, not a claim about how much was bought or sold.

**Institutions mirrors the same in-page pattern.** *All Institutions* keeps the fund picker and
full history table; *Quarterly Changes* rolls up new, increased, reduced and no-longer-disclosed
positions across the tracked quarterly shareholding books. Monthly AMC portfolios do not enter
that roll-up: their `% to NAV` is a weight in a fund, not a stake in the company. Clicking any
company opens every relevant quarterly institution book with its status, prior/current filed
stake, derived percentage-point change, Trendlyne value and filed share count.

Increases and reductions are in **percentage points of the company** — the only size a filing
states. A new or exited position carries **no size at all**, because a position appearing or
vanishing is a change of disclosure rather than a move of the whole holding, and "exited" is
always worded *no longer disclosed*. "Bought by more than one investor" is a **count of who
moved**, never a signal or a score. See *Rolling ninety books up into one screen* in `CLAUDE.md`.

Still to come — this list is now the only place the gap is recorded, since the dashed *Wiring
roadmap* card that used to close each tab has been removed from the UI:
- AMFI + Trendlyne mutual fund flow overlay
- Investor conviction scoring vs position size
- Cross-investor overlap heatmap

Fund *returns* are no longer here: they are the **Mutual Funds** tab. A saved
`#/research/super-investors/fund-returns` link still resolves — the shell rewrites it to the new
address rather than dropping the reader on a different page.

### Mutual Funds — `mutual-funds` (GLOW-OWNED)
Sub-views: **Category Performance · All Schemes**

Fund performance, which is a different question from the holdings on the tab before it — a fund's
return is not a stake in a company, sums with nothing there and joins to no company. It was a
sub-view of Super Investors because that is where the AmfiBeas feed happened to be wired.

**Category Performance** reads a weekly workbook committed to the repo: every mutual-fund category,
the median return the workbook published for it, and the index the workbook prints beneath that
category — both on the face of every cell, so a category return never appears without its
benchmark. Clicking a category opens its schemes, with the category's median, its index and the
derived gap between them pinned above the table.

**All Schemes** is the daily AmfiBeas feed: every tracked scheme, its point-to-point return per
period and its rank inside its own cohort.

**The two are different snapshots on different dates and no figure crosses between them.** The
workbook is weekly and is the only source here that publishes a category median or a benchmark; the
AmfiBeas payload has neither. Each sub-view prints its own as-on date, and All Schemes says in words
that a benchmark lives only on the other view. Putting the workbook's index return beside a live
fund return would be a comparison nobody measured.

**A hierarchical classification drills over both** — asset class → group → category, from
`js/data/mf-taxonomy.js`, over the workbook's 26 sheets and the live feed's 56 classification
strings alike. It is a reading aid over somebody else's category, not a new one: nothing is renamed
or merged. An asset class the workbook does not publish (debt, commodities, fund of funds) is
**named with the reason** rather than drawn as an empty group.

**The heatmap shades, and the shading explains itself.** A scheme's cell is tinted by where it sits
among the schemes in its own category over that period — a count, not a model — and a category's by
the size of its gap to its own index. Emerald above, rose below; a legend beside the table says
which. The figure printed is always the source's; only the background is added here.

**Exactly two figures are derived**, and both say so wherever they surface: the gap (a return minus
its category median or its benchmark, in percentage **points**, absent the moment either side is),
and the shade. The medians and index returns are reproduced unchanged — the import refuses to write
the file unless every published median reconciles against the scheme rows it parsed.

**The benchmark is the workbook's choice and the reader may change it**, from the indices the
workbook prints under *that* category and never from the 36-index master sheet. Where a sheet lists
a price index and its own TRI the TRI is used — the same index measured the way a NAV is — and where
a category is compared against a price index, that is flagged, because its gap is not on the same
scale as a TRI gap.

Scope does not apply: these are schemes, not companies. No row carries a watchlist star and the head
says so.

Still to come:
- Rolling-period and calendar-year returns, if the workbook ever publishes them
- Risk measures (standard deviation, Sharpe, max drawdown) — no source here carries them today
- Debt categories on Category Performance, which need a workbook that publishes them

### Overview — `overview`
Sub-views: **Positions · Allocation · Realised P&L**
- Live mark-to-market from the technicals feed; a position missing from it is marked *at cost*, tagged, and excluded from the curve — never marked at zero
- FIFO cost basis with charges folded in, and the open-lot table in every position drill
- A reconciliation strip showing the measured residual of both identities, not a claim that they hold
- Realised P&L as one row per FIFO lot match, each with its own buy date, holding period and short/long term
- Allocation by sector and conviction, plus a top-5 concentration bar
- *Not built:* broker import, target weights and drift alerts, tax-lot harvesting, intraday marks

### Position By — `position-by`
Sub-views: **By Sector · By Conviction · By Holding Period · By P&L Band**
- One grouping engine, four keys; each cut carries the aggregate that cut is actually about
- Holding period groups **lots, not positions** — a position built over three years sits in several bands at once, and the tax term follows the lot consumed
- Stacked weight bar, per-group drill, and an expandable ungrouped table showing the working
- *Not built:* market-cap/factor buckets, target-vs-actual weights, group-level benchmarking

### Transaction History — `transactions`
Sub-views: **Trades · Dividends & Actions · Import / Export**
- Every sell expands to the lots it consumed, with charges apportioned across them
- Dividends tracked as income, never folded into the cost basis
- Bonus/split adjust lots in place — quantity multiplied, cost per share divided, acquisition date preserved
- CSV import parses in-browser, previews, trial-replays, and names every rejected row with its line and reason; an applied import is **session-only** and says so, because a static site has no server to write the file
- *Not built:* contract-note parsing, server-side persistence, duplicate detection

### Drawdown — `drawdown`
Sub-views: **Equity Curve · Underwater Plot · Drawdown Episodes**
- Curve from real closes, with the cash line separated and the y-axis anchored at zero
- **Two** drawdowns — total portfolio and holdings-only — because retained cash dampens one and not the other
- **XIRR and TWR**, labelled money-weighted and time-weighted; only TWR is shown against the Nifty 500
- Every peak-to-trough episode with decline and recovery durations; an open drawdown reports "ongoing" rather than being closed at the last day
- Coverage is stated: excluded tickers are named, never silently dropped
- *Not built:* rolling volatility/Sharpe, per-position drawdown contribution, custom windowing

---

## 8. Roadmap

| # | Prompt | Scope |
| --- | --- | --- |
| 1 | Foundation + shell | File layout, nav model, scope toggle, routing, design system, UI primitives, live engine, mock data, placeholder panels, docs. ✅ *this prompt* |
| 2 | Technicals/breakouts data pipeline | Live Yahoo Finance EOD across NSE 500, Node 22 scripts in `scripts/`, GitHub Actions refresh, produces `public/data/technicals.json`. ✅ |
| 3 | Breakouts / Technical tab UI | 16-rule scoring model, four live sub-views, drill panel with per-rule provenance, Excel export. ✅ |
| 4 | Earnings Hub | 15-rule / 21-point Result Quality & Growth model, three sub-views (Latest Results, Result Scans, Quality & Growth), 8 built-in scans + a custom scan builder, drill panel with 8-quarter series and per-rule provenance, two-sheet Excel export. Earnings data is **synthetic but real-shaped** — generated by `scripts/gen-mock-earnings.mjs` and labelled as illustrative on every surface; wiring the real filings feed is a three-file change documented in `docs/DATA-CONTRACTS.md`. ✅ |
| 5 | Con-call + Deep Dive | Runtime keyword engine (scans transcript text in the browser — no stored counts), a full keyword-set editor persisted to localStorage, a 5s live-call ticker, a companies × keywords matrix with quarter-on-quarter deltas, catalyst tracking, and the six-view Deep Dive in a new full-screen `openWorkspace` overlay. Transcripts are **synthetic but real-shaped** — and unlike the earnings set, every person and brokerage named in them is fictional. ✅ |
| 6 | Public Chatter + Super Investors | Chatter: forum threads with claim extraction, Telegram groups with a transparent 0–3 pump-risk heuristic, and a cross-source Trending view joined to the **real** technicals feed with a chatter-vs-price quadrant. Investors: investor-first cards, a four-view per-investor workspace, a mandate view for funds, FII/DII and MF category flow charts, and an overlap heatmap. Both data sets are **synthetic** — and the investor names are **real people**, so their positions carry an attribution ribbon on every surface and the data set holds numbers only, never a quote or rationale. ✅ |
| 7 | Portfolio Analytics + polish and QA | A FIFO lot engine (`js/portfolio/lots.js`) replaying the ledger into open lots and realised rows with per-lot holding periods and tax terms; positions marked to market from the **live** technicals feed; an equity curve, two drawdown series and a Nifty 500 comparison built from **735 trading days of real Yahoo closes** (`scripts/scrape-portfolio-history.mjs`); XIRR *and* time-weighted return, because only one of them is comparable to an index; four sub-views over four cuts each; CSV import with preview-and-reject; and a QA pass covering error states, a11y focus traps, `scope="col"` on every header, and ~190 assertions in `scripts/verify-ui.mjs` including both reconciliation identities and an independent max-drawdown recompute. The ledger is **synthetic**; every price in it is real. ✅ |

| 8 | Tracked news keywords + cross-feed correlation | The desk's thirty keywords as one shared vocabulary (`public/js/data/news-keywords.js`), driving a counted Topic filter and column on both News surfaces, the materiality rule for company news in General Alerts, and a participation event (volume ≥ `VOLUME_X`, or a confirmed base break) on the technicals feed. AI Alerts gains `confluenceOf()` — seven **named** cross-feed patterns that say *"volume 3.2x its average, and a tracked investor's latest book shows buying"* instead of *"three feeds"*. A keyword is a **topic and never a direction**, so no story anywhere gains a sentiment of ours. Measured: 11,060 captured stories → 3,278 tracked. ✅ |

**Still to come**

- **Corporate Announcements does not use the taxonomy.** Several of the thirty words — *Receipt of
  Order*, *Corporate Governance*, *Commissioning* — are literally BSE filing phrases, so the fit is
  obvious. It is deliberately not wired: `announcementSignal()` already states its own materiality
  rule for that feed, and a second overlapping rule over one question is the pattern this codebase
  keeps having to un-write. Wiring it means **replacing** that rule, not adding beside it.
- **No keyword-targeted search.** "Company name + keyword" is answered by classifying the committed
  capture, not by sending 559 × 30 queries against a sixty-a-minute cap. If the upstream ever grows
  a topic axis, that becomes the cheaper question to ask.
- **Patterns are tuned against one capture.** Thirty of thirty fire on the shipped file, but *Fire*
  reaches one row and *Receipt of Order* two. Those are the two to re-measure once more history has
  accumulated; the Topic filter's **No tracked keyword** option is what makes a too-narrow pattern
  findable in the meantime.

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

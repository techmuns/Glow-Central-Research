# CLAUDE.md — working rules for this repo

Read this before touching anything. `docs/SPEC.md` has the product detail;
`docs/DATA-CONTRACTS.md` has every JSON shape.

---

## Hard rules

1. **Work on `main` only. Never create a branch.** Commit and push to `main` when done.
2. **No build step, no bundler, no framework, no npm dependencies for the app itself.**
   Vanilla ES modules, served as static files. If you find yourself adding a `package.json`
   for the front-end, stop — that's out of contract.
   (Node 22 scripts under `scripts/` that refresh data are fine and expected.)
3. **Everything must run by opening the static site.** Verify before pushing:
   `python3 -m http.server 8080 -d public`, then drive it with Playwright.
   Zero console errors is the bar.
4. Tailwind comes from the CDN (`https://cdn.tailwindcss.com`) — do not vendor or compile it.
5. Light theme only.

---

## Stack

| Concern | Choice |
| --- | --- |
| Markup | `public/index.html`, single entry |
| CSS | Tailwind via CDN + a small `:root` token block in `index.html` |
| Fonts | Inter 400–800 (body), Plus Jakarta Sans 600–800 (headings, `.font-display`) |
| JS | Vanilla ES modules, `<script type="module" src="js/app.js">` |
| Data | JSON in `public/data/`, refreshed by Node 22 scripts in `scripts/` via GitHub Actions |
| Hosting | Cloudflare Worker (`worker/index.js` + `wrangler.jsonc`) serving `env.ASSETS` |

---

## File layout

```
public/
  index.html                  design tokens, fonts, Tailwind CDN, #app mount, overlay roots
                              (drill z-50 < workspace z-55 < modal z-60)
  js/
    app.js                    bootstrap: load all JSON, then mount the shell
    core/
      state.js                global state + localStorage + pub/sub
      router.js               hash routing (#/ws/tab/subview?scope=)
      live.js                 live-update polling engine
      watch.js                app-wide feed watchers -> the alert stack
      store.js                IndexedDB payload cache + conditional fetch (see the caching section)
      format.js               number/date/currency/relative-time helpers
      dom.js                  $, $$, escapeHtml, el, empty
    ui/
      screener.js             THE SCREENER KIT — build tabs from this
      visual.js               avatars, tiers, status pills, signal dots, legend
      sources.js              data-source registry, opened from the header status pill
      notifications.js        the live alert stack, lower-right
      export.js               generic exceljs-from-CDN "Export Excel" helper
      components.js           chrome primitives (tab bar, rail, toggle, search…)
      shell.js                header + rail + tabs + content host + tab registry
    concall/
      scans.js                the WHOLE Con-call tab, live off StockScans (scores are THEIRS)
                              — the scan table plus the "Upcoming Concalls" schedule overlay
      deep-dive.js            the Deep Dive panel: trigger a run on the SEPARATE Concall Deep Dive
                              dashboard, mirror its progress, render its report (also THEIRS)
    investors/
      deep-dive.js            the four-tab per-investor workspace (synthetic set; Fund Flows only)
      filed.js                the REAL half of Institutions — filed shareholdings off Trendlyne
      live.js                 the WHOLE Superstar Investors view — real filed books off Finology
    data/
      coverage.js             THE BOOK — the 142 companies the Portfolio toggle means, and the
                              19 it cannot cover. NOT the ledger; see the section below
      technicals.js           loads + scores the live feed once, caches it
      earnings.js             same, for the earnings feed (+ legacy-summary adapter)
      chatter-live.js         the live chatter feed: mention counts + sentiment, split by
                              whether the slug resolved to a symbol we cover
      investors.js            holders, overlap matrix, company interest, fund flows (synthetic)
      institution-holdings.js real filed shareholdings, by institution (Trendlyne)
      finology-shared.js      pure shape guards + deriveMoves — imported by worker/finology.mjs
      sentiment-shared.js     pure shape guards + the slug->NSE resolver for the chatter feed
      super-investors.js      the live super-investor feed: list, then every book, four at a time
      deep-dive.js            transport for the Concall Deep Dive dashboard — a click costs a run,
                              so nothing in here fires on its own
      universe.js             screener-export -> legacy universe shape adapter
    scoring/
      tech-scoring.js         16-rule / 24-point technicals model (ported verbatim)
      earnings-scoring.js     15-rule / 21-point result quality + growth model
      rule-meta.js            per-rule provenance, keyed META[tabId][ruleKey]
    tabs/                     earnings-hub, concall, public-chatter, breakouts, super-investors
    portfolio/                overview, position-by, transactions, drawdown
  data/                       technicals.json, atr-history.json, portfolio-history.json,
                              earnings-live.json, mc-ticker-map.json, result-returns.json,
                              earnings-calendar.json, universe.json, portfolio.json,
                              portfolio-companies.json, mock/*.json
scripts/
  resolve-portfolio-companies.mjs  book names -> NSE symbols, collision-guarded
  scrape-technicals.mjs       the live pipeline (Yahoo EOD + NSE delivery %)
  gen-mock-earnings.mjs       seeded generator for the synthetic earnings set
  gen-mock-investors.mjs      seeded generator for holdings + fund flows
  scrape-institution-holdings.mjs  REAL filed shareholdings, per fund, off Trendlyne
  lib/trendlyne.mjs           the Trendlyne page parser, pure and testable offline
  stub-chatter.mjs            replays a captured chatter payload, so a verify run needs no egress
  verify-ui.mjs               the pre-push checklist, driven with Playwright
  lib/                        indicators.mjs, liquidity-estimators.mjs
.github/workflows/technicals-refresh.yml   weekdays 07:00 IST
worker/index.js               asset serving + POST /api/live-prices + GET /api/earnings
                              (+ ?fields=prices) + /api/earnings-calendar + /api/concalls
                              + /api/super-investors (+ /{slug})
worker/http.mjs               content ETags, 304s and CORS — shared with any local stand-in
worker/mc.mjs                 the Moneycontrol client + normaliser, shared with scripts/
worker/stockscans.mjs         the StockScans con-call client (vocabulary lives in public/js/data/)
worker/finology.mjs           the AUTHENTICATED Finology client — holds env.MUNS_TOKEN, never the browser
wrangler.jsonc
docs/SPEC.md                  product spec + roadmap
docs/DATA-CONTRACTS.md        every JSON file's shape, units, source, cadence
docs/HANDOFF.md               live-vs-mock inventory, architecture map, deploy, known gaps
```

---

## Module interface contract

Every file in `js/tabs/` and `js/portfolio/` exports exactly this. The shell is generic and
knows nothing about any individual tab beyond this contract.

```js
export const meta = {
  id: 'earnings-hub',
  title: 'Earnings Hub',
  subtitle: 'One line describing the tab.',
  subviews: [{ id: 'latest-results', label: 'Latest Results', badge: 12 /* optional */ }],
};

export function render(ctx) {}   // ctx = { scope, subview, root, live, data }
export function destroy() {}     // detach listeners/pollers; called on nav away
```

- `ctx.scope` is `'portfolio' | 'universe'` — **every tab must visibly reflect it.**
- `ctx.root` is the content host, already cleared.
- `ctx.data` is the loaded data set, keyed as in `DATA_SOURCES` (see `app.js`).
- `ctx.live` is the live engine.
- `render()` is called on every route change within the tab (sub-view or scope change too),
  so it must be safe to call repeatedly.
- `destroy()` is called only when navigating to a *different* tab. Unsubscribe and
  `live.stop()` there.

**To add a tab:** create the module, then add it to the `WORKSPACES` array in
`js/ui/shell.js`. That's the only registration point.

---

## Design tokens

Defined in `:root` in `public/index.html`. Use them; don't invent new colours.

**The brand ramp is indigo → purple → pink.** Emerald / amber / rose are *semantic only* —
they mean pass / partial / fail. Never use a semantic colour to mean "branded", and never use
indigo to mean "good".

| Token | Value | Meaning |
| --- | --- | --- |
| `--brand-500` | `#6366f1` | indigo — brand ramp start |
| `--brand-600` | `#4f46e5` | indigo-600 — links, actions, active nav |
| `--brand-mid` | `#a855f7` | purple — brand ramp middle |
| `--brand-end` | `#ec4899` | pink — brand ramp end |
| `--accent-600` | `#4f46e5` | indigo-600 — accent for links/actions |
| `--positive` | `#059669` | emerald — pass |
| `--caution` | `#d97706` | amber — partial |
| `--negative` | `#e11d48` | rose — fail |
| `--hard-fail` | `#be123c` | rose-700 — hard fail |
| `--neutral` | `#64748b` | slate — n/a |
| `--page-bg` | `#f8fafc` | page background |

The brand gradient, used on the logo mark, the scope toggle thumb and the freshness hero card:
`bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500`.

Conventions:
- Surfaces are white, `rounded-2xl`, `shadow-sm`, `ring-1 ring-slate-100`.
- Page background carries three radial gradients (violet TL, pink TR, sky BR), all ≤ 12%.
- Content column is `max-w-[1400px] mx-auto px-6`.
- `font-variant-numeric: tabular-nums` on every number-bearing cell.
- Tables scroll horizontally **inside their own container**; the page body must never scroll
  sideways. `overflow-x: hidden` on `html` *and* `body` is a backstop, not the mechanism —
  it's on `html` because the parked drill panel is `position: fixed` and `body` can't clip it.
- The left rail collapses to a dropdown under 1024px (Tailwind `lg:`), and **disappears entirely
  on a tab with `subviews: []`** — the content then spans the full width. The workspace switcher
  sits in the tab-bar row, not the rail, which is what makes that safe: dropping the rail never
  strands a workspace.
- Long-running lists get `.scrollbar-thin`; panels that mount fresh get `.fade-in`.

---

## The screener kit — `js/ui/screener.js` + `js/ui/visual.js`

**Build every tab out of these. Do not hand-roll a table, a stat row or a detail panel.**

`visual.js` is the shared vocabulary: `avatarFor(name)` (deterministic gradient + initials),
`scoreTier(pct)`, `scoreBadgeClass(pct)`, `tierLabel`, `tierColor`, `statusPill(status)`,
`signalDots(signals)`, `legendStrip()`, `STATUS_DOT`.

`screener.js` is the furniture:

| Component | Use |
| --- | --- |
| `statStrip(cards)` | the 4-up KPI row. Card 4 **must** be `{ hero: true, … }` — the gradient freshness card. Any card may carry `help: { title, body }` for a `?` explainer modal. **Not mandatory**: the Earnings Hub deliberately has none — see below. |
| `topCards({ title, items, valueFormat, onSelect })` | the Top-10 hero grid. `valueFormat: 'score'` renders `value/max` coloured by tier; `'metric'` renders one formatted number coloured by `tone`. |
| `scoreTable(config)` | the workhorse: search, filter select, watchlist, sort, export, sticky head, row click. |
| `openDrill(config)` | right-slide detail panel (singleton), 480px. For one row's detail. |
| `openWorkspace(config)` | full-screen overlay (singleton), `max-w-[1200px]`, with its own tab strip. For analysis that needs room — see below. |
| `openModal(html, { size })` | centred modal (singleton). `size`: `default` \| `wide` \| `magazine`. |
| `sectionHead`, `roadmapStrip`, `pendingPanel` | title block, the dashed roadmap card, and the honest "no data yet" panel. |

**A tab may opt out of the stat strip, and out of sub-views.** The Earnings Hub is one dense table
and nothing else: no stat cards, no ribbon, no rail. The rule that survives is not "every tab has a
stat strip" — it is **the provenance must always be reachable**. There it lives behind a small Live
pill in the section head, which opens a modal with what is live, what each column is joined from,
what is missing and what a dash means. Decluttering a page is fine; deleting its accountability is
not. A tab with `subviews: []` gets no rail — the shell hides that block and skips wiring it.

The standard tab body, in order:

```js
ctx.root.innerHTML = `
  ${sectionHead({ title, description, meta: scopeSummary({ scope: ctx.scope, count, noun }) })}
  ${stats.html}          // statStrip — 4 cards, 4th is the gradient hero
  ${cards.html}          // topCards — omit where no ranking is meaningful
  ${table.html}          // scoreTable
  ${legendStrip()}       // only on tabs that render signal dots
  ${roadmapStrip(FEATURES)}
`;
stats.wire(ctx.root); cards.wire(ctx.root); table.wire(ctx.root);
```

`scoreTable` essentials — `rows`, `key(row)` (watchlist id), `name(row)`, `sub(row)`, and
`columns: [{ label, get(row), html?, align?, sortable?, sortValue? }]`. `html: true` means
`get()` returns trusted markup, so **escape inside it yourself**. Optional: `showScore` +
`score(row) => { points, max, pct, redFlag? }`, `showSignals` + `signals(row) => [{ label, status }]`,
`filters`, `searchable`, `initialSort`, `onRowClick`, `link`, `exportName`.

Score and Signals are **opt-in**. A tab with no scoring model leaves `showScore` off rather
than rendering empty score furniture.

**Layout knobs, for wide numeric tables.** Defaults give the screener look; the Earnings Hub is
the only consumer that changes all four, because it carries ten numeric columns:

| Option | Default | Effect |
| --- | --- | --- |
| `showRank` | `true` | `false` drops the leading `#` column. The watchlist star does **not** go with it — it moves inside the identity cell, because the watchlist filter needs a per-row control. |
| `nameAfter` | `0` | How many of `columns` render *before* the identity column. `1` puts a date or ID column first. |
| `nameMaxPx` | `null` | Hard px cap on the identity column. `truncate` alone will not stop a long sub-line widening the table — a `<table>` in auto layout sizes to its widest content, so the cap on the inner block is what makes the ellipsis engage. |
| `dense` | `false` | `px-2` instead of `px-4`, and `tracking-normal` instead of `tracking-wider` on the headers. Worth ~110px across ten columns. |
| `wrapHeads` | `false` | Lets a heading stack onto two lines instead of forcing its column as wide as the label. On a wide numeric table **the headings, not the figures, are what overflows** — "Jun 26 Holding %" is far wider than "2.8%". Worth ~230px across thirteen columns. |
| `showAvatar` | `true` | The gradient mark in the identity cell. It costs ~46px, and on a table wide enough that company names would otherwise truncate, the name is what the reader is scanning for. |
| `filters` | `null` | One config, or an **array** of them. An array renders several `<select>`s that AND together — "PAT grew" and "Consolidated only" are different questions and folding both into one dropdown would make them mutually exclusive for no reason. |
| `initialView` | `null` | Seed search / filters / watchlist-only / sort from a previous instance's `view` (which the table now returns). A tab that rebuilds on live data must pass this, or the reader's state is discarded every time a row arrives. |
| `stickyHead` | `null` | A CSS length that makes the table body its own vertical scroller, e.g. `'max(320px, calc(100vh - 300px))'`. **This is what makes the sticky `<thead>` work.** `sticky` positions against the nearest *scrolling* ancestor, and `overflow-x: auto` on the wrapper makes that wrapper the scroll container in both axes — so without a height the head sticks to a box that never scrolls while the page scrolls underneath it. |

Reach for these only when the alternative is a horizontal scrollbar at 1440px. Measure before and
after — `[data-table-scroll]`'s `scrollWidth` vs `clientWidth` is the number that matters, and
`verify-ui.mjs` asserts it for the Earnings Hub (ten columns) and for Institutions (thirteen).

### Honesty rules for the kit

These are not style preferences — they are why the dashboard can be trusted:

1. **Never fabricate a number to fill a component.** If a feed hasn't landed, render
   `pendingPanel()` and drop the ranking grid.
2. **Signals must be direct readings**, e.g. "revenue YoY > 0", not a modelled judgement. A
   real points-based score only appears once its model is built and documented.
3. **Label derived figures as derived.** Super Investors' holding value is
   `holding % × market cap` and says so in the drill panel — filings disclose a percentage,
   never a rupee amount.
4. **Every `?` help modal states what is mock and what is live**, and which prompt wires it.
5. **Never attribute invented words to a real person.** This is a harder line than the mock-data
   rule and it is not negotiable by labelling. Synthetic *numbers* about a real subject are fine
   when marked: the earnings figures sit against real companies, and the Super Investors holdings
   sit against real, named investors, both under an unmissable ribbon. Synthetic *speech, views or
   rationale* attributed to a named real person are not fine at any labelling level, because a
   screenshot travels without the ribbon and the quote survives as something they said. So:
   con-call speakers and analysts are fictional, forum and Telegram handles are fictional, and
   `superinvestors.json` carries positions with **no** `rationale` / `quote` / `thesis` field —
   deliberately, so there is nothing to render. If a field would read as something a real person
   said or thought, drop the field.
6. **Synthetic numbers must be unmistakable wherever they surface.** Earnings Hub is the
   reference: an amber ribbon on every sub-view, a freshness card reading "Mock data · generated
   `<date>` · not a filing time" rather than a fake filing time, an amber note in the drill, an
   amber banner as row 1 of every exported sheet, and a `mock` row in the Sources modal naming
   the generator script. All five read one flag derived from the payload — see *Mock data that
   has to behave like real data* below. **A number that leaves the dashboard must carry its
   provenance with it**: an exported workbook is the one artefact nobody can see a ribbon on.

`wire()` returns a disposer when it registers anything global. Call it in `destroy()`.
**Always escape data-sourced strings** with `escapeHtml` from `core/dom.js`.

### The workspace overlay — `openWorkspace`

When one row's detail needs more than the 480px drill panel — several views over the same
entity, a transcript, charts side by side — use the workspace. The Con-call Deep Dive is the
reference consumer.

```js
openWorkspace({
  title: company.name,
  subtitle: `${ticker} · ${sector} · ${quarter}`,
  avatarName: company.name,          // drives the gradient avatar
  badges: [statusBadge, mockBadge],  // trusted markup, rendered beside the title
  actionsHtml: '',                   // trusted markup, top-right
  tabs: [{ id, label, badge?, render: () => html, wire?: (panel) => {} }],
  activeTab: 'summary',
  onTabChange: (id) => ctx.setParamsQuiet({ ...ctx.params, view: id }),
  onClose: () => ctx.setParamsQuiet(withoutDeepDiveParams),
});
```

Rules that make it behave:

- **`render()` is lazy and repeated.** A tab's `render()` runs when it is first shown and again
  on every return to it, so it must be cheap and side-effect-free. `wire()` gets the freshly
  rendered panel.
- **ESC and × close it; a backdrop click does not.** A workspace holds real state — a scrolled
  transcript, a search term — and a stray click outside should not discard it.
- **Scroll is locked** on `<body>` (`.workspace-open`) while it is open.
- **Stacking is drill (z-50) < workspace (z-55) < modal (z-60)**, so a modal opened from inside
  a workspace lands on top. The ESC handler checks for an open modal and defers to it.
- **`closeWorkspace({ silent: true })`** skips the `onClose` callback. The shell uses it on route
  change, where the URL is already being rewritten by the navigation.
- **Mirror its state into the URL with `ctx.setParamsQuiet()`, never `ctx.setParams()`.**
  `setParams` re-mounts the tab body, which would tear down the very overlay doing the writing.
  `setParamsQuiet` writes the URL and saves the route without re-mounting. Because the shell
  closes every overlay on mount, the owning tab is responsible for **reopening from the URL**
  after each paint — that is what makes `?deepdive=TICKER&view=comparison` survive a reload and
  work as a shared link.
- `refreshWorkspace()` re-renders the current panel in place, for when the data behind it
  changes (a keyword edit).

### Chrome primitives — `js/ui/components.js`

Navigation furniture only: `tabBar`, `railNav`, `segmentedToggle`, `searchInput`, `liveBadge`,
`scopeSummary`, `pill`, `badge`, `scorePill`, `filterChips`, `toolbar`, `emptyState`,
`skeleton`, `spark`, `tooltip`, plus the legacy `statCard` / `sectionHeader` / `dataTable`.
Prefer the screener kit for anything inside a tab panel.

### Adding a scoring model — the pattern prompts 5–7 should follow

**Two models now sit on this contract:** `tech-scoring.js` (16 rules / 24 points, ported verbatim
from LKP) and `earnings-scoring.js` (15 rules / 21 points, built here). They share every shape, so
the screener kit consumes both with zero special-casing. Copy their shape rather than inventing a
new one — earnings is the cleaner reference for a model written from scratch.

1. **The model lives in `js/scoring/<pillar>-scoring.js`** and exports:
   - `ACTIVE_RULES` — `[{ key, label, category, criteria, fn }]`
   - `scoreCompany(c)` → `{ company, breakdown, totalPoints, totalMax, scorePct, hardFails, naCount, tickerError? }`
   - `TOTAL_MAX` — the model's declared maximum, computed as `ACTIVE_RULES.reduce(… r.fn({}).max)`
     so it can never drift from the rules themselves.

   Each rule `fn(c)` returns `{ points, max, status, value, note }` where `status` is one of
   `pass | partial | fail | hard_fail | na`. **Missing input must return `na` with the rule's
   `max`** — never a zero that reads like a real measurement. A rule with no data costs the
   company those points and says so in the drill.

   `na` is also the right answer for input that is *present but meaningless*: earnings returns it
   for the other-income and tax-rate ratios when PBT ≤ 0, and for operating-profit-vs-PAT growth
   when either side is an operating loss. Taken literally that last rule rewards a collapse —
   operating profit falling from +466 Cr to −268 Cr scores −157%, which "beats" a PAT down −208%
   and would hand an operating-loss quarter full marks for earnings quality. **Check every
   ratio-of-growth-rates rule for that failure mode**, and give the `na` branch a `value` string
   showing the raw numbers so the drill still explains itself.

2. **Provenance lives in `rule-meta.js` under `META[tabId][ruleKey]`**:
   `{ source(company), calculation, clientLogic, ourLogic }`. One file, one entry per model —
   `META.technicals`, `META.earnings`. (`RULE_META` remains exported as an alias of
   `META.technicals` so the technicals drill needed no change.) A non-null `ourLogic` is what
   turns the drill panel's Implementation chip amber — set it whenever the implementation
   deviates from the stated logic, and explain how. Four earnings rules carry one.

3. **The data layer lives in `js/data/<feed>.js`**: fetch once, score once, cache, and expose
   `load() / all() / byTicker() / meta() / forScope()`. Tabs must never rescore on a sub-view or
   scope change — filter the cached list. If `app.js` already loads the payload at bootstrap,
   export a `prime(payload)` so the module seeds its cache instead of refetching.

4. **The tab turns scoring on** by passing `showScore` + `score(row)` and `showSignals` +
   `signals(row)` to `scoreTable`, and adds `legendStrip()`. Until a real model exists, leave both
   off — see the honesty rules above.

Score points may be fractional (ADX 20–25 scores 0.5; the earnings tax-rate rule scores 0.5).
Format with a helper, don't assume integers.

A gap between two percentages is measured in **percentage points**. Use a `pp` formatter —
`fmtSigned(gap) + ' pp'` renders the doubled unit "+2.0% pp".

### Reproducing someone else's analysis — the StockScans rule

The Con-call tab's live half shows a **result score**, a **sentiment tier** and **highlight
bullets** that StockScans computed, not us. That is allowed, and it is the user's explicit choice.
What makes it honest is that the boundary never blurs:

1. **Do not re-band, re-scale or recompute.** `resultTierOf()` in `js/data/stockscans-shared.js`
   uses StockScans' own cut-points (80 / 60 / 40 / 20), lifted from their client. A band of our
   invention under their score would read as their judgement and be ours.
2. **Say whose it is on every surface.** The sub-view description, the Live pill's modal, the
   drill's Provenance group and row 1 of the exported sheet all say the scores are StockScans'.
   The export banner matters most — a workbook leaves the page without its chrome.
3. **`pending` is not zero.** A call joins the feed when it is *held* and gains its analysis some
   minutes later. Until then the score is null and renders `pending`, exactly as it does upstream.
   A zero would claim they assessed it and found it worthless.
4. **Link, do not reproduce.** Full summaries and transcripts stay on StockScans; rows deep-link
   to their reader. We surface their index, not their content.
5. **One definition of the vocabulary.** `public/js/data/stockscans-shared.js` is pure and is
   imported by `worker/stockscans.mjs`, so the browser and the Worker cannot drift about what
   "Strong" means.

The same rules apply to any feed where the *analysis* is someone else's rather than the
*measurement*. **Institutions is the second consumer**: a shareholding filing discloses a share
count and a percentage of the company and never a rupee amount, so the ₹ value beside every
holding is Trendlyne's derivation — reproduced unchanged, headed "Value (Trendlyne)", and split
from the filings in the drill's Provenance group. `scrape-institution-holdings.mjs` refuses to
write the file unless its own total matches the one Trendlyne print on the page, which is how a
parse that silently dropped a row would be caught rather than shipped.

**Concall Deep Dive is the third**, and the strongest case: the whole artefact is theirs, not one
column of it. See below.

**Superstar Investors is the fourth**: the holding percentages are the companies' own filings, and
the ₹ value beside each one is Ticker Finology's derivation from a percentage and a market cap —
headed *Value (Finology)*, reproduced, never recomputed. The single figure this dashboard computes
on that feed is the quarter-over-quarter change, and it is headed *Change (derived)*.

### An upstream you CANNOT proxy — the same-zone Worker rule

Every other upstream here is proxied through our Worker, for politeness and for somewhere to stand
when it fails. The chatter API is not, and the reason is a platform rule rather than a preference.

**Cloudflare refuses a subrequest from one Worker to another Worker's `*.workers.dev` hostname on
the same account** — error 1042, *"Worker tried to fetch from another Worker on the same zone,
which is not allowed"* — and surfaces the refusal as a **404**. A `/api/chatter` route was written,
deployed, and returned 404 in production while `curl` returned 200 from the identical URL.

Three things to take from it:

1. **A 404 from an upstream is not proof the upstream is missing.** The tab said *"check that the
   API is deployed"* and the API was deployed, healthy, and answering. Diagnosis went to the one
   place with nothing wrong. When a named failure state can be produced by two very different
   causes, the message has to admit both — see `unavailablePanel` in `js/tabs/public-chatter.js`.
2. **`wrangler dev` versus the deployment is the test that settles it.** Identical code, variable
   and URL: locally it returned all 219 entries, deployed it returned a 404. That eliminates path
   construction, configuration and the upstream in one comparison, and leaves only *where the
   request is made from*. Run it first whenever an upstream behaves differently in production.
   The natural experiment was in the code too — moneycontrol.com, stockscans.in and devde.muns.io
   all worked, and the single `*.workers.dev` upstream was the single failure.
3. **The fix is where the call is made from, not what it sends.** The browser calls it directly, as
   it already does the Concall Deep Dive Worker. If a future upstream on this account genuinely
   needs proxying — to hold a credential — use a **service binding** (`"services"` in
   `wrangler.jsonc`) or give it a **custom domain**. Another `fetch()` cannot work.

**Carry the requested URL into the failure.** The first version recorded only a status code, and a
bare "404" is unfalsifiable: it cost a long investigation during which the upstream was healthy and
answering 200 to `curl` the whole time, while nothing on screen said which address had been asked
for. A failure state that cannot be diagnosed from its own artefact is half a failure state.

Calling from the browser cost nothing here, and that is a fact that was checked rather than
assumed: the API sends `access-control-allow-origin: *`, exposes `ETag` via
`access-control-expose-headers`, and answers `If-None-Match` with a bodyless 304 — so
`conditionalJson` and the device store behave exactly as they did against our own route. **Verify
those three headers with `curl -D-` before moving any feed to the browser**; without an exposed
ETag the client cannot revalidate and every poll becomes a full download.

### An upstream that needs a credential — the Finology rule

Every other source here is open. The super-investor API is not: it wants
`Authorization: Bearer …`. That changes three things.

1. **The token lives on the Worker and the browser never sees it.** `env.MUNS_TOKEN`, injected in
   `worker/finology.mjs`, exactly as `/api/live-prices` proxies Munshot. A token shipped to the
   client is a token published — there is no "obfuscated" version of this that is not that.
   `npx wrangler secret put MUNS_TOKEN` in production, `.dev.vars` locally (gitignored).
   `env.MUNS_BASE` redirects the upstream so a verification run never scrapes their production.
2. **A missing or rejected token is its own state, named on screen.** `no-token` and
   `unauthorised` are things an operator fixes, and the view says which command fixes them;
   `unreachable` / `upstream` are things to wait for. Collapsing them into one "could not load"
   wastes the only information that makes the failure actionable. Upstream failures come back as
   **200 with `ok: false` and a `reason`** — the request to our Worker succeeded — cached for 15
   seconds rather than the six hours a success gets, so a corrected token takes effect at once.
3. **A failed read is never an empty result.** `holdings: []` only ever travels with `ok: false`
   beside it, and the card says "could not be read". An investor who holds nothing and an investor
   whose book 500'd must never render the same.

And two that come from the upstream being a live scrape rather than an API over a database:

- **Cache hard and fan out on the client.** Shareholding data moves once a quarter, so the edge
  holds six hours and each book is stored on the device under its own tag. The list is one request
  and each book is another, walked **four at a time** with the view painting as they land. A
  `?full=1` that fetched every book in one request would turn a cold cache into sixty simultaneous
  page reads on their service.
- **A blank quarter is not a zero.** Below the disclosure threshold a real holding is invisible in
  the filing, so `null` travels to the cell, renders as an em dash, and is excluded from totals. A
  position disappearing is *"no longer disclosed"*, not *"sold"* — and neither `new` nor `exited`
  carries a percentage-point figure, because printing ±the whole holding would invent a trade size.
  This is the same class of error as `classifyChange()` and the `op_vs_pat` rule: **check every
  place a missing value could be read as a measured one.**

### Triggering someone else's pipeline — the Deep Dive rule

The Con-call table's last column dispatches a run on a **separate** dashboard, watches it, and
renders the report it produces. Everything in *Reproducing someone else's analysis* applies —
reproduce, never recompute; say whose it is on every surface; link to their own rendering — plus
three that only arise when you can make another service *do work*:

1. **Separate what costs money from what does not, and hold that line everywhere.** `POST
   /api/analyze` is unauthenticated and every accepted call starts a real LLM run; `GET
   /api/summary` and `GET /api/report` are free. So **nothing that costs a run ever fires on its
   own** — no poller, no peek on render, the cell is a button, the first click confirms, and
   "Re-run from scratch" returns to that confirm step rather than dispatching on the click.
   Reopening calls `resume(slug)`, which only polls; their API would dedup a second `POST` anyway,
   but not asking at all is the version that cannot cost a run through a bug of ours.
   **The free index, by contrast, IS fetched unprompted** — once per page load, never polled — so
   a row can say *"report ready"* instead of making the reader pay to discover it exists. Getting
   that backwards in either direction is the bug: polling their trigger, or charging for an answer
   already sitting there.
2. **The loading window is their screen, not one of ours.** A run takes minutes, and their API
   sends exactly one field while it runs: a bare `stage` key. Their own dashboard turns that into a
   sentence, a percentage and a seven-step checklist using the table in `js/analyze.js`; that table
   is copied into `js/data/deep-dive.js` and this panel draws the same screen. Reproducing their
   vocabulary is the rule (same as the StockScans tiers) — writing our own wording for "extract"
   would be describing their pipeline in our words and would drift the moment they changed it.

   Two failure modes, both of which happened here. Rendering the raw key shows the reader
   "EXTRACT". And **inventing a message where the payload has none** is worse: the panel printed
   "Waiting for the pipeline to report in…" because `message` does not exist in their response, so
   it implied nothing was happening while the stage beside it said the transcript was being read.
   The stage IS the information. `unknown` right after dispatch is KV lag, not failure — it is
   simply the first step of their checklist, never an error and never an empty report.

   The panel also carries nothing their screen does not: no elapsed clock, no trail of stages, no
   slug, no paragraph about how long runs take.
3. **Render by shape, not by field name, because the schema is not ours to pin.** `report`'s shape
   lives in their repo. Sections render **in their own key order** — reordering is editing their
   report — and each is drawn from what it *is*: uniform short scalars become a table, prose-
   carrying arrays become cards, flat objects become definition grids. Only `meta` is special-
   cased (provenance), plus two cosmetic hints (`*_url` links, `quote` blockquotes). A section they
   add next month arrives laid out rather than dropped. Escape every string and only ever make an
   anchor from an `http(s)` value — this is external content and none of it may reach the DOM as
   markup.
4. **Never show one company's report under another's name.** The panel is titled from our row and
   the report from theirs; a slug is resolved from two places, so if `report.meta.ticker`
   contradicts the row, say so loudly rather than retitling it.

The base URL is `window.SATTVA_DEEPDIVE_URL` in `index.html`; `localStorage['sattva:deepdive-base']`
overrides it, which is how `verify-ui.mjs` points the whole run at a stub so a verification never
touches — or spends against — the real dashboard.

### One tab, one provenance — and how it got that way

The Con-call tab used to carry six sub-views behind a left rail. Two were live off StockScans; the
other four ran on a **synthetic transcript corpus with fictional speakers**, because no open source
gives us full transcript text. Holding that line took an amber ribbon on one half, a green Live
pill on the other, `LIVE_SUBVIEWS` routing the two through separate code paths, and a rule that
neither half's poller could repaint the other.

The four synthetic views are gone, and so is the machinery: the tab is one live table plus the
schedule overlay, `subviews: []`, no rail, no ribbon. **That is the preferred resolution whenever
a tab acquires two provenances** — not a better ribbon. If the real transcript feed is ever wired
(BSE publishes filed transcript PDFs), the keyword engine and the Deep Dive workspace are in git
history at `8e31eec..` and would come back pointed at real text.

The rule that survives: **never put a live number and a synthetic one in the same panel**, and
prefer removing the synthetic one to labelling it.

### Mock data that has to behave like real data

`earnings.json` is synthetic but built to the exact contract of the real feed, and the tab is
wired as if it were live. The pattern for any feed in that state:

- Put the honesty switch **in the data**, not in the code. `meta().isMock` is derived from the
  payload's `source` field containing "mock". Every marker — the amber ribbon, the freshness card,
  the drill note, the export banner — reads that one flag, so swapping the file in flips all of
  them at once and no marker can be left behind.
- Generate it from a **seeded** script committed to `scripts/`, so the file regenerates
  byte-identically and a diff means a real change.
- Keep real what can be real. Names, tickers, sectors and market caps come from `universe.json`;
  only the financials are invented, and the ribbon says exactly that.
- Document the swap in `docs/DATA-CONTRACTS.md` under a "Wiring the real feed" heading — the list
  of files to touch, in order.

### Performance on large tables

`scoreTable` handles 500+ rows because of three things — keep them if you touch it:
- listeners are **delegated** on `<thead>` / `<tbody>`, never per row;
- row markup is **position-independent** (rank comes from a CSS counter, the click target carries
  the row key) and cached by key, so it is built once;
- a repaint whose row set the DOM already contains **moves existing `<tr>` nodes** instead of
  re-parsing HTML. That is what keeps a 535-row sort at ~30ms instead of ~150ms.

### Data sources

The header "Sources" modal is generated from `js/ui/sources.js`. **Adding a data source means
updating three things together**: the contract in `docs/DATA-CONTRACTS.md`, the loader in
`js/app.js`, and the entry in `sources.js` (including its honest `status`: `live` / `mock` /
`pending`).

---

## What "Portfolio" means — `js/data/coverage.js`

**The scope toggle filters by the book, not by the ledger.** `public/data/portfolio-companies.json`
is the family office's direct-equity statement — 142 companies, names and sectors only, resolved to
NSE symbols by `scripts/resolve-portfolio-companies.mjs`. `coverage.js` primes it at bootstrap and
exposes `holdings() / tracked() / uncovered() / has(ticker) / meta() / coverageNote()`. **Every
`forScope()` in every research tab reads it. Nothing reads `ctx.data.portfolio.holdings` for that
purpose any more** — that path is the ledger's, and it lists twelve positions.

Do not merge the two files. `portfolio.json` carries quantities and costs, the FIFO replay
reconciles against it, and `verify-ui.mjs` asserts two identities numerically; widening it to 142
lines would break both and invent quantities nobody supplied. The statement gave names only —
value and weight were explicitly out of scope. See the table in `docs/DATA-CONTRACTS.md`.

Three rules:

1. **A line with no ticker is still a holding.** Nineteen of the 142 have no NSE symbol: five
   unlisted private companies, the four Vedanta demerger entities, two warrant lines, five BSE-only
   companies and three whose symbol could not be found. They stay in the file with a `reason` and
   surface as *held but not covered*. Dropping them would silently redefine "Portfolio" as *"the
   123 we happen to have a feed for"* — the same class of error as rendering a missing value as
   zero.
2. **Always print the denominator.** `scopeSummary({ scope, count, noun, book })` renders
   *"Portfolio · 96 of 142 reported"*, and `coverageNote()` writes the long form. Ninety-six rows
   look complete until you know the book is 142, and no feed covers all of it: Breakouts reaches
   **123** — every listed line — Earnings Hub 103, Con-call 77 (plus scheduled), Public Chatter 4.
   Breakouts reaches all of them because it is the one feed whose input we control, and it only
   does since the scrape stopped reading the NSE-500 export alone (see *The universe is the index
   plus the book* in `docs/DATA-CONTRACTS.md`). Where a feed is someone else's index, the gap is
   theirs and the denominator is how the reader can tell.
3. **Resolve by script, never by hand, and let it fail on a collision.** Two book lines resolving to
   one symbol means one is wrong — *Allcargo Global* and *Allcargo Logistics* are `AGL` and
   `ALLCARGO`, and without the guard one would have inherited the other's rows. Names checked by
   hand live in the script's `CONFIRMED` table; not-listed lines live in `NOT_LISTED_EQUITY` so a
   later run cannot "resolve" a private company to a same-named listed one.

---

## Portfolio Analytics — the FIFO engine and the two identities

`js/portfolio/lots.js` replays the ledger once per page load; `js/data/portfolio.js` joins the
result to the live technicals feed and to `portfolio-history.json`. The four sub-views read that
cached result — **never rescore or replay on a sub-view or scope change.**

**Two identities must hold exactly**, and `scripts/verify-ui.mjs` asserts both numerically against
the shipped data, not against a fixture:

1. `sum(open lot quantities) === position quantity`, per ticker — and `portfolio.json` agrees.
2. `realised + unrealised + dividends === total P&L`, **per position**, not merely in aggregate.

If either drifts, the position table and the ledger are telling different stories about the same
money. The Overview shows the measured residual rather than claiming correctness in prose.

Four rules that are easy to break:

- **Charges belong in the basis.** Buy-side charges are folded into cost per share; sell-side
  charges reduce proceeds, apportioned across the lots consumed.
- **Dividends are income, never a discount on the purchase.** Folding them into the basis would
  disguise income as a cheaper entry.
- **Corporate actions adjust lots in place** — quantity multiplied, cost per share divided, total
  cost unchanged, **acquisition date preserved**. A zero-price "buy" for bonus shares would reset
  the holding-period clock and misclassify a later sale as short term.
- **Missing input is not zero.** A sell larger than the holding, or an unknown type, goes to
  `book.errors[]`. A position with no live price is marked *at cost*, tagged "at cost", and excluded
  from the equity curve — marking it at zero would invent a −100% position.

### The back-adjustment trap — read before touching prices or corporate actions

**Yahoo's `close` is back-adjusted for splits and bonuses**: a 2024 price is restated in today's
share terms. Two consequences, and getting either wrong bends the equity curve on a day nothing
happened, in the one chart where an artefact reads as risk.

1. A ledger may carry a corporate-action row **only for an action the price series was adjusted
   for**. An invented split on a real ticker doubles the quantity while the series stays put, and
   the curve jumps 100%. This is why both synthetic actions in the mock ledger sit on the one
   holding with no price series at all.
2. Where an action row does exist, `dailyPositions()` returns `valuationQtyByDate` — the holding in
   **current share terms** — and the curve values against that. The two corrections cancel exactly.

Check the series before trusting a recollection about a corporate action. A draft of the generator
mirrored a "real" CDSL bonus that is not in this window; the data said so and the double-count was
caught before it shipped.

### Two return figures and two drawdowns, deliberately

The raw curve rises from ~₹92k to ~₹42.6L, and most of that is money paid in. So **XIRR** is
money-weighted (what the investor earned) and **TWR** is time-weighted (what the strategy returned,
contributions stripped out) — TWR is the only one comparable to an index, and the only one shown
against the Nifty 500. Never label the curve's start-to-end move a return.

Likewise: the headline drawdown is the total portfolio (retained cash dampens it, correctly), and a
second holdings-only figure answers "how far did the stocks fall". Both are labelled; neither is
presented as *the* drawdown.

### The split provenance ribbon

Portfolio Analytics is the one workspace where mock and real meet inside a single number, so it
does not use the plain amber ribbon. `provenanceRibbon()` in `js/portfolio/chrome.js` renders both
halves — amber for the ledger, emerald for the mark — and adapts when a feed is missing. All four
sub-views call that one function; change it there, not four times.

---

## Overlays are modal to the keyboard too

`openDrill`, `openModal` and `openWorkspace` all call `trapFocus()` (in `js/ui/screener.js`), which
sets `role="dialog" aria-modal="true"`, moves focus in, keeps Tab inside, and restores focus on
close. If you add a fourth overlay, use it — without it a keyboard user is left tabbing through the
page behind a panel they cannot see, and closing it drops focus to `<body>`.

Every `<th>` carries `scope="col"`. The verification suite fails if one does not.

---

## The live earnings feed — the one per-request live surface

Everything else in this dashboard is live *on a schedule*: a GitHub Action scrapes, commits, and
the site serves a file. The Earnings Hub is live *per request*. `worker/index.js` proxies
Moneycontrol behind a 30-second edge cache and the browser polls it, so a company that files at
14:32 is on screen by about 14:33 with no Action run and no rebuild.

Four rules hold it together:

1. **One normaliser, two consumers.** `worker/mc.mjs` is pure and dependency-free (`fetch` is a
   parameter), imported by both the Worker and `scripts/scrape-earnings.mjs`. That is what stops
   the committed fallback from disagreeing with the live route about shape.
2. **The proxy exists for politeness and for the fallback, not for CORS.** Moneycontrol sends
   `access-control-allow-origin: *`, so the browser could call it directly. Going through the
   Worker means a thousand readers cost the upstream one fetch per cache window, and gives us
   somewhere to serve the last committed snapshot from when it breaks — labelled `degraded`, never
   as an empty "no results".
3. **Refresh the cache on every tick; repaint only on a STRUCTURAL change.** Prices move
   constantly. An early version fingerprinted the price too, so the 1,300-row table rebuilt every
   30 seconds and threw away whatever the user had sorted. The fingerprint now covers identity and
   the reported figures only.
4. **The fingerprint must be order-independent.** The payload arrives in Moneycontrol's sort order
   while the cache is held in ours; anything order-sensitive reports "changed" on every single
   tick. It sums per-row hashes for exactly this reason.

### A percentage across a sign change is not a growth rate

169 of 1,319 companies in a full quarter — **13%** — report a profit move where the sign flips.
Moneycontrol gives all of them a plain percentage. Rendered as a coloured number they lie:

- **Loss in both periods.** Vodafone Idea's "+43%" is a loss narrowing from ₹6,608 Cr to ₹3,754 Cr.
- **Loss → profit** and **profit → loss.** A change across zero has no percentage at all.

So `classifyChange()` tags every metric with a `kind`, `pct` is null wherever no honest percentage
exists, and the UI renders a labelled pill instead of a number. This is the same failure mode as
the `op_vs_pat` rule in the earnings model — **check every growth figure for it.**

### Market cap is computed, not stored

`mc-ticker-map.json` holds the **share count**, not the market cap. The browser multiplies it by
the price on the current tick, so the column is correct now rather than as-of the last refresh.
Verified against Moneycontrol's own figure to the rupee.

### Joins that can legitimately miss

scID → ticker (1,319/1,319), ticker → market cap and industry, and (ticker, result date) → the
result-day close (1,312/1,319). Every miss renders as an em dash and the coverage note under the
table counts them. **A dash means "not joined"; it never means zero.**

---

## The header, and the alert stack — `js/ui/notifications.js` + `js/core/watch.js`

The header carries the brand, the scope toggle, **one** status pill and a refresh button. There
used to also be a global search box, a Sources button, a green *"Live · just now"* chip and a white
*"Updated 52 minutes ago"* chip. The two chips are the instructive removal: they made competing
claims about the same subject, and the green one tracked the 20-second heartbeat — a poller whose
"fetcher" returns `Date.now()` without asking any server anything — so it read *"just now"* whether
or not a byte had been confirmed in an hour.

- `statusControl()` in `components.js` is the replacement: `● Live · updated 4m ago`, on
  `live.getLastDataTick()`, plus a refresh button that **says what it found** (`Up to date` /
  `3 new`) rather than spinning and vanishing.
- `live.register(id, { synthetic: true })` keeps a poller out of `getLastDataTick()`. The heartbeat
  is the only one. **Freshness has to be a claim about data**, so anything that does not talk to a
  server does not get to move that clock.
- **The Sources button is gone from the chrome, not from the app** — the pill opens it. Provenance
  must stay reachable from every screen (see the honesty rules above), and a freshness control is
  the right home: *how current is this* and *where did it come from* are one question.
- `live.refreshAll()` ticks every **running, non-synthetic** poller and resolves when they settle.
  It deliberately does not start stopped ones: a stopped poller belongs to an unmounted tab.

### Alerts: what may interrupt, and what may not

`notifications.push({ key, kind, title, detail, href })` renders a card in the lower-right stack.
`core/watch.js` feeds it from the two live feeds' existing `onChange` + `newArrivals()`.

Five rules, and each is load-bearing:

1. **An alert is a fact that arrived**, never a summary of what is on screen. A repaint is not an
   event; a company filing a result and a con-call gaining its analysis are.
2. **`key` dedupes for the life of the page.** Both feeds re-hand their whole arrival list on every
   change, so without a stable key the same result re-announces itself on every tick.
3. **The backlog is suppressed, not replayed.** Arrivals accumulate from page load, so the
   watcher's first change event would otherwise dump rows the reader has been looking at for ten
   minutes. `notifications.suppress(keys)` marks them announced without showing them — a
   notification asserts *this just happened*, and replaying history through it devalues every alert
   after it.
4. **z-30: alerts sit under every overlay** (drill 50 < workspace 55 < modal 60). The reader opened
   those deliberately; a toast landing on top of one is the failure mode this component is one step
   from.
5. **The text obeys the same honesty rules as the tables.** `earningsDetail()` routes through
   `kind` from `classifyChange()`, so a loss-to-profit swing reads *"turned profitable"* rather
   than a percentage that does not exist; a con-call with no score reads *"analysis pending"*, not
   `0/100`. The suite asserts both.

**The watchers run app-wide, and that is the whole point.** `startLive` / `stopLive` are owned by
the tab that shows a feed — right for a table, useless for an alert, which is only worth having if
it fires while the reader is elsewhere. So `watch.start(live)` holds its own claim on both pollers
and `watch.ensureRunning()` re-asserts it after every route change, because the tab you just left
called `live.stop()` on the same id. This is affordable **only** because both feeds are conditional:
an unchanged con-call tick is a bodyless 304 and an unchanged results tick is the ~30KB prices
projection. Without the caching layer, watching two feeds app-wide would be indefensible.

---

## Live engine — `js/core/live.js`

```js
live.register('concall-live', { intervalMs: 5000, fetcher: myDeltaFetcher });
const off = live.subscribe('concall-live', (payload) => paint(payload));
live.start('concall-live');   // in render()
live.stop('concall-live');    // in destroy(), and call off()
```

- Pollers run only while started **and** the document is visible; they pause on hidden and
  refetch immediately on return.
- Exponential backoff on error, capped at 60s. Errors never reach the UI.
- Swap mock → real by changing one argument: `live.realFetcher('/api/technicals')`.
- **`live.mockFetcher(path)` re-reads `path` on every tick and jitters its numbers.** That is fine
  for a small file whose numbers are meant to breathe, and wrong for anything else — a feed with
  real figures must poll the real route, and jittering quoted speech would invent words nobody
  said.
- **A tick that early-returns from `tick()` never reschedules.** The `!running || hidden ||
  inFlight` guard has no `finally`, so a fetcher that never settles kills the poller silently —
  no error, no tick, just a feed that quietly stops. If you write a fetcher, make sure every path
  through it resolves.

---

## Never re-download what the reader already has — `js/core/store.js`

The two polled feeds are large: the results payload is **1.1MB** and the con-call scan **450KB**,
and both are polled every 30 seconds. Every loader used to fetch with `cache: 'no-store'`, which
forbids reuse outright, so a single open Earnings Hub tab pulled **1,135KB per tick — ~136MB an
hour** to discover that nothing had changed. Fixing that is what `core/store.js` and the ETag
layer in `worker/http.mjs` are for.

Measured, end to end in Chromium: cold visit **2,388KB** → reload **5KB** → one unchanged poll
**0.3KB**.

Three mechanisms, and each is load-bearing:

1. **A content ETag on every GET route** (`withTag` / `revalidate` in `worker/http.mjs`, shared by
   the Worker and any local stand-in). A matching `If-None-Match` gets a bodyless 304.
   The tag is computed over the payload **minus the volatile keys** — `fetchedAt`, `servedAt`,
   `resolvedOnTheFly`, `unresolved`, `contentTag` itself. Miss that and the tag changes on every
   request while the content does not, and the 304 never fires. `stableJson` drops them with a
   replacer rather than a field list, so a field added next month is covered automatically.
   **The test that matters is that the tag survives an edge-cache expiry**: the Worker re-fetches
   upstream, re-normalises, re-stamps the timestamps, and must still produce the same tag.
2. **A persistent store** (IndexedDB, `js/core/store.js`). First paint comes off the device with
   no network at all; the committed snapshot is fetched last and only when the store is empty or
   the live route is unreachable. **The store holds the server's own bytes under the server's own
   tag** — never a locally patched copy. That pairing is the entire basis for trusting "you
   already have this", and price updates are folded into memory only, never written back.
3. **A prices-only projection for the results feed**, `GET /api/earnings?fields=prices` — scID →
   `[ltp, changePct]` plus a `structureTag`, ~30KB against 1.1MB. This exists because the results
   feed is the one place a conditional GET alone buys nothing: `ltp` moves on every tick during
   market hours, so the full representation genuinely changes every 30 seconds even when not one
   reported figure has. The client re-fetches the full feed exactly when `structureTag` moves,
   which is when a company has filed or revised. **The con-call route deliberately has no
   projection** — nothing on a con-call row moves on a tick, so the 304 does the whole job there,
   and a merge path that could drift from the server's truth would be complexity for nothing.

Rules:

- **Do not hand-roll the conditional request.** `cache: 'no-store'` plus your own `If-None-Match`
  is the obvious implementation and Chromium kills it: the 304 response is aborted with
  `net::ERR_ABORTED` a couple of seconds later, the fetch rejects, and because pollers swallow
  optional errors the symptom is not an error — it is a feed that silently stops updating. Use
  `cache: 'no-cache'` and let the browser send the validator. `conditionalJson` then compares the
  response ETag against the stored one **before** reading the body, so an unchanged tick still
  skips the parse.
- **`no-cache` for committed static files, never `no-store`.** `no-store` forbids reuse; `no-cache`
  revalidates and reuses. That one word was ~800KB per visit.
- **Caching must never cost freshness, and it must never be able to claim freshness it lacks.**
  `meta.origin` says where this paint came from (`live` / `store` / `snapshot`) and
  `meta.checkedAt` when the server last confirmed it — a different fact from `meta.fetchedAt`,
  which is when the upstream was read. A 304 moves the second and not the first. `deliveryNote()`
  in `js/ui/sources.js` renders both, and both Live pills carry it.
- A store miss is never an error. It means "fetch it", which is what the code did before the store
  existed. Private windows and disabled storage fall back to an in-memory Map, and
  `isPersistent()` reports it so the UI can say so.

---

## Where to look for what

| I need to… | Go to |
| --- | --- |
| Build a tab panel | `js/ui/screener.js` — assemble, don't hand-roll |
| Add or change a scoring model | `js/scoring/` + `js/data/` — see the pattern above |
| Change the technicals pipeline | `scripts/scrape-technicals.mjs` (`TECH_LIMIT=15` for a smoke run) — its universe is the NSE-500 export **plus the book**, deliberately; read *The universe is the index PLUS the book* in `docs/DATA-CONTRACTS.md` before narrowing it |
| Price a company the technicals feed is missing | `TECH_FILL_GAPS=1 node scripts/scrape-technicals.mjs` — fetches only what is absent or errored and merges, so it costs one request per gap |
| Change the live earnings feed | `worker/mc.mjs` (client + normaliser) then `worker/index.js` (`/api/earnings`) |
| Change the results calendar | `fetchCalendarStrip()` / `fetchCalendarDay()` in `worker/mc.mjs`, then `/api/earnings-calendar` — read the top-20 cap **and the Akamai note** in `docs/DATA-CONTRACTS.md` first |
| Refresh the calendar capture | `node scripts/scrape-calendar.mjs` (`CAL_BACK`/`CAL_AHEAD` to widen) |
| Change the chatter feed | `js/data/chatter-live.js` + `js/data/sentiment-shared.js` — the browser calls it DIRECTLY and must; read *There is no `/api/chatter`* in `docs/DATA-CONTRACTS.md` before adding a proxy. `changePct` there is mention volume, not price |
| Change the super-investor feed | `worker/finology.mjs` + `public/js/data/finology-shared.js`, then `/api/super-investors` — read *An upstream that needs a credential* below first |
| Change the Superstar Investors view | `js/investors/live.js` — the whole sub-view is that one file |
| Change the live con-call feed | `worker/stockscans.mjs` + `public/js/data/stockscans-shared.js`, then `/api/concalls` — read *Reproducing someone else's analysis* below first |
| Change the Con-call tab or its schedule overlay | `js/concall/scans.js` — the whole tab is that one file |
| Change the Deep Dive column or panel | `js/concall/deep-dive.js` (panel) + `js/data/deep-dive.js` (transport) — read *Triggering someone else's pipeline* below first |
| Refresh the con-call snapshot | `node scripts/scrape-concalls.mjs` |
| Change how a growth figure is classified | `classifyChange()` in `worker/mc.mjs` — read the sign-change rules above first |
| Refresh the earnings snapshot / ticker map | `node scripts/scrape-earnings.mjs` (`REFRESH_ALL=1` to re-resolve share counts) |
| Add result-day base prices | `node scripts/scrape-result-returns.mjs` — incremental, one call per new result |
| Refresh the portfolio price history | `scripts/scrape-portfolio-history.mjs` (`HISTORY_YEARS=5` to widen) |
| Add or remove a company from the book | `BOOK` in `scripts/resolve-portfolio-companies.mjs`, re-run it (`--net` for the leftovers), commit `public/data/portfolio-companies.json` |
| Change what the Portfolio scope filters by | `js/data/coverage.js` — read *What "Portfolio" means* above first; it is **not** `portfolio.json` |
| Change FIFO lot matching or corporate actions | `js/portfolio/lots.js` — read the two identities above first |
| Change how positions are marked or the curve is built | `js/data/portfolio.js` |
| Change the portfolio provenance ribbon | `provenanceRibbon()` in `js/portfolio/chrome.js` — one function, four sub-views |
| Regenerate the mock ledger | `node scripts/gen-mock-transactions.mjs` — seeded; also rewrites `portfolio.json`'s derived fields |
| Wire the real ledger | `docs/DATA-CONTRACTS.md` → "Wiring the real ledger" (6 steps) |
| Hand the project over | `docs/HANDOFF.md` |
| Regenerate the mock earnings set | `node scripts/gen-mock-earnings.mjs` — seeded, so output is stable |
| Wire the real earnings feed | `docs/DATA-CONTRACTS.md` → "Wiring the real feed" (3 files) |
| Add or change a result scan | `js/tabs/earnings-scans.js` — the definition string and the predicate live in the same object |
| Regenerate the mock investors | `node scripts/gen-mock-investors.mjs` |
| Wire another fund's real holdings | one entry in `FUNDS` in `scripts/scrape-institution-holdings.mjs`, then re-run it |
| Build a full-screen analysis view | `openWorkspace` in `js/ui/screener.js` — don't grow the drill panel |
| Run the pre-push checks | `node scripts/verify-ui.mjs` (serve `public/` on :8080 first) |
| Add a server route | the API block in `worker/index.js` — return through `withTag` + `revalidate` so it is conditional like the rest |
| Add/change a tab or sub-view | the module in `js/tabs/` or `js/portfolio/`, then `WORKSPACES` in `js/ui/shell.js` |
| Change avatar / tier / status-pill styling | `js/ui/visual.js` |
| Change the header, rail or tab bar | `js/ui/shell.js` |
| Add a row to the Sources modal | `js/ui/sources.js` (and `docs/DATA-CONTRACTS.md`) |
| Add a reusable chrome widget | `js/ui/components.js` |
| Change the header status pill or refresh button | `statusControl()` in `js/ui/components.js`, wired in `wireStaticHeader()` |
| Change what raises a live alert | `js/core/watch.js` (what counts as an event) + `js/ui/notifications.js` (how it looks) — read *The header, and the alert stack* first |
| Change routing or URL shape | `js/core/router.js` |
| Add persisted state | `js/core/state.js` |
| Add a polled/live data source | `js/core/live.js` + `live.register` in the owning tab |
| Stop a feed re-downloading itself | `js/core/store.js` (client) + `worker/http.mjs` (ETag/304) — read *Never re-download what the reader already has* first |
| Change what counts as a content change | `withTag` / `VOLATILE_KEYS` in `worker/http.mjs`, and `structureTagOf` in `worker/index.js` |
| Add a cached feed to the device store | give it a key in `KEYS` (`js/core/store.js`) and fetch it with `conditionalJson` |
| Add a new JSON file | drop it in `public/data/`, add to `DATA_SOURCES` in `js/app.js`, document it in `docs/DATA-CONTRACTS.md` |
| Add a server route | the marked `/api/*` block in `worker/index.js` |
| Understand a JSON shape / unit / source | `docs/DATA-CONTRACTS.md` |
| Understand the roadmap | `docs/SPEC.md` §8 |

---

## Verification checklist before pushing

```bash
python3 -m http.server 8080 -d public
```

Then run the suite — ~190 Playwright assertions, exits non-zero on the first failure
(Chromium is preinstalled — never run `playwright install`):

```bash
node scripts/verify-ui.mjs
```

It covers, beyond the checklist below:

- shell renders with **zero console errors**
- all 9 tabs across both workspaces render their panel
- every tab that has a statStrip shows 4 cards with the gradient freshness hero as the 4th
  (the Earnings Hub has none by design; its Live pill carries the provenance instead)
- rail sub-views switch content
- the Portfolio/Universe toggle changes what every tab reports
- the URL hash updates; browser back/forward work
- a reload restores the same route and scope
- the top-tab underline scales in on the active tab only
- top cards and table rows open the drill panel; ESC and the backdrop close it
  (the Earnings Hub has no drill by design — its rows are inert and the suite asserts that)
- scoreTable search, header sort, filter select and watchlist toggle all work, and the
  watchlist survives a reload
- the Sources modal opens off the status pill and lists every documented source
- the header carries no search box and no Sources button, exactly one status pill reading
  "Live · updated <when>", and a refresh button that reports a result
- an alert renders in the lower-right corner, never announces the same event twice, caps its stack,
  sits behind all three overlays, and never turns a sign change into a growth rate or an
  unanalysed con-call into a score of nil
- layout holds at 1440px, 1024px and 390px with no sideways page scroll
- the Earnings Hub's ten columns fit inside 1440px with no scrollbar of their own, and its
  reported-figure columns recompute to the growth percentage shown beside them
- its column headings stay put while the body scrolls, and its rows are in the upstream's own
  order within the newest date — not merely date-sorted
- the Earnings Hub's YoY/QoQ toggle repoints the comparison columns and the URL, survives a
  reload, and leaves the current-period figure for a given company **identical** under both
- its two filter dropdowns partition the set exactly (STD + CON = all) and combine rather than
  replace each other
- **the book is whole**: every line from the statement is present, each carries a ticker or a stated
  reason it has none, no two lines collapse onto one symbol, the counts add up, every Portfolio-
  scoped row on Earnings Hub / Con-call / Breakouts resolves to a book ticker, and each of those
  pills prints the denominator
- **the two portfolio identities**, computed against the shipped data: open lots sum to position
  quantity on every ticker, and realised + unrealised + dividends equals total P&L per position
- **max drawdown recomputed independently** of the module that produces it, agreeing to 4dp on both
  the depth and the trough date
- the no-live-price and no-price-history fallbacks say what is missing rather than showing zeros
- the CSV round trip parses every row back, and a malformed file names each rejection with its line
- every `<th>` carries `scope="col"`; the three overlays trap focus and restore it on close
- **the two polled feeds do not re-download themselves**: the payload is kept on the device under
  a tag that describes it, a repeat fetch of either transfers headers and no body, the prices
  projection is a fraction of the full feed, the Live pill says where the paint came from, and no
  static-file loader is still using `cache: 'no-store'`

> The caching checks need a Worker. Against a plain `python3 -m http.server` there is no
> `/api/*`, so they report **SKIP** — which is itself worth seeing, because it exercises the
> snapshot fallback. Verify a caching change against `npx wrangler dev`:
> `node scripts/verify-ui.mjs http://127.0.0.1:8787`. A SKIP there is not a pass.

> Sandbox note: the agent proxy only accepts CONNECT, so headless Chromium cannot reach
> `cdn.tailwindcss.com` or Google Fonts. To screenshot with real styling, copy `public/` to a
> scratch dir, `curl` the Tailwind CDN script and the fonts CSS into it, and repoint
> `index.html` at the local copies. **Never commit that change** — the committed `index.html`
> must keep the CDN URLs.

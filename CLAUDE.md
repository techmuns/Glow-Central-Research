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
      format.js               number/date/currency/relative-time helpers
      dom.js                  $, $$, escapeHtml, el, empty
    ui/
      screener.js             THE SCREENER KIT — build tabs from this
      visual.js               avatars, tiers, status pills, signal dots, legend
      sources.js              data-source registry behind the header "Sources" modal
      export.js               generic exceljs-from-CDN "Export Excel" helper
      components.js           chrome primitives (tab bar, rail, toggle, search…)
      shell.js                header + rail + tabs + content host + tab registry
    concall/
      keyword-engine.js       runtime transcript scanner + the keyword store
      keyword-editor.js       the keyword set editor (modal)
      deep-dive.js            the six-tab Con-call Deep Dive workspace
    chatter/
      pump-risk.js            the 0-3 coordinated-posting heuristic + its reasons
    investors/
      deep-dive.js            the four-tab per-investor workspace
    data/
      technicals.js           loads + scores the live feed once, caches it
      earnings.js             same, for the earnings feed (+ legacy-summary adapter)
      concalls.js             same, for the transcript corpus (lazy — it is ~2MB)
      chatter.js              forum + telegram feeds, momentum and pump risk derived here
      investors.js            holders, overlap matrix, company interest, fund flows
      universe.js             screener-export -> legacy universe shape adapter
    scoring/
      tech-scoring.js         16-rule / 24-point technicals model (ported verbatim)
      earnings-scoring.js     15-rule / 21-point result quality + growth model
      rule-meta.js            per-rule provenance, keyed META[tabId][ruleKey]
    tabs/                     earnings-hub, earnings-scans, earnings-drill, concall,
                              public-chatter, breakouts, breakouts-drill, super-investors
    portfolio/                overview, position-by, transactions, drawdown
  data/                       technicals.json, atr-history.json, universe.json,
                              portfolio.json, mock/*.json
scripts/
  scrape-technicals.mjs       the live pipeline (Yahoo EOD + NSE delivery %)
  gen-mock-earnings.mjs       seeded generator for the synthetic earnings set
  gen-mock-concalls.mjs       seeded generator for the synthetic transcript corpus
  gen-mock-chatter.mjs        seeded generator for the forum + telegram feeds
  gen-mock-investors.mjs      seeded generator for holdings + fund flows
  verify-ui.mjs               the pre-push checklist, driven with Playwright
  lib/                        indicators.mjs, liquidity-estimators.mjs
.github/workflows/technicals-refresh.yml   weekdays 07:00 IST
worker/index.js               asset serving + POST /api/live-prices
wrangler.jsonc
docs/SPEC.md                  product spec + 7-prompt roadmap
docs/DATA-CONTRACTS.md        every JSON file's shape, units, source, cadence
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
- The left rail collapses to a dropdown under 1024px (Tailwind `lg:`).
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
| `statStrip(cards)` | the 4-up KPI row. Card 4 **must** be `{ hero: true, … }` — the gradient freshness card. Any card may carry `help: { title, body }` for a `?` explainer modal. |
| `topCards({ title, items, valueFormat, onSelect })` | the Top-10 hero grid. `valueFormat: 'score'` renders `value/max` coloured by tier; `'metric'` renders one formatted number coloured by `tone`. |
| `scoreTable(config)` | the workhorse: search, filter select, watchlist, sort, export, sticky head, row click. |
| `openDrill(config)` | right-slide detail panel (singleton), 480px. For one row's detail. |
| `openWorkspace(config)` | full-screen overlay (singleton), `max-w-[1200px]`, with its own tab strip. For analysis that needs room — see below. |
| `openModal(html, { size })` | centred modal (singleton). `size`: `default` \| `wide` \| `magazine`. |
| `sectionHead`, `roadmapStrip`, `pendingPanel` | title block, the dashed roadmap card, and the honest "no data yet" panel. |

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

### The keyword engine — `js/concall/keyword-engine.js`

A general text scanner, not a Con-call-only helper. Anything with a text corpus and a
user-editable term list should use it rather than growing a second one.

```js
const scan = engine.scanCall(call, engine.getKeywords());
scan.byKeyword['capex'].hits        // 7
scan.byKeyword['capex'].prepared    // 4 — management volunteered it
scan.byKeyword['capex'].qna         // 3 — analysts asked
scan.byKeyword['capex'].contexts    // [{ speaker, section, sentence, matchedTerm }]
engine.compareScans(latest, previous)  // deltas, plus introduced[] / dropped[]
engine.highlight(text, keywords, escapeHtml)   // trusted markup
```

The non-negotiables:

1. **Never store a count in a file.** Counts are computed at render time. That is the whole
   reason editing a keyword updates the screen instantly, and it is why `concall-keywords.json`
   ships terms and no `hits` field. A precomputed count would go stale the moment a user edits
   an alias, and nothing would tell them.
2. **Matching is word-boundary anchored and case-insensitive**, multi-word terms tolerate any
   whitespace run, and **overlapping aliases count once** — longest alias wins. Without that
   last rule, adding a broad alias silently inflates every count the narrow one already caught.
3. **Keep `prepared` and `qna` separate all the way to the UI.** They mean opposite things:
   management volunteering a topic versus an analyst having to extract it. Summing them away
   throws out the most interesting thing in the data.
4. **Missing input is not zero.** A call with no transcript returns `hasTranscript: false`, and
   the UI must render "not held yet" rather than a row of zeroes — "management mentioned this
   0 times" and "nobody has spoken yet" are different claims. Same for `compareScans` with no
   previous call: every delta is `null`, never the latest count.
5. **Scans are memoised on `(callId, keywordsHash)`**, where the hash covers only `id` +
   `terms`. A colour or label edit must not bust a cache it cannot affect. The cache clears on
   every keyword change.
6. **Keyword colours are categorical only** — `indigo`, `violet`, `purple`, `fuchsia`, `pink`,
   `sky`, `cyan`, `blue`, `teal`, `slate`. Emerald, amber and rose are semantic here, so a
   keyword may never take one: a keyword tinted emerald reads as a verdict.

Edits persist to `localStorage` under `sattva:concall-keywords` and broadcast through
`onKeywordsChange()`. Subscribe once in the tab's `render()` and repaint from there — that one
wire is what makes the editor feel instant instead of "save and reload". The write-back path for
moving the set to a server store is in `docs/DATA-CONTRACTS.md`.

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
- **`live.mockFetcher(path)` re-downloads `path` on every tick and jitters its numbers.** That is
  fine for a small file whose numbers are meant to breathe. It is wrong for a large one, and
  wrong for anything containing quoted speech — jittering a transcript invents words nobody
  said. The Con-call poller passes a plain function that computes a small delta from the
  already-loaded corpus instead; see `liveTickFetcher` in `js/data/concalls.js`.

---

## Where to look for what

| I need to… | Go to |
| --- | --- |
| Build a tab panel | `js/ui/screener.js` — assemble, don't hand-roll |
| Add or change a scoring model | `js/scoring/` + `js/data/` — see the pattern above |
| Change the technicals pipeline | `scripts/scrape-technicals.mjs` (`TECH_LIMIT=15` for a smoke run) |
| Regenerate the mock earnings set | `node scripts/gen-mock-earnings.mjs` — seeded, so output is stable |
| Wire the real earnings feed | `docs/DATA-CONTRACTS.md` → "Wiring the real feed" (3 files) |
| Add or change a result scan | `js/tabs/earnings-scans.js` — the definition string and the predicate live in the same object |
| Regenerate the mock con-calls | `node scripts/gen-mock-concalls.mjs` — seeded, so output is stable |
| Regenerate the mock chatter / investors | `node scripts/gen-mock-chatter.mjs`, `node scripts/gen-mock-investors.mjs` |
| Change the pump-risk thresholds | `js/chatter/pump-risk.js` — named constants, and the help modal quotes them |
| Change keyword matching | `js/concall/keyword-engine.js` — see the rules above before touching it |
| Add a view to the Deep Dive | `js/concall/deep-dive.js`: add to `TABS`, `TAB_LABEL`, `RENDERERS`, and `WIRERS` if it needs listeners |
| Build a full-screen analysis view | `openWorkspace` in `js/ui/screener.js` — don't grow the drill panel |
| Run the pre-push checks | `node scripts/verify-ui.mjs` (serve `public/` on :8080 first) |
| Add a server route | the API block in `worker/index.js` |
| Add/change a tab or sub-view | the module in `js/tabs/` or `js/portfolio/`, then `WORKSPACES` in `js/ui/shell.js` |
| Change avatar / tier / status-pill styling | `js/ui/visual.js` |
| Change the header, rail or tab bar | `js/ui/shell.js` |
| Add a row to the Sources modal | `js/ui/sources.js` (and `docs/DATA-CONTRACTS.md`) |
| Add a reusable chrome widget | `js/ui/components.js` |
| Change routing or URL shape | `js/core/router.js` |
| Add persisted state | `js/core/state.js` |
| Add a polled/live data source | `js/core/live.js` + `live.register` in the owning tab |
| Add a new JSON file | drop it in `public/data/`, add to `DATA_SOURCES` in `js/app.js`, document it in `docs/DATA-CONTRACTS.md` |
| Add a server route | the marked `/api/*` block in `worker/index.js` |
| Understand a JSON shape / unit / source | `docs/DATA-CONTRACTS.md` |
| Understand the roadmap | `docs/SPEC.md` §8 |

---

## Verification checklist before pushing

```bash
python3 -m http.server 8080 -d public
```

Then confirm with Playwright (Chromium is preinstalled — never run `playwright install`):

- shell renders with **zero console errors**
- all 9 tabs across both workspaces render their panel
- every tab shows a 4-card statStrip whose 4th card is the gradient freshness hero
- rail sub-views switch content
- the Portfolio/Universe toggle changes what every tab reports
- the URL hash updates; browser back/forward work
- a reload restores the same route and scope
- the top-tab underline scales in on the active tab only
- top cards and table rows both open the drill panel; ESC and the backdrop close it
- scoreTable search, header sort, filter select and watchlist toggle all work, and the
  watchlist survives a reload
- the Sources modal opens and lists every documented source
- layout holds at 1440px, 1024px and 390px with no sideways page scroll

> Sandbox note: the agent proxy only accepts CONNECT, so headless Chromium cannot reach
> `cdn.tailwindcss.com` or Google Fonts. To screenshot with real styling, copy `public/` to a
> scratch dir, `curl` the Tailwind CDN script and the fonts CSS into it, and repoint
> `index.html` at the local copies. **Never commit that change** — the committed `index.html`
> must keep the CDN URLs.

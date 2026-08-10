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
  index.html                  design tokens, fonts, Tailwind CDN, #app mount
  js/
    app.js                    bootstrap: load all JSON, then mount the shell
    core/
      state.js                global state + localStorage + pub/sub
      router.js               hash routing (#/ws/tab/subview?scope=)
      live.js                 live-update polling engine
      format.js               number/date/currency/relative-time helpers
      dom.js                  $, $$, escapeHtml, el, empty
    ui/
      components.js           shared UI primitives
      shell.js                header + rail + tabs + content host + tab registry
    tabs/                     earnings-hub, concall, public-chatter, breakouts, super-investors
    portfolio/                overview, position-by, transactions, drawdown
  data/                       portfolio.json, universe.json, mock/*.json
worker/index.js               asset serving + a marked slot for /api/* routes
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

| Token | Value | Meaning |
| --- | --- | --- |
| `--brand-600` | `#0d9488` | teal, primary |
| `--brand-700` | `#059669` | emerald, gradient end |
| `--accent-600` | `#7c3aed` | violet, secondary |
| `--positive` | `#059669` | gains / beats / inflows |
| `--caution` | `#d97706` | pending / moderate |
| `--negative` | `#e11d48` | losses / misses / outflows |
| `--neutral` | `#64748b` | slate |
| `--page-bg` | `#f8fafc` | page background |

Conventions:
- Surfaces are white, `rounded-2xl`, `shadow-sm`, `ring-1 ring-slate-100`.
- Page background carries three sub-12%-opacity radial gradients (teal TL, violet TR, sky BR).
- `font-variant-numeric: tabular-nums` on every number-bearing cell.
- Tables scroll horizontally **inside their own container**; the page body must never scroll
  sideways. `body { overflow-x: hidden }` is a backstop, not the mechanism.
- The left rail collapses to a dropdown under 1024px (Tailwind `lg:`).

---

## UI primitives — `js/ui/components.js`

`statCard`, `sectionHeader`, `scopeSummary`, `tabBar`, `railNav`, `segmentedToggle`,
`dataTable`, `pill`, `badge`, `scorePill`, `filterChips`, `searchInput`, `toolbar`,
`drillPanel`, `modal`, `emptyState`, `skeleton`, `liveBadge`, `spark`, `tooltip`,
`comingSoonStrip`.

Each returns either an HTML string or `{ html, wire(root) }`. Pattern:

```js
const table = dataTable({ columns, rows, initialSort: { key: 'marketValue', dir: 'desc' } });
mount.innerHTML = table.html;
table.wire(mount);
```

`wire()` returns a disposer when it registers anything global (document listeners, intervals,
resize handlers). Call it in `destroy()`.

**Always escape data-sourced strings** with `escapeHtml` from `core/dom.js` before putting them
in an innerHTML template. The `dataTable` `render` callbacks are raw HTML — escape inside them.

---

## Live engine — `js/core/live.js`

```js
live.register('concall-feed', { intervalMs: 12000, fetcher: live.mockFetcher('data/mock/concall-feed.json') });
const off = live.subscribe('concall-feed', (rows) => paint(rows));
live.start('concall-feed');   // in render()
live.stop('concall-feed');    // in destroy(), and call off()
```

- Pollers run only while started **and** the document is visible; they pause on hidden and
  refetch immediately on return.
- Exponential backoff on error, capped at 60s. Errors never reach the UI.
- Swap mock → real by changing one argument: `live.realFetcher('/api/technicals')`.

---

## Where to look for what

| I need to… | Go to |
| --- | --- |
| Add/change a tab or sub-view | the module in `js/tabs/` or `js/portfolio/`, then `WORKSPACES` in `js/ui/shell.js` |
| Change the header, rail or tab bar | `js/ui/shell.js` |
| Add a reusable widget | `js/ui/components.js` |
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
- rail sub-views switch content
- the Portfolio/Universe toggle changes what every tab reports
- the URL hash updates; browser back/forward work
- a reload restores the same route and scope
- layout holds at 1440px, 1024px and 390px with no sideways page scroll

> Sandbox note: the agent proxy only accepts CONNECT, so headless Chromium cannot reach
> `cdn.tailwindcss.com` or Google Fonts. To screenshot with real styling, copy `public/` to a
> scratch dir, `curl` the Tailwind CDN script and the fonts CSS into it, and repoint
> `index.html` at the local copies. **Never commit that change** — the committed `index.html`
> must keep the CDN URLs.

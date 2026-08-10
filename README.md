# Sattva Central Research

An Indian-equities research and portfolio analytics dashboard. Two workspaces —
**Research Central** (earnings, con-calls, public chatter, technical breakouts, superstar
investors) and **Portfolio Analytics** (positions, allocation, transactions, drawdown) — with a
global Portfolio ⇄ Universe scope toggle that applies to every tab.

Static site, no build step, no bundler, no framework, no npm dependencies for the app itself.
Vanilla ES modules and Tailwind from a CDN. Hosted as a Cloudflare Worker.

![Earnings Hub](docs/screenshots/earnings-hub.png)

---

## Status

**Prompts 1–5 of 7 complete.** The shell, the screener kit, the live technicals pipeline, the
Earnings Hub and the Con-call tab are in. The remaining tabs land one prompt at a time — see the
roadmap in [`docs/SPEC.md`](docs/SPEC.md#8-roadmap).

**Breakouts / Technical is live.** 535 NSE-500 companies scored against a 16-rule, 24-point
model, from a daily Yahoo Finance EOD scrape plus NSE bhavcopy delivery data, refreshed weekdays
at 07:00 IST by [a GitHub Action](.github/workflows/technicals-refresh.yml). Everything else
still runs on the placeholder data in `public/data/mock/`, and the UI labels which is which —
the Sources modal in the header lists every feed with an honest live / real / mock / pending
status.

**Two full scoring/analysis systems sit on mock-but-real-shaped data.** The Earnings Hub scores
every result against a 15-rule, 21-point quality-and-growth model; the Con-call tab scans real
transcript text for user-editable keywords, at runtime, in the browser. Both are wired exactly as
they will be when the feeds land — swapping the JSON is the only change needed.

---

## Run it locally

No install step. Serve `public/` over HTTP with anything:

```bash
python3 -m http.server 8080 -d public
# then open http://localhost:8080
```

Opening `public/index.html` directly from the filesystem will **not** work — `fetch()` of the
JSON data files is blocked on `file://`. The app detects this and says so.

Optionally, run it through the real Worker runtime:

```bash
npx wrangler dev
```

---

## Deploy

Cloudflare Workers, with the static site served through the `ASSETS` binding:

```bash
npx wrangler deploy
```

Config lives in [`wrangler.jsonc`](wrangler.jsonc); the Worker itself is
[`worker/index.js`](worker/index.js), which serves assets for everything and has a clearly
marked slot for future `/api/*` routes.

---

## Layout

```
public/
  index.html          design tokens, fonts, Tailwind CDN
  js/
    app.js            bootstrap: load JSON, mount the shell
    core/             state, router, live engine, format, dom helpers
    ui/               components.js (primitives), shell.js (chrome + tab registry)
    concall/          keyword-engine.js (runtime scanner), keyword-editor, deep-dive
    data/             per-feed loaders: technicals, earnings, concalls, universe
    scoring/          tech-scoring (24 pt), earnings-scoring (21 pt), rule-meta
    tabs/             earnings-hub, concall, public-chatter, breakouts, super-investors
    portfolio/        overview, position-by, transactions, drawdown
  data/               portfolio.json, universe.json, technicals.json, mock/*.json
worker/index.js       asset serving + /api/* slot
docs/SPEC.md          product spec, nav model, per-tab features, 7-prompt roadmap
docs/DATA-CONTRACTS.md  every JSON file: shape, types, units, cadence, real source
CLAUDE.md             working rules, module contract, design tokens, where-to-look index
```

---

## Docs

- **[`docs/SPEC.md`](docs/SPEC.md)** — the product spec: navigation model, scope toggle, every
  tab and sub-view with its planned features, and the 7-prompt roadmap.
- **[`docs/DATA-CONTRACTS.md`](docs/DATA-CONTRACTS.md)** — every data file's exact JSON shape,
  field types, units, refresh cadence and intended real source. Read this before wiring live data.
- **[`CLAUDE.md`](CLAUDE.md)** — stack rules, file layout, the module interface contract, design
  tokens, and the verification checklist.

## Refresh the technicals feed by hand

```bash
node scripts/scrape-technicals.mjs            # full run, ~10 min for 535 companies
TECH_LIMIT=15 node scripts/scrape-technicals.mjs   # smoke run -> technicals.smoke.json
```

A capped run writes to a sibling file and skips the ATR accumulator, so it can never truncate
the committed feed or poison the volatility-trend history.

## Regenerate the mock earnings set

```bash
node scripts/gen-mock-earnings.mjs
```

Seeded, so the output is byte-stable — a diff means a real change. Writes
`public/data/mock/earnings.json` and `public/data/mock/earnings-calendar.json`. Company names,
tickers, sectors and market caps come from `universe.json` and are real; **every financial figure
is synthetic**, and the dashboard says so on every surface that shows one. Swapping in the real
filings feed is a three-file change — see *Wiring the real feed* in
[`docs/DATA-CONTRACTS.md`](docs/DATA-CONTRACTS.md).

## Regenerate the mock con-calls

```bash
node scripts/gen-mock-concalls.mjs
```

Seeded, so the output is byte-stable. Writes `public/data/mock/concall-calls.json` (60 companies
× 2 calls, ~9,000 transcript segments), `concall-keywords.json` and `catalysts.json`.

Company names, tickers and sectors are real. **Every transcript line is synthetic, and every
person and brokerage firm named in these calls is fictional** — inventing a number for a real
company is one thing, putting invented words in a real person's mouth is another. The dashboard
says so on every surface that shows the data.

The keyword counts, though, are **not** mock: `public/js/concall/keyword-engine.js` scans that
text in the browser on every render, so editing a keyword's aliases genuinely changes what
matches. No count is stored in any file.

## Verify before pushing

```bash
python3 -m http.server 8080 -d public &
node scripts/verify-ui.mjs
```

Drives the site with Playwright and walks CLAUDE.md's checklist — every route in both scopes,
routing and history, table search/sort/filters, the drill panel, the provenance markers, the
Excel export and the responsive breakpoints. Exits non-zero if anything fails, so it can gate a
push. It uses a system Playwright install (`PLAYWRIGHT_ROOT` / `CHROME_PATH` to point it
elsewhere) rather than adding an npm dependency.

## Screenshots

| Technical Scanner | Rule breakdown |
| --- | --- |
| ![Technical Scanner](docs/screenshots/tech-scanner.png) | ![Drill panel](docs/screenshots/tech-drill.png) |

| Strong Breakouts | FII Accumulation |
| --- | --- |
| ![Strong Breakouts](docs/screenshots/strong-breakouts.png) | ![FII Accumulation](docs/screenshots/fii-accumulation.png) |

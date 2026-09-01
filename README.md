# Sattva Central Research

An Indian-equities research and portfolio analytics dashboard. Two workspaces —
**Research Central** (Ask Research, daily alerts, earnings, con-calls, public chatter, technical breakouts,
superstar investors, news, announcements, insider trades) and **Portfolio Analytics** (positions,
allocation, transactions, drawdown) — with a global **Portfolio · Watchlist · Universe** scope
toggle that applies to every tab.

**Ask Research** is the landing tab: a conversational workspace that assembles a bounded evidence
packet from every dashboard data module, reports source coverage and provenance, and keeps its
conversation library on the reader's device. Its optional **Web research** mode sends the same
dashboard packet to the server-side assistant and requires hosted web search, so current external
context and dashboard facts are combined in one answer without exposing the provider key.

**Daily Alerts** is one newest-first, internally scrollable timeline consolidated
from four of the tabs — Breakouts / Technical, News, Corp Announcements and Insider Trades — red
for a price fall past 5% and orange for everything else. It reuses each feed's retained history,
shows every row's Indian date and available clock time, and offers All / today / 7-day / 30-day
filters. It adds no data source of its own and separately says whether each feed has actually looked
at today, because historical rows do not prove that today's scrape ran.

Static site, no build step, no bundler, no framework, no npm dependencies for the app itself.
Vanilla ES modules and Tailwind from a CDN. Hosted as a Cloudflare Worker.

![Earnings Hub](docs/screenshots/earnings-hub.png)

---

## Status

**All fourteen tabs across both workspaces are built.** See
[`docs/HANDOFF.md`](docs/HANDOFF.md) for the full live-vs-mock inventory, the architecture map,
deploy notes and the known gaps.

**Public Chatter is live too**, off the SentimentDash API — mention counts and sentiment across ValuePickr, TradingQnA and Google News. The synthetic forum/Telegram corpus that used to fill it is deleted rather than relabelled.

**Two more surfaces are genuinely live.**

*Breakouts / Technical* scores 535 NSE-500 companies against a 16-rule, 24-point model from a
daily Yahoo Finance EOD scrape plus NSE delivery data, refreshed weekdays at 07:00 IST by
[a GitHub Action](.github/workflows/technicals-refresh.yml).

*Portfolio Analytics* marks every position to market from that same feed, and builds its equity
curve and drawdown from **735 trading days of real closing prices** — because a max drawdown from
an invented price series looks exactly like a measured one and nobody could check it. The trade
ledger behind it is synthetic, but every execution price in it is a real close on a real trading
day, so the curve never steps at a trade. The split ribbon on that workspace states both halves.

**Two full scoring/analysis systems sit on mock-but-real-shaped data.** The Earnings Hub scores
every result against a 15-rule, 21-point quality-and-growth model; the Con-call tab scans real
transcript text for user-editable keywords, at runtime, in the browser. Both are wired exactly as
they will be when the feeds land — swapping the JSON is the only change needed.

The Sources modal in the header lists every feed with an honest live / real / mock / pending
status. What each tab does *not* do is recorded in `docs/SPEC.md` under its "Still to come" —
a dashed **Wiring roadmap** card used to carry that under every table, and it was chrome competing
with the content it sat beneath.

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

Ask Research is intentionally disabled until the server-side secret is present. For local Worker
development, put `OPENAI_API_KEY=…` in the gitignored `.dev.vars`; for a deployed Worker, configure
it with `npx wrangler secret put OPENAI_API_KEY`. The model name is the non-secret
`OPENAI_MODEL` variable in `wrangler.jsonc`. Do not put the key in `public/` or browser storage.
Conversation history is stored locally, while each submitted question and its bounded dashboard
evidence packet are sent to OpenAI with response storage disabled.

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
                      watchlist.js — the companies the reader stars, and the Watchlist scope
    ui/               components.js (primitives), shell.js (chrome + tab registry)
    concall/          keyword-engine.js (runtime scanner), keyword-editor, deep-dive
    data/             per-feed loaders: technicals, earnings, concalls, chatter, universe
                      coverage.js — the 142-company book the Portfolio scope filters by
                      scope.js — the three scopes; every forScope() is built on it
                      daily-alerts.js — retained chronological readings across four tabs
                      sentiment-shared.js — slug→NSE resolver, shared with the Worker
    scoring/          tech-scoring (24 pt), earnings-scoring (21 pt), rule-meta
    research/         bounded cross-dashboard evidence catalog + safe answer renderer
    tabs/             ask-research, daily-alerts, earnings-hub, concall, public-chatter, breakouts,
                      super-investors, news, corp-announcements, insider-trades
    portfolio/        overview, position-by, transactions, drawdown
  data/               portfolio-companies.json (the book), portfolio.json (the ledger),
                      universe.json, technicals.json, mock/*.json
worker/index.js       asset serving + live read-through APIs + the Ask Research stream
worker/research.mjs   server-only OpenAI Responses bridge, web search and request limits
docs/SPEC.md          product spec, nav model, per-tab features, roadmap
docs/HANDOFF.md       live-vs-mock inventory, architecture, FIFO rules, deploy, known gaps
docs/DATA-CONTRACTS.md  every JSON file: shape, types, units, cadence, real source
CLAUDE.md             working rules, module contract, design tokens, where-to-look index
```

---

## Docs

- **[`docs/SPEC.md`](docs/SPEC.md)** — the product spec: navigation model, scope toggle, every
  tab and sub-view with its features, and the build roadmap.
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

## Regenerate the mock investor set

```bash
node scripts/import-amc-portfolio.mjs # Bandhan Focused + Small Cap monthly portfolios, from scripts/fixtures/
```

Seeded, so output is byte-stable.

- **Investor names are real; their positions are not.** Ashish Kacholia, Dolly Khanna, Small Cap
  World Fund and the rest are real, and their genuine holdings are public. Everything shown here
  is synthetic, labelled on every surface — and the data set carries **numbers only**, with no
  `rationale`, `quote` or `thesis` field, deliberately, so there is nothing to render that would
  read as something a named person said.

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

| Portfolio Overview — live marks, FIFO basis, reconciliation strip | Drawdown — 735 real trading days |
| --- | --- |
| ![Portfolio Overview](docs/screenshots/portfolio-overview.png) | ![Drawdown](docs/screenshots/portfolio-drawdown.png) |

| The FIFO working behind a sell | Grouped by lot, not by position |
| --- | --- |
| ![FIFO drill](docs/screenshots/portfolio-fifo-drill.png) | ![Position By](docs/screenshots/portfolio-position-by.png) |

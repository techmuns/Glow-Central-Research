# Worklog — Research Central overhaul + family-office fixes (20 Nov 2026)

This is the living handoff/worklog for the work briefed on the **client call** and the
**founder discussion** of 20 Nov 2026, plus the **Framework.xlsx** and the **Groww** UI reference.
Keep updating this file as work proceeds so nothing is lost across the session.

## Who's who
- **Jaisinghani family** — the family office (owners: Ajay Jaisinghani, Bharat Jaisinghani (PolyCab), etc.).
- **Ankita** — family principal; wants the family-office PDF report (summary view, charts), reviews over weekend.
- **Yamini** — family-side product stakeholder; uses the dashboard most; requested AI Recommendations, "5-min stock idea", raised the blank-XIRR complaint.
- **Prateek** — client side; sent the Framework.xlsx + email (merge framework into AI Insights 5-min read).
- **Chiraag / "founder"** — Munshot founder (the person I'm taking instructions from); drives the overhaul.
- **Vipul (a.k.a. Whipple/Vipple)** — Munshot dev; owns auto-forward setup + build items.
- **Naval, Gaurav** — Munshot team (parser, family-office data).

## The three repos
1. **techmuns/Glow-Central-Research** (THIS repo) — the research dashboard. Most of the work lands here.
   - Live: https://glow-central-research.tech-441.workers.dev  (Cloudflare Worker; auto-deploys on push to main via Cloudflare Git integration).
2. **techmuns/GlowVentures** — the family-office wealth dashboard (Vite/TS/React). PRODUCES the family's portfolio/book that Glow-Central-Research consumes. Family-office fixes land here. Cloned at /home/user/techmuns/glowventures (read-only for now).
3. **ceekay-munshot/klpdash** — the **LKP stock screener** (Cloudflare Worker + static). Its screening engine (Screener.in + Yahoo technicals, all free) is to be **cloned and merged** into Glow-Central-Research. Cloned at /home/user/ceekay-munshot/klpdash (read-only for now).

## Founder's stated priorities
- **Priority 1 — family-office data (PART B): OWNED BY ANOTHER SESSION (20 Nov).** Load pending statements (Motilal etc.) + reconcile so blank columns fill for Ankita. **I do NOT work this now** — sync at the very end, finish leftovers only.
- **MY FOCUS = Priority 2:** the AI screening system (funnel + merged framework) in Glow-Central-Research (PART A).
- Standing instruction: **maintain a strict, complete to-do; do not miss anything** (he was annoyed a "reverse DCF" item was missed earlier). This worklog IS that to-do.

## Delivery process — BEFORE/AFTER screenshots (standing rule, 20 Nov)
**For EVERY feature / PR / merge**, capture a clear, real-frontend **BEFORE** screenshot and a matching
**AFTER** screenshot (same page + state), so a **delivery PDF** of all the feedback items can be compiled
at the very end. Rules:
- Real rendered frontend (Playwright against the live site or a local `python3 -m http.server -d public`),
  full and legible — never a code diff or a mock.
- Capture BEFORE right before implementing each item; capture AFTER once it's on the branch/preview.
- Send each pair to the user as it's made (kept in the chat) AND log it in the table below.
- At the very end, assemble all pairs into one before/after delivery PDF.
- **Tell the user WHERE on the dashboard** each change lives (which tab + section) so they can cross-verify.
- **Delivery loop per feature:** build on branch → BEFORE shot + say where it is → open PR (before/after in body) → Verify CI green → merge to main → Cloudflare auto-deploys main → **CHECK THE LIVE URL** (glow-central-research.tech-441.workers.dev) that it actually updated → send a from-live AFTER shot. Run the local Verify suite + zero-console-errors BEFORE pushing, so a broken build never reaches the live family-office site.

### Before/After screenshot log
| # | Feature (checklist id) | Before shot | After shot | PR | Status |
|---|---|---|---|---|---|
| — | (none yet — no code changed) | — | — | — | — |

---

# PART A — Glow Central Research (the research dashboard)

## A1. Clean up Research Central navigation (founder)
- Most tabs are unread noise: Announcements, Earnings, Screens, Mutual Funds, News, Super Investors, Capital Raise, Mergers, Private Market, etc. **Nobody reads them.**
- Move all of them into a **"More / Add tab" popup**: clicking it opens a picker to choose which tabs to show. (An Add-tab/"Build a Tab" system already exists — `js/ui/saved-tabs.js`, `tab-order.js`, `core/workspace.js`. Reuse/extend it so the DEFAULT view is minimal.)
- **Keep visible by default only: Watchlist, Portfolio, and Alerts.**
- Keep the hidden tabs **running/processing in the background** (collection unchanged) — just not shown unless the user adds them.
- Overall goal: "remove all the garbage, consolidate to a single page with tables. A lot of it is noise."

## A2. Alerts group cleanup (founder)
- **AI Alerts:** remove the "Compact" layout clutter that got added ("what garbage got added — remove it"). Keep AI Alerts clean. (Re-confirm exactly what to strip — likely the Compact view's extra chrome, or revert to the simpler card list.)
- **Keep All Alerts.**
- **Merge AI Insights + AI Recommendations into ONE thing** (one table). Running the "5-min stock idea / report" on any recommendation runs it. "These two need to be merged into one — a table."
- **Remove "Themes · who benefits"** from AI Insights (Yamini mentioned it, founder says it's noise / not needed now).
- **AI Recommendations: deprioritize** ("can stay behind for now; comes later").

## A3. AI Insights — the "5-minute stock read" overhaul (client, detailed)
The AI Insights one-pager (run per company, "Run company") is the core deliverable. Changes:

- **Universe / market-cap filter:** today it's ~NSE 500. Client wants a market-cap filter, default **₹1,000 cr and above** (working universe ₹1,000–25,000 cr). Add a selectable market-cap filter.
- **Remove ALL technical analysis from "What we like / what we don't like."** Put technicals in a **separate section** ("how the stock looks technically").
- **"What the street says" → a TABLE**, one row per broker, columns: *date initiated / date of report / last update · recommendation (Buy/Sell/Hold) · target price · + a valuation-style set (revenue growth, EPS, etc.)* — like a broker valuation table. Let the user **pick/choose which broker report** to view. (Feeds from the broker-reports pipeline, see A5.)
- **Business-quality score drill-down:** the 80/100 score must show **how it's calculated** — the 4–5 parameters, their weightages, and be **tweakable** (edit weightages). Client will give inputs. Goal over ~3 months: a transparent, agreed scoring algorithm.
- **The decision MATRIX / quadrant (the "first section" — decide in 30 seconds whether to dig deeper):** three axes —
  1. **Business quality** — good / average / bad (0–100 score). Split stocks into 3 buckets: (a) good quality + growth runway, (b) average quality but has growth, (c) bad quality + no growth.
  2. **Earnings predictability / conviction** — high / medium / low (AI's confidence in predicting guidance for FY28/FY29).
  3. **Valuation** — overvalued / fairly valued / undervalued.
  - Rule: **2 of 3 green → Watchlist**; **poor quality → drop entirely (not even watchlist)**; medium quality + med-high predictability + reasonable valuation → can look at it.
- **Business-quality table:** parameters on the left, a 1–2 line **AI summary** per parameter on the right (e.g. "moat / right to win"), and a **score column (0–2:** 2=high, 1=medium, 0=none). ~5 parameters; overall on a 0–10 scale.
- **Valuation per sector:** different methods per sector (Bank → P/B; AMC → P/E; etc.). Use the Framework.xlsx KPI→signal map. Some **common metrics across sectors** (P/E, EV/EBITDA, order book, P/E vs historical median/peers) always shown. Merge client's framework with existing.
- **KPI tracking + trends:** per company, list the KPIs that matter (e.g. Bharti: subscribers, ARPU, data usage, minutes of usage), read from filings. Build a **KPI table with multi-quarter trend (QoQ / YoY)** and an **icon to open a longer-term trend chart**. Show **estimate vs guidance vs actual**.
- **Forecasting / street estimates:** forecast next ~2 quarters; show the **popular street estimate** and **earnings-estimate upside** (from broker reports). (Average is "misleading" — show range, not just average.)
- **Entry / buy-price calc** (goes in the report's first half; all AI-calculated, with a manual-check rationale):
  - Projected EPS (AI compounds EPS over ~3–4 yrs) × an **AI-assigned exit multiple** (e.g. 25× — AI justifies why vs the current 20×, from quality/growth/differentiation) = **exit price**.
  - Apply a required **IRR (~20%, higher for ancillaries ~25–30%)** → back-calculate **required entry/buy price** at today's date.
  - Compare vs **CMP** (above/below entry price). Show the rationale for the multiple.
- **Corporate announcements feed the score:** any material corporate announcement (new MD with strong track record, new drug, capex, order) should **flow into business-quality / differentiation scoring**. For companies with new announcements, **re-run scoring on an ongoing basis**; if the score changes, move to Watchlist.
- **Prateek's email specifics (A4 overlaps):** below each company name add a **"Run 5 mins page report" icon**; add the framework's ~338 companies to the AI Insights list; show the output in the Framework "Table" format.

## A4. Merge the qualitative Framework.xlsx into AI Insights (Prateek email + both calls)
- **Framework.xlsx → "Sheet"**: scoring rules, 0–2 each:
  - **Business quality / Economics** (0 weak … 2 attractive economics / critical product / defensible)
  - **Differentiation** (0 commodity … 2 niche / switching costs / qualification barriers)
  - **Growth runway** (0 none … 2 credible multi-year structural growth / share gains)
  - **Catalyst / inflection** ("Growth engine") (0 none … 2 evidence-based catalyst: capacity / new products / customers / margin recovery)
  - **Earnings materiality** ("Recent evidence") (0 won't matter … 2 can change rev/EPS/ROE/ROA in 3–5 yrs; needs concrete proof points)
  - **Governance** — Pass/Fail gate (not scored).
- **Framework.xlsx → "Table"** (the required output format): `Number · Company · Industry · Summary (what it does) · CMP · Market cap · Total/12 · Rank · Gov. gate (Pass/Fail) · Economics (Score+Rationale) · Differentiation (Score+Rationale) · Growth runway (Score+Rationale) · Growth engine (Score+Rationale) · Recent evidence (Score+Rationale)`.
  - NOTE: header says **Total /12** but only 5 scored criteria (×2 = /10) appear — **confirm with Prateek** whether Governance is scored (→ /12) or it's /10.
- Merge this qualitative framework + scoring with the **existing Munshot** scoring (don't replace — combine), and include it in each company's 5-min note.
- The **~338 companies (rows 9–346)** in the "Sheet" (International Gemological, Tips Music, Waaree Renewable, Wework India, Esab India, … through Keto Motors, Guj Inds. Power) are to be **added to the AI Insights list** and run. (NOT ~113 — the list is large; adding + running the qualitative framework on all is a sizable token/compute job → batch + measure cost, per A5.)
- Data source for the quantitative inputs: **Screener.in** (trusted) + reading filings; keep Screener as the single source to avoid multi-source conflicts.

## A5. The AI SCREENING FUNNEL — the big new feature (client framework + founder's funnel UI)
A sophisticated, visual, interactive screening funnel on Glow Central Research. Follow the **Groww** filter UI style (left filter rail + results table) — but **no LKP-style colours**; must be **fast, smooth, very user-friendly**, numbers update live as you click.

- **Layout:** a **funnel view on one side** (total stocks → excluded → … → ~100), a **full table on the other**. Clicking a funnel stage shows exactly that stage's companies in the table. One single table (not multiple baskets like the old SPIP basket), all columns in it; rejected companies drop out of the table as filters apply.
- **Step 0 — Universe:** choose market cap (default ₹1,000–25,000 cr) → all stocks in range.
- **Step 1 — Sector exclusion:** tick-marks to **exclude** sectors/themes — commodity first, sectors the family avoids (hard-to-analyse: pharma, chemicals unless bandwidth), and **"negative impact of AI on business model."** The excluded set is a manual/curated list. Defines the investable universe.
- **Step 2 — Quantitative screening** (→ ~400): revenue growth, profit growth, ROCE, cash conversion, debt position. **Editable ranges/thresholds, not hard-coded** — number or between-two-numbers, greater-than/less-than like Screener; can be **per-sector**. Also capture **"companies at an inflection point"** (large capex cycle / new product launch) so they aren't wrongly eliminated — data from **Corporate Announcements categories** (capex/commissioning, order/contract, capacity, product launch & approvals, capital raise), over the **last ~6 months** (not just last 3 days). Our announcement engine can already segregate announcements into these categories.
- **Step 3 — Qualitative filter (AI-driven, token-heavy)** (→ ~100): the Framework's 6 criteria (A4) — business quality, differentiation, growth runway, catalyst/friction, steady-compounder, earnings materiality, plus governance flags (minority treatment, capital allocation, pledging, auditor remarks), each 0–2. Run via Claude / Moonshot.
- **Step 4 — Valuation filter** (→ ~30–40 active): fair value + entry price (A3 entry-price calc).
- **Bucketing** (shown in report, not a hard filter): structural compounders, business at inflection, turnaround / earnings recovery, special situations (demerger / holdco / cash cow), cyclical recovery (bottom-of-cycle — **method TBD: how to find bottom-of-cycle companies?**). Special situations come from announcement categories (governance/management/deals); demergers from the existing Mergers & Demergers tab (add a search there).
- **AND / OR filter toggle:** let the user choose AND vs OR across filters (ANDing everything leaves 1–2 companies; OR keeps a usable basket). Important.
- **Output:** ~100 = Watchlist, ~30 = active tracking.
- **Turnaround data** (recent losses, falling EPS, low ROCE, elevated debt): from PAT/EPS/ROCE already available.
- **Cost / cadence:** qualitative filter burns a lot of tokens. Plan: build it, run once, measure the token cost, then optimise for cost. Run per-company whenever a new corporate announcement arrives (ongoing), not the whole universe daily. (Moonshot/Claude token limit ~30–40% left till Sunday reset — OK to build/test.)
- **Groww reference URL:** https://groww.in/stocks/filter?closePriceHigh=100000&closePriceLow=0&marketCapHigh=3000000&marketCapLow=0&page=0&size=15&sortType=ASC

## A6. Merge the LKP screener (klpdash) into this dashboard (founder)
- The LKP screener (ceekay-munshot/klpdash) already computes the quantitative params off Screener + Yahoo. **Clone its engine and merge** the parts not already built here (the quantitative screening params, per-sector thresholds, any data it reads that we lack). "Bulletproof it."
- Also: build the **"Moonshot Stock Screener"** from LKP (a separate earlier ask the founder repeats).
- Our dashboard already has most data built-in (Screener fundamentals, Yahoo technicals, announcements). Bring only what's missing from LKP.
- See **"Repo study: LKP screener"** below for the full map. Net-new from LKP: the 19-rule fundamental scoring, the macro pillar, the liquidity math, and two qualitative LLM agents (auditor opinion + revenue-mix). Adapt its FIXED bands into the founder's EDITABLE ranges; re-point its Muns/Firecrawl feeds to our own.

## A7. Broker research reports pipeline (client)
- Set up **auto-forwarding** of research emails/Telegram to the research inbox (techmuns.io) or a shared folder, then surface them in a **"Broker research" tab** and in the "what the street says" table (A3).
- Telegram channels to join/ingest: **"Equity Research Reports by MWZ"** (~5,535 members), **"Money Purse / moneyp"** (~2.77 lakh — news). Access on personal numbers; **auto-forward to the research ID**. Vipul to set up auto-forward and identify the top sending domains.
- Existing infra: the dashboard already has broker-reports (`broker-reports.json`, Telegram ingestion). Extend to the client's channels + the AI Insights street-table.

---

# PART B — GlowVentures family-office dashboard (other repo)

> **OWNED BY ANOTHER SESSION (20 Nov 2026).** These family-office fixes are being done in a separate
> GlowVentures session. I do NOT work these now — I sync to that session at the very END and finish only
> whatever is left over. Kept here for completeness and the file map (see "Repo study: GlowVentures").

## B1. Load Motilal Oswal statements → fix blank XIRR / returns
- Yamini's complaint: XIRR/return columns blank. Cause: **Motilal Oswal statements not yet loaded**. Of ~49 holdings in that account, **46 figured out** via transaction statements (cross-verified); **43 have distinct units → adding now.**
- Action: finish loading Motilal statements into the portfolio library so the blank columns fill.

## B2. Fix duplicate / same-units double-count (6 holdings)
- 6 of the 49 holdings show the **SAME number of units** across two statements under two different people (e.g. Bharat/HDFC and Ajay/Motilal). Need to verify these are genuinely separate transactions (different buy dates/costs = separate) vs a true duplicate to avoid double-counting.
- Specifically check **3 stocks** (founder to send email screenshots): one is the **"361 fund"** (likely **360 ONE**) — check if 90 lakh units + same cost is a real duplicate → must NOT double-count.
- (The dashboard already has a `dedupeGroup` concept — "also reported under" — relevant here.)

## B3. Bulletproof the drag-and-drop document parser
- The drag-and-drop statement parser in Moonshot/GlowVentures "isn't built properly" — **a lot of document data is left unused** and doesn't sync everywhere.
- Action: use Claude to parse incoming documents; **test drag-and-drop on a few**; fix the parser so it fills correctly for ALL statement types. Make it robust/"bulletproof."

## B4. Private investments: PDF drill-down
- In the private-investments view, clicking a **number of shares / a row/number** should **open the source PDF** (the statement that number came from). Same for public holdings rows.
- Map **private-market transactions** to the transaction ledgers/demat statements (demat statements contain the private transactions).

## B5. Share-certificate ↔ transaction-statement reconciliation (flag gaps)
- Take the share-certificate Excel, **map it to the transaction statement**; where it reconciles, fine; **where there's a gap, flag it** and ask only for the gaps (don't request everything).
- Also review the **HDFC equity-trade report** (sent by Sushita) — has useful info.

## B6. Real-estate tab enrichment
- Enrich the real-estate tab UI with real-estate data (the family is starting real-estate investing: ~2 commercial properties generating rental income; most other real estate is owned, no rental). Fields: appreciation, rental income, transaction ledgers, residential vs commercial.
- Shiraag/Chiraag to add the real-estate document (Yamini reviews first). Template already exists ("based on how our family sees real estate").

## B7. Export report (12-page family-office PDF)
- The Monday-morning family-office review PDF (summary vs detailed; portfolio value, asset allocation, recorded gain, YTD return, benchmark vs Nifty 500 / Nifty Next, gain/loss by manager/asset class). Get **Ankita's remarks/edits** after she reviews.

## B8. Missing holdings reconciliation
- **Kiefer Science** and **Manorama** showing missing — statement reconciliation in progress; push once done.
- General data-accuracy target: ~96–97%; missing pieces are mainly PMS/AIF buy-price (use current NAV; pursue **view-only LOA access** to custodian/PMS to extract monthly statements, like the CAMS/KFintech setup).

---

## Open questions / to confirm
- A4: Framework "Total /12" vs 5 scored criteria (/10) — is Governance scored or a gate? Confirm with Prateek.
- A1/A2: exact "Compact" clutter to remove from AI Alerts — confirm with founder on screen.
- A5: method to detect "bottom-of-cycle / cyclical recovery" companies — TBD.
- A5/A6: which specific LKP params/data are missing here (pending klpdash study).
- A7: which email domains / exact Telegram channels to wire — Vipul to confirm.

## Constraints & rules (don't break)
- Honesty rules stand: no fabricated numbers; show stale/failed/partial; label derived figures ("guide, not target"); don't double-count holdings.
- Data: Screener.in is the trusted quantitative source; Yahoo for technicals; both free. No new paid data without sign-off.
- No LKP-style colours on the new screener; must be fast/smooth.
- **NOTHING HARDCODED** (founder, 20 Nov) — every screener threshold is a user-editable range (a number, or between two numbers; greater-/less-than, Screener-style), per-sector where relevant. ADAPT LKP's fixed bands into editable ranges rather than copying them.
- Changes to public/js/ must bump the service-worker version in public/sw.js.
- Portfolio + Watchlist stay in parity.
- Branch + PR for changes; never push to main directly; Cloudflare Git auto-deploys main on merge.
- Production credential/config changes need explicit user authorization.
- **Every feature/PR gets a clear BEFORE + AFTER real-frontend screenshot** (for the final delivery PDF) — see the Delivery section.

## Repo study: LKP screener (ceekay-munshot/klpdash) — for A6
**What it is:** a Cloudflare Worker + static dashboard that scores a fixed ~537-company universe (one
Screener.in saved screen branded "NSE 500", ~₹12,500 cr floor) on a 5-pillar model → weighted 0–100
composite + BUY/AVOID rating + hard-fail red flags. Static-first: GitHub Actions scrape + score +
commit JSON; the browser re-runs the same modules. 151 daily snapshots committed (History/backtests).

**Scoring model (the reusable heart):**
- **Fundamentals (29 pts, 19 rules):** ROE/ROCE, margins, operating cash flow (negative = hard fail),
  revenue/PAT CAGR, EPS, D/E (>2 hard fail), interest coverage (<1.5 hard fail), promoter pledge (>20%
  hard fail), promoter & FII/DII holding trend, dividends, SEBI (active case = hard fail), auditor
  opinion (adverse/disclaimer = hard fail). Financial Services excluded from D/E·ICR·CFO; defensive
  sectors get a lower growth bar.
- **Technicals (24 pts, 16 rules):** the SAME model as our Breakouts tab (price>50EMA, >200DMA [below =
  hard fail], golden cross, RSI, MACD, ADX, RS vs Nifty 500, volume, 52W proximity, base breakout, beta, ATR).
- **Macro (17 pts, 11 rules):** sector rotation (capex, rate-cut, China+1/EMS, rural), GDP/CPI/crude/INR/
  bond-yield, PLI + renewable. Two-path: per-company annual-report revenue mix when available, else sector proxy.
- **Sentiment (market-wide:** VIX, FII/DII flow, PCR, breadth) + **Liquidity (per-company:** ADTV [<₹5cr
  hard fail], impact cost, spread, F&O).
- **Composite = Fund×40% + Tech×35% + Macro×15% + Sent×5% + Liq×5%.** Bands: ≥75 STRONG BUY, 60–74 BUY,
  45–59 WATCH, <45 AVOID; any hard-fail → FILTERED (shown, excluded from the basket).

**Reusable files (pure, portable):** `public/js/{scoring,tech-scoring,macro-scoring,
sentiment-liquidity-scoring,composite-scoring,rule-meta}.js` and `screener-test/lib/{indicators,
liquidity-estimators,enrich-companies}.mjs`. Data scrapers: `screener-test/scrape-*.mjs`. The two
qualitative agents: `auditor_agent.txt` + `scrape-auditor-opinions.mjs` (auditor opinion), and
`build-revenue-mix-todo.mjs` + `merge-revenue-mix.mjs` (annual-report MD&A extraction).

**Caveats for the merge (correct the "all free" assumption):**
- Thresholds are FIXED hard-coded bands, NOT editable greater/less/between ranges. Founder wants
  EDITABLE per-sector ranges (Groww/Screener style) → ADAPT LKP's rules into editable thresholds, don't
  lift as-is. Only LKP's Backtesting "Custom Lab" has tweakable params + a per-pillar parameter picker.
- Several feeds are NOT free Screener+Yahoo: insider trades, auditor opinions, live quotes go through the
  Munshot/Muns API (devde.muns.io / fastapi.muns.io); PCR/impact-cost + SEBI governance use Firecrawl
  (paid credits); revenue-mix uses a Claude.ai routine. On merge, re-point these to Glow-Central-Research's
  own feeds (we already have technicals, insider, announcements, Screener fundamentals) or drop/replace.
- Related repos also exist: `techmuns/lkpearnings` (older LKP earnings) and `ceekay-munshot/glowstocks`.

## Repo study: GlowVentures (techmuns/GlowVentures) — for PART B
**What it is:** the family "Investor Cockpit" — Vite + React + TypeScript + Tailwind + Recharts, on
Cloudflare Pages behind an edge password gate. Core rule: **no figure is ever fabricated** (absent → "—"
with a reason). The book is assembled OFFLINE from ~30+ platforms' PDF/Excel statements → one generated
file `src/data/glowData.ts` → consumed by this app AND by Glow-Central-Research.
**Workflow differs from Glow-Central-Research:** push → open PR → label `automerge` → CI squash-merges to
main once green (`.github/workflows/merge-on-green.yml`). `glowData.ts` is GENERATED — never hand-edit;
regenerate with `npm run build-book`. README.md is STALE — trust CLAUDE.md + glowData.ts.

**Where each PART B item lives:**
- **B1 Motilal statements / blank returns:** the parser is a deterministic, coordinate-based OFFLINE
  pipeline (`scripts/ingest/extract.mjs` + `scripts/ingest/providers/*` + `.../lib/*`) — NOT an LLM.
  Motilal CDSL demats (`providers/motilalDemat.mjs`) are READ but value nothing (quantity only, no cost),
  so returns show "—". Blank XIRR = `costBasis: null` → `src/components/Absent.tsx`. Fix = recover costs
  from the transaction statements (`scripts/lib/recoverHoldingCosts.mjs`, `npm run reconcile:review` /
  `reconcile:register`), then rebuild the book. "Needs attention" = the manifest StatusPill in Statement
  Library + the `check:reads` gate (`scripts/check-reads.mjs`).
- **B2 same-units-two-names:** handled by `scripts/ingest/reconcile.mjs` → `duplicateHoldings` → shared
  `dedupeGroup` + `alsoReportedUnder` (counted once in consolidated totals). The "these are separate
  investments" decisions live in `shared/separateInvestments.mjs` (`npm run replay:dedupe`). The 6 cases →
  decide each as a duplicate (dedupe) vs separate buys (two transactions) there.
- **B3 bulletproof the parser:** deterministic per-provider readers (~21); docs with no reader fail
  explicitly (`no-extractor`, `scan-no-reader`, `no-text-layer`, `text-outlined-to-paths`), several are
  `held-out-by-decision`. "Bulletproof" = add/repair per-provider readers AND/OR add a Claude (LLM)
  fallback for unhandled docs (today the only LLM use is `scripts/build-private-rounds.mjs`, unrelated).
  The coordinate engine (`lib/layout.mjs`, `table.mjs`) must beat column-scramble + rotated pages + scans
  (tesseract OCR). NOTE: today's parser is deterministic by design, so "use Claude to parse" is a NEW
  approach — confirm scope with founder.
- **B4 private-holding PDF drill-down:** a PDF.js renderer + `src/components/SourceLink.tsx`
  (`sourceBackground`) already open a statement record as an overlay; private share counts are HAND-ENTERED
  with a free-text source label (`src/lib/holdingShares.ts`, `HoldingInputs.tsx`). The client's exact ask
  (click a share count → open the specific source PDF at its page) is PARTIALLY built — extend the entered
  count to carry/open its source document. Pages: `PrivateMarket.tsx`, `PrivateCompany.tsx`.
- **B5 share-certificate reconciliation:** map against transaction statements via the same reconcile
  pipeline; flag gaps as `material` deltas (`reconcile.mjs`, `config/reconciliation-exceptions.json`).
- **B6 real estate:** `src/pages/RealEstate.tsx` + `shared/realEstate.mjs` (model; tax `shared/propertyTax.mjs`;
  bulk Excel `shared/propertySheet.mjs`; store `functions/api/real-estate.js`). Exists — enrich with data.
- **B7 12-page PDF report:** `src/lib/exportCioReport.ts` (jsPDF) → cover, contents, allocation donut,
  asset table, performance by class/mandate, vs-benchmark, top holdings, PE/VC, cash, flows, returns, notes;
  summary/detailed + top-N. Driven by `src/components/CioReportExport.tsx`. Exists — polish per Ankita.
- **B8 Kiefer/Manorama missing:** same cost-recovery/reconcile path as B1.

**Fragile / notable:** parser genuinely "not bulletproof" (founder is right); private-register arrays
(`BOOK_PE_FUNDS` etc.) are EMPTY — the private book is carried as ordinary positions from the MOPWM
consolidated review, many valued at cost (no return); README stale; real-estate CII needs a manual yearly
add. Entry points: `src/App.tsx`+`src/lib/nav.ts` (routes), `src/lib/types.ts` (model), `scripts/build-book.mjs`
(book), `scripts/ingest/extract.mjs` (parser), `src/context/PortfolioContext.tsx`+`src/lib/analytics.ts`
(runtime), CLAUDE.md + docs/history/ (rules).

## Session log
- 20 Nov 2026: read both call transcripts (client + founder), Framework.xlsx, Groww + email screenshots. Mapped Glow-Central-Research end to end (tabs, pipelines, deployment, live site). Cloned techmuns/GlowVentures and ceekay-munshot/klpdash (read-only). **Both repo studies done** — folded into the LKP (A6) and GlowVentures (PART B) sections above. Wrote this worklog + posted the checklist in chat. Committed worklog to branch `claude/cool-gates-xzyfih`. **PART B (family-office data) reassigned to another session — I own PART A (screening) only.** Re-read the FULL Framework.xlsx: **~338 companies** (rows 9–346, not ~113), 6 criteria + a Governance gate; the "Table" sheet is a format template (headers only, 11 merged header groups). Standing instruction: **nothing hardcoded** in the screener (editable ranges). No code changed yet — awaiting which PART A item to start. Pushed worklog to origin. **Standing rules added: (1) before/after real-frontend screenshot for every feature → final delivery PDF; (2) tell the user WHERE on the dashboard each change lives; (3) after merge to main, verify the LIVE URL updated.** Green-lit to build all of PART A. Started Feature #1 (declutter nav + merge AI Insights/Recommendations + clean Alerts) — reading the nav/shell/saved-tabs machinery.

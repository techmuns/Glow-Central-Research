# Client + founder requirements — the strict to-do (20 Nov 2026)

Source of truth for what to build, extracted **verbatim-faithfully** from the two recordings the user
gave: the **client call** (≈1h) and the **founder's walkthrough** (≈18m, Hindi). The founder's order
(9:50): *"maintain a very strict to-do without fail … I don't want a single task missed."* So every
ask is listed here with a status and a timestamp reference. The raw transcript is saved at
`scratchpad/client-founder-transcript.txt` (and `call-readable.txt`); re-read this doc before each feature.

Timestamps `[c MM:SS]` = client call, `[f MM:SS]` = founder discussion.

Founder's stated priority order: **(1) family-office numbers (PART B — the OTHER session), (2) the
screening funnel.** Everything in PART A below is this session's work.

## SHIPPED LOG (live on main / glow-central-research.tech-441.workers.dev)
- ✅ **Remove AI Insights "Themes · who benefits"** (#1559) — A2.
- ✅ **Nav declutter to 3 core sections + "More" picker** (#1560) — A1.
- ✅ **Hide AI Recommendations sub-tab** (#1560) — A3 (hide half).
- ✅ **Framework scoring worksheet** tab (#1561) — A7; the funnel's qualitative stage.
- ✅ **Screening Funnel** — the "Screener" tab (#1563) — A6. Five editable stages, funnel viz + table,
  AND/OR, live counts, on real Screener fundamentals.
- ✅ **AI Insights decision layer** (#1564) — A5.4 decision matrix + A5.6 buy-price maths + A5.1
  technicals-own-section.
- ✅ **AI Insights business-quality breakdown** (#1565) — A5.3 (5 params, 0–2, editable weights → 0–10).
- ✅ **AI Insights sector valuation yardstick** (#1566) — A5.7 (bank→P/B, AMC→P/E, …).
- ✅ **AI Insights KPI trajectory** (#1567) — A5.8 (revenue/profit/margin sparklines + 3/5/10Y CAGRs).
- ✅ **Client requirements + worklog docs** on main (#1562).
- 🟨 **Surface the Screener in the top nav + remove the J&K-Bank "kachra" pilot** (PR #1568) — A4 (the
  concrete clutter the founder pointed at) + the nav fix (Screener was built but buried behind "More").
- 🟨 **Screener universe FIX** (PR #1569) — the big one: the funnel only covered **209** in-band
  large-caps (data skewed ≥₹10,000 Cr); rebuilt from the full tracked universe → **1,123 in the
  ₹1,000–25,000 Cr band** (client's "1,200–1,300"). `scripts/build-funnel-fundamentals.mjs` (offline
  merge) + `scripts/scrape-funnel-universe.mjs` + `funnel-universe-refresh.yml` (authenticated weekly
  walk fills the small-caps' 3-year metrics). **NEEDS the user to add `SCREENER_USERNAME` /
  `SCREENER_PASSWORD` repo secrets once** → then the funnel's quant stage fills automatically forever.

**The Framework must AUTO-SCORE (founder: "nothing manual… what is the use of AI?", [c 25:07]).** The
Framework tab is a MANUAL 0–2 grid today (338 blank rows) — wrong. Once the authenticated universe walk
lands the full metrics, the Framework's five criteria should be computed deterministically from them
(desk can override, never required to type). Tracked as the next build after the universe capture.

**Awaiting the user's input:** `SCREENER_USERNAME`/`SCREENER_PASSWORD` secrets (chosen 21 Nov — the
"configure once, forever automated" path for the Screener universe); A9 broker ingestion (Telegram/email
sources). **Next no-input items:** Framework auto-score, A10 demerger search, A3 merge Recos→Insights.

**Two Screener fundamentals feeds (A8, partly unified 21 Nov):** the per-company one-pager
`fundamentals.json` (168 cos, deep, the AI-Insights report) and the funnel's `funnel-fundamentals.json`
(now ~1,755 cos, flat). `build-funnel-fundamentals.mjs` now derives the funnel's 3-year metrics from the
one-pager's series where they overlap — the first half of the unification.

---

## PART A — Research Central (this session)

### A1. Declutter the nav to three sections — ✅ SHIPPED (#1560)
`[f 0:18–0:48]` Collapse Announcements/Earnings/Screens/Mutual-fund/News/Private-market/Super-investor/
Capital-raise into one **"More / Add tabs"** popup; leave only **Watchlist, Portfolio, Alerts**. Features
run in the background and are shown on demand `[f 0:26–0:38]`. Done: 3-section default + counted "More"
picker, device-remembered, deep-links still open hidden sections.

### A2. AI Insights — remove "Themes · who benefits" — ✅ SHIPPED (#1559)
`[f 1:26]` *"ये वॉट्स पियर … कचरा बनेगा, इसकी कोई जरूरत नहीं"* — the themes/benefit control Yamini flagged
is clutter; remove. Done; the per-company "Exposed to <theme>" chip + AI Alerts indirect-exposure kept.

### A3. Hide AI Recommendations for now; later MERGE into AI Insights — ✅ (hide) / ⬜ (merge later)
`[f 1:34, 1:43–1:57]` Recommendations stays behind for now (**done, #1560**). LATER: *"AI insights और
recommendation दोनों एक ही चीज बनेंगे"* — the two become ONE: running a 5-min stock idea on any
recommendation runs it; **merge the two into one table.** ⬜ TODO (later phase).

### A4. AI Alerts — Compact view: remove the "garbage" — ⬜ TODO (needs the exact items)
`[f 0:48–1:07]` On AI Alerts (the Compact cards), *"यह क्या कचरा ऐड हो गया है? पहले तो यह पूरा कचरा हटाओ"*
— remove the clutter that got added to Compact. Ask the user which specific elements (tags / broker
pills / archive ✕ / etc.) to strip.

### A5. AI Insights "5-minute report" overhaul — 🟨 CORE SHIPPED (4 of 8 items live)
The client went through this screen in detail. Each sub-item:
- **A5.1** Remove technical analysis from "what we like / don't like"; put it in its **own section**
  ("how the stock is looking technically"). `[c 17:53–18:16]` — ✅ SHIPPED (#1564): "How it looks
  technically" section added (the AI narrative may still mention them; the dedicated home now exists).
- **A5.2** **"What the Street says" as a broker TABLE:** columns = date / date of report / recommendation
  (buy-sell) / target price / revenue growth / EPS — "how a valuation table looks", **one row per
  broker**, pick-and-choose which broker. `[c 18:22–19:07]` — ✅ ALREADY PRESENT (pre-existing
  `brokerBlockHtml`, one row per broker from `broker-reports.json`).
- **A5.3** **Business-quality drill-down:** show the ~5 parameters behind the score, with an AI 1–2 line
  summary per parameter (e.g. the company's moat / right-to-win), a **0–2 score per parameter**, arriving
  at a 0–10 total; **weightages tweakable**, client gives inputs. `[c 19:15–21:04, 34:52–35:52]` —
  ✅ SHIPPED (#1565): 5 deterministic params (returns / growth / balance sheet / margins / consistency),
  0–2 each, factual notes, editable weights → 0–10. **The per-param "moat" AI sentence is still TODO
  (needs an AI call), and the client may swap the 5 params/weights for their own framework.**
- **A5.4** **The matrix / quadrant** (the "decide in 30 seconds" block at the top): three axes —
  **business quality** (good/avg/bad), **earnings predictability** (high/med/low), **valuation**
  (under/fair/over). Show which quadrant → look / avoid / **watchlist** (green flag in 2 of 3 → watchlist;
  poor quality → drop entirely). `[c 22:40–26:41, 34:30–34:52]` — ✅ SHIPPED (#1564): the decision matrix.
- **A5.5** A **headline "what will make me buy this stock."** `[c 22:49]` — 🟨 PARTIAL: the buy-price
  block answers "what price makes this a buy"; the existing "Our view" trigger line covers the narrative.
- **A5.6** **Exit-price → entry-price math in the report:** AI assigns a forward multiple (e.g. 25×) to
  projected EPS → exit price; apply a required IRR (≈20%, higher for ancillaries) → **entry/buy price**;
  map vs CMP (above/below). Plus a **manual check** on the rationale for the assigned multiple.
  `[c 23:56–25:03, 44:49–48:18]` — ✅ SHIPPED (#1564): the buy-price chain, editable multiple/IRR/years.
- **A5.7** **Valuation metric per sector** (bank → P/B, AMC → P/E, etc.); different sectors, different
  methodology — from the KPI→signal map / Framework. `[c 27:30–28:28, 35:56]` — ⬜ TODO (next; small).
- **A5.8** **KPI table + trends:** per-company KPI table with Q/Q, Y/Y and multi-quarter trend, and an
  **icon to open a longer-term trend**; show **estimate vs guidance vs actual**, and the **popular street
  estimate** (from research reports). `[c 10:05–12:17]` — 🟨 TRAJECTORY SHIPPED (#1567): revenue / net-profit / margin sparklines +
  3/5/10Y CAGRs. Estimate-vs-actual + street estimate still need consensus data we may not hold.
- Note `[c 25:03]`: *"everything is AI calculated, nothing manual."* The top matrix decides dig-deep or not.

### A6. THE SCREENING FUNNEL — ✅ SHIPPED (#1563), LIVE (the core deliverable)
The founder's explicit UI spec `[f 3:08–5:36]`, Groww-style (ref URL the user gave:
`groww.in/stocks/filter?...marketCapLow/High...closePriceLow/High...sortType`):
- **Two-pane layout:** LEFT = a **funnel visualization** (Total stocks → after each exclusion → … → ~100),
  RIGHT = **one table with all columns** (NOT multiple baskets). Clicking a funnel step filters the table
  to that step's companies. *"एक बहुत ही सुंदर विजुअलाइजेशन … clearly दिखे AI screening कैसे हो रही है"*
  `[f 3:37–5:36]`. **Live:** click-click-click and the funnel counts change live; fast & smooth `[f 8:27–8:41]`.
- **Step 1 — Market cap:** universe **₹1,000–25,000 Cr** (client's defined universe), **editable** filter;
  `[c 8:47, 36:53, 38:12; f 3:08]`. ~1,200–1,300 stocks in band `[c 38:12]`. (Data corroboration: 96% of the
  Framework's readable names sit in this band — see worklog.)
- **Step 2 — Sector exclusion:** **checkboxes** to exclude sectors (commodity first; "negative impact of AI
  on business model"; hard-to-cover sectors like pharma/chemicals). Manual list the client supplies.
  `[c 37:05–38:29; f 3:16–3:37]` → ~800 companies.
- **Step 3 — Quantitative screen (EDITABLE RANGES, not hardcoded):** Revenue & profit growth, **ROCE**,
  **cash conversion**, **debt position** — each a filter the user sets as a single number or **between two
  numbers (greater-than / less-than, like Screener)**, tweakable per sector; *"हार्ड कोट मत कर, रेंज दे दे"*
  `[c 38:33–39:49; f 5:36–6:48]` → ~400 (don't hard-fix 400; reduce per our own criteria `[f 4:32]`).
  - **Keep inflection-point companies** (commodity→specialty, large capex, new product, smart acquisition):
    data comes from **Corp Announcements categories** (capex & commissioning, capacity & opex, capital raise,
    product launch & approvals) over the **last ~6 months** `[c 39:01–39:35; f 6:48–8:14]`.
- **Step 4 — Qualitative (AI) = the Framework (0–2):** business quality, differentiation (niche/moat),
  growth runway (5–10y), catalyst/inflection, steady-compounder, earnings materiality, governance flag
  (minority treatment, capital allocation, pledging, auditor remarks) `[c 39:57–43:21]` → ~100 top companies.
  **✅ the Framework TAB (#1561) is this step** — integrate it into the funnel.
- **Step 5 — Valuation filter → buy-list of 30–40;** wait for the buy price `[c 43:37–44:11]`.
- **AND / OR toggle (important):** AND-ing every filter leaves ~1–2 companies; let the user **choose AND or
  OR** per filter so the basket stays usable `[f 13:01–14:26]`.
- **Turn-around / recovery screen:** recent losses, falling EPS, low ROCE, elevated debt (from PAT/EPS/ROCE)
  `[f 9:04–9:24]`.
- **Special situations & hidden value:** holding companies, demerger candidates, cash cows — from the
  announcements (governance / management / deals) `[f 10:42–11:27]`.
- **Cyclical recovery / bottom-of-cycle:** needs a defined method (AI prompt on Claude/Moonshot; bucket by
  CWIP + last-2-years flag) `[f 11:54–12:19]`.
- **Bucketing** (shown in the report, not part of the score): structural compounders, business at inflection,
  turnaround/earnings recovery, special situations, cyclical recovery `[c 49:55–51:19]`.
- End goal: deliver ~100 companies → watchlist; 30 actively tracked `[c 56:49–56:58]`.
- **Corporate announcements feed the quality score live:** a new MD, a new drug, etc. should change the
  score; re-run scoring for companies with new announcements and move changes into the watchlist
  `[c 55:03–56:28]`.
- **Token cost:** the qualitative/AI step is token-heavy; run it periodically (not daily), optimise cost;
  Tech Muns limits reset Sunday `[c 53:46–55:03; f 8:48–9:04]`.

### A7. Framework scoring worksheet — ✅ SHIPPED (#1561), integrate into A6
The qualitative step as a standalone editable, shared tab (5 criteria 0–2 + Governance gate, 338 companies).
Next: make it the step-4 surface inside the funnel.

### A8. Merge the LKP / klpdash engine; build the "Moonshot stock screener" — ⬜ TODO
`[f 2:27–3:00, 9:24–9:39]` *"whatever data/API isn't built into THIS dashboard, bring it from the LKP one,
put it in, and bulletproof it"*; *"make a clone of the LKP one and merge"*; *"मून शॉट स्टॉक स्क्रीनर बनाना"*.
LKP = `ceekay-munshot/klpdash`: 5-pillar scorer off Screener.in + Yahoo + Muns + Firecrawl — the source of
the quantitative fundamentals (P/E, ROE, ROCE, cash conversion, debt) the funnel's Step 3 needs. Don't carry
LKP's colours `[f 8:41]`.

### A9. Broker research ingestion — ⬜ TODO (depends on the user wiring sources)
`[c 12:25–17:46]` Telegram channels ("equity research reports by MWZ" ~5.5k; "money purse" ~2.77L) and
email auto-forward to `research@…` / `tech@muns.io` → feed the **broker research tab** (and A5.2). The user
sets up auto-forward; we ingest.

### A10. Demerger search on the Mergers & Demergers view — ⬜ TODO (small)
`[f 11:27–11:45]` Add a search box on the existing merger/demerger surface so demerger candidates are easy
to find.

---

## PART B — Glow Ventures family office (the OTHER session owns this; sync at the end)
`[c 0:04–1:26, 58:52–59:39; f 10:26–17:16]`
- **B1. Share-certificate reconciliation:** map the share-certificate Excel to the transaction statement,
  flag only the gaps.
- **B2. Private-transaction PDF drill-down:** clicking a private-holding row / number opens the source PDF
  (transaction statement) at its page.
- **B3. Motilal statements / blank XIRR:** Yamini's blank XIRR columns were because Motilal statements
  weren't loaded; 46 of 49 holdings cross-verified via transaction statements; **6 holdings show the same
  units/cost across two members → don't double-count** (361 fund is one to check); the rest (43) being added.
- **B4. Kiefer Science & Manorama missing** — pending reconciliation.
- **B5. Drag-and-drop parser must be bulletproof** — a lot of data was going unused on drag-drop; fix so it
  fills for all documents.
- **B6. Real-estate tab** — enrich with data (one commercial rental property now, more coming).
- **B7. 12-page PDF report**, emailed every Monday morning; Ankita to give input on layout.
- **B8. View-only LOA / monthly statement access** for PMS/AIF custodians (like CAMS/Kfintech) instead of
  manual downloads.

---

## Process rules the founder set (do not break)
- **A strict, complete to-do, nothing missed** `[f 9:50–10:12]`. This doc is it; keep it current.
- **Output must be 100% correct and clear** — the end viewers are billionaires with minimal time `[f 10:05–10:29]`.
- **Nothing hardcoded** — filter thresholds are editable ranges `[f 6:16; client "ss2"]`.
- No tab in Research Central that nobody looks at `[c 53:05]`.
- Before/after real-frontend screenshots for every feature → final delivery PDF (standing user rule).
- Say WHERE on the dashboard each change lives; verify the LIVE URL after each merge (standing user rule).

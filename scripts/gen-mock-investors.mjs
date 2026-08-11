#!/usr/bin/env node
// gen-mock-investors.mjs — generates the ILLUSTRATIVE super-investor data set.
//
//   node scripts/gen-mock-investors.mjs
//
// Writes:
//   public/data/mock/superinvestors.json   8 named individual investors, 4 quarters each
//   public/data/mock/institutions.json     8 fund houses, same shape plus AUM/category
//   public/data/mock/fund-flows.json       24 months of FII / DII / MF category net flows
//
// ATTRIBUTION — READ THIS BEFORE EDITING
//
//   The investor and fund names here are REAL, public figures. Their actual shareholdings are
//   publicly disclosed in quarterly exchange filings and aggregated by Trendlyne / Ticker
//   Finology / AMFI. Naming them is the point of the feature.
//
//   THE POSITIONS BELOW ARE NOT THEIRS. Every ticker, quantity, holding percentage and
//   transaction is invented. "Dolly Khanna holds 2.4% of <company>" in this data set is a
//   false statement about a real person's finances, and it is only defensible because the
//   dashboard says so on every single surface that renders it — the tab ribbon, the investor
//   workspace, the drill panel, and row 1 of every exported sheet. If you add a surface, add
//   the marker.
//
//   THIS FILE CONTAINS NUMBERS AND POSITIONS ONLY. It deliberately carries no `rationale`,
//   `commentary`, `quote`, `thesis` or `why` field, and none should ever be added while the
//   data is synthetic. Inventing a number is bounded and labelled; inventing a sentence a
//   named person supposedly said or thought is putting words in a real mouth, and no ribbon
//   fixes that. The same rule governs the con-call transcripts (see gen-mock-concalls.mjs),
//   where the speakers are fictional for exactly this reason.
//
// Determinism: mulberry32 seeded from SEED, so reruns are byte-identical.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UNIVERSE_PATH = resolve(__dirname, '../public/data/universe.json');
const PORTFOLIO_PATH = resolve(__dirname, '../public/data/portfolio.json');
const INVESTORS_PATH = resolve(__dirname, '../public/data/mock/superinvestors.json');
const INSTITUTIONS_PATH = resolve(__dirname, '../public/data/mock/institutions.json');
const FLOWS_PATH = resolve(__dirname, '../public/data/mock/fund-flows.json');

const SEED = 20260813;
const QUARTERS = ['Q2FY26', 'Q3FY26', 'Q4FY26', 'Q1FY27']; // oldest first
const LATEST_QUARTER = 'Q1FY27';
const AS_OF = '2026-06-30'; // the shareholding cut-off the latest quarter reflects
const FLOW_MONTHS = 24;

// ---------------------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const rand = (lo, hi) => lo + rng() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const chance = (p) => rng() < p;
const round = (n, d = 2) => {
  const m = 10 ** d;
  return Math.round(n * m) / m;
};
function sample(arr, n) {
  const pool = arr.slice();
  const out = [];
  while (out.length < n && pool.length) out.push(...pool.splice(Math.floor(rng() * pool.length), 1));
  return out;
}

const parseMarketCapCr = (value) => {
  const n = Number(String(value ?? '').replace(/,/g, '').replace(/Cr\.?/i, '').trim());
  return Number.isFinite(n) ? n : null;
};
const tickerFromUrl = (url) => String(url || '').match(/\/company\/([^/]+)/)?.[1]?.toUpperCase() || null;

// ---------------------------------------------------------------------------------------
// The tracked names. Real people and real funds — see the attribution note above.
//
// `style` only shapes which slice of the universe the generator draws from, so the invented
// portfolios look plausible (a small-cap-focused investor should not come back holding only
// mega-caps). It is a generator artefact, not a claim about how anyone actually invests.
// ---------------------------------------------------------------------------------------
const INVESTORS = [
  { investorId: 'ashish-kacholia', name: 'Ashish Kacholia', since: '2004', style: 'small', size: [18, 25] },
  { investorId: 'dolly-khanna', name: 'Dolly Khanna', since: '2008', style: 'micro', size: [14, 20] },
  { investorId: 'vijay-kedia', name: 'Vijay Kedia', since: '1993', style: 'small', size: [12, 16] },
  { investorId: 'mukul-agrawal', name: 'Mukul Agrawal', since: '2003', style: 'mid', size: [18, 25] },
  { investorId: 'akash-bhanshali', name: 'Akash Bhanshali', since: '2001', style: 'mid', size: [12, 18] },
  { investorId: 'anil-kumar-goel', name: 'Anil Kumar Goel', since: '1990', style: 'micro', size: [14, 22] },
  { investorId: 'sunil-singhania', name: 'Sunil Singhania', since: '2018', style: 'mid', size: [16, 24] },
  { investorId: 'porinju-veliyath', name: 'Porinju Veliyath', since: '2002', style: 'micro', size: [12, 18] },
];

const INSTITUTIONS = [
  { investorId: 'small-cap-world-fund', name: 'Small Cap World Fund', house: 'Capital Group', category: 'FII', style: 'small', size: [20, 28], aum: [48000, 92000], schemes: [1, 2] },
  { investorId: 'bandhan-kirti-jain', name: 'Bandhan Small Cap Fund', house: 'Bandhan Mutual Fund', manager: 'Kirti Jain', category: 'Domestic MF', style: 'small', size: [18, 26], aum: [7000, 14000], schemes: [3, 6] },
  { investorId: 'nippon-india-mf', name: 'Nippon India Growth Fund', house: 'Nippon India Mutual Fund', category: 'Domestic MF', style: 'mid', size: [20, 30], aum: [22000, 38000], schemes: [4, 9] },
  { investorId: 'hdfc-mf', name: 'HDFC Flexi Cap Fund', house: 'HDFC Mutual Fund', category: 'Domestic MF', style: 'large', size: [18, 26], aum: [45000, 70000], schemes: [5, 11] },
  { investorId: 'sbi-mf', name: 'SBI Small Cap Fund', house: 'SBI Mutual Fund', category: 'Domestic MF', style: 'small', size: [18, 26], aum: [26000, 34000], schemes: [4, 8] },
  { investorId: 'government-pension-global', name: 'Government Pension Fund Global', house: 'Norges Bank IM', category: 'FII', style: 'large', size: [20, 30], aum: [110000, 180000], schemes: [1, 1] },
  { investorId: 'abu-dhabi-investment', name: 'Abu Dhabi Investment Authority', house: 'ADIA', category: 'FII', style: 'mid', size: [14, 22], aum: [60000, 105000], schemes: [1, 2] },
  { investorId: 'lic-india', name: 'Life Insurance Corporation of India', house: 'LIC', category: 'DII', style: 'large', size: [22, 30], aum: [200000, 320000], schemes: [8, 16] },
];

const ACTIONS = ['New', 'Buy', 'Hold', 'Sell', 'Exit'];

// ---------------------------------------------------------------------------------------
// Universe slices by market-cap band, so a "small cap" investor gets small caps.
// ---------------------------------------------------------------------------------------
const universe = JSON.parse(readFileSync(UNIVERSE_PATH, 'utf8'));
const rows = universe
  .filter((e) => tickerFromUrl(e['Screener URL']) && e.Company)
  .map((e) => ({
    ticker: tickerFromUrl(e['Screener URL']),
    name: e.Company,
    sector: e.Sector || e['Broad Sector'] || 'Services',
    marketCap: parseMarketCapCr(e['Market Cap']) || 2000,
  }))
  .sort((a, b) => b.marketCap - a.marketCap);

const n = rows.length;
const BANDS = {
  large: rows.slice(0, Math.floor(n * 0.25)),
  mid: rows.slice(Math.floor(n * 0.2), Math.floor(n * 0.6)),
  small: rows.slice(Math.floor(n * 0.45), Math.floor(n * 0.85)),
  micro: rows.slice(Math.floor(n * 0.65)),
};

const holdingsPortfolio = JSON.parse(readFileSync(PORTFOLIO_PATH, 'utf8'))?.holdings || [];
const heldTickers = holdingsPortfolio.map((h) => String(h.ticker).toUpperCase());
const heldRows = rows.filter((r) => heldTickers.includes(r.ticker));

/**
 * Build one holder's book: `count` companies, each with a position in all four quarters.
 *
 * Positions are sized by RUPEE VALUE first, then converted to a holding percentage against
 * the company's market cap. Drawing the percentage directly produced nonsense at the top of
 * the market — "3% of a ₹6.7 lakh crore bank" is a ₹20,000 crore position for one individual.
 * Sizing by value keeps a ₹150 Cr position at 3% of a small cap and 0.02% of a mega cap,
 * which is the relationship that actually holds.
 *
 * `positionBand` is the holder's typical position size in ₹ crore.
 *
 * The walk runs backwards from the latest quarter, and share count is fixed per company for
 * the whole series — drawing an implied price per quarter made `qty` incomparable across
 * quarters, so `qtyDelta` did not reconcile against the quantities beside it.
 */
function buildBook(pool, count, { seedHolding = [], positionBand = [20, 400], maxPct = 8 } = {}) {
  const picks = [...seedHolding, ...sample(pool.filter((p) => !seedHolding.some((s) => s.ticker === p.ticker)), Math.max(0, count - seedHolding.length))];
  const holdings = [];

  for (const co of picks) {
    // One share count per company for the whole series, from a plausible share price.
    const impliedPrice = Math.max(12, rand(45, 2400));
    const sharesOut = (co.marketCap * 1e7) / impliedPrice;

    // Latest position value, then as a percentage of the company — capped, because a stake
    // above the disclosure threshold is rare and above ~10% is a different kind of story.
    let valueCr = round(rand(positionBand[0], positionBand[1]), 1);
    const pctOf = (v) => Math.min(maxPct, round((v / co.marketCap) * 100, 2));

    const series = [];
    for (let qi = QUARTERS.length - 1; qi >= 0; qi--) {
      series.unshift({ quarter: QUARTERS[qi], valueCr });
      // The previous quarter's position: often unchanged, sometimes materially different.
      const move = chance(0.45) ? 1 : chance(0.5) ? rand(1.05, 1.7) : rand(0.4, 0.95);
      valueCr = round(Math.max(0, valueCr * move), 1);
    }

    // A genuinely new entry: zero out everything before a random quarter.
    if (chance(0.22)) {
      const entryIdx = randInt(1, QUARTERS.length - 1);
      for (let qi = 0; qi < entryIdx; qi++) series[qi].valueCr = 0;
    }
    // …or a full exit in the latest quarter.
    if (chance(0.1)) series[series.length - 1].valueCr = 0;
    if (series.every((s) => s.valueCr === 0)) series[series.length - 1].valueCr = round(rand(positionBand[0], positionBand[1]), 1);

    for (let qi = 0; qi < series.length; qi++) {
      const cur = series[qi];
      const prev = qi > 0 ? series[qi - 1] : null;
      const holdingPct = pctOf(cur.valueCr);
      const prevPct = prev ? pctOf(prev.valueCr) : 0;
      const qty = Math.round((sharesOut * holdingPct) / 100);
      const prevQty = prev ? Math.round((sharesOut * prevPct) / 100) : 0;
      const holdingPctDelta = prev ? round(holdingPct - prevPct, 2) : 0;

      let action;
      if (!prev) action = 'Hold';
      else if (prevPct === 0 && holdingPct > 0) action = 'New';
      else if (holdingPct === 0 && prevPct > 0) action = 'Exit';
      else if (holdingPctDelta > 0.01) action = 'Buy';
      else if (holdingPctDelta < -0.01) action = 'Sell';
      else action = 'Hold';

      holdings.push({
        ticker: co.ticker,
        name: co.name,
        sector: co.sector,
        quarter: cur.quarter,
        qty,
        holdingPct,
        // Value is the holding percentage applied to market cap. It is DERIVED, not disclosed —
        // filings give a percentage, never a rupee amount — and the UI says so wherever it shows.
        valueCr: round((co.marketCap * holdingPct) / 100, 1),
        qtyDelta: prev ? qty - prevQty : 0,
        holdingPctDelta,
        action,
      });
    }
  }
  return holdings;
}

function summarise(holdings) {
  const latest = holdings.filter((h) => h.quarter === LATEST_QUARTER && h.holdingPct > 0);
  const prev = holdings.filter((h) => h.quarter === QUARTERS[QUARTERS.length - 2] && h.holdingPct > 0);
  const value = round(latest.reduce((s, h) => s + h.valueCr, 0), 1);
  const prevValue = round(prev.reduce((s, h) => s + h.valueCr, 0), 1);
  return {
    stocksHeld: latest.length,
    portfolioValueCr: value,
    prevPortfolioValueCr: prevValue,
    valueChangePct: prevValue ? round(((value - prevValue) / prevValue) * 100, 1) : null,
    topHolding: latest.slice().sort((a, b) => b.valueCr - a.valueCr)[0]?.name ?? null,
  };
}

// ---- individuals ---------------------------------------------------------------------------
// Two of the tracked names get a portfolio holding overlapping the user's own book, so the
// Portfolio scope has something in it rather than rendering empty.
const investors = INVESTORS.map((inv, i) => {
  const pool = BANDS[inv.style] || rows;
  const seed = i < 3 ? sample(heldRows, randInt(1, 3)) : [];
  const holdings = buildBook(pool, randInt(inv.size[0], inv.size[1]), {
    seedHolding: seed,
    positionBand: [12, 340], // individuals run books in the hundreds-to-low-thousands of crore
    maxPct: 8,
  });
  return {
    investorId: inv.investorId,
    name: inv.name,
    type: 'individual',
    since: inv.since,
    quarters: [...QUARTERS].reverse(), // newest first, as the UI reads them
    ...summarise(holdings),
    holdings,
  };
});

// ---- institutions --------------------------------------------------------------------------
const institutions = INSTITUTIONS.map((inst, i) => {
  const pool = BANDS[inst.style] || rows;
  const seed = i < 3 ? sample(heldRows, randInt(1, 3)) : [];
  // A fund's India equity positions scale with its AUM, so the book is an order of magnitude
  // larger than an individual's without any single stake being implausible.
  const aumCr = randInt(inst.aum[0], inst.aum[1]);
  const holdings = buildBook(pool, randInt(inst.size[0], inst.size[1]), {
    seedHolding: seed,
    positionBand: [Math.round(aumCr * 0.004), Math.round(aumCr * 0.05)],
    maxPct: 9.5,
  });
  const latest = holdings.filter((h) => h.quarter === LATEST_QUARTER && h.holdingPct > 0);
  const bySector = {};
  for (const h of latest) bySector[h.sector] = (bySector[h.sector] || 0) + h.valueCr;
  const topSectors = Object.entries(bySector)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([sector, v]) => ({ sector, sharePct: round((v / latest.reduce((s, h) => s + h.valueCr, 0)) * 100, 1) }));

  return {
    investorId: inst.investorId,
    name: inst.name,
    type: 'institution',
    house: inst.house,
    manager: inst.manager ?? null,
    category: inst.category,
    aumCr,
    schemeCount: randInt(inst.schemes[0], inst.schemes[1]),
    since: null,
    quarters: [...QUARTERS].reverse(),
    ...summarise(holdings),
    topSectors,
    holdings,
  };
});

// ---- fund flows ----------------------------------------------------------------------------
// 24 months of net flows in ₹ crore. Signs matter: FII and DII genuinely run opposite in Indian
// markets more often than not, so the series are anti-correlated rather than independent.
const MONTHS = [];
{
  const d = new Date(Date.UTC(2024, 8, 1)); // Sep 2024 → Aug 2026
  for (let i = 0; i < FLOW_MONTHS; i++) {
    MONTHS.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
}
const flows = MONTHS.map((month) => {
  const fii = Math.round(rand(-32000, 26000));
  // DII leans against FII, with its own drift — SIP flows keep it positive more often.
  const dii = Math.round(-fii * rand(0.35, 0.95) + rand(2000, 16000));
  const equity = Math.round(rand(6000, 42000));
  return {
    month,
    fiiNetCr: fii,
    diiNetCr: dii,
    mf: {
      equityCr: equity,
      smallCapCr: Math.round(equity * rand(0.08, 0.24)),
      midCapCr: Math.round(equity * rand(0.1, 0.26)),
      largeCapCr: Math.round(equity * rand(0.12, 0.34)),
    },
  };
});

// ---- write -----------------------------------------------------------------------------------
const stamp = {
  generated_at: new Date('2026-08-11T04:10:00Z').toISOString(),
  generator: 'scripts/gen-mock-investors.mjs',
  seed: SEED,
  source: 'Mock data',
  as_of: AS_OF,
  quarter: LATEST_QUARTER,
  quarters: [...QUARTERS].reverse(),
};

const ATTRIBUTION =
  'ILLUSTRATIVE DATA. The investor and fund names here are REAL public figures whose actual shareholdings are ' +
  'disclosed in quarterly exchange filings and aggregated by Trendlyne / Ticker Finology / AMFI. ' +
  'THE POSITIONS IN THIS FILE ARE NOT THEIRS — every ticker, quantity and holding percentage is synthetic, ' +
  'generated by scripts/gen-mock-investors.mjs. This file contains numbers and positions only: no quote, ' +
  'rationale or commentary is attributed to any named person, and none may be added while the data is synthetic.';

writeFileSync(
  INVESTORS_PATH,
  `${JSON.stringify({ _provenance: ATTRIBUTION, ...stamp, investor_count: investors.length, investors }, null, 1)}\n`
);
writeFileSync(
  INSTITUTIONS_PATH,
  `${JSON.stringify({ _provenance: ATTRIBUTION, ...stamp, institution_count: institutions.length, institutions }, null, 1)}\n`
);
writeFileSync(
  FLOWS_PATH,
  `${JSON.stringify(
    {
      _provenance:
        'ILLUSTRATIVE DATA. Every flow figure is synthetic, generated by scripts/gen-mock-investors.mjs. ' +
        'Real FII/DII net flows are published by NSE/BSE and mutual fund category flows by AMFI.',
      ...stamp,
      unit: 'INR crore, net',
      month_count: flows.length,
      months: flows,
    },
    null,
    1
  )}\n`
);

// ---- report ------------------------------------------------------------------------------------
const allH = [...investors, ...institutions].flatMap((x) => x.holdings);
const latestH = allH.filter((h) => h.quarter === LATEST_QUARTER);
const byAction = latestH.reduce((a, h) => ({ ...a, [h.action]: (a[h.action] || 0) + 1 }), {});
console.log(`investors:            ${investors.length} individuals, ${institutions.length} institutions`);
console.log(`holdings rows:        ${allH.length} (${QUARTERS.length} quarters each)`);
console.log(`latest-quarter moves: ${ACTIONS.map((a) => `${a} ${byAction[a] || 0}`).join(' · ')}`);
console.log(`portfolio overlap:    ${new Set(latestH.filter((h) => heldTickers.includes(h.ticker)).map((h) => h.ticker)).size} of ${heldTickers.length} holdings covered`);
console.log(`fund flows:           ${flows.length} months (${MONTHS[0]} → ${MONTHS.at(-1)})`);
console.log(`\nwrote ${INVESTORS_PATH}`);
console.log(`wrote ${INSTITUTIONS_PATH}`);
console.log(`wrote ${FLOWS_PATH}`);

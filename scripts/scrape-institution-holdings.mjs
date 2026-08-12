// scripts/scrape-institution-holdings.mjs — REAL filed shareholdings, by institution.
//
//   node scripts/scrape-institution-holdings.mjs
//
// Writes public/data/institution-holdings.json: every company a tracked institution appears in,
// with the share count and percentage each company FILED with the exchanges, nine quarters deep.
//
// CADENCE. Shareholding patterns are filed quarterly, and the exchange window runs for weeks after
// each quarter ends — companies trickle in. So this is a scheduled scrape committed to the repo,
// not a Worker route: there is no per-request freshness to win, and a 1MB HTML parse per reader
// would be an absurd way to serve data that moves four times a year.
//
// ADDING A FUND is one entry in FUNDS below. The id and slug come straight out of the Trendlyne
// URL: /portfolio/superstar-shareholders/<id>/latest/<slug>/.
//
// THE RUN FAILS RATHER THAN SHIPPING A WRONG TOTAL. Trendlyne state the holding count and the
// portfolio value in prose on the page; we compute both from the rows we parsed. If the two
// disagree, the parse has dropped or double-counted something and the file is not written. On the
// Jun 2026 pull they agree to the rupee: 37 holdings, ₹35,818.0 Cr.

import { writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSuperstarPortfolio, portfolioUrl } from './lib/trendlyne.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/data/institution-holdings.json');
const UNIVERSE = resolve(__dirname, '../public/data/universe.json');

// `house` and `category` are ours, not Trendlyne's — they are what the dashboard groups by, and
// Trendlyne's page does not carry them.
const FUNDS = [
  { id: 54015, slug: 'smallcap-world-fund-inc', house: 'Capital Group', category: 'FII' },
];

// Trendlyne's stated total vs ours. A gap this size means a row was dropped or counted twice.
const TOLERANCE_CR = 0.5;

/**
 * ticker -> sector/industry, for the ~half of these holdings that sit inside the NSE 500.
 *
 * universe.json carries no ticker column — the screener export identifies a company by its
 * Screener.in URL, and `js/data/universe.js` derives the ticker from the last path segment. Same
 * derivation here so the two cannot disagree about what a ticker is.
 */
async function loadUniverse() {
  try {
    const raw = JSON.parse(await readFile(UNIVERSE, 'utf8'));
    const idx = new Map();
    for (const c of Array.isArray(raw) ? raw : []) {
      const m = /company\/([^/]+)\//.exec(String(c['Screener URL'] || ''));
      const t = m ? m[1].toUpperCase() : null;
      if (t) idx.set(t, { sector: c.Sector || null, industry: c.Industry || null });
    }
    return idx;
  } catch {
    return new Map();
  }
}

const pp = (a, b) => (a == null || b == null ? null : Math.round((a - b) * 100) / 100);

async function main() {
  const universe = await loadUniverse();
  console.log(`universe index: ${universe.size} tickers`);

  const institutions = [];
  for (const fund of FUNDS) {
    console.log(`\nfetching ${fund.slug} …\n  ${portfolioUrl(fund)}`);
    const f = await fetchSuperstarPortfolio(fund);

    // The cross-check. Their prose against our arithmetic, before anything is written.
    const gap = f.stated.valueCr == null ? null : Math.abs(f.portfolioValueCr - f.stated.valueCr);
    console.log(`  parsed ${f.holdings.length} holdings + ${f.former.length} former · Rs ${f.portfolioValueCr.toLocaleString('en-IN')} Cr`);
    console.log(`  Trendlyne states ${f.stated.stocks} holdings · Rs ${(f.stated.valueCr ?? 0).toLocaleString('en-IN')} Cr`);
    if (f.stated.stocks != null && f.stated.stocks !== f.holdings.length) {
      throw new Error(`holding count disagrees: parsed ${f.holdings.length}, page states ${f.stated.stocks}`);
    }
    if (gap != null && gap > TOLERANCE_CR) {
      throw new Error(`portfolio value disagrees by Rs ${gap.toFixed(1)} Cr: parsed ${f.portfolioValueCr}, page states ${f.stated.valueCr}`);
    }
    console.log('  cross-check OK');

    const [q0, q1] = f.quarters;
    const decorate = (h) => {
      const u = universe.get(h.ticker.toUpperCase()) || null;
      const cur = h.pctByQuarter[q0];
      const prev = h.pctByQuarter[q1];
      return {
        ticker: h.ticker,
        name: h.name,
        sector: u?.sector ?? null,
        industry: u?.industry ?? null,
        inUniverse: !!u,
        // Filed by the company, both of them.
        qty: h.qty,
        holdingPct: cur,
        // Trendlyne's derivation (holding % x market cap), carried as theirs and labelled as such.
        valueCr: h.valueCr,
        // Their published change for the quarter, and the label they use where no number applies
        // ("New", "Below 1% first time", "Filing Awaited").
        changePp: h.changePp,
        changeNote: h.changeNote,
        // Ours, and only arithmetic on two filed percentages — never a stand-in for the above.
        pctDelta: pp(cur, prev),
        pctByQuarter: h.pctByQuarter,
        url: h.url,
      };
    };

    institutions.push({
      investorId: f.slug,
      name: f.name,
      type: 'institution',
      house: fund.house,
      category: fund.category,
      trendlyneId: f.trendlyneId,
      sourceUrl: f.sourceUrl,
      latestQuarter: f.latestQuarter,
      latestQuarterLabel: f.latestQuarterLabel,
      quarters: f.quarters,
      quarterLabels: f.quarterLabels,
      stocksHeld: f.holdings.length,
      portfolioValueCr: f.portfolioValueCr,
      // How many of the current holdings have actually filed for the newest quarter. The rest are
      // held — there is a share count and a value — with the percentage still outstanding.
      filedThisQuarter: f.holdings.filter((h) => h.pctByQuarter[f.latestQuarter] != null).length,
      awaitingFiling: f.holdings.filter((h) => h.pctByQuarter[f.latestQuarter] == null).map((h) => h.ticker),
      holdings: f.holdings.map(decorate),
      former: f.former.map(decorate),
      fetchedAt: f.fetchedAt,
    });
  }

  const payload = {
    _provenance:
      'REAL DATA. Shareholding patterns as filed with the Indian exchanges each quarter, aggregated by holder by Trendlyne. Share counts and holding percentages are the filings themselves. The rupee holding value is TRENDLYNE\'S OWN derivation (holding % x market cap), reproduced unchanged and attributed, not recomputed here. An absent percentage for the newest quarter means the company has not filed yet — it does not mean the position was sold.',
    source: 'Trendlyne — Superstar Shareholders (trendlyne.com/portfolio/superstar-shareholders/)',
    generator: 'scripts/scrape-institution-holdings.mjs',
    generated_at: new Date().toISOString(),
    quarter: institutions[0]?.latestQuarter ?? null,
    quarterLabel: institutions[0]?.latestQuarterLabel ?? null,
    institution_count: institutions.length,
    institutions,
  };

  // Never write an empty or truncated file over a good one — the same rule the calendar and
  // con-call scrapers follow. A failed scrape must leave yesterday's data in place.
  if (!institutions.length || institutions.some((i) => !i.holdings.length)) {
    throw new Error('refusing to write: a fund parsed to zero holdings');
  }

  await writeFile(OUT, `${JSON.stringify(payload, null, 1)}\n`);
  console.log(`\nwrote ${OUT}`);
  for (const i of institutions) {
    console.log(`  ${i.name}: ${i.stocksHeld} holdings, Rs ${i.portfolioValueCr.toLocaleString('en-IN')} Cr, ${i.filedThisQuarter} filed for ${i.latestQuarterLabel}, ${i.former.length} former`);
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});

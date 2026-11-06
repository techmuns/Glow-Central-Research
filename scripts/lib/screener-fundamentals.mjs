// scripts/lib/screener-fundamentals.mjs — a pure, dependency-free parser for a Screener.in company
// page. It reads the PUBLIC page (no login): the top ratios, the compounded-growth tables, the annual
// P&L (10 years of Sales / Operating profit / OPM / Net profit / EPS) and Screener's own pros & cons.
//
// Why Screener: it is the authoritative, multi-year source for Indian company fundamentals, and the
// standard financials and ratios are on the public page. We REPRODUCE its figures (the same rule the
// dashboard already follows for StockScans, Finology and Trendlyne) — never recompute them — and the
// one derived thing we add, a fair-value band, is computed separately in js/data/fair-value.js and is
// labelled ours.
//
// No npm dependency (CLAUDE.md hard rule 2): a tag scanner over the HTML, like filings-shared.js and
// xlsx-read.mjs. It must tolerate a missing section rather than throw — a field Screener does not show
// for a company stays null, never a guessed number.

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '');
const decode = (s) => String(s || '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#8377;|₹/g, '').replace(/&rs;/gi, '');
const clean = (s) => decode(stripTags(s)).replace(/\s+/g, ' ').trim();

/** The first number in a cell → a Number, or null. Tolerates units and symbols around it, so
 *  "₹ 2,98,464 Cr.", "22.8", "1.38 %", "+19%" all read cleanly; "", "-" and prose read null. */
function num(s) {
  const t = clean(s).replace(/,/g, '');
  const m = t.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** The "top ratios" list: Market Cap, Current Price, High / Low, Stock P/E, Book Value, Dividend
 *  Yield, ROCE, ROE, Face Value — whatever the company shows. Returned as a name→raw-value map. */
function topRatios(html) {
  const m = html.match(/<ul[^>]*id="top-ratios"[^>]*>([\s\S]*?)<\/ul>/i);
  const out = {};
  if (!m) return out;
  const items = m[1].match(/<li[\s\S]*?<\/li>/gi) || [];
  for (const li of items) {
    const name = clean((li.match(/<span class="name">([\s\S]*?)<\/span>/i) || [])[1]);
    // Anchor the value capture on </li>, so a value with nested spans (High / Low is
    // "₹ <span>12,470</span> / <span>8,605</span>") is taken whole rather than cut at the first </span>.
    const val = clean((li.match(/<span class="(?:nowrap )?value">([\s\S]*?)<\/span>\s*<\/li>/i) || [])[1]);
    if (name) out[name.toLowerCase()] = val;
  }
  return out;
}

/** A labelled compounded-growth table ("Compounded Sales Growth", …) → { y10, y5, y3, ttm/y1 }. */
function rangesTable(html, label) {
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?<table[^>]*class="[^"]*ranges-table[^"]*"[^>]*>([\\s\\S]*?)<\\/table>', 'i');
  const m = html.match(re);
  if (!m) return null;
  const out = {};
  for (const tr of m[1].match(/<tr>[\s\S]*?<\/tr>/gi) || []) {
    const tds = (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map((c) => clean(c.replace(/<\/?td[^>]*>/gi, '')));
    if (tds.length < 2) continue;
    const key = tds[0].toLowerCase();
    const v = num(tds[1]);
    if (/10\s*year/.test(key)) out.y10 = v;
    else if (/5\s*year/.test(key)) out.y5 = v;
    else if (/3\s*year/.test(key)) out.y3 = v;
    else if (/ttm/.test(key)) out.ttm = v;
    else if (/1\s*year|last\s*year/.test(key)) out.y1 = v;
  }
  return Object.keys(out).length ? out : null;
}

/** One row of the annual P&L, by its leading label → an array of Numbers (oldest → newest, incl TTM). */
function plRow(section, label) {
  const re = new RegExp('<tr[^>]*>\\s*<td[^>]*>\\s*(?:<button[^>]*>)?\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?<\\/tr>', 'i');
  const m = section.match(re);
  if (!m) return [];
  const tds = m[0].match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
  return tds.slice(1).map((c) => num(c.replace(/<\/?td[^>]*>/gi, '')));
}

/** The P&L column headers (Mar 2017 … Mar 2026, TTM). */
function plYears(section) {
  const head = (section.match(/<thead>([\s\S]*?)<\/thead>/i) || [])[1] || '';
  return (head.match(/<th[^>]*>([\s\S]*?)<\/th>/gi) || [])
    .map((c) => clean(c.replace(/<\/?th[^>]*>/gi, ''))).filter(Boolean);
}

function prosCons(html, which) {
  // The div carries a style attribute: <div class="pros" style="…">. Allow attributes after the class.
  const m = html.match(new RegExp('<div class="' + which + '"[^>]*>([\\s\\S]*?)<\\/div>', 'i'));
  if (!m) return [];
  return (m[1].match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || []).map((li) => clean(li.replace(/<\/?li[^>]*>/gi, ''))).filter(Boolean);
}

/**
 * Parse a Screener company page into a structured fundamentals record. `html` is the page source,
 * `symbol` the NSE symbol we fetched it for, `basis` 'consolidated' | 'standalone'. Returns null only
 * when the page isn't a company page at all (so the caller records a failure rather than writing junk).
 */
export function parseScreenerFundamentals(html, { symbol, basis = 'consolidated', url = '' } = {}) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  // The h1 holds a logo span, the company name text node, then edit/watch icons — none of the nested
  // elements carry text on Screener, so stripping tags yields the name cleanly.
  const name = h1 ? clean(h1[1]) : '';
  const r = topRatios(html);
  // A real company page always has the top-ratios list with a market cap. No market cap → not one.
  if (!name || !('market cap' in r)) return null;

  const section = (html.match(/<section[^>]*id="profit-loss"[\s\S]*?<\/section>/i) || [''])[0];
  const years = plYears(section);
  const eps = plRow(section, 'EPS in Rs');
  const annual = {
    years,
    sales: plRow(section, 'Sales'),
    operatingProfit: plRow(section, 'Operating Profit'),
    opm: plRow(section, 'OPM %'),
    netProfit: plRow(section, 'Net Profit'),
    eps,
  };

  const ratios = {
    marketCap: num(r['market cap']),        // ₹ crore
    price: num(r['current price']),
    pe: num(r['stock p/e']),
    bookValue: num(r['book value']),
    divYield: num(r['dividend yield']),      // %
    roce: num(r['roce']),                    // %
    roe: num(r['roe']),                      // %
    faceValue: num(r['face value']),
    debtToEquity: num(r['debt to equity']),  // usually absent on the public page → null
  };
  // High / Low comes as "₹ 12,470 / 9,009" in one value — split it.
  const hl = clean(r['high / low'] || '').split('/').map((x) => num(x));
  ratios.high = hl[0] ?? null;
  ratios.low = hl[1] ?? null;

  return {
    symbol: String(symbol || '').toUpperCase(),
    name,
    basis,
    sourceUrl: url,
    ratios,
    growth: {
      sales: rangesTable(section || html, 'Compounded Sales Growth'),
      profit: rangesTable(section || html, 'Compounded Profit Growth'),
      priceCagr: rangesTable(section || html, 'Stock Price CAGR'),
      roe: rangesTable(section || html, 'Return on Equity'),
    },
    annual,
    // TTM EPS is the last EPS column (the one Screener labels TTM); fall back to the newest annual.
    epsTtm: eps.length ? eps[eps.length - 1] : null,
    pros: prosCons(html, 'pros'),
    cons: prosCons(html, 'cons'),
    fetchedAt: new Date().toISOString(),
  };
}

export const _internal = { num, clean, topRatios, rangesTable, plRow };

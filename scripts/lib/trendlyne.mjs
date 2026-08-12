// scripts/lib/trendlyne.mjs — the Trendlyne superstar-portfolio client and normaliser.
//
// Pure and dependency-free: no Node APIs beyond the `fetch` that is passed in, so the parser can
// be unit-tested against a saved page without a network. Same shape as worker/mc.mjs, and for the
// same reason — one definition of what a row means.
//
//   const fund = await fetchSuperstarPortfolio({ id: 54015, slug: 'smallcap-world-fund-inc' });
//
// WHAT THIS SOURCE ACTUALLY IS
//   Indian listed companies file their shareholding pattern with the exchanges each quarter. Any
//   holder above 1% is named, with the number of shares and the percentage of the company held.
//   Trendlyne aggregates those filings the other way round — by holder — so one page lists every
//   company a given institution appears in. The QUANTITIES AND PERCENTAGES ARE THE FILINGS;
//   the rupee value is Trendlyne's own derivation (holding % × market cap), and is labelled as
//   theirs everywhere it surfaces. Same rule as the StockScans scores: reproduce, attribute,
//   never re-derive.
//
// THE PAGE IS SERVER-RENDERED, WHICH IS WHY THIS IS A PARSER AND NOT AN API CLIENT
//   The table is ~900KB of HTML inside a 1MB page, initialised client-side by DataTables from
//   rows that are already in the document (`JS_autoDataTables`). There is no JSON endpoint behind
//   it that an anonymous caller can reach — the autocomplete API answers subscribers only. So the
//   table is parsed out of the markup, and the parse is defensive about it: every field is
//   validated, and a page whose shape has changed throws rather than yielding plausible nonsense.
//
// A DASH IS NOT A ZERO, AND IT IS NOT AN EXIT
//   Trendlyne's own note: "The latest quarter tends to have missing data since not all companies
//   may have reported their shareholding data till now." So an empty percentage in the newest
//   column means the company has not filed yet, NOT that the holder sold. In the Jun 2026 pull,
//   J B Chemicals has a holding value and a share count but no percentage for that quarter —
//   which is exactly the case that would read as "exited" if a dash were flattened to zero.

export const TRENDLYNE_BASE = 'https://trendlyne.com';

// A browser UA. CloudFront in front of Trendlyne 403s the default one — including on robots.txt,
// which is why that file could not be read to check for a crawl policy. This fetches ONE page per
// fund per run, on demand, which is the politest thing a scraper can be.
const HEADERS = {
  accept: 'text/html,application/xhtml+xml',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
};

export const portfolioUrl = ({ id, slug }) => `${TRENDLYNE_BASE}/portfolio/superstar-shareholders/${id}/latest/${slug}/`;

/** Indian quarters are labelled by the month they end. "Jun 2026" is Q1 of FY 2026-27. */
export function quarterCode(label) {
  const m = /^([A-Za-z]{3})\s+(\d{4})$/.exec(String(label || '').trim());
  if (!m) return null;
  const q = { mar: 4, jun: 1, sep: 2, dec: 3 }[m[1].toLowerCase()];
  if (!q) return null;
  const year = Number(m[2]);
  // Apr-Mar financial year: Jun/Sep/Dec 2026 all sit in FY26-27; Mar 2026 closes FY25-26.
  const fyEnd = q === 4 ? year : year + 1;
  return `Q${q}FY${String(fyEnd).slice(2)}`;
}

const clean = (html) =>
  String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

/** "1,104.2 Cr" -> 1104.2. Anything else -> null; never 0, which would be a claim. */
export function parseCrore(s) {
  const m = /^([\d,]+(?:\.\d+)?)\s*Cr$/i.exec(String(s || '').trim());
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** "8,732,412" -> 8732412. */
export function parseQty(s) {
  const t = String(s || '').trim().replace(/,/g, '');
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** "2.5%" -> 2.5. A dash, a blank or a label like "Below 1% first time" -> null. */
export function parsePct(s) {
  const m = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(String(s || '').trim());
  return m ? Number(m[1]) : null;
}

/** The change column is a bare signed number, and carries a LABEL where no number applies. */
export function parseChange(s) {
  const t = String(s || '').trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return { pp: Number(t), note: null };
  if (!t || t === '-') return { pp: null, note: null };
  // Seen in the wild: "New", "Below 1% first time", "Filing Awaited". Each is a real statement
  // about the position that no number can carry — "Filing Awaited" in particular is the reason a
  // holding can have a value and a share count but no percentage for the quarter.
  return { pp: null, note: t };
}

/**
 * Slice the holdings table out of the page by BALANCING <table> tags.
 *
 * Cutting at the first `</table>` finds a nested one — each row has an expandable child table —
 * and yields three rows out of seventy-two, which looks like a successful parse. Ask how many
 * rows you got before trusting any of this.
 */
export function extractTable(html) {
  const start = html.indexOf('<table class="superstar-shareholding');
  if (start < 0) throw new Error('Trendlyne page has no superstar-shareholding table — the layout has changed');
  let depth = 0;
  const re = /<\/?table\b/g;
  re.lastIndex = start;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0] === '<table' ? 1 : -1;
    if (depth === 0) return html.slice(start, m.index + 8);
  }
  throw new Error('Trendlyne holdings table is not closed');
}

/**
 * Parse the holdings table into rows.
 *
 * Keyed on the per-row link to the company's own shareholding page, which is where the NSE ticker
 * comes from — the visible name is truncated and cannot be joined on. That link is also what
 * separates a main row from the child rows underneath it, which repeat the same figures shifted by
 * a column and would otherwise double every holding.
 */
export function parseHoldings(html) {
  const table = extractTable(html);
  const heads = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => clean(m[1]));
  // "Jun 2026 Holding %", "Mar 2026 %", … — the quarters this pull covers, newest first.
  const quarters = heads.slice(5, 14).map((h) => h.replace(/\s*Holding\s*%$/i, '').replace(/\s*%$/, '').trim());
  if (quarters.length < 2 || !quarterCode(quarters[0])) {
    throw new Error(`Trendlyne column headers are not quarters: ${JSON.stringify(heads.slice(0, 15))}`);
  }

  const body = table.slice(table.indexOf('<tbody'));
  const rows = [];
  for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const link = /href="https:\/\/trendlyne\.com\/equity\/share-holding\/(\d+)\/([A-Z0-9&.\-]+)\/latest\/([a-z0-9-]+)\/"/.exec(tr[1]);
    if (!link) continue;
    const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => clean(m[1]));
    // A main row leads with the empty expand cell; a child row starts straight at the name.
    if (tds.length < 14 || tds[0] !== '') continue;
    const change = parseChange(tds[4]);
    rows.push({
      ticker: link[2],
      slug: link[3],
      trendlyneId: Number(link[1]),
      name: tds[1],
      valueCr: parseCrore(tds[2]),
      qty: parseQty(tds[3]),
      changePp: change.pp,
      changeNote: change.note,
      // Filed percentage per quarter, newest first. null where the company has not filed.
      pctByQuarter: Object.fromEntries(quarters.map((q, i) => [quarterCode(q) || q, parsePct(tds[5 + i])])),
      url: `${TRENDLYNE_BASE}/equity/share-holding/${link[1]}/${link[2]}/latest/${link[3]}/`,
    });
  }
  if (!rows.length) throw new Error('Trendlyne holdings table parsed to zero rows');
  return { quarters: quarters.map((q) => quarterCode(q) || q), quarterLabels: quarters, rows };
}

/**
 * The headline numbers, read from the page's own prose so they can be checked against the sum of
 * the rows. They agreed to the rupee on the Jun 2026 pull (₹35,818.0 Cr over 37 holdings); a
 * disagreement means the parse dropped or double-counted something, which is worth failing on.
 */
export function parseSummary(html) {
  const text = clean(html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' '));
  const stocks = /publicly holds\s+(\d+)\s+stocks/i.exec(text);
  const worth = /net worth of over\s+Rs\.?\s*([\d,]+(?:\.\d+)?)\s*Cr/i.exec(text);
  // Anchored on the sentence that names the holder, not on the page title — the nav bar sits
  // above it in the flattened text and a lazy backtrack swallows "US CEO Salary Dashboard" too.
  const name = /(?:filed,\s*)([A-Za-z0-9 .,&'()-]{3,60}?)\s+publicly holds/i.exec(text);
  return {
    statedStocks: stocks ? Number(stocks[1]) : null,
    statedValueCr: worth ? Number(worth[1].replace(/,/g, '')) : null,
    name: name ? name[1].trim() : null,
  };
}

/**
 * Fetch and normalise one superstar's portfolio.
 *
 * The current portfolio is the set of rows carrying a HOLDING VALUE, not the set carrying a
 * percentage for the newest quarter — those differ by one on the Jun 2026 pull, because a company
 * can be held while its latest filing is still outstanding. Using the percentage would have
 * silently dropped J B Chemicals and left the total ₹502.7 Cr short of Trendlyne's own figure.
 */
export async function fetchSuperstarPortfolio({ id, slug, house = null, category = null }, fetchImpl = fetch) {
  const url = portfolioUrl({ id, slug });
  const res = await fetchImpl(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Trendlyne HTTP ${res.status} for ${slug}`);
  const html = await res.text();

  const { quarters, quarterLabels, rows } = parseHoldings(html);
  const summary = parseSummary(html);
  const held = rows.filter((r) => r.valueCr != null);
  const sumCr = Math.round(held.reduce((a, r) => a + r.valueCr, 0) * 10) / 10;

  return {
    trendlyneId: id,
    slug,
    name: summary.name || slug,
    house,
    category,
    sourceUrl: url,
    latestQuarter: quarters[0],
    latestQuarterLabel: quarterLabels[0],
    quarters,
    quarterLabels,
    stocksHeld: held.length,
    portfolioValueCr: sumCr,
    // Trendlyne's own stated totals, kept beside ours so the two can be compared rather than
    // trusted. `scrape-institution-holdings.mjs` fails the run when they disagree.
    stated: { stocks: summary.statedStocks, valueCr: summary.statedValueCr },
    holdings: held,
    // Companies on the page with history but no current position. Real information — it is the
    // difference between "never owned" and "sold out of" — so it travels, separately.
    former: rows.filter((r) => r.valueCr == null),
    fetchedAt: new Date().toISOString(),
  };
}

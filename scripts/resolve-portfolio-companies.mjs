#!/usr/bin/env node
// scripts/resolve-portfolio-companies.mjs — the family's direct-equity book, resolved to tickers.
//
//   node scripts/resolve-portfolio-companies.mjs            # write public/data/portfolio-companies.json
//   node scripts/resolve-portfolio-companies.mjs --dry      # report the match, write nothing
//
// WHY THIS EXISTS. The book arrives as company NAMES. Every scope filter in this dashboard —
// Earnings Hub, Con-call, Breakouts, Chatter, Institutions — narrows by NSE TICKER, because that
// is the only stable key the feeds share. So a name has to become a ticker before "Portfolio"
// means anything, and that resolution has to be inspectable rather than a pile of hand-typed
// symbols nobody can check.
//
// THE ONE RULE: A NAME THAT DOES NOT RESOLVE IS KEPT, NOT DROPPED.
//   Several lines are genuinely not NSE-listed equities — private holdings, warrant lines, and the
//   Vedanta demerger entities that had not listed as at the book date. Guessing a ticker for those
//   would put someone else's company under this family's name in every scoped view, which is far
//   worse than a gap. They are written out with `ticker: null` and a `reason`, and the UI shows
//   them as held-but-not-covered rather than pretending they are absent.
//
// MATCHING IS EXACT-ISH, NEVER FUZZY-BY-SCORE. Names are normalised (case, punctuation, the
// Ltd/Limited/India noise) and compared for equality, then for a contains-relationship that is
// unambiguous across the whole candidate set. A token-overlap score would silently map "Vedanta
// Power" onto "Vedanta Ltd"; anything with more than one candidate is reported for a human to
// settle rather than resolved by a tie-break.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const NET = process.argv.includes('--net');
const OUT = join(ROOT, 'public/data/portfolio-companies.json');

// ---------------------------------------------------------------------------------------
// The book, as supplied: 142 direct-equity lines as at 30 Jun 2026. Value and weight are
// deliberately NOT carried — they were explicitly out of scope, and a stale rupee figure beside a
// live price is exactly the kind of number this dashboard refuses to show.
// ---------------------------------------------------------------------------------------
const BOOK = [
  ['IIFL Finance', 'Financials'],
  ['HFCL Limited', 'Communication Services'],
  ['Jayaswal Neco Industries', 'Materials'],
  ['Sky Gold Limited', 'Consumer Discretionary'],
  ['Tata Capital Ltd', 'Financials'],
  ['LT Foods Limited', 'Consumer Staples'],
  ['Aditya Birla Capital', 'Financials'],
  ['Jubilant Pharmova', 'Healthcare'],
  ['Oracle Financial Services Software', 'Information Technology'],
  ['Turtlemint Fintech Solutions', 'Financials'],
  ['PNB Housing Fin', 'Financials'],
  ['Biocon Ltd', 'Healthcare'],
  ['Edelweiss Financial Services', 'Financials'],
  ['OnEMI Technology Solutions', 'Financials'],
  ['Concord Control Systems', 'Industrials'],
  ['Man Industries (India)', 'Industrials'],
  ['Motilal Oswal Financial Services', 'Financials'],
  ['Park Medi World', 'Healthcare'],
  ['Standard Engineering Technology', 'Industrials'],
  ['Vedanta Aluminium Metal', 'Materials'],
  ['Prestige Estate Projects', 'Real Estate'],
  ['Sansera Engineering', 'Consumer Discretionary'],
  ['Hindustan Zinc', 'Materials'],
  ['Sudarshan Chemical Industries', 'Materials'],
  ['Emmvee Photovoltaic Power', 'Industrials'],
  ['Kopran Limited', 'Healthcare'],
  ['Siemens Energy India', 'Industrials'],
  ['Canara Bank', 'Financials'],
  ['Interarch Building Products', 'Industrials'],
  ['Coforge Limited', 'Information Technology'],
  ['Garware Hi-Tech Film', 'Materials'],
  ['Ashika Credit Capital', 'Financials'],
  ['Shriram Pistons & Rings', 'Consumer Discretionary'],
  ['PB Fintech Limited', 'Financials'],
  ['GOCL Corporation', 'Materials'],
  ['Vedanta Limited', 'Materials'],
  ['Waaree Energies', 'Industrials'],
  ['Titagarh Rail Systems', 'Industrials'],
  ['Pine Labs Limited', 'Financials'],
  ['ISGEC Heavy Engineering', 'Industrials'],
  ['Shilchar Technologies', 'Industrials'],
  ['J&K Bank', 'Financials'],
  ['Aditya Vision Limited', 'Consumer Discretionary'],
  ['Nilkamal', 'Consumer Discretionary'],
  ['Jana Small Finance Bank', 'Financials'],
  ['Eternal', 'Consumer Discretionary'],
  ['Shalby Limited', 'Healthcare'],
  ['Mahindra & Mahindra', 'Consumer Discretionary'],
  ['Indo Farm Equipment', 'Industrials'],
  ['Angel One Limited', 'Financials'],
  ['Bengal and Assam Company', 'Financials'],
  ['Sammaan Capital', 'Financials'],
  ['Supriya Lifescience', 'Healthcare'],
  ['Alpex Solar', 'Industrials'],
  ['Embassy Developments', 'Real Estate'],
  ['Gujarat Ambuja Exports', 'Consumer Staples'],
  ['Adani Enterprises', 'Industrials'],
  ['Stylam Industries', 'Materials'],
  ['Vishal Mega Mart', 'Consumer Discretionary'],
  ['Central Depository Services', 'Financials'],
  ['Kotak Mahindra Bank', 'Financials'],
  ['Kross Limited', 'Consumer Discretionary'],
  ['Sejal Glass Limited', 'Materials'],
  ['Carysil Limited', 'Consumer Discretionary'],
  ['Kaynes Technology India', 'Information Technology'],
  ['Wockhardt', 'Healthcare'],
  ['Shree Cements', 'Materials'],
  ['Ramkrishna Forgings', 'Consumer Discretionary'],
  ['Oswal Pumps Limited', 'Industrials'],
  ['Persistent Systems', 'Information Technology'],
  ['Valor Estate Limited', 'Real Estate'],
  ['Advait Energy Transitions', 'Industrials'],
  ['Shipping Corporation of India', 'Industrials'],
  ['HDFC Bank', 'Financials'],
  ['Finbud Financial Services', 'Financials'],
  ['Voltamp Transformers', 'Industrials'],
  ['JSW Steel', 'Materials'],
  ['RBL Bank', 'Financials'],
  ['Jay Bee Laminations', 'Industrials'],
  ['Happy Forgings', 'Consumer Discretionary'],
  ['Indian Hotels Company', 'Consumer Discretionary'],
  ['Meghmani Organics', 'Materials'],
  ['Vedanta Power Limited', 'Energy'],
  ['Jio Financial Services', 'Financials'],
  ['Vedanta Iron and Steel', 'Materials'],
  ['Vedanta Oil and Gas', 'Energy'],
  ['Praxis Home Retails', 'Consumer Discretionary'],
  ['Sanjivani Paranteral', 'Healthcare'],
  ['Dalmia Bharat', 'Materials'],
  ['Coal India', 'Energy'],
  ['JSW Energy', 'Energy'],
  ['Eveready', 'Consumer Discretionary'],
  ['Restaurant Brands Asia', 'Consumer Discretionary'],
  ['Narayana Hrudayalaya', 'Healthcare'],
  ['Vintage Coffee and Beverages', 'Consumer Staples'],
  ['Samhi Hotels Limited', 'Consumer Discretionary'],
  ['Glittke Granites', 'Materials'],
  ['Harsha', 'Industrials'],
  ['Axiscades Technologies', 'Information Technology'],
  ['ITC Ltd', 'Consumer Staples'],
  ['Protean eGov Technologies', 'Information Technology'],
  ['Fabtech Technologies', 'Healthcare'],
  ['Rashtriya Chemicals', 'Materials'],
  ['Vikram Kamats Hospitality — warrants', 'Consumer Discretionary'],
  ['Alpex Solar — warrants', 'Industrials'],
  ['Virtuoso Optoelectronics', 'Industrials'],
  ['Urban Company', 'Consumer Discretionary'],
  ['Techno Electric & Engineering', 'Industrials'],
  ['Azad Engineering', 'Industrials'],
  ['Jay Bharat Maruti', 'Unclassified'],
  ['AvenuesAI Ltd', 'Unclassified'],
  ['Eureka Forbes', 'Unclassified'],
  ['Sahana Systems', 'Unclassified'],
  ['Ceinsys Tech', 'Unclassified'],
  ['Pace Digitek', 'Unclassified'],
  ['Allcargo Global', 'Unclassified'],
  ['Allcargo Logistics', 'Unclassified'],
  ['Macpower CNC Machines', 'Unclassified'],
  ['Tata Technologies', 'Unclassified'],
  ['Raymond Realty', 'Unclassified'],
  ['Sanstar Ltd', 'Unclassified'],
  ['RPSG Ventures', 'Unclassified'],
  ['Praveg Limited', 'Unclassified'],
  ['Swan Corp', 'Unclassified'],
  ['Polyplex Corporation', 'Unclassified'],
  ['Future Consumer', 'Unclassified'],
  ['Vikram Kamats Hospitality', 'Unclassified'],
  ['String Metaverse', 'Unclassified'],
  ['Thomas Cook (India)', 'Unclassified'],
  ['Alankit Limited', 'Unclassified'],
  ['Tejas Networks', 'Unclassified'],
  ['Bafna Pharmaceuticals', 'Unclassified'],
  ['Ellenbarrie Industrial Gases', 'Unclassified'],
  ['Nisus Finance Services', 'Unclassified'],
  ['Insolation Energy', 'Unclassified'],
  ['Transformers and Rectifiers India', 'Unclassified'],
  ['Billionbrains Garage Ventures', 'Unclassified'],
  ['Rain Industries', 'Unclassified'],
  ['Unimech Aerospace', 'Unclassified'],
  ['Crizac Ltd', 'Unclassified'],
  ['Future Supply Chain Solutions', 'Unclassified'],
  ['Mangalore Petrochemicals and Refinery', 'Unclassified'],
];

/**
 * Lines that are NOT an NSE-listed equity, and why.
 *
 * Stated here rather than left to fail matching silently, because "no ticker" and "we could not
 * find the ticker" are different facts and only one of them is a gap in this script. Each of these
 * is a real position in the book; none of them can appear in a feed keyed by NSE symbol.
 */
const NOT_LISTED_EQUITY = {
  'Turtlemint Fintech Solutions': 'unlisted — private company, held directly',
  'OnEMI Technology Solutions': 'unlisted — private company, held directly',
  'Standard Engineering Technology': 'unlisted — private company, held directly',
  'Finbud Financial Services': 'unlisted — private company, held directly',
  'AvenuesAI Ltd': 'unlisted — private company, held directly',
  'Vedanta Aluminium Metal': 'demerged entity — not listed as at the book date',
  'Vedanta Power Limited': 'demerged entity — not listed as at the book date',
  'Vedanta Iron and Steel': 'demerged entity — not listed as at the book date',
  'Vedanta Oil and Gas': 'demerged entity — not listed as at the book date',
  'Vikram Kamats Hospitality — warrants': 'warrants, not the equity line',
  'Alpex Solar — warrants': 'warrants, not the equity line',
};

/**
 * Names the automatic passes cannot place, resolved by hand and then CHECKED.
 *
 * Every symbol here was confirmed by asking Yahoo for it and reading back the company name in the
 * comment — not typed from memory. Where the two disagree the comment says so, because a rename is
 * a thing a future reader needs: `SHRIPISTON` is right, but the company is now called SPR Auto
 * Technologies and searching for "Shriram Pistons" finds nothing.
 *
 * The automatic passes reject these on purpose. Their guard is name agreement, and "Oracle
 * Financial Services Software" simply does not prefix-match "ORACLE FIN SERV SOFT LTD." — which is
 * the guard working, not failing. Loosening it to catch these would also let it catch
 * `ASHIKAG` (Ashika Global Securities) for `Ashika Credit Capital`, which is a different company.
 */
const CONFIRMED = {
  'Oracle Financial Services Software': ['OFSS', 'ORACLE FIN SERV SOFT LTD.'],
  'GOCL Corporation': ['GOCLCORP', 'GOCL CORPORATION LIMITED'],
  'Bengal and Assam Company': ['BENGALASM', 'BENGAL & ASSAM CO. LTD.'],
  'Sahana Systems': ['SAHANA-SM', 'SAHANA SYSTEM LIMITED'],
  'Sanstar Ltd': ['SANSTAR', 'SANSTAR LIMITED'],
  'Swan Corp': ['SWANCORP', 'SWAN CORP LIMITED'],
  // Renamed: the ticker survives, the name does not. Both feeds on disk already carry the new one.
  'Shriram Pistons & Rings': ['SHRIPISTON', 'SPR AUTO TECHNOLOGIES LTD (renamed from Shriram Pistons & Rings)'],
  // The book transposes the words; the company is Mangalore Refinery & Petrochemicals.
  'Mangalore Petrochemicals and Refinery': ['MRPL', 'MANGALORE REFINERY & PETROCHEMICALS'],
  // Two separate listed companies that a prefix match collapses onto one symbol — see the
  // collision guard below, which is what caught it.
  'Allcargo Global': ['AGL', 'ALLCARGO GLOBAL LIMITED'],
  'Allcargo Logistics': ['ALLCARGO', 'ALLCARGO LOGISTICS LTD'],
};

/**
 * Held, listed, but NOT on the NSE — so no NSE-keyed feed in this dashboard can carry them.
 *
 * This is a real coverage gap and it is recorded rather than hidden. The BSE symbol is kept so the
 * line is identifiable and so a future BSE feed has something to join on.
 */
const BSE_ONLY = {
  'Concord Control Systems': 'CNCRD',
  'Ashika Credit Capital': null, // BSE-listed; ASHIKAG on the NSE is Ashika GLOBAL Securities, a different company
  'Glittke Granites': 'GLITTEKG', // spelled "Glittek" by the exchange
  'Vikram Kamats Hospitality': 'KAMATS',
  'Sanjivani Paranteral': 'SANJIVIN', // BSE: SANJIVANI PARANTERAL LTD.
};

/**
 * Held, but findable on neither exchange through any source available here.
 *
 * Not the same as "unlisted": these have been listed. Two are companies that went through
 * insolvency and were delisted; the others are small enough that no source on hand carries them.
 * Recorded as an open question rather than quietly resolved to something that looked close.
 */
const NOT_FOUND = {
  'String Metaverse': 'no symbol found on either exchange — check the current name',
  'Nisus Finance Services': 'no symbol found on either exchange — an SME line, check the current name',
  'Future Supply Chain Solutions': 'no symbol found on either exchange — delisted after insolvency',
};

// ---------------------------------------------------------------------------------------
// Normalisation and matching
// ---------------------------------------------------------------------------------------

/** Strip the noise that differs between a holdings statement and an exchange's own name. */
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(limited|ltd|the|company|co|corporation|corp|inc|plc)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * …and a space-free form, for the prefix pass.
 *
 * Moneycontrol truncates its display names to about fifteen characters — "Sudarshan Chem",
 * "Interarch Build", "Jay BharatMarut" — so an equality test misses most of the book and a
 * word-boundary test misses any name cut mid-word. Comparing without spaces handles both, and
 * "Jay BharatMarut" then correctly prefixes "Jay Bharat Maruti".
 */
const squash = (s) => norm(s).replace(/ /g, '');

function loadCandidates() {
  const out = new Map(); // normalised name -> { ticker, name, source }
  const add = (name, ticker, source) => {
    const t = String(ticker || '').trim().toUpperCase();
    const n = norm(name);
    if (!t || !n) return;
    if (!out.has(n)) out.set(n, { ticker: t, name: String(name).trim(), source });
  };

  // Order matters: `add` keeps the FIRST name it sees for a key, so the source with the fullest
  // names goes in first. StockScans print a company's whole name; Moneycontrol truncate to ~15
  // characters, which is why the prefix pass below exists at all.
  try {
    const cs = JSON.parse(readFileSync(join(ROOT, 'public/data/concall-scans.json'), 'utf8'));
    for (const r of cs.rows || []) add(r.name, r.ticker, 'stockscans');
  } catch {
    /* optional */
  }

  const mc = JSON.parse(readFileSync(join(ROOT, 'public/data/mc-ticker-map.json'), 'utf8'));
  for (const e of Object.values(mc.map || {})) add(e.fullName, e.ticker, 'moneycontrol');

  const uni = JSON.parse(readFileSync(join(ROOT, 'public/data/universe.json'), 'utf8'));
  for (const row of Array.isArray(uni) ? uni : Object.values(uni)) {
    const url = row?.['Screener URL'] || '';
    const m = /company\/([A-Z0-9&.\-]+)\//i.exec(url);
    if (m) add(row.Company, m[1], 'screener');
  }

  return out;
}

function resolve(name, candidates) {
  const exact = candidates.get(norm(name));
  if (exact) return { ...exact, how: 'exact' };

  // Prefix, in either direction, on the space-free form. A truncated source name prefixes the
  // book's fuller one; occasionally the book is the terser of the two. Eight characters is the
  // floor — below that a prefix is not evidence of anything ("Jay ", "Man ").
  const b = squash(name);
  const hits = [];
  for (const [key, v] of candidates) {
    const k = squash(key);
    if (k.length < 8 || b.length < 8) continue;
    if (b.startsWith(k) || k.startsWith(b)) hits.push(v);
  }
  const uniq = [...new Map(hits.map((h) => [h.ticker, h])).values()];
  if (uniq.length === 1) return { ...uniq[0], how: 'prefix' };
  if (uniq.length > 1) return { ambiguous: uniq.slice(0, 4).map((u) => `${u.ticker} (${u.name})`) };
  return null;
}

// ---------------------------------------------------------------------------------------

/**
 * Last resort: ask Yahoo for the NSE symbol, and only believe it if the name agrees.
 *
 * Roughly thirty lines of this book are small caps that appear in none of the three files on
 * disk. The alternative to a lookup is typing symbols from memory, which is a claim nobody can
 * check and exactly the kind of thing that puts the wrong company under a portfolio filter.
 *
 * Yahoo's search is fuzzy — it will happily return something for a name it does not have — so a
 * result is accepted only when the returned company name normalises to a prefix of the book's, or
 * the book's to a prefix of it. `--net` gates the whole pass, so the script still runs offline and
 * a run without the network simply resolves fewer names rather than resolving them wrongly.
 */
async function yahooLookup(name) {
  const q = encodeURIComponent(name.replace(/\s*—\s*warrants$/i, ''));
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${q}&quotesCount=8&newsCount=0`;
  let body;
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    body = await res.json();
  } catch {
    return null;
  }
  const b = squash(name);
  for (const qt of body?.quotes || []) {
    if (!/\.NS$/.test(qt.symbol || '')) continue; // NSE only — the feeds here are NSE-keyed
    const yn = squash(qt.shortname || qt.longname || '');
    if (!yn || yn.length < 6) continue;
    if (b.startsWith(yn) || yn.startsWith(b)) {
      return { ticker: qt.symbol.replace(/\.NS$/, '').toUpperCase(), name: qt.shortname || qt.longname, source: 'yahoo-search' };
    }
  }
  return null;
}

const candidates = loadCandidates();
const holdings = [];
const unresolved = [];
const ambiguous = [];

for (const [name, sector] of BOOK) {
  const notListed = NOT_LISTED_EQUITY[name];
  if (notListed) {
    holdings.push({ name, ticker: null, sector, listed: false, reason: notListed });
    continue;
  }
  const confirmed = CONFIRMED[name];
  if (confirmed) {
    holdings.push({ name, ticker: confirmed[0], sector, listed: true, matchedName: confirmed[1], matchedBy: 'confirmed:yahoo' });
    continue;
  }
  if (name in NOT_FOUND) {
    holdings.push({ name, ticker: null, sector, listed: true, reason: NOT_FOUND[name] });
    continue;
  }
  if (name in BSE_ONLY) {
    holdings.push({
      name,
      ticker: null,
      sector,
      listed: true,
      exchange: 'BSE',
      bseSymbol: BSE_ONLY[name],
      reason: 'listed on the BSE only — every feed wired here is keyed by NSE symbol',
    });
    continue;
  }
  const hit = resolve(name, candidates);
  if (hit?.ticker) {
    holdings.push({ name, ticker: hit.ticker, sector, listed: true, matchedName: hit.name, matchedBy: `${hit.how}:${hit.source}` });
  } else if (hit?.ambiguous) {
    ambiguous.push({ name, options: hit.ambiguous });
    holdings.push({ name, ticker: null, sector, listed: true, reason: `ambiguous — ${hit.ambiguous.join(' / ')}` });
  } else {
    unresolved.push({ name, sector, index: holdings.length });
    holdings.push({ name, ticker: null, sector, listed: true, reason: 'no NSE symbol found in the data on disk' });
  }
}

// The network pass, over whatever the offline sources could not place.
if (NET && unresolved.length) {
  console.log(`\nasking Yahoo for ${unresolved.length} unresolved names…`);
  for (const u of unresolved.slice()) {
    const hit = await yahooLookup(u.name);
    if (!hit) continue;
    holdings[u.index] = { name: u.name, ticker: hit.ticker, sector: u.sector, listed: true, matchedName: hit.name, matchedBy: 'yahoo-search' };
    unresolved.splice(unresolved.indexOf(u), 1);
    console.log(`  ${u.name.padEnd(38)} -> ${hit.ticker}  (${hit.name})`);
    await new Promise((r) => setTimeout(r, 350)); // be polite; this is somebody else's search box
  }
}

// COLLISION GUARD — two book lines must never resolve to one symbol.
//
// The per-name check rejects one name matching several candidates. It cannot see the mirror case:
// several names matching the SAME candidate, which is how "Allcargo Global" and "Allcargo
// Logistics" — two separately listed companies — both became ALLCARGO. Silently, and in a way that
// would have shown one company's results under the other's name in every scoped view.
//
// Anything that collides is demoted back to unresolved and reported. A name in CONFIRMED is exempt
// only because a human has already looked at it.
const byTicker = new Map();
for (const h of holdings) {
  if (!h.ticker || h.matchedBy === 'confirmed:yahoo') continue;
  if (!byTicker.has(h.ticker)) byTicker.set(h.ticker, []);
  byTicker.get(h.ticker).push(h);
}
const collisions = [...byTicker.entries()].filter(([, list]) => list.length > 1);
for (const [ticker, list] of collisions) {
  for (const h of list) {
    h.ticker = null;
    h.reason = `collision — this and ${list.length - 1} other book line(s) both resolved to ${ticker}; needs a human`;
    delete h.matchedName;
    delete h.matchedBy;
  }
}

const resolved = holdings.filter((h) => h.ticker).length;
const unlisted = holdings.filter((h) => h.listed === false).length;
const bseOnly = holdings.filter((h) => h.exchange === 'BSE').length;

console.log(`book lines           ${BOOK.length}`);
console.log(`resolved to a ticker ${resolved}`);
console.log(`not listed equity    ${unlisted}`);
console.log(`BSE-only (no NSE)    ${bseOnly}`);
console.log(`ambiguous            ${ambiguous.length}`);
console.log(`collisions           ${collisions.length}`);
for (const [t, list] of collisions) console.log(`  ${t} <- ${list.map((h) => h.name).join(' + ')}`);
console.log(`unresolved           ${unresolved.length}`);
if (ambiguous.length) {
  console.log('\nAMBIGUOUS — needs a human:');
  for (const a of ambiguous) console.log(`  ${a.name}  ->  ${a.options.join(' | ')}`);
}
if (unresolved.length) {
  console.log('\nUNRESOLVED:');
  for (const u of unresolved) console.log(`  ${u.name}`);
}

if (DRY) {
  console.log('\n--dry: nothing written.');
  process.exit(0);
}

const payload = {
  _provenance:
    'The family office\'s direct-equity book as at 30 Jun 2026, supplied as company names and resolved to NSE symbols by scripts/resolve-portfolio-companies.mjs. ' +
    'This is the COVERAGE list that the Portfolio scope filters every research tab by — it is not a ledger: no quantity, no cost, no value. ' +
    'public/data/portfolio.json remains the Portfolio Analytics ledger and is a different thing. ' +
    'A line with ticker: null is still a real holding; it either is not an NSE-listed equity or could not be resolved, and the UI shows it as held-but-not-covered rather than dropping it.',
  asOf: '2026-06-30',
  source: 'family office direct-equity statement',
  count: holdings.length,
  resolved,
  unlisted,
  bseOnly,
  unresolved: holdings.filter((h) => h.listed !== false && h.exchange !== 'BSE' && !h.ticker).length,
  holdings,
};
writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`\nwrote ${OUT}`);

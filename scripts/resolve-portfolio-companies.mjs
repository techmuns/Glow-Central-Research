#!/usr/bin/env node
// scripts/resolve-portfolio-companies.mjs — the family's direct-equity book, resolved to tickers.
//
//   node scripts/resolve-portfolio-companies.mjs            # write public/data/portfolio-companies.json
//   node scripts/resolve-portfolio-companies.mjs --dry      # report the match, write nothing
//   node scripts/resolve-portfolio-companies.mjs --net      # let Yahoo's search place the leftovers
//
// THE BOOK COMES FROM scripts/fixtures/family-book.json, WHICH scripts/sync-family-book.mjs WRITES
// FROM THE FAMILY OFFICE'S OWN REPOSITORY (techmuns/Sattva-Family). It used to be a list of names
// typed in here from a statement; that was a second copy of a book that lives somewhere else, and a
// second copy can only drift. Now one line here is one ISIN there, and this script's job is purely
// the second half: turning each ISIN's company into an NSE ticker.
//
// WHY THIS EXISTS. Every scope filter in this dashboard — Earnings Hub, Con-call, Breakouts, Chatter,
// Institutions — narrows by NSE TICKER, because that is the only stable key the feeds share. So a
// company has to become a ticker before "Portfolio" means anything, and that resolution has to be
// inspectable rather than a pile of hand-typed symbols nobody can check.
//
// THE ONE RULE: A LINE THAT DOES NOT RESOLVE IS KEPT, NOT DROPPED.
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
//
// IDENTITY IS THE ISIN. Every hand-checked table below is keyed by it, never by a name: the
// custodian's names are upper-cased, cut at twenty characters and spelt differently across the
// family's seventeen entities, and a table keyed on one spelling would silently detach the day
// their file carried another. The name beside each entry is a comment for the reader.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const NET = process.argv.includes('--net');
const FIXTURE = join(ROOT, 'scripts/fixtures/family-book.json');
const OUT = join(ROOT, 'public/data/portfolio-companies.json');

if (!existsSync(FIXTURE)) {
  console.error(`${FIXTURE} is missing — run scripts/sync-family-book.mjs first; it reads the book from the family repository and writes that file.`);
  process.exit(1);
}
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const BOOK = Array.isArray(fixture.lines) ? fixture.lines : [];
if (!BOOK.length || BOOK.some((l) => !/^INE[A-Z0-9]{9}$/.test(l.isin || '') || !l.name)) {
  console.error('the fixture is not a list of { isin, name, sector } lines with equity ISINs — refusing to resolve it');
  process.exit(1);
}

// ---------------------------------------------------------------------------------------
// What each line is CALLED on screen.
//
// The custodian's wording is what the family file carries — "JUBILANT PHARMOVA LT", "SHRIRAM PIST.
// & RING", "RPSG VENTURES LIMITE" — and it is kept on every holding as `bookName`, because it is the
// source's own word for the line. It is not what a reader should have to recognise a company by, so
// each known ISIN carries the display name the dashboard has always used. A NEW ISIN that is not
// here yet is shown under the name the feed it resolved on prints for it, or failing that under the
// custodian's own wording, title-cased — never dropped, never guessed. Add its line here when it
// appears in the sync's "added" report.
// ---------------------------------------------------------------------------------------
const DISPLAY_NAMES = {
  INE423A01024: 'Adani Enterprises',
  INE674K01013: 'Aditya Birla Capital',
  INE679V01027: 'Aditya Vision Limited',
  INE0ALI01010: 'Advait Energy Transitions',
  INE914E01040: 'Alankit Limited',
  INE1YPB01014: 'Allcargo Global',
  INE418H01029: 'Allcargo Logistics',
  INE0R4701017: 'Alpex Solar',
  INE0R4713012: 'Alpex Solar — warrants',
  INE732I01021: 'Angel One Limited',
  INE094B01013: 'Ashika Credit Capital',
  INE483S01020: 'AvenuesAI Ltd',
  INE555B01013: 'Axiscades Technologies',
  INE02IJ01035: 'Azad Engineering',
  INE878I01022: 'Bafna Pharmaceuticals',
  INE083K01017: 'Bengal and Assam Company',
  INE0HOQ01053: 'Billionbrains Garage Ventures',
  INE376G01013: 'Biocon Ltd',
  INE476A01022: 'Canara Bank',
  INE482D01024: 'Carysil Limited',
  INE016Q01014: 'Ceinsys Tech',
  INE736A01011: 'Central Depository Services',
  INE522F01014: 'Coal India',
  INE591G01025: 'Coforge Limited',
  INE0N0J01014: 'Concord Control Systems',
  INE0S4R01014: 'Crizac Ltd',
  INE00R701025: 'Dalmia Bharat',
  INE532F01054: 'Edelweiss Financial Services',
  INE236E01022: 'Ellenbarrie Industrial Gases',
  INE069I01010: 'Embassy Developments',
  INE1C6T01020: 'Emmvee Photovoltaic Power',
  INE758T01015: 'Eternal',
  INE0KCE01017: 'Eureka Forbes',
  INE128A01029: 'Eveready',
  INE0HF201011: 'Fabtech Technologies',
  INE0EDU01014: 'Finbud Financial Services',
  INE220J01025: 'Future Consumer',
  INE935Q01015: 'Future Supply Chain Solutions',
  INE291A01017: 'Garware Hi-Tech Film',
  INE741B01027: 'Glittke Granites',
  INE077F01035: 'GOCL Corporation',
  INE036B01030: 'Gujarat Ambuja Exports',
  INE330T01021: 'Happy Forgings',
  INE0JUS01029: 'Harsha',
  INE040A01034: 'HDFC Bank',
  INE548A01028: 'HFCL Limited',
  INE267A01025: 'Hindustan Zinc',
  INE530B01024: 'IIFL Finance',
  INE053A01029: 'Indian Hotels Company',
  INE622H01018: 'Indo Farm Equipment',
  INE0LGX01024: 'Insolation Energy',
  INE00M901018: 'Interarch Building Products',
  INE858B01029: 'ISGEC Heavy Engineering',
  INE154A01025: 'ITC Ltd',
  INE168A01041: 'J&K Bank',
  INE953L01027: 'Jana Small Finance Bank',
  INE0SMY01017: 'Jay Bee Laminations',
  INE571B01036: 'Jay Bharat Maruti',
  INE854B01010: 'Jayaswal Neco Industries',
  INE758E01017: 'Jio Financial Services',
  INE121E01018: 'JSW Energy',
  INE019A01038: 'JSW Steel',
  INE700A01033: 'Jubilant Pharmova',
  INE918Z01012: 'Kaynes Technology India',
  INE082A01010: 'Kopran Limited',
  INE237A01036: 'Kotak Mahindra Bank',
  INE0O6601022: 'Kross Limited',
  INE818H01020: 'LT Foods Limited',
  INE155Z01011: 'Macpower CNC Machines',
  INE101A01026: 'Mahindra & Mahindra',
  INE993A01026: 'Man Industries (India)',
  INE103A01014: 'Mangalore Petrochemicals and Refinery',
  INE0CT101020: 'Meghmani Organics',
  INE338I01027: 'Motilal Oswal Financial Services',
  INE410P01011: 'Narayana Hrudayalaya',
  INE310A01015: 'Nilkamal',
  INE0DQN01013: 'Nisus Finance Services',
  INE12F801023: 'OnEMI Technology Solutions',
  INE881D01027: 'Oracle Financial Services Software',
  INE0BYP01024: 'Oswal Pumps Limited',
  INE0S3G01027: 'Pace Digitek',
  INE119201023: 'Park Medi World',
  INE417T01026: 'PB Fintech Limited',
  INE262H01021: 'Persistent Systems',
  INE15B701018: 'Pine Labs Limited',
  INE572E01012: 'PNB Housing Fin',
  INE633B01018: 'Polyplex Corporation',
  INE722B01019: 'Praveg Limited',
  INE546Y01022: 'Praxis Home Retails',
  INE811K01011: 'Prestige Estate Projects',
  INE004A01022: 'Protean eGov Technologies',
  INE855B01025: 'Rain Industries',
  INE399G01023: 'Ramkrishna Forgings',
  INE027A01015: 'Rashtriya Chemicals',
  INE1SY401010: 'Raymond Realty',
  INE976G01028: 'RBL Bank',
  INE07T201019: 'Restaurant Brands Asia',
  INE425Y01011: 'RPSG Ventures',
  INE0LEX01011: 'Sahana Systems',
  INE08U801020: 'Samhi Hotels Limited',
  INE148I01020: 'Sammaan Capital',
  INE860D01013: 'Sanjivani Paranteral',
  INE953O01021: 'Sansera Engineering',
  INE08NE01025: 'Sanstar Ltd',
  INE955I01044: 'Sejal Glass Limited',
  INE597J01018: 'Shalby Limited',
  INE024F01011: 'Shilchar Technologies',
  INE109A01011: 'Shipping Corporation of India',
  INE070A01015: 'Shree Cements',
  INE526E01018: 'Shriram Pistons & Rings',
  INE1NPP01017: 'Siemens Energy India',
  INE01IU01018: 'Sky Gold Limited',
  INE0M4D01010: 'Standard Engineering Technology',
  INE958L01034: 'String Metaverse',
  INE239C01020: 'Stylam Industries',
  INE659A01023: 'Sudarshan Chemical Industries',
  INE07RO01027: 'Supriya Lifescience',
  INE665A01038: 'Swan Corp',
  INE976I01016: 'Tata Capital Ltd',
  INE142M01025: 'Tata Technologies',
  INE285K01026: 'Techno Electric & Engineering',
  INE010J01012: 'Tejas Networks',
  INE332A01027: 'Thomas Cook (India)',
  INE615H01020: 'Titagarh Rail Systems',
  INE763I01026: 'Transformers and Rectifiers India',
  INE0OC301013: 'Turtlemint Fintech Solutions',
  INE0U3I01011: 'Unimech Aerospace',
  INE0CAZ01013: 'Urban Company',
  INE879I01012: 'Valor Estate Limited',
  INE1CDF01017: 'Vedanta Aluminium Metal',
  INE1CLE01013: 'Vedanta Iron and Steel',
  INE205A01025: 'Vedanta Limited',
  INE704J01044: 'Vedanta Oil and Gas',
  INE694L01019: 'Vedanta Power Limited',
  INE564S01019: 'Vikram Kamats Hospitality',
  INE564S13022: 'Vikram Kamats Hospitality — warrants',
  INE498Q01014: 'Vintage Coffee and Beverages',
  INE0I0T01010: 'Virtuoso Optoelectronics',
  INE01EA01019: 'Vishal Mega Mart',
  INE540H01012: 'Voltamp Transformers',
  INE377N01017: 'Waaree Energies',
  INE049B01025: 'Wockhardt',
};

/**
 * Lines that are NOT an NSE-listed equity, and why.
 *
 * Stated here rather than left to fail matching silently, because "no ticker" and "we could not
 * find the ticker" are different facts and only one of them is a gap in this script. Each of these
 * is a real position in the book; none of them can appear in a feed keyed by NSE symbol.
 */
const NOT_LISTED_EQUITY = {
  INE0OC301013: 'unlisted — private company, held directly', // Turtlemint Fintech Solutions
  INE12F801023: 'unlisted — private company, held directly', // OnEMI Technology Solutions
  INE0M4D01010: 'unlisted — private company, held directly', // Standard Engineering Technology
  INE0EDU01014: 'unlisted — private company, held directly', // Finbud Financial Services
  INE483S01020: 'unlisted — private company, held directly', // AvenuesAI Ltd
  INE1CDF01017: 'demerged entity — not listed as at the book date', // Vedanta Aluminium Metal
  INE694L01019: 'demerged entity — not listed as at the book date', // Vedanta Power Limited
  INE1CLE01013: 'demerged entity — not listed as at the book date', // Vedanta Iron and Steel
  INE704J01044: 'demerged entity — not listed as at the book date', // Vedanta Oil and Gas
  INE564S13022: 'warrants, not the equity line', // Vikram Kamats Hospitality — warrants
  INE0R4713012: 'warrants, not the equity line', // Alpex Solar — warrants
};

/**
 * Companies the automatic passes cannot place, resolved by hand and then CHECKED.
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
  INE881D01027: ['OFSS', 'ORACLE FIN SERV SOFT LTD.'], // Oracle Financial Services Software
  INE077F01035: ['GOCLCORP', 'GOCL CORPORATION LIMITED'], // GOCL Corporation
  INE083K01017: ['BENGALASM', 'BENGAL & ASSAM CO. LTD.'], // Bengal and Assam Company
  INE0LEX01011: ['SAHANA-SM', 'SAHANA SYSTEM LIMITED'], // Sahana Systems
  INE08NE01025: ['SANSTAR', 'SANSTAR LIMITED'], // Sanstar Ltd
  INE665A01038: ['SWANCORP', 'SWAN CORP LIMITED'], // Swan Corp
  // Renamed: the ticker survives, the name does not. Both feeds on disk already carry the new one.
  INE526E01018: ['SHRIPISTON', 'SPR AUTO TECHNOLOGIES LTD (renamed from Shriram Pistons & Rings)'], // Shriram Pistons & Rings
  // The book transposes the words; the company is Mangalore Refinery & Petrochemicals.
  INE103A01014: ['MRPL', 'MANGALORE REFINERY & PETROCHEMICALS'], // Mangalore Petrochemicals and Refinery
  // Two separate listed companies that a prefix match collapses onto one symbol — see the
  // collision guard below, which is what caught it.
  INE1YPB01014: ['AGL', 'ALLCARGO GLOBAL LIMITED'], // Allcargo Global
  INE418H01029: ['ALLCARGO', 'ALLCARGO LOGISTICS LTD'], // Allcargo Logistics
  // Placed by Yahoo's symbol search on an earlier `--net` run, each accepted only because the name
  // Yahoo returned agreed with the book's. Pinned so the scheduled sync resolves the whole book
  // from the files on disk and never depends on somebody else's search box being reachable.
  INE036B01030: ['GAEL', 'GUJARAT AMBUJA EXPORTS LT'], // Gujarat Ambuja Exports
  INE0JUS01029: ['HARSHA', 'HARSHA ENGINEERS INT LTD'], // Harsha
  INE0SMY01017: ['JAYBEE-SM', 'JAY BEE LAMINATIONS LTD'], // Jay Bee Laminations (SME board)
  INE1NPP01017: ['ENRIN', 'SIEMENS ENERGY INDIA LTD'], // Siemens Energy India
  INE220J01025: ['FCONSUMER', 'FUTURE CONSUMER LIMITED'], // Future Consumer
  INE855B01025: ['RAIN', 'RAIN INDUSTRIES LIMITED'], // Rain Industries
  INE879I01012: ['DBREALTY', 'VALOR ESTATE LIMITED'], // Valor Estate (formerly D B Realty; the ticker survives)
  // An SME-board line that the con-call and results feeds file under the bare symbol. It is pinned
  // to Yahoo's `-SM` form because the technicals scrape reads Yahoo, where the bare ALPEXSOLAR.NS is
  // a dead entry (instrument type MUTUALFUND, last trade July 2024) and ALPEXSOLAR-SM.NS is the
  // equity that trades. The same convention as JAYBEE-SM and SAHANA-SM above.
  INE0R4701017: ['ALPEXSOLAR-SM', 'ALPEX SOLAR LIMITED'], // Alpex Solar
};

/**
 * Held, listed, but NOT on the NSE — so no NSE-keyed feed in this dashboard can carry them.
 *
 * This is a real coverage gap and it is recorded rather than hidden. The BSE symbol is kept so the
 * line is identifiable and so a future BSE feed has something to join on.
 */
const BSE_ONLY = {
  INE0N0J01014: 'CNCRD', // Concord Control Systems
  INE094B01013: null, // Ashika Credit Capital — BSE-listed; ASHIKAG on the NSE is Ashika GLOBAL Securities, a different company
  INE741B01027: 'GLITTEKG', // Glittke Granites — spelled "Glittek" by the exchange
  INE564S01019: 'KAMATS', // Vikram Kamats Hospitality
  INE860D01013: 'SANJIVIN', // Sanjivani Paranteral — BSE: SANJIVANI PARANTERAL LTD.
};

/**
 * Held, but findable on neither exchange through any source available here.
 *
 * Not the same as "unlisted": these have been listed. Two are companies that went through
 * insolvency and were delisted; the others are small enough that no source on hand carries them.
 * Recorded as an open question rather than quietly resolved to something that looked close.
 */
const NOT_FOUND = {
  INE958L01034: 'no symbol found on either exchange — check the current name', // String Metaverse
  INE0DQN01013: 'no symbol found on either exchange — an SME line, check the current name', // Nisus Finance Services
  INE935Q01015: 'no symbol found on either exchange — delisted after insolvency', // Future Supply Chain Solutions
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
 * "Interarch Build", "Jay BharatMarut" — and the custodian cuts at twenty ("RPSG VENTURES LIMITE"),
 * so an equality test misses much of the book and a word-boundary test misses any name cut
 * mid-word. Comparing without spaces handles both, and "Jay BharatMarut" then correctly prefixes
 * "Jay Bharat Maruti".
 */
const squash = (s) => norm(s).replace(/ /g, '');

/** The custodian's wording, made readable for a line no display name has been given yet. */
const titleCase = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bLtd\b/g, 'Ltd')
    .replace(/\s+/g, ' ')
    .trim();

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


/** One holding from one fixture line: the display name, the custodian's wording, the ISIN. */
const line = (l, fields) => ({
  isin: l.isin,
  name: DISPLAY_NAMES[l.isin] || null, // settled below once the match is known
  bookName: l.name,
  sector: l.sector || 'Unclassified',
  ...fields,
});

for (const l of BOOK) {
  const isin = l.isin;
  const notListed = NOT_LISTED_EQUITY[isin];
  if (notListed) {
    holdings.push(line(l, { ticker: null, listed: false, reason: notListed }));
    continue;
  }
  const confirmed = CONFIRMED[isin];
  if (confirmed) {
    holdings.push(line(l, { ticker: confirmed[0], listed: true, matchedName: confirmed[1], matchedBy: 'confirmed:yahoo' }));
    continue;
  }
  if (isin in NOT_FOUND) {
    holdings.push(line(l, { ticker: null, listed: true, reason: NOT_FOUND[isin] }));
    continue;
  }
  if (isin in BSE_ONLY) {
    holdings.push(
      line(l, {
        ticker: null,
        listed: true,
        exchange: 'BSE',
        bseSymbol: BSE_ONLY[isin],
        reason: 'listed on the BSE only — every feed wired here is keyed by NSE symbol',
      }),
    );
    continue;
  }
  // The display name is the better search term where one exists: the custodian's twenty-character
  // cut ("PERSISTENT SYSTEMS L") still prefix-matches, but the full name matches exactly.
  const query = DISPLAY_NAMES[isin] || l.name;
  const hit = resolve(query, candidates);
  if (hit?.ticker) {
    holdings.push(line(l, { ticker: hit.ticker, listed: true, matchedName: hit.name, matchedBy: `${hit.how}:${hit.source}` }));
  } else if (hit?.ambiguous) {
    ambiguous.push({ name: query, options: hit.ambiguous });
    holdings.push(line(l, { ticker: null, listed: true, reason: `ambiguous — ${hit.ambiguous.join(' / ')}` }));
  } else {
    unresolved.push({ name: query, isin, index: holdings.length });
    holdings.push(line(l, { ticker: null, listed: true, reason: 'no NSE symbol found in the data on disk' }));
  }
}

// The network pass, over whatever the offline sources could not place.
if (NET && unresolved.length) {
  console.log(`\nasking Yahoo for ${unresolved.length} unresolved names…`);
  for (const u of unresolved.slice()) {
    const hit = await yahooLookup(u.name);
    if (!hit) continue;
    const h = holdings[u.index];
    holdings[u.index] = { ...h, ticker: hit.ticker, listed: true, matchedName: hit.name, matchedBy: 'yahoo-search' };
    delete holdings[u.index].reason;
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
// Anything that collides is demoted back to unresolved and reported. A line in CONFIRMED is exempt
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

// Settle the display name: the table, else the full name the feed prints (Moneycontrol's are
// truncated, so those do not count), else the custodian's wording made readable. Never blank.
const newNames = [];
for (const h of holdings) {
  if (h.name) continue;
  const feedName = h.matchedName && h.matchedBy && !/moneycontrol|confirmed/.test(h.matchedBy) ? h.matchedName : null;
  h.name = feedName || titleCase(h.bookName);
  newNames.push(h);
}
holdings.sort((a, b) => a.name.localeCompare(b.name, 'en'));

const resolved = holdings.filter((h) => h.ticker).length;
const unlisted = holdings.filter((h) => h.listed === false).length;
const bseOnly = holdings.filter((h) => h.exchange === 'BSE').length;

console.log(`book lines           ${BOOK.length}  (${fixture.source || 'fixture'}, as of ${fixture.asOf || 'unknown'})`);
console.log(`resolved to a ticker ${resolved}`);
console.log(`not listed equity    ${unlisted}`);
console.log(`BSE-only (no NSE)    ${bseOnly}`);
console.log(`ambiguous            ${ambiguous.length}`);
console.log(`collisions           ${collisions.length}`);
for (const [t, list] of collisions) console.log(`  ${t} <- ${list.map((h) => h.name).join(' + ')}`);
console.log(`unresolved           ${unresolved.length}`);
if (newNames.length) {
  console.log(`\nNEW LINES with no entry in DISPLAY_NAMES yet (shown under the feed's or the custodian's wording):`);
  for (const h of newNames) console.log(`  ${h.isin}  ${h.name}  (book: ${h.bookName})`);
}
if (ambiguous.length) {
  console.log('\nAMBIGUOUS — needs a human:');
  for (const a of ambiguous) console.log(`  ${a.name}  ->  ${a.options.join(' | ')}`);
}
if (unresolved.length) {
  console.log('\nUNRESOLVED:');
  for (const u of unresolved) console.log(`  ${u.isin}  ${u.name}`);
}

if (DRY) {
  console.log('\n--dry: nothing written.');
  process.exit(0);
}

const payload = {
  _provenance:
    `The family office's listed direct-equity book, one line per equity ISIN, read from ${fixture.source || 'the family repository'} by scripts/sync-family-book.mjs and resolved to NSE symbols by scripts/resolve-portfolio-companies.mjs. ` +
    'This is the COVERAGE list that the Portfolio scope filters every research tab by — it is not a ledger: no quantity, no cost, no value. ' +
    'public/data/portfolio.json remains the Portfolio Analytics ledger and is a different thing. ' +
    'A line with ticker: null is still a real holding; it either is not an NSE-listed equity or could not be resolved, and the UI shows it as held-but-not-covered rather than dropping it.',
  asOf: fixture.asOf || null,
  source: fixture.source || 'family office direct-equity statement',
  sourceCommit: fixture.sourceCommit || null,
  syncedAt: fixture.fetchedAt || null,
  count: holdings.length,
  resolved,
  unlisted,
  bseOnly,
  unresolved: holdings.filter((h) => h.listed !== false && h.exchange !== 'BSE' && !h.ticker).length,
  holdings,
};
writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`\nwrote ${OUT}`);

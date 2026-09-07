// data/mf-taxonomy.js — THE ONE MUTUAL-FUND CLASSIFICATION, for both feeds.
//
//   WORKBOOK_TAXONOMY                sheet name -> { assetClass, group, label }
//   classifyLive(classification)     an AmfiBeas classification string -> { assetClass, group, label }
//   buildTree(items, of)             items -> [{ assetClass, groups: [{ group, categories: [...] }] }]
//   workbookCoverage()               the asset classes the workbook reaches, and the gaps, with reasons
//   FACTORS / factorsOf(name)        the strategy a scheme's OWN NAME states — momentum, quality,
//                                    value, low volatility, alpha, equal weight, dividend yield
//
// PURE, AND IMPORTED FROM TWO SIDES. `scripts/import-mf-weekly.mjs` reads it to file each workbook
// sheet, and the Mutual Funds tab reads it to file each of the live feed's 3,400 schemes. Same
// arrangement, and the same reason, as `finology-shared.js` and `filings-shared.js`: two copies of
// a taxonomy is two taxonomies, and they drift the first time one of them gains a category.
//
// THE THREE LEVELS ARE asset class -> group -> category.
//   asset class   what the money is in            Equity, Debt, Hybrid, Fund of Funds, Commodities
//   group         how the category is chosen      Market cap, Strategy, Sectoral & thematic, …
//   category      the scheme's own bucket         Small Cap, Arbitrage, Gilt, …
//
// The middle level is the one this file adds. Both feeds publish a flat category — the workbook a
// sheet name, AmfiBeas a "Equity : Large Cap" string — and neither says that Large Cap and Small
// Cap are the same KIND of choice while Healthcare is a different one. Grouping them is a reading
// aid over somebody else's category, not a new category: nothing is renamed, nothing is merged, and
// every scheme keeps the bucket its source put it in. `label` exists only to expand a sheet's
// shorthand ("BAF" -> "Balanced Advantage"), and `sourceLabel` always carries the original.
//
// A CATEGORY NOBODY ANTICIPATED IS `Other`, NEVER A GUESS. `classifyLive` files an unrecognised
// classification under its own asset-class head where it can read one, and under `Unclassified`
// where it cannot — visible, counted and obviously unplaced, rather than quietly folded into
// whichever group looked closest. The AmfiBeas feed carries 308 schemes with no classification at
// all; those are `Unclassified` and they are still shown, because a scheme that exists and is
// unlabelled is not a scheme that does not exist.
//
// THERE IS A FOURTH READING AND IT IS NOT PART OF THE TREE. `FACTORS` / `factorsOf()` at the foot
// of this file answer "which of these are momentum funds", which neither source's classification
// can. It reads the scheme's OWN NAME rather than its classification, it is labelled as such
// wherever it surfaces, and it is deliberately a SEPARATE axis: a momentum fund's classification is
// still `Equity : Index`, and nothing here moves it.

// ---------------------------------------------------------------------------------------
// The top level
// ---------------------------------------------------------------------------------------

/**
 * Asset classes in reading order. `order` is what every sort here keys on, so the tree cannot come
 * out alphabetically ("Commodities" before "Equity") the day a new class is added.
 */
const ASSET_CLASSES = [
  { id: 'equity', label: 'Equity', order: 1 },
  { id: 'debt', label: 'Debt', order: 2 },
  { id: 'hybrid', label: 'Hybrid', order: 3 },
  { id: 'commodities', label: 'Commodities', order: 4 },
  { id: 'fof', label: 'Fund of Funds', order: 5 },
  { id: 'unclassified', label: 'Unclassified', order: 99 },
];

const CLASS_ORDER = new Map(ASSET_CLASSES.map((c) => [c.label, c.order]));

/** Groups in reading order within an asset class — same reason as `order` above. */
const GROUP_ORDER = [
  'Market cap',
  'Strategy',
  'Sectoral & thematic',
  'Index & smart beta',
  'Exchange traded',
  'International',
  'Duration',
  'Credit',
  'Cash & liquid',
  'Asset allocation',
  'Hedged',
  'Funds',
  'Domestic',
  'Overseas',
  'Not sub-classified',
  'Other',
];
const groupRank = (g) => {
  const i = GROUP_ORDER.indexOf(g);
  return i < 0 ? GROUP_ORDER.length : i;
};

// ---------------------------------------------------------------------------------------
// The workbook's 26 sheets
// ---------------------------------------------------------------------------------------

/**
 * Sheet name -> where it sits. The KEY is the workbook's own spelling, so a sheet renamed upstream
 * fails the import loudly instead of disappearing from a group; `label` is only ever an expansion
 * of a shorthand, never a re-categorisation.
 *
 * DEBT IS ABSENT HERE ON PURPOSE. The workbook publishes no debt sheet, so no debt category is
 * invented for it; the tab states that in words. The live feed does cover debt, on its own date.
 */
export const WORKBOOK_TAXONOMY = {
  'Large Cap': { assetClass: 'Equity', group: 'Market cap' },
  'Large&Mid': { assetClass: 'Equity', group: 'Market cap', label: 'Large & Mid Cap' },
  'Mid Cap': { assetClass: 'Equity', group: 'Market cap' },
  'Small Cap': { assetClass: 'Equity', group: 'Market cap' },
  'Multi Cap': { assetClass: 'Equity', group: 'Market cap' },
  'Flexi Cap': { assetClass: 'Equity', group: 'Market cap' },

  'Focused Funds': { assetClass: 'Equity', group: 'Strategy', label: 'Focused' },
  'Value Funds': { assetClass: 'Equity', group: 'Strategy', label: 'Value' },
  'Contra Fund': { assetClass: 'Equity', group: 'Strategy', label: 'Contra' },
  'Dividend Yield Funds': { assetClass: 'Equity', group: 'Strategy', label: 'Dividend Yield' },
  ELSS: { assetClass: 'Equity', group: 'Strategy', label: 'ELSS (tax saver)' },

  Consumption: { assetClass: 'Equity', group: 'Sectoral & thematic' },
  Financials: { assetClass: 'Equity', group: 'Sectoral & thematic' },
  Digital: { assetClass: 'Equity', group: 'Sectoral & thematic', label: 'Digital & technology' },
  Healthcare: { assetClass: 'Equity', group: 'Sectoral & thematic' },
  Infrastructure: { assetClass: 'Equity', group: 'Sectoral & thematic' },
  Manufacturing: { assetClass: 'Equity', group: 'Sectoral & thematic' },
  PSU: { assetClass: 'Equity', group: 'Sectoral & thematic' },
  Energy: { assetClass: 'Equity', group: 'Sectoral & thematic' },
  'Transportation & Logistics': { assetClass: 'Equity', group: 'Sectoral & thematic' },
  Services: { assetClass: 'Equity', group: 'Sectoral & thematic' },
  Exports: { assetClass: 'Equity', group: 'Sectoral & thematic' },

  'Smart Beta Strategy Funds': { assetClass: 'Equity', group: 'Index & smart beta', label: 'Smart Beta' },

  BAF: { assetClass: 'Hybrid', group: 'Asset allocation', label: 'Balanced Advantage' },
  'Equity Saving': { assetClass: 'Hybrid', group: 'Asset allocation', label: 'Equity Savings' },
  'Arbitrage Funds': { assetClass: 'Hybrid', group: 'Hedged', label: 'Arbitrage' },
};

/**
 * The asset classes this workbook reaches, and the ones it does not — each with the reason.
 *
 * A class the source does not cover is NAMED rather than left out or drawn empty: an empty "Debt"
 * group reads as "no debt funds exist", which is a claim about the market rather than about this
 * spreadsheet. Same rule as the book's nineteen lines with no NSE symbol.
 */
export function workbookCoverage() {
  const covered = new Set(Object.values(WORKBOOK_TAXONOMY).map((t) => t.assetClass));
  return ASSET_CLASSES.filter((c) => c.id !== 'unclassified').map((c) => ({
    ...c,
    covered: covered.has(c.label),
    note: covered.has(c.label)
      ? null
      : `This weekly workbook publishes no ${c.label.toLowerCase()} sheet, so no ${c.label.toLowerCase()} category is reproduced here. The daily AmfiBeas feed on All Schemes does carry them, on its own date.`,
  }));
}

// ---------------------------------------------------------------------------------------
// The live feed's 56 classification strings
// ---------------------------------------------------------------------------------------

// AmfiBeas writes "<head> : <tail>", e.g. "Equity : Large Cap", "Debt : Liquid", "Hybrid :
// Arbitrage", "FoFs : Overseas", "Metal : ETFs", "Other : FoF" — and sometimes just "Debt" or
// "Hybrid" with no tail at all. The head is their asset class and is taken as given; only the
// GROUP is decided here, from the tail.
const HEAD_TO_CLASS = {
  Equity: 'Equity',
  Debt: 'Debt',
  Hybrid: 'Hybrid',
  FoFs: 'Fund of Funds',
  Metal: 'Commodities',
  Other: 'Unclassified',
};

// Tail -> group, per asset class. A tail this file does not list falls to `Other` — visible and
// obviously unplaced rather than pushed into a neighbour — and a classification with NO tail at all
// falls to `Not sub-classified`, which is a different statement: see classifyLive() below.
//
// AN EXCHANGE-TRADED FUND IS ITS OWN GROUP, IN EVERY ASSET CLASS. It used to be filed under
// `Index & smart beta`, which put 25 gold ETFs under a heading about equity factor strategies and
// left the ~200 equity ETFs sharing a bucket with 447 open-ended index funds — so a reader looking
// for "ETFs", which is a word the source itself uses, had no control that said it. Listed-versus-
// open-ended is a real distinction the source draws, so it gets its own group and `Index & smart
// beta` keeps the open-ended index trackers.
const EQUITY_GROUPS = [
  [/^(large cap|mid cap|small cap|large & mid cap|multi cap|flexi cap)$/i, 'Market cap'],
  [/^(focused|value \/ contra|value|contra|elss|tax saving \(elss\)|dividend yield)$/i, 'Strategy'],
  [/^(sectoral|thematic)\b/i, 'Sectoral & thematic'],
  [/^etfs$/i, 'Exchange traded'],
  [/^(index|index funds)$/i, 'Index & smart beta'],
  [/^international$/i, 'International'],
];
const DEBT_GROUPS = [
  [/(overnight|liquid|money market|ultra short|low duration)/i, 'Cash & liquid'],
  [/(short duration|medium duration|medium to long|long duration|dynamic bond|gilt|floater)/i, 'Duration'],
  [/(corporate bond|credit risk|banking & psu)/i, 'Credit'],
  [/^etfs$/i, 'Exchange traded'],
];
const HYBRID_GROUPS = [
  [/(arbitrage|equity savings)/i, 'Hedged'],
  [/(aggressive|balanced|conservative|dynamic asset allocation|multi asset)/i, 'Asset allocation'],
];
const FOF_GROUPS = [
  [/^domestic$/i, 'Domestic'],
  [/^overseas$/i, 'Overseas'],
];
const COMMODITY_GROUPS = [
  [/^etfs$/i, 'Exchange traded'],
  [/^mfs$/i, 'Funds'],
];

const GROUPS_BY_CLASS = {
  Equity: EQUITY_GROUPS,
  Debt: DEBT_GROUPS,
  Hybrid: HYBRID_GROUPS,
  'Fund of Funds': FOF_GROUPS,
  Commodities: COMMODITY_GROUPS,
};

/**
 * One AmfiBeas `classification` string -> where it sits in the tree.
 *
 * `sourceLabel` is always the string as it arrived, so the reader can see the source's own words
 * beside the grouping this file added. A null or unreadable classification is `Unclassified` and is
 * kept — 308 of the shipped feed's schemes carry none, and dropping them would silently shrink a
 * universe the source says is 3,439 strong.
 */
export function classifyLive(classification) {
  const raw = String(classification || '').trim();
  if (!raw) {
    return { assetClass: 'Unclassified', group: 'Other', label: 'No classification', sourceLabel: null, categoryId: 'unclassified' };
  }
  const [head, ...rest] = raw.split(':').map((s) => s.trim());
  const tail = rest.join(' : ');
  const assetClass = HEAD_TO_CLASS[head] || 'Unclassified';
  const label = tail || head;
  const rules = GROUPS_BY_CLASS[assetClass] || [];
  // A BARE HEAD IS "NOT SUB-CLASSIFIED", NOT "OTHER". 289 schemes arrive as the single word `Debt`
  // and 71 as `Hybrid`, with no tail at all — the source knows the asset class and has filed no
  // category under it. `Other` reads as a bucket the source chose; this reads as the absence it is,
  // which is the same distinction every em dash in this codebase draws.
  const group = rules.find(([re]) => re.test(tail))?.[1] || (tail ? 'Other' : 'Not sub-classified');
  return { assetClass, group, label, sourceLabel: raw, categoryId: slugify(raw) };
}

// ---------------------------------------------------------------------------------------
// The strategy a scheme's own NAME states
// ---------------------------------------------------------------------------------------

/**
 * MOMENTUM IS NOT A CLASSIFICATION EITHER SOURCE PUBLISHES, AND IT IS STILL A REAL QUESTION.
 *
 * AmfiBeas files all 645 passive equity schemes as `Index`, `Index Funds` or `ETFs` and stops
 * there; the workbook files all 70 of them as one `Smart Beta Strategy Funds` sheet. Neither says
 * which factor a scheme follows — so "show me the momentum funds" had no control on either
 * sub-view, and the 75 momentum schemes in the live feed were reachable only by typing the word
 * into a search box.
 *
 * WHERE THE ANSWER COMES FROM IS THE SCHEME'S OWN NAME, and that is why this is admissible rather
 * than a category of our invention. A passive scheme is named for the index it tracks — "Motilal
 * Oswal Nifty 200 Momentum 30 Index Fund" — because SEBI requires the tracked index in the scheme
 * name, and an active one that calls itself "Active Momentum Fund" is making the same statement.
 * Reading a word the source printed is not the same act as deciding which bucket a scheme belongs
 * in: nothing here changes a scheme's classification, nothing is renamed, and a scheme matching no
 * pattern is simply not in a strategy rather than being placed in a nearest one.
 *
 * It is labelled as read-from-the-name everywhere it surfaces, for the same reason a derived gap is
 * labelled derived.
 */
export const FACTORS = [
  { id: 'momentum', label: 'Momentum', re: /\bmomentum\b/i },
  { id: 'quality', label: 'Quality', re: /\bquality\b/i },
  { id: 'value', label: 'Value', re: /\bvalue\b/i },
  { id: 'low-volatility', label: 'Low volatility', re: /\blow[\s.-]*vol(atility)?\b/i },
  { id: 'alpha', label: 'Alpha', re: /\balpha\b/i },
  { id: 'equal-weight', label: 'Equal weight', re: /\bequal[\s.-]*w(eigh)?t\b/i },
  { id: 'dividend', label: 'Dividend yield', re: /\bdividend\b|\bdiv\.?\s*yield\b/i },
];

const FACTOR_LABEL = new Map(FACTORS.map((f) => [f.id, f.label]));
export const factorLabel = (id) => FACTOR_LABEL.get(id) || id;

/**
 * Every strategy word a scheme's own name states, as factor ids. A name may state more than one —
 * "Nifty Smallcap250 Momentum Quality 100" is both — so this returns an array and a scheme is
 * counted under each, rather than being forced into whichever matched first.
 *
 * `Growth` is deliberately not a factor here: it is the OPTION suffix on almost every scheme name
 * in both feeds ("- Dir - Growth", "(G)"), so a pattern for it would match nearly the whole
 * universe and say nothing.
 */
export function factorsOf(name) {
  const n = String(name || '');
  if (!n) return [];
  return FACTORS.filter((f) => f.re.test(n)).map((f) => f.id);
}

export function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------------------

/**
 * Roll a flat list into `asset class -> group -> category`.
 *
 * `of(item)` returns `{ assetClass, group, label, categoryId }` — `WORKBOOK_TAXONOMY`'s entry for a
 * sheet, or `classifyLive()`'s for a scheme. Counts are of the ITEMS handed in, so a narrowed list
 * produces a narrowed tree and no level ever prints a number from a wider set than the one on
 * screen.
 */
export function buildTree(items, of) {
  const classes = new Map();
  for (const item of items) {
    const t = of(item);
    if (!t) continue;
    if (!classes.has(t.assetClass)) classes.set(t.assetClass, new Map());
    const groups = classes.get(t.assetClass);
    if (!groups.has(t.group)) groups.set(t.group, new Map());
    const cats = groups.get(t.group);
    const id = t.categoryId || slugify(t.label);
    if (!cats.has(id)) cats.set(id, { id, label: t.label, sourceLabel: t.sourceLabel ?? t.label, items: [] });
    cats.get(id).items.push(item);
  }
  return [...classes.entries()]
    .map(([assetClass, groups]) => ({
      assetClass,
      count: [...groups.values()].reduce((n, cats) => n + [...cats.values()].reduce((m, c) => m + c.items.length, 0), 0),
      groups: [...groups.entries()]
        .map(([group, cats]) => ({
          group,
          count: [...cats.values()].reduce((n, c) => n + c.items.length, 0),
          categories: [...cats.values()].sort((a, b) => a.label.localeCompare(b.label)),
        }))
        .sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.group.localeCompare(b.group)),
    }))
    .sort((a, b) => (CLASS_ORDER.get(a.assetClass) ?? 98) - (CLASS_ORDER.get(b.assetClass) ?? 98) || a.assetClass.localeCompare(b.assetClass));
}

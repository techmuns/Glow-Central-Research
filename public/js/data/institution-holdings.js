// data/institution-holdings.js — REAL filed shareholdings, by institution.
//
//   prime(payload)            // seeded from app.js at bootstrap
//   all()                     // the institutions we have real filings for
//   byId(investorId)
//   meta()                    // quarter, source, when it was scraped
//   holdingsForScope(scope, holdings, fund)
//
// WHAT IS REAL HERE AND WHAT IS NOT
//   Indian companies file their shareholding pattern with the exchanges each quarter, naming every
//   holder above 1% with a share count and a percentage of the company. Those two numbers are the
//   filing itself. Trendlyne aggregate them by holder — one page per institution — and that is what
//   scripts/scrape-institution-holdings.mjs reads.
//
//   The RUPEE VALUE is Trendlyne's own derivation: holding % × market cap. It is reproduced
//   unchanged and attributed to them, never recomputed here, for the same reason the con-call
//   scores are StockScans' — a number of our own under their label would read as theirs.
//
// A MISSING PERCENTAGE IS NOT AN EXIT
//   Filings trickle in for weeks after a quarter closes. A holding can carry a share count and a
//   value while its percentage for the newest quarter is still outstanding — Trendlyne label that
//   row "Filing Awaited", and one of the 37 Jun-2026 holdings is in exactly that state. Rendering
//   it as 0% would report a position that is still held as sold.

const PATH = 'data/institution-holdings.json';

let cache = null;
let loadPromise = null;

/** Seed from the bootstrap payload so the module never refetches what app.js already has. */
export function prime(payload) {
  if (payload && !cache) ingest(payload);
  return cache;
}

export function load() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = import('../core/store.js')
    .then((s) => s.revalidatedJson(PATH, { optional: true }))
    .then((p) => {
      loadPromise = null;
      if (p) ingest(p);
      return cache;
    })
    .catch(() => {
      loadPromise = null;
      return null;
    });
  return loadPromise;
}

function ingest(payload) {
  const institutions = (payload.institutions || []).map((f) => ({
    ...f,
    // Newest first by book size, which is the order a reader scans for.
    holdings: [...(f.holdings || [])].sort((a, b) => (b.valueCr ?? 0) - (a.valueCr ?? 0)),
    former: [...(f.former || [])],
  }));
  cache = {
    institutions,
    byId: new Map(institutions.map((f) => [f.investorId, f])),
    meta: {
      source: payload.source || null,
      generator: payload.generator || null,
      generatedAt: payload.generated_at || null,
      quarter: payload.quarter || null,
      quarterLabel: payload.quarterLabel || null,
      count: institutions.length,
    },
  };
  return cache;
}

export const isLoaded = () => !!cache;
export const all = () => (cache ? cache.institutions : []);
export const meta = () => (cache ? cache.meta : null);
export const byId = (id) => (cache && id ? cache.byId.get(id) || null : null);

/** Every ticker any tracked institution currently holds — used to answer "who owns this?". */
export function holdersOf(ticker) {
  const t = String(ticker || '').toUpperCase();
  if (!t) return [];
  return all()
    .filter((f) => f.holdings.some((h) => h.ticker.toUpperCase() === t))
    .map((f) => ({ fund: f, holding: f.holdings.find((h) => h.ticker.toUpperCase() === t) }));
}

/**
 * Narrow a fund's holdings to the active scope. Portfolio scope answers a different and more
 * useful question than "what does this fund own" — it answers "where does this fund overlap me".
 */
export function holdingsForScope(scope, portfolioHoldings = [], rows = []) {
  if (scope !== 'portfolio') return rows;
  const held = new Set(portfolioHoldings.map((h) => String(h.ticker).toUpperCase()));
  return rows.filter((h) => held.has(String(h.ticker).toUpperCase()));
}

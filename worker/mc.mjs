// worker/mc.mjs — the Moneycontrol earnings client, shared by the Worker and the Node scraper.
//
// Pure and dependency-free: no Node APIs, no DOM, no Cloudflare APIs. `fetch` is a parameter so
// the Worker passes its own and Node passes the global. That is what lets one definition serve
// both the live route (worker/index.js) and the committed snapshot (scripts/scrape-earnings.mjs)
// — two copies of this would drift and the live tab would disagree with its own fallback file.
//
//   const { rows, meta } = await fetchLatestResults({ limit: 5000 });
//
// THE UPSTREAM
//   GET https://api.moneycontrol.com/mcapi/v1/earnings/rapid-results
//   Undocumented but stable-shaped, CORS-open, no auth, no bot wall. Returns positional arrays
//   described by its own `header` block, which is why `normalise()` reads the header rather than
//   hard-coding indices — if Moneycontrol inserts a column, we notice instead of silently
//   shifting every field by one.
//
// THE PERCENTAGE TRAP, AND WHY EVERY ROW CARRIES A `kind`
//   Moneycontrol reports Net Profit growth as a plain percentage even when the sign flips. Across
//   the 1,319 companies in a full Q1 pull, 169 of them — 13% — are cases where that number does
//   not mean what it appears to:
//     · 71 have losses in BOTH periods. Vodafone Idea shows "+43%": the loss narrowed from
//       6,608 Cr to 3,754 Cr. Rendered as a green +43% it reads as profit growth.
//     · 63 went from loss to profit. Wockhardt shows "+199%". A percentage change across zero is
//       not a growth rate at all.
//     · 35 went from profit to loss. Bharat Forge shows "-127%". Same problem, mirrored.
//   So every metric is classified and the UI labels it. A number that cannot honestly be read as
//   a growth rate must not be painted like one.

export const RAPID_RESULTS_URL = 'https://api.moneycontrol.com/mcapi/v1/earnings/rapid-results';

// Validated server-side; sending anything else returns a 422 naming the allowed set.
export const TYPES = ['LR', 'BP', 'WP', 'PT', 'NT']; // Latest / Best / Worst / Profit- / Net-turnaround
export const CATEGORIES = ['all', 'std', 'con'];
export const SUBTYPES = ['yoy', 'qoq'];
export const SORTS = ['latest', 'name', 'growth', 'changeP'];

export function buildUrl({ limit = 5000, page = 1, type = 'LR', subType = 'yoy', category = 'all', sortBy = 'latest', indexId = 'N', sector = '', search = '', seq = 'desc' } = {}) {
  const q = new URLSearchParams({
    limit: String(limit),
    page: String(page),
    type,
    subType,
    category,
    sortBy,
    indexId,
    sector,
    search,
    seq,
  });
  return `${RAPID_RESULTS_URL}?${q}`;
}

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/** "August 10, 2026" -> "2026-08-10". Returns null rather than guessing on an unexpected format. */
export function parseResultDate(s) {
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/** "11,689" -> 11689 · "-3,754" -> -3754 · "" -> null. Never returns 0 for missing input. */
export function parseNum(s) {
  if (s == null || s === '' || s === '-') return null;
  const n = Number(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Classify a period-on-period move so the UI can render it honestly.
 *
 * `pct` is only ever non-null for `normal` and `loss-narrowed`/`loss-widened`, and even then the
 * loss cases carry a distinct kind so they can be labelled. For a sign flip there is no honest
 * percentage, so `pct` is null and the UI shows the two raw figures instead.
 */
export function classifyChange(current, prior, reportedPct) {
  if (current == null || prior == null) return { kind: 'na', pct: null, direction: 0 };
  if (prior === 0) return { kind: current === 0 ? 'flat' : 'from-zero', pct: null, direction: Math.sign(current) };

  if (current >= 0 && prior > 0) {
    const pct = reportedPct != null ? reportedPct : ((current - prior) / prior) * 100;
    return { kind: 'normal', pct, direction: Math.sign(current - prior) };
  }
  if (current < 0 && prior < 0) {
    // Both loss-making. Improvement means the loss got smaller, i.e. current is less negative.
    // An unchanged loss is its own case: treating "not narrowed" as "widened" rendered Eurotex's
    // -1 vs -1 as "Loss ↑ 0%", which claims a deterioration that did not happen.
    if (current === prior) return { kind: 'loss-flat', pct: 0, direction: 0 };
    const narrowed = current > prior;
    return { kind: narrowed ? 'loss-narrowed' : 'loss-widened', pct: reportedPct, direction: narrowed ? 1 : -1 };
  }
  if (current >= 0 && prior < 0) return { kind: 'turnaround', pct: null, direction: 1 };
  return { kind: 'slipped-to-loss', pct: null, direction: -1 };
}

/**
 * Turn one Moneycontrol positional row into an object, using the payload's own `header` block to
 * locate each field. Unknown/extra columns are ignored; a missing required one yields null rather
 * than a shifted value.
 */
export function normaliseRow(row, headerIndex) {
  const at = (name) => {
    const i = headerIndex[name];
    return i == null ? undefined : row[i];
  };

  const metrics = {};
  const raw = at('quarterData');
  if (Array.isArray(raw)) {
    for (const m of raw) {
      if (!Array.isArray(m) || m.length < 4) continue;
      const key = String(m[0]).toLowerCase().replace(/[^a-z]/g, ''); // "Gross Profit" -> grossprofit
      const current = parseNum(m[1]);
      const prior = parseNum(m[2]);
      const reported = parseNum(m[3]);
      metrics[key] = { label: m[0], current, prior, reportedPct: reported, ...classifyChange(current, prior, reported) };
    }
  }

  const seo = String(at('seoString') || '');
  const scId = String(at('scID') || '').trim();

  return {
    scId,
    // Moneycontrol truncates display names to 15 characters ("Jubilant Pharmo"), so this is a
    // label, never a join key. The join key is scId -> NSE ticker via the committed map.
    name: String(at('stockName') || '').trim(),
    resultDate: parseResultDate(at('date')),
    resultDateLabel: String(at('date') || ''),
    ltp: parseNum(at('ltp')),
    changePct: parseNum(at('changeP')),
    exchange: String(at('exchange') || '').trim(), // N | B
    basis: String(at('financialType') || '').trim(), // Consolidated | Standalone
    sectorSlug: seo.split('/').filter(Boolean)[0] || null,
    mcUrl: seo ? `https://www.moneycontrol.com/india/stockpricequote${seo}` : null,
    revenue: metrics.revenue ?? null,
    grossProfit: metrics.grossprofit ?? null,
    netProfit: metrics.netprofit ?? null,
  };
}

/** Map the payload's `header` array to `{ fieldName: index }`. */
export function headerIndexOf(header) {
  const idx = {};
  (header || []).forEach((h, i) => {
    if (h && h.name) idx[h.name] = i;
  });
  return idx;
}

/**
 * Fetch and normalise one page. `fetchImpl` defaults to the ambient fetch so the Worker and Node
 * both work without ceremony.
 */
export async function fetchLatestResults(opts = {}, fetchImpl = fetch) {
  const url = buildUrl(opts);
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': 'SattvaCentralResearch/1.0 (+dashboard)' },
  });
  if (!res.ok) throw new Error(`Moneycontrol HTTP ${res.status}`);
  const body = await res.json();
  if (!body || body.success !== 1 || !body.data) {
    throw new Error(`Moneycontrol rejected the request: ${typeof body?.data === 'string' ? body.data : 'unexpected payload'}`);
  }

  const data = body.data;
  const headerIndex = headerIndexOf(data.header);
  for (const required of ['stockName', 'scID', 'date', 'quarterData']) {
    if (headerIndex[required] == null) throw new Error(`Moneycontrol payload is missing the "${required}" column`);
  }

  const rows = (data.list || []).map((r) => normaliseRow(r, headerIndex)).filter((r) => r.scId);

  // tableHeader is ["Q1 FY26-27", "Jun 26", "Jun 25", "Growth"] — the quarter this pull covers and
  // the two periods being compared. Carrying it through means the UI can state which quarter it is
  // showing instead of implying "current".
  const [quarter, currentPeriod, priorPeriod] = data.tableHeader || [];

  return {
    rows,
    meta: {
      quarter: quarter || null,
      currentPeriod: currentPeriod || null,
      priorPeriod: priorPeriod || null,
      subType: opts.subType || 'yoy',
      type: opts.type || 'LR',
      category: opts.category || 'all',
      count: rows.length,
      source: 'Moneycontrol — Rapid Results (api.moneycontrol.com/mcapi/v1/earnings/rapid-results)',
      fetchedAt: new Date().toISOString(),
    },
  };
}

export const PRICE_FEED_URL = 'https://priceapi.moneycontrol.com/pricefeed/nse/equitycash';

/**
 * Resolve a Moneycontrol company code to its NSE identity.
 *
 * Returns `{ ticker, industry, shares, fullName }` or null. Never throws: an unresolvable code
 * must degrade to "no ticker shown", not to a failed request for the whole table.
 */
export async function resolveIdentity(scId, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${PRICE_FEED_URL}/${encodeURIComponent(scId)}`, {
      headers: { accept: 'application/json', 'user-agent': 'SattvaCentralResearch/1.0' },
    });
    if (!res.ok) return null;
    const d = (await res.json())?.data || {};
    const ticker = String(d.NSEID || '').trim().toUpperCase();
    if (!ticker) return null;
    const shares = Number(d.SHRS);
    return {
      ticker,
      bseId: String(d.BSEID || '').trim() || null,
      fullName: String(d.company || d.SC_FULLNM || '').trim() || null,
      industry: String(d.newSubsector || d.main_sector || '').replace(/\s+/g, ' ').trim() || null,
      shares: Number.isFinite(shares) && shares > 0 ? shares : null,
      mktCapAtBuild: Number(d.MKTCAP) || null,
    };
  } catch {
    return null;
  }
}

/**
 * Fill in the identity of companies the committed ticker map has never seen.
 *
 * A company that reports TODAY is by definition not in a map built yesterday, so without this the
 * freshest rows — the entire point of a live results feed — arrive with no ticker, no market cap
 * and no industry until the nightly job catches up. Those are exactly the rows a user is looking
 * at, so they get resolved now.
 *
 * Bounded by `limit`: outside results season this resolves nothing, and on the busiest day it is
 * a few dozen requests once per cache window, not per reader. Anything beyond the cap keeps its
 * null ticker and is picked up by the next scheduled run.
 */
export async function resolveMissing(rows, knownMap = {}, { limit = 40, fetchImpl = fetch } = {}) {
  const unknown = [...new Set(rows.filter((r) => r.scId && !knownMap[r.scId]).map((r) => r.scId))].slice(0, limit);
  if (!unknown.length) return { resolved: {}, attempted: 0, failed: 0 };

  const entries = await Promise.all(unknown.map(async (scId) => [scId, await resolveIdentity(scId, fetchImpl)]));
  const resolved = {};
  let failed = 0;
  for (const [scId, hit] of entries) {
    if (hit) resolved[scId] = hit;
    else failed++;
  }
  return { resolved, attempted: unknown.length, failed };
}

/** Attach identity + a live market cap to each row from the merged map. */
export function applyIdentity(rows, map = {}) {
  return rows.map((r) => {
    const m = map[r.scId];
    if (!m) return r;
    return {
      ...r,
      ticker: m.ticker || null,
      fullName: m.fullName || null,
      industry: m.industry || null,
      shares: m.shares ?? null,
      mktCapAtBuild: m.mktCapAtBuild ?? null,
    };
  });
}

/**
 * Latest result date present in a row set, as ISO. The live layer uses this plus the row count as
 * a cheap "has anything changed?" signal — a new filing moves one or both.
 */
export function freshnessOf(rows) {
  let latest = null;
  for (const r of rows) if (r.resultDate && (!latest || r.resultDate > latest)) latest = r.resultDate;
  return { latestResultDate: latest, count: rows.length };
}

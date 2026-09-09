// data/finology-shared.js — the super-investor vocabulary, shared by the browser and the Worker.
//
//   isSlug(s)                    what the upstream will accept as a path param
//   normaliseList(body)          the investor list, shape-guarded
//   normalisePortfolio(body, s)  one investor's book, shape-guarded
//   deriveMoves(portfolio)       quarter-over-quarter position changes
//   summarise(portfolio)         totals over one book
//
// PURE, AND IMPORTED BY `worker/finology.mjs`. Same arrangement as stockscans-shared.js: one
// definition of what a holding is, so the Worker and the browser cannot end up disagreeing about
// whether a blank quarter means zero. Nothing here touches the DOM, `fetch` or any global.
//
// THE NUMBERS ARE FINOLOGY'S. Holding percentages are what the company filed with the exchanges;
// `valueCr` is Finology's own derivation from that percentage and a market cap — the same relation
// the Institutions view has with Trendlyne's value column. Neither is recomputed here.
//
// THE ONE DERIVED FIGURE is the quarter-over-quarter change in `deriveMoves`, which is subtraction
// of two of their own percentages. It is labelled as derived on every surface that shows it.

/**
 * THE RETRY BUDGET, AND IT LIVES HERE BECAUSE THE SCREEN QUOTES IT.
 *
 * `worker/finology.mjs` owns the rationale — six seconds is six times the healthy latency, two
 * attempts rides out a restart, and `DEADLINE_MS` is the absolute guarantee. The numbers sit in
 * this shared module because the panel tells the reader what the request was given, and a sentence
 * that names a figure the code decides must READ it rather than repeat it. It did repeat it: the
 * ceiling was cut from 15s × 3 to 6s × 2 under a 13s deadline, and the reason string in
 * `js/investors/live.js` went on saying "given 15 seconds and retried" — quoting a budget that had
 * not existed for some time, in the one place a reader could check it against a stopwatch.
 *
 * Same rule as the Sources modal: no figure on a surface may be typed by hand where the module that
 * decides it can be asked instead.
 */
export const REQ_TIMEOUT_MS = 6000;
export const ATTEMPTS = 2;
export const DEADLINE_MS = 13000;

/** Only [a-z0-9-] is a valid slug upstream; anything else is a 400 there, so it is rejected here. */
export const isSlug = (s) => typeof s === 'string' && /^[a-z0-9-]+$/.test(s) && s.length <= 120;

const num = (v) => {
  if (v == null || v === '' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Two decimals, because a percentage-point delta of 0.30000000000000004 is not a real figure. */
export const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Shape guard for the list.
 *
 * `bio` and `imageUrl` are documented nullable, and `name` can be missing. An investor with no
 * usable slug is DROPPED rather than rendered: the slug is the only way to fetch that investor's
 * book, so a card without one is a dead end. `dropped` carries how many, because upstream `count`
 * and the rendered count would otherwise disagree with nothing to explain it.
 */
export function normaliseList(body) {
  const raw = Array.isArray(body?.investors) ? body.investors : [];
  const investors = raw
    .map((i) => ({
      name: str(i?.name) || str(i?.slug) || null,
      slug: str(i?.slug),
      bio: str(i?.bio),
      imageUrl: str(i?.imageUrl),
    }))
    .filter((i) => isSlug(i.slug || ''));
  return {
    count: Number.isFinite(body?.count) ? body.count : investors.length,
    dropped: raw.length - investors.length,
    investors,
  };
}

/**
 * Shape guard for one portfolio.
 *
 * `quarters` is the ordered list of column labels and `quarterlyHoldings` is keyed by those
 * labels. A holding may legitimately be missing a quarter — that means NOT DISCLOSED (or not
 * held) in that quarter, and Finology print "-" for it. It stays `null` all the way to the UI,
 * where it renders as an em dash. Coercing it to 0 would invent a position size of zero, which is
 * a claim, and would turn every gap in disclosure into a fabricated exit in `deriveMoves`.
 */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "Jun 2025" / "Jun 25" / "2025-06" -> 202506, or null when the label is not a date at all. */
export function quarterOrder(label) {
  const s = String(label || '').trim();
  const iso = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (iso) return Number(iso[2]) >= 1 && Number(iso[2]) <= 12 ? Number(iso[1]) * 100 + Number(iso[2]) : null;
  const named = /^([A-Za-z]{3})[a-z]*[\s-]*(\d{2,4})$/.exec(s);
  if (!named) return null;
  const m = MONTHS[named[1].toLowerCase()];
  if (!m) return null;
  const y = named[2].length <= 2 ? 2000 + Number(named[2]) : Number(named[2]);
  return y * 100 + m;
}

/**
 * The source's quarters, newest first.
 *
 * EVERY CONSUMER ALREADY ASSUMES `quarters[0]` IS THE LATEST — `deriveMoves` compares [0] against
 * [1], `summarise` counts what is disclosed in [0], and the investor card prints "as of quarters[0]".
 * That assumption was never checked. If the upstream ever hands back ascending order, all three
 * silently describe the OLDEST quarter as the current book, which is not a rendering glitch but a
 * wrong answer stated confidently.
 *
 * So the order is now established from the labels rather than assumed from the array. Labels that
 * do not parse as dates are left exactly where they were — reordering something we cannot read
 * would be worse than trusting it — and a mixed set keeps the source's order for the same reason.
 */
function orderedQuarters(quarters) {
  const keyed = quarters.map((q) => ({ q, n: quarterOrder(q) }));
  if (keyed.some((k) => k.n == null)) return quarters;
  return keyed.sort((a, b) => b.n - a.n).map((k) => k.q);
}

export function normalisePortfolio(body, slug) {
  const raw = Array.isArray(body?.quarters) ? body.quarters.filter((q) => typeof q === 'string' && q.trim()) : [];
  const quarters = orderedQuarters([...new Set(raw)]);
  const holdings = (Array.isArray(body?.holdings) ? body.holdings : [])
    .map((h) => {
      const byQuarter = {}, quarterlyStatus = {};
      for (const q of quarters) {
        byQuarter[q] = num(h?.quarterlyHoldings?.[q]);
        quarterlyStatus[q] = disclosureStatus(h, q);
      }
      return {
        company: str(h?.company),
        companySlug: str(h?.companySlug),
        quarterlyHoldings: byQuarter,
        quarterlyStatus,
        valueCr: num(h?.valueCr),
      };
    })
    .filter((h) => h.company);

  return {
    name: str(body?.name) || slug,
    slug: str(body?.slug) || slug,
    ...(str(body?.fetchedAt) ? { fetchedAt: str(body.fetchedAt) } : {}),
    netWorthCr: num(body?.netWorthCr),
    activeStocks: num(body?.activeStocks),
    totalStocks: num(body?.totalStocks),
    quarters,
    holdings,
  };
}

/** A source null has lost its meaning. Only explicit absence can support a presence change. */
export function disclosureStatus(holding, quarter) {
  if (num(holding?.quarterlyHoldings?.[quarter]) != null) return 'reported';
  const status = holding?.quarterlyStatus?.[quarter];
  if (['filing_due', 'not_disclosed', 'unknown'].includes(status)) return status;
  const text = String(holding?.quarterlyHoldings?.[quarter] ?? '').trim();
  if (/filing (due|awaited)|awaiting filing/i.test(text)) return 'filing_due';
  if (/^(-|—|not disclosed)$/i.test(text)) return 'not_disclosed';
  return 'unknown';
}

export function periodEnd(label) {
  const order = quarterOrder(label);
  return order == null ? null : new Date(Date.UTC(Math.floor(order / 100), order % 100, 0)).toISOString().slice(0, 10);
}
export function closedQuarters(portfolio, today = new Date().toISOString().slice(0, 10)) {
  return orderedQuarters((portfolio?.quarters || []).filter((q) =>
    [3, 6, 9, 12].includes(quarterOrder(q) % 100) && periodEnd(q) <= today));
}

/** Consecutive, completed calendar quarters; an August event is not a portfolio-wide quarter. */
export function comparisonPeriods(portfolio, today) {
  const [latest, prior] = closedQuarters(portfolio, today);
  const monthIndex = (q) => Math.floor(quarterOrder(q) / 100) * 12 + quarterOrder(q) % 100;
  const comparable = !!latest && !!prior && monthIndex(latest) - monthIndex(prior) === 3;
  return { comparable, latest: latest || null, prior: prior || null };
}

export function deriveMoves(portfolio, today) {
  const periods = comparisonPeriods(portfolio, today);
  if (!periods.comparable) return { ...periods, moves: [] };
  const { latest, prior } = periods;
  const moves = [];
  for (const h of portfolio.holdings || []) {
    const now = num(h.quarterlyHoldings[latest]), before = num(h.quarterlyHoldings[prior]);
    if (now == null && before == null) continue;
    const nowStatus = disclosureStatus(h, latest), beforeStatus = disclosureStatus(h, prior);
    let action = 'unknown', deltaPp = null;
    if (now != null && before != null) {
      deltaPp = round2(now - before);
      action = deltaPp > 0 ? 'added' : deltaPp < 0 ? 'trimmed' : 'held';
    } else if (nowStatus === 'filing_due' || beforeStatus === 'filing_due') action = 'awaiting';
    else if (beforeStatus === 'not_disclosed') action = 'new';
    else if (nowStatus === 'not_disclosed') action = 'exited';
    moves.push({ company: h.company, companySlug: h.companySlug, valueCr: h.valueCr,
      now, before, nowStatus, beforeStatus, deltaPp, action });
  }
  return { ...periods, moves };
}

export function summarise(portfolio, today) {
  const latest = closedQuarters(portfolio, today)[0] || null;
  const disclosed = latest ? portfolio.holdings.filter((h) => num(h.quarterlyHoldings[latest]) != null) : [];
  // Positive disclosed stakes with a zero valuation are an upstream valuation gap, not a zero book.
  const valued = disclosed.filter((h) => h.valueCr != null && (h.valueCr > 0 || num(h.quarterlyHoldings[latest]) === 0));
  const missingValues = disclosed.length - valued.length;
  return {
    latestQuarter: latest,
    disclosedCount: disclosed.length,
    rowCount: portfolio.holdings.length,
    valueCr: valued.length && !missingValues ? round2(valued.reduce((a, h) => a + h.valueCr, 0)) : null,
    valuedCount: valued.length,
    missingValues,
    offCycleCount: portfolio.holdings.filter((h) => (portfolio.quarters || []).some((q) =>
      quarterOrder(q) > quarterOrder(latest) && ![3, 6, 9, 12].includes(quarterOrder(q) % 100) && num(h.quarterlyHoldings[q]) != null)).length,
  };
}

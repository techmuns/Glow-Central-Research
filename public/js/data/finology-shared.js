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
export function normalisePortfolio(body, slug) {
  const quarters = Array.isArray(body?.quarters) ? body.quarters.filter((q) => typeof q === 'string' && q.trim()) : [];
  const holdings = (Array.isArray(body?.holdings) ? body.holdings : [])
    .map((h) => {
      const byQuarter = {};
      for (const q of quarters) byQuarter[q] = num(h?.quarterlyHoldings?.[q]);
      return {
        company: str(h?.company),
        companySlug: str(h?.companySlug),
        quarterlyHoldings: byQuarter,
        valueCr: num(h?.valueCr),
      };
    })
    .filter((h) => h.company);

  return {
    name: str(body?.name) || slug,
    slug: str(body?.slug) || slug,
    netWorthCr: num(body?.netWorthCr),
    activeStocks: num(body?.activeStocks),
    totalStocks: num(body?.totalStocks),
    quarters,
    holdings,
  };
}

/**
 * Quarter-over-quarter position changes, from the two most recent quarters they publish.
 *
 *   new      not disclosed in the prior quarter, disclosed in the latest
 *   exited   disclosed in the prior quarter, not in the latest
 *   added    disclosed in both, latest is higher
 *   trimmed  disclosed in both, latest is lower
 *   held     disclosed in both, unchanged
 *
 * A BLANK QUARTER IS NOT A ZERO, and that is what makes `new` and `exited` presence changes rather
 * than deltas. `deltaPp` stays null for both: the position did not move by "the whole holding", it
 * appeared or disappeared from disclosure, and printing ±5.2pp would be inventing a trade size.
 *
 * Below the Indian disclosure threshold a holder drops off the shareholding pattern entirely, so
 * an `exited` row means "no longer disclosed", which is not the same as "sold out". The UI says
 * that; this function only classifies.
 *
 * With fewer than two quarters published there is nothing to compare, and this returns
 * `comparable: false` rather than calling every position new.
 */
export function deriveMoves(portfolio) {
  const [latest, prior] = portfolio?.quarters || [];
  if (!latest || !prior) return { comparable: false, latest: latest || null, prior: null, moves: [] };

  const moves = [];
  for (const h of portfolio.holdings) {
    const now = h.quarterlyHoldings[latest];
    const before = h.quarterlyHoldings[prior];
    if (now == null && before == null) continue; // disclosed in neither: nothing to say
    let action;
    let deltaPp = null;
    if (before == null) action = 'new';
    else if (now == null) action = 'exited';
    else {
      deltaPp = round2(now - before);
      action = deltaPp > 0 ? 'added' : deltaPp < 0 ? 'trimmed' : 'held';
    }
    moves.push({ company: h.company, companySlug: h.companySlug, valueCr: h.valueCr, now, before, deltaPp, action });
  }
  return { comparable: true, latest, prior, moves };
}

/**
 * Totals over one book. Every figure is a count or a sum of their own numbers.
 *
 * THE VALUE SUMS ONLY WHAT IS STILL DISCLOSED. `holdings` carries every company that has ever
 * appeared in this investor's history, including ones absent from the latest quarter — and
 * summing those into a "book" produced the contradiction this was written to fix: a card reading
 * `0 holdings` beside `₹793 Cr book`, because the count used the latest quarter and the total
 * used all of history. What someone holds now is the latest quarter, so both figures use it.
 *
 * Within that set, only the rows that actually carry a value are summed, and `valuedCount` says
 * how many did. A total that silently skips a third of the book while looking complete is worse
 * than no total at all.
 */
export function summarise(portfolio) {
  const [latest] = portfolio?.quarters || [];
  const disclosed = latest ? portfolio.holdings.filter((h) => h.quarterlyHoldings[latest] != null) : portfolio.holdings;
  const valued = disclosed.filter((h) => h.valueCr != null);
  return {
    latestQuarter: latest || null,
    disclosedCount: disclosed.length,
    rowCount: portfolio.holdings.length,
    valueCr: valued.length ? round2(valued.reduce((a, h) => a + h.valueCr, 0)) : null,
    valuedCount: valued.length,
  };
}

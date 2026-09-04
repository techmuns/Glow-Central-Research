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

/**
 * THE UPSTREAM'S OWN WORD FOR A CELL THAT CARRIES NO NUMBER, kept rather than erased.
 *
 * Finology print **"Filing Due"** in a quarter a company has not filed yet, and "-" where the
 * holding genuinely was not disclosed. `num()` turns both into `null`, and that collapse is what
 * let a company that simply has not filed be reported as one a fund had sold out of. It is the
 * same distinction `parseChange` keeps for Trendlyne's "Filing Awaited", for the same reason.
 *
 * Returns the label only where it is a real statement — "-" and blank say nothing a null does not.
 */
const cellNote = (v) => {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t || t === '-' || Number.isFinite(Number(t))) return null;
  return t;
};

/** Their words for "this period is not filed yet", matched loosely because it is somebody's prose. */
const PENDING_NOTE = /\b(due|awaited|pending|not\s+filed|yet\s+to\s+file)\b/i;
export const isPendingNote = (note) => !!note && PENDING_NOTE.test(String(note));
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
  if (iso) return Number(iso[1]) * 100 + Number(iso[2]);
  const named = /^([A-Za-z]{3})[a-z]*[\s-]*(\d{2,4})$/.exec(s);
  if (!named) return null;
  const m = MONTHS[named[1].toLowerCase()];
  if (!m) return null;
  const y = named[2].length <= 2 ? 2000 + Number(named[2]) : Number(named[2]);
  return y * 100 + m;
}

/**
 * A SHAREHOLDING QUARTER CLOSES IN MARCH, JUNE, SEPTEMBER OR DECEMBER, AND NOTHING ELSE DOES.
 *
 * Finology open a column for the CURRENT period as soon as the first company files into it, and
 * every other row in that column reads "Filing Due" until its own filing lands. So a column
 * labelled "Aug 2026" is not a quarter in which a fund sold; it is a quarter most of the market
 * has not filed yet — and comparing it against the last closed quarter measures WHO HAS FILED,
 * not who traded. That is a category error of exactly the kind the Institutions rule exists for:
 * two things that render as a number against a company name and are not the same measurement.
 *
 * Measured on the shipped capture of ninety books: columns labelled Mar / Jun / Sep / Dec are a
 * median **87%** filled; columns labelled with any other month are a median **6%** filled and
 * never above 33%. Those are two different populations, not one noisy one.
 *
 * A label we cannot read as a date is treated as filed — refusing to compare something we simply
 * do not recognise would be worse than trusting the source's own ordering, and the mass-exit
 * guard in `deriveMoves` still stands behind it.
 */
const QUARTER_END_MONTHS = new Set([3, 6, 9, 12]);
export function isFiledQuarter(label) {
  const n = quarterOrder(label);
  if (n == null) return true;
  return QUARTER_END_MONTHS.has(n % 100);
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
  const quarters = orderedQuarters(raw);
  const holdings = (Array.isArray(body?.holdings) ? body.holdings : [])
    .map((h) => {
      const byQuarter = {};
      const notes = {};
      for (const q of quarters) {
        const raw = h?.quarterlyHoldings?.[q];
        byQuarter[q] = num(raw);
        const note = cellNote(raw);
        if (note) notes[q] = note;
      }
      return {
        company: str(h?.company),
        companySlug: str(h?.companySlug),
        quarterlyHoldings: byQuarter,
        // Their word for a cell that carries no number, where they gave one. Empty on every row
        // whose cells were all numeric or a plain dash, so it costs nothing on a normal book.
        quarterlyNotes: notes,
        valueCr: num(h?.valueCr),
      };
    })
    .filter((h) => h.company);

  // THE COLUMNS ARE SPLIT ONCE, HERE, so every consumer asks the same question of the same answer.
  // `quarters` is unchanged — it is the source's own column set and the table still renders all of
  // it, "Filing Due" column included. What is new is that a comparison has somewhere honest to look.
  const filedQuarters = quarters.filter((q) => isFiledQuarter(q));
  const openQuarters = quarters.filter((q) => !isFiledQuarter(q));

  return {
    name: str(body?.name) || slug,
    slug: str(body?.slug) || slug,
    netWorthCr: num(body?.netWorthCr),
    activeStocks: num(body?.activeStocks),
    totalStocks: num(body?.totalStocks),
    quarters,
    filedQuarters,
    openQuarters,
    holdings,
  };
}

/**
 * The two most recent FILED quarters of a book, newest first, or nulls where it has fewer.
 *
 * Exported because the Data Table classifies a row from its own book's quarters and must ask the
 * same question `deriveMoves` asks. It used to answer it itself, off `quarters[0]` and `[1]`.
 */
export function filedPair(quarters) {
  const filed = (quarters || []).filter((q) => isFiledQuarter(q));
  return [filed[0] || null, filed[1] || null];
}

/**
 * ONE CLASSIFIER FOR ONE HOLDING, and the only one in this codebase.
 *
 * `js/investors/live.js` carried a second copy — the same five branches over `quarters[0]` and
 * `[1]` — so the Data Table went on printing "Undisclosed" against a company whose drill panel and
 * alert had been corrected. Two predicates over one question is the shape this repository keeps
 * having to un-write, and here it meant a fix could land in three places and still be visibly
 * wrong in the fourth.
 *
 * Returns null where there is nothing to say, so the caller can drop the row.
 */
export function classifyHolding(h, latest, prior) {
  const now = h?.quarterlyHoldings?.[latest] ?? null;
  const before = h?.quarterlyHoldings?.[prior] ?? null;
  if (now == null && before == null) return null;
  if (now == null) {
    // Their own word first where they gave one, then their own value. See rules 2 and 3 below.
    return { action: isPendingNote(h?.quarterlyNotes?.[latest]) || stillValued(h) ? 'awaiting' : 'exited', deltaPp: null, now, before };
  }
  if (before == null) return { action: 'new', deltaPp: null, now, before };
  const deltaPp = round2(now - before);
  return { action: deltaPp > 0 ? 'added' : deltaPp < 0 ? 'trimmed' : 'held', deltaPp, now, before };
}

/**
 * Quarter-over-quarter position changes, from the two most recent quarters they have FILED.
 *
 *   new       not disclosed in the prior quarter, disclosed in the latest
 *   exited    disclosed in the prior quarter, not in the latest
 *   added     disclosed in both, latest is higher
 *   trimmed   disclosed in both, latest is lower
 *   held      disclosed in both, unchanged
 *   awaiting  no filed percentage for the latest quarter, and the source still values the
 *             position — the filing is outstanding, NOT a move, and never reported as a sale
 *
 * ------------------------------------------------------------------------------------------
 * WHY THIS READS `filedQuarters` AND NOT `quarters[0]`, WHICH IS THE BUG THIS EXISTS TO CLOSE
 *
 * Finology open a column for the CURRENT period the moment the first company files into it, and
 * print "Filing Due" on every row that has not. `num()` turns that into a null, this function
 * turned a null in the latest column into `exited`, and `exited` reaches the reader as **"X is no
 * longer disclosed"** — a sale that never happened, attributed to a named real person.
 *
 * Measured on the shipped capture, Madhusudan Kela's book: the "Aug 2026" column carried a figure
 * for **1 of 18** holdings, so comparing it against Jun 2026 reported **fourteen** of his
 * positions as gone, Kopran among them — while his page plainly showed Kopran at 1.72% in both
 * Mar and Jun 2026 with Aug reading *Filing Due*. Across all ninety books, 362 of 1,696 derived
 * moves (21%) were exits, most of them this. Nothing threw, no count was wrong, and the feed
 * confidently reported a mass liquidation of the Indian market.
 *
 * Three things stop it, and they are independent on purpose:
 *
 * 1. **A quarter that has not closed is never a comparison baseline.** `isFiledQuarter` above.
 *    This is the actual fix and it is structural rather than statistical.
 * 2. **Their own word wins where they gave one.** A cell noted "Filing Due" is `awaiting`, whatever
 *    the calendar says — reproducing the source's vocabulary, as the con-call and Trendlyne rules
 *    both require. `awaiting` is not a move and is excluded from every roll-up.
 * 3. **An exit needs the source's OWN corroboration, per row.** Finology publish a current value
 *    beside every holding, and it is their answer to the question this bug got wrong: on Kela's
 *    page Kopran reads *Filing Due* and **₹19.71 Cr**, while Choice International — which he
 *    really is off the register of — reads **0.00**. So a missing percentage is only called an
 *    exit when the value agrees it is gone. Where the source still values the position we say the
 *    quarter's percentage is not available (`awaiting`) rather than that the holder sold.
 *    Measured on the shipped capture: of the exits left after fix 1, 142 carry a zero value and
 *    40 carry a real one — and those 40 include Life Insurance Corporation "leaving" Reliance
 *    Communications after two identical quarters at 4.13%, still valued at ₹9.01 Cr.
 *
 * A STATISTICAL GUARD WAS TRIED HERE FIRST AND WAS WORSE. Refusing a book where more than half the
 * positions exit at once catches a bad column, and it also refused Dolly Khanna — whose book sits
 * at the 1% disclosure threshold, so several positions dropping off in one quarter is her normal
 * pattern rather than an anomaly, visible in every quarter of her history. A threshold over a real
 * distribution silences a real answer; the value rule above is the source's own statement about
 * the same row, so it does not have to guess.
 *
 * A BLANK QUARTER IS STILL NOT A ZERO. `new` and `exited` stay presence changes and `deltaPp`
 * stays null for both — the position did not move by "the whole holding", it appeared in or
 * disappeared from disclosure, and printing ±5.2pp would be inventing a trade size. Below the
 * Indian disclosure threshold a holder drops off the pattern entirely, so `exited` means "no
 * longer disclosed" and never "sold out". The UI says that; this function only classifies.
 *
 * With fewer than two FILED quarters there is nothing to compare, and this returns
 * `comparable: false` rather than calling every position new.
 */

/**
 * THE ONE DEFINITION OF WHAT COUNTS AS A MOVE, asked by every consumer.
 *
 * `daily-alerts.js` used to spell this `action !== 'held'`, which was the correct spelling of
 * "something happened" while `held` was the only non-event — and became silently wrong the moment
 * `awaiting` was added, because an outstanding filing would have passed the filter and been raised
 * as an alert reading "X's holding was awaiting between Mar and Jun 2026", classified negative for
 * want of being positive. That is the same shape as `scope !== 'portfolio'` and the same fix: name
 * what IS the thing, in one place, so a new state cannot be admitted by accident.
 */
export const MOVE_ACTIONS = ['new', 'exited', 'added', 'trimmed'];
export const isMove = (action) => MOVE_ACTIONS.includes(action);

/**
 * Does the source still say this position is worth something?
 *
 * `valueCr` is Finology's derivation from the holding and a market cap, so it is their statement
 * that the position exists. `0` is their statement that it does not. `null` is no statement at
 * all, and an exit claimed on no corroboration is the failure this whole module is fixing, so a
 * missing value counts as uncorroborated too — it is one row in the shipped capture.
 */
const stillValued = (h) => Number.isFinite(h?.valueCr) && h.valueCr > 0;

export function deriveMoves(portfolio) {
  // A payload normalised before `filedQuarters` existed (a cached book on somebody's device, or a
  // committed snapshot from an older run) still has to be read, so the split is derived here when
  // it is absent rather than falling back to the column set that caused the bug.
  const filed = portfolio?.filedQuarters || (portfolio?.quarters || []).filter((q) => isFiledQuarter(q));
  const [latest, prior] = filed;
  const pending = (portfolio?.quarters || []).filter((q) => !filed.includes(q));
  if (!latest || !prior) {
    return { comparable: false, latest: latest || null, prior: null, pending, moves: [], reason: 'fewer than two filed quarters' };
  }

  const moves = [];
  for (const h of portfolio.holdings) {
    const change = classifyHolding(h, latest, prior);
    if (!change) continue; // disclosed in neither: nothing to say
    moves.push({ company: h.company, companySlug: h.companySlug, valueCr: h.valueCr, ...change });
  }

  return { comparable: true, latest, prior, pending, moves, reason: null };
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
  // THE LATEST *FILED* QUARTER, for the same reason `deriveMoves` uses it. Counting an open
  // "Filing Due" column as the current book made Madhusudan Kela hold one company instead of
  // fifteen and put his book at a fraction of its size — a card stating, in figures, that an
  // investor had liquidated. `latestQuarter` is what every surface prints as "as of", so it has to
  // name a quarter that was actually filed.
  const filed = portfolio?.filedQuarters || (portfolio?.quarters || []).filter((q) => isFiledQuarter(q));
  const [latest] = filed;
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

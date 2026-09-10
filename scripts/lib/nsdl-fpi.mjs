// scripts/lib/nsdl-fpi.mjs — THE NSDL FPI MONITOR CLIENT AND PARSERS. GLOW-OWNED.
//
// One depository publishes every figure behind the FPI Activity view, on four reports:
//
//   Debt Utilisation Status   ReportDetail.aspx?RepID=1   the OUTSTANDING investment FPIs hold in
//                                                         central government securities, state
//                                                         development loans and corporate bonds,
//                                                         one file per reporting date, archived
//                                                         back to 2011 behind a date dropdown.
//   Daily Trends              Monthly.aspx / Archive.aspx  the NET INVESTMENT of a single day, in
//                                                         NSDL's own route categories.
//   Calendar Year             Yearwise.aspx?RptType=6     the same net investment, by month, with
//                                                         the year's own published total row.
//   Financial Year            Yearwise.aspx?RptType=5     the same, by Indian financial year.
//
// EVERYTHING HERE IS PURE EXCEPT `fetchReport`, and that takes its fetch as a parameter — the same
// arrangement as `worker/nse-ann.mjs` and `worker/mc-news.mjs`, so every parser is testable offline
// against a saved page and the capture script knows nothing about ASP.NET.
//
// ── TWO THINGS THAT LOOK LIKE THEY WOULD WORK AND DO NOT ─────────────────────────────────────────
//
// 1. **THE COLUMNS OF THE GENERAL-LIMIT TABLE MOVE BETWEEN DATES, UNDER AN UNCHANGED HEADER.**
//    Measured on three consecutive reporting dates: 18-Aug-2026 and 14-Aug-2026 print eight cells
//    per row (Upper Limit first), and 17-Aug-2026 prints SEVEN — the Upper Limit cell is simply
//    absent — beneath the identical eight-column header. Read positionally, 17 August reports an
//    upper limit of 70,189 crore and an investment of 145 crore: both numbers are real, both are in
//    the right shape, and both are the wrong column. The span ids do not save you either
//    (`Label4` is the upper limit on one date and the investment on the next).
//
//    So the row is aligned by ARITHMETIC, not by position or by name: NSDL publish
//    `Investment + Unutilised Blocks + Investment VRR = Total Investment` in the table itself, and
//    `alignGeneralLimit` finds the only offset where that identity holds. A layout that changes
//    again fails loudly rather than returning a plausible number from the wrong column. Same rule
//    as `import-mf-weekly.mjs` reconciling every published median before it writes: the check is on
//    the parse, and the figure that ships is always the published one.
//
// 2. **A LEVEL IS NOT A FLOW, AND ONLY THE DEBT SIDE IS PUBLISHED AS A LEVEL.** The Debt
//    Utilisation Status answers "how much do FPIs hold", not "what did they buy today"; the day's
//    debt figure on the FPI Activity table is the CHANGE in that holding between two reporting
//    dates, which is a derivation and is labelled as one everywhere it surfaces. The equity figure
//    is not derived at all — NSDL publish equity net investment directly, and that published number
//    is what travels. The two must never be described in the same words.
//
// The derivation was checked against a desk circular for 17 and 14 August 2026 before it shipped:
// G-Sec −117 and −422, SDL +300 and 0, corporate bonds −76 and −343, each reproduced to the crore
// from the published levels. `scripts/verify-fpi-activity.mjs` keeps that fixture.

export const NSDL_BASE = 'https://www.fpi.nsdl.co.in/web/Reports';
export const DEBT_UTILISATION_URL = `${NSDL_BASE}/ReportDetail.aspx?RepID=1`;
export const DAILY_TRENDS_URL = `${NSDL_BASE}/Monthly.aspx`;
export const DAILY_TRENDS_ARCHIVE_URL = `${NSDL_BASE}/Archive.aspx`;
export const CALENDAR_YEAR_URL = `${NSDL_BASE}/Yearwise.aspx?RptType=6`;
export const FINANCIAL_YEAR_URL = `${NSDL_BASE}/Yearwise.aspx?RptType=5`;

// A weak user-agent is served a different page by NSDL's front end; a desktop one is not. This is
// the same reason `worker/nse-ann.mjs` carries a full browser string.
export const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-GB,en;q=0.9',
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const stripTags = (s) => s.replace(/<[^>]+>/g, ' ');
const decode = (s) =>
  s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
const text = (s) => decode(stripTags(s)).replace(/\s+/g, ' ').trim();

/**
 * NSDL write a negative as `(1,234.56)` on the daily and utilisation reports and as `-1234` on the
 * year-wise ones. A cell carrying no figure — `-`, `NA`, blank — is NULL, never zero: an instrument
 * the report did not answer for and an instrument at nil are different claims, and this dashboard
 * has been bitten by collapsing them before (see the `classifyHolding` rules in CLAUDE.md).
 */
export function num(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/ /g, ' ').trim();
  if (!s || /^(?:-|–|—|n\.?a\.?)$/i.test(s)) return null;
  const negative = /^\(.*\)$/.test(s);
  const body = s.replace(/^\(|\)$/g, '').replace(/,/g, '').replace(/^Rs\.?/i, '').trim();
  if (!/^[+-]?\d*\.?\d+$/.test(body)) return null;
  const n = Number(body);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** `August 18,2026` / `18-Aug-2026` / `18/08/2026` → `2026-08-18`, else null. */
export function isoDate(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  let m = /^([A-Za-z]+)\s+(\d{1,2})\s*,\s*(\d{4})$/.exec(s);
  if (m) {
    const i = MONTHS.indexOf(m[1].toLowerCase());
    if (i < 0) return null;
    return `${m[3]}-${String(i + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (m) {
    const i = MONTH_ABBR.indexOf(m[2].toLowerCase());
    if (i < 0) return null;
    return `${m[3]}-${String(i + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

// ---- HTML table helpers ------------------------------------------------------------------------

const tables = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, '').match(/<table[\s\S]*?<\/table>/gi) || [];
const tableRows = (table) => (table.match(/<tr[\s\S]*?<\/tr>/gi) || []).map((r) => (r.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(text));

// ---- 1. Debt Utilisation Status ----------------------------------------------------------------

/**
 * The archive dropdown: every reporting date NSDL still serves, newest first, each with the id the
 * postback wants. Both selects on the page carry the same list, so the first is enough.
 */
export function parseArchiveDates(html) {
  const select = /<select[^>]*name="(?:ddlSubReports|DropDownList1)"[\s\S]*?<\/select>/i.exec(html);
  if (!select) return [];
  const out = [];
  const seen = new Set();
  for (const m of select[0].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)) {
    const date = isoDate(text(m[2]));
    if (!date || seen.has(date)) continue;
    seen.add(date);
    out.push({ id: m[1], date });
  }
  return out;
}

export const parseAsOn = (html) => {
  const m = /Debt Utilisation Status as on\s*([^<]+)/i.exec(html);
  return m ? isoDate(text(m[1])) : null;
};

/**
 * Find the offset at which the row's own published identity holds. See the header: the general-
 * limit row loses its leading Upper Limit cell on some dates, so no fixed position and no span id
 * can be trusted. Returns null when no offset satisfies either identity — a shape change is
 * reported, never guessed around.
 *
 * NSDL RESTRUCTURED THIS REPORT IN 2026 and the archive serves both forms:
 *
 *   before   Instrument · Eligible Foreign Investors · Upper Limit · Investment · Unutilised
 *            Blocks · Total, with `Investment + Unutilised Blocks = Total`, and one row per
 *            investor category — `General` and `Long Term` on separate lines.
 *   after    Instrument · Upper Limit · Investment · Unutilised Blocks · Investment VRR · Total,
 *            with `Investment + Unutilised Blocks + Investment VRR = Total`, one row per
 *            instrument and the voluntary retention route carried in the same line.
 *
 * The three-term identity is tried FIRST. Tried the other way round, a two-term match inside a
 * modern row could land on a pair that happens to add up, and the whole point of aligning by
 * arithmetic is that only one alignment can be right.
 */
export function alignGeneralLimit(values) {
  const v = values.map(num);
  // A crore of tolerance against figures published to three decimals: generous, and still far
  // below anything that could mask a mis-aligned column.
  const holds = (sum, total) => Math.abs(sum - total) <= 1;
  for (let i = 0; i + 3 < v.length; i += 1) {
    const [a, b, c, d] = [v[i], v[i + 1], v[i + 2], v[i + 3]];
    if ([a, b, c, d].some((x) => x == null) || !(a > 0)) continue; // a zero prefix matches vacuously
    if (holds(a + b + c, d)) return { investment: a, unutilisedBlocks: b, vrr: c, total: d };
  }
  for (let i = 0; i + 2 < v.length; i += 1) {
    const [a, b, c] = [v[i], v[i + 1], v[i + 2]];
    if ([a, b, c].some((x) => x == null) || !(a > 0)) continue;
    // The older form has no VRR column at all. `null` rather than 0: the route is not reported on
    // that page, which is a different claim from a route reported at nil.
    if (holds(a + b, c)) return { investment: a, unutilisedBlocks: b, vrr: null, total: c };
  }
  return null;
}

/**
 * The outstanding investment behind the FPI Activity table's debt rows, plus the report date.
 * `gsec` and `sdl` come from the general-limit government-securities table; `corpBond` from the
 * corporate-bond limits table, whose own published identity is (B) + (C) = (D).
 *
 * Throws on a shape it cannot align. A capture that cannot read the page keeps the retained file.
 */
export function parseDebtOutstanding(html) {
  const asOn = parseAsOn(html);
  if (!asOn) throw Object.assign(new Error('No "Debt Utilisation Status as on <date>" heading — this is not the report page.'), { reason: 'shape' });

  let gsec = null;
  let sdl = null;
  let corpBond = null;
  let gsecLongTerm = null;
  let categorised = false;

  for (const table of tables(html)) {
    const flat = text(table);
    if (/Central Government Securities/i.test(flat) && /Unutilised Blocks/i.test(flat)) {
      for (const cells of tableRows(table)) {
        if (!cells.length) continue;
        if (!/^(Central|State) Government Securities$/i.test(cells[0])) continue;
        // On the older form the second cell names the investor category. `General` is the open
        // limit — the line a desk circular quotes and the one every window here is differenced on.
        // A `Long Term` row is a DIFFERENT limit with its own utilisation and is deliberately not
        // added in: folding two limits together would make a reallocation between them read as a
        // purchase. The modern form has no category cell and the whole row is the general route.
        const category = /^(General|Long Term)$/i.test(cells[1] || '') ? cells[1] : null;
        if (category) categorised = true;
        const aligned = alignGeneralLimit(cells.slice(category ? 2 : 1));
        if (!aligned) continue;
        if (category && !/^General$/i.test(category)) {
          // Kept, not used. The long-term investor limit is published on the older pages and not
          // on the newer ones; recording it is what makes "the headline is the general route"
          // a checkable statement rather than a claim about a column nobody can see any more.
          if (/^Central/i.test(cells[0])) gsecLongTerm = gsecLongTerm ?? aligned;
          continue;
        }
        if (/^Central/i.test(cells[0])) gsec = gsec ?? aligned;
        else sdl = sdl ?? aligned;
      }
    }
    // The corporate-bond limits table repeats near-identically as the coupon-re-investment table,
    // which carries only (A) and (B) and no sum. NSDL print the sum's definition in the header of
    // the one we want — `(D)=(B)+(C)` — on BOTH layouts, where the older names (C) the unutilised
    // auctioned limit and the newer names it the VRR route. Keying on the published identity is
    // what tells the two tables apart without caring which era the page is from.
    if (/\(D\)\s*=\s*\(B\)\s*\+\s*\(C\)/i.test(flat) && /Corporate Bonds/i.test(flat) && corpBond == null) {
      for (const cells of tableRows(table)) {
        const at = cells.findIndex((c) => /^Corporate Bonds$/i.test(c));
        if (at < 0) continue;
        const rest = cells.slice(at + 1).map(num).filter((n) => n != null);
        // …, upperLimit, (B), (C), (D), …  with (B) + (C) = (D).
        for (let i = 0; i + 2 < rest.length; i += 1) {
          if (rest[i] > 0 && Math.abs(rest[i] + rest[i + 1] - rest[i + 2]) <= 1) {
            corpBond = { investment: rest[i], vrr: rest[i + 1], total: rest[i + 2] };
            break;
          }
        }
        if (corpBond) break;
      }
    }
  }

  if (!gsec || !sdl || !corpBond) {
    throw Object.assign(
      new Error(
        `Debt Utilisation Status for ${asOn} parsed ${[gsec && 'G-Sec', sdl && 'SDL', corpBond && 'corporate bonds'].filter(Boolean).join(', ') || 'nothing'} — the table layout has changed.`,
      ),
      { reason: 'shape' },
    );
  }
  return {
    date: asOn,
    // The general route is the line the desk circular reports and the line every daily figure is
    // differenced from. The VRR route is a separate NSDL limit with its own window; it is carried
    // so the export can state it, and is never folded into the headline.
    gsec: gsec.investment,
    sdl: sdl.investment,
    corpBond: corpBond.investment,
    gsecVrr: gsec.vrr,
    sdlVrr: sdl.vrr,
    // (C) in the corporate-bond table is the VRR route on the newer pages and the unutilised
    // auctioned limit on the older ones — the same position, a different measurement. It is only
    // reported as VRR where the page actually says VRR.
    corpBondVrr: categorised ? null : corpBond.vrr,
    gsecLongTerm: gsecLongTerm?.investment ?? null,
    // Which era of the report this level was read from. A window that spans a change of layout is
    // a window in which the source changed what it was counting, and the reader is owed that
    // rather than a difference presented as a day's trading.
    layout: categorised ? 'by-investor-category' : 'single-line',
  };
}

// ---- 2. Daily Trends ---------------------------------------------------------------------------

const FLOW_KEYS = {
  equity: /^Equity$/i,
  debtGeneral: /^Debt-?\s*General\s*Limit$/i,
  debtVrr: /^Debt-?\s*VRR$/i,
  debtFar: /^Debt-?\s*FAR$/i,
  hybrid: /^Hybrid$/i,
  mutualFunds: /^Mutual\s*Funds?$/i,
  aifs: /^AIFs?$/i,
};

/**
 * Every reporting date on a Daily Trends page (Monthly.aspx is the current month; Archive.aspx
 * answers with an earlier one), as NSDL's own NET INVESTMENT per category.
 *
 * The page is one long table in which a date, a category and an investment route each open a
 * rowspan, so a row carries between one and six cells depending on where it sits. Rather than model
 * that, the reader walks the rows carrying state: the last date seen, the last category seen, and
 * it takes the figure from the `Sub-total` row of each category — which is the number NSDL print as
 * that category's net investment for the day, stock exchange plus primary market.
 */
export function parseDailyTrends(html) {
  const byDate = new Map();
  for (const table of tables(html)) {
    if (!/Daily Trends in FPI Investments/i.test(text(table)) && !/Net Investment/i.test(text(table))) continue;
    let date = null;
    let category = null;
    for (const cells of tableRows(table)) {
      if (!cells.length) continue;
      // THE ARCHIVE PAGE ENDS WITH A CUMULATIVE BLOCK — `Total for 2026` — that belongs to no
      // reporting date and repeats the whole category layout. The date carried by the walk is
      // still the last day of the requested month when it starts, so without this the year's
      // running total is filed as that day's trading: measured on August 2026, 31 August came out
      // at −224,442 crore of equity against its real −270. Closing the date is what ends the walk.
      if (cells.some((c) => /^Total\s+for\b/i.test(c))) date = null;
      for (const c of cells) {
        const d = isoDate(c);
        if (d) date = d;
      }
      if (!date) continue;
      const named = cells.find((c) => Object.values(FLOW_KEYS).some((re) => re.test(c)));
      if (named) category = Object.keys(FLOW_KEYS).find((k) => FLOW_KEYS[k].test(named));
      const isSubtotal = cells.some((c) => /^Sub-?total$/i.test(c));
      const isTotal = cells.some((c) => /^Total$/i.test(c));
      if (!isSubtotal && !isTotal) continue;
      // Gross purchases, gross sales, net investment (INR), net investment (USD) — the third
      // number is the one NSDL label "Net Investment (Rs. Crore)". A `Total` row carries the same
      // three without a category.
      const figures = cells.map(num).filter((n) => n != null);
      if (figures.length < 3) continue;
      const net = figures[2];
      const row = byDate.get(date) || { date };
      if (isTotal) row.total = net;
      else if (category) row[category] = net;
      byDate.set(date, row);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ---- 3 & 4. Year-wise net investment -----------------------------------------------------------

// Both year-wise tables print one block of twelve figures per period, in this order, under a
// two-deep header. Reproduced as NSDL order them; nothing is re-banded or renamed.
const YEAR_FIELDS = ['equity', 'debtGeneral', 'debtVrr', 'debtFar', 'hybrid', 'mfEquity', 'mfDebt', 'mfHybrid', 'mfSolutionOriented', 'mfOther', 'aifs', 'total'];
const BLOCK = YEAR_FIELDS.length + 1;

function yearBlocks(html, label) {
  for (const table of tables(html)) {
    for (const cells of tableRows(table)) {
      if (cells.length < BLOCK * 2 || !label.test(cells[0])) continue;
      const out = [];
      for (let i = 0; i + BLOCK <= cells.length; i += BLOCK) {
        const period = cells[i];
        const values = cells.slice(i + 1, i + BLOCK).map(num);
        out.push({ period, values });
      }
      return out;
    }
  }
  return [];
}

const withFields = (values) => Object.fromEntries(YEAR_FIELDS.map((k, i) => [k, values[i] ?? null]));

/**
 * `Yearwise.aspx?RptType=6` — one calendar year, month by month, ending with the year's OWN total
 * row (`Total - 2025`). A month still running is marked `**` upstream and travels as `partial`,
 * because a part-month total and a closed one are different claims.
 */
export function parseCalendarYear(html) {
  const year = /Monthly FPI Net Investments \(Calendar Year - (\d{4})\)/i.exec(html)?.[1] || null;
  const blocks = yearBlocks(html, /^January\b/i);
  const months = [];
  let total = null;
  for (const { period, values } of blocks) {
    const partial = /\*\*/.test(period);
    const name = period.replace(/\*+/g, '').trim();
    const totalMatch = /^Total\s*-\s*(\d{4})$/i.exec(name);
    if (totalMatch) {
      total = { period: totalMatch[1], partial, ...withFields(values) };
      continue;
    }
    const i = MONTHS.indexOf(name.toLowerCase());
    if (i < 0 || !year) continue;
    months.push({ period: `${year}-${String(i + 1).padStart(2, '0')}`, partial, ...withFields(values) });
  }
  // NSDL mark the running MONTH with `**` and leave the year's total row unmarked, so a year still
  // in progress would otherwise travel as closed. A part-year total and a closed one are different
  // claims and the view labels them differently, so the flag is carried up from the months.
  if (total && months.some((m) => m.partial)) total.partial = true;
  return { year, months, total };
}

/**
 * `Yearwise.aspx?RptType=5` — every Indian financial year since 1992-93, one row each, with the
 * running one marked `**`. The last row is NSDL's all-time total and is dropped: it is not a year.
 */
export function parseFinancialYears(html) {
  const out = [];
  for (const table of tables(html)) {
    for (const cells of tableRows(table)) {
      if (cells.length < BLOCK) continue;
      const period = cells[0].replace(/\*+/g, '').trim();
      if (!/^\d{4}-\d{2}$/.test(period)) continue;
      const values = cells.slice(1, BLOCK).map(num);
      if (values.every((v) => v == null)) continue;
      out.push({ period, partial: /\*\*/.test(cells[0]), ...withFields(values) });
    }
  }
  return out.sort((a, b) => a.period.localeCompare(b.period));
}

// ---- the ASP.NET postback --------------------------------------------------------------------

/**
 * Every hidden input on the page, replayed verbatim. WebForms rejects a post that omits one — the
 * first attempt at the archive sent only `__VIEWSTATE` and was redirected to Error.aspx, which
 * reads exactly like the report being unavailable.
 */
export function hiddenFields(html) {
  const out = {};
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const name = /name="([^"]*)"/i.exec(m[0])?.[1];
    if (!name || name.includes("' +")) continue; // a template literal in NSDL's own inline script
    out[name] = decode(/value="([^"]*)"/i.exec(m[0])?.[1] ?? '');
  }
  return out;
}

export const formBody = (fields) => new URLSearchParams(fields).toString();

/**
 * GET a report, or POST a postback against one. `fetchImpl` is a parameter so the parsers above can
 * be exercised offline; `timeoutMs` bounds every hop, as `worker/finology.mjs` does.
 */
export async function fetchReport(url, { fetchImpl = fetch, body = null, referer = url, timeoutMs = 45000 } = {}) {
  const res = await fetchImpl(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { ...HEADERS, referer, 'content-type': 'application/x-www-form-urlencoded' } : { ...HEADERS, referer },
    body: body || undefined,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const html = await res.text();
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${url}`), { reason: 'upstream', status: res.status });
  // WebForms answers a rejected postback with a 302 to Error.aspx, which `redirect: 'follow'` turns
  // into a 200 carrying an error page. A 200 that is not the page you asked for is not evidence
  // about that page — the same trap as BSE's `strCat=-1` and Moneycontrol's interstitial.
  if (/Error\.aspx/i.test(html) && html.length < 4000) throw Object.assign(new Error(`NSDL refused the request for ${url}`), { reason: 'refused' });
  return html;
}

/** Ask the Debt Utilisation report for one archived reporting date. */
export function archivePostBody(basePageHtml, optionId) {
  const fields = hiddenFields(basePageHtml);
  return formBody({
    ...fields,
    __EVENTTARGET: 'ddlSubReports',
    __EVENTARGUMENT: '',
    __LASTFOCUS: '',
    ddlSubReports: optionId,
    DropDownList1: optionId,
    txtRegNo: '',
  });
}

/** Ask the calendar-year report for a year other than the current one. */
export function calendarYearPostBody(basePageHtml, year) {
  const fields = hiddenFields(basePageHtml);
  return formBody({ ...fields, __EVENTTARGET: 'ddl', __EVENTARGUMENT: '', ddl: String(year) });
}

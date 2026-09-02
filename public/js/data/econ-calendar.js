// data/econ-calendar.js — the economic release calendar, read side. GLOW-OWNED.
//
//   fetchCalendar(from, to, countries)   → { ok: true, events, … } | { ok: false, failureCode, … }
//   plus the derived-figure helpers the table uses: impactOf, categoryLabel, fmtEconValue,
//   surpriseOf, surpriseDirection, eventTime, dayOf, isDayOnly, byDay, shiftDate, calendarReason.
//
// Backed by `GET /api/econ-calendar` on this dashboard's Worker (worker/econ-calendar.mjs), a proxy
// for TradingView's calendar endpoint — the upstream needs Origin/Referer headers a browser cannot
// set. A port of `src/lib/econCalendar.ts` in techmuns/GlowVentures; every rule in here is one
// where the wrong answer looks plausible on screen, so the rules are kept identical:
//
//   • IMPORTANCE IS -1 / 0 / 1 AND THE MAPPING WAS VERIFIED, not assumed: 1 is Non Farm Payrolls
//     and the ISM PMIs, -1 is bill auctions. An UNRANKED release stays unranked, never "low".
//   • SURPRISE NEEDS BOTH HALVES — actual less consensus, only where both are published. A surprise
//     struck against a missing consensus is the whole actual dressed up as a beat.
//   • AND IT CARRIES NO VERDICT. Whether a beat is good news depends on the indicator, and nothing
//     in the feed says which way round each one runs. The sign is shown; the meaning is the reader's.
//   • A RELEASE WITH NO ANNOUNCED TIME MUST NOT MOVE A DAY. The source stamps those at midnight UTC;
//     in a zone behind UTC that lands on the previous day. They are day-only, on the source's date.

const BASE = 'api/econ-calendar';

export async function fetchCalendar(from, to, countries = []) {
  const q = new URLSearchParams({ from, to });
  if (countries.length) q.set('countries', countries.join(','));
  const url = `${BASE}?${q}`;
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    const d = await r.json().catch(() => null);
    if (!d || d.ok !== true) {
      return { ok: false, failureCode: d?.failureCode ?? (d?.reason ? `REASON_${String(d.reason).toUpperCase()}` : `HTTP_${r.status}`), upstreamStatus: d?.upstreamStatus ?? null, httpStatus: r.status, detail: d?.detail ?? d?.message ?? null, requestedUrl: url };
    }
    return d;
  } catch (e) {
    return { ok: false, failureCode: 'NETWORK', upstreamStatus: null, httpStatus: null, detail: e instanceof Error ? e.message : String(e), requestedUrl: url };
  }
}

export const isCalendarError = (r) => !r || r.ok === false;

/** The reader's sentence for a calendar that could not be fetched. */
export function calendarReason(e) {
  if (e.failureCode === 'RANGE_TOO_WIDE') return 'That date range is wider than this feed will answer in one request.';
  if (e.failureCode === 'BAD_RANGE') return 'That date range could not be read.';
  if (e.failureCode === 'HTTP_404' || e.failureCode === 'HTTP_405') return 'There is no /api/econ-calendar on this origin — the calendar needs this dashboard\'s Worker, not a static file server. Run it through `npx wrangler dev` or open the deployed site.';
  if (e.failureCode === 'NETWORK') return `The request could not be made${e.detail ? ` (${e.detail})` : ''}.`;
  if (e.failureCode === 'UPSTREAM_NO_RESPONSE') return 'The calendar feed did not answer in time.';
  return `The calendar feed returned an error${e.upstreamStatus ? ` (${e.upstreamStatus})` : e.httpStatus ? ` (HTTP ${e.httpStatus})` : ''}.`;
}

export const impactOf = (importance) => (importance === 1 ? 'high' : importance === 0 ? 'medium' : importance === -1 ? 'low' : 'unranked');
export const IMPACT_LABEL = { high: 'High', medium: 'Medium', low: 'Low', unranked: 'Unranked' };
export const IMPACTS = ['high', 'medium', 'low', 'unranked'];

/** The upstream's category codes, spelled out. An unknown code shows as-is. */
export const CATEGORY_LABEL = {
  prce: 'Prices & inflation', lbr: 'Labour', gdp: 'Growth', mny: 'Money & rates', gov: 'Government', trd: 'Trade',
  bsnss: 'Business', cnsm: 'Consumer', hse: 'Housing', bnd: 'Bonds', enrg: 'Energy', mrkt: 'Markets',
};
export const categoryLabel = (c) => (c ? CATEGORY_LABEL[c] ?? c : 'Uncategorised');

/** The book is Indian, so these two lead; every country the feed carries is selectable. */
export const DEFAULT_COUNTRIES = ['IN', 'US'];
export const COUNTRY_NAME = {
  IN: 'India', US: 'United States', EU: 'Euro Zone', GB: 'United Kingdom', CN: 'China', JP: 'Japan', DE: 'Germany', FR: 'France',
  HK: 'Hong Kong', SG: 'Singapore', AU: 'Australia', CA: 'Canada', CH: 'Switzerland', KR: 'South Korea', BR: 'Brazil', RU: 'Russia',
  ZA: 'South Africa', IT: 'Italy', ES: 'Spain', NZ: 'New Zealand',
};

/** A value WITH ITS UNIT: 4.45 is a percent, 692.87 is billions. Null stays null — never 0. */
export function fmtEconValue(v, unit, currency) {
  if (v == null || !Number.isFinite(v)) return null;
  const n = v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  if (!unit) return n;
  const u = unit.trim();
  if (/^[$€£¥₹]$/.test(u)) return `${u}${n}`;
  if (u === '%') return `${n}%`;
  if (/^[KMBT]$/.test(u)) return `${n}${u}`;
  return `${n} ${u}`;
}

/** Actual less consensus, ONLY when both are numbers. */
export function surpriseOf(e) {
  if (e.actual == null || e.forecast == null) return null;
  return e.actual - e.forecast;
}
export const surpriseDirection = (s) => (s == null ? null : s > 0 ? 'above' : s < 0 ? 'below' : 'in line');

/** Local-time HH:MM, in the reader's own zone. */
export function eventTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function eventDay(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const isDayOnly = (iso) => typeof iso === 'string' && (iso.endsWith('T00:00:00.000Z') || iso.endsWith('T00:00:00Z'));
export const dayOf = (iso) => (isDayOnly(iso) ? iso.slice(0, 10) : eventDay(iso));

/** Group events into days, in chronological order. */
export function byDay(events) {
  const m = new Map();
  for (const e of events) {
    const d = dayOf(e.date);
    (m.get(d) ?? m.set(d, []).get(d)).push(e);
  }
  return [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, evs]) => ({ day, events: evs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.title.localeCompare(b.title))) }));
}

/** ISO date N days from a base, as YYYY-MM-DD in local time. */
export function shiftDate(base, days) {
  const d = new Date(base.getTime() + days * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The four windows the reference calendars offer. */
export const CAL_RANGES = [
  { key: 'today', label: 'Today', of: (t) => [shiftDate(t, 0), shiftDate(t, 1)] },
  { key: 'week', label: 'This week', of: (t) => [shiftDate(t, -t.getDay()), shiftDate(t, 7 - t.getDay())] },
  { key: 'next', label: 'Next 30 days', of: (t) => [shiftDate(t, 0), shiftDate(t, 30)] },
  { key: 'past', label: 'Past 30 days', of: (t) => [shiftDate(t, -30), shiftDate(t, 1)] },
];

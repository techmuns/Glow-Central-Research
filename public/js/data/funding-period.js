// GLOW-OWNED. The Private Market funding table's period: quick picks plus a From–To range, read on
// each deal's own FUNDING date — Inc42's "Date" column for the round (`dateISO`), not the day the
// weekly roundup that listed it was published. A row whose source printed no readable date falls
// back to its roundup's publication day in IST, so it stays reachable rather than vanishing from
// every bounded range; a row with neither is reachable only under All captured history.
//
// A filter value is one string, so a saved reading, the URL-free view memory and a repaint all carry
// it unchanged: 'latest' | '1m' | '3m' | '6m' | '12m' | 'all' | 'range:<from>:<to>' (either side may
// be empty, both inclusive, ISO dates).

export const PERIOD_PICKS = [
  { value: 'latest', label: 'Latest captured week' },
  { value: '1m', label: 'Last 1 month', months: 1 },
  { value: '3m', label: 'Last 3 months', months: 3 },
  { value: '6m', label: 'Last 6 months', months: 6 },
  { value: '12m', label: 'Last 12 months', months: 12 },
  { value: 'all', label: 'All captured history' },
];
const MONTHS = Object.fromEntries(PERIOD_PICKS.filter(p => p.months).map(p => [p.value, p.months]));
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDay(value) {
  const m = ISO.exec(String(value || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Today's date in India, as YYYY-MM-DD. */
export function istToday(now = Date.now()) {
  return new Date(now + 330 * 60000).toISOString().slice(0, 10);
}

/** The same calendar day `months` earlier, clamped to that month's last day (31 Mar − 1m = 28/29 Feb). */
export function monthsBefore(day, months) {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** The deal's funding date: the source's own round date, else its roundup's publication day (IST). */
export function fundingDay(row) {
  if (isIsoDay(row?.dateISO)) return row.dateISO;
  const published = Date.parse(row?.publishedAt || '');
  return Number.isFinite(published) ? istToday(published) : '';
}

export function parseRange(value) {
  const m = /^range:([^:]*):([^:]*)$/.exec(String(value || ''));
  if (!m) return null;
  const from = m[1], to = m[2];
  if ((from && !isIsoDay(from)) || (to && !isIsoDay(to)) || (!from && !to)) return null;
  return { from, to };
}
export const isRangeValue = value => parseRange(value) !== null;

/** A From–To pair as a filter value; reversed ends are swapped, and two empty ends mean All. */
export function rangeValue(from, to) {
  from = isIsoDay(from) ? from : ''; to = isIsoDay(to) ? to : '';
  if (!from && !to) return 'all';
  if (from && to && from > to) [from, to] = [to, from];
  return `range:${from}:${to}`;
}

/** Older readings saved a roundup YEAR ('2026'); read one as that calendar year's range. */
export function normalizePeriod(value) {
  const v = String(value ?? '');
  if (PERIOD_PICKS.some(p => p.value === v) || isRangeValue(v)) return v;
  if (/^20\d{2}$/.test(v)) return `range:${v}-01-01:${v}-12-31`;
  return v;
}

/** Inclusive { from, to } bounds a value selects, or null where it is not a date bound (All, Latest). */
export function periodBounds(value, today = istToday()) {
  if (MONTHS[value]) return { from: monthsBefore(today, MONTHS[value]), to: today };
  return parseRange(value);
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const formatDay = day => (isIsoDay(day) ? DAY_FORMAT.format(new Date(`${day}T00:00:00Z`)) : '');

export function rangeLabel(value) {
  const r = parseRange(value);
  if (!r) return '';
  if (r.from && r.to) return r.from === r.to ? formatDay(r.from) : `${formatDay(r.from)} – ${formatDay(r.to)}`;
  return r.from ? `From ${formatDay(r.from)}` : `Up to ${formatDay(r.to)}`;
}

/** A row-predicate factory: one bounds computation per value, not one per row. */
export function periodMatcher({ latestUrl = null, today = istToday() } = {}) {
  const cache = new Map();
  return (row, value) => {
    if (!value || value === 'all') return true;
    if (value === 'latest') return !!latestUrl && row.sourceUrl === latestUrl;
    if (!cache.has(value)) cache.set(value, periodBounds(value, today));
    const bounds = cache.get(value);
    if (!bounds) return true;
    const day = fundingDay(row);
    if (!day) return false;
    return (!bounds.from || day >= bounds.from) && (!bounds.to || day <= bounds.to);
  };
}

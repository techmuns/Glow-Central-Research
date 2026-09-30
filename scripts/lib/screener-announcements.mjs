// Public exchange notices discovered through Screener's authenticated ALL-announcements index.
// Provider text is data: keep the filing title/link/time, never its generated summary or instructions.
export const SCREENER_ANNOUNCEMENTS_URL = 'https://www.screener.in/announcements/all/';
const IST = 19800000, HOUR = 3600000, DAY = 24 * HOUR;
const decode = value => String(value || '').replace(/&#(x[\da-f]+|\d+);/gi, (_, raw) => {
  const n = raw[0].toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : Number(raw);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}).replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (_, k) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[k.toLowerCase()]);
const text = value => decode(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (html, name) => {
  // Raw HTML may leave simple values unquoted; a saved browser DOM adds quotes to them.
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(html || '');
  return decode(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
};
const iso = value => new Date(value).toISOString();
const invalidSource = code => Object.assign(Error(`Announcement index rejected: ${code}`), { captureReason: code });
const validInstant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function screenerRecoveryCheckpoint(value) {
  if (value?.bootstrap !== true) return value;
  // The release includes an explicitly unavailable initial asset so first readers do not 404.
  // Only the pristine empty marker may initialise collection; it cannot reset captured history.
  if (value.version === 1 && value.rowCount === 0 && ['rows', 'ranges', 'pending'].every(k => Array.isArray(value[k]) && !value[k].length)
    && !value.enqueuedThrough && !value.captureStart && !value.lastPageAt && !value.lastSuccessAt) return null;
  throw Error('Invalid bootstrap capture; existing history must not be reset');
}

export function screenerCursorAt(instant) {
  const local = iso(Date.parse(instant) + IST);
  return `?ts=${local.slice(0, 19).replace(/[T:]/g, '-')}-${local.slice(20, 23)}000&same_ts_offset_count=0`;
}

export function screenerCursor(value) {
  const url = new URL(decode(value), SCREENER_ANNOUNCEMENTS_URL);
  if (url.origin !== 'https://www.screener.in' || url.pathname !== '/announcements/all/' || url.hash || url.username || url.password
    || [...url.searchParams.keys()].some(k => !['ts', 'same_ts_offset_count'].includes(k))
    || url.searchParams.getAll('ts').length !== 1 || url.searchParams.getAll('same_ts_offset_count').length !== 1) throw invalidSource('cursor-shape');
  const stamp = url.searchParams.get('ts'), offset = url.searchParams.get('same_ts_offset_count');
  const m = /^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{6})$/.exec(stamp || '');
  const instant = m && `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5].slice(0, 3)}+05:30`;
  if (!instant || !validInstant(instant) || iso(Date.parse(instant) + IST).slice(0, 19) !== `${m[1]}T${m[2]}:${m[3]}:${m[4]}`
    || !/^\d{1,7}$/.test(offset || '')) throw invalidSource('cursor-shape');
  return { query: url.search, stamp, time: Date.parse(instant), offset: Number(offset) };
}

const indiaDay = time => iso(time + IST).slice(0, 10);
function announcementBlocks(html) {
  const blocks = [];
  let depth = 0, active = null;
  for (const match of html.matchAll(/<\/?div\b[^>]*>/gi)) {
    if (/^<\//.test(match[0])) {
      depth--;
      if (active && depth === active.depth) {
        blocks.push({ ...active, end: match.index + match[0].length, html: html.slice(active.content, match.index) });
        active = null;
      }
    } else {
      if (/\bannouncement-item\b/.test(attr(match[0], 'class'))) {
        if (active) throw invalidSource('nested-record');
        active = { start: match.index, content: match.index + match[0].length, depth };
      }
      depth++;
    }
  }
  if (active) throw invalidSource('record-incomplete');
  return blocks;
}
function groupDate(label, { now, prior, next }) {
  if (/^today$/i.test(label)) return indiaDay(now);
  if (/^yesterday$/i.test(label)) return indiaDay(now - DAY);
  const clean = label.replace(/^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?),?\s+/i, '');
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?(?:,?\s+(\d{4}))?$/i.exec(clean);
  const monthFirst = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/i.exec(clean);
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const word = (dayFirst?.[2] || monthFirst?.[1] || '').toLowerCase().replace(/^sept$/, 'september');
  const month = months.findIndex(m => m === word || m.slice(0, 3) === word);
  if (month < 0) return /^\d{4}-\d{2}-\d{2}$/.test(clean) && indiaDay(Date.parse(`${clean}T00:00:00+05:30`)) === clean ? clean : null;
  const day = Number(dayFirst?.[1] || monthFirst?.[2]), explicitYear = Number(dayFirst?.[3] || monthFirst?.[3]);
  const upper = indiaDay(prior?.time ?? now), lower = indiaDay(next.time);
  const anchorYear = Number(upper.slice(0, 4));
  const candidates = (explicitYear ? [explicitYear] : [anchorYear - 1, anchorYear, anchorYear + 1]).map(year =>
    `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  ).filter(date => {
    const stamp = Date.parse(`${date}T00:00:00+05:30`);
    return Number.isFinite(stamp) && indiaDay(stamp) === date && (explicitYear || date >= lower && date <= upper);
  });
  if (candidates.length !== 1) throw invalidSource('date-group-ambiguous');
  return candidates[0];
}

export function parseScreenerAnnouncements(html, { cursor = null, now = Date.now() } = {}) {
  if (typeof html !== 'string' || !/<\/main\s*>/i.test(html) || !/Latest Announcements/i.test(html)
    || /<form[^>]+action=["']\/login\//i.test(html)) throw invalidSource('index-incomplete');
  const button = /<button\b([^>]*\bdata-swap=["']#show-more-[^"']*["'][^>]*)>/i.exec(html);
  if (!button) throw invalidSource('pagination-unavailable');
  const next = screenerCursor(/Utils\.ajaxLoad\(event,\s*'([^']+)'\)/.exec(attr(button[1], 'onclick'))?.[1] || '');
  const prior = cursor ? screenerCursor(cursor) : null;
  const blocks = announcementBlocks(html);
  if (!blocks.length) throw invalidSource('index-empty-unverified');
  // Older records use a shared date heading (e.g. Yesterday), with no per-record time.
  // Only headings OUTSIDE a record can supply its date; summaries cannot change date context.
  const groups = [...html.matchAll(/<div\b[^>]*>([^<>]{1,80})<\/div\s*>/gi)]
    .filter(m => !blocks.some(block => m.index >= block.start && m.index < block.end))
    .map(m => ({ index: m.index, date: groupDate(text(m[1]), { now, prior, next }) })).filter(g => g.date);
  const rows = blocks.map(block => {
    const links = [...block.html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)].slice(0, 2);
    const companyUrl = new URL(attr(links[0]?.[1], 'href'), SCREENER_ANNOUNCEMENTS_URL);
    const companyMatch = /^\/company\/([A-Z0-9&._-]{1,80})\/(?:consolidated\/)?$/i.exec(decodeURIComponent(companyUrl.pathname));
    if (companyUrl.origin !== 'https://www.screener.in' || !companyMatch) throw invalidSource('company-shape');
    const companyKey = companyMatch[1].toUpperCase(), company = text(links[0][2]);
    const url = new URL(attr(links[1]?.[1], 'href'), SCREENER_ANNOUNCEMENTS_URL);
    // Some notices (e.g. an exchange seeking clarification) have no attachment. Screener
    // points to its issuer page instead. Retain the notice, but never call that page a PDF.
    const referenceOnly = url.origin === 'https://www.screener.in' && /^\/company\/id\/\d+\/$/.test(url.pathname) && !url.search && !url.hash;
    // Exchange filings also arrive as ZIP/XBRL and other attachment formats. A filename
    // extension is not a completeness rule; retain the original HTTPS exchange link.
    const source = ['www.bseindia.com', 'bseindia.com'].includes(url.hostname) ? 'BSE'
      : ['nsearchives.nseindia.com', 'archives.nseindia.com'].includes(url.hostname) ? 'NSE' : referenceOnly ? 'Screener' : null;
    const timeTag = /<time\b([^>]*)>/i.exec(links[1]?.[2] || '');
    const publishedAt = attr(timeTag?.[1], 'datetime'), stamp = Date.parse(publishedAt);
    if (timeTag && (!/T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+05:30$/.test(publishedAt) || !Number.isFinite(stamp) || stamp > now + 5 * 60000)) throw invalidSource('record-time');
    const group = groups.filter(g => g.index < block.start).at(-1)?.date;
    const date = timeTag ? indiaDay(stamp) : group;
    // The title precedes the PDF icon/time/optional AI blurb. Never import a generated blurb.
    const title = text((links[1]?.[2] || '').split(/<(?:i|time|span|div)\b/i)[0]);
    if (!company || !title || !source || !date || date > indiaDay(now) || url.protocol !== 'https:' || url.username || url.password
      || url.pathname === '/') throw invalidSource('record-shape');
    if (timeTag && group && date !== group) throw invalidSource('date-group-mismatch');
    return { ticker: /^\d{6}$/.test(companyKey) ? `BSE:${companyKey}` : companyKey,
      ...(/^\d{6}$/.test(companyKey) ? { scripCode: companyKey } : {}),
      company, companyUrl: companyUrl.href, title, url: referenceOnly ? null : url.href, date,
      ...(referenceOnly ? { referenceUrl: url.href, documentUnavailable: true } : {}),
      ...(timeTag ? { time: iso(stamp + IST).slice(11, 19), publishedAt: iso(stamp) } : {}),
      source, sources: [source], providers: ['Screener announcements'] };
  });
  for (let i = 1; i < rows.length; i++) if (rows[i].date > rows[i - 1].date ||
    rows[i].publishedAt && rows[i - 1].publishedAt && rows[i].publishedAt > rows[i - 1].publishedAt) throw invalidSource('record-order');
  const linked = rows.filter(r => r.url);
  if (new Set(linked.map(r => `${r.ticker}|${r.url}`)).size !== linked.length) throw invalidSource('repeated-record');
  const last = rows.at(-1);
  if (last.date !== indiaDay(next.time) || last.publishedAt && next.time !== Date.parse(last.publishedAt)) throw invalidSource('cursor-record-mismatch');
  if (prior && (rows[0].date > indiaDay(prior.time) || Date.parse(rows[0].publishedAt || '') > prior.time || next.stamp > prior.stamp
    || next.stamp === prior.stamp && next.offset <= prior.offset)) throw invalidSource('pagination-stalled');
  return { rows, next: next.query };
}

function mergeIntervals(ranges, incoming) {
  const out = [];
  for (const range of [...ranges, incoming].sort((a, b) => a.from.localeCompare(b.from))) {
    const last = out.at(-1);
    if (last && range.from <= last.to) last.to = last.to > range.to ? last.to : range.to;
    else out.push({ from: range.from, to: range.to });
  }
  return out;
}

// Fixed upper timestamps + the provider's tie offset keep new arrivals from shifting later pages.
// Fresh windows are queued independently of unfinished history. A page checkpoint is committed only
// AFTER its records; a killed process replays pages instead of moving past unsaved disclosures.
export async function collectScreenerAnnouncements({ previous = null, readPage, checkpoint,
  initialFrom = null, now = Date.now, sourceNow = now, maxPages = 600, budgetMs = 12 * 60000 } = {}) {
  const started = now(), at = iso(started), wallStarted = performance.now();
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || budgetMs < 1) throw Error('Invalid announcement capture budget');
  if (previous && (previous.version !== 1 || !Array.isArray(previous.pending) || !Array.isArray(previous.ranges)
    || !validInstant(previous.enqueuedThrough))) throw Error('Invalid announcement checkpoint; retain it for recovery');
  const state = structuredClone(previous || { version: 1, pending: [], ranges: [], captureStart: initialFrom || iso(started - 7 * DAY) });
  delete state.rows;
  delete state.rowCount;
  if (!validInstant(state.captureStart) || state.captureStart >= at) throw Error('Invalid announcement capture start');
  if (previous && previous.enqueuedThrough > at) throw Error('Announcement clock moved behind the saved checkpoint');
  for (const range of state.ranges) if (!validInstant(range.from) || !validInstant(range.to) || range.from >= range.to || range.to > at) throw Error('Invalid verified announcement interval');
  for (const job of state.pending) {
    if (!validInstant(job.from) || !validInstant(job.to) || job.from >= job.to || job.to > at || !Number.isSafeInteger(job.pages) || job.pages < 0) throw Error('Invalid pending announcement window');
    if (screenerCursor(job.cursor).time > Date.parse(job.to)) throw Error('Announcement cursor moved beyond its saved window');
  }
  if (Date.parse(state.nextRetryAt || '') > started) {
    state.pagesThisRun = 0;
    await checkpoint(state, [], { force: true });
    return state;
  }
  const freshFrom = previous ? iso(Math.max(Date.parse(state.captureStart), Date.parse(previous.enqueuedThrough) - 2 * HOUR)) : state.captureStart;
  if (!validInstant(freshFrom) || freshFrom >= at) throw Error('Invalid announcement recovery interval');
  const job = { from: freshFrom, to: at, cursor: screenerCursorAt(at), pages: 0, kind: 'recent' };
  // Unstarted windows can coalesce. Never replace a saved pagination cursor with a newer head.
  state.pending = state.pending.filter(p => {
    if (p.pages || p.to < job.from || p.from > job.to) return true;
    job.from = p.from < job.from ? p.from : job.from;
    return false;
  });
  state.pending.push(job);
  state.enqueuedThrough = at;
  if (previous && started - (Date.parse(state.reconcileQueuedAt || '') || 0) >= DAY && !state.pending.some(p => p.kind === 'reconcile')) {
    const from = iso(Math.max(Date.parse(state.captureStart), started - 7 * DAY));
    state.pending.push({ from, to: at, cursor: screenerCursorAt(at), pages: 0, kind: 'reconcile' });
    state.reconcileQueuedAt = at;
  } else if (!previous) state.reconcileQueuedAt = at;
  state.lastAttemptAt = at;
  state.error = null;
  state.nextRetryAt = null;
  let pages = 0;
  await checkpoint(state, [], { force: true });
  // Give arrivals ten pages, then give every unfinished window a fair turn. Queue length and
  // missing intervals remain visible when source volume exceeds the configured run budget.
  let selected = job, burst = 0;
  while (state.pending.length && pages < maxPages && now() - started < budgetMs && performance.now() - wallStarted < budgetMs) {
    let parsed;
    try {
      parsed = parseScreenerAnnouncements(await readPage(selected.cursor), { cursor: selected.cursor, now: sourceNow() });
    } catch (error) {
      state.error = { at: iso(now()), reason: error.captureReason || 'source-or-shape', message: 'Screener announcements could not be fully checked. Saved rows and pagination are retained.' };
      if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) state.nextRetryAt = iso(now() + error.retryAfterMs);
      break;
    }
    const incoming = parsed.rows.filter(row => row.publishedAt ? row.publishedAt >= selected.from && row.publishedAt <= selected.to
      : row.date >= indiaDay(Date.parse(selected.from)) && row.date <= indiaDay(Date.parse(selected.to)));
    selected.cursor = parsed.next;
    selected.pages++;
    pages++;
    state.lastPageAt = iso(now());
    state.totalPages = (state.totalPages || 0) + 1;
    if (screenerCursor(parsed.next).time < Date.parse(selected.from)) {
      state.ranges = mergeIntervals(state.ranges, selected);
      state.pending = state.pending.filter(p => p !== selected);
      state.lastCompletedAt = iso(now());
      burst = 10;
    }
    await checkpoint(state, incoming);
    if (++burst >= 10 || !state.pending.includes(selected)) {
      // Oldest unfinished work first, with round-robin bursts once it has had its turn.
      const remaining = state.pending.filter(p => p !== selected);
      if (remaining.length) selected = remaining.sort((a, b) => (a.lastTurn || '').localeCompare(b.lastTurn || '') || a.from.localeCompare(b.from))[0];
      if (selected) selected.lastTurn = iso(now());
      burst = 0;
    }
  }
  state.updatedAt = iso(now());
  state.pagesThisRun = pages;
  state.pendingCount = state.pending.length;
  if (!state.pending.length && !state.error) state.lastSuccessAt = state.updatedAt;
  await checkpoint(state, [], { force: true });
  return state;
}

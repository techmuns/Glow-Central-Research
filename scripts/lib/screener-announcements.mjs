// Public exchange notices discovered through Screener's authenticated ALL-announcements index.
// Provider text is data: keep the filing title/link/time, never its generated summary or instructions.
export const SCREENER_ANNOUNCEMENTS_URL = 'https://www.screener.in/announcements/all/';
const IST = 19800000, HOUR = 3600000, DAY = 24 * HOUR;
const decode = value => String(value || '').replace(/&#(x[\da-f]+|\d+);/gi, (_, raw) => {
  const n = raw[0].toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : Number(raw);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}).replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (_, k) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[k.toLowerCase()]);
const text = value => decode(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (html, name) => decode(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(html)?.[2] || '');
const iso = value => new Date(value).toISOString();
const validInstant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function screenerCursorAt(instant) {
  const local = iso(Date.parse(instant) + IST);
  return `?ts=${local.slice(0, 19).replace(/[T:]/g, '-')}-${local.slice(20, 23)}000&same_ts_offset_count=0`;
}

export function screenerCursor(value) {
  const url = new URL(decode(value), SCREENER_ANNOUNCEMENTS_URL);
  if (url.origin !== 'https://www.screener.in' || url.pathname !== '/announcements/all/' || url.hash || url.username || url.password
    || [...url.searchParams.keys()].some(k => !['ts', 'same_ts_offset_count'].includes(k))
    || url.searchParams.getAll('ts').length !== 1 || url.searchParams.getAll('same_ts_offset_count').length !== 1) throw Error('Invalid announcement cursor');
  const stamp = url.searchParams.get('ts'), offset = url.searchParams.get('same_ts_offset_count');
  const m = /^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{6})$/.exec(stamp || '');
  const instant = m && `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5].slice(0, 3)}+05:30`;
  if (!instant || !validInstant(instant) || iso(Date.parse(instant) + IST).slice(0, 19) !== `${m[1]}T${m[2]}:${m[3]}:${m[4]}`
    || !/^\d{1,7}$/.test(offset || '')) throw Error('Invalid announcement cursor');
  return { query: url.search, stamp, time: Date.parse(instant), offset: Number(offset) };
}

export function parseScreenerAnnouncements(html, { cursor = null, now = Date.now() } = {}) {
  if (typeof html !== 'string' || !/<\/main\s*>/i.test(html) || !/Latest Announcements/i.test(html)
    || /<form[^>]+action=["']\/login\//i.test(html)) throw Error('Announcement index unavailable or incomplete');
  const chunks = html.split(/<div\b[^>]*class=["'][^"']*\bannouncement-item\b[^"']*["'][^>]*>/i).slice(1);
  if (!chunks.length) throw Error('Announcement index has no verified records; coverage has not advanced');
  const rows = chunks.map(chunk => {
    const links = [...chunk.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)].slice(0, 2);
    const companyUrl = new URL(attr(links[0]?.[1], 'href'), SCREENER_ANNOUNCEMENTS_URL);
    const companyMatch = /^\/company\/([A-Z0-9&._-]{1,80})\/(?:consolidated\/)?$/i.exec(decodeURIComponent(companyUrl.pathname));
    if (companyUrl.origin !== 'https://www.screener.in' || !companyMatch) throw Error('Unrecognized announcement company');
    const companyKey = companyMatch[1].toUpperCase(), company = text(links[0][2]);
    const url = new URL(attr(links[1]?.[1], 'href'));
    const source = ['www.bseindia.com', 'bseindia.com'].includes(url.hostname) ? 'BSE'
      : ['nsearchives.nseindia.com', 'archives.nseindia.com'].includes(url.hostname) ? 'NSE' : null;
    const publishedAt = attr(/<time\b([^>]*)>/i.exec(links[1]?.[2] || '')?.[1], 'datetime');
    const stamp = Date.parse(publishedAt);
    // The title precedes the PDF icon/time/optional AI blurb. Never import a generated blurb.
    const title = text((links[1]?.[2] || '').split(/<(?:i|time|span|div)\b/i)[0]);
    if (!company || !title || !source || url.protocol !== 'https:' || url.username || url.password
      || !/\.(?:pdf|xml)(?:$|[?&#])/i.test(url.href) || !/T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+05:30$/.test(publishedAt)
      || !Number.isFinite(stamp) || stamp > now + 5 * 60000) throw Error('Unrecognized announcement record');
    const local = iso(stamp + IST);
    return { ticker: /^\d{6}$/.test(companyKey) ? `BSE:${companyKey}` : companyKey,
      ...(/^\d{6}$/.test(companyKey) ? { scripCode: companyKey } : {}),
      company, companyUrl: companyUrl.href, title, url: url.href, date: local.slice(0, 10), time: local.slice(11, 19),
      publishedAt: iso(stamp), source, sources: [source], providers: ['Screener announcements'] };
  });
  for (let i = 1; i < rows.length; i++) if (rows[i].publishedAt > rows[i - 1].publishedAt) throw Error('Announcement order changed');
  if (new Set(rows.map(r => `${r.ticker}|${r.url}`)).size !== rows.length) throw Error('Announcement page repeated a record');
  const button = /<button\b([^>]*\bdata-swap=["']#show-more-[^"']*["'][^>]*)>/i.exec(html);
  if (!button) throw Error('Announcement pagination unavailable; coverage has not advanced');
  const action = attr(button[1], 'onclick');
  const next = screenerCursor(/Utils\.ajaxLoad\(event,\s*'([^']+)'\)/.exec(action)?.[1] || '');
  if (next.time !== Date.parse(rows.at(-1).publishedAt)) throw Error('Announcement cursor does not match the last row');
  if (cursor) {
    const prior = screenerCursor(cursor);
    if (Date.parse(rows[0].publishedAt) > prior.time || next.stamp > prior.stamp
      || next.stamp === prior.stamp && next.offset <= prior.offset) throw Error('Announcement pagination did not advance');
  }
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
  initialFrom = null, now = Date.now, maxPages = 600, budgetMs = 12 * 60000 } = {}) {
  const started = now(), at = iso(started);
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
  while (state.pending.length && pages < maxPages && now() - started < budgetMs) {
    let parsed;
    try {
      parsed = parseScreenerAnnouncements(await readPage(selected.cursor), { cursor: selected.cursor, now: now() });
    } catch (error) {
      state.error = { at: iso(now()), reason: error.captureReason || 'source-or-shape', message: 'Screener announcements could not be fully checked. Saved rows and pagination are retained.' };
      if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) state.nextRetryAt = iso(now() + error.retryAfterMs);
      break;
    }
    const incoming = parsed.rows.filter(row => row.publishedAt >= selected.from && row.publishedAt <= selected.to);
    selected.cursor = parsed.next;
    selected.pages++;
    pages++;
    state.lastPageAt = iso(now());
    state.totalPages = (state.totalPages || 0) + 1;
    if (parsed.rows.at(-1).publishedAt < selected.from) {
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

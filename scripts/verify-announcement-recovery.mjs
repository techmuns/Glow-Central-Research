import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScreenerAnnouncements, screenerCursor, screenerCursorAt, screenerRecoveryCheckpoint, collectScreenerAnnouncements } from './lib/screener-announcements.mjs';
import { bseCaptureIndex, failedBseCapture } from './lib/bse-capture-state.mjs';
import { archiveFilings } from './lib/filing-archive.mjs';
import { announcementCoverage } from '../public/js/data/announcement-coverage.js';
import { assessFilingsHealth } from '../public/js/data/filings-health-shared.js';
import { createAnnouncementIdentity } from '../public/js/data/announcement-identity.js';

const originalNow = Date.parse('2026-09-30T17:00:00.000Z');
const bootstrap = { version: 1, bootstrap: true, rowCount: 0, rows: [], pending: [], ranges: [] };
assert.equal(screenerRecoveryCheckpoint(bootstrap), null);
assert.throws(() => screenerRecoveryCheckpoint({ ...bootstrap, lastPageAt: '2026-09-29T10:00:00.000Z' }), /history must not be reset/);
assert.throws(() => screenerRecoveryCheckpoint({ ...bootstrap, rows: [{ title: 'Retain me' }] }), /history must not be reset/);
const actual = readFileSync(new URL('./fixtures/screener-announcements.html', import.meta.url), 'utf8');
const parsed = parseScreenerAnnouncements(actual, { now: originalNow });
assert.equal(parsed.rows.length, 25);
assert.equal(parsed.rows[0].ticker, 'ERAINFRA');
assert.equal(parsed.rows[0].publishedAt, '2026-09-30T16:09:25.000Z');
assert.equal(parsed.rows[0].title, 'Shareholder Meeting / Postal Ballot-Outcome of AGM');
assert.equal(screenerCursor(parsed.next).offset, 1);
assert.deepEqual(parsed.rows[0].providers, ['Screener announcements']);
for (const bad of [actual.replace('</main>', ''), actual.replaceAll('announcement-item', 'unknown-item'),
  actual.replace('data-swap=', 'broken-swap='), actual.replace('same_ts_offset_count=1', 'same_ts_offset_count=0').replaceAll('21-24-25-000000', '21-24-26-000000'),
  actual.replace('https://www.bseindia.com/stockinfo/', 'https://untrusted.test/stockinfo/')])
  assert.throws(() => parseScreenerAnnouncements(bad, { now: originalNow }));
for (const bad of ['?ts=2026-02-30-12-00-00-000000&same_ts_offset_count=0',
  'https://elsewhere.test/announcements/all/?ts=2026-09-30-12-00-00-000000&same_ts_offset_count=0',
  '?ts=2026-09-30-12-00-00-000000&same_ts_offset_count=-1',
  '?ts=2026-09-30-12-00-00-000000&ts=another&same_ts_offset_count=0']) assert.throws(() => screenerCursor(bad));

const iso = time => new Date(time).toISOString();
const notice = (id, time, ticker = 'TCS') => ({ id, time, ticker });
// Use the observed All-index DOM structure; the fake server implements the timestamp/tie cursor.
function pageHtml(rows, next) {
  return `<main><h1>Latest Announcements</h1>${rows.map(r => `<div class="bordered announcement-item">
    <div><a href="/company/${encodeURIComponent(r.ticker)}/consolidated/"><span>${r.ticker} Company</span><i></i></a>
    <a href="https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=${r.id}.pdf">Board Meeting Outcome ${r.id}<i class="icon-file-pdf"></i>
    <span><time datetime="${new Date(r.time + 19800000).toISOString().replace('Z', '+05:30')}"></time></span><div>Generated summary must not become filing text</div></a></div></div>`).join('')}
    <button data-swap="#show-more-cursor" onclick="Utils.ajaxLoad(event, '${next.replaceAll('&', '&amp;')}')">Show More</button></main>`;
}
let clock = originalNow;
const hour = 3600000;
let notices = [
  notice('newest', clock - 60000, 'M&M'),
  ...Array.from({ length: 9 }, (_, i) => notice(`tie-${i}`, clock - 600000, i === 4 ? '541096' : 'TCS')),
  notice('lower-bound', clock - 2 * hour), notice('older', clock - 2 * hour - 1000),
  notice('ancient-sentinel', clock - 10 * 24 * hour),
];
const requests = [];
function indexPage(query) {
  requests.push(query);
  const cursor = screenerCursor(query);
  const sorted = [...notices].sort((a, b) => b.time - a.time);
  let ties = 0;
  const rows = sorted.filter(r => r.time < cursor.time || r.time === cursor.time && ++ties > cursor.offset).slice(0, 3);
  assert(rows.length, 'test source includes an older sentinel');
  const last = rows.at(-1);
  const offset = sorted.slice(0, sorted.indexOf(last) + 1).filter(r => r.time === last.time).length;
  const next = screenerCursorAt(iso(last.time)).replace('same_ts_offset_count=0', `same_ts_offset_count=${offset}`);
  return pageHtml(rows, next);
}
let durable = null;
const saved = new Map();
const checkpoint = async (state, incoming) => {
  for (const row of incoming) saved.set(row.url, row);
  durable = structuredClone(state);
};
const run = options => collectScreenerAnnouncements({ now: () => clock, previous: durable, initialFrom: iso(originalNow - 2 * hour), readPage: indexPage, checkpoint, ...options });
await run({ maxPages: 2 });
assert.equal(durable.pending.length, 1);
assert.equal(saved.size, 6);
assert.equal(durable.ranges.length, 0, 'a partial walk never claims the interval complete');
const oldCursor = durable.pending[0].cursor;
clock += hour;
notices.unshift(notice('arrived-after-interruption', clock - 60000, 'INFY'));
await run({ maxPages: 20 });
assert(requests.includes(oldCursor), 'resume the unfinished page instead of replacing its cursor');
assert.equal(durable.pending.length, 0);
assert.equal(saved.size, 12, 'all nine tied timestamps plus arrivals and the inclusive lower boundary are retained once');
assert.equal(durable.ranges.length, 1);
assert.equal(durable.ranges[0].from, iso(originalNow - 2 * hour));
assert.equal(durable.ranges[0].to, iso(clock));
assert([...saved.values()].every(r => !r.title.includes('Generated summary')));
assert([...saved.values()].some(r => r.ticker === 'M&M'));
assert([...saved.values()].some(r => r.ticker === 'BSE:541096' && r.scripCode === '541096'));

// A late source insertion behind a completed cursor is found by the daily reconciliation.
clock = originalNow + 23 * hour;
await run({ maxPages: 30 });
notices.push(notice('late-insertion', originalNow - hour, 'BPLPHARMA'));
clock = originalNow + 25 * hour;
await run({ maxPages: 30 });
assert([...saved.values()].some(r => r.url.includes('late-insertion')));
assert.equal(durable.pending.length, 0);

// Refusal preserves rows, success time and a retryable cursor; retry-after is respected.
const goodTime = durable.lastSuccessAt;
clock += hour;
await run({ readPage: async () => { throw Object.assign(Error('private upstream detail'), { retryAfterMs: hour }); } });
assert.equal(durable.lastSuccessAt, goodTime);
assert(durable.pending.length > 0);
assert.equal(durable.error.reason, 'source-or-shape');
assert(!JSON.stringify(durable).includes('private upstream detail'));
let reads = 0;
clock += 60000;
await run({ readPage: async () => { reads++; return ''; } });
assert.equal(reads, 0);
assert.equal(durable.pagesThisRun, 0);
clock += hour;
await run({ maxPages: 30 });
assert.equal(durable.error, null);

// An interrupted write must never be caught and re-saved with an advanced, unsaved cursor.
clock += hour;
let writes = 0;
await assert.rejects(run({ checkpoint: async (state, rows) => {
  writes++;
  if (writes > 1) throw Error('disk full');
  await checkpoint(state, rows);
} }), /disk full/);
assert.equal(writes, 2);
assert.equal(durable.pending.at(-1).pages, 0);
await run({ maxPages: 30 });
assert.equal(durable.pending.length, 0);
const refused = structuredClone(durable);
refused.enqueuedThrough = iso(clock + hour);
await assert.rejects(run({ previous: refused }), /clock moved/);

// A refused company directory must not prevent the independent filing request.
const identity = { isin: 'INE365Y01019', ticker: 'BPLPHARMA', bseCode: '541096', name: 'Bharat Parenterals Limited' };
const index = await bseCaptureIndex({ now: clock, previous: { version: 1, capturedAt: iso(clock - hour), entries: [identity] },
  mcMap: { tcs: { ticker: 'TCS', bseId: '532540' } }, fetchMaster: async () => { throw Error('HTTP 403'); } });
assert.equal(index.byCode.get('541096').ticker, 'BPLPHARMA');
assert.equal(index.byCode.get('532540').ticker, 'TCS');
assert.equal(index.identities, null, 'do not rewrite the verified directory with a stale success timestamp');
assert.equal(index.identityError.reason, 'directory-unavailable');
const prior = { capturedAt: iso(clock - hour), lastCompleteTo: '2026-09-29', coversUniverse: true,
  byTicker: { BPLPHARMA: [{ date: '2026-09-19', title: 'Retained announcement' }] }, rowCount: 1, failed: {} };
const failed = failedBseCapture(prior, { now: clock });
assert.deepEqual(failed.byTicker, prior.byTicker);
assert.equal(failed.capturedAt, prior.capturedAt);
assert.equal(failed.lastCompleteTo, prior.lastCompleteTo);
assert.equal(failed.coversUniverse, false);
assert(failed.lastError);

// Recovery shares the durable monthly archive and deduplicates alternate BSE links by document.
const dir = mkdtempSync(join(tmpdir(), 'glow-recovery-'));
try {
  const resolver = createAnnouncementIdentity([identity]);
  const recovered = resolver.row([...saved.values()].find(r => r.ticker === 'BSE:541096'));
  assert.equal(recovered.ticker, 'BPLPHARMA');
  const document = 'f6d9abb7-7050-4b1a-9725-aa4ea17421fb';
  const target = { ...recovered, date: '2026-09-29', url: `https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=${document}.pdf` };
  archiveFilings(dir, 'announcements', [{ ...target, url: `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${document}.pdf`, providers: ['BSE date index'] }]);
  archiveFilings(dir, 'announcements', [target, ...[...saved.values()].map(resolver.row)]);
  const month = JSON.parse(readFileSync(join(dir, '2026-09.json')));
  assert(month.rows.some(r => r.ticker === 'BPLPHARMA'));
  const copies = month.rows.filter(r => r.date === '2026-09-29' && r.ticker === 'BPLPHARMA');
  assert.equal(copies.length, 1, 'the same original PDF through BSE and the backup remains one filing');
  assert.deepEqual(new Set(copies[0].providers), new Set(['BSE date index', 'Screener announcements']));
  assert(month.rows.some(r => r.url.includes('lower-bound')), 'recovery never erases older records');
} finally { rmSync(dir, { recursive: true, force: true }); }

const health = value => assessFilingsHealth({ announcementRecovery: value }, { now: clock, sources: ['announcementRecovery'] });
const good = { ...durable, rows: [...saved.values()], rowCount: saved.size };
assert.equal(health(good).status, 'healthy');
for (const [mutate, code] of [
  [r => { r.pending = [{ from: iso(clock - hour), to: iso(clock) }]; }, 'recovery-incomplete'],
  [r => { r.error = { message: 'private details' }; }, 'source-read-failed'],
  [r => { r.ranges = []; }, 'historical-gap'],
  [r => { r.lastPageAt = iso(clock - 5 * hour); }, 'source-check-overdue'],
  [r => { r.lastAttemptAt = iso(clock + hour); }, 'invalid-check-time'],
  [r => { r.rowCount++; }, 'invalid-capture'],
]) {
  const value = structuredClone(good); mutate(value);
  assert(health(value).findings.some(f => f.code === code));
  assert(!JSON.stringify(health(value)).includes('private details'));
}
const meta = { capturedAt: iso(clock), coversUniverse: true, recovery: { available: true, lastPageAt: iso(clock), pendingCount: 0 } };
assert.equal(announcementCoverage(meta, clock).incomplete, false);
assert.equal(announcementCoverage({ ...meta, capturedAt: iso(clock - 5 * hour) }, clock).incomplete, true);
assert.equal(announcementCoverage({ ...meta, sourceCheck: { error: failed.lastError } }, clock).incomplete, true);
assert.equal(announcementCoverage({ ...meta, recovery: { ...meta.recovery, pendingCount: 1 } }, clock).incomplete, true);
console.log('PASS announcement recovery: observed source HTML, cursor ties, new arrivals, interrupted resume, late additions, refusal/cooldown, failed writes, archive retention, saved identities and independent health.');

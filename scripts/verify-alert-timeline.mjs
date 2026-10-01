#!/usr/bin/env node
import assert from 'node:assert/strict';
import { prepareTimeline, createTimelineHistory } from '../public/js/data/alert-timeline.js';
const day = '2026-09-28';
const event = (id, extra = {}) => ({ id, ticker: 'TEST', company: 'Test Company', feed: 'earnings',
  headline: `Result ${id}`, day: '2026-08-01', time: '09:00', importance: 'high', ...extra });
const current = event('current', { day });
const history = { events: [event('foreign', { ticker: 'OTHER' }), event('ineligible', { aiEligible: false }),
  event('routine', { feed: 'announcements', headline: 'Trading window closure', filingSubject: 'Trading window closure' }),
  event('revoked-recent', { day }), ...Array.from({ length: 20000 }, (_, i) => event(`old-${i}`))] };
const card = { ticker: 'TEST', events: [current] };
const rows = await prepareTimeline(card, { history, day });
assert.equal(rows.length, 20001, 'all older eligible records, no foreign/routine/ineligible/revoked recent rows');
assert.equal(rows[0].id, 'current');
assert(rows.some(row => row.id === 'old-19999'));
assert.equal((await prepareTimeline(card, { history, day, filters: { selected: ['insider'], hideRoutine: true } })).length, 1,
  'history respects the same event filter; the already filtered card owns current events');
assert.equal((await prepareTimeline(card, { history, day, filters: { hideRoutine: false } })).length, 20002, 'routine history is available when explicitly included');
assert.equal(await prepareTimeline(card, { history, day, isCurrent: () => false }), null, 'abandoned preparations never publish');
const proposal = event('proposal', {day, time:'09:00', storyId:'merger', storySequence:1});
const approval = event('approval', {day, time:null, storyId:'merger', storySequence:2});
assert.deepEqual((await prepareTimeline({events:[proposal,approval], developments:[{lead:proposal},{lead:approval}]}, {day})).map(r=>r.id), ['approval','proposal'], 'clockless material updates precede their earlier checked development');
let calls = 0, release, currentView = true;
let next = { events: [event('public'), event('public', { ticker: 'OTHER' }), event('private', { feed: 'company-documents', private: true }), event('removed-ok', { feed: 'insider' })],
  feeds: [{ id: 'earnings', status: 'ok' }, { id: 'company-documents', status: 'ok' }, { id: 'insider', status: 'ok' }] };
const reader = createTimelineHistory({ options: () => ({ scope: 'universe' }), isCurrent: () => currentView,
  collect: async opts => { calls++; assert(opts.includeHistory); await new Promise(done => { release = done; }); return next; } });
const a = reader.read(), b = reader.read(); assert.equal(a, b, 'cards share one pending read'); release(); await a;
assert.equal(await reader.read(), await a); assert.equal(calls, 1, 'later cards share the saved history');
next = { events: [event('new'), event('new', { ticker: 'OTHER' })], pending: 0, feeds: [{ id: 'earnings', status: 'failed' }, { id: 'insider', status: 'ok' }] };
const retry = reader.read({ refresh: true }); release();
assert.deepEqual((await retry).events.map(e => e.id), ['public', 'public', 'new', 'new'], 'failed public identity groups survive; current groups remain complete; successful removals and revoked private records do not');
const obsolete = reader.read({ memoryOnly: true }); currentView = false; release(); assert.equal(await obsolete, null);
console.log('PASS 20,000-row history, company/eligibility/filter isolation, cancellation, shared lazy reads and source-specific failure retention without revoked private data.');

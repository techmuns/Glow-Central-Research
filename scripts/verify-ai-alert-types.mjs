import assert from 'node:assert/strict';
import { aiEventTypes, matchesAIEvent, normalizeAIEventFilters } from '../public/js/data/ai-alert-types.js';
<<<<<<< HEAD
import { rankReport, cardWithEvents, leadEvent } from '../public/js/data/ai-alerts.js';
=======
import { rankReport, cardWithEvents, leadEvent, withPositionSnapshot, withoutPositionSnapshot } from '../public/js/data/ai-alerts.js';
>>>>>>> sattva/main

const filing = (headline, extra = {}) => ({ feed: 'announcements', headline, ...extra });
for (const headline of ['Loss of share certificates', 'Issue of duplicate share certificate', 'Dematerialisation of shares', 'Trading window closure', 'Newspaper Publication']) {
  const event = filing(headline);
  assert.deepEqual(aiEventTypes(event), ['routine'], headline);
  assert.equal(matchesAIEvent(event), false);
  assert.equal(matchesAIEvent(event, { hideRoutine: false }), true);
}
for (const [headline, expected] of [
  ['Scheme of arrangement approved by NCLT', ['scheme', 'deals']],
  ['Resignation of Director/KMP/SMP', ['resignation', 'management']],
  ['Preferential issue of convertible warrants', ['preferential', 'warrants', 'capital']],
  ['Allotment of equity shares on conversion of warrants', ['warrants', 'capital']],
  ['Appointment of CFO', ['management']],
  ['Unknown general update', ['other']],
]) assert.deepEqual(aiEventTypes(filing(headline)), expected);
assert.deepEqual(aiEventTypes(filing('Board meeting outcome', { filingDescription: 'Approved a preferential issue of warrants' })), ['preferential', 'warrants', 'board-meeting']);
assert.deepEqual(aiEventTypes(filing('Newspaper publication of scheme of arrangement')), ['routine']);
assert.deepEqual(aiEventTypes(filing('Newspaper advertisement pertaining to dispatch of Letter of Offer for Buyback', { filingSubCategory: 'Buyback' })), ['routine']);
assert.deepEqual(aiEventTypes(filing('General Updates', { filingSubCategory: 'Financial Results', filingDescription: 'Newspaper publication of financial results' })), ['routine']);
assert.deepEqual(aiEventTypes(filing('General Updates', { filingDescription: 'Resignation of auditor' })), ['resignation', 'management']);
assert.deepEqual(aiEventTypes(filing('General Updates', { reason: 'AI suggests a resignation or warrants issue' })), ['other']);
assert.deepEqual(aiEventTypes({ feed: 'news', headline: 'Warrants issued' }), ['news']);
assert(!aiEventTypes(filing('Court issues arrest warrant')).includes('warrants'));
assert(matchesAIEvent(filing('Preferential issue of warrants'), { selected: ['resignation', 'warrants'] }));
assert(!matchesAIEvent(filing('Loss of share certificate'), { selected: ['routine'], hideRoutine: true }));
assert.deepEqual(normalizeAIEventFilters({ selected: ['warrants', 'warrants', 'bogus'], hideRoutine: false }), { selected: ['warrants'], hideRoutine: false });
assert.deepEqual(normalizeAIEventFilters(null), { selected: [], hideRoutine: true });

const events = ['Loss of share certificates', 'Resignation of Director', 'Preferential issue of warrants'].map((headline, i) => ({
  ...filing(headline), id: String(i), ticker: 'TEST', company: 'Test Limited', day: '2026-09-28', time: `1${i}:00`,
  importance: 'high', direction: i === 1 ? 'positive' : 'negative', url: `https://example.test/${i}.pdf`,
}));
const report = rankReport({ day: '2026-09-28', scope: 'universe', events, feeds: [{ id: 'announcements', status: 'ok', reachesToday: true }] }, { holdings: [], companyMetadata: [], insightCompanies: [] });
const card = report.allCards[0];
const view = cardWithEvents(card, card.events.filter(event => matchesAIEvent(event, { selected: ['resignation'] })));
assert.equal(view.events.length, 1);
assert.match(view.insight, /Resignation/);
assert.equal(leadEvent(view).id, '1');
assert.equal(view.developments.length, 1);
assert.equal(view.mixed, false);
assert.equal(view.feedCount, 1);
assert.equal(view.score, card.score, 'filtering never promotes company priority');
assert.equal(view.evidenceKey, card.evidenceKey, 'archive receipts still cover the full company');
assert.equal(card.events.length, 3, 'retained history is untouched');
assert.equal(cardWithEvents(card, []), null);
assert.equal(cardWithEvents(card, card.events), card);
console.log('PASS: filing categories, multi-select OR, routine exclusion, unknowns, compact source fields, matching claims and retained company evidence.');
<<<<<<< HEAD
=======

const extra = { ...events[1], id: 'unheld', ticker: 'OTHER', company: 'Other Company' };
const snapshot = { holdings: [{ ticker: 'TEST', name: 'Test Limited', isin: 'INE000A01001', weightPct: 100 }], sizes: { complete: true } };
for (const scope of ['universe', 'watchlist']) {
  const original = rankReport({ day: '2026-09-28', scope, events: [...events, extra], feeds: report.feeds }, { holdings: [] });
  const weighted = withPositionSnapshot(original, snapshot);
  assert.equal(weighted.allCards.length, 2, 'non-held companies stay in their selected scope');
  assert.equal(weighted.allCards.find(card => card.ticker === 'TEST').holdingWeightPct, 100);
  assert.equal(weighted.allCards.find(card => card.ticker === 'OTHER').holdingWeightPct, null);
  const cleared = withoutPositionSnapshot(weighted);
  assert(cleared.allCards.every(card => card.holdingWeightPct === null));
  assert.deepEqual(cleared.allCards.map(card => card.evidenceKey), original.allCards.map(card => card.evidenceKey));
  assert.equal(withoutPositionSnapshot(cleared), cleared, 'repeated failures reuse the cleared view');
}
console.log('PASS: every-scope weights retain non-held evidence and disappear without reranking after failure.');
>>>>>>> sattva/main

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { ATTRIBUTION_VERSION } from '../public/js/data/company-news-attribution.js';
import { currentDay, relativeAge, formatDay, latestSignal, latestAlertSignal, latestAlertEvent, sortAlertCards, matchesSearch } from '../public/js/ui/ai-alert-utils.js';

assert.equal(currentDay(Date.parse('2026-09-04T18:29:59Z')), '2026-09-04');
assert.equal(currentDay(Date.parse('2026-09-04T18:30:00Z')), '2026-09-05');
assert.equal(currentDay(Date.parse('2026-12-31T18:30:00Z')), '2027-01-01');
for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata']) {
  process.env.TZ = zone;
  assert.equal(relativeAge('2026-09-04', '2026-09-04'), 'today');
  assert.equal(relativeAge('2026-09-04', '2026-09-05'), '1d');
  assert.equal(relativeAge('2026-08-31', '2026-09-04'), '4d');
  assert.equal(relativeAge('2026-12-31', '2027-01-01'), '1d');
  assert.equal(relativeAge('2024-02-28', '2024-03-01'), '2d');
  assert.equal(relativeAge('2026-09-05', '2026-09-04'), 'in 1d');
  assert.equal(formatDay('2026-09-04'), '04 Sept 2026');
}
for (const day of [null, undefined, '', '2026-02-29', '2026-09-31', 'garbage']) {
  assert.equal(relativeAge(day, '2026-09-04'), '—');
  assert.equal(formatDay(day), 'Date unavailable');
}
assert.equal(relativeAge('2026-09-04', 'bad date'), '—');
assert.equal(latestSignal([]), null);
assert.equal(latestSignal([{ day: '2026-02-29' }]), null);
const events = [
  { day: '2026-09-03', time: '16:30', headline: 'Strongest but older signal' },
  { day: '2026-09-04', time: '09:15', headline: 'Routine filing' },
  { day: '2026-09-04', time: '14:42', headline: 'Hidden fourth event: lithium supply agreement', feedLabel: 'Corporate Announcements' },
];
assert.deepEqual(latestSignal(events), { day: '2026-09-04', time: '14:42', datetime: '2026-09-04T14:42:00+05:30' });
assert.deepEqual(latestSignal([...events, { day: '2026-09-04', time: null }]), { day: '2026-09-04', time: null, datetime: '2026-09-04' });
assert.equal(latestSignal([...events, { day: '2026-09-05', time: '26:00' }]).time, null);
const card = { company: 'Mahindra & Mahindra', ticker: 'M&M', sector: 'Automobiles', insight: 'Heavy trading with selling', confluence: [{ short: 'News behind it' }], events };
for (const q of ['', '  ', 'MAHINDRA', 'm&m', 'lithium SUPPLY', 'mahindra agreement', 'corporate announcements', 'selling', 'news behind', '2026-09-04', 'automobiles']) {
  assert(matchesSearch(card, q), `matches ${q}`);
}
assert(!matchesSearch(card, 'unrelated bank'));
assert(!matchesSearch(card, 'mahindra missing-keyword'));
console.log('PASS: AI alert search, source date precision, IST rollover, invalid dates and calendar ages across timezones.');

const sorting = [
  { key: 'OLDER', score: 98, holdingWeightPct: 50, events: [{ day: '2026-09-03', time: '14:00', importance: 'high' }, { day: '2026-09-06', importance: 'low' }] },
  { key: 'NEW', score: 65, holdingWeightPct: 10, events: [{ day: '2026-09-05', time: '14:00', importance: 'high' }] },
  { key: 'NEWER', score: 64, holdingWeightPct: 2, events: [{ day: '2026-09-05', time: '15:00', importance: 'high' }] },
  { key: 'UNKNOWN', score: 99, holdingWeightPct: null, events: [{ day: 'invalid', importance: 'high' }] },
];
assert.equal(latestAlertSignal(sorting[0]).day, '2026-09-03', 'routine newer data cannot resurface an older noteworthy alert');
assert.equal(latestAlertEvent(sorting[0]).day, '2026-09-03');
const related = { day: '2026-09-06', feed: 'news', importance: 'high', aiEligible: false,
  attribution: { version: ATTRIBUTION_VERSION, status: 'related', relationships: [{ relationship: 'subsidiary of a related entity', evidenceUrl: 'https://example.test/relationship' }] } };
assert.equal(latestAlertSignal({ events: [...sorting[0].events, related] }).day, related.day, 'reviewed relationship evidence retains its actual event date');
assert.deepEqual(sortAlertCards(sorting).map(c => c.key), ['NEWER', 'NEW', 'OLDER', 'UNKNOWN']);
assert.deepEqual(sortAlertCards(sorting, 'holdings').map(c => c.key), ['OLDER', 'NEW', 'NEWER', 'UNKNOWN']);
assert.deepEqual(sortAlertCards(sorting, 'priority').map(c => c.key), ['UNKNOWN', 'OLDER', 'NEW', 'NEWER']);
assert.equal(sorting[0].key, 'OLDER', 'sorting is a view and does not mutate source ranking');
assert.deepEqual(sortAlertCards(sorting.map(c => ({ ...c, holdingWeightPct: null })), 'holdings').map(c => c.key), ['NEWER', 'NEW', 'OLDER', 'UNKNOWN']);

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { rankReport, mergePartialReport, withPositionSnapshot, clearRankingCache } = await import('../public/js/data/ai-alerts.js');
const { enrichCardFromAllAlerts, indexAlertContext } = await import('../public/js/data/intelligence-graph.js');
const sizeHoldings = [
  { ticker: 'LARGE', name: 'Large holding', weightPct: 20 },
  { ticker: 'SMALL', name: 'Small holding', weightPct: 5 },
  { ticker: null, name: 'Fund with no research symbol', weightPct: 75 },
];
const feeds = ['earnings', 'announcements', 'insider'].map(id => ({ id, status: 'ok', reachesToday: true }));
const report = { day: '2026-09-04', scope: 'portfolio', feeds, events: ['LARGE', 'SMALL'].flatMap(ticker => feeds.map(({ id }) => ({
  id: `${ticker}-${id}`, ticker, company: ticker, feed: id, day: '2026-09-04', headline: `${ticker} ${id} signal`,
  importance: 'high', direction: ticker === 'SMALL' ? 'negative' : 'positive',
}))) };
const sizes = { sizes: { complete: true, basis: 'listed-market-value' }, holdings: sizeHoldings };
const bySize = rankReport(report, { holdings: sizeHoldings, positionSizes: sizes });
assert.equal(bySize.cards[0].ticker, 'LARGE');
assert.equal(bySize.cards[0].holdingWeightPct, 20, 'unmatched funds stay in the percentage denominator');
assert(bySize.cards[0].score < bySize.cards[1].score, 'size ordering leaves evidence priority intact');
const byPriority = rankReport(report, { holdings: sizeHoldings });
const missingSectors = sizeHoldings.map(h => ({ ...h, sector: 'Unclassified' }));
const negativeReport = { ...report, events: report.events.map(e => ({ ...e, direction: 'negative' })) };
const unclassified = rankReport(negativeReport, { holdings: missingSectors, companyMetadata: [] });
assert(unclassified.allCards.every(c => c.sector === null && c.sectorCluster === 0),
  'unclassified companies cannot form a negative sector cluster or inflate priority');
const classified = rankReport(negativeReport, { holdings: missingSectors,
  companyMetadata: [{ ticker: 'LARGE', sector: 'Financial Services' }, { ticker: 'SMALL', sector: 'Industrials' }] });
assert.equal(classified.allCards.find(c => c.ticker === 'LARGE').sector, 'Financial Services');
assert(classified.allCards.every(c => c.sectorCluster === 0));
assert.equal(rankReport(report, { holdings: sizeHoldings.map(h => ({ ...h, sector: 'Statement sector' })),
  companyMetadata: [{ ticker: 'LARGE', sector: 'Other sector' }] }).allCards.find(c => c.ticker === 'LARGE').sector, 'Statement sector',
  'a known statement classification takes precedence over the company feed');
assert.equal(byPriority.cards[0].ticker, 'SMALL', 'public identities cannot activate size ordering');
assert(byPriority.cards.every(c => c.holdingWeightPct === null));
assert.equal(rankReport({ ...report, scope: 'universe' }, { holdings: sizeHoldings, positionSizes: sizes }).cards[0].ticker, 'SMALL');
assert.equal(rankReport(report, { holdings: sizeHoldings, positionSizes: { sizes: { complete: false } } }).cards[0].ticker, 'SMALL');
const publicIdentities = sizeHoldings.map(({ weightPct: _weightPct, ...holding }) => holding);
const byAuthenticatedPayload = rankReport(report, { holdings: publicIdentities, positionSizes: sizes });
assert.equal(byAuthenticatedPayload.cards[0].ticker, 'LARGE', 'production reads weights from the authenticated positions payload, not the public identity list');
assert.equal(byAuthenticatedPayload.cards[0].holdingWeightPct, 20);
const immediateSizes = withPositionSnapshot(byPriority, sizes);
assert.equal(immediateSizes.cards.find(c => c.ticker === 'LARGE').holdingWeightPct, 20);
assert.equal(immediateSizes.cards[0].ticker, byPriority.cards[0].ticker, 'size arrival cannot reorder the existing queue');
const exited = withPositionSnapshot(byPriority, { ...sizes, holdings: sizes.holdings.filter(h => h.ticker !== 'SMALL') });
assert(!exited.allCards.some(c => c.ticker === 'SMALL'), 'a verified exit is removed before slow feeds finish');
const identityCard = { ...byPriority.cards[0], key: 'RESOLVED', ticker: 'RESOLVED', entityId: 'isin:INE000009999' };
const identityReport = { ...byPriority, cards: [identityCard], allCards: [identityCard] };
const tickerlessSizes = { sizes: { complete: true }, holdings: [{ ticker: null, isin: 'INE000009999', name: 'Unresolved workbook symbol', weightPct: 100 }] };
assert.equal(withPositionSnapshot(identityReport, tickerlessSizes).cards[0].holdingWeightPct, 100, 'verified ISIN matching retains a held company even when Family has no ticker');
assert.equal(withPositionSnapshot(identityReport, { ...tickerlessSizes, sizes: { complete: false } }).cards[0].holdingWeightPct, null);
const resolvedEvent = { ...report.events[0], ticker: 'RESOLVED', entityId: identityCard.entityId };
assert.equal(rankReport({ ...report, events: [resolvedEvent] }, { holdings: tickerlessSizes.holdings, positionSizes: tickerlessSizes }).allCards[0].holdingWeightPct, 100, 'completed ranking uses the same ISIN aliases');
const arriving = rankReport({ ...report, events: report.events.map(e => ({ ...e, id: `new-${e.id}`, ticker: 'NEW', company: 'New signal' })) }, { holdings: [{ ticker: 'NEW' }] });
const progress = mergePartialReport(byPriority, arriving);
assert(progress.cards.some(c => c.ticker === 'NEW'), 'a new noteworthy company arrives before the slowest source settles');
assert(progress.cards.some(c => c.ticker === 'LARGE'), 'partial progress does not erase previously loaded companies');
assert.equal(mergePartialReport(byPriority, { ...byPriority, cards: [], allCards: [] }).cards.length, byPriority.cards.length);
const arrivingSameCompany = rankReport({ ...report, pending: 1, events: [{ ...report.events[0],
  id: 'same-company-new', headline: 'New material export contract', feed: 'announcements' }] }, { holdings: sizeHoldings });
const mergedSameCompany = mergePartialReport(byPriority, arrivingSameCompany);
const mergedLarge = mergedSameCompany.cards.find(card => card.ticker === 'LARGE');
assert(mergedLarge.events.some(e => e.id === 'same-company-new'), 'new evidence is not hidden while an older source is pending');
assert(mergedLarge.events.some(e => e.id === report.events[0].id), 'old evidence remains alongside the new arrival');
const corrected = rankReport({ ...report, pending: 1, events: [{ ...report.events[0], headline: 'Corrected original event' }] }, { holdings: sizeHoldings });
assert.equal(mergePartialReport(byPriority, corrected).cards.find(c => c.ticker === 'LARGE').events.find(e => e.id === report.events[0].id).headline,
  'Corrected original event', 'a correction updates its old stable identity during partial progress');
const retractedEligibility = rankReport({ ...report, pending: 1,
  events: report.events.map(event => ({ ...event, aiEligible: false })) }, { holdings: sizeHoldings });
assert.equal(mergePartialReport(byPriority, retractedEligibility).cards.length, 0,
  'a source correction removing AI eligibility cannot resurrect old material evidence during a partial refresh');

const context = {
  id: 'LARGE-raw-filing', ticker: 'LARGE', company: 'Large holding', feed: 'announcements',
  day: '2026-09-04', headline: 'LARGE signal source document', detail: 'Underlying source record',
  kind: 'document', aiEligible: false, importance: 'low', direction: 'neutral',
};
const contextOnly = {
  id: 'CONTEXT-only', ticker: 'CONTEXT', company: 'Context only company', feed: 'announcements',
  day: '2026-09-04', headline: 'Routine source document', kind: 'document', aiEligible: false,
  importance: 'low', direction: 'neutral',
};
const routineSnapshot = {
  ...context, id: 'LARGE-routine-snapshot', feed: 'investor-positions', feedLabel: 'Investor holdings',
  headline: 'Quarterly holding disclosure snapshot', kind: 'snapshot',
};
const contextual = rankReport({ ...report, events: [...report.events, context, contextOnly, routineSnapshot], feeds: [...report.feeds, { id: 'investor-positions', status: 'ok', reachesToday: true }] }, { holdings: publicIdentities, positionSizes: sizes });
const largeBefore = byAuthenticatedPayload.cards.find((card) => card.ticker === 'LARGE');
const largeAfter = contextual.cards.find((card) => card.ticker === 'LARGE');
assert.equal(largeAfter.score, largeBefore.score, 'context contributes zero priority points');
assert.equal(largeAfter.contextEvents[0].id, context.id, 'the raw top-of-funnel record still enriches the card');
assert.equal(largeAfter.contextEvents.some((event) => event.id === routineSnapshot.id), false, 'an unrelated routine snapshot does not clutter the alert');
assert.equal(contextual.allCards.some((card) => card.ticker === 'CONTEXT'), false, 'context-only data cannot manufacture an AI alert');
assert.equal(contextual.meta.topFunnelEvents, report.events.length + 3);
const indexedReport = { ...report, events: [...report.events, context, contextOnly, routineSnapshot] };
const contextIndex = indexAlertContext(indexedReport);
for (const candidate of byAuthenticatedPayload.cards) {
  assert.deepEqual(enrichCardFromAllAlerts(candidate, indexedReport, { contextIndex }),
    enrichCardFromAllAlerts(candidate, indexedReport), 'shared ticker index preserves every selected context record and score');
}
console.log('PASS: authenticated size ordering, evidence priority preservation, full-pool zero-score context and missing-size fallback.');
const vocabularyTrigger = { ...context, id: 'vocabulary-trigger', ticker: 'ALPHA', company: 'Alpha Cement',
  headline: 'Cement concrete operations', detail: '', keywordIds: [] };
const vocabularyCandidate = { ...context, id: 'vocabulary-context', ticker: 'ALPHA', company: 'Alpha Concrete',
  headline: 'Concrete cement disclosure', detail: '', keywordIds: [] };
const vocabularyReport = { day: '2026-09-04', feeds: [{ id: 'announcements', status: 'ok' }], events: [vocabularyCandidate] };
const vocabularyCard = { ticker: 'ALPHA', events: [vocabularyTrigger] };
assert.equal(enrichCardFromAllAlerts(vocabularyCard, vocabularyReport).contextEvents.length, 0,
  'all trigger and candidate company names are excluded from topic overlap');
vocabularyTrigger.keywordIds = ['cement']; vocabularyCandidate.keywordIds = ['cement'];
assert.equal(enrichCardFromAllAlerts(vocabularyCard, vocabularyReport).contextEvents[0]?.id, vocabularyCandidate.id,
  'explicit keyword IDs remain topics even when their word appears in a company name');
vocabularyTrigger.keywordIds = []; vocabularyCandidate.keywordIds = [];
assert.equal(enrichCardFromAllAlerts(vocabularyCard, vocabularyReport).contextEvents.length, 0,
  'a subsequent context build reads corrected trigger vocabulary');

// Publication envelopes and status-only progress must not derive the same cards repeatedly.
clearRankingCache();
let evidenceReads = 0;
const observedEvents = report.events.map(event => new Proxy(event, {
  get(target, key) { evidenceReads++; return target[key]; },
}));
const publication = { ...report, events: observedEvents, feeds: feeds.map(feed => ({ ...feed })) };
const cachedRank = rankReport(publication, { holdings: publicIdentities });
evidenceReads = 0;
const statusOnly = rankReport({ ...publication, events: [...observedEvents], pending: 2,
  cacheSavedAt: 1234, feeds: publication.feeds.map(feed => ({ ...feed, checkedAt: 1234 })) },
{ holdings: structuredClone(publicIdentities) });
assert.equal(evidenceReads, 0, 'unchanged record publications skip scoring and context derivation');
assert.equal(statusOnly.cards, cachedRank.cards);
assert.equal(statusOnly.allCards, cachedRank.allCards);
assert.equal(statusOnly.pending, 2);
assert.equal(statusOnly.meta.cacheSavedAt, 1234);
assert.equal(statusOnly.feeds[0].checkedAt, 1234, 'status-only envelopes still carry the latest source checks');
assert.equal(mergePartialReport(cachedRank, statusOnly).cards, cachedRank.cards,
  'cumulative partials reuse the completed derivation');
const correction = rankReport({ ...publication, events: observedEvents.map((event, i) => i === 0
  ? { ...event, headline: 'Same-count corrected evidence' } : event) }, { holdings: publicIdentities });
assert.equal(correction.allCards.find(card => card.ticker === 'LARGE').events.find(event => event.id === report.events[0].id).headline,
  'Same-count corrected evidence');
publication.feeds.forEach(feed => { feed.status = 'failed'; });
const failedRank = rankReport(publication, { holdings: publicIdentities });
assert(failedRank.allCards.find(card => card.ticker === 'LARGE').score < cachedRank.allCards.find(card => card.ticker === 'LARGE').score,
  'score-affecting source health invalidates even when the feed objects and event count are unchanged');
const notHeld = rankReport(publication, { holdings: [] });
assert.equal(notHeld.allCards.find(card => card.ticker === 'LARGE').holding, false, 'membership changes remove the held-company signal');
const nextWindow = rankReport({ ...publication, day: '2026-09-19' }, { holdings: publicIdentities });
assert.equal(nextWindow.allCards.length, 0, 'date changes re-age unchanged evidence');
const insight = { ticker: 'LARGE', companyKey: 'LARGE', name: 'Large holding', rows: [] };
const withInsight = rankReport(publication, { holdings: publicIdentities, insightCompanies: [insight] });
const failedInsight = rankReport(publication, { holdings: publicIdentities, insightCompanies: [{ ...insight, readStatus: 'failed' }] });
assert.notEqual(failedInsight.allCards, withInsight.allCards, 'changed Insights status invalidates context derivation');
const newWeights = { ...sizes, holdings: sizes.holdings.map(holding => ({ ...holding, weightPct: 10 })) };
assert.equal(rankReport(publication, { holdings: publicIdentities, positionSizes: newWeights }).allCards.find(card => card.ticker === 'LARGE').holdingWeightPct, 10);
assert.equal(withPositionSnapshot(immediateSizes, sizes), immediateSizes, 'unchanged positions reuse cards and report');
clearRankingCache();
assert.notEqual(rankReport(publication, { holdings: publicIdentities }).allCards, failedRank.allCards,
  'access invalidation discards the previous private derivation');
console.log('PASS: unchanged publications reuse derivations; corrections, source health, membership, dates, Insights and positions invalidate them.');

// ---------------------------------------------------------------------------------------
// THE TWO-BULLET READING. "One bullet is what has happened; the second, will it change the earnings
// assumption, the valuation or the thesis?" The second bullet is a deterministic reading of which
// QUESTION each event bears on — never an answer — so every branch is asserted on a fixture here,
// because a day's capture rarely holds a buyback, a rating cut, a big move and a holder's exit on
// one company.
const { IMPACT_AXES, eventImpacts, impactOf, impactParts, impactLine } = await import('../public/js/data/ai-alerts.js');
assert.deepEqual(IMPACT_AXES.map(axis => axis.id), ['earnings', 'valuation', 'thesis'], 'the three triggers, in the desk’s order');
const base = { day: '2026-09-04', ticker: 'T', company: 'Test Co', direction: 'neutral', importance: 'high' };
const orderFiling = { ...base, id: 'f1', feed: 'announcements', headline: 'Receipt of order worth Rs 135 crore', keywords: ['Order', 'Receipt of Order'], filingRule: 'order or contract award' };
const buybackStory = { ...base, id: 'n1', feed: 'news', headline: 'Board approves buyback', keywords: ['Buyback', 'Approval'] };
const fraudStory = { ...base, id: 'n2', feed: 'news', headline: 'Regulator probes alleged fraud', keywordIds: ['fraud', 'investigation'] };
const nseDowngrade = { ...base, id: 'f2', feed: 'nse-filings', headline: 'Credit rating downgrade', keywords: [], filingRule: 'rating downgrade' };
const result = { ...base, id: 'e1', feed: 'earnings', headline: 'YOY quarterly result filed' };
const call = { ...base, id: 'c1', feed: 'concalls', headline: 'Con-call analysis published', direction: 'negative' };
const quietCall = { ...call, id: 'c2', importance: 'low', direction: 'neutral' };
const bigMove = { ...base, id: 't1', feed: 'technicals', kind: 'move', movePct: 6.5, direction: 'positive', headline: 'Rose 6.5% at the 2026-09-03 close' };
const smallMove = { ...bigMove, id: 't2', movePct: 1.2, importance: 'low', aiEligible: false, kind: 'price-reading' };
const volume = { ...base, id: 't3', feed: 'technicals', kind: 'volume', volumeX: 4.4 };
const breakout = { ...base, id: 't4', feed: 'technicals', kind: 'breakout', direction: 'positive' };
const holderCut = { ...base, id: 'i1', feed: 'investors', action: 'trimmed', investor: 'Life Insurance Corporation', deltaPp: -2, direction: 'negative' };
const holderSmall = { ...holderCut, id: 'i2', deltaPp: -0.5, importance: 'low' };
const insiderSell = { ...base, id: 's1', feed: 'insider', headline: 'Promoter — Disposal', direction: 'negative' };
const insiderSmall = { ...insiderSell, id: 's2', importance: 'low' };
const chatter = { ...base, id: 'ch1', feed: 'chatter', headline: 'Bearish public chatter', direction: 'negative' };
const relatedStory = { ...buybackStory, id: 'n3', aiEligible: false,
  attribution: { version: ATTRIBUTION_VERSION, status: 'related', relationships: [{ relationship: 'subsidiary of a related entity', evidenceUrl: 'https://example.test/relationship' }] } };
const untracked = { ...base, id: 'n4', feed: 'news', headline: 'General coverage', keywords: [] };

const axesOf = event => [...new Set(eventImpacts(event).map(hit => hit.axis))];
assert.deepEqual(axesOf(orderFiling), ['earnings']);
assert.deepEqual(eventImpacts(orderFiling).map(hit => hit.text), ['Order in a filing', 'Receipt of Order in a filing', 'order or contract award in a filing'],
  'a filing names its keywords by the desk’s own labels and its rule by the rule’s own name');
assert.deepEqual(axesOf(buybackStory).sort(), ['earnings', 'valuation'], 'labels resolve to keyword ids: Approval is an earnings question, Buyback a valuation one');
assert.deepEqual(axesOf(fraudStory), ['thesis'], 'keyword ids are read directly where a row carries them');
assert.deepEqual(axesOf(nseDowngrade), ['valuation', 'thesis'], 'NSE filings count as filings and a filing rule alone is enough');
assert.deepEqual(eventImpacts(result), [{ axis: 'earnings', text: 'results filed' }]);
assert.deepEqual(axesOf(call), ['earnings']);
assert.deepEqual(axesOf(quietCall), [], 'a neutral, mid-band con-call is not an earnings trigger');
assert.deepEqual(eventImpacts(bigMove), [{ axis: 'valuation', text: 'up 6.5% at the close' }], 'a move past the feed’s own threshold bears on valuation');
assert.deepEqual(axesOf(smallMove), [], 'a move below MOVE_PCT bears on nothing — the feed’s threshold, not a second one');
assert.deepEqual(axesOf(volume), [], 'volume is participation and bears on nothing by itself');
assert.deepEqual(axesOf(breakout), [], 'a base break is a tape reading, not one of the three questions');
assert.deepEqual(axesOf(holderCut), [], 'a holder’s move is somebody else’s decision, not one of the three questions — it is the first bullet’s business');
assert.deepEqual(axesOf(holderSmall), []);
assert.deepEqual(axesOf(insiderSell), [], 'an insider trade bears on none of the three by itself');
assert.deepEqual(axesOf(insiderSmall), []);
assert.deepEqual(axesOf(chatter), [], 'chatter bears on none of the three');
assert.deepEqual(axesOf(relatedStory), [], 'a related-entity story never drives a company’s bullet');
assert.deepEqual(axesOf(untracked), []);

const all = impactOf([holderCut, chatter, fraudStory, bigMove, orderFiling, result, buybackStory, { ...result, id: 'e2' }]);
assert.deepEqual(all.map(hit => hit.axis), ['earnings', 'valuation', 'thesis'], 'axes come out in the desk’s order whatever order the events arrived in');
assert.deepEqual(all[0].reasons.map(r => r.text), ['Order in a filing', 'Receipt of Order in a filing', 'order or contract award in a filing', 'results filed', 'Approval in the news'],
  'one reason per distinct trigger — a second result filing does not repeat “results filed”');
assert.equal(all[0].reasons.find(r => r.text === 'results filed').eventId, 'e1', 'a reason keeps the id of the event it was read from');
assert.deepEqual(all[2].reasons.map(r => r.text), ['Fraud in the news', 'Investigation in the news']);
assert.deepEqual(impactOf([]), []);
assert.deepEqual(impactOf([chatter, volume, untracked, holderCut, insiderSell]), [], 'no axis is present-and-empty');

assert.equal(impactLine([]), 'Nothing here is a tracked trigger for the earnings assumption, the valuation or the thesis. Read the evidence before deciding.');
assert.equal(impactLine(impactOf([result])), 'Could change the earnings assumption (results filed). Nothing tracked here bears on the valuation and thesis.');
assert.equal(impactLine(impactOf([bigMove, nseDowngrade])),
  'Could change the valuation (up 6.5% at the close; rating downgrade in a filing) and the thesis (rating downgrade in a filing). Nothing tracked here bears on the earnings assumption.',
  'two axes present: the missing one is named in words');
assert.equal(impactLine(all),
  'Could change the earnings assumption (Order in a filing; Receipt of Order in a filing; order or contract award in a filing; results filed; Approval in the news), the valuation (up 6.5% at the close; Buyback in the news) and the thesis (Fraud in the news; Investigation in the news).',
  'all three present: no “nothing bears on” tail, and every trigger is listed — none is folded into a count');
for (const line of [impactLine([]), impactLine(all), impactLine(impactOf([result]))]) {
  assert(!/\bwill\b/i.test(line) && !/\bEPS\b/.test(line), `the bullet never answers the question it asks: ${line}`);
}
const parts = impactParts(all);
assert.deepEqual(parts.filter(part => part.kind === 'axis').map(part => part.axis), ['earnings', 'valuation', 'thesis']);
assert.equal(parts.map(part => part.text).join(''), impactLine(all), 'the parts are the line, so a renderer cannot drift from it');
const reasonParts = parts.filter(part => part.kind === 'reason');
assert.equal(reasonParts.length, all.reduce((sum, hit) => sum + hit.reasons.length, 0), 'every trigger is its own part, so every one can be a link');
assert(reasonParts.every(part => part.eventId && part.feed && part.axis), 'every trigger part carries the event it was read from');
assert.deepEqual(reasonParts.find(part => part.text === 'results filed'), { kind: 'reason', axis: 'earnings', text: 'results filed', eventId: 'e1', feed: 'earnings' });
assert.equal(reasonParts.find(part => part.text === 'up 6.5% at the close').eventId, 't1');
assert.equal(reasonParts.find(part => part.text === 'Buyback in the news').eventId, 'n1');

const twoBullets = rankReport({ day: '2026-09-04', scope: 'portfolio', feeds: [{ id: 'announcements', status: 'ok', reachesToday: true }, { id: 'technicals', status: 'ok', reachesToday: true }],
  events: [orderFiling, bigMove] }, { holdings: [{ ticker: 'T', name: 'Test Co' }] });
const bulletCard = twoBullets.cards.find(card => card.ticker === 'T');
assert(bulletCard, 'the fixture surfaces');
assert.deepEqual(bulletCard.impacts.map(hit => hit.axis), ['earnings', 'valuation']);
assert.equal(bulletCard.impactLine, impactLine(bulletCard.impacts));
assert(matchesSearch(bulletCard, 'thesis') && matchesSearch(bulletCard, 'order in a filing') && matchesSearch(bulletCard, 'valuation'), 'search reaches the second bullet');
console.log('PASS: the second bullet reads which of earnings, valuation or thesis each event bears on, from the feeds’ own thresholds and the desk’s own keywords, and never answers it.');

#!/usr/bin/env node
// Offline contracts for semantic news grouping. Model replies are fixtures, not a live accuracy benchmark.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  EVENT_INSTRUCTIONS, EVENT_REPORT_LIMIT, EVENT_REQUEST_BYTES, EVENT_RESPONSE_BYTES,
  eventCandidates, compatibleReports, compatibleEventMembers, parseEventGroups, reviewNewsEvents, relatedNewsReports, moneyAmounts,
} from '../worker/newsletter-events.mjs';
import { buildBrief, briefStats, briefStories, renderBriefHtml, renderBriefText } from '../worker/newsletter-brief.mjs';
import { DEFAULT_SETTINGS, istInstant } from '../public/js/data/newsletter-shared.js';
import { editorialEvents } from '../worker/newsletter-editorial.mjs';
import { renderInvestorEmails } from '../worker/newsletter-email.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/newsletter/repeated-news.json', import.meta.url)));
const news = () => ({ groups: [{ ticker: fixture.ticker, company: fixture.company, items: fixture.reports.map((r, i) => ({
  ...r, at: Date.parse(r.publishedAt), summary: '', attribution: 'confirmed', keywords: [], keys: [`source:${i}`, r.url],
})) }] });
const env = { CLAUDE_KEY: 'ABSKfixture-only-key' };
const expectedPartition = reports => [reports.filter(r => r.headline.startsWith('EIL ')).map(r => r.id), reports.filter(r => !r.headline.startsWith('EIL ')).map(r => r.id)];
const answer = groups => Response.json({ content: [{ type: 'text', text: JSON.stringify(groups) }] });
let calls = 0;
const fetcher = async (url, init) => {
  calls++;
  const body = JSON.parse(init.body), { REPORTS } = JSON.parse(body.messages[0].content);
  assert.equal(init.redirect, 'manual');
  assert.equal(body.system[0].text, EVENT_INSTRUCTIONS);
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(body.max_tokens, 4000);
  assert.ok(!JSON.stringify(REPORTS).includes('https://'), 'only source text, no source URLs or document requests');
  assert.equal(REPORTS.length, 5);
  assert.ok(REPORTS.every(r => fixture.reports.some(f => f.headline === r.headline)), 'full original headlines enter the check');
  return answer(expectedPartition(REPORTS));
};
const checked = news(), original = structuredClone(checked);
checked.dedup = await reviewNewsEvents({ news: checked, env, fetcher });
assert.equal(calls, 1);
assert.deepEqual([checked.dedup.reviewed, checked.dedup.combined], [5, 3]);
assert.equal(new Set(checked.groups[0].items.map(r => r.eventId)).size, 2);
const sourceRows = checked.groups[0].items.map(({ eventId, ...row }) => row);
assert.deepEqual(sourceRows, original.groups[0].items, 'only presentation membership changes; all source content and keys survive');

const reports = eventCandidates(news()).reports;
const valid = expectedPartition(reports);
assert.deepEqual(parseEventGroups(JSON.stringify(valid), reports), valid);
for (const bad of [[], [['unknown']], { groups: valid }, [reports.map(r => r.id), null]]) {
  assert.equal(parseEventGroups(JSON.stringify(bad), reports), null, 'empty, unknown-only and malformed replies fail closed');
}
const ids = reports.map(r => r.id), sorted = groups => groups.map(g => [...g].sort()).sort((a, b) => a[0].localeCompare(b[0]));
assert.deepEqual(sorted(parseEventGroups(JSON.stringify([[ids[0]]]), reports)), sorted(ids.map(id => [id])), 'an omitted id stays a separate update');
assert.deepEqual(sorted(parseEventGroups(JSON.stringify([...valid, [ids[0]]]), reports)), sorted([...valid.map(g => g.filter(id => id !== ids[0])).filter(g => g.length), [ids[0]]]),
  'an id the reply places twice stays separate; the other memberships survive');
assert.deepEqual(parseEventGroups(JSON.stringify([...valid, ['unknown']]), reports), valid, 'an unknown id is ignored');
const base = reports[0];
for (const [a, b] of [
  [base, { ...base, ticker: 'OTHER' }], [base, { ...base, related: true }],
  [base, { ...base, at: base.at + 86400001 }], [base, { ...base, at: NaN }],
  [{ ...base, headline: 'Company wins contract worth 2600 crore' }, { ...base, headline: 'Company wins contract worth 3600 crore' }],
  [{ ...base, headline: 'Company approves airport project' }, { ...base, headline: 'Company rejects airport project' }],
  [{ ...base, headline: 'Company grants airport permit' }, { ...base, headline: 'Company revokes airport permit' }],
  [{ ...base, headline: 'Company allows new exports' }, { ...base, headline: 'Company bans new exports' }],
  [{ ...base, headline: 'Company in talks for oil projects' }, { ...base, headline: 'Company signs oil project contract' }],
  [{ ...base, headline: 'Company announces quarterly results', summary: 'Profit 40 crore' }, { ...base, headline: 'Company announces quarterly results', summary: 'Profit 50 crore' }],
]) {
  assert.equal(compatibleReports(a, b), false);
  assert.equal(compatibleEventMembers(a, b), false);
  assert.deepEqual(parseEventGroups('[["a","b"]]', [{ ...a, id: 'a' }, { ...b, id: 'b' }]), [['a'], ['b']], 'an unsafe proposed group is split, never merged');
}
// A-B and B-C time proximity cannot silently join A-C outside the event window.
const chain = [0, 12, 25].map((hours, i) => ({ ...base, id: String(i), at: base.at + hours * 3600000 }));
assert.deepEqual(parseEventGroups('[["0","1","2"]]', chain), [['0', '1'], ['2']]);
// One unsafe group no longer voids every other group in the reply (the 28 October failure).
const orders = [{ ...base, id: 'o1', headline: 'Company wins Rs 500 crore order' }, { ...base, id: 'o2', headline: 'Company bags ₹300 cr contract' }];
assert.deepEqual(parseEventGroups(JSON.stringify([[...valid[0]], [...valid[1]], ['o1', 'o2']]), [...reports, ...orders]), [...valid, ['o1'], ['o2']]);
assert.deepEqual(moneyAmounts('Net profit Rs.41,591.21 lakh; 4.16 Billion Rupees; $1.2 bn; USD 300 million'),
  [{ currency: 'inr', value: 415.9121 }, { currency: 'inr', value: 416 }, { currency: 'usd', value: 1200 }, { currency: 'usd', value: 300 }]);
const asStory = (r, extra = {}) => ({ ...r, kind: 'news', source: r.source, dek: r.summary, ...extra });
assert.equal(relatedNewsReports(asStory(base), asStory(base, { source: 'Another publisher' })), false,'An identical headline without corroboration cannot merge distinct unread events');
assert.equal(relatedNewsReports(asStory(base,{url:'https://fixture.test/article'}), asStory(base, { source: 'Another publisher',url:'https://fixture.test/article?utm_campaign=copy' })), true);
assert.equal(relatedNewsReports(asStory(base, { eventId: 'a' }), asStory(base, { eventId: 'b', source: 'Another publisher' })), false, 'reviewed singletons override identical headlines');
assert.equal(relatedNewsReports(asStory(base), asStory(base, { kind: 'filing' })), false);
assert.equal(relatedNewsReports(asStory(base), asStory(base, { source: 'Another publisher', headline: 'EIL signs an oil infrastructure deal in Saudi Arabia and UAE' })), false, 'no fuzzy grouping on failure');

for (const [reply, reason] of [
  [async () => new Response('', { status: 429 }), 'rate-limited'],
  [async () => new Response('', { status: 503 }), 'upstream'],
  [async () => answer([['unknown']]), 'unreadable'],
  [async () => new Response('x'.repeat(EVENT_RESPONSE_BYTES + 1)), 'unreadable'],
  [async () => { throw new DOMException('deadline', 'TimeoutError'); }, 'timeout'],
]) {
  const input = structuredClone(checked);
  const state = await reviewNewsEvents({ news: input, env, fetcher: reply });
  assert.equal(state.reason, reason);
  assert.ok(input.groups[0].items.every(r => !r.eventId), 'failure cannot keep stale group membership');
  assert.deepEqual(input.groups[0].items, original.groups[0].items);
}
const forbidden = async () => { throw new Error('must not call'); };
assert.equal((await reviewNewsEvents({ news: news(), env, fetcher: forbidden, enabled: false })).reason, 'preview');
assert.equal((await reviewNewsEvents({ news: news(), env: {}, fetcher: forbidden })).reason, 'not-configured');
assert.equal((await reviewNewsEvents({ news: { groups: [] }, env, fetcher: forbidden })).reason, 'nothing-to-check');
const tooMany = news();
tooMany.groups[0].items = Array.from({ length: EVENT_REPORT_LIMIT + 1 }, () => ({ ...tooMany.groups[0].items[0] }));
assert.equal((await reviewNewsEvents({ news: tooMany, env, fetcher: forbidden })).reason, 'limit');
const tooLong = news();
tooLong.groups[0].items[0].summary = 'अ'.repeat(EVENT_REQUEST_BYTES);
assert.equal(eventCandidates(tooLong).reports.length, 0, 'UTF-8 budget excludes whole company instead of clipping away qualifications');
tooLong.groups.push({ ...news().groups[0], ticker: 'SECOND' });
assert.equal(eventCandidates(tooLong).reports.length, 5, 'an oversized company does not starve a later one');
const partial = await reviewNewsEvents({ news: tooLong, env, fetcher: async (url, init) => answer(JSON.parse(JSON.parse(init.body).messages[0].content).REPORTS.map(r => [r.id])) });
assert.equal(partial.partial, true);
assert.equal(partial.reviewed, 5);
assert.equal(partial.eligible, 10);
const longReports = news();
for (const r of longReports.groups[0].items) r.summary = '&'.repeat(3500);
assert.ok(JSON.stringify(longReports).length < EVENT_REQUEST_BYTES);
const longCheck=await reviewNewsEvents({news:longReports,env,fetcher:async(_url,init)=>{
 const reports=JSON.parse(JSON.parse(init.body).messages[0].content).REPORTS;
 assert(reports.every(r=>r.summary==='&'.repeat(3500)),'Actual model input keeps complete qualifications without an obsolete HTML-escape budget');
 return answer(reports.map(r=>[r.id]));
}});
assert.equal(longCheck.reviewed,5);

// Exercise each deployment's actual company grouping, rendering and delivery identities.
const ASSETS = { fetch: async request => new URL(request.url).pathname === '/data/portfolio-companies.json'
  ? Response.json({ count: 1, asOf: '2026-09-21', holdings: [{ ticker: fixture.ticker, name: fixture.company }] })
  : new Response('', { status: 404 }) };
const brief = await buildBrief({ edition: 'morning', day: '2026-09-21', settings: DEFAULT_SETTINGS,
  env: { ASSETS }, now: istInstant('2026-09-21', '08:00'), includeAi: false, fetcher: async () => new Response('', { status: 503 }) });
brief.news = { ...brief.news, ...checked, count: 5, more: 0 };
const stats = briefStats(brief);
assert.equal(stats.stories, 5);
assert.equal(stats.updates, 2, 'four Gulf opportunity reports are one update; order book stays separate');
assert.deepEqual(briefStats(JSON.parse(JSON.stringify(brief))), stats, 'stored/restarted editions reproduce the same memberships and IDs');
assert.equal(stats.companies[0].clusters.find(c => c.main.headline.startsWith('EIL ')).others.length, 3);
assert.equal(new Set(briefStories(brief).flatMap(r => r.keys)).size, 10, 'every source identity remains available to the delivered-story ledger');
const html = renderBriefHtml(brief), text = renderBriefText(brief);
for (const r of fixture.reports) {
  assert.ok(html.includes(r.headline));
  assert.ok(text.includes(r.headline));
  assert.ok(html.includes(r.url));
  assert.ok(text.includes(r.url));
}
assert.ok(html.includes('3 repeat reports combined'));
const out = process.env.NEWSLETTER_EVENT_OUTPUT;
if (out) { mkdirSync(out, { recursive: true }); writeFileSync(`${out}/repeated-news.html`, html); }
if (existsSync(new URL('../worker/newsletter-pdf.mjs', import.meta.url))) {
  const { renderBriefPdf } = await import('../worker/newsletter-pdf.mjs');
  const { renderBriefEmails } = await import('../worker/newsletter-email.mjs');
  const pdf = renderBriefPdf(brief), pdfText = new TextDecoder().decode(pdf);
  for (const r of fixture.reports) assert.ok(pdfText.includes(r.url));
  const emails = renderBriefEmails(brief);
  assert.equal(new Set(emails.flatMap(e => e.keys)).size, 10);
  const busy = structuredClone(brief);
  busy.news.groups = Array.from({ length: 24 }, (_, i) => ({ ...structuredClone(checked.groups[0]), ticker: `COMPANY${i}`, company: `Company ${i}`,
    items: checked.groups[0].items.map(r => ({ ...r, keys: r.keys.map(key => `${i}:${key}`) })) }));
  busy.book.listed = 24;
  const parts = renderBriefEmails(busy);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => p.bytes <= 90000));
  assert.equal(new Set(parts.flatMap(p => p.keys)).size, 240, 'semantic grouping also preserves every source across multiple email parts');
  const longBrief = structuredClone(brief);
  longBrief.news.groups = longReports.groups;
  const longParts = renderBriefEmails(longBrief);
  assert.ok(longParts.length > 1, 'long reports remain separable into safe email parts');
  assert.ok(longParts.every(p => p.bytes <= 90000));
  assert.equal(new Set(longParts.flatMap(p => p.keys)).size, 10);
  if (out) writeFileSync(`${out}/repeated-news.pdf`, pdf);
}
// City Union Bank, 28 October: one results filing and eight reports of it were nine updates.
const cub = JSON.parse(readFileSync(new URL('./fixtures/newsletter/city-union-results-2026-10-28.json', import.meta.url)));
const cubAnnouncements = () => ({ groups: [{ ticker: cub.ticker, company: cub.company, items: [{
  headline: cub.filing.headline, subject: cub.filing.subject, exchanges: cub.filing.exchanges, url: cub.filing.url, sourceUrls: [cub.filing.url],
  at: Date.parse(cub.filing.publishedAt), type: 'results', keys: ['cub:filing', cub.filing.url], keywords: [], keywordIds: [], keywordGroups: [],
  direction: 'positive', importance: 'high', content: { state: 'ready', hash: 'cub-fixture', facts: cub.filing.facts },
}] }] });
const cubNews = () => ({ groups: [{ ticker: cub.ticker, company: cub.company, items: cub.reports.map((r, i) => ({
  ...r, at: Date.parse(r.publishedAt), summary: '', attribution: 'confirmed', keywords: [], keys: [`cub:${i}`, r.url],
})) }] });
const cubCandidates = eventCandidates(cubNews(), cubAnnouncements());
assert.equal(cubCandidates.reports.length, 9, 'filings and news of one company enter one partition');
const cubFiling = cubCandidates.reports.find(r => r.kind === 'filing');
assert.ok(cubFiling.summary.includes('Rs.41,591.21 lakh') && cubFiling.summary.includes('Financial Results'), 'a filing is checked on its own subject and read facts');
assert.ok(!JSON.stringify(cubCandidates.reports).includes('https://'), 'no source URLs or document requests enter the check');
const cubIds = cubCandidates.reports.map(r => r.id);
assert.equal(compatibleReports(cubCandidates.reports[1], cubCandidates.reports[2]), false, 'the strict copy rule still separates differing figures');
assert.ok(cubCandidates.reports.every(a => cubCandidates.reports.every(b => compatibleEventMembers(a, b))), 'rounding, units and other metrics of one result are one event');
assert.deepEqual(parseEventGroups(JSON.stringify([cubIds]), cubCandidates.reports), [cubIds]);
const cubChecked = { news: cubNews(), announcements: cubAnnouncements() };
const cubReview = await reviewNewsEvents({ ...cubChecked, env, fetcher: async (_url, init) =>
  answer([JSON.parse(JSON.parse(init.body).messages[0].content).REPORTS.map(r => r.id)]) });
assert.deepEqual([cubReview.ok, cubReview.reviewed, cubReview.combined], [true, 9, 8]);
const cubRows = [...cubChecked.announcements.groups[0].items, ...cubChecked.news.groups[0].items];
assert.equal(new Set(cubRows.map(r => r.eventId)).size, 1, 'the filing and every report carry one checked event');
const cubBrief = structuredClone(brief);
cubBrief.announcements = { ...cubBrief.announcements, ...cubChecked.announcements, count: 1, more: 0 };
cubBrief.news = { ...cubBrief.news, ...cubChecked.news, dedup: cubReview, count: 8, more: 0 };
const cubStats = briefStats(cubBrief), cubCompany = cubStats.companies.find(c => c.ticker === cub.ticker);
assert.equal(cubCompany.clusters.length, 1, 'one development, one update');
assert.equal(cubCompany.clusters[0].main.kind, 'filing', 'the company\'s own read filing leads');
assert.equal(cubCompany.clusters[0].others.length, 8);
assert.deepEqual(briefStats(JSON.parse(JSON.stringify(cubBrief))).companies.find(c => c.ticker === cub.ticker).clusters.length, 1, 'a stored edition folds identically');
assert.equal(new Set(briefStories(cubBrief).filter(r => r.ticker === cub.ticker).flatMap(r => r.keys)).size, 18, 'every source identity stays in the ledger');
const cubHtml = renderBriefHtml(cubBrief), cubText = renderBriefText(cubBrief);
for (const url of [cub.filing.url, ...cub.reports.map(r => r.url)]) { assert.ok(cubHtml.includes(url)); assert.ok(cubText.includes(url)); }
assert.ok(cubHtml.includes('8 repeat reports combined'));
const cubReading = editorialEvents(cubBrief, cubStats.companies).events.filter(e => e.ticker === cub.ticker);
assert.equal(cubReading.length, 1, 'the investor briefing prints the results once');
assert.deepEqual(new Set(cubReading[0].sources), new Set([cub.filing.url, ...cub.reports.map(r => r.url)]), 'every original link stays attached to that one item');
const cubInbox = renderInvestorEmails(cubBrief, { dashboardUrl: 'https://example.test', brand: 'Glow Ventures', pdfUrl: 'https://example.test/api/newsletter/pdf/00000000-0000-0000-0000-000000000001' }).map(m => m.html).join('');
if (process.env.CUB_INBOX) writeFileSync(process.env.CUB_INBOX, cubInbox);
for (const url of [cub.filing.url, ...cub.reports.map(r => r.url)]) assert.ok(cubInbox.includes(url), `the inbox links ${url}`);
assert.equal(cub.reports.filter(r => cubInbox.includes(r.headline.replaceAll('&', '&amp;'))).length < cub.reports.length, true, 'repeat headlines are no longer printed as separate items');
// Without a checked partition nothing folds on headline or time proximity.
const unchecked = structuredClone(cubBrief);
for (const g of [...unchecked.announcements.groups, ...unchecked.news.groups]) for (const r of g.items) delete r.eventId;
assert.ok(briefStats(unchecked).companies.find(c => c.ticker === cub.ticker).clusters.length > 1);
// A failed batch leaves its rows separate and the next batch is still tried.
const twoBatches = { groups: [
  { ticker: 'BIGA', company: 'Big A', items: Array.from({ length: 60 }, (_, i) => ({ headline: `Big A report ${i}`, at: Date.parse(cub.filing.publishedAt), summary: '', keys: [`a${i}`] })) },
  { ticker: 'BIGB', company: 'Big B', items: Array.from({ length: 30 }, (_, i) => ({ headline: `Big B report ${i}`, at: Date.parse(cub.filing.publishedAt), summary: '', keys: [`b${i}`] })) },
] };
let attempt = 0;
const continued = await reviewNewsEvents({ news: twoBatches, env, fetcher: async (_url, init) => {
  attempt++;
  return attempt === 1 ? new Response('', { status: 503 }) : answer([JSON.parse(JSON.parse(init.body).messages[0].content).REPORTS.map(r => r.id)]);
} });
assert.deepEqual([attempt, continued.ok, continued.reviewed, continued.eligible], [2, true, 30, 90]);
assert.ok(twoBatches.groups[0].items.every(r => !r.eventId) && twoBatches.groups[1].items.every(r => r.eventId));
let stopped = 0;
assert.equal((await reviewNewsEvents({ news: structuredClone(twoBatches), env: {}, fetcher: async () => { stopped++; } })).reason, 'not-configured');
assert.equal(stopped, 0);
console.log('PASS repeated-news partition, source retention, safety guards, failure/preview/budget handling, rendered email and saved edition');

#!/usr/bin/env node
// The team brief, tested where it is decided: the pure contract, the durable store, the brief
// builder against fixtures, the broadsheet renderer, and the alarm that sends.
//
// Run with `node scripts/verify-newsletter.mjs`. Needs no server and no egress: the store runs on
// node:sqlite exactly as the concall summary and watchlist stores do, Yahoo and NSE answer from
// captured fixtures, the committed data files stand in for the assets binding, and the email
// endpoint is a stub that records what it was asked to send.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_SETTINGS, EDITION_IDS, NEWSLETTER_SUBSCRIBER_LIMIT,
  editionWindow, istDay, istInstant, istLabel, newsletterIntent, newsletterIntents, newsletterSettings,
  nextScheduled, normaliseEmail, normaliseEmailList, previousWeekday, scheduledEditions,
} from '../public/js/data/newsletter-shared.js';
import { NewsletterStore } from '../worker/newsletter-store.mjs';
import {
  MARKET_ROWS, TOPICS, briefStats, briefSubject, buildBrief, quoteFromChart, quoteFromSeries, renderBriefHtml, renderBriefText, topicOf,
} from '../worker/newsletter-brief.mjs';
import { NewsletterSchedule, NEWSLETTER_TIMER_KEY, EMAIL_SEND_URL, CATCH_UP_MS, sendEmail } from '../worker/newsletter-schedule.mjs';

let failures = 0;
let count = 0;
async function test(name, fn) {
  count++;
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${error.stack || error.message}`);
  }
}

// ---- stand-ins ------------------------------------------------------------------------------------

function sqlStorage() {
  const db = new DatabaseSync(':memory:');
  return {
    sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
    transactionSync: (fn) => {
      db.exec('BEGIN');
      try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

class Storage {
  constructor() { Object.assign(this, sqlStorage()); this.data = new Map(); this.alarm = null; this.tail = Promise.resolve(); }
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
  transaction(fn) { const result = this.tail.then(() => fn(this)); this.tail = result.catch(() => {}); return result; }
}

const fixture = (name) => readFileSync(new URL(`./fixtures/newsletter/${name}`, import.meta.url), 'utf8');
const asset = (path) => readFileSync(new URL(`../public${path}`, import.meta.url), 'utf8');
const assets = {
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    try { return new Response(asset(path), { headers: { 'content-type': 'application/json' } }); } catch { return new Response('missing', { status: 404 }); }
  },
};
const CHARTS = { '^GSPC': 'yahoo-sp500.json', '^N225': 'yahoo-nikkei.json', 'BZ=F': 'yahoo-brent.json', 'JPY=X': 'yahoo-usdjpy.json', '^TNX': 'yahoo-us10y.json' };

// 08:00 IST on 17 September 2026, the morning after the captured feeds.
const MORNING = istInstant('2026-09-17', '08:00');
const nseXml = () => {
  const xml = fixture('nse-announcements.xml');
  // A filing by a book company inside the window, so the join is asserted rather than hoped for.
  const item = '<item><title>Aarti Drugs Ltd</title><link>https://nsearchives.nseindia.com/corporate/AARTIDRUGS_17092026071500_test.pdf</link><description>Aarti Drugs Ltd has informed the Exchange regarding Receipt of order from a customer &lt;script&gt;alert(1)&lt;/script&gt; |SUBJECT: Bagging/Receiving of orders/contracts</description><pubDate>17-Sep-2026 07:15:00</pubDate></item>'
    + '<item><title>Aarti Drugs Ltd</title><link>https://nsearchives.nseindia.com/corporate/AARTIDRUGS_17092026071600_test2.pdf</link><description>Aarti Drugs Ltd has informed the Exchange regarding Credit rating downgrade by CRISIL |SUBJECT: Credit Rating</description><pubDate>17-Sep-2026 07:16:00</pubDate></item>';
  return xml.replace('<item>', `${item}<item>`);
};

function makeFetcher({ yahoo = 'ok', nse = 'ok', email = 'ok', log = [] } = {}) {
  return async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://query1.finance.yahoo.com/v8/finance/chart/')) {
      assert.equal(init.headers?.['user-agent'], 'Mozilla/5.0 (compatible; SattvaCentralBot/1.0)');
      const symbol = decodeURIComponent(url.slice('https://query1.finance.yahoo.com/v8/finance/chart/'.length).split('?')[0]);
      log.push({ kind: 'yahoo', symbol });
      if (yahoo === 'down') return new Response('nope', { status: 503 });
      const file = CHARTS[symbol] || 'yahoo-sp500.json';
      return new Response(fixture(file), { headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://nsearchives.nseindia.com/')) {
      log.push({ kind: 'nse' });
      if (nse === 'blocked') return new Response('<html>Access Denied</html>', { status: 403 });
      return new Response(nseXml(), { headers: { 'content-type': 'application/xml' } });
    }
    if (url === EMAIL_SEND_URL) {
      const body = JSON.parse(init.body);
      log.push({ kind: 'email', to: body.email, subject: body.subject, html: body.html, text: body.text, auth: init.headers.authorization, method: init.method });
      if (email === 'unauthorised') return Response.json({ success: false, message: 'private upstream text' }, { status: 401 });
      if (email === 'down') return new Response('gateway', { status: 502 });
      if (email === 'hang') throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      return Response.json({ data: { message: 'Email sent successfully!' }, message: '', success: true });
    }
    throw new Error(`Unexpected request in test: ${url}`);
  };
}

// ---- the contract -----------------------------------------------------------------------------------

console.log('\n— the contract —');

await test('an address is lower-cased and trimmed, and a bad one is null rather than a row', () => {
  assert.equal(normaliseEmail('  Pratik@Muns.IO '), 'pratik@muns.io');
  for (const bad of ['pratik', 'pratik@', '@muns.io', 'a b@muns.io', '', null, 'x'.repeat(250) + '@muns.io']) assert.equal(normaliseEmail(bad), null, String(bad));
});

await test('a pasted list is read as several addresses, and what could not be read is NAMED', () => {
  // The shape a desk actually pastes: a column out of a table, then a mail client's separators.
  const pasted = normaliseEmailList('bharat@glowventures.in\ngaurav@glowventures.in\r\nprateek@glowventures.in ,  ashwini@glowventures.in;ankita@glowventures.in\nYAMINI@Glowventures.in\n');
  assert.deepEqual(pasted.emails, ['bharat@glowventures.in', 'gaurav@glowventures.in', 'prateek@glowventures.in', 'ashwini@glowventures.in', 'ankita@glowventures.in', 'yamini@glowventures.in']);
  assert.deepEqual(pasted.invalid, []);
  // A display name is consumed with its brackets — neither refused as a bad address nor left as chaff.
  assert.deepEqual(normaliseEmailList('Bharat Kumar <bharat@glowventures.in>, gaurav@glowventures.in').emails, ['bharat@glowventures.in', 'gaurav@glowventures.in']);
  // One person is one row whatever case they were typed in, and one address twice is still one row.
  assert.deepEqual(normaliseEmailList('a@muns.io, A@MUNS.IO').emails, ['a@muns.io']);
  // The whole point: a token that is not an address is reported verbatim, never quietly dropped.
  assert.deepEqual(normaliseEmailList('a@muns.io, nope, b@muns.io').invalid, ['nope']);
  assert.deepEqual(normaliseEmailList('a@muns.io, nope, b@muns.io').emails, ['a@muns.io', 'b@muns.io']);
  assert.deepEqual(normaliseEmailList('   '), { emails: [], invalid: [] });
});

await test('a subscription names who added it; an unsubscribe need not', () => {
  assert.throws(() => newsletterIntent({ op: 'subscribe', email: 'a@muns.io' }), /who added/);
  assert.throws(() => newsletterIntent({ op: 'subscribe', email: 'nope', by: 'Ravi' }), /valid email/);
  assert.throws(() => newsletterIntent({ op: 'subscribe', email: 'a@muns.io', by: 'Ravi', editions: [] }), /at least one/);
  assert.throws(() => newsletterIntent({ op: 'delete', email: 'a@muns.io' }), /unknown op/);
  assert.deepEqual(newsletterIntent({ op: 'subscribe', email: 'A@muns.io', by: '  Ravi  Kumar ', editions: ['evening', 'morning', 'evening'] }),
    { op: 'subscribe', email: 'a@muns.io', name: null, by: 'Ravi Kumar', editions: ['morning', 'evening'] });
  assert.deepEqual(newsletterIntent({ op: 'unsubscribe', email: 'a@muns.io' }).editions, null);
  assert.throws(() => newsletterIntents([{ op: 'unsubscribe', email: 'a@muns.io' }, { op: 'subscribe', email: 'A@MUNS.IO', by: 'x' }]), /Duplicate/);
  assert.throws(() => newsletterIntents([]), /1 to 20/);
});

await test('the schedule defaults to 08:00 and 16:00 IST and refuses a morning after the evening', () => {
  assert.deepEqual(newsletterSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(newsletterSettings({ morning: { time: '07:30' } }).morning, { enabled: true, time: '07:30' });
  assert.throws(() => newsletterSettings({ morning: { time: '8am' } }), /HH:MM/);
  assert.throws(() => newsletterSettings({ morning: { time: '17:00' } }), /before the evening/);
});

await test('the Indian clock: a fixed +05:30, weekdays only, and the previous weekday steps over a weekend', () => {
  assert.equal(istDay(Date.UTC(2026, 8, 16, 20, 0)), '2026-09-17', '01:30 IST is the next day');
  assert.equal(istLabel(istInstant('2026-09-17', '08:00')), 'Thu 17 Sep, 08:00 IST');
  assert.equal(previousWeekday('2026-09-21'), '2026-09-18', 'Monday looks back to Friday');
  assert.equal(previousWeekday('2026-09-17'), '2026-09-16');
});

await test('the morning window reaches back to the previous weekday evening; the evening to that morning', () => {
  const s = DEFAULT_SETTINGS;
  const monday = editionWindow('morning', '2026-09-21', s);
  assert.equal(istLabel(monday.from), 'Fri 18 Sep, 16:00 IST');
  assert.equal(istLabel(monday.to), 'Mon 21 Sep, 08:00 IST');
  const evening = editionWindow('evening', '2026-09-17', s);
  assert.equal(istLabel(evening.from), 'Thu 17 Sep, 08:00 IST');
  assert.equal(istLabel(evening.to), 'Thu 17 Sep, 16:00 IST');
  const onDemand = editionWindow('morning', '2026-09-17', s, { to: istInstant('2026-09-17', '11:00') });
  assert.equal(istLabel(onDemand.to), 'Thu 17 Sep, 11:00 IST', 'a brief built on request covers up to now');
});

await test('the next send skips weekends and switched-off editions, and vanishes when both are off', () => {
  const s = DEFAULT_SETTINGS;
  const fridayNoon = istInstant('2026-09-18', '12:00');
  assert.deepEqual(nextScheduled(s, fridayNoon), { edition: 'evening', day: '2026-09-18', at: istInstant('2026-09-18', '16:00'), key: '2026-09-18:evening' });
  const fridayNight = istInstant('2026-09-18', '20:00');
  assert.equal(nextScheduled(s, fridayNight).key, '2026-09-21:morning', 'Friday night looks to Monday morning');
  assert.equal(nextScheduled({ ...s, morning: { enabled: false, time: '08:00' } }, fridayNight).key, '2026-09-21:evening');
  assert.equal(nextScheduled({ morning: { enabled: false, time: '08:00' }, evening: { enabled: false, time: '16:00' } }, fridayNight), null);
  assert.deepEqual(scheduledEditions(s, istInstant('2026-09-18', '15:00'), istInstant('2026-09-21', '09:00')).map((e) => e.key),
    ['2026-09-18:evening', '2026-09-21:morning']);
});

// ---- the store ------------------------------------------------------------------------------------

console.log('\n— the store —');

let clock = Date.parse('2026-09-16T05:00:00.000Z');
const makeStore = () => new NewsletterStore(sqlStorage(), { now: () => (clock += 1000) });

await test('subscribe, update, unsubscribe and re-subscribe are one row with a stated state each time', () => {
  const store = makeStore();
  assert.equal(store.snapshot().count, 0);
  let out = store.apply([{ op: 'subscribe', email: 'Pratik@muns.io', by: 'Pratik', editions: ['morning'] }]);
  assert.deepEqual(out.outcomes, [{ email: 'pratik@muns.io', outcome: 'subscribed' }]);
  assert.equal(out.snapshot.subscribers[0].addedBy, 'Pratik');
  assert.deepEqual(out.snapshot.subscribers[0].editions, ['morning']);
  out = store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Someone', editions: ['morning'] }]);
  assert.equal(out.outcomes[0].outcome, 'unchanged', 'a repeated add changes nothing and does not move the revision');
  const revision = out.snapshot.revision;
  out = store.apply([{ op: 'editions', email: 'pratik@muns.io', editions: ['morning', 'evening'] }]);
  assert.equal(out.outcomes[0].outcome, 'updated');
  assert.equal(out.snapshot.revision, revision + 1);
  assert.deepEqual(store.recipients('evening').map((r) => r.email), ['pratik@muns.io']);
  out = store.apply([{ op: 'unsubscribe', email: 'pratik@muns.io' }]);
  assert.equal(out.outcomes[0].outcome, 'unsubscribed');
  assert.equal(out.snapshot.count, 0);
  assert.equal(store.apply([{ op: 'editions', email: 'pratik@muns.io', editions: ['morning'] }]).outcomes[0].outcome, 'not-subscribed');
  out = store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Ravi' }]);
  assert.equal(out.outcomes[0].outcome, 'subscribed');
  assert.equal(out.snapshot.subscribers[0].addedBy, 'Ravi', 'a re-subscription records who did it this time');
});

await test('the list has a ceiling and a refusal never reads as subscribed', () => {
  const store = makeStore();
  for (let i = 0; i < NEWSLETTER_SUBSCRIBER_LIMIT; i += 10) {
    store.apply(Array.from({ length: 10 }, (_, j) => ({ op: 'subscribe', email: `person${i + j}@muns.io`, by: 'Desk' })));
  }
  const out = store.apply([{ op: 'subscribe', email: 'one-more@muns.io', by: 'Desk' }]);
  assert.equal(out.outcomes[0].outcome, 'full');
  assert.equal(out.snapshot.count, NEWSLETTER_SUBSCRIBER_LIMIT);
});

await test('settings persist, an unchanged save moves nothing, a bad one is refused', () => {
  const store = makeStore();
  assert.equal(store.setSettings({ morning: { time: '07:30' } }).changed, true);
  assert.equal(store.settings().morning.time, '07:30');
  assert.equal(store.setSettings({ morning: { time: '07:30' } }).changed, false);
  assert.throws(() => store.setSettings({ evening: { time: '07:00' } }), /before the evening/);
  assert.equal(store.settings().evening.time, '16:00');
});

await test('a delivery key is claimed once, ever', () => {
  const store = makeStore();
  assert.equal(store.beginDelivery({ key: '2026-09-17:morning', edition: 'morning', day: '2026-09-17', scheduledAt: MORNING, source: 'timer', recipients: 2 }), true);
  assert.equal(store.beginDelivery({ key: '2026-09-17:morning', edition: 'morning', day: '2026-09-17', scheduledAt: MORNING, source: 'timer', recipients: 2 }), false);
  store.finishDelivery('2026-09-17:morning', { sent: 2, failed: 0, outcomes: [{ email: 'a@muns.io', ok: true }, { email: 'b@muns.io', ok: true }], subject: 'x' });
  assert.equal(store.beginDelivery({ key: '2026-09-17:morning', edition: 'morning', day: '2026-09-17', source: 'timer', recipients: 2 }), false, 'a finished key stays claimed');
  const d = store.deliveries(5)[0];
  assert.equal(d.sent, 2); assert.equal(d.outcomes.length, 2); assert.ok(d.finishedAt);
});

// ---- the brief --------------------------------------------------------------------------------------

console.log('\n— the brief —');

await test('a Yahoo chart becomes a quote with its own session state and time', () => {
  const sp = quoteFromChart(JSON.parse(fixture('yahoo-sp500.json')), MARKET_ROWS[0], MORNING);
  assert.equal(sp.state, 'close', 'the US session is over at 08:00 IST');
  assert.ok(sp.last > 0 && sp.prev > 0 && Number.isFinite(sp.changePct));
  assert.equal(sp.timezone, 'America/New_York');
  const nikkei = quoteFromChart(JSON.parse(fixture('yahoo-nikkei.json')), MARKET_ROWS[3], MORNING);
  assert.equal(nikkei.state, 'live', 'Tokyo is trading at 08:00 IST');
  assert.throws(() => quoteFromChart({ chart: { result: [{ meta: {} }] } }, MARKET_ROWS[0], MORNING), /shape/);
});

await test('the series store fills a refused symbol and says so with the store\'s own date', () => {
  const manifest = JSON.parse(asset('/data/series/index.json'));
  const row = quoteFromSeries(manifest, MARKET_ROWS[0]);
  assert.equal(row.state, 'stored');
  assert.match(row.storedDay, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(quoteFromSeries(manifest, { ...MARKET_ROWS[4] }), null, 'a symbol with no series stays unavailable');
});

await test('the desk\'s keyword families fold onto the seven topics, and nothing matched is Other', () => {
  assert.equal(topicOf({ keywordIds: ['order'], keywordGroups: ['growth'] }).id, 'orders');
  assert.equal(topicOf({ keywordIds: ['capex'], keywordGroups: ['growth'] }).id, 'growth');
  assert.equal(topicOf({ keywordIds: ['credit-rating'], keywordGroups: ['risk'] }).id, 'trouble');
  assert.equal(topicOf({ keywordIds: [], keywordGroups: [] }).id, 'other');
  assert.deepEqual(TOPICS.map((t) => t.label), ['Growth', 'Orders', 'Deals', 'Money', 'Approvals & IP', 'Trouble', 'Other']);
});

let morning;
await test('the morning brief builds from the fixtures and every section states its window and sources', async () => {
  const log = [];
  morning = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher({ log }), now: MORNING });
  assert.equal(log.filter((l) => l.kind === 'yahoo').length, MARKET_ROWS.length, 'one chart read per symbol');
  assert.equal(log.filter((l) => l.kind === 'nse').length, 1);
  assert.equal(morning.markets.rows.length, MARKET_ROWS.length);
  assert.deepEqual(morning.markets.failed, []);
  assert.equal(istLabel(morning.window.from), 'Wed 16 Sep, 16:00 IST');
  assert.equal(istLabel(morning.window.to), 'Thu 17 Sep, 08:00 IST');
  assert.ok(morning.book.listed > 100, 'the book\'s listed lines are the denominator');
  assert.equal(morning.announcements.nse.ok, true);
  const aarti = morning.announcements.groups.find((g) => g.ticker === 'AARTIDRUGS');
  assert.ok(aarti, 'a filing by a book company inside the window joins');
  assert.equal(aarti.items.length, 2);
  const order = aarti.items.find((i) => /Receipt of order/.test(i.headline));
  assert.ok(order.keywords.includes('Receipt of Order'), 'the exchange\'s own phrase is a tracked keyword');
  assert.equal(order.direction, 'neutral', 'a customer order receipt is not called an award by the filing rule');
  const downgrade = aarti.items.find((i) => /downgrade/.test(i.headline));
  assert.equal(downgrade.direction, 'negative', 'the filing rule reads a downgrade as negative');
  assert.equal(morning.news.source.ok, true);
  assert.ok(morning.news.source.publishers.length >= 1);
  for (const g of morning.news.groups) for (const item of g.items) assert.ok(item.at >= morning.window.from && item.at < morning.window.to);
});

await test('the broadsheet carries the Glow Ventures masthead, escapes the exchanges\' text and dates every figure', () => {
  const html = renderBriefHtml(morning, { dashboardUrl: 'https://example.test', recipient: { email: 'pratik@muns.io', addedBy: 'Ravi' } });
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('<meta name="color-scheme" content="light">'));
  assert.ok(html.includes('letter-spacing:6px;color:#1a1712;">GLOW VENTURES</div>'), 'the masthead is the family office\'s name');
  assert.ok(!html.includes('MUNSHOT'), 'no Munshot masthead on a Glow Ventures brief');
  assert.ok(html.includes('border-top:3px double #1a1712'), 'the double rule');
  assert.ok(html.includes('Research Central — Morning Portfolio Brief'));
  assert.ok(html.includes('Edition: Portfolio companies'));
  assert.ok(html.includes('Glow Ventures · Research Central'), 'the caption under the sheet');
  assert.ok(html.includes('https://example.test/#/research/ask-research?newsletter=manage'), 'the unsubscribe link lands on the panel');
  assert.ok(html.includes('Added by Ravi'));
  assert.ok(html.includes('Global market scan'));
  assert.ok(html.includes('S&amp;P 500'));
  assert.ok(!html.includes('<script>'), 'exchange text is escaped');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(/Close · \w{3} \d{2}:\d{2} \w+/.test(html), 'a closed market prints its close time');
  assert.ok(/Live · \w{3} \d{2}:\d{2} \w+/.test(html), 'a trading market prints its last print');
  assert.ok(html.includes('color:#3b82f6;font-weight:bold'), 'the Orders topic colour appears');
  assert.ok(/\b1 watch-out\b/.test(html), 'the downgrade filing is counted as a watch-out on the stats line');
  assert.ok(html.includes('#f43f5e'), 'the watch-out colour appears');
  assert.ok(html.includes('Read →'), 'every story offers Read →');
  assert.ok(!html.includes('<style') && !html.includes('<script'), 'no stylesheet, no script');
  assert.ok(html.length < 200000);
  const subject = briefSubject(morning);
  assert.match(subject, /^Glow Ventures · \d+ updates? on your portfolio companies — 17 Sep$/, subject);
  const text = renderBriefText(morning);
  assert.ok(text.startsWith('GLOW VENTURES') && text.includes('GLOBAL MARKET SCAN') && text.includes('Aarti Drugs'));
  assert.ok(text.indexOf('YOUR PORTFOLIO COMPANIES') < text.indexOf('GLOBAL MARKET SCAN'), 'the text copy leads with the companies too');
});

await test('the portfolio companies lead the sheet, each company once, strongest first, with its stories under it', () => {
  const html = renderBriefHtml(morning, { dashboardUrl: 'https://example.test' });
  const stats = briefStats(morning);
  assert.ok(stats.companies.length > 0);
  assert.equal(stats.companies.reduce((n, c) => n + c.stories.length, 0), stats.stories, 'every story sits under exactly one company');
  assert.equal(new Set(stats.companies.map((c) => c.ticker)).size, stats.companies.length, 'a company appears once, filings and news together');
  for (let i = 1; i < stats.companies.length; i++) {
    const [a, b] = [stats.companies[i - 1], stats.companies[i]];
    assert.ok(a.score > b.score || (a.score === b.score && a.stories.length >= b.stories.length), `${a.ticker} before ${b.ticker}`);
  }
  assert.equal(stats.companies[0].ticker, 'AARTIDRUGS', 'the company with a tracked order and a downgrade leads');
  assert.ok(html.indexOf('Your portfolio companies') > 0 && html.indexOf('Your portfolio companies') < html.indexOf('Global market scan'), 'companies before the market scan');
  assert.ok(html.indexOf('Aarti Drugs') < html.indexOf('Global market scan'));
  assert.ok(html.includes(`across <strong style="color:#1a1712;">${stats.companies.length} of ${morning.book.listed}</strong> portfolio companies`), 'the summary counts companies against the book');
  assert.ok(html.includes('https://example.test/#/research/daily-alerts?scope=portfolio&amp;company=AARTIDRUGS'), 'a company links to its own alerts on the dashboard');
});

await test('every link in the brief opens in a new tab', () => {
  const html = renderBriefHtml(morning, { dashboardUrl: 'https://example.test', recipient: { email: 'pratik@muns.io' } });
  const anchors = html.match(/<a\s[^>]*>/g) || [];
  assert.ok(anchors.length > 5, 'stories, companies and the footer carry links');
  for (const a of anchors) {
    assert.ok(a.includes('target="_blank"'), a);
    assert.ok(a.includes('rel="noopener noreferrer"'), a);
  }
  assert.ok(html.includes('<base target="_blank">'), 'the preview page opens anything else in a new tab too');
});

await test('a refused quote source and a blocked exchange are stated on the page, never drawn as numbers', async () => {
  const brief = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher({ yahoo: 'down', nse: 'blocked' }), now: istInstant('2026-09-17', '16:00') });
  assert.ok(brief.markets.stored.length > 0, 'the series store fills what it can');
  assert.ok(brief.markets.failed.includes('taiex'), 'a symbol with no series stays unavailable');
  assert.equal(brief.announcements.nse.ok, false);
  assert.equal(brief.announcements.nse.reason, 'blocked');
  const html = renderBriefHtml(brief);
  assert.ok(html.includes('Series store · '), 'a stored figure carries the store\'s date');
  assert.ok(html.includes('unavailable'));
  assert.ok(html.includes('NSE feed could not be read (blocked)'));
  const stats = briefStats(brief);
  assert.equal(stats.stories, brief.announcements.count + brief.news.count);
});

await test('with nothing filed or published the sheet says so, and only about what it could read', async () => {
  const brief = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher(), now: istInstant('2026-09-17', '02:00') });
  const html = renderBriefHtml(brief);
  if (!briefStats(brief).stories) {
    assert.ok(html.includes('Quiet day — nothing to report.'));
    assert.ok(html.includes('Nothing was filed or published about a portfolio company in this window.'));
  }
  assert.ok(html.includes('GLOW VENTURES'));
});

// ---- the schedule -----------------------------------------------------------------------------------

console.log('\n— the schedule —');

function makeSchedule({ env = {}, fetcherOptions = {}, now = () => clock } = {}) {
  const storage = new Storage();
  const store = new NewsletterStore(storage, { now });
  const log = fetcherOptions.log || (fetcherOptions.log = []);
  const schedule = new NewsletterSchedule(storage, { ASSETS: assets, MUNS_TOKEN: 'team-secret-token', ...env }, store, { fetcher: makeFetcher(fetcherOptions), now });
  return { storage, store, schedule, log };
}

await test('arming points the alarm at the next weekday send and re-arms after every wake', async () => {
  clock = istInstant('2026-09-16', '17:00');
  const { storage, store, schedule } = makeSchedule();
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }]);
  assert.equal(await storage.getAlarm(), null);
  await schedule.arm();
  assert.equal(await storage.getAlarm(), MORNING, 'Wednesday evening arms Thursday 08:00 IST');
  const status = await schedule.status();
  assert.equal(status.next.key, '2026-09-17:morning');
  assert.equal(status.tokenConfigured, true);
  store.setSettings({ morning: { enabled: false, time: '08:00' } });
  await schedule.arm();
  assert.equal(await storage.getAlarm(), istInstant('2026-09-17', '16:00'), 'switching the morning off moves the alarm to the evening');
});

await test('the alarm sends the morning brief to its subscribers once, with html only, and a replay sends nothing', async () => {
  clock = istInstant('2026-09-16', '17:00');
  const { storage, store, schedule, log } = makeSchedule();
  store.apply([
    { op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik', name: 'Pratik' },
    { op: 'subscribe', email: 'ravi@muns.io', by: 'Pratik', editions: ['evening'] },
    { op: 'subscribe', email: 'meera@muns.io', by: 'Pratik' },
  ]);
  await schedule.arm();
  clock = MORNING + 5000;
  await schedule.wake();
  const emails = log.filter((l) => l.kind === 'email');
  assert.deepEqual(emails.map((e) => e.to).sort(), ['meera@muns.io', 'pratik@muns.io'], 'only morning subscribers, ravi is evening-only');
  for (const e of emails) {
    assert.equal(e.method, 'POST');
    assert.equal(e.auth, 'Bearer team-secret-token');
    assert.ok(e.html && e.text === undefined, 'exactly one of html/text');
    assert.match(e.subject, /^Glow Ventures · \d+ updates? on your portfolio companies — 17 Sep$/);
    assert.ok(e.html.includes('GLOW VENTURES'));
  }
  const delivery = store.delivery('2026-09-17:morning');
  assert.equal(delivery.sent, 2); assert.equal(delivery.failed, 0); assert.equal(delivery.source, 'timer');
  assert.ok(delivery.finishedAt);
  assert.equal(delivery.summary.quotes, MARKET_ROWS.length);
  assert.equal(await storage.getAlarm(), istInstant('2026-09-17', '16:00'), 're-armed for the evening');
  const before = log.length;
  await schedule.wake();
  assert.equal(log.length, before, 'a replayed alarm reads nothing and sends nothing');
  assert.equal((await schedule.status()).lastResult, 'nothing-due');
  assert.ok(!JSON.stringify([...storage.data.values()]).includes('team-secret-token'), 'the token never enters durable storage');
});

await test('without a token the delivery is recorded as no-token against every recipient and nothing is posted', async () => {
  clock = istInstant('2026-09-16', '17:00');
  const { store, schedule, log } = makeSchedule({ env: { MUNS_TOKEN: undefined } });
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }]);
  await schedule.arm();
  clock = MORNING + 1000;
  await schedule.wake();
  assert.equal(log.filter((l) => l.kind === 'email').length, 0);
  assert.equal(log.filter((l) => l.kind === 'yahoo').length, 0, 'nothing is even built without a way to send it');
  const d = store.delivery('2026-09-17:morning');
  assert.equal(d.reason, 'no-token'); assert.equal(d.failed, 1); assert.deepEqual(d.outcomes, [{ email: 'pratik@muns.io', ok: false, reason: 'no-token' }]);
  assert.equal((await schedule.status()).tokenConfigured, false);
});

await test('a refused send is a failure per recipient, never a sent count, and carries no upstream text', async () => {
  clock = istInstant('2026-09-16', '17:00');
  const { storage, store, schedule } = makeSchedule({ fetcherOptions: { email: 'unauthorised' } });
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }]);
  await schedule.arm();
  clock = MORNING + 1000;
  await schedule.wake();
  const d = store.delivery('2026-09-17:morning');
  assert.equal(d.sent, 0); assert.equal(d.failed, 1); assert.equal(d.reason, 'unauthorised');
  assert.equal(d.outcomes[0].status, 401);
  assert.ok(!JSON.stringify([...storage.data.values()]).includes('private upstream'));
  assert.ok(!JSON.stringify(store.snapshot()).includes('private upstream'));
});

await test('an edition the timer reaches hours late is recorded as missed rather than sent at lunch', async () => {
  clock = istInstant('2026-09-16', '17:00');
  const { store, schedule, log } = makeSchedule();
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }]);
  await schedule.arm();
  clock = MORNING + CATCH_UP_MS + 60000;
  await schedule.wake();
  assert.equal(log.filter((l) => l.kind === 'email').length, 0);
  assert.equal(store.delivery('2026-09-17:morning').reason, 'missed');
});

await test('a test copy goes to one address only, covers up to now, and never claims the scheduled key', async () => {
  clock = istInstant('2026-09-17', '10:30');
  const { store, schedule, log } = makeSchedule({ env: { MUNS_TOKEN: undefined } });
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }, { op: 'subscribe', email: 'meera@muns.io', by: 'Pratik' }]);
  assert.equal((await schedule.sendNow({ edition: 'morning', to: 'me', email: 'nobody' })).reason, 'invalid-email');
  const out = await schedule.sendNow({ edition: 'morning', to: 'me', email: 'Pratik@muns.io' }, 'reader-session-token');
  assert.equal(out.ok, true); assert.equal(out.sent, 1);
  const emails = log.filter((l) => l.kind === 'email');
  assert.equal(emails.length, 1); assert.equal(emails[0].to, 'pratik@muns.io');
  assert.equal(emails[0].auth, 'Bearer reader-session-token', 'the reader\'s own token stands in when the Worker has none');
  assert.ok(emails[0].html.includes('This is a test copy you asked for.'));
  assert.ok(emails[0].html.includes('built on request'));
  assert.ok(emails[0].html.includes('10:30 IST'), 'the on-demand window runs up to now');
  assert.equal(store.delivery('2026-09-17:morning'), null, 'the scheduled key is untouched');
  assert.equal(store.deliveries(1)[0].source, 'test');
});

await test('sending to everyone cools down for five minutes and a second press within it is refused', async () => {
  clock = istInstant('2026-09-17', '10:30');
  const { store, schedule, log } = makeSchedule();
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }, { op: 'subscribe', email: 'meera@muns.io', by: 'Pratik' }]);
  const out = await schedule.sendNow({ edition: 'evening', to: 'all' });
  assert.equal(out.sent, 2);
  assert.equal(log.filter((l) => l.kind === 'email').length, 2);
  clock += 60000;
  assert.equal((await schedule.sendNow({ edition: 'evening', to: 'all' })).reason, 'cooling-down');
  assert.equal(log.filter((l) => l.kind === 'email').length, 2);
  assert.equal((await schedule.sendNow({ edition: 'evening', to: 'nobody' })).reason, 'invalid-target');
});

await test('a preview builds the edition up to now without sending, in html or text', async () => {
  clock = istInstant('2026-09-17', '10:30');
  const { schedule, log } = makeSchedule();
  const html = await schedule.preview({ edition: 'morning' });
  assert.equal(html.ok, true); assert.ok(html.body.startsWith('<!doctype html>')); assert.match(html.subject, /^Glow Ventures ·/);
  const text = await schedule.preview({ edition: 'morning', format: 'text' });
  assert.ok(text.body.startsWith('GLOW VENTURES'));
  assert.equal(log.filter((l) => l.kind === 'email').length, 0);
  assert.equal((await schedule.preview({ edition: 'weekly' })).reason, 'invalid-edition');
});

await test('sendEmail sends exactly one body and names every failure without the upstream\'s words', async () => {
  const log = [];
  await assert.rejects(() => sendEmail({ fetcher: makeFetcher({ log }), token: 't', email: 'a@muns.io', subject: 's', html: '<p>x</p>', text: 'x' }), /exactly one/);
  await assert.rejects(() => sendEmail({ fetcher: makeFetcher({ log }), token: 't', email: 'a@muns.io', subject: 's' }), /exactly one/);
  assert.deepEqual(await sendEmail({ fetcher: makeFetcher({ log }), token: 't', email: 'a@muns.io', subject: 's', text: 'plain' }), { ok: true, status: 200, reason: null });
  assert.equal(log.at(-1).text, 'plain'); assert.equal(log.at(-1).html, undefined);
  assert.equal((await sendEmail({ fetcher: makeFetcher({ email: 'down' }), token: 't', email: 'a@muns.io', subject: 's', html: 'x' })).reason, 'upstream');
  assert.equal((await sendEmail({ fetcher: makeFetcher({ email: 'hang' }), token: 't', email: 'a@muns.io', subject: 's', html: 'x' })).reason, 'timeout');
});

console.log(`\n${count - failures} of ${count} passed`);
if (failures) process.exit(1);

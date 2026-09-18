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
  DEFAULT_SETTINGS, EDITION_IDS, NEWSLETTER_SUBSCRIBER_LIMIT, REPORTED_RETENTION_MS,
  dayOnlyInstant, editionWindow, istDay, istInstant, istLabel, lateArrivalsFrom, newsletterIntent, newsletterIntents, newsletterSettings,
  nextScheduled, normaliseEmail, normaliseEmailList, previousWeekday, scheduledEditions,
} from '../public/js/data/newsletter-shared.js';
import { NewsletterStore } from '../worker/newsletter-store.mjs';
import {
  MARKET_ROWS, MOVE_PCT, TOPICS, briefStats, briefStories, briefSubject, buildBrief, quoteFromChart, quoteFromSeries, renderBriefHtml, renderBriefText, topicOf,
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
/** The committed files, with named paths replaced by a fixture object (or removed with null), and every path asked for recorded. */
function assetsWith(overrides = {}, requested = []) {
  return {
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      requested.push(path);
      if (path in overrides) {
        return overrides[path] == null ? new Response('missing', { status: 404 }) : new Response(JSON.stringify(overrides[path]), { headers: { 'content-type': 'application/json' } });
      }
      try { return new Response(asset(path), { headers: { 'content-type': 'application/json' } }); } catch { return new Response('missing', { status: 404 }); }
    },
  };
}
/** A ledger stand-in: `keys` are what the desk has been sent, `since` where the ledger's knowledge begins. */
const ledger = (keys = [], since = null) => ({ empty: false, size: keys.length || 1, since, has: (key) => keys.includes(key) });
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
  assert.deepEqual(TOPICS.map((t) => t.label), ['Growth', 'Orders', 'Deals', 'Money', 'Approvals & IP', 'Trouble', 'Trades', 'Price', 'Other']);
  assert.equal(topicOf({ kind: 'trade', keywordIds: ['order'], keywordGroups: ['growth'] }).id, 'trades', 'a trade is a trade whatever its cells say');
  assert.equal(topicOf({ kind: 'move' }).id, 'price');
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
  assert.ok(html.includes('NSE live feed could not be read (blocked)'));
  assert.ok(html.includes('NSE history'), 'the retained day files are a source of their own and are named as one');
  const stats = briefStats(brief);
  assert.equal(stats.stories, brief.announcements.count + brief.news.count + brief.trades.count + brief.moves.count, 'every story on the sheet is one the sources counted');
});

await test('with nothing filed or published the sheet says so, and only about what it could read', async () => {
  const brief = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher(), now: istInstant('2026-09-17', '02:00') });
  const html = renderBriefHtml(brief);
  if (!briefStats(brief).stories) {
    assert.ok(html.includes('Quiet window — nothing to report.'));
    assert.ok(html.includes('Nothing was filed, published, traded or moved about a portfolio company in this window.'));
  }
  assert.ok(html.includes('GLOW VENTURES'));
});

// ---- nothing falls between two briefs -------------------------------------------------------------

console.log('\n— coverage —');

const BOOK_ROW = (overrides = {}) => ({
  newsId: 'late-order-1', scripCode: '524348', company: 'Aarti Drugs Ltd', headline: 'Receipt of order from an overseas customer worth Rs 40 crore',
  category: 'Company Update', subCategory: 'Award of Order / Receipt of Order', date: '2026-09-16', time: '15:50:00', url: 'https://www.bseindia.com/xml-data/corpfiling/late-order-1.pdf', ...overrides,
});
const bseWith = (rows) => ({ capturedAt: '2026-09-17T02:20:00.000Z', from: '2026-09-15', to: '2026-09-17', byTicker: { AARTIDRUGS: rows } });
const findStory = (brief, test) => briefStories(brief).find(test) || null;

await test('a filing captured after the previous brief went out reaches the next brief once, marked, and never twice', async () => {
  // 15:50 on the 16th is inside the previous (evening) window; the 08:00 brief on the 17th is the next send.
  const build = (reported) => buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assetsWith({ '/data/corp-announcements.json': bseWith([BOOK_ROW()]) }) }, fetcher: makeFetcher({ nse: 'blocked' }), now: MORNING, reported });
  const isLate = (s) => s.kind === 'filing' && s.ticker === 'AARTIDRUGS' && /overseas customer/.test(s.headline);

  const unknown = await build(null);
  assert.equal(findStory(unknown, isLate), null, 'with no ledger at all nothing outside the window is read: "unknown" is not "not sent"');
  assert.equal(unknown.lateFrom, null);

  const unsent = await build(ledger([]));
  const late = findStory(unsent, isLate);
  assert.ok(late, 'against a ledger that does not hold it, the filing is carried');
  assert.equal(late.late, true);
  assert.deepEqual(late.keys, ['bse:late-order-1'], 'the ledger key is the exchange\'s own stable id');
  assert.equal(istLabel(unsent.lateFrom), istLabel(lateArrivalsFrom('morning', '2026-09-17', DEFAULT_SETTINGS)), 'the lookback reaches two windows back');
  assert.equal(briefStats(unsent).late, briefStories(unsent).filter((s) => s.late).length);
  assert.ok(briefStats(unsent).late >= 1);
  const html = renderBriefHtml(unsent, { dashboardUrl: 'https://example.test' });
  assert.ok(html.includes('not in the previous brief'), 'a late arrival says so on its row');
  assert.ok(html.includes(`${briefStats(unsent).late} not in the previous brief`), 'and the summary line counts them');
  assert.ok(/16 Sept, 15:50 IST/.test(html), 'it keeps its own publication time, never the brief\'s');
  assert.ok(unsent.reported.some((r) => r.key === 'bse:late-order-1' && r.publishedAt === istInstant('2026-09-16', '15:50')), 'a send of this brief would put the filing in the ledger');

  const sent = await build(ledger(['bse:late-order-1']));
  assert.equal(findStory(sent, isLate), null, 'once the desk has been sent it, it is not sent again');

  const before = await build(ledger([], istInstant('2026-09-16', '16:00')));
  assert.equal(findStory(before, isLate), null, 'nothing published before the ledger began is judged unsent — an earlier brief carried it');
  assert.equal(before.lateFrom, null, 'a lookback the ledger cannot vouch for collapses to the window');

  const monday = editionWindow('morning', '2026-09-21', DEFAULT_SETTINGS);
  assert.equal(istLabel(lateArrivalsFrom('morning', '2026-09-21', DEFAULT_SETTINGS)), 'Thu 17 Sep, 16:00 IST', 'Monday looks back over Friday\'s two windows');
  assert.ok(lateArrivalsFrom('morning', '2026-09-21', DEFAULT_SETTINGS) < monday.from);
});

await test('a filing inside the window is carried whether or not the ledger holds it, and the ledger never suppresses the window', async () => {
  const row = BOOK_ROW({ newsId: 'in-window-1', date: '2026-09-16', time: '18:10:00', headline: 'Credit rating upgraded by CRISIL' });
  const env = { ASSETS: assetsWith({ '/data/corp-announcements.json': bseWith([row]) }) };
  for (const reported of [null, ledger([]), ledger(['bse:in-window-1'])]) {
    const brief = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env, fetcher: makeFetcher({ nse: 'blocked' }), now: MORNING, reported });
    const story = findStory(brief, (s) => s.kind === 'filing' && /CRISIL/.test(s.headline));
    assert.ok(story, 'the printed window is a promise about what is inside it');
    assert.equal(story.late, false);
    assert.equal(story.mood.id, 'good', 'the filing rule reads an upgrade as positive');
  }
});

await test('NSE\'s retained day files are read for the window, only the days the index holds, and resolved against the book', async () => {
  const requested = [];
  const dayRow = { company: 'Aarti Drugs Ltd', url: 'https://nsearchives.nseindia.com/corporate/AARTIDRUGS_16092026183000_history.pdf', subject: 'Analyst/Investor Meet Para A-XBRL', description: 'Aarti Drugs Ltd has informed the Exchange about Schedule of Analysts or Institutional Investors Meet |SUBJECT: Analyst/Investor Meet Para A-XBRL', publishedAt: '2026-09-16T13:00:00.000Z', symbolHint: 'AARTIDRUGS', ticker: null, resolvedBy: null, observedAt: '2026-09-16T13:30:00.000Z' };
  const env = { ASSETS: assetsWith({
    '/data/nse-filings/index.json': { version: 1, capturedAt: '2026-09-17T02:00:00.000Z', count: 2, days: [{ day: '2026-09-16', count: 1 }, { day: '2026-09-17', count: 1 }] },
    '/data/nse-filings/2026-09-16.json': { day: '2026-09-16', rows: [dayRow] },
    '/data/nse-filings/2026-09-17.json': { day: '2026-09-17', rows: [{ ...dayRow, url: 'https://nsearchives.nseindia.com/corporate/AARTIDRUGS_17092026071500_test.pdf', publishedAt: '2026-09-17T01:45:00.000Z', description: 'Aarti Drugs Ltd has informed the Exchange regarding Receipt of order from a customer |SUBJECT: Bagging/Receiving of orders/contracts', subject: 'Bagging/Receiving of orders/contracts' }] },
    '/data/nse-filings/2026-09-15.json': null,
  }, requested) };
  const brief = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env, fetcher: makeFetcher({ nse: 'blocked' }), now: MORNING });
  assert.equal(brief.announcements.nse.ok, false, 'the live feed is blocked in this run');
  assert.deepEqual(brief.announcements.nseHistory.days, ['2026-09-16', '2026-09-17']);
  assert.ok(!requested.includes('/data/nse-filings/2026-09-15.json'), 'a day the index does not list is never asked for');
  const meet = findStory(brief, (s) => s.kind === 'filing' && s.ticker === 'AARTIDRUGS' && /Investors Meet/.test(s.headline));
  assert.ok(meet, 'a history row with no ticker is resolved by the book\'s own name');
  assert.equal(meet.source, 'NSE');
  assert.equal(istLabel(meet.at), 'Wed 16 Sep, 18:30 IST');
  const order = findStory(brief, (s) => s.kind === 'filing' && s.ticker === 'AARTIDRUGS' && /Receipt of order from a customer/.test(s.headline));
  assert.ok(order, 'the history copy of the live fixture\'s filing is one filing');
  assert.equal(briefStories(brief).filter((s) => s.kind === 'filing' && s.ticker === 'AARTIDRUGS' && /Receipt of order from a customer/.test(s.headline)).length, 1, 'never two rows for one filing');
  assert.ok(renderBriefHtml(brief).includes('NSE history 2 day files (2026-09-16, 2026-09-17)'), 'the sources line names the day files read');
});

await test('routine filings are counted on the page and not listed, so they cannot crowd out a material one', async () => {
  const rows = [
    BOOK_ROW({ newsId: 'np-1', date: '2026-09-16', time: '18:00:00', subCategory: 'Newspaper Publication', category: 'Company Update', headline: 'Newspaper publication of the unaudited financial results' }),
    BOOK_ROW({ newsId: 'res-1', date: '2026-09-16', time: '18:05:00', subCategory: 'Financial Results', category: 'Result', headline: 'Unaudited financial results for the quarter ended 30 June 2026' }),
  ];
  // BSE only in this run: the NSE index is emptied so the count is the fixture's and nothing else's.
  const brief = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assetsWith({ '/data/corp-announcements.json': bseWith(rows), '/data/nse-filings/index.json': { version: 1, capturedAt: '2026-09-17T02:00:00.000Z', count: 0, days: [] } }) }, fetcher: makeFetcher({ nse: 'blocked' }), now: MORNING });
  assert.equal(brief.announcements.routineHidden, 1);
  assert.equal(findStory(brief, (s) => /Newspaper publication/.test(s.headline)), null);
  assert.ok(findStory(brief, (s) => /Unaudited financial results/.test(s.headline)), 'the result itself is listed');
  const html = renderBriefHtml(brief);
  assert.ok(html.includes('1 routine filing (newspaper copies'), html.match(/\d+ routine filing[^<]*/)?.[0]);
  assert.ok(!brief.reported.some((r) => r.key === 'bse:np-1'), 'a filing not shown is not marked as sent');
});

await test('trades on a holding come from the insider archive, dated day-only, read with the dashboard\'s own direction and thresholds', async () => {
  const EVENING = istInstant('2026-09-17', '16:00');
  const bseCode = JSON.parse(asset('/data/announcement-identities.json')).entries.find((e) => e.ticker === 'AARTIDRUGS')?.bseCode;
  assert.ok(bseCode, 'the identity file carries the book company\'s BSE code');
  const rows = [
    { ticker: 'AARTIDRUGS', date: '2026-09-17', url: 'https://www.screener.in/trades/insiders/?o=-2', sourceId: 'insiders', cells: { 'Trade Category': 'Insider trade', Company: 'Aarti Drugs', Insider: 'Ramesh Shah', Category: 'Promoter', 'Security Type': 'Equity', Transaction: 'Sold', 'Trade Shares': '50000', 'Trade Value': '2.25 crore', 'Broadcast Date': '2026-09-17', Source: 'Screener.in' } },
    { ticker: String(bseCode), date: '2026-09-17', url: 'https://www.screener.in/trades/sast/?o=-2', sourceId: 'sast', cells: { 'Trade Category': 'SAST', Company: 'Aarti Drugs', Insider: 'Long Only Fund LP', Transaction: 'Acquisition', 'Trade Shares': '2300000', 'Trade %': '2.50', Mode: 'Market', 'Broadcast Date': '2026-09-17', Source: 'Screener.in' } },
    { ticker: 'AARTIDRUGS', date: '2026-09-16', url: 'https://www.screener.in/trades/bulk/?o=-2', sourceId: 'bulk', cells: { 'Trade Category': 'Bulk deal', Company: 'Aarti Drugs', Insider: 'Some Capital LLP', 'Security Type': 'Equity', Transaction: 'Buy', 'Trade Shares': '17000', 'Trade Value': '1.88 crore', Price: '1105', 'Broadcast Date': '2026-09-16', Source: 'Screener.in' } },
    { ticker: 'NOTINBOOK', date: '2026-09-17', sourceId: 'bulk', cells: { 'Trade Category': 'Bulk deal', Company: 'Somebody Else', Insider: 'X', Transaction: 'Buy', 'Trade Shares': '1', 'Broadcast Date': '2026-09-17', Source: 'Screener.in' } },
  ];
  const env = { ASSETS: assetsWith({ '/data/insider-archive/index.json': { version: 1, months: { '2026-09': rows.length }, rowCount: rows.length, updatedAt: '2026-09-17T10:30:00.000Z' }, '/data/insider-archive/2026-09.json': { kind: 'insider', rows } }) };
  const evening = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env, fetcher: makeFetcher(), now: EVENING });
  const trades = briefStories(evening).filter((s) => s.kind === 'trade');
  assert.equal(trades.length, 2, 'the 17th\'s two disclosures; the 16th\'s is the previous day\'s and a stranger\'s is nobody\'s');
  for (const t of trades) {
    assert.equal(t.ticker, 'AARTIDRUGS');
    assert.equal(t.dayOnly, true);
    assert.equal(t.at, dayOnlyInstant('2026-09-17'), 'a day-dated record is filed at its day\'s close');
    assert.equal(t.topic.id, 'trades');
    assert.ok(t.keys[0].startsWith('trade:'), t.keys[0]);
  }
  const sold = trades.find((t) => /Sold/.test(t.headline));
  assert.equal(sold.headline, 'Insider trade: Ramesh Shah — Sold');
  assert.equal(sold.mood.id, 'watch', 'a disposal reads as a watch-out from its own transaction word');
  assert.equal(sold.importance, 'low', '₹2.25 crore is under the ₹10 crore bar');
  const sast = trades.find((t) => /SAST/.test(t.headline));
  assert.equal(sast.mood.id, 'good');
  assert.equal(sast.importance, 'high', '2.5% of the company is over the 1% bar');
  assert.ok(sast.score > sold.score, 'the material one leads');
  assert.ok(/2\.50% of the company/.test(sast.dek), sast.dek);
  const html = renderBriefHtml(evening);
  assert.ok(html.includes('17 Sept, day only'), 'no clock is invented for a broadcast day');
  assert.ok(html.includes('trades (bulk, block, SAST, insider) captured Thu 17 Sep, 16:00 IST, dated by broadcast day'));
  // The 16th's bulk deal belongs to the 16th's evening brief; captured late, it reaches the next one through the ledger.
  const morning = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env, fetcher: makeFetcher(), now: MORNING, reported: ledger([]) });
  const bulk = findStory(morning, (s) => s.kind === 'trade' && /Bulk deal/.test(s.headline));
  assert.ok(bulk && bulk.late, 'the bulk deal of the 16th is carried as not in the previous brief');
  const real = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher(), now: EVENING });
  assert.equal(real.trades.source.ok, true, 'the committed archive reads');
  assert.ok(real.trades.source.months.includes('2026-09'));
});

await test('price moves: the evening brief reads the closing quotes, the morning the completed bars, at the dashboard\'s own ±5% bar', async () => {
  const EVENING = istInstant('2026-09-17', '16:00');
  const quote = (ticker, price, prevClose, sessionDate = '2026-09-17', time = '15:47') => ({ ticker, price, prevClose, quoteAt: new Date(istInstant(sessionDate, time)).toISOString(), checkedAt: new Date(istInstant(sessionDate, time) + 60000).toISOString(), sessionDate, provider: 'Yahoo Finance' });
  const capture = { getByName: (name) => { assert.equal(name, 'breakout-capture:v1'); return { breakoutRead: async () => ({ state: 'complete', rows: [
    quote('AARTIDRUGS', 1070, 1000), quote('PURVA', 210, 218), quote('NOTINBOOK', 109, 100), quote('ABCAPITAL', 300, 200, '2026-09-16'), quote('SBIN', 950, 900, '2026-09-17', '11:00'),
  ] }) }; } };
  assert.equal(MOVE_PCT, 5);
  const evening = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assets, CAPTURE_REGISTRY: capture }, fetcher: makeFetcher(), now: EVENING });
  assert.equal(evening.moves.state, 'capture');
  assert.equal(evening.moves.session, '2026-09-17');
  const moves = briefStories(evening).filter((s) => s.kind === 'move');
  assert.equal(moves.length, 1, '+7% is a move; −3.7% is not; a stranger, yesterday\'s quote and a mid-morning print are not');
  assert.equal(moves[0].ticker, 'AARTIDRUGS');
  assert.equal(moves[0].headline, 'Up 7.0% on the day at ₹1,070.00');
  assert.equal(moves[0].mood.id, 'good');
  assert.deepEqual(moves[0].keys, ['move:AARTIDRUGS|2026-09-17']);
  assert.equal(moves[0].topic.id, 'price');
  const html = renderBriefHtml(evening);
  assert.ok(html.includes('Previous close ₹1,000.00 · last print 15:47 IST'));
  assert.ok(html.includes('prices from the closing quotes captured Thu 17 Sep, 15:47 IST for the 2026-09-17 session'));

  // No capture, and daily bars that end the previous session — the state an evening brief is in when
  // the collector did not run. (The committed file already carries the 17th, so it is aged here.)
  const behind = { ...JSON.parse(asset('/data/technicals.json')), price_date: '2026-09-16' };
  const none = await buildBrief({ edition: 'evening', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assetsWith({ '/data/technicals.json': behind }) }, fetcher: makeFetcher(), now: EVENING });
  assert.equal(none.moves.state, 'unavailable');
  assert.equal(none.moves.count, 0);
  assert.ok(renderBriefHtml(none).includes('price moves unavailable (capture-unavailable; daily-behind; daily bars end 2026-09-16)'), 'an unread price feed is named, never drawn as no moves');

  // The next morning: the completed daily bars carry the same session, keyed the same way, so a move the
  // evening brief sent is not sent again — and one it could not send is.
  const daily = JSON.parse(asset('/data/technicals.json'));
  const nextMorning = istInstant(daily.price_date, '08:00') + 86400000;
  const morning = await buildBrief({ edition: 'morning', day: istDay(nextMorning), settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher(), now: nextMorning, reported: ledger([], istInstant(daily.price_date, '08:00')) });
  assert.equal(morning.moves.state, 'daily');
  assert.equal(morning.moves.session, daily.price_date);
  const book = new Set(JSON.parse(asset('/data/portfolio-companies.json')).holdings.map((h) => h.ticker).filter(Boolean));
  // The file's list is `companies` (the resolver reads `rows || companies` too), and a row with no bar
  // date belongs to the file's own session, the fallback General Alerts make.
  const expected = (daily.rows || daily.companies || []).filter((r) => book.has(r.ticker) && (r.bar_date || daily.price_date) === daily.price_date && Math.abs(Number(r.pct_change_today)) >= MOVE_PCT).length;
  const dailyMoves = briefStories(morning).filter((s) => s.kind === 'move');
  assert.equal(dailyMoves.length, Math.min(expected, 30), 'every holding past the bar, and nothing under it');
  for (const m of dailyMoves) { assert.ok(Math.abs(m.pct) >= MOVE_PCT); assert.equal(m.late, true, 'a close before the window opened is a late arrival'); }
  const alreadySent = await buildBrief({ edition: 'morning', day: istDay(nextMorning), settings: DEFAULT_SETTINGS, env: { ASSETS: assets }, fetcher: makeFetcher(), now: nextMorning, reported: ledger(dailyMoves.map((m) => m.keys[0]), istInstant(daily.price_date, '08:00')) });
  assert.equal(briefStories(alreadySent).filter((s) => s.kind === 'move').length, 0, 'what the evening brief sent is not sent again');
});

await test('TradingView\'s symbol-tagged headlines join only under the dashboard\'s name match or as a story tagged with this company alone', async () => {
  const feed = JSON.parse(asset('/data/tradingview-news/latest.json'));
  const tv = (title, relatedSymbols, publishedAt = '2026-09-16T14:00:00.000Z') => ({ title, source: 'Reuters', url: `https://in.tradingview.com/news/${encodeURIComponent(title)}/`, publishedAt, date: publishedAt.slice(0, 10), tradingViewId: `t:${title}`, relatedSymbols, sourceSymbol: 'NSE:AARTIDRUGS', ticker: 'AARTIDRUGS' });
  const latest = { ...feed, byTicker: { AARTIDRUGS: [
    tv('Aarti Drugs wins USFDA approval for Tarapur unit', ['NSE:AARTIDRUGS', 'BSE:AARTIDRUGS', 'NSE:NIFTY', 'NSE:SUNPHARMA']),
    tv('Pharma stocks rally as rupee slides', ['NSE:AARTIDRUGS', 'NSE:SUNPHARMA', 'NSE:CIPLA', 'NSE:DRREDDY']),
    tv('Board approves capex for new API block', ['NSE:AARTIDRUGS']),
  ] } };
  const brief = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env: { ASSETS: assetsWith({ '/data/tradingview-news/latest.json': latest }) }, fetcher: makeFetcher(), now: MORNING });
  const titles = briefStories(brief).filter((s) => s.kind === 'news' && s.ticker === 'AARTIDRUGS' && /via TradingView/.test(s.source)).map((s) => s.headline);
  assert.ok(titles.includes('Aarti Drugs wins USFDA approval for Tarapur unit'), 'named in the headline');
  assert.ok(titles.includes('Board approves capex for new API block'), 'tagged with this company alone');
  assert.ok(!titles.includes('Pharma stocks rally as rupee slides'), 'a sector story tagged with four companies is not this company\'s news');
  assert.equal(brief.news.tradingview.tagged, 3);
  assert.equal(brief.news.tradingview.matched, 2);
  const story = briefStories(brief).find((s) => s.headline === 'Board approves capex for new API block');
  assert.equal(story.mood.id, 'neutral', 'a headline carries no sentiment reading');
  assert.equal(story.source, 'Reuters · via TradingView');
  assert.ok(story.keys[0].startsWith('tv:AARTIDRUGS|'));
});

// ---- the ledger ----------------------------------------------------------------------------------------

console.log('\n— the ledger —');

await test('the ledger remembers what a send carried, from the first window it recorded, and forgets after ten days', () => {
  const store = makeStore();
  assert.deepEqual([store.reportedLookup().empty, store.reportedLookup().since], [true, null]);
  const first = istInstant('2026-09-16', '08:00');
  assert.deepEqual(store.markReported([{ key: 'bse:a', publishedAt: first + 3600000 }, { key: 'nse:b', publishedAt: null }, { key: '' }], '2026-09-16:evening', { windowFrom: first }), { added: 2 });
  const lookup = store.reportedLookup();
  assert.equal(lookup.empty, false);
  assert.ok(lookup.has('bse:a') && lookup.has('nse:b') && !lookup.has('bse:c'));
  assert.equal(lookup.since, first, 'the ledger\'s knowledge begins at its first delivery\'s window');
  assert.deepEqual(store.markReported([{ key: 'bse:a', publishedAt: first }], '2026-09-17:morning', { windowFrom: first + 86400000 }), { added: 0 }, 'a replay adds nothing');
  assert.equal(store.reportedLookup().since, first, 'and does not move the start');
  assert.equal(store.reportedCount(), 2);
  clock += REPORTED_RETENTION_MS + 60000;
  store.markReported([{ key: 'bse:z', publishedAt: null }], '2026-09-26:morning', { windowFrom: clock });
  assert.ok(!store.reportedLookup().has('bse:a') && store.reportedLookup().has('bse:z'), 'ten-day-old items are pruned on the next write');
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
  assert.ok(store.reportedCount() >= delivery.summary.stories, 'every item the brief carried is in the ledger once it reached the desk');
  assert.equal(store.reportedLookup().since, istInstant('2026-09-16', '16:00'), 'the ledger begins at this brief\'s window');
  assert.equal((await schedule.status()).reported, store.reportedCount());
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
  assert.equal(store.reportedCount(), 0, 'a send nobody received marks nothing as reported');
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
  assert.equal(store.reportedCount(), 0, 'a test copy marks nothing as reported: the list did not see it');
});

await test('sending to everyone cools down for five minutes and a second press within it is refused', async () => {
  clock = istInstant('2026-09-17', '10:30');
  const { store, schedule, log } = makeSchedule();
  store.apply([{ op: 'subscribe', email: 'pratik@muns.io', by: 'Pratik' }, { op: 'subscribe', email: 'meera@muns.io', by: 'Pratik' }]);
  const out = await schedule.sendNow({ edition: 'evening', to: 'all' });
  assert.equal(out.sent, 2);
  assert.equal(log.filter((l) => l.kind === 'email').length, 2);
  assert.ok(store.reportedCount() > 0, 'a send to everyone is a send the desk saw, so it is recorded');
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

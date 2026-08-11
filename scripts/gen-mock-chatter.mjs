#!/usr/bin/env node
// gen-mock-chatter.mjs — generates the ILLUSTRATIVE public-chatter data set.
//
//   node scripts/gen-mock-chatter.mjs
//
// Writes:
//   public/data/mock/chatter-valuepickr.json   40 forum threads
//   public/data/mock/chatter-telegram.json     25 public groups
//
// WHAT IS REAL AND WHAT IS NOT
//   Real:      company names, tickers and sectors — from public/data/universe.json.
//   Synthetic: every thread, every post, every message, every count.
//   Fictional: EVERY HANDLE. Same rule as the con-call analysts — a forum handle belongs to a
//              real person, and attaching invented opinions to one misattributes speech. The
//              handles below are built from a word list that produces obviously-generic names.
//
// NOTHING DERIVED IS BAKED IN. Momentum, reach and pump risk are computed at runtime by
// js/data/chatter.js and js/chatter/pump-risk.js from the raw counts in these files, so the
// UI can show its working and a reader can disagree with the flag.
//
// Determinism: mulberry32 seeded from SEED, so reruns are byte-identical.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UNIVERSE_PATH = resolve(__dirname, '../public/data/universe.json');
const PORTFOLIO_PATH = resolve(__dirname, '../public/data/portfolio.json');
const VP_PATH = resolve(__dirname, '../public/data/mock/chatter-valuepickr.json');
const TG_PATH = resolve(__dirname, '../public/data/mock/chatter-telegram.json');

const SEED = 20260812;
const THREAD_COUNT = 40;
const GROUP_COUNT = 25;
const TODAY = '2026-08-11';
const NOW_ISO = '2026-08-11T09:30:00+05:30';

// ---------------------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const rand = (lo, hi) => lo + rng() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const chance = (p) => rng() < p;
const round = (n, d = 2) => {
  const m = 10 ** d;
  return Math.round(n * m) / m;
};
function sample(arr, n) {
  const pool = arr.slice();
  const out = [];
  while (out.length < n && pool.length) out.push(...pool.splice(Math.floor(rng() * pool.length), 1));
  return out;
}

const tickerFromUrl = (url) => String(url || '').match(/\/company\/([^/]+)/)?.[1]?.toUpperCase() || null;
const isoAt = (daysAgo, hour = null) => {
  const d = new Date(`${TODAY}T00:00:00+05:30`);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour ?? randInt(7, 23), randInt(0, 59), 0, 0);
  return `${d.toISOString().slice(0, 19)}+05:30`;
};

// ---------------------------------------------------------------------------------------
// Fictional handles. Deliberately generic-looking so no handle reads as a specific person.
// ---------------------------------------------------------------------------------------
const HANDLE_A = ['value', 'quality', 'compounder', 'moat', 'cyclical', 'contra', 'patient', 'margin',
  'smallcap', 'midcap', 'deep', 'growth', 'terminal', 'balance', 'cashflow', 'dividend', 'turnaround', 'basket'];
const HANDLE_B = ['investor', 'hunter', 'seeker', 'notes', 'diary', 'ledger', 'lens', 'watch', 'desk',
  'journal', 'tracker', 'files', 'log', 'reader', 'student', 'analyst_x', 'scribe'];
const handleFor = () => `${pick(HANDLE_A)}_${pick(HANDLE_B)}${chance(0.35) ? randInt(2, 99) : ''}`;

// ---------------------------------------------------------------------------------------
// Post / message text. Written to sound like retail forum commentary without being about any
// real person, and without making a checkable claim about a real company's actual numbers —
// every figure is left vague or is clearly a poster's own guess.
// ---------------------------------------------------------------------------------------
const VP_POSITIVE = [
  'Went through the annual report over the weekend. The working capital cycle has genuinely tightened, which is what I wanted to see before adding.',
  'Capacity coming on stream next year should show up in the topline from H2. Happy to hold through the gap.',
  'Management has been consistent on the margin band for four quarters now. That consistency is worth something.',
  'Distribution expansion is the underrated part of this story. Everyone is focused on the pricing.',
  'Promoter holding steady and no pledging. Basic hygiene, but worth noting given the sector.',
  'Added a tracking position. Not a full allocation until I see one more quarter of execution.',
];
const VP_NEGATIVE = [
  'Receivables have been creeping up for three quarters. I would want an explanation before sizing up.',
  'The other income line is doing a lot of work in that PAT number. Operating performance is flat at best.',
  'Competitive intensity in the entry segment looks like it is getting worse, not better.',
  'Trimmed. The re-rating has already happened and the earnings have not caught up yet.',
  'Not comfortable with the related-party transactions in the notes. Passing on this one.',
  'Capex funded by debt in a rising rate environment is a combination I have been burnt by before.',
];
const VP_NEUTRAL = [
  'Does anyone have the segment-wise breakup from the investor presentation? The annual report only gives consolidated.',
  'Tracking this one but have not taken a position. Waiting for the next quarter.',
  'Useful thread. Adding the con-call notes I took, for whoever finds them helpful.',
  'What is the current utilisation across the plants? I could not find it in the filings.',
  'Sharing a link to the exchange filing for anyone following along.',
  'Holding since the demerger. No change to my view either way this quarter.',
];
const CLAIM_FACT = [
  'Promoter holding unchanged at the last disclosure.',
  'Capacity expansion announced in the last exchange filing.',
  'The company has disclosed a new long-term supply agreement.',
  'Debt was reduced during the year per the annual report.',
  'A new plant received environmental clearance.',
];
const CLAIM_SPEC = [
  'Could double revenue over three years if the new capacity fills up.',
  'Might be a re-rating candidate if margins hold at this level.',
  'Possible entry into two new export markets next year.',
  'Rumoured to be evaluating a bolt-on acquisition.',
  'A demerger of the non-core business would unlock value.',
];
const CLAIM_Q = [
  'What is the replacement cost of the existing capacity?',
  'Has anyone modelled what happens if input costs revert?',
  'Is the export business margin-accretive or dilutive?',
  'How much of the order book is executable this year?',
  'Does anyone have the historical utilisation numbers?',
];

const TG_BULL = [
  'Volumes picking up here. Watch the delivery percentage.',
  'Breakout on the daily. Keeping it on the radar.',
  'Results next week. Positioning ahead of it.',
  'Strong sector tailwind, this is the cheapest name in the pack.',
  'Accumulating on dips. Nothing has changed in the story.',
];
const TG_NEUTRAL = [
  'Any views on this one? Been sideways for months.',
  'Sharing the exchange filing link for the group.',
  'Con-call is tomorrow, transcript should be out by Friday.',
  'Someone asked for the shareholding pattern — it is on the exchange site.',
];
const TG_BEAR = [
  'Book partial profits here. Risk-reward is not what it was.',
  'Exiting. Better setups elsewhere.',
  'The move looks stretched relative to the earnings.',
];

const CATEGORIES = ['Company analysis', 'Sector deep dive', 'Small cap', 'Turnaround', 'Portfolio review'];
const TG_PREFIX = ['Smallcap', 'Momentum', 'Value', 'Multibagger', 'Swing', 'Positional', 'Breakout', 'Alpha', 'Compounder', 'Microcap'];
const TG_SUFFIX = ['Traders', 'Investors', 'Research', 'Ideas', 'Club', 'Circle', 'Desk', 'Signals', 'Hub', 'Network'];

const sentimentText = (s) => (s > 0.15 ? pick(VP_POSITIVE) : s < -0.15 ? pick(VP_NEGATIVE) : pick(VP_NEUTRAL));
const tgText = (s) => (s > 0.15 ? pick(TG_BULL) : s < -0.15 ? pick(TG_BEAR) : pick(TG_NEUTRAL));

// ---------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------
const universe = JSON.parse(readFileSync(UNIVERSE_PATH, 'utf8'));
const eligible = universe.filter((e) => tickerFromUrl(e['Screener URL']) && e.Company);
const holdings = JSON.parse(readFileSync(PORTFOLIO_PATH, 'utf8'))?.holdings || [];
const heldTickers = new Set(holdings.map((h) => String(h.ticker).toUpperCase()));

// Portfolio holdings first, so the Portfolio scope is not an empty tab. Then a stride sample.
const chosen = eligible.filter((e) => heldTickers.has(tickerFromUrl(e['Screener URL'])));
const rest = eligible.filter((e) => !heldTickers.has(tickerFromUrl(e['Screener URL'])));
const stride = Math.max(1, Math.floor(rest.length / Math.max(1, THREAD_COUNT - chosen.length)));
for (let i = 0; chosen.length < THREAD_COUNT && i < rest.length; i += stride) chosen.push(rest[i]);

// ---- ValuePickr threads -----------------------------------------------------------------
const threads = chosen.map((entry, i) => {
  const ticker = tickerFromUrl(entry['Screener URL']);
  const name = entry.Company;
  const sector = entry.Sector || entry['Broad Sector'] || 'Services';

  // A thread's baseline "temperature", which drives volume and how peaked it is.
  const heat = rand(0, 1);
  const postsPrior7d = Math.max(1, Math.round(rand(2, 60) * (0.4 + heat)));
  // Momentum is left for the UI to derive; here we just make some threads genuinely accelerate.
  const swing = chance(0.35) ? rand(1.3, 3.4) : chance(0.3) ? rand(0.25, 0.75) : rand(0.8, 1.25);
  const posts7d = Math.max(0, Math.round(postsPrior7d * swing));

  const sentiment = round(Math.max(-1, Math.min(1, rand(-0.7, 0.8))), 2);
  const participantCount = Math.max(2, Math.round((posts7d + postsPrior7d) * rand(0.25, 0.6)));
  const postCount = postsPrior7d * randInt(4, 30) + posts7d;

  const contributors = sample([...new Set(Array.from({ length: 14 }, handleFor))], randInt(3, 5))
    .map((handle, idx) => ({ handle, posts: Math.max(1, Math.round((posts7d / (idx + 1.6)) * rand(0.5, 1.2))) }))
    .sort((a, b) => b.posts - a.posts);

  const recentPosts = Array.from({ length: randInt(4, 8) }, () => {
    const s = round(Math.max(-1, Math.min(1, sentiment + rand(-0.5, 0.5))), 2);
    return { handle: chance(0.6) ? pick(contributors).handle : handleFor(), at: isoAt(randInt(0, 6)), text: sentimentText(s), sentiment: s, likes: randInt(0, 34) };
  }).sort((a, b) => b.at.localeCompare(a.at));

  const claims = [
    ...Array.from({ length: randInt(1, 2) }, () => ({ text: pick(CLAIM_FACT), kind: 'fact', at: isoAt(randInt(0, 20)) })),
    ...Array.from({ length: randInt(1, 3) }, () => ({ text: pick(CLAIM_SPEC), kind: 'speculation', at: isoAt(randInt(0, 20)) })),
    ...Array.from({ length: randInt(1, 2) }, () => ({ text: pick(CLAIM_Q), kind: 'question', at: isoAt(randInt(0, 20)) })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  // 12 weeks of weekly post counts, ending on this week's number, for the drill sparkline.
  const weekly = [];
  let w = postsPrior7d;
  for (let k = 0; k < 11; k++) {
    w = Math.max(0, Math.round(w * rand(0.65, 1.45)));
    weekly.push(w);
  }
  weekly.push(posts7d);

  return {
    threadId: `vp-${String(i + 1).padStart(3, '0')}`,
    ticker,
    name,
    sector,
    title: `${name} — ${pick(['the runway from here', 'capacity, costs and the next two years', 'a slow compounder worth the wait', 'what the market is missing', 'business quality vs valuation', 'tracking the turnaround'])}`,
    url: `https://forum.valuepickr.com/t/${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}/${randInt(1000, 99999)}`,
    category: pick(CATEGORIES),
    createdAt: isoAt(randInt(120, 1400), 12),
    lastPostAt: recentPosts[0]?.at || isoAt(randInt(0, 6)),
    postCount,
    participantCount,
    posts7d,
    postsPrior7d,
    weeklyPosts12w: weekly,
    sentiment,
    topContributors: contributors,
    recentPosts,
    claims,
  };
});

// ---- Telegram groups ----------------------------------------------------------------------
// Some groups are deliberately built to trip the pump-risk heuristic: high volume, very few
// distinct senders, heavy forwarding and uniformly bullish. Others are built to look busy but
// healthy, so the flag has to discriminate rather than just rank by volume.
const tgTickers = sample(chosen, GROUP_COUNT);
const groups = tgTickers.map((entry, i) => {
  const ticker = tickerFromUrl(entry['Screener URL']);
  const name = entry.Company;
  const sector = entry.Sector || entry['Broad Sector'] || 'Services';

  // Four shapes. `borderline` matters as much as `pumpy`: a heuristic that only ever returns 0
  // or 3 is not discriminating, it is just recognising two hand-built clusters. Borderline
  // groups clear the volume gate but trip only one or two of the three signals, which is what
  // the amber "Elevated" state is for and what a real ambiguous case looks like.
  const roll = rng();
  const profile = roll < 0.18 ? 'pumpy' : roll < 0.44 ? 'borderline' : roll < 0.56 ? 'quiet' : 'normal';
  const memberCount = randInt(1200, 96000);

  let messages24h;
  let uniqueSenders24h;
  let forwardRatio;
  let sentiment;
  if (profile === 'pumpy') {
    messages24h = randInt(260, 900);
    uniqueSenders24h = randInt(4, 12); // a wall of messages from almost nobody
    forwardRatio = round(rand(0.55, 0.9), 2);
    sentiment = round(rand(0.62, 0.95), 2); // uniformly bullish
  } else if (profile === 'borderline') {
    // Busy and spiking, but only some of the signals present.
    messages24h = randInt(140, 420);
    const which = randInt(1, 2); // how many of the three signals to trip
    const order = sample(['concentration', 'forwards', 'uniform'], 3);
    const on = new Set(order.slice(0, which));
    uniqueSenders24h = on.has('concentration') ? randInt(6, 18) : randInt(40, 110);
    forwardRatio = round(on.has('forwards') ? rand(0.52, 0.72) : rand(0.1, 0.4), 2);
    sentiment = round(on.has('uniform') ? rand(0.58, 0.8) : rand(-0.3, 0.45), 2);
  } else if (profile === 'quiet') {
    messages24h = randInt(3, 40);
    uniqueSenders24h = randInt(2, 15);
    forwardRatio = round(rand(0.05, 0.3), 2);
    sentiment = round(rand(-0.4, 0.4), 2);
  } else {
    messages24h = randInt(40, 320);
    uniqueSenders24h = randInt(18, 120);
    forwardRatio = round(rand(0.08, 0.42), 2);
    sentiment = round(rand(-0.45, 0.6), 2);
  }
  uniqueSenders24h = Math.min(uniqueSenders24h, messages24h);
  const messagesPrior24h = Math.max(
    1,
    Math.round(messages24h * (profile === 'pumpy' || profile === 'borderline' ? rand(0.12, 0.5) : rand(0.7, 1.35)))
  );

  const recentMessages = Array.from({ length: randInt(4, 7) }, () => {
    const s = round(Math.max(-1, Math.min(1, sentiment + rand(-0.25, 0.25))), 2);
    return { handle: handleFor(), at: isoAt(0, randInt(8, 22)), text: tgText(s), sentiment: s };
  }).sort((a, b) => b.at.localeCompare(a.at));

  return {
    groupId: `tg-${String(i + 1).padStart(3, '0')}`,
    name: `${pick(TG_PREFIX)} ${pick(TG_SUFFIX)}`,
    memberCount,
    ticker,
    companyName: name,
    sector,
    messages24h,
    messagesPrior24h,
    uniqueSenders24h,
    sentiment,
    forwardRatio,
    profile, // generator artefact, kept so a reviewer can see why a group looks the way it does
    recentMessages,
  };
});

// ---- write -------------------------------------------------------------------------------
const stamp = {
  generated_at: new Date('2026-08-11T04:00:00Z').toISOString(),
  generator: 'scripts/gen-mock-chatter.mjs',
  seed: SEED,
  source: 'Mock data',
  as_of: TODAY,
  now: NOW_ISO,
};

writeFileSync(
  VP_PATH,
  `${JSON.stringify(
    {
      _provenance:
        'ILLUSTRATIVE DATA. Company names, tickers and sectors are real (from public/data/universe.json). ' +
        'Every thread, post, count and sentiment reading is synthetic, generated by scripts/gen-mock-chatter.mjs. ' +
        'ALL HANDLES ARE FICTIONAL — no real forum member wrote any of this. Thread URLs do not resolve.',
      ...stamp,
      thread_count: threads.length,
      threads,
    },
    null,
    1
  )}\n`
);

writeFileSync(
  TG_PATH,
  `${JSON.stringify(
    {
      _provenance:
        'ILLUSTRATIVE DATA. Company names, tickers and sectors are real. Every group, message, count and sentiment ' +
        'reading is synthetic, generated by scripts/gen-mock-chatter.mjs. ALL HANDLES AND GROUP NAMES ARE FICTIONAL — ' +
        'no real Telegram group or member is represented here.',
      ...stamp,
      group_count: groups.length,
      groups,
    },
    null,
    1
  )}\n`
);

// ---- report -------------------------------------------------------------------------------
const risers = threads.filter((t) => t.posts7d > t.postsPrior7d).length;
console.log(`valuepickr threads:   ${threads.length} (${risers} accelerating, ${threads.length - risers} cooling)`);
console.log(`  recent posts:       ${threads.reduce((s, t) => s + t.recentPosts.length, 0)}`);
console.log(`  claims:             ${threads.reduce((s, t) => s + t.claims.length, 0)}`);
console.log(`telegram groups:      ${groups.length}`);
for (const p of ['pumpy', 'borderline', 'normal', 'quiet']) {
  console.log(`  shaped ${p.padEnd(11)} ${groups.filter((g) => g.profile === p).length}`);
}
console.log('  (the risk flag itself is computed at runtime by js/chatter/pump-risk.js, never stored)');
console.log(`\nwrote ${VP_PATH}`);
console.log(`wrote ${TG_PATH}`);

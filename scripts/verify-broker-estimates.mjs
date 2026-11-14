#!/usr/bin/env node
// scripts/verify-broker-estimates.mjs — the "What brokers say" valuation anchor (#452), offline.
//
// The block reproduces NAMED brokers' own calls from the broker reports we capture. What is asserted,
// in the order it can go wrong:
//   1. a company no broker named gets no block (null), and the match is by EXACT ticker;
//   2. one row per broker — the broker's LATEST report in the window, their previous view set aside;
//   3. the target consensus is the brokers' OWN printed targets only (min / max / median), and an
//      upside-only post contributes NO target — nothing is derived;
//   4. the stance split counts rated brokers and names the unrated ones;
//   5. "vs the current price" is the median target against the live price, ours, and null without it;
//   6. a broker's own rating or target change is carried from the post's `previous`;
//   7. a report older than the window is dropped once a `now` is given.
// No server and no egress.

import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { brokerEstimates, median } = await import('../public/js/data/broker-estimates.js');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log(`ok   ${name}`); pass++; };

const NOW = Date.parse('2026-11-10T00:00:00Z');
const days = (n) => new Date(NOW - n * 864e5).toISOString();
const rep = (o) => ({ broker: 'X', ticker: 'ACME', rating: null, stance: null, target: null, upsidePct: null,
  kind: 'view', points: null, publishedAt: days(1), url: `https://t.me/c/${Math.random()}`, previous: null, ...o });

// A realistic set for ACME: three brokers, one of them posting twice.
const reports = [
  rep({ broker: 'Motilal Oswal', rating: 'BUY', stance: 'bullish', target: 100, publishedAt: days(20), url: 'u-mo-old' }),
  rep({ broker: 'Motilal Oswal', rating: 'ADD', stance: 'bullish', target: 120, publishedAt: days(3), url: 'u-mo-new',
        previous: { rating: 'BUY', target: 100, publishedAt: days(20), url: 'u-mo-old' } }),
  rep({ broker: 'Nuvama', rating: 'HOLD', stance: 'neutral', target: 140, publishedAt: days(5), url: 'u-nuv' }),
  rep({ broker: 'Antique', rating: null, stance: null, target: null, upsidePct: 18, publishedAt: days(8), url: 'u-ant' }),
  rep({ broker: 'Kotak', rating: 'SELL', stance: 'bearish', target: null, publishedAt: days(2), url: 'u-kot' }),
  // A different company, and a stale Motilal note — neither should touch ACME's current block.
  rep({ broker: 'ICICI', ticker: 'OTHER', rating: 'BUY', stance: 'bullish', target: 999, publishedAt: days(1) }),
  rep({ broker: 'Old Broker', rating: 'BUY', stance: 'bullish', target: 50, publishedAt: days(40), url: 'u-stale' }),
];

// 1 — absent / exact ticker
ok('a company no broker named gets no block', brokerEstimates(reports, 'ZZZZ', { now: NOW }) === null);
ok('a null/empty input is handled', brokerEstimates(null, 'ACME') === null && brokerEstimates([], 'ACME') === null);

const est = brokerEstimates(reports, 'ACME', { now: NOW, cmp: 100 });
ok('the block carries the ticker and a row set', est && est.ticker === 'ACME' && Array.isArray(est.rows));
ok('OTHER\'s report never leaks into ACME', !est.rows.some((r) => r.target === 999));

// 2 — one row per broker, latest wins
const mo = est.rows.find((r) => r.broker === 'Motilal Oswal');
ok('one row per broker — Motilal appears once', est.rows.filter((r) => r.broker === 'Motilal Oswal').length === 1);
ok('…and it is the LATEST report (ADD · 120), not the older BUY · 100', mo.rating === 'ADD' && mo.target === 120 && mo.url === 'u-mo-new');
ok('rows are newest first', est.rows[0].broker === 'Kotak');

// 3 — target consensus is the brokers' OWN printed targets; nothing derived
ok('the count is every broker with a current view', est.count === 4 && est.consensus.count === 4);
ok('the target range/median are the printed targets only (120, 140)', est.consensus.targets.n === 2
  && est.consensus.targets.min === 120 && est.consensus.targets.max === 140 && est.consensus.targets.median === 130);
ok('an upside-only post contributes NO target (Antique)', est.rows.find((r) => r.broker === 'Antique').target === null);
ok('…and its printed upside is kept as the broker\'s own', est.rows.find((r) => r.broker === 'Antique').upsidePct === 18);
ok('median() is the mean of the two middles for an even count', median([100, 140]) === 120 && median([100, 120, 140]) === 120);

// 4 — stance split names the rated and the unrated
const s = est.consensus.stances;
ok('the stance split counts rated brokers', s.bullish === 1 && s.neutral === 1 && s.bearish === 1);
ok('the unrated broker is counted apart', est.consensus.ratedCount === 3 && (est.count - est.consensus.ratedCount) === 1);
ok('the lean is mixed when buys and sells tie', est.consensus.lean === 'mixed');

// 5 — vs the current price is ours, labelled, and needs a price
ok('median target vs the live price is derived from the printed median', est.consensus.vsCmp
  && est.consensus.vsCmp.cmp === 100 && Math.abs(est.consensus.vsCmp.medianPct - 0.30) < 1e-9);
ok('without a live price there is no vs-price figure', brokerEstimates(reports, 'ACME', { now: NOW }).consensus.vsCmp === null);

// 6 — a broker's own change is carried from the post's `previous`
ok('Motilal\'s rating change is carried (BUY → ADD)', mo.changed && mo.changed.fromRating === 'BUY');
ok('…and its target change too (from 100)', mo.changed.fromTarget === 100);
ok('a broker with no previous has no change marker', est.rows.find((r) => r.broker === 'Nuvama').changed === null);

// 7 — the window floor drops an old report once a `now` is given
ok('a report older than the window is dropped with a now', !est.rows.some((r) => r.broker === 'Old Broker'));
ok('…and kept when no now is given (the file is already windowed)',
  brokerEstimates(reports, 'ACME').rows.some((r) => r.broker === 'Old Broker'));

// A target-less company: the block still forms, with no consensus target and no vs-price line.
const noTargets = brokerEstimates([
  rep({ broker: 'A', rating: 'BUY', stance: 'bullish' }),
  rep({ broker: 'B', rating: 'HOLD', stance: 'neutral' }),
], 'ACME', { now: NOW, cmp: 100 });
ok('a company whose brokers printed no target still forms a block', noTargets.count === 2 && noTargets.consensus.targets === null);
ok('…with no vs-price figure (nothing to measure)', noTargets.consensus.vsCmp === null);

console.log(`\nall broker-estimates checks passed (${pass})`);

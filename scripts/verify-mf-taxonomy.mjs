#!/usr/bin/env node
// The mutual-fund taxonomy's one rule that moves a scheme, and the active / passive cut above it.
// Offline, dependency-free: the module under test is pure, so this needs no server and no browser.
//
// What is asserted, and why each is load-bearing (CLAUDE.md, "Active / Passive is the first chip
// row"):
//   - a name-stated tracker the source files under an ACTIVE category is shown under Index & smart
//     beta or Exchange traded, in a category whose id cannot collide with the one it left;
//   - the source's own word wins where it gives one — a scheme filed as Index Funds is passive on
//     its say-so and is never re-filed, whatever its name says;
//   - an actively managed scheme in the same bucket stays exactly where the source put it;
//   - a factor word (Value) is not a passive signal, and neither is the option suffix;
//   - `management` is one definition, read off the group, for the live feed AND the workbook;
//   - the tree carries `refiled` on a moved category so the chip can say why it exists.

import assert from 'node:assert/strict';
import {
  classifyLive, buildTree, managementOf, PASSIVE_GROUPS, MANAGEMENT, managementLabel,
  passiveKindOf, isFundOfFunds, WORKBOOK_TAXONOMY, PASSIVE_NAME,
} from '../public/js/data/mf-taxonomy.js';
import {
  loadMfFilters, saveMfFilters, normaliseMfFilters, reconcileHierarchy, MF_FILTERS_KEY,
} from '../public/js/data/mf-filter-memory.js';

let checks = 0;
const ok = (label, fn) => { fn(); checks++; console.log(`  ok  ${label}`); };

// Real names and real classifications from the 16 September 2026 feed — the measurement the rule
// was written against, not invented cases.
const moved = (c, n) => classifyLive(c, n);

ok('a Nifty Midcap 150 index fund filed under Equity : Mid Cap is shown under Index & smart beta', () => {
  const t = moved('Equity : Mid Cap', 'Aditya Birla Sun Life Nifty Midcap 150 Index Fund');
  assert.equal(t.assetClass, 'Equity');
  assert.equal(t.group, 'Index & smart beta');
  assert.equal(t.label, 'Index · Mid Cap');
  assert.equal(t.categoryId, 'equity-mid-cap-index');
  assert.equal(t.management, 'passive');
  assert.equal(t.sourceLabel, 'Equity : Mid Cap', 'the source’s own string is kept beside the move');
  assert.deepEqual({ from: t.refiled.from, kind: t.refiled.kind }, { from: 'Equity : Mid Cap', kind: 'index' });
  assert.match(t.refiled.reason, /Filed by the source as Equity : Mid Cap/);
  assert.match(t.refiled.reason, /rank and category median remain the source’s own cohort/);
  assert.equal(t.shownLabel, 'Equity : Index · Mid Cap');
});

ok('a Midcap 150 ETF filed under Mid Cap is a listed unit and sits under Exchange traded, even spelt out', () => {
  for (const name of ['UTI Nifty Midcap 150 Exchange Traded Fund', 'ICICI Prudential BSE Midcap Select ETF']) {
    const t = moved('Equity : Mid Cap', name);
    assert.equal(t.group, 'Exchange traded', name);
    assert.equal(t.label, 'ETF · Mid Cap');
    assert.equal(t.categoryId, 'equity-mid-cap-etf');
    assert.equal(t.refiled.kind, 'etf');
  }
});

ok('the actively managed mid-cap fund beside them stays exactly where the source put it', () => {
  const t = moved('Equity : Mid Cap', 'HDFC Mid-Cap Opportunities Fund-Dir(G)');
  assert.equal(t.group, 'Market cap');
  assert.equal(t.label, 'Mid Cap');
  assert.equal(t.categoryId, 'equity-mid-cap');
  assert.equal(t.management, 'active');
  assert.equal(t.refiled, null);
  assert.equal(t.shownLabel, 'Equity : Mid Cap');
});

ok('a moved category’s id can never collide with the bucket it left', () => {
  const a = moved('Equity : Mid Cap', 'Kotak Nifty Midcap 150 Index Fund').categoryId;
  const b = moved('Equity : Mid Cap', 'Kotak Emerging Equity Fund').categoryId;
  const c = moved('Equity : Index', 'Kotak Nifty Midcap 150 Index Fund').categoryId;
  assert.notEqual(a, b);
  assert.notEqual(a, c, 'a tracker the source itself files under Index keeps the source’s own category');
});

ok('the source’s own word wins: a scheme filed as Index Funds is passive on its say-so and is never re-filed', () => {
  const t = moved('Equity : Index Funds', 'ICICI Pru PSU Equity Fund-Reg(G)');
  assert.equal(t.management, 'passive');
  assert.equal(t.refiled, null);
  assert.equal(t.group, 'Index & smart beta');
  assert.equal(t.categoryId, 'equity-index-funds');
  for (const [c, n] of [['Equity : Index', 'Lic Mf Nifty Next 50 Index Fund'], ['Equity : ETFs', 'Nippon India ETF Nifty Bank BeES'], ['Metal : ETFs', 'HDFC Gold ETF'], ['Debt : ETFs', 'SBI Nifty 10 yr Benchmark G-Sec ETF']]) {
    const u = moved(c, n);
    assert.equal(u.management, 'passive', c);
    assert.equal(u.refiled, null, `${c} is the source’s own passive bucket`);
    assert.equal(u.sourceLabel, c);
    assert.equal(u.shownLabel, c);
  }
});

ok('a factor word is not a passive signal, and neither is the option suffix', () => {
  assert.equal(moved('Equity : Value / Contra', 'HDFC Value Fund-Dir(G)').management, 'active');
  assert.equal(moved('Equity : Large Cap', 'Bravo Momentum Fund').management, 'active');
  assert.equal(moved('Equity : Flexi Cap', 'Zeta Equal Weight Fund').management, 'active');
  assert.equal(moved('Hybrid : Arbitrage', 'Kotak Equity Arbitrage Fund - Growth').management, 'active');
  assert.equal(passiveKindOf('Parag Parikh Flexi Cap Fund - Direct Plan - Growth'), null);
});

ok('target-maturity index funds and G-Sec ETFs under a bare Debt head are shown with the trackers, and the label says the source gave no sub-category', () => {
  const idx = moved('Debt', 'Bandhan CRISIL IBX 90:10 SDL Plus Gilt April 2032 Index Fund');
  assert.equal(idx.assetClass, 'Debt');
  assert.equal(idx.group, 'Index & smart beta');
  assert.equal(idx.label, 'Index · not sub-classified');
  assert.equal(idx.categoryId, 'debt-index');
  const etf = moved('Debt', 'Motilal Oswal Nifty 5 year Benchmark G-Sec ETF');
  assert.equal(etf.group, 'Exchange traded');
  assert.equal(etf.label, 'ETF · not sub-classified');
  const dur = moved('Debt : Medium to Long Duration', 'Edelweiss Nifty PSU Bond Plus SDL Apr 2027 50:50 Index Fund-Reg(G)');
  assert.equal(dur.group, 'Index & smart beta');
  assert.equal(dur.label, 'Index · Medium to Long Duration');
  assert.equal(moved('Debt : Medium to Long Duration', 'ICICI Pru Long Term Bond Fund').group, 'Duration');
  assert.equal(moved('Debt : Liquid', 'Kotak Nifty 1D Rate Liquid ETF').group, 'Exchange traded');
});

ok('a fund of funds feeding an ETF is not itself listed, so it sits with the index funds rather than the exchange-traded group', () => {
  assert.equal(isFundOfFunds('ICICI Pru Gold ETF FOF(G)'), true);
  assert.equal(isFundOfFunds('Invesco India Gold ETF Fund of Fund'), true);
  const t = moved('FoFs : Domestic', 'ICICI Pru Gold ETF FOF(G)');
  assert.equal(t.assetClass, 'Fund of Funds');
  assert.equal(t.group, 'Index & smart beta');
  assert.equal(t.label, 'ETF · Domestic');
  assert.equal(moved('FoFs : Overseas', 'Motilal Oswal Nasdaq 100 FOF-Reg(G)').group, 'Index & smart beta', 'an index family’s own name is a tracker’s name');
  assert.equal(moved('FoFs : Overseas', 'Some Global Opportunities FoF').group, 'Overseas');
});

ok('a scheme with no classification at all is still placed: passive where its name says so, Unclassified otherwise', () => {
  const t = moved(null, 'Sundaram Nifty 100 Equal Weight Fund');
  assert.equal(t.assetClass, 'Unclassified');
  assert.equal(t.group, 'Index & smart beta');
  assert.equal(t.management, 'passive');
  assert.equal(t.refiled.from, null);
  assert.equal(t.categoryId, 'unclassified-index');
  const u = moved('', 'Some Fund With No Classification');
  assert.equal(u.group, 'Other');
  assert.equal(u.management, 'active');
  assert.equal(u.refiled, null);
});

ok('management is one definition, read off the group, for both feeds', () => {
  assert.deepEqual([...PASSIVE_GROUPS], ['Index & smart beta', 'Exchange traded']);
  assert.equal(managementOf('Index & smart beta'), 'passive');
  assert.equal(managementOf('Exchange traded'), 'passive');
  for (const g of ['Market cap', 'Strategy', 'Sectoral & thematic', 'Duration', 'Hedged', 'Not sub-classified', 'Other']) assert.equal(managementOf(g), 'active', g);
  assert.equal(managementOf(WORKBOOK_TAXONOMY['Smart Beta Strategy Funds'].group), 'passive', 'the workbook’s Smart Beta sheet is passive without a second table');
  for (const sheet of ['Mid Cap', 'Small Cap', 'Flexi Cap', 'BAF', 'Arbitrage Funds', 'Healthcare']) assert.equal(managementOf(WORKBOOK_TAXONOMY[sheet].group), 'active', sheet);
  assert.deepEqual(MANAGEMENT.map((m) => m.id), ['active', 'passive']);
  assert.equal(managementLabel('passive'), 'Passive');
  assert(MANAGEMENT.every((m) => m.title.length > 40), 'every chip carries its rule');
  assert(PASSIVE_NAME.every((p) => p.note), 'every name pattern says why it is as narrow as it is');
});

ok('the tree carries refiled on a moved category, and keeps the source’s label beside it', () => {
  const rows = [
    { name: 'Alpha Mid Cap Fund', c: 'Equity : Mid Cap' },
    { name: 'Beta Nifty Midcap 150 Index Fund', c: 'Equity : Mid Cap' },
    { name: 'Gamma Nifty Midcap 150 ETF', c: 'Equity : Mid Cap' },
    { name: 'Delta Nifty 50 Index Fund', c: 'Equity : Index' },
  ].map((r) => ({ ...r, taxonomy: classifyLive(r.c, r.name) }));
  const tree = buildTree(rows, (r) => r.taxonomy);
  const equity = tree.find((n) => n.assetClass === 'Equity');
  assert.deepEqual(equity.groups.map((g) => [g.group, g.count]), [['Market cap', 1], ['Index & smart beta', 2], ['Exchange traded', 1]]);
  const smart = equity.groups.find((g) => g.group === 'Index & smart beta');
  const movedCat = smart.categories.find((c) => c.id === 'equity-mid-cap-index');
  assert.equal(movedCat.label, 'Index · Mid Cap');
  assert.equal(movedCat.sourceLabel, 'Equity : Mid Cap');
  assert.equal(movedCat.refiled.kind, 'index');
  assert.equal(movedCat.management, 'passive');
  const own = smart.categories.find((c) => c.id === 'equity-index');
  assert.equal(own.refiled, null);
  const active = equity.groups.find((g) => g.group === 'Market cap').categories[0];
  assert.equal(active.id, 'equity-mid-cap');
  assert.equal(active.items.length, 1, 'the source’s Mid Cap holds only the actively managed fund');
  assert.equal(active.management, 'active');
});

// ---------------------------------------------------------------------------------------------
// THE LAST STATE OF SELECTION IS RETAINED — js/data/mf-filter-memory.js. Device-local, validated
// field by field, and re-checked against the feed's own tree before it is applied.
// ---------------------------------------------------------------------------------------------

const memoryStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), raw: m };
};

ok('nothing saved reads as nothing chosen — every control All, the source’s own figure', () => {
  const s = loadMfFilters(memoryStore());
  assert.deepEqual(s, {
    management: null, assetClass: null, group: null, categoryId: null, strategy: null, measure: 'return',
    live: { q: '', sort: null, categories: [] }, weekly: { q: '', sort: null, categories: [] }, benchmarks: {},
  });
});

ok('a saved selection round-trips whole, under one versioned key', () => {
  const store = memoryStore();
  saveMfFilters({
    management: 'passive', assetClass: 'Equity', group: 'Index & smart beta', categoryId: 'equity-mid-cap-index',
    strategy: 'momentum', measure: 'vs-benchmark',
    live: { q: 'nifty', sort: { key: '1Y', dir: 'asc' }, categories: ['Equity : Index · Mid Cap'] },
    weekly: { q: '', sort: { key: 'name', dir: 'desc' }, categories: [] },
    benchmarks: { 'smart-beta': 'nifty-500-tri' },
  }, store);
  assert.equal(JSON.parse(store.raw.get(MF_FILTERS_KEY)).v, 1);
  const s = loadMfFilters(store);
  assert.equal(s.management, 'passive');
  assert.equal(s.categoryId, 'equity-mid-cap-index');
  assert.equal(s.strategy, 'momentum');
  assert.equal(s.measure, 'vs-benchmark');
  assert.deepEqual(s.live, { q: 'nifty', sort: { key: '1Y', dir: 'asc' }, categories: ['Equity : Index · Mid Cap'] });
  assert.deepEqual(s.weekly.sort, { key: 'name', dir: 'desc' });
  assert.deepEqual(s.benchmarks, { 'smart-beta': 'nifty-500-tri' });
});

ok('a value the vocabulary does not hold resolves to its default, field by field, never by throwing', () => {
  const s = normaliseMfFilters({
    management: 'hybrid', strategy: 'growth', measure: 'vs-nothing', assetClass: 7, group: '   ',
    live: { q: 42, sort: { dir: 'asc' }, categories: ['ok', 3, ''] }, benchmarks: ['x'],
  });
  assert.equal(s.management, null, 'an unknown management word is dropped');
  assert.equal(s.strategy, null, '"growth" is deliberately not a factor');
  assert.equal(s.measure, 'return');
  assert.equal(s.assetClass, null);
  assert.equal(s.group, null);
  assert.deepEqual(s.live, { q: '', sort: null, categories: ['ok'] });
  assert.deepEqual(s.benchmarks, {});
});

ok('malformed JSON, a wrong version and a throwing store all read as nothing chosen', () => {
  const bad = memoryStore(); bad.raw.set(MF_FILTERS_KEY, '{not json');
  assert.equal(loadMfFilters(bad).assetClass, null);
  const old = memoryStore(); old.raw.set(MF_FILTERS_KEY, JSON.stringify({ v: 0, assetClass: 'Equity' }));
  assert.equal(loadMfFilters(old).assetClass, null);
  assert.equal(loadMfFilters({ getItem: () => { throw new Error('quota'); } }).assetClass, null);
  assert.doesNotThrow(() => saveMfFilters({ assetClass: 'Equity' }, { setItem: () => { throw new Error('quota'); } }));
  assert.equal(loadMfFilters(null).assetClass, null, 'no storage at all is a plain default');
});

const memTree = buildTree([
  { classification: 'Equity : Mid Cap', fundName: 'Hotel Mid Cap Opportunities Fund' },
  { classification: 'Equity : Mid Cap', fundName: 'Foxtrot Nifty Midcap 150 Index Fund' },
  { classification: 'Debt : Short Duration', fundName: 'Delta Debt Fund' },
].map((f) => ({ ...f, taxonomy: classifyLive(f.classification, f.fundName) })), (f) => f.taxonomy);

ok('a saved class, group and category the tree still offers are kept whole', () => {
  assert.deepEqual(reconcileHierarchy({ assetClass: 'Equity', group: 'Market cap', categoryId: 'equity-mid-cap' }, memTree),
    { assetClass: 'Equity', group: 'Market cap', categoryId: 'equity-mid-cap' });
});

ok('a saved group the tree no longer holds is dropped with the category beneath it, and the class stays', () => {
  assert.deepEqual(reconcileHierarchy({ assetClass: 'Equity', group: 'Gone', categoryId: 'equity-mid-cap' }, memTree),
    { assetClass: 'Equity', group: null, categoryId: null });
  assert.deepEqual(reconcileHierarchy({ assetClass: 'Equity', group: 'Market cap', categoryId: 'equity-gone' }, memTree),
    { assetClass: 'Equity', group: 'Market cap', categoryId: null });
  assert.deepEqual(reconcileHierarchy({ assetClass: 'Commodities', group: 'Market cap', categoryId: 'equity-mid-cap' }, memTree),
    { assetClass: null, group: null, categoryId: null });
});

ok('a saved group or category without its class fills the class in from the tree rather than being dropped', () => {
  assert.deepEqual(reconcileHierarchy({ assetClass: null, group: 'Duration', categoryId: null }, memTree),
    { assetClass: 'Debt', group: 'Duration', categoryId: null });
  assert.deepEqual(reconcileHierarchy({ assetClass: null, group: null, categoryId: 'equity-mid-cap-index' }, memTree),
    { assetClass: 'Equity', group: 'Index & smart beta', categoryId: 'equity-mid-cap-index' });
});

ok('a category saved under the group it left is not offered there — it is under Index & smart beta now', () => {
  assert.deepEqual(reconcileHierarchy({ assetClass: 'Equity', group: 'Market cap', categoryId: 'equity-mid-cap-index' }, memTree),
    { assetClass: 'Equity', group: 'Market cap', categoryId: null });
});

console.log(`PASS mf taxonomy: ${checks} checks — the active / passive cut, the one rule that moves a tracker out of an active bucket, and the remembered selection.`);

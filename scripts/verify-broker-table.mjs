// verify-broker-table.mjs — the broker valuation table's honest extraction (A5.2).
// The client asked for a broker table with Revenue-growth and EPS columns. Those figures live in the
// broker's PDF, which the capture does not hold — so we read them ONLY from the post's own words,
// verbatim, and leave the field null otherwise. This asserts: figures are extracted where stated,
// never fabricated where absent, carried through the (broker, company, day) merge, and never derived
// from an upside. Pure, offline — no server.
import assert from 'node:assert/strict';
import { parseBrokerPost, mergeReports } from '../public/js/data/broker-reports-shared.js';

let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; console.log('  PASS', n); } catch (e) { fail++; console.error('  FAIL', n, '\n   ', e.message); } };
const post = (text, id = 1) => ({ id, url: `https://t.me/researchreportss/${id}`, publishedAt: '2026-11-20T10:00:00.000Z', text });
const one = (text) => { const r = parseBrokerPost(post(text)); assert.equal(r.length, 1, `expected one report from: ${text}`); return r[0]; };

// 1) A stated revenue-growth figure is read verbatim.
ok('revGrowth: "50% revenue growth" read verbatim', () => {
  const r = one('PL Capital sees 20% UPSIDE in Dilip Buildcon- H2FY27 guidance at 50% revenue growth');
  assert.equal(r.revGrowth, '50% revenue growth');
  assert.equal(r.eps, null);
});

// 2) A qualitative growth phrase ("revenue growth accelerates") is read verbatim.
ok('revGrowth: "Revenue growth accelerates" read verbatim', () => {
  const r = one('ICICI Securities sees 16% UPSIDE in Just Dial- Revenue growth accelerates; margins weigh');
  assert.match(r.revGrowth || '', /^Revenue growth accelerat/i);
});

// 3) An EPS statement is read verbatim, from a digest line.
ok('eps: "Cut EPS estimates" read verbatim (digest row)', () => {
  const r = one('Antique on\nAshok Leyland: HOLD | TP 175 | Commodity inflation caps margin; Cut EPS estimates');
  assert.equal(r.rating, 'HOLD');
  assert.equal(r.target, 175);
  assert.match(r.eps || '', /Cut EPS estimates/i);
  assert.equal(r.revGrowth, null);
});

// 4) An EPS figure with a currency is read.
ok('eps: "EPS of Rs 45" read verbatim', () => {
  const r = one('Nuvama sees 12% UPSIDE in Acme Co- Margins expand; EPS of Rs 45 in FY27');
  assert.match(r.eps || '', /EPS of Rs 45/i);
});

// 5) NO FABRICATION: a post with only an upside and a generic thesis states neither — both null.
ok('no fabrication: upside-only post → revGrowth & eps null', () => {
  const r = one('Motilal Oswal sees 33% UPSIDE in Jindal Stainless- Strong NSR and volume recovery drive earnings');
  assert.equal(r.upsidePct, 33);
  assert.equal(r.revGrowth, null);
  assert.equal(r.eps, null);
});

// 6) "earnings"/"growth" alone is not an EPS or a revenue-growth figure (no false positive).
ok('no false positive: "drive earnings" / "growth trajectory" → null', () => {
  const r = one('Antique sees 20% UPSIDE in Some Co- Acquisition-led expansion strengthens growth trajectory');
  assert.equal(r.revGrowth, null);
  assert.equal(r.eps, null);
});

// 7) The merge keeps a figure stated in one post of the (broker, company, day) group.
ok('mergeReports carries revGrowth/eps across the day group', () => {
  const a = parseBrokerPost(post('Axis Securities sees 18% UPSIDE in Foo Ltd- Order book strong', 10))[0];
  const b = parseBrokerPost(post('Axis Securities sees 18% UPSIDE in Foo Ltd- 22% revenue growth; EPS CAGR of 19%', 11))[0];
  const merged = mergeReports([a, b], (r) => `name:${(r.named || '').toLowerCase()}`);
  assert.equal(merged.length, 1, 'one merged report');
  assert.equal(merged[0].revGrowth, '22% revenue growth');
  assert.match(merged[0].eps || '', /EPS CAGR of 19%/i);
});

// 8) The extracted value is always a substring of the post (verbatim, never reworded).
ok('extracted figures are verbatim substrings of the post text', () => {
  const text = 'HDFC Securities sees 9% UPSIDE in Bar Ltd- Topline growth healthy; cut FY27 EPS estimates';
  const r = one(text);
  if (r.revGrowth) assert.ok(text.includes(r.revGrowth), `revGrowth not a substring: ${r.revGrowth}`);
  if (r.eps) assert.ok(text.toLowerCase().includes(r.eps.toLowerCase()), `eps not a substring: ${r.eps}`);
  assert.match(r.eps || '', /EPS estimates/i);
});

console.log(`\nverify-broker-table: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

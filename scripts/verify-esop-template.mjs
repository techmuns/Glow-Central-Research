// verify-esop-template.mjs — #364. The canonical ESOP template is deterministic and honest:
// it reshapes the AI Read's own quote-backed details into one fixed shape, names what the filing
// does not state rather than guessing it, keeps every detail it does not consume, and never reads an
// employee grant as a raise or a sale. No live model and no network — the shaping is pure.
import assert from 'node:assert/strict';
import { isEsopFiling, esopTemplate } from '../public/js/data/esop-template.js';

const fieldOf = (tpl, key) => tpl.fields.find((f) => f.key === key);

// ── Detection ──────────────────────────────────────────────────────────────────────────────────
assert.equal(isEsopFiling({ categories: ['esop', 'capital'], title: 'Allotment under ESOP' }), true, 'the shared esop category is the authoritative signal');
assert.equal(isEsopFiling({ title: 'Grant of options under the Employee Stock Option Scheme 2020' }), true, 'ESOP words identify a row that arrived without categories');
assert.equal(isEsopFiling({ categories: ['results'], title: 'Audited financial results for the quarter ended 30 September 2026' }), false, 'a results filing is not an ESOP filing');
assert.equal(isEsopFiling({ categories: ['capital'], title: 'Allotment of equity shares on a preferential basis (QIP)' }), false, 'the broad capital category alone must not pull in a QIP/preferential issue');
assert.equal(isEsopFiling({ categories: ['capital'], title: 'Issue of non-convertible debentures' }), false, 'a debenture issue is capital, not an employee grant');

// ── A full grant, read in full ───────────────────────────────────────────────────────────────────
const grantRow = { categories: ['esop', 'capital'], title: 'Grant of 5,00,000 stock options under ESOP 2021 to eligible employees', subCategory: 'ESOP/ESOS' };
const grantRead = { documentType: 'ESOP grant intimation', keyDetails: [
  { label: 'Options granted', value: '5,00,000 options', quote: 'the Nomination and Remuneration Committee granted 5,00,000 options', location: 'p.1' },
  { label: 'Exercise price', value: '₹10 per option', quote: 'at an exercise price of ₹10 per option', location: 'p.1' },
  { label: 'Vesting', value: 'over 4 years, 25% each year', quote: 'vesting over four years in equal annual tranches', location: 'p.2' },
  { label: 'Dilution', value: '0.80% of the expanded share capital', quote: 'representing 0.80% of the expanded share capital', location: 'p.2' },
  { label: 'Record date', value: '12 October 2026', quote: 'the record date is 12 October 2026', location: 'p.3' },
] };
const grant = esopTemplate(grantRead, grantRow);
assert.equal(grant.fields.map((f) => f.key).join(','), 'instrument,scheme,stage,count,exercisePrice,vesting,dilution', 'the seven canonical fields in fixed order');
assert.equal(fieldOf(grant, 'instrument').value, 'Stock options');
assert.equal(fieldOf(grant, 'scheme').value, 'ESOP 2021');
assert.equal(fieldOf(grant, 'stage').value, 'Options granted to employees');
assert.equal(fieldOf(grant, 'count').value, '5,00,000 options');
assert.equal(fieldOf(grant, 'count').source, 'document', 'the number came from the read, not the subject');
assert.equal(fieldOf(grant, 'count').quote, 'the Nomination and Remuneration Committee granted 5,00,000 options', 'quantitative fields keep their literal quote');
assert.equal(fieldOf(grant, 'exercisePrice').value, '₹10 per option');
assert.match(fieldOf(grant, 'vesting').value, /4 years/);
assert.match(fieldOf(grant, 'dilution').value, /0\.80% of the expanded share capital/);
assert.equal(grant.extra.length, 1, 'nothing is dropped — the unrelated detail is preserved');
assert.equal(grant.extra[0].label, 'Record date');
assert.match(grant.caption, /not a capital raise/, 'the caption refuses the raise reading');
assert.match(grant.caption, /not a promoter or insider sale/, 'the caption refuses the sale reading');

// ── A thin allotment, no document read ─────────────────────────────────────────────────────────
const allotRow = { categories: ['esop'], title: 'Allotment of 1,200 equity shares under ESOP 2015 on exercise of options' };
const allot = esopTemplate(null, allotRow);
assert.equal(fieldOf(allot, 'instrument').value, 'Stock options', 'instrument defaults to stock options for an esop-classified filing');
assert.equal(fieldOf(allot, 'scheme').value, 'ESOP 2015');
assert.equal(fieldOf(allot, 'stage').value, 'Shares allotted on exercise of options');
assert.equal(fieldOf(allot, 'count').value, '1,200 equity shares', 'the number the exchange printed in its own subject is offered');
assert.equal(fieldOf(allot, 'count').source, 'subject', 'and it is labelled as the subject, not a document fact');
for (const key of ['exercisePrice', 'vesting', 'dilution']) {
  assert.equal(fieldOf(allot, key).value, null, `${key} is absent, never guessed, when the document was not read`);
  assert.equal(fieldOf(allot, key).quote, null);
}

// ── Mis-slotting guard: a detail must not be pulled into a slot by a word in its VALUE ──────────────
const tricky = esopTemplate({ keyDetails: [
  { label: 'Exercise period', value: '5 years from the date of vesting', quote: 'exercisable within 5 years from vesting', location: 'p.2' },
  { label: 'Market price on grant date', value: '₹412', quote: 'the closing market price on the grant date was ₹412', location: 'p.1' },
] }, grantRow);
assert.equal(fieldOf(tricky, 'vesting').value, null, '"Exercise period" is not the vesting schedule, though its value mentions vesting');
assert.equal(fieldOf(tricky, 'exercisePrice').value, null, '"Market price on grant date" is not the exercise price');
assert.equal(tricky.extra.length, 2, 'both unslotted details are preserved under other details');

// ── RSUs and a shareholder approval, read in full ──────────────────────────────────────────────────
const rsu = esopTemplate(
  { keyDetails: [{ label: 'Number of RSUs', value: '2,00,000 units', quote: 'grant of 2,00,000 restricted stock units', location: 'p.1' }] },
  { categories: ['esop'], title: 'Outcome: shareholders approved the Restricted Stock Unit Plan 2026 by postal ballot' });
assert.equal(fieldOf(rsu, 'instrument').value, 'Restricted stock units (RSUs)');
assert.equal(fieldOf(rsu, 'stage').value, 'Approved by shareholders');
assert.equal(fieldOf(rsu, 'count').value, '2,00,000 units');

// ── A non-ESOP filing still returns a template object but the UI gates on isEsopFiling ─────────────
assert.equal(isEsopFiling({ categories: ['results'], title: 'Q2 results' }, { documentType: 'Financial results' }), false);

console.log('PASS esop template: detection (category + text, QIP/debenture excluded), seven fixed fields, quote-backed values, honest absents vs not-read, subject-number fallback, nothing dropped, no mis-slotting, and the caption refuses the raise/sale readings');

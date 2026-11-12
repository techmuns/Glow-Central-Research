// data/esop-template.js — ONE FIXED SHAPE FOR AN EMPLOYEE STOCK-OPTION FILING.
//
// Client request #364. ESOP / employee-grant announcements come in many wordings — a scheme
// approval, a fresh grant, an allotment of shares on exercise, an amendment — and the one thing
// the desk must never do is read them as a capital RAISE (a QIP, a preferential issue) or as a
// promoter/insider SALE. An employee grant is neither: it is a plan to pay employees in equity,
// dilutive only as options vest and are exercised.
//
// So when the AI Read popup (ui/announcement-read.js) reads an ESOP filing, its "Key details"
// section is rendered to ONE canonical template instead of a free list, so a reader always sees the
// same ESOP fields in the same order:
//
//   Instrument · Scheme · Stage · Number granted / allotted · Exercise price · Vesting · Resulting dilution
//
// This module is PURE and adds no judgement and no new fact:
//
//  1. THE VALUES ARE THE READ's OWN. The quantitative fields (number, exercise price, vesting,
//     dilution) are mapped from the AI Read's quote-backed keyDetails — every one already carries a
//     literal quote from the document (announcement-read-shared.js). Nothing is re-extracted from the
//     document here; the template only chooses which canonical slot a detail belongs in.
//  2. AN ABSENT FIELD SAYS SO. A canonical field with no matching detail is `null`, rendered
//     "Not stated in this filing" — never a zero, a guess or a default. (A number also present in the
//     exchange's own subject line is offered as a clearly-labelled fallback, not as a document fact.)
//  3. INSTRUMENT, SCHEME and STAGE are read from the filing's OWN subject/description text with fixed
//     rules (the same discipline as announcement-types.js) — these are what the filing is, not a
//     reading of it. Instrument defaults to "Stock options" for an esop-classified filing, which the
//     classification already establishes.
//  4. NOTHING IS DROPPED. A keyDetail the template does not consume is returned under `extra`, so the
//     popup still shows every fact the read found.
//  5. THE CAPTION IS FIXED AND NEVER WRONG. It states the one thing #364 is about — an employee grant
//     is not a raise and not a sale — and makes no size or direction claim.
//
// The investment-judgement fields the desk also asked about (is it performance-linked, does it move
// the needle) are deliberately NOT here: those stay with the read's own "Why it matters / Investment
// impact" section, which is where a reading, as opposed to a fact, belongs.

const lc = (s) => String(s ?? '').toLowerCase();
const text = (row = {}, reading = {}) =>
  lc([row.title, row.headline, row.subject, row.subCategory, row.summary, row.description, reading?.documentType].filter(Boolean).join(' · '));

// Does this filing belong to the employee-grant family? The authoritative signal is the shared
// `esop` category (announcement-categories.js), already classified and tested; a text match is the
// fallback for a row that reached the popup without categories, and for the read's own documentType.
const ESOP_WORDS = /\besops?\b|\besos\b|\besps\b|employee stock (?:option|purchase|appreciation)|\bstock options?\b|grant of (?:stock )?options?|restricted stock units?|\brsus?\b|stock appreciation rights?|\bsars?\b|sweat equity/;
export function isEsopFiling(row = {}, reading = null) {
  const cats = Array.isArray(row.categories) ? row.categories : [];
  if (cats.includes('esop')) return true;
  // Do not let the broad `capital` category alone pull in a QIP or a debenture issue: require the
  // ESOP words themselves when the category did not say `esop`.
  return ESOP_WORDS.test(text(row, reading || {}));
}

// Indian-formatted share/option counts: "5,00,000 equity shares", "12,000 options", "1,200 RSUs".
const COUNT_IN_TEXT = /\b(\d{1,3}(?:,\d{2,3})+|\d{3,})\s*(equity shares|shares|stock options?|options?|units?|rsus?)\b/i;

// The instrument the plan pays in — read from the filing's own words.
function instrumentOf(t) {
  if (/restricted stock units?|\brsus?\b/.test(t)) return 'Restricted stock units (RSUs)';
  if (/stock appreciation rights?|\bsars?\b/.test(t)) return 'Stock appreciation rights (SARs)';
  if (/sweat equity/.test(t)) return 'Sweat equity shares';
  if (/\boptions?\b|\besops?\b|\besos\b|\besps\b|employee stock (?:option|purchase)/.test(t)) return 'Stock options';
  if (/equity shares?/.test(t)) return 'Equity shares';
  return null;
}

// Which step in the plan's life this filing reports — allotment first, because an allotment filing
// usually also names the scheme's earlier approval, and the current action is what the reader wants.
function stageOf(t) {
  if (/\ballot\w+/.test(t) && /exercise/.test(t)) return 'Shares allotted on exercise of options';
  if (/\ballot\w+/.test(t)) return 'Shares allotted under the scheme';
  if (/\bgrant\w*\b/.test(t) && /options?|rsus?|units?|sars?/.test(t)) return 'Options granted to employees';
  if (/amend\w+|modif\w+|revis\w+/.test(t)) return 'Scheme amended';
  if (/approv\w+/.test(t) && /shareholders?|members?|postal ballot|general meeting|\bagm\b|\begm\b/.test(t)) return 'Approved by shareholders';
  if (/approv\w+/.test(t) && /board|nomination|remuneration|\bnrc\b|committee/.test(t)) return 'Approved by the board / committee';
  if (/approv\w+|adopt\w+/.test(t)) return 'Scheme approved';
  if (/grant\w*/.test(t)) return 'Options granted to employees';
  return null;
}

// Which canonical slot a keyDetail belongs in. The tests are anchored on the detail's own LABEL (the
// value is read only for the count's own number and for a dilution stated as a percentage), so a
// detail whose value merely mentions a word — "Exercise period: 5 years from vesting" — is not pulled
// into the vesting slot. Application order is price → vesting → dilution → count, and a detail is
// consumed by at most one slot, so the number-hungry count test can never steal a priced detail.
const SLOT_TESTS = {
  exercisePrice: (label) => /(?:exercise|grant|option|strike)\s*price|price per (?:option|share|unit)|^price$/.test(label),
  vesting: (label) => /\bvest(?:s|ed|ing|able)?\b/.test(label),
  dilution: (label, value) => /\bdilut/.test(label) || /% of (?:the )?(?:expanded|enhanced|post-?issue|paid-?up|existing)[^.]*\b(?:equity|share capital|capital)/.test(value),
  count: (label, value) => /\b(?:number|no\.?|nos\.?|quantity|aggregate)\b[^.]*\b(?:option|share|unit|rsu)/.test(label)
    || /\b(?:options?|shares?|units?|rsus?)\s+(?:granted|allotted|issued|vested)\b/.test(label) || COUNT_IN_TEXT.test(value),
};
const SLOT_ORDER = ['exercisePrice', 'vesting', 'dilution', 'count'];

function mapDetails(keyDetails) {
  const details = (Array.isArray(keyDetails) ? keyDetails : []).map((d) => ({
    label: String(d?.label ?? ''), value: String(d?.value ?? ''), quote: d?.quote ? String(d.quote) : null, location: d?.location ? String(d.location) : null,
  })).filter((d) => d.label && d.value);
  const slots = { exercisePrice: null, vesting: null, dilution: null, count: null };
  const consumed = new Set();
  for (const slot of SLOT_ORDER) {
    const idx = details.findIndex((d, i) => !consumed.has(i) && SLOT_TESTS[slot](lc(d.label), lc(d.value)));
    if (idx >= 0) { slots[slot] = details[idx]; consumed.add(idx); }
  }
  const extra = details.filter((_, i) => !consumed.has(i));
  return { slots, extra };
}

const field = (key, label, detail) => detail
  ? { key, label, value: detail.value, quote: detail.quote, location: detail.location, source: 'document' }
  : { key, label, value: null, quote: null, location: null, source: null };

/**
 * The canonical ESOP template for one filing and its (optional) AI reading.
 *
 * @param {object|null} reading  the accepted AI Read (`read.reading`), or null when the document was
 *   not read — the deterministic instrument/scheme/stage fields and the caption still render.
 * @param {object} row  the filing row (its exchange subject, sub-category and summary).
 * @returns {{ caption: string, fields: Array, extra: Array }}
 *   `fields` is the ordered canonical list; each is `{ key, label, value|null, quote|null, location,
 *   source }` where `source` is 'document' (quote-backed), 'subject' (the exchange's own subject line)
 *   or 'filing' (instrument/scheme/stage read from the subject) — and `value: null` means not stated.
 */
export function esopTemplate(reading = null, row = {}) {
  const t = text(row, reading || {});
  const subject = String(row.title || row.headline || row.subject || '');
  const { slots, extra } = mapDetails(reading?.keyDetails);

  const instrument = instrumentOf(t) || (isEsopFiling(row, reading) ? 'Stock options' : null);
  const schemeMatch = subject.match(/\b((?:ESOP|ESOS|ESPS)[ -]?\d{2,4}[A-Za-z]?|(?:Employee Stock Option|Employee Stock Purchase|Stock Option|Share[- ]based)[\w ]{0,28}?(?:Scheme|Plan)(?:[ -]?\d{2,4})?)\b/i);
  const stage = stageOf(t);

  // The number: prefer the read's quote-backed detail; otherwise offer the count the exchange printed
  // in its OWN subject line, labelled as such so it is never mistaken for a document fact.
  let count = field('count', 'Number granted / allotted', slots.count);
  if (!count.value) {
    const m = subject.match(COUNT_IN_TEXT);
    if (m) count = { key: 'count', label: 'Number granted / allotted', value: `${m[1]} ${m[2].toLowerCase()}`, quote: null, location: null, source: 'subject' };
  }

  const fields = [
    { key: 'instrument', label: 'Instrument', value: instrument, quote: null, location: null, source: instrument ? 'filing' : null },
    { key: 'scheme', label: 'Scheme', value: schemeMatch ? schemeMatch[1].replace(/\s+/g, ' ').trim() : null, quote: null, location: null, source: schemeMatch ? 'filing' : null },
    { key: 'stage', label: 'Stage', value: stage, quote: null, location: null, source: stage ? 'filing' : null },
    count,
    field('exercisePrice', 'Exercise price', slots.exercisePrice),
    field('vesting', 'Vesting', slots.vesting),
    field('dilution', 'Resulting dilution', slots.dilution),
  ];

  return {
    caption: 'Employee stock grant — options or shares awarded to employees. Dilutive only as options vest and are exercised; this is not a capital raise and not a promoter or insider sale.',
    fields,
    extra,
  };
}

// Event-level anchors read only from the supplied source text. These are matching aids, never
// generated claims. Unknown facts remain unknown; a category alone cannot establish an event.
const TYPES = [
  ['regulatory', /\b(?:court|tribunal|tax|gst|penalty|penalties|litigation)\b/i],
  ['order', /\b(?:orders?|contracts?|letter of (?:award|acceptance)|letters of (?:award|acceptance)|loa)\b/i],
  ['acquisition', /\b(?:acquir\w*|acquisition|takeover|buys?\s+(?:a\s+)?stake)\b/i],
  ['merger', /\b(?:merg\w*|amalgamat\w*)\b/i],
  ['results', /\b(?:results?|earnings|net profit|revenue)\b/i],
  ['launch', /\b(?:launch\w*|unveil\w*)\b/i],
];
const STAGES = [
  ['denial', /\b(?:denies?|denied|not received|no orders?)\b/i],
  ['cancelled', /\b(?:cancels?|cancell?ed|terminat\w*|revok\w*|withdraw\w*|scrapped)\b/i],
  ['correction', /\b(?:corrigend\w*|correct\w*|revis\w*|amend\w*|clarif\w*)\b/i],
  ['proposed', /\b(?:talks|propos\w*|plans? to|considering|explor\w*|mulls?|likely to|to acquire|to buy|bids? for|bidding)\b/i],
  ['completed', /\b(?:completes?|completed|commission\w*)\b/i],
  ['awarded', /\b(?:signs?|signed|wins?|won|awarded|approves?|approved|secures?|secured|acquires?|acquired|bags?|bagged|receives?|received|letter of (?:award|acceptance))\b/i],
];
const normal = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const names = value => new Set(normal(value).split(/\s+/).filter(w => w.length > 2 &&
  !/^(?:the|and|for|limited|ltd|private|pvt|company|corporation|project|projects|west|east|north|south)$/.test(w)));
const overlaps = (a, b) => [...a].some(x => b.has(x));
const conflict = (a, b) => a.size > 0 && b.size > 0 && !overlaps(a, b);
const subset = (a, b) => [...a].every(word => b.has(word));
const nameConflict = (a, b) => a.size > 0 && b.size > 0 && !subset(a, b) && !subset(b, a);

// Only explicit named phrases qualify. Lower-case generic phrases ("in its business") do not.
// A missing or differently abbreviated name cannot prove a match; it can only leave rows apart.
const namedPattern = prefix => new RegExp(`\\b(?:${prefix.replace(/[a-z]/g, letter => `[${letter}${letter.toUpperCase()}]`)})\\s+((?:[A-Z][A-Za-z0-9&'-]*(?:\\s+|(?=[.,;:]|$))){1,6})`, 'g');
const NAMED = {
  projects: namedPattern('project(?:s)?(?: named| called)?'),
  customers: namedPattern('from|awarded by|contract with'),
  places: namedPattern('in|at'),
};
function namedAfter(text, pattern) {
  const out = new Set();
  for (const match of text.matchAll(pattern)) for (const word of names(match[1])) out.add(word);
  return out;
}

export function eventFacts(text) {
  const value = String(text || '');
  const periods = new Set([...value.matchAll(/\b(?:q([1-4])|([1-4])q)\s*(?:fy\s*)?((?:20)?\d{2})?\b/gi)]
    .map(m => `q${m[1] || m[2]}${m[3] ? `:${m[3].slice(-2)}` : ''}`));
  const years = new Set([...value.matchAll(/\bfy\s*((?:20)?\d{2})(?:\s*[-/]\s*((?:20)?\d{2}))?\b/gi)]
    .map(m => (m[2] || m[1]).slice(-2)));
  const phases = new Set([...value.matchAll(/\bphase\s*[-:]?\s*(\d+)\b/gi)].map(m => m[1]));
  const projects = namedAfter(value, NAMED.projects);
  const customers = namedAfter(value, NAMED.customers);
  const places = namedAfter(value, NAMED.places);
  return {
    type: TYPES.find(([, pattern]) => pattern.test(value))?.[0] || null,
    stage: STAGES.find(([, pattern]) => pattern.test(value))?.[0] || null,
    periods, years, phases, projects, customers, places,
  };
}

/** Explicit contradictory facts veto even near-identical wording and equal amounts. */
export function compatibleEventFacts(a, b) {
  if (a.type && b.type && a.type !== b.type) return false;
  if (a.stage && b.stage && a.stage !== b.stage) return false;
  if (conflict(a.years, b.years) || conflict(a.phases, b.phases)) return false;
  // A quarter without its year can agree with the same quarter explicitly dated in the other.
  if (a.periods.size && b.periods.size && ![...a.periods].some(x => [...b.periods].some(y =>
    x === y || (x.split(':')[0] === y.split(':')[0] && (!x.includes(':') || !y.includes(':')))))) return false;
  return !['projects', 'customers', 'places'].some(key => nameConflict(a[key], b[key]));
}

/** Same kind, same reported stage and amount, close in time: differently worded order coverage. */
export function sameOrderFacts(a, b) {
  return a.type === 'order' && b.type === 'order' && a.stage === 'awarded' && b.stage === 'awarded';
}

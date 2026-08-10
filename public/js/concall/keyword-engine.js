// concall/keyword-engine.js — the runtime transcript scanner.
//
// NOTHING HERE IS PRECOMPUTED. Every count on the Con-call tab is produced by running this
// code over transcript text in the browser, which is what makes the keyword editor real: add
// an alias and the numbers move, because the text genuinely contains that word.
//
//   import * as engine from '../concall/keyword-engine.js';
//   const scan = engine.scanCall(call, engine.getKeywords());
//   scan.byKeyword['capex'].hits            // 7
//   scan.byKeyword['capex'].prepared        // 4  (management volunteered it)
//   scan.byKeyword['capex'].qna             // 3  (analysts asked about it)
//   scan.byKeyword['capex'].contexts        // [{ speaker, section, sentence, matchedTerm }]
//
// MATCHING RULES
//   · case-insensitive
//   · word-boundary anchored, so "capex" does not match "capexes" and — more importantly —
//     a two-letter alias can never match inside an unrelated word
//   · multi-word terms tolerate any run of whitespace ("order  book" == "order book")
//   · every alias of a keyword counts toward that keyword's total
//   · overlapping aliases are counted ONCE. If a keyword tracks both "margin" and
//     "margin guidance", the phrase "margin guidance" is one hit, not two — otherwise adding
//     a broader alias would silently inflate every count that the narrower one already caught.
//
// THE PREPARED / Q&A SPLIT is kept everywhere rather than summed away. They mean opposite
// things: capex in prepared remarks is management volunteering a commitment; capex in Q&A is
// an analyst having to drag it out of them. A tab that only showed the total would hide that.

const STORAGE_KEY = 'sattva:concall-keywords';

// ---------------------------------------------------------------------------------------
// Colour vocabulary
//
// Keyword colours are CATEGORICAL — they distinguish one keyword from another and carry no
// verdict. Emerald, amber and rose are reserved as semantic in this dashboard (pass /
// partial / fail), so they are deliberately absent: a keyword tinted emerald would read as
// "good". The picker in the editor offers exactly this list and nothing else.
// ---------------------------------------------------------------------------------------
export const KEYWORD_COLORS = {
  indigo: { dot: 'bg-indigo-500', chip: 'bg-indigo-50 text-indigo-700 ring-indigo-200', cell: 'bg-indigo-50 text-indigo-700', hex: '#6366f1' },
  violet: { dot: 'bg-violet-500', chip: 'bg-violet-50 text-violet-700 ring-violet-200', cell: 'bg-violet-50 text-violet-700', hex: '#8b5cf6' },
  purple: { dot: 'bg-purple-500', chip: 'bg-purple-50 text-purple-700 ring-purple-200', cell: 'bg-purple-50 text-purple-700', hex: '#a855f7' },
  fuchsia: { dot: 'bg-fuchsia-500', chip: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200', cell: 'bg-fuchsia-50 text-fuchsia-700', hex: '#d946ef' },
  pink: { dot: 'bg-pink-500', chip: 'bg-pink-50 text-pink-700 ring-pink-200', cell: 'bg-pink-50 text-pink-700', hex: '#ec4899' },
  sky: { dot: 'bg-sky-500', chip: 'bg-sky-50 text-sky-700 ring-sky-200', cell: 'bg-sky-50 text-sky-700', hex: '#0ea5e9' },
  cyan: { dot: 'bg-cyan-500', chip: 'bg-cyan-50 text-cyan-700 ring-cyan-200', cell: 'bg-cyan-50 text-cyan-700', hex: '#06b6d4' },
  blue: { dot: 'bg-blue-500', chip: 'bg-blue-50 text-blue-700 ring-blue-200', cell: 'bg-blue-50 text-blue-700', hex: '#3b82f6' },
  teal: { dot: 'bg-teal-500', chip: 'bg-teal-50 text-teal-700 ring-teal-200', cell: 'bg-teal-50 text-teal-700', hex: '#14b8a6' },
  slate: { dot: 'bg-slate-500', chip: 'bg-slate-100 text-slate-700 ring-slate-300', cell: 'bg-slate-100 text-slate-700', hex: '#64748b' },
};
export const COLOR_NAMES = Object.keys(KEYWORD_COLORS);
export const colorFor = (name) => KEYWORD_COLORS[name] || KEYWORD_COLORS.slate;

// ---------------------------------------------------------------------------------------
// The keyword set: defaults from the JSON file, user edits in localStorage.
// ---------------------------------------------------------------------------------------

let defaults = [];
let current = null;
const changeListeners = new Set();

/** Seed the defaults from concall-keywords.json (called by app.js at bootstrap). */
export function primeDefaults(payload) {
  const list = Array.isArray(payload?.keywords) ? payload.keywords : Array.isArray(payload) ? payload : [];
  defaults = list.map(normalise).filter(Boolean);
  current = null; // force a re-read so the defaults apply if nothing is stored
  return defaults;
}

export function getDefaults() {
  return defaults.map((k) => ({ ...k, terms: [...k.terms] }));
}

function normalise(k) {
  if (!k || !k.id) return null;
  const terms = (Array.isArray(k.terms) ? k.terms : [])
    .map((t) => String(t).trim())
    .filter(Boolean);
  return {
    id: String(k.id),
    label: String(k.label || k.id),
    category: k.category ? String(k.category) : '',
    color: COLOR_NAMES.includes(k.color) ? k.color : 'slate',
    // A keyword with no aliases falls back to matching its own label, so a freshly added
    // keyword is never silently unmatchable.
    terms: terms.length ? terms : [String(k.label || k.id)],
  };
}

/** The active keyword set — user edits if there are any, otherwise the shipped defaults. */
export function getKeywords() {
  if (current) return current;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const list = (Array.isArray(parsed) ? parsed : parsed?.keywords || []).map(normalise).filter(Boolean);
      if (list.length) {
        current = list;
        return current;
      }
    }
  } catch {
    // Corrupt or unreadable storage falls through to the defaults rather than blanking the tab.
  }
  current = getDefaults();
  return current;
}

/**
 * Replace the whole set and notify. Callers re-render on the change event rather than
 * polling — that is what makes an edit in the modal update every count behind it at once.
 */
export function setKeywords(list) {
  current = (Array.isArray(list) ? list : []).map(normalise).filter(Boolean);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ keywords: current }));
  } catch {
    // Private mode / quota: the edit still applies for this session, it just will not persist.
  }
  emitChange();
  return current;
}

/** Drop user edits and go back to the shipped set. */
export function resetKeywords() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  current = getDefaults();
  emitChange();
  return current;
}

export function hasUserEdits() {
  try {
    return !!localStorage.getItem(STORAGE_KEY);
  } catch {
    return false;
  }
}

export function onKeywordsChange(cb) {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

function emitChange() {
  for (const cb of [...changeListeners]) {
    try {
      cb(current);
    } catch (err) {
      console.error('[keyword-engine] change listener threw', err);
    }
  }
}

/** Import a JSON string produced by exportKeywords(). Throws with a readable message. */
export function importKeywords(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That is not valid JSON.');
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.keywords;
  if (!Array.isArray(list) || !list.length) throw new Error('Expected an array of keywords, or an object with a "keywords" array.');
  const clean = list.map(normalise).filter(Boolean);
  if (!clean.length) throw new Error('No usable keywords found — each needs at least an "id".');
  return setKeywords(clean);
}

export function exportKeywords() {
  return JSON.stringify({ keywords: getKeywords() }, null, 2);
}

/** A stable id for a new keyword, slugged from its label and de-duplicated. */
export function slugId(label, existing = getKeywords()) {
  const base = String(label || 'keyword').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'keyword';
  let id = base;
  let n = 2;
  while (existing.some((k) => k.id === id)) id = `${base}-${n++}`;
  return id;
}

// ---------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Compiled patterns are cached per term string — the same nine keywords are re-scanned across
// 112 calls, so recompiling a RegExp per call per term is pure waste.
const patternCache = new Map();

function patternFor(term) {
  let re = patternCache.get(term);
  if (!re) {
    // \s+ between words so "order  book" and "order\nbook" both match.
    const body = escapeRe(term.trim()).replace(/\s+/g, '\\s+');
    // Lookarounds rather than \b: \b is wrong at a boundary like "SKU," vs "SKU-2", and these
    // behave predictably for terms that start or end with a non-word character.
    re = new RegExp(`(?<![\\w-])${body}(?![\\w-])`, 'gi');
    patternCache.set(term, re);
  }
  re.lastIndex = 0;
  return re;
}

/**
 * All non-overlapping match ranges for one keyword in one string.
 * Longer aliases win: matching "margin guidance" before "margin" means the broader alias does
 * not double-count a phrase the narrower one already claimed.
 */
function matchRanges(text, terms) {
  const found = [];
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    const re = patternFor(term);
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (found.some((r) => start < r.end && end > r.start)) continue; // overlaps a longer alias
      found.push({ start, end, term, matched: m[0] });
      if (m[0].length === 0) re.lastIndex++; // paranoia: never loop forever on an empty match
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** The sentence containing `index`, so a context line reads as a sentence and not a fragment. */
function sentenceAround(text, index) {
  const before = text.lastIndexOf('. ', index);
  const start = before === -1 ? 0 : before + 2;
  const after = text.indexOf('. ', index);
  const end = after === -1 ? text.length : after + 1;
  return text.slice(start, end).trim();
}

// ---------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------

const scanCache = new Map();
const MAX_CACHE = 400; // ~ two full passes over the call set; bounded so it cannot grow forever

/** Only the fields that change the *result* go into the key — a colour edit must not bust it. */
function keywordsHash(keywords) {
  return keywords.map((k) => `${k.id}:${k.terms.join('|')}`).join(';');
}

/**
 * Scan one call.
 *
 * Returns:
 *   {
 *     callId, quarter, totalHits, keywordsMatched,
 *     byKeyword: { [id]: { id, label, color, hits, prepared, qna, segments: [i],
 *                          contexts: [{ speaker, role, section, sentence, matchedTerm, segmentIndex }],
 *                          firstMentionAt } }
 *   }
 *
 * A call with no transcript (scheduled, not yet held) returns zeroed counts with
 * `hasTranscript: false` — the caller is expected to render that as "not yet held" rather than
 * as a company that mentioned nothing.
 */
export function scanCall(call, keywords = getKeywords()) {
  const callId = call?.callId || 'unknown';
  const key = `${callId}::${keywordsHash(keywords)}`;
  const cached = scanCache.get(key);
  if (cached) return cached;

  const segments = Array.isArray(call?.transcript) ? call.transcript : [];
  const byKeyword = {};
  for (const k of keywords) {
    byKeyword[k.id] = {
      id: k.id,
      label: k.label,
      color: k.color,
      hits: 0,
      prepared: 0,
      qna: 0,
      segments: [],
      contexts: [],
      firstMentionAt: null,
    };
  }

  segments.forEach((seg, i) => {
    const text = String(seg?.text || '');
    if (!text) return;
    for (const k of keywords) {
      const ranges = matchRanges(text, k.terms);
      if (!ranges.length) continue;
      const bucket = byKeyword[k.id];
      bucket.hits += ranges.length;
      if (seg.section === 'qna') bucket.qna += ranges.length;
      else bucket.prepared += ranges.length;
      bucket.segments.push(i);
      if (bucket.firstMentionAt == null) bucket.firstMentionAt = seg.t ?? null;
      // One context per segment, not per match — three mentions in one sentence is one thing
      // to read, and an unbounded context list is what makes a tooltip unusable.
      bucket.contexts.push({
        speaker: seg.speaker || '',
        role: seg.role || '',
        section: seg.section || 'prepared',
        sentence: sentenceAround(text, ranges[0].start),
        matchedTerm: ranges[0].term,
        segmentIndex: i,
        t: seg.t ?? null,
      });
    }
  });

  const result = {
    callId,
    quarter: call?.quarter || null,
    hasTranscript: segments.length > 0,
    byKeyword,
    totalHits: Object.values(byKeyword).reduce((s, b) => s + b.hits, 0),
    keywordsMatched: Object.values(byKeyword).filter((b) => b.hits > 0).length,
  };

  if (scanCache.size >= MAX_CACHE) scanCache.clear();
  scanCache.set(key, result);
  return result;
}

/**
 * Latest vs previous, from the same scan function run over both — so a delta can never
 * disagree with the counts it is derived from.
 *
 * `previous` may be null (a company's first call); every delta then comes back as null rather
 * than as the latest count, which would read as "+7 since last quarter" for a call that has no
 * last quarter.
 */
export function compareScans(latest, previous) {
  const out = { totalDelta: null, byKeyword: {}, hasPrevious: !!previous?.hasTranscript, introduced: [], dropped: [] };
  const ids = new Set([...Object.keys(latest?.byKeyword || {}), ...Object.keys(previous?.byKeyword || {})]);
  for (const id of ids) {
    const now = latest?.byKeyword?.[id]?.hits ?? 0;
    const before = previous?.byKeyword?.[id]?.hits ?? 0;
    out.byKeyword[id] = {
      now,
      before: out.hasPrevious ? before : null,
      delta: out.hasPrevious ? now - before : null,
    };
    if (!out.hasPrevious) continue;
    if (now > 0 && before === 0) out.introduced.push(id);
    if (now === 0 && before > 0) out.dropped.push(id);
  }
  out.totalDelta = out.hasPrevious ? (latest?.totalHits ?? 0) - (previous?.totalHits ?? 0) : null;
  return out;
}

/** Highlight every keyword hit in a plain-text string. Returns trusted HTML. */
export function highlight(text, keywords = getKeywords(), escapeFn = (s) => s) {
  const src = String(text || '');
  const all = [];
  for (const k of keywords) {
    for (const r of matchRanges(src, k.terms)) all.push({ ...r, keyword: k });
  }
  if (!all.length) return escapeFn(src);
  all.sort((a, b) => a.start - b.start);

  let out = '';
  let cursor = 0;
  for (const r of all) {
    if (r.start < cursor) continue; // two keywords claiming the same span — first one wins
    const c = colorFor(r.keyword.color);
    out += escapeFn(src.slice(cursor, r.start));
    out += `<mark class="rounded px-0.5 font-semibold ${c.cell}" data-kw="${escapeFn(r.keyword.id)}">${escapeFn(src.slice(r.start, r.end))}</mark>`;
    cursor = r.end;
  }
  out += escapeFn(src.slice(cursor));
  return out;
}

/** Drop every memoised scan. Called when the keyword set changes. */
export function clearCache() {
  scanCache.clear();
}

// A keyword edit invalidates every scan that used the old set. The cache is keyed by the
// keyword hash so stale entries could never be *returned*, but they would sit there forever;
// clearing keeps memory flat across a long editing session.
onKeywordsChange(clearCache);

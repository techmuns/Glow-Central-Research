// data/chatter.js — the public-chatter feeds: load once, derive once, cache.
//
//   await load();
//   threads()                  // ValuePickr threads, momentum derived
//   groups()                   // Telegram groups, pump risk derived
//   trending()                 // one row per company, both sources merged
//   forScope(rows, scope, hs)  // narrow to holdings, keeping "no chatter" rows
//   meta()                     // generated_at, provenance, isMock
//
// EVERYTHING DERIVED IS DERIVED HERE, not baked into the JSON: momentum, reach, and the
// pump-risk flag. The files carry raw counts only, so the UI can show its working and a reader
// can disagree with a flag rather than having to trust it.
//
// PROVENANCE: threads, posts, groups and messages are SYNTHETIC and every handle is fictional
// (see scripts/gen-mock-chatter.mjs). `meta().isMock` is derived from the payload's own
// `source` field; every marker on the tab reads that one flag.

import { pumpRisk } from '../chatter/pump-risk.js';

const VP_PATH = 'data/mock/chatter-valuepickr.json';
const TG_PATH = 'data/mock/chatter-telegram.json';

export const LIVE_ID = 'chatter-live';

let loadPromise = null;
let cache = null;

export function load() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = build().catch((err) => {
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load ${path} (${res.status})`);
  return res.json();
}

async function build() {
  const [vp, tg] = await Promise.all([fetchJson(VP_PATH), fetchJson(TG_PATH)]);
  cache = ingest(vp, tg);
  return cache;
}

// ---- derivations ---------------------------------------------------------------------------

/** Momentum as both an absolute change and a percentage, with the divide-by-zero case honest. */
function momentumOf(now, prior) {
  const abs = now - prior;
  // A thread that went from 0 to 12 has not grown "infinitely" — it has started. Percentage is
  // null there, and the UI shows the absolute instead of inventing a number.
  const pct = prior > 0 ? Math.round((abs / prior) * 1000) / 10 : null;
  return { abs, pct, isNew: prior === 0 && now > 0 };
}

function ingest(vp, tg) {
  const threads = (vp?.threads || []).map((t) => ({
    ...t,
    source: 'valuepickr',
    momentum: momentumOf(t.posts7d, t.postsPrior7d),
    // Reach is distinct participants over the window — the number of people talking, which is
    // a different question from the number of posts.
    reach: t.participantCount,
    postsPerParticipant: t.participantCount ? Math.round((t.posts7d / t.participantCount) * 10) / 10 : 0,
  }));

  const groups = (tg?.groups || []).map((g) => ({
    ...g,
    source: 'telegram',
    momentum: momentumOf(g.messages24h, g.messagesPrior24h),
    reach: g.uniqueSenders24h,
    risk: pumpRisk(g),
  }));

  return {
    meta: {
      generated_at: vp?.generated_at ?? null,
      source: vp?.source ?? 'Mock data',
      generator: vp?.generator ?? null,
      seed: vp?.seed ?? null,
      as_of: vp?.as_of ?? null,
      thread_count: threads.length,
      group_count: groups.length,
      provenance: vp?._provenance ?? null,
      isMock: String(vp?.source ?? '').toLowerCase().includes('mock'),
    },
    threads,
    groups,
    byThreadId: new Map(threads.map((t) => [t.threadId, t])),
    byGroupId: new Map(groups.map((g) => [g.groupId, g])),
  };
}

// ---- accessors -----------------------------------------------------------------------------

export function threads() {
  return cache ? cache.threads : [];
}
export function groups() {
  return cache ? cache.groups : [];
}
export function meta() {
  return cache ? cache.meta : null;
}
export function isLoaded() {
  return !!cache;
}
export function threadById(id) {
  return cache?.byThreadId.get(id) || null;
}
export function groupById(id) {
  return cache?.byGroupId.get(id) || null;
}

/**
 * One row per company across BOTH sources — the cross-source view.
 *
 * Mentions are posts + messages, which are not the same unit; the row keeps them separate as
 * well as summed so the split bar can show where the noise is actually coming from.
 */
export function trending() {
  const byTicker = new Map();
  const ensure = (ticker, name, sector) => {
    if (!byTicker.has(ticker)) {
      byTicker.set(ticker, {
        ticker,
        name,
        sector,
        vpPosts: 0,
        vpPrior: 0,
        tgMessages: 0,
        tgPrior: 0,
        threads: [],
        groups: [],
        sentiments: [],
        firstMentionAt: null,
        maxRisk: 0,
      });
    }
    return byTicker.get(ticker);
  };

  for (const t of threads()) {
    const row = ensure(t.ticker, t.name, t.sector);
    row.vpPosts += t.posts7d;
    row.vpPrior += t.postsPrior7d;
    row.threads.push(t);
    row.sentiments.push(t.sentiment);
    if (!row.firstMentionAt || t.createdAt < row.firstMentionAt) row.firstMentionAt = t.createdAt;
  }
  for (const g of groups()) {
    const row = ensure(g.ticker, g.companyName, g.sector);
    row.tgMessages += g.messages24h;
    row.tgPrior += g.messagesPrior24h;
    row.groups.push(g);
    row.sentiments.push(g.sentiment);
    row.maxRisk = Math.max(row.maxRisk, g.risk.level);
  }

  return [...byTicker.values()]
    .map((row) => {
      const total = row.vpPosts + row.tgMessages;
      const prior = row.vpPrior + row.tgPrior;
      const sentiment = row.sentiments.length ? row.sentiments.reduce((a, b) => a + b, 0) / row.sentiments.length : null;
      return {
        ...row,
        totalMentions: total,
        priorMentions: prior,
        momentum: momentumOf(total, prior),
        sentiment: sentiment == null ? null : Math.round(sentiment * 100) / 100,
        bullishShare: row.sentiments.length
          ? Math.round((row.sentiments.filter((s) => s > 0.15).length / row.sentiments.length) * 100)
          : null,
        sourceSplit: total ? { vp: Math.round((row.vpPosts / total) * 100), tg: Math.round((row.tgMessages / total) * 100) } : { vp: 0, tg: 0 },
      };
    })
    .sort((a, b) => b.totalMentions - a.totalMentions);
}

/**
 * Narrow any of the above to the portfolio.
 *
 * A holding with no chatter comes back as an explicit placeholder row rather than being
 * dropped — "nobody is talking about this" is a finding, and a silently missing row is not.
 */
export function forScope(rows, scope, holdings = [], { key = (r) => r.ticker } = {}) {
  if (scope !== 'portfolio') return rows;
  const held = holdings.map((h) => String(h.ticker).toUpperCase());
  const byTicker = new Map();
  for (const r of rows) {
    const t = String(key(r)).toUpperCase();
    if (!byTicker.has(t)) byTicker.set(t, []);
    byTicker.get(t).push(r);
  }
  const out = [];
  for (const h of holdings) {
    const hits = byTicker.get(String(h.ticker).toUpperCase());
    if (hits?.length) out.push(...hits);
    else out.push({ ticker: h.ticker, name: h.name || h.ticker, sector: h.sector || '', noChatter: 'No chatter tracked for this holding' });
  }
  void held;
  return out;
}

// ---- live engine ----------------------------------------------------------------------------

// How many new posts / messages have arrived since the page loaded. Held here rather than in
// the view so a sub-view switch or a filter change does not reset the counters.
const arrivals = new Map(); // id -> count
let lastTickAt = null;

export function arrivalsFor(id) {
  return arrivals.get(id) || 0;
}
export function totalArrivals() {
  let n = 0;
  for (const v of arrivals.values()) n += v;
  return n;
}
export function lastTick() {
  return lastTickAt;
}

/**
 * The live tick.
 *
 * A real feed would expose "posts since <cursor>" and this would be
 * `live.realFetcher('/api/chatter/since?...')`. There is no such endpoint, so the tick picks a
 * few busy threads and groups and increments them — the same shape a delta endpoint would
 * return.
 *
 * It deliberately does NOT re-fetch either JSON file. `live.mockFetcher` would re-download both
 * every tick and jitter their numbers, and jittering a post count while quoting the post text
 * beside it would make the two disagree.
 */
async function tickFetcher() {
  const at = Date.now();
  lastTickAt = at;
  const hot = threads()
    .slice()
    .sort((a, b) => b.posts7d - a.posts7d)
    .slice(0, 12);
  const loud = groups()
    .slice()
    .sort((a, b) => b.messages24h - a.messages24h)
    .slice(0, 10);

  const events = [];
  // Busier rooms produce more arrivals per tick — that is the only thing "live" means here.
  for (const t of hot) {
    if (Math.random() < 0.35) {
      const n = 1;
      t.posts7d += n;
      t.momentum = momentumOf(t.posts7d, t.postsPrior7d);
      arrivals.set(t.threadId, (arrivals.get(t.threadId) || 0) + n);
      events.push({ kind: 'post', id: t.threadId, ticker: t.ticker, name: t.name, n });
    }
  }
  for (const g of loud) {
    if (Math.random() < 0.5) {
      const n = Math.random() < 0.3 ? 2 : 1;
      g.messages24h += n;
      g.momentum = momentumOf(g.messages24h, g.messagesPrior24h);
      // The flag has to be recomputed, not carried: another burst can tip a group over.
      g.risk = pumpRisk(g);
      arrivals.set(g.groupId, (arrivals.get(g.groupId) || 0) + n);
      events.push({ kind: 'message', id: g.groupId, ticker: g.ticker, name: g.companyName, n });
    }
  }
  return { at, events, total: totalArrivals() };
}

export function registerPoller(live, { intervalMs = 8000 } = {}) {
  live.register(LIVE_ID, { intervalMs, fetcher: tickFetcher });
}

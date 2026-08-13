// core/watch.js — the app-wide feed watchers behind the notification stack.
//
//   watch.start(live);        // once, at shell mount
//   watch.ensureRunning();    // after every route change
//   await watch.refreshNow(); // the header's refresh button
//
// WHY THIS EXISTS SEPARATELY FROM THE TABS
//   `startLive` / `stopLive` on each feed are owned by the tab that shows it: the Earnings Hub
//   starts the results poller in render() and stops it in destroy(). That is right for a table —
//   nothing should poll a feed nothing is showing. It is wrong for an alert, which is only worth
//   having if it fires while the reader is somewhere else. So the watchers hold their own claim on
//   the same two pollers, and `ensureRunning()` re-asserts it after each route change, because a
//   tab's destroy() calls `live.stop()` on the id the watcher also depends on.
//
// WHAT IT COSTS, AND WHY THAT IS ACCEPTABLE
//   Both feeds are conditional: an unchanged con-call tick is a bodyless 304 (~0.3KB) and an
//   unchanged results tick is the ~30KB prices projection, which drops to ~0.3KB when even the
//   prices have not moved. The full 1.1MB payload is pulled only when `structureTag` moves — i.e.
//   when a company has actually filed. Watching two feeds app-wide is affordable *because* of the
//   caching work in `core/store.js` and `worker/http.mjs`; without it this would be indefensible.
//
// THE BACKLOG RULE
//   Both feeds accumulate `newArrivals()` from page load onward. On the watcher's first change
//   event that list may already hold rows the reader has been looking at for ten minutes. Those are
//   suppressed rather than announced: a notification asserts "this just happened", and replaying
//   history through it devalues every alert after it.

import * as earnings from '../data/earnings-live.js';
import * as concalls from '../data/concall-scans.js';
import * as chatter from '../data/chatter-live.js';
import * as coverage from '../data/coverage.js';
import * as notifications from '../ui/notifications.js';
import { formatCroreCompact, formatPct } from './format.js';

let engine = null;
let started = false;
const stops = [];

// Arrival keys are stable across ticks, which is what lets `notifications.push` dedupe: the feeds
// re-hand the whole arrival list every time anything changes.
const earningsKey = (r) => `earnings:${r.scId}:${r.resultDate}`;
const concallKey = (r) => `concall:${r.companyKey}:${r.when}:${r.reason}`;
const chatterKey = (r) => `chatter:${r.slug}`;

export function start(live) {
  if (started) return;
  started = true;
  engine = live;
  notifications.mount();

  // Load, then watch. A failed load is not an error state for the watcher — the tab that owns the
  // feed reports it properly, and an alert stack that announced its own fetch failures would be
  // noise about our plumbing rather than news about the market.
  wire(earnings, { keyOf: earningsKey, announce: announceEarnings, label: earnings.LIVE_ID });
  wire(concalls, { keyOf: concallKey, announce: announceConcalls, label: concalls.LIVE_ID });
  wire(chatter, { keyOf: chatterKey, announce: announceChatter, label: chatter.LIVE_ID });
}

function wire(feed, { keyOf, announce, label }) {
  feed
    .load()
    .then(() => {
      // Everything already on the arrival list at this moment predates the watcher. Seed the
      // dedupe set with it so the first change event announces only what is genuinely new.
      notifications.suppress(feed.newArrivals().map(keyOf));
      stops.push(feed.startLive(engine));
      stops.push(feed.onChange(announce));
    })
    .catch((err) => console.warn(`[watch] ${label} unavailable — no alerts from it`, err));
}

/**
 * Re-assert the watchers' claim on both pollers.
 *
 * Called after every route change because a tab's `destroy()` calls `live.stop()` on the same
 * poller id. `live.start()` is a no-op when the poller is already running, so this is cheap and
 * idempotent — and without it, visiting the Earnings Hub once and leaving would permanently kill
 * the alerts for that feed.
 */
export function ensureRunning() {
  if (!engine) return;
  for (const id of [earnings.LIVE_ID, concalls.LIVE_ID, chatter.LIVE_ID]) engine.start(id);
}

/**
 * Force every running poller to check now. Resolves to what changed, so the button can say
 * something true rather than just spinning for a moment.
 */
export async function refreshNow() {
  if (!engine) return { announced: 0 };
  const before = notifications.announcedCount();
  ensureRunning();
  await engine.refreshAll();
  // The feeds' own onChange fires synchronously inside the tick, so by here the announcements
  // have already been made.
  return { announced: notifications.announcedCount() - before };
}

// ---------------------------------------------------------------------------------------
// Turning arrivals into alerts
//
// Every string below is built from a field the feed carried. Where a figure is missing the line
// says what is missing instead of substituting a zero — a result with no reported profit is not a
// result of zero, and a con-call awaiting its analysis is `pending` upstream, not a score of nil.
// ---------------------------------------------------------------------------------------

function announceEarnings() {
  for (const r of [...earnings.newArrivals()].reverse()) {
    notifications.push({
      key: earningsKey(r),
      kind: 'earnings',
      title: r.company || r.shortName || r.ticker || 'A company has reported',
      detail: earningsDetail(r),
      href: '#/research/earnings-hub/latest-results',
      at: r.seenAt || Date.now(),
    });
  }
}

export function earningsDetail(r) {
  const parts = [];
  const rev = describeMetric('Revenue', r.revenue);
  const pat = describeMetric('Net profit', r.netProfit);
  if (rev) parts.push(rev);
  if (pat) parts.push(pat);
  if (!parts.length) return r.resultDate ? `Filed ${r.resultDate}. Figures not yet parsed.` : 'Filed. Figures not yet parsed.';
  return parts.join(' · ');
}

/**
 * One metric as a phrase. `kind` comes from `classifyChange()` in worker/mc.mjs and is the whole
 * reason this is not a template string: 13% of reported moves cross zero, where a percentage is
 * not a growth rate at all. Those get the words the table uses rather than a coloured number that
 * would be a lie in a smaller font.
 */
function describeMetric(label, m) {
  if (!m || m.current == null) return '';
  const value = formatCroreCompact(m.current);
  if (m.kind === 'loss_to_profit') return `${label} ${value} — turned profitable`;
  if (m.kind === 'profit_to_loss') return `${label} ${value} — swung to a loss`;
  if (m.kind === 'loss_both') return `${label} ${value} — loss in both periods`;
  if (m.pct == null) return `${label} ${value}`;
  return `${label} ${value} (${formatPct(m.pct, { signed: true })})`;
}

function announceConcalls() {
  for (const r of [...concalls.newArrivals()].reverse()) {
    notifications.push({
      key: concallKey(r),
      kind: 'concall',
      title: r.name || r.ticker || 'A con-call was held',
      detail: concallDetail(r),
      href: '#/research/concall',
      at: r.seenAt || Date.now(),
    });
  }
}

export function concallDetail(r) {
  // `reason` is set by the feed: 'listed' means the call joined the index, 'analysed' means
  // StockScans' read of it landed. They are different events and read as different sentences.
  if (r.reason === 'analysed') {
    const score = r.resultScore != null ? `Result score ${Math.round(r.resultScore)}/100 (StockScans)` : 'Analysis ready (StockScans)';
    return r.resultTier?.label ? `${score} · ${r.resultTier.label}` : score;
  }
  if (r.resultScore == null) return 'Call held — analysis pending';
  return `Result score ${Math.round(r.resultScore)}/100 (StockScans)`;
}

/**
 * Chatter alerts fire ONLY for companies in the book, and only on first appearance.
 *
 * The other two feeds announce every arrival, which is right: a company filing a result is an
 * event whoever owns it. Chatter is different in scale and in kind — a scrape adds entries for
 * brokers, themes and companies nobody here holds, and a stack of "Guggenheim was mentioned"
 * cards would train the reader to dismiss the whole component, including the results alerts that
 * matter. So the filter is the book, and the threshold is appearance rather than movement: a
 * holding being discussed for the first time is news; its count drifting from 3 to 4 is not.
 */
function announceChatter() {
  for (const r of [...chatter.newArrivals()].reverse()) {
    if (!r.ticker || !coverage.has(r.ticker)) continue;
    notifications.push({
      key: chatterKey(r),
      kind: 'chatter',
      title: r.name,
      detail: chatterDetail(r),
      href: '#/research/public-chatter',
      at: r.seenAt || Date.now(),
    });
  }
}

export function chatterDetail(r) {
  const where = r.sourceLabel ? ` on ${r.sourceLabel}` : '';
  const n = r.mentions === 1 ? '1 mention' : `${r.mentions} mentions`;
  // Their sentiment word, not a score of ours, and no percentage — `mentionsChangePct` is mention
  // volume and putting it in a one-line alert is exactly where it would be read as a price move.
  return `Now discussed${where} — ${n} in 30 days · ${r.sentiment.labelText} (SentimentDash)`;
}

export function stop() {
  for (const off of stops.splice(0)) {
    try {
      off?.();
    } catch { /* a disposer that throws must not strand the others */ }
  }
  started = false;
}

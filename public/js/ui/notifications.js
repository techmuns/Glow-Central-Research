// ui/notifications.js — the live alert stack in the lower-right corner.
//
//   notifications.mount();
//   notifications.push({ key, kind, title, detail, href, at });
//
// This is the one surface on the dashboard that speaks without being asked, so the rules it obeys
// are about restraint rather than richness:
//
//   1. AN ALERT IS A FACT THAT ARRIVED, never a summary of what is already on screen. It fires
//      when a company files a result or a con-call gains its analysis — things that happened
//      upstream since the reader last looked. A repaint is not an event.
//   2. `key` DEDUPES FOR THE LIFE OF THE PAGE. Both feeds re-hand their arrival list on every
//      change, and the same result must never announce itself twice because the poller ticked.
//   3. IT NEVER COVERS AN OVERLAY. z-30 puts it under the drill (z-50), the workspace (z-55) and
//      modals (z-60): the reader opened those deliberately and a toast interrupting them would be
//      the failure mode this whole component is one step away from.
//   4. NOTHING IS INVENTED TO FILL IT. `detail` is built from fields the feed actually carried; a
//      result with no reported figure says so rather than showing a zero, and a con-call with no
//      score says "analysis pending", which is what `pending` means upstream.
//
// The stack keeps the newest MAX_VISIBLE and drops the rest — it is an alert strip, not an inbox.

import { escapeHtml } from '../core/dom.js';
import { formatRelativeTime } from '../core/format.js';

const ROOT_ID = 'notification-root';
const MAX_VISIBLE = 4;
const DISMISS_MS = 14000;

// Per-kind styling. Emerald/amber/rose stay semantic elsewhere in the app, so these are
// deliberately drawn from the brand ramp plus one neutral: an alert is not a pass or a fail.
const KIND = {
  earnings: { dot: 'bg-indigo-500', ring: 'ring-indigo-100', chip: 'bg-indigo-50 text-indigo-700', label: 'Result filed' },
  concall: { dot: 'bg-purple-500', ring: 'ring-purple-100', chip: 'bg-purple-50 text-purple-700', label: 'Con-call' },
  chatter: { dot: 'bg-pink-500', ring: 'ring-pink-100', chip: 'bg-pink-50 text-pink-700', label: 'Chatter' },
  // The brand ramp again, not a semantic colour: a published story is neither good news nor bad,
  // and emerald or rose here would be this dashboard passing judgement on somebody's reporting.
  news: { dot: 'bg-indigo-400', ring: 'ring-indigo-100', chip: 'bg-indigo-50 text-indigo-700', label: 'Market news' },
  // Ask Research finishing an answer the reader asked for and then navigated away from. Brand
  // ramp again: an answer is not a pass or a fail.
  research: { dot: 'bg-purple-400', ring: 'ring-purple-100', chip: 'bg-purple-50 text-purple-700', label: 'Ask Research' },
  system: { dot: 'bg-slate-400', ring: 'ring-slate-100', chip: 'bg-slate-100 text-slate-600', label: 'Update' },
};

const seen = new Set();
let root = null;
let seq = 0;

export function mount() {
  root = document.getElementById(ROOT_ID);
  if (root) return root;
  root = document.createElement('div');
  root.id = ROOT_ID;
  // Bottom-right, above content and below every overlay. `pointer-events-none` on the column so
  // the page stays clickable through the gaps; each card re-enables them for itself.
  root.className = 'pointer-events-none fixed bottom-4 right-4 z-30 flex w-[min(22rem,calc(100vw-2rem))] flex-col-reverse gap-2';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  document.body.appendChild(root);
  return root;
}

/**
 * Show one alert. Returns false when it was a duplicate, which is the common case: the feeds hand
 * back their whole arrival list on every change and only the unseen part of it is news.
 */
export function push({ key, kind = 'system', title, detail = '', href = null, image = null, at = Date.now() }) {
  if (!title) return false;
  const id = key || `${kind}:${title}:${at}`;
  if (seen.has(id)) return false;
  seen.add(id);
  if (!root) mount();

  const style = KIND[kind] || KIND.system;
  const card = document.createElement('div');
  // NO ENTRANCE ANIMATION, DELIBERATELY. This is the one component whose entire job is to be seen,
  // and an animated entrance made it invisible twice:
  //
  //   - `.fade-in` is `animation: … both`, which pins the element at the keyframe's opacity-0 start
  //     until the animation actually runs. Anything that stops it running — a throttled timeline,
  //     reduced-motion handling, a screenshot tool that rewinds finite animations — leaves a card
  //     that is in the DOM, correctly positioned, hit-testable, and completely blank.
  //   - Replacing it with an opacity-0 start plus a `transition` on the next frame failed the same
  //     way for the same reason: the resting state was invisible and something else had to happen
  //     for the reader to see it.
  //
  // Both were caught only because a control element rendered beside it and this one did not. So the
  // rule here is that the card's ONLY state is its final one. A panel the reader navigated to can
  // afford to fade in — they are waiting for it. An alert cannot: it is unrequested, it is the
  // whole notification, and "arrived but invisible" is indistinguishable from "never fired".
  card.className = `pointer-events-auto overflow-hidden rounded-2xl bg-white shadow-lg ring-1 ${style.ring}`;
  card.dataset.notification = kind;
  // THE PICTURE THAT COMES WITH THE STORY. Only ever an http(s) value, and only ever the
  // publisher's own — the same rule the news cards follow, because this is external content and a
  // `javascript:` or `data:` value must never reach `src`. `onerror` hides it rather than leaving a
  // broken-image glyph in a card whose whole job is to look deliberate.
  const thumb =
    typeof image === 'string' && /^https:\/\//i.test(image)
      ? `<div class="h-12 w-[68px] flex-shrink-0 overflow-hidden rounded-lg bg-gradient-to-br from-slate-100 to-slate-200">
           <img src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async" class="h-full w-full object-cover" onerror="this.parentElement.style.display='none'">
         </div>`
      : '';

  card.innerHTML = `
    <div class="flex items-start gap-3 p-3.5">
      <span class="mt-1 flex h-2 w-2 flex-shrink-0 rounded-full ${style.dot}"></span>
      ${thumb}
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="rounded-full ${style.chip} px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">${escapeHtml(style.label)}</span>
          <span class="text-[11px] tabular-nums text-slate-400" data-notification-time>${escapeHtml(formatRelativeTime(at))}</span>
        </div>
        <p class="mt-1.5 line-clamp-2 text-sm font-semibold text-slate-900">${escapeHtml(title)}</p>
        ${detail ? `<p class="mt-0.5 line-clamp-2 text-xs leading-relaxed text-slate-500">${escapeHtml(detail)}</p>` : ''}
        ${href ? `<a href="${escapeHtml(href)}" class="mt-2 inline-block text-xs font-semibold text-indigo-600 hover:text-indigo-700" data-notification-link>Open →</a>` : ''}
      </div>
      <button type="button" aria-label="Dismiss" data-notification-close
        class="flex-shrink-0 rounded-lg p-1 text-slate-300 transition-colors hover:bg-slate-50 hover:text-slate-500">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;

  // Removal is immediate for the same reason: an exit animation that stalls would leave a dismissed
  // card on screen, which is the mirror of the bug above.
  const remove = () => card.remove();
  card.querySelector('[data-notification-close]').addEventListener('click', remove);
  card.querySelector('[data-notification-link]')?.addEventListener('click', remove);

  root.appendChild(card);
  seq += 1;

  // Keep the newest few. `flex-col-reverse` renders the newest at the bottom, so the oldest cards
  // are the first children.
  while (root.children.length > MAX_VISIBLE) root.firstElementChild.remove();

  const timer = setTimeout(remove, DISMISS_MS);
  card.addEventListener('mouseenter', () => clearTimeout(timer)); // reading it should not lose it
  return true;
}

/**
 * Mark a batch of keys as already announced WITHOUT showing anything.
 *
 * Both feeds carry arrivals accumulated since page load, so the first tick after the watcher
 * starts would otherwise dump a backlog of results the reader has been looking at all along. A
 * notification claims "this just happened"; replaying history through it would make every alert
 * afterwards worth less.
 */
export function suppress(keys) {
  for (const k of keys) seen.add(k);
}

/** Test seam and the "clear all" path. */
export function clear() {
  if (root) root.innerHTML = '';
}

export const visibleCount = () => (root ? root.children.length : 0);
export const announcedCount = () => seq;

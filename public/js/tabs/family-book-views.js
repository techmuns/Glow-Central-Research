// tabs/family-book-views.js — the two views of the Family Book, and the switch between them.
// GLOW-OWNED.
//
// THE SWITCH SITS ON THE TITLE ROW, NOT IN A CARD ABOVE IT — the same resolution Corp Announcements
// and Mutual Funds took, for the same measured reason: the shell's sub-view picker is a white card
// with a kicker, a label and a chevron, and on a tab whose whole point is the table beneath it that
// is ~70px of chrome spent on a choice between two words. `family-book.js` declares
// `inlineSubviews: true`, so the shell still routes `#/research/family-book/<view>` — the URL
// segment, the fallback to the first view, a shared link — and draws no card.
//
// ALL HOLDINGS IS FIRST AND IS UNCHANGED. It is what the tab has always been: every row on every
// statement, every asset class, consolidated. Direct Equity is a narrowing of it — the listed
// equity only, one row per company rather than one per (company, account) — and nothing in it may
// contradict the view beside it, because both read the same `counted()` rows.

import { escapeHtml } from '../core/dom.js';
import { buildHash } from '../core/router.js';

export const ALL_HOLDINGS_VIEW = 'all-holdings';
export const DIRECT_EQUITY_VIEW = 'direct-equity';
export const TAB_ID = 'family-book';
export const VIEWS = [
  { id: ALL_HOLDINGS_VIEW, label: 'All Holdings' },
  { id: DIRECT_EQUITY_VIEW, label: 'Direct Equity' },
];

/** The segmented switch, with the active view marked `aria-current="page"`. Plain hash links. */
export function viewSwitchHtml(ctx, activeId) {
  const scope = ctx?.scope || 'portfolio';
  return `<nav data-view-switch aria-label="Family Book views" class="inline-flex shrink-0 rounded-lg bg-slate-100 p-0.5 text-xs font-semibold">
    ${VIEWS.map((v) => {
      const active = v.id === activeId;
      const href = buildHash({ workspace: 'research', tab: TAB_ID, subview: v.id, scope });
      return `<a href="${escapeHtml(href)}" data-view-switch-item="${escapeHtml(v.id)}" ${active ? 'aria-current="page"' : ''}
        class="rounded-md px-2.5 py-1 transition-colors ${active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'}">${escapeHtml(v.label)}</a>`;
    }).join('')}
  </nav>`;
}

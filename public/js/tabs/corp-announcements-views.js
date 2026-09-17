// tabs/corp-announcements-views.js — the two views of Corp Announcements, and the switch between
// them, in one place both view modules import.
//
// THE SWITCH SITS IN THE TITLE ROW, NOT IN A CARD ABOVE IT. The shell's sub-view picker is a
// white card of its own — a kicker, a label and a chevron — and on a tab whose whole point is the
// table beneath, it was ~70px of chrome spent on a choice between two words. So this tab declares
// `subviewPicker: 'inline'`: the shell still routes `#/research/corp-announcements/<view>` exactly
// as before (the alias for the retired tab id, the watchdog mapping and the Ask Research citation
// route are untouched), but draws no card, and the section head carries this segmented switch
// beside the title instead. They are plain hash links, so the router does the navigation and no
// listener has to be wired or disposed.

import { escapeHtml } from '../core/dom.js';
import { buildHash } from '../core/router.js';

export const ANNOUNCEMENTS_VIEW = 'announcements';
export const CORPORATE_ACTIONS_VIEW = 'corporate-actions';
export const TAB_ID = 'corp-announcements';
export const VIEWS = [
  { id: ANNOUNCEMENTS_VIEW, label: 'Announcements' },
  { id: CORPORATE_ACTIONS_VIEW, label: 'Corporate Actions' },
];

/** The segmented switch, with the active view marked `aria-current="page"`. */
export function viewSwitchHtml(ctx, activeId) {
  const scope = ctx?.scope || 'portfolio';
  return `<nav data-view-switch aria-label="Corp Announcements views" class="inline-flex shrink-0 rounded-lg bg-slate-100 p-0.5 text-xs font-semibold">
    ${VIEWS.map((v) => {
      const active = v.id === activeId;
      const href = buildHash({ workspace: 'research', tab: TAB_ID, subview: v.id, scope });
      return `<a href="${escapeHtml(href)}" data-view-switch-item="${escapeHtml(v.id)}" ${active ? 'aria-current="page"' : ''}
        class="rounded-md px-2.5 py-1 transition-colors ${active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'}">${escapeHtml(v.label)}</a>`;
    }).join('')}
  </nav>`;
}

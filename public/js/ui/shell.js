// ui/shell.js — the generic app chrome: header, workspace dropdown, top tabs, left rail,
// and the content host that every tab/portfolio module mounts into. This file owns the
// workspace/tab registry; individual tab modules stay ignorant of navigation entirely.

import { $, escapeHtml } from '../core/dom.js';
import { formatRelativeTime } from '../core/format.js';
import { state, setScope, setRoute, saveLastRoute } from '../core/state.js';
import * as router from '../core/router.js';
import * as live from '../core/live.js';
import { tabBar, railNav, segmentedToggle, searchInput, liveBadge, emptyState } from './components.js';

import * as earningsHub from '../tabs/earnings-hub.js';
import * as concall from '../tabs/concall.js';
import * as publicChatter from '../tabs/public-chatter.js';
import * as breakouts from '../tabs/breakouts.js';
import * as superInvestors from '../tabs/super-investors.js';
import * as overview from '../portfolio/overview.js';
import * as positionBy from '../portfolio/position-by.js';
import * as transactions from '../portfolio/transactions.js';
import * as drawdown from '../portfolio/drawdown.js';

// The nav model in one place: two workspaces, each an ordered list of tab modules.
// Every module's `meta.subviews` supplies the rail/rail-dropdown items — nothing here is
// duplicated per module.
const WORKSPACES = [
  { id: 'research', label: 'Research Central', tabs: [earningsHub, concall, publicChatter, breakouts, superInvestors] },
  { id: 'portfolio', label: 'Portfolio Analytics', tabs: [overview, positionBy, transactions, drawdown] },
];

let contentHost = null;
let currentTabModule = null;
let chromeDisposers = [];

export function mount(root) {
  root.innerHTML = shellTemplate();
  contentHost = $('#content-host', root);

  wireStaticHeader(root);

  // Always-on poller so the header "Live" pill ticks even when the active tab has no poller
  // of its own — real tab pollers (e.g. the Con-call feed) update the same global tick too.
  live.register('heartbeat', { intervalMs: 20000, fetcher: async () => Date.now() });
  live.start('heartbeat');

  router.start((rawRoute) => handleRoute(root, rawRoute));
}

function shellTemplate() {
  return `
    <header class="sticky top-0 z-40 border-b border-slate-200/80 bg-white/75 backdrop-blur-md">
      <div class="mx-auto grid max-w-[1600px] grid-cols-[auto_1fr_auto] items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3 lg:gap-6 lg:px-8">
        <div class="flex min-w-0 items-center gap-3">
          <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-600 to-emerald-600 font-display text-sm font-extrabold text-white shadow-sm">SC</span>
          <div class="hidden min-w-0 sm:block">
            <div class="font-display truncate text-base font-extrabold leading-tight text-slate-900">Sattva Central Research</div>
            <div id="brand-subtitle" class="truncate text-xs leading-tight text-slate-500">Research Central · Indian equities</div>
          </div>
        </div>
        <div class="flex min-w-0 justify-center">
          <div id="search-mount" class="w-full max-w-md"></div>
        </div>
        <div class="flex shrink-0 items-center justify-end gap-1.5 sm:gap-2 lg:gap-3">
          <div id="scope-toggle-mount"></div>
          <div id="live-badge-mount"></div>
          <div id="updated-chip-mount"></div>
        </div>
      </div>
    </header>
    <div class="mx-auto flex max-w-[1600px] flex-col gap-6 px-3 py-5 sm:px-4 sm:py-6 lg:flex-row lg:px-8">
      <aside class="lg:w-64 lg:shrink-0">
        <div id="aside-content" class="lg:sticky lg:top-20"></div>
      </aside>
      <main class="min-w-0 flex-1">
        <div id="tabbar-mount" class="mb-5"></div>
        <div id="content-host" class="flex flex-col gap-5"></div>
      </main>
    </div>
    <div id="overlay-root"></div>`;
}

// ---- Header: parts that never change across route changes ----------------------------------

function wireStaticHeader(root) {
  const isMac = navigator.platform ? navigator.platform.toLowerCase().includes('mac') : false;
  const search = searchInput({
    placeholder: 'Search any company, theme or investor…',
    shortcutLabel: isMac ? '⌘K' : 'Ctrl K',
    options: buildSearchOptions(),
  });
  $('#search-mount', root).innerHTML = search.html;
  search.wire(root);

  const liveWidget = liveBadge({ label: 'Live', getTimestamp: () => live.getLastTick(), subscribeTick: live.onGlobalTick });
  $('#live-badge-mount', root).innerHTML = liveWidget.html;
  liveWidget.wire(root);

  $('#updated-chip-mount', root).innerHTML = updatedChipHtml();
  wireUpdatedChip(root, () => state.dataLoadedAt);
}

function buildSearchOptions() {
  const data = state.data;
  const byTicker = new Map();
  for (const c of data?.universe || []) byTicker.set(c.ticker, { ticker: c.ticker, name: c.name });
  for (const h of data?.portfolio?.holdings || []) byTicker.set(h.ticker, { ticker: h.ticker, name: h.name });
  return Array.from(byTicker.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
}

function updatedChipHtml() {
  return `
    <span class="hidden items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500 lg:inline-flex" data-updated-chip>
      <span>Updated</span><span data-updated-time class="tabular-nums text-slate-600">—</span>
    </span>`;
}

function wireUpdatedChip(root, getTimestamp) {
  const timeEl = root.querySelector('[data-updated-time]');
  function refresh() {
    const ts = getTimestamp();
    timeEl.textContent = ts ? formatRelativeTime(ts) : '—';
  }
  refresh();
  setInterval(refresh, 15000);
}

// ---- Route-dependent chrome: workspace dropdown, rail, top tabs, scope toggle ---------------

function handleRoute(root, rawRoute) {
  const ws = WORKSPACES.find((w) => w.id === rawRoute.workspace) || WORKSPACES[0];
  const tabModule = ws.tabs.find((t) => t.meta.id === rawRoute.tab) || ws.tabs[0];
  const subviews = tabModule.meta.subviews || [];
  const subviewValid = subviews.some((s) => s.id === rawRoute.subview);
  const subview = subviewValid ? rawRoute.subview : subviews[0]?.id || null;
  const scope = rawRoute.scope || state.scope;

  const resolved = { workspace: ws.id, tab: tabModule.meta.id, subview, scope };

  if (state.scope !== scope) setScope(scope);
  setRoute(resolved);
  router.replaceRoute(resolved);
  saveLastRoute(router.buildHash(resolved));

  renderRouteChrome(root, ws, tabModule, resolved);
  mountTab(tabModule, resolved);
}

function renderRouteChrome(root, ws, tabModule, resolved) {
  disposeChrome();

  const subtitleEl = $('#brand-subtitle', root);
  if (subtitleEl) subtitleEl.textContent = `${ws.label} · Indian equities`;

  const toggle = segmentedToggle({
    options: [
      { value: 'universe', label: 'Universe' },
      { value: 'portfolio', label: 'Portfolio' },
    ],
    activeValue: resolved.scope,
    onChange: goScope,
  });
  const toggleMount = $('#scope-toggle-mount', root);
  toggleMount.innerHTML = toggle.html;
  chromeDisposers.push(toggle.wire(toggleMount));

  const wsDropdown = dropdownMenu({
    key: 'workspace',
    kicker: 'Workspace',
    valueLabel: ws.label,
    items: WORKSPACES.map((w) => ({ id: w.id, label: w.label })),
    activeId: ws.id,
    onSelect: goWorkspace,
  });

  const subviewItems = (tabModule.meta.subviews || []).map((s) => ({ id: s.id, label: s.label, badge: s.badge }));
  const activeSubviewLabel = subviewItems.find((s) => s.id === resolved.subview)?.label || '';
  const rail = railNav({ items: subviewItems, activeId: resolved.subview, onSelect: goSubview });
  const mobileSubDropdown = dropdownMenu({
    key: 'subview-mobile',
    kicker: tabModule.meta.title,
    valueLabel: activeSubviewLabel,
    items: subviewItems,
    activeId: resolved.subview,
    onSelect: goSubview,
  });

  const asideEl = $('#aside-content', root);
  asideEl.innerHTML = `
    <div>${wsDropdown.html}</div>
    <div class="mt-4 hidden lg:block">${rail.html}</div>
    <div class="mt-3 lg:hidden">${mobileSubDropdown.html}</div>`;
  chromeDisposers.push(wsDropdown.wire(asideEl));
  chromeDisposers.push(rail.wire(asideEl));
  chromeDisposers.push(mobileSubDropdown.wire(asideEl));

  const tabItems = ws.tabs.map((t) => ({ id: t.meta.id, label: t.meta.title }));
  const bar = tabBar({ tabs: tabItems, activeId: resolved.tab, onSelect: goTab });
  const tabBarMount = $('#tabbar-mount', root);
  tabBarMount.innerHTML = bar.html;
  chromeDisposers.push(bar.wire(tabBarMount));

  document.title = `${tabModule.meta.title} · Sattva Central Research`;
}

function disposeChrome() {
  for (const dispose of chromeDisposers) {
    try {
      dispose && dispose();
    } catch (err) {
      console.error('[shell] chrome cleanup failed', err);
    }
  }
  chromeDisposers = [];
}

function mountTab(tabModule, resolved) {
  if (currentTabModule && currentTabModule !== tabModule) {
    try {
      currentTabModule.destroy?.();
    } catch (err) {
      console.error(`[shell] destroy() failed for "${currentTabModule.meta?.id}"`, err);
    }
  }
  currentTabModule = tabModule;

  const ctx = { scope: resolved.scope, subview: resolved.subview, root: contentHost, live, data: state.data };
  try {
    tabModule.render(ctx);
  } catch (err) {
    console.error(`[shell] render() failed for "${tabModule.meta?.id}"`, err);
    contentHost.innerHTML = emptyState({ title: 'This panel hit a snag', message: String(err?.message || err), icon: '⚠️' });
  }
}

// ---- Navigation intents (all funnel through router.navigate so the URL stays canonical) -----

function goWorkspace(id) {
  const ws = WORKSPACES.find((w) => w.id === id);
  if (!ws) return;
  const firstTab = ws.tabs[0];
  router.navigate({ workspace: ws.id, tab: firstTab.meta.id, subview: firstTab.meta.subviews[0].id, scope: state.scope });
}

function goTab(tabId) {
  const ws = WORKSPACES.find((w) => w.id === state.workspace) || WORKSPACES[0];
  const tabModule = ws.tabs.find((t) => t.meta.id === tabId) || ws.tabs[0];
  router.navigate({ workspace: ws.id, tab: tabModule.meta.id, subview: tabModule.meta.subviews[0].id, scope: state.scope });
}

function goSubview(subviewId) {
  router.navigate({ workspace: state.workspace, tab: state.tab, subview: subviewId, scope: state.scope });
}

function goScope(scope) {
  router.navigate({ workspace: state.workspace, tab: state.tab, subview: state.subview, scope });
}

// ---- Small local dropdown used by the workspace switcher + the mobile sub-view picker -------
// (Not in ui/components.js because it's specifically about app navigation chrome, not a
// general-purpose primitive other tabs would reuse.)

function dropdownMenu({ key, kicker, valueLabel, items, activeId, onSelect }) {
  const html = `
    <div class="relative" data-dd="${escapeHtml(key)}">
      <button type="button" data-dd-trigger class="flex w-full items-center justify-between gap-2 rounded-2xl bg-white px-3.5 py-3 text-left shadow-sm ring-1 ring-slate-100 transition-colors hover:ring-slate-200">
        <span class="min-w-0">
          <span class="block truncate text-[11px] font-semibold uppercase tracking-wide text-slate-400">${escapeHtml(kicker)}</span>
          <span class="block truncate text-sm font-bold text-slate-900">${escapeHtml(valueLabel)}</span>
        </span>
        <svg data-dd-chevron class="h-4 w-4 shrink-0 text-slate-400 transition-transform duration-150" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="m5 8 5 5 5-5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <div data-dd-menu class="absolute left-0 right-0 z-30 mt-2 hidden max-h-80 overflow-y-auto rounded-2xl bg-white p-1.5 shadow-lg ring-1 ring-slate-100">
        ${items
          .map(
            (item) => `
          <button type="button" data-dd-id="${escapeHtml(item.id)}" class="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-semibold transition-colors ${
              item.id === activeId ? 'bg-teal-50 text-teal-700' : 'text-slate-600 hover:bg-slate-50'
            }">
            <span class="truncate">${escapeHtml(item.label)}</span>
            ${item.id === activeId ? '<span class="ml-auto shrink-0 text-teal-600">✓</span>' : ''}
          </button>`
          )
          .join('')}
      </div>
    </div>`;

  function wire(root) {
    const wrap = root.querySelector(`[data-dd="${key}"]`);
    if (!wrap) return () => {};
    const trigger = wrap.querySelector('[data-dd-trigger]');
    const menu = wrap.querySelector('[data-dd-menu]');
    const chevron = wrap.querySelector('[data-dd-chevron]');

    function toggle(open) {
      menu.classList.toggle('hidden', !open);
      chevron.style.transform = open ? 'rotate(180deg)' : '';
    }
    function onTriggerClick(e) {
      e.stopPropagation();
      toggle(menu.classList.contains('hidden'));
    }
    function onMenuClick(e) {
      const btn = e.target.closest('[data-dd-id]');
      if (!btn) return;
      toggle(false);
      onSelect(btn.dataset.ddId);
    }
    function onDocClick(e) {
      if (!wrap.contains(e.target)) toggle(false);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') toggle(false);
    }

    trigger.addEventListener('click', onTriggerClick);
    menu.addEventListener('click', onMenuClick);
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeydown);

    return () => {
      trigger.removeEventListener('click', onTriggerClick);
      menu.removeEventListener('click', onMenuClick);
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeydown);
    };
  }

  return { html, wire };
}

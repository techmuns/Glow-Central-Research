// ui/shell.js — the generic app chrome: header, workspace dropdown, top tabs, left rail,
// and the content host that every tab/portfolio module mounts into. This file owns the
// workspace/tab registry; individual tab modules stay ignorant of navigation entirely.

import { $, escapeHtml } from '../core/dom.js';
import { formatRelativeTime } from '../core/format.js';
import { state, setScope, setRoute, saveLastRoute } from '../core/state.js';
import * as router from '../core/router.js';
import * as live from '../core/live.js';
import { tabBar, railNav, segmentedToggle, searchInput, liveBadge, emptyState } from './components.js';
import { openModal, closeDrill, closeModal, closeWorkspace } from './screener.js';
import { sourcesModalHtml } from './sources.js';
import * as technicals from '../data/technicals.js';
import { openTechnicalsDrill } from '../tabs/breakouts-drill.js';

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
    <header class="mx-auto max-w-[1400px] px-6 pb-4 pt-8">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex flex-shrink-0 items-center gap-3">
          <div class="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 text-lg font-extrabold text-white shadow-lg">SC</div>
          <div class="min-w-0">
            <h1 class="font-display truncate text-2xl font-extrabold leading-tight text-slate-900">Sattva Central Research</h1>
            <p id="brand-subtitle" class="truncate text-sm text-slate-500">Research Central · Indian equities</p>
          </div>
        </div>

        <div id="search-mount" class="relative mx-auto w-full max-w-xl flex-1 sm:px-4"></div>

        <div class="flex flex-shrink-0 flex-wrap items-center gap-2 text-xs text-slate-500">
          <button id="sources-btn" type="button" title="See every data source this dashboard uses"
            class="flex items-center gap-1.5 rounded-full bg-white/70 px-3 py-1.5 ring-1 ring-slate-200 transition-colors hover:bg-indigo-50 hover:text-indigo-700 hover:ring-indigo-200">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>
            <span class="font-medium">Sources</span>
          </button>
          <div id="scope-toggle-mount"></div>
          <div id="live-badge-mount"></div>
          <div id="updated-chip-mount"></div>
        </div>
      </div>
    </header>

    <nav class="mx-auto max-w-[1400px] px-6">
      <div id="tabbar-mount"></div>
    </nav>

    <div class="mx-auto flex max-w-[1400px] flex-col gap-6 px-6 py-6 lg:flex-row">
      <aside class="lg:w-60 lg:flex-shrink-0">
        <div id="aside-content" class="lg:sticky lg:top-6"></div>
      </aside>
      <main class="fade-in min-w-0 flex-1">
        <div id="content-host"></div>
      </main>
    </div>`;
}

// ---- Header: parts that never change across route changes ----------------------------------

function wireStaticHeader(root) {
  const isMac = navigator.platform ? navigator.platform.toLowerCase().includes('mac') : false;
  const search = searchInput({
    placeholder: 'Search any company, theme or investor…',
    shortcutLabel: isMac ? '⌘K' : 'Ctrl K',
    options: buildSearchOptions(),
    onSelect: openCompanyTechnicals,
  });
  $('#search-mount', root).innerHTML = search.html;
  search.wire(root);

  const liveWidget = liveBadge({ label: 'Live', getTimestamp: () => live.getLastTick(), subscribeTick: live.onGlobalTick });
  $('#live-badge-mount', root).innerHTML = liveWidget.html;
  liveWidget.wire(root);

  $('#updated-chip-mount', root).innerHTML = updatedChipHtml();
  wireUpdatedChip(root, () => state.dataLoadedAt);

  $('#sources-btn', root).addEventListener('click', () => openModal(sourcesModalHtml(), { size: 'magazine' }));
}

// Selecting a search result opens that company's technicals drill from ANY tab. The feed is
// loaded lazily, so the first search before visiting Breakouts triggers the fetch; afterwards
// it resolves from cache. A ticker with no technicals row (scrape failure, or a portfolio name
// outside the NSE 500) still opens the panel, which states that plainly.
function openCompanyTechnicals(ticker) {
  technicals
    .load()
    .then(() => {
      const scored = technicals.byTicker(ticker);
      if (scored) return openTechnicalsDrill(scored);
      const known = (state.data?.universe || []).find((c) => c.ticker === ticker);
      openTechnicalsDrill({
        company: { ticker, name: known?.name || ticker, sector: known?.sector, screenerUrl: known?.screenerUrl },
        tickerError: 'No technicals row for this ticker in the latest scrape',
        breakdown: [],
        hardFails: [],
        totalPoints: 0,
        totalMax: 0,
        scorePct: 0,
      });
    })
    .catch((err) => console.error('[shell] could not open technicals for', ticker, err));
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
    <span class="hidden items-center gap-1 rounded-full bg-white/70 px-3 py-1.5 ring-1 ring-slate-200 lg:inline-flex" data-updated-chip>
      <span>Updated</span><span data-updated-time class="font-semibold tabular-nums text-slate-700">—</span>
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

  // Tab-owned filter params ride along in the query string so a filtered view is shareable.
  // The shell doesn't interpret them — it just preserves them across route changes.
  const resolved = { workspace: ws.id, tab: tabModule.meta.id, subview, scope, params: rawRoute.params || {} };

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

  // Rail is a single white card: workspace dropdown on top, sub-view list beneath a hairline.
  // A tab with no sub-views renders just the workspace dropdown — an empty sub-view box with a
  // heading and nothing under it reads as a loading failure rather than as "there is one view".
  const hasSubviews = subviewItems.length > 0;
  const asideEl = $('#aside-content', root);
  asideEl.innerHTML = `
    <div class="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
      <div class="p-2">${wsDropdown.html}</div>
      ${
        hasSubviews
          ? `<div class="hidden border-t border-slate-100 p-2 lg:block">
               <div class="px-2 pb-1.5 pt-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(tabModule.meta.title)}</div>
               ${rail.html}
             </div>
             <div class="border-t border-slate-100 p-2 lg:hidden">${mobileSubDropdown.html}</div>`
          : ''
      }
    </div>`;
  chromeDisposers.push(wsDropdown.wire(asideEl));
  // Only wire what was actually rendered: a tab with no sub-views has no rail and no mobile
  // dropdown in the DOM, and wiring them anyway throws on a null element and kills the mount.
  if (hasSubviews) {
    chromeDisposers.push(rail.wire(asideEl));
    chromeDisposers.push(mobileSubDropdown.wire(asideEl));
  }

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
  // A drill panel, modal or workspace opened on the previous view must never survive a route
  // change — it would be showing a row that is no longer on screen. `silent` because the URL
  // is already being rewritten by the navigation that triggered this; letting the overlay run
  // its own onClose would have it fight that write.
  closeDrill();
  closeModal();
  closeWorkspace({ silent: true });

  if (currentTabModule && currentTabModule !== tabModule) {
    try {
      currentTabModule.destroy?.();
    } catch (err) {
      console.error(`[shell] destroy() failed for "${currentTabModule.meta?.id}"`, err);
    }
  }
  currentTabModule = tabModule;

  const ctx = {
    scope: resolved.scope,
    subview: resolved.subview,
    root: contentHost,
    live,
    data: state.data,
    params: resolved.params || {},
    // Tabs call this to push their own filter state into the URL without touching routing.
    // history.replaceState does NOT fire hashchange, so the router would never see the new
    // params — we re-mount the tab body explicitly. Chrome doesn't depend on params, so only
    // the panel is rebuilt, and a chip click leaves no history entry to back out of.
    setParams(next) {
      const route = { workspace: state.workspace, tab: state.tab, subview: state.subview, scope: state.scope, params: next };
      router.replaceRoute(route);
      saveLastRoute(router.buildHash(route));
      mountTab(tabModule, route);
    },
    // Same URL write, but WITHOUT re-mounting the panel. For state that lives in an overlay
    // rather than in the page body: the Deep Dive mirrors its open company and internal tab
    // into the URL so the view is shareable and survives a reload, and re-mounting on every
    // internal tab click would tear down the very overlay doing the writing.
    setParamsQuiet(next) {
      const route = { workspace: state.workspace, tab: state.tab, subview: state.subview, scope: state.scope, params: next };
      router.replaceRoute(route);
      saveLastRoute(router.buildHash(route));
      ctx.params = next;
    },
  };
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
  router.navigate({ workspace: ws.id, tab: firstTab.meta.id, subview: firstTab.meta.subviews?.[0]?.id ?? null, scope: state.scope });
}

function goTab(tabId) {
  const ws = WORKSPACES.find((w) => w.id === state.workspace) || WORKSPACES[0];
  const tabModule = ws.tabs.find((t) => t.meta.id === tabId) || ws.tabs[0];
  router.navigate({ workspace: ws.id, tab: tabModule.meta.id, subview: tabModule.meta.subviews?.[0]?.id ?? null, scope: state.scope });
}

// Filter params belong to a specific sub-view, so switching sub-view (or tab, or workspace)
// clears them. Only a scope change keeps them — the same filters still make sense.
function goSubview(subviewId) {
  router.navigate({ workspace: state.workspace, tab: state.tab, subview: subviewId, scope: state.scope });
}

function goScope(scope) {
  router.navigate({ workspace: state.workspace, tab: state.tab, subview: state.subview, scope, params: router.parseHash().params });
}

// ---- Small local dropdown used by the workspace switcher + the mobile sub-view picker -------
// (Not in ui/components.js because it's specifically about app navigation chrome, not a
// general-purpose primitive other tabs would reuse.)

function dropdownMenu({ key, kicker, valueLabel, items, activeId, onSelect }) {
  const html = `
    <div class="relative" data-dd="${escapeHtml(key)}">
      <button type="button" data-dd-trigger class="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-slate-50">
        <span class="min-w-0">
          <span class="block truncate text-[11px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(kicker)}</span>
          <span class="block truncate text-sm font-bold text-slate-900">${escapeHtml(valueLabel)}</span>
        </span>
        <svg data-dd-chevron class="h-4 w-4 shrink-0 text-slate-400 transition-transform duration-150" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="m5 8 5 5 5-5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <div data-dd-menu class="scrollbar-thin absolute left-0 right-0 z-30 mt-1 hidden max-h-80 overflow-y-auto rounded-2xl bg-white p-1.5 shadow-lg ring-1 ring-slate-200">
        ${items
          .map(
            (item) => `
          <button type="button" data-dd-id="${escapeHtml(item.id)}" class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-semibold transition-colors ${
              item.id === activeId ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50'
            }">
            <span class="truncate">${escapeHtml(item.label)}</span>
            ${item.id === activeId ? '<span class="ml-auto shrink-0 text-indigo-600">✓</span>' : ''}
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

// Company selection and free-text search use one predicate for rows, counts and export.
// The existing Worker route owns the Muns credential and its static user_index contract.
import { escapeHtml as e } from '../core/dom.js';
import { searchCompanies } from '../data/stock-search.js';

const normal = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = value => normal(value).split(/\s+/).filter(Boolean);
let sequence = 0;

export function announcementSearch({ companies, companyKey, resolveCompany, allowsCompany,
  scopeLabel, searchable, q = '', state = { selected: null } }) {
  const id = `announcement-search-${++sequence}`;
  const known = new Map();
  const candidate = raw => {
    const company = resolveCompany(raw);
    const key = companyKey(company);
    return key ? { ...company, name: company.name || company.company || company.ticker,
      key, allowed: allowsCompany(company) } : null;
  };
  for (const raw of companies) {
    const key = companyKey(raw);
    if (!key || known.has(key)) continue;
    const item = candidate(raw);
    if (item && !known.has(item.key)) known.set(item.key, item);
  }
  const textByRow = new WeakMap();
  const prepare = row => {
    if (!textByRow.has(row)) textByRow.set(row, normal(searchable(row)));
    return textByRow.get(row);
  };
  let previousQuery, needle = '';
  const matches = (row, query) => {
    if (state.selected && companyKey(row) !== companyKey(state.selected)) return false;
    if (query !== previousQuery) { previousQuery = query; needle = normal(query); }
    if (!needle) return true;
    return prepare(row).includes(needle);
  };
  const chipHtml = () => state.selected ? `<div class="announcement-selected-company">
    <span class="announcement-selected-identity"><span class="announcement-company-name">${e(state.selected.name)}</span>
      <span class="announcement-company-symbol">${e(state.selected.ticker || state.selected.bseCode || '')}</span></span>
    <button type="button" data-announcement-company-clear aria-label="Clear selected company" title="Clear selected company">×</button></div>` : '';
  const hint = () => state.selected && !allowsCompany(state.selected)
    ? `This company is outside ${scopeLabel}. Switch scope or clear the company.`
    : state.selected ? 'Showing this company only. Period and filing-type filters still apply.' : '';
  const placeholder = () => state.selected ? 'Search within this company…' : 'Search company name, ticker or announcement…';
  const html = `<div data-announcement-search="${id}" class="min-w-0 flex-1" style="min-width:min(100%,220px);max-width:32rem">
    <div data-announcement-company-chip>${chipHtml()}</div>
    <div data-announcement-search-box>
      <input type="text" data-table-search role="combobox" aria-label="Search company name, ticker or announcement"
        aria-autocomplete="list" aria-expanded="false" aria-haspopup="listbox" aria-controls="${id}-list" aria-describedby="${id}-hint"
        autocomplete="off" maxlength="200" value="${e(q)}" placeholder="${e(placeholder())}"
        class="announcement-search-input">
    </div><p id="${id}-hint" data-announcement-search-hint role="status" class="mt-1 text-xs text-slate-500" ${hint() ? '' : 'hidden'}>${e(hint())}</p>
  </div>`;

  function wire(host, { onQuery }) {
    const root = host.querySelector(`[data-announcement-search="${id}"]`);
    const input = root.querySelector('[data-table-search]');
    const box = root.querySelector('[data-announcement-search-box]');
    const menu = document.createElement('div');
    menu.dataset.announcementSearchMenu = id;
    menu.hidden = true;
    menu.className = 'announcement-search-menu';
    menu.innerHTML = `<p data-search-status role="status" class="announcement-search-status"></p>
      <div id="${id}-list" role="listbox" aria-label="Matching companies"></div>
      <p class="announcement-search-help">Select a company to see its announcements, or keep typing to search announcement text.</p>`;
    document.body.append(menu);
    const list = menu.querySelector('[role="listbox"]');
    const status = menu.querySelector('[data-search-status]');
    let timer, controller, generation = 0, disposed = false, active = -1, shown = [], remote = [], message = '';
    let requestQuery = null;
    const cached = new Map();
    const cancel = () => { clearTimeout(timer); controller?.abort(); controller = null; generation++; requestQuery = null; };
    function close() {
      cancel(); menu.hidden = true; active = -1;
      input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
    }
    function place() {
      if (menu.hidden) return;
      const r = box.getBoundingClientRect();
      menu.style.width = `${Math.min(Math.max(r.width, 300), innerWidth - 16)}px`;
      const below = innerHeight - r.bottom - 16, above = r.top - 16;
      const upward = below < 250 && above > below;
      menu.style.maxHeight = `${Math.max(0, upward ? above : below)}px`;
      menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, upward ? r.top - menu.offsetHeight - 6 : r.bottom + 6)}px`;
    }
    function paint() {
      const parts = words(input.value);
      const all = new Map();
      for (const item of known.values()) {
        if (parts.every(word => normal(`${item.name} ${item.company || ''} ${item.ticker || ''} ${item.bseCode || ''}`).includes(word))) all.set(item.key, item);
      }
      for (const raw of remote) {
        if (!/^india$/i.test(raw.country || '') || raw.validTicker === false) continue;
        const item = candidate(raw);
        if (item && !all.has(item.key)) all.set(item.key, item);
      }
      shown = [...all.values()].sort((a, b) => Number(b.allowed) - Number(a.allowed)).slice(0, 20);
      active = -1; input.removeAttribute('aria-activedescendant');
      status.textContent = message || (shown.length ? 'Choose a company' : 'No matching company found. Your text still searches announcements.');
      list.innerHTML = shown.map((item, i) => `<button type="button" role="option" tabindex="-1" id="${id}-option-${i}"
        data-announcement-company="${i}" aria-selected="false" ${item.allowed ? '' : 'disabled aria-disabled="true"'}
        class="announcement-search-option">
        <span class="announcement-company-name">${e(item.name)}</span>
        <span class="announcement-company-symbol">${e(item.ticker || item.bseCode || '')}${item.allowed ? '' : ` · Outside ${e(scopeLabel)} — switch to Universe`}</span>
      </button>`).join('');
      place();
    }
    function show() {
      const query = input.value.trim();
      if (state.selected || query.length < 2) { close(); return; }
      menu.hidden = false; input.setAttribute('aria-expanded', 'true');
      if (requestQuery === query) { place(); return; }
      cancel(); requestQuery = query; remote = cached.get(query) || [];
      message = cached.has(query) ? '' : 'Searching companies…'; paint();
      if (cached.has(query)) return;
      const mine = generation;
      timer = setTimeout(async () => {
        controller = new AbortController();
        try {
          const found = await searchCompanies(query.slice(0, 80), {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
          });
          if (disposed || mine !== generation) return;
          remote = found; cached.set(query, found); message = ''; paint();
        } catch {
          if (disposed || mine !== generation) return;
          remote = []; message = 'Company search is unavailable. Showing saved matches; announcement text search still works.'; paint();
        }
      }, 250);
    }
    function select(item) {
      if (!item?.allowed) return;
      state.selected = item; input.value = ''; updateSelection(); close(); onQuery(''); input.focus();
    }
    function updateSelection() {
      root.querySelector('[data-announcement-company-chip]').innerHTML = chipHtml();
      input.placeholder = placeholder();
      const note = root.querySelector('[data-announcement-search-hint]');
      note.textContent = hint(); note.hidden = !note.textContent;
    }
    const onInput = () => { onQuery(input.value.trim().toLowerCase()); show(); };
    const onKey = event => {
      if (event.key === 'Escape') { close(); return; }
      if (event.key === 'Tab') { close(); return; }
      if (event.key === 'Enter' && !menu.hidden && active >= 0) { event.preventDefault(); select(shown[active]); return; }
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault(); show();
      const enabled = shown.map((item, i) => item.allowed ? i : -1).filter(i => i >= 0);
      if (!enabled.length) return;
      const index = enabled.indexOf(active), step = event.key === 'ArrowDown' ? 1 : -1;
      active = enabled[index < 0 ? (step > 0 ? 0 : enabled.length - 1) : (index + step + enabled.length) % enabled.length];
      list.querySelectorAll('[role="option"]').forEach((option, i) => {
        option.setAttribute('aria-selected', String(i === active));
      });
      input.setAttribute('aria-activedescendant', `${id}-option-${active}`);
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    };
    const onClear = event => {
      if (!event.target.closest('[data-announcement-company-clear]')) return;
      state.selected = null; input.value = ''; updateSelection(); close(); onQuery(''); input.focus();
    };
    const onOutside = event => { if (!root.contains(event.target) && !menu.contains(event.target)) close(); };
    const onBlur = event => { if (!menu.contains(event.relatedTarget) && !root.contains(event.relatedTarget)) close(); };
    menu.addEventListener('mousedown', event => event.preventDefault());
    menu.addEventListener('click', event => {
      const option = event.target.closest('[data-announcement-company]');
      if (option) select(shown[Number(option.dataset.announcementCompany)]);
    });
    root.addEventListener('click', onClear);
    input.addEventListener('input', onInput); input.addEventListener('focus', show); input.addEventListener('keydown', onKey); input.addEventListener('blur', onBlur);
    document.addEventListener('pointerdown', onOutside); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => {
      disposed = true; close(); menu.remove();
      root.removeEventListener('click', onClear);
      input.removeEventListener('input', onInput); input.removeEventListener('focus', show); input.removeEventListener('keydown', onKey); input.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerdown', onOutside); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
    };
  }
  return { html, wire, matches, prepare, state };
}

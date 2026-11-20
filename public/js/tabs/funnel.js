// tabs/funnel.js — THE SCREENING FUNNEL.
//
// LEFT: the funnel — a stage per cut (Universe → Market cap → Sector → Quantitative → Qualitative
// → Valuation), each a clickable bar showing how many companies survive it, with the editor for
// the selected stage beneath. RIGHT: one table of the selected stage's companies, every column.
//
// Nothing is hardcoded — every threshold is an editable default (see data/funnel.js). Counts move
// live as the desk edits. The qualitative stage reads the shared Framework scores; the quantitative
// and valuation stages read the Screener fundamentals snapshot (data/fundamentals.js).

import { sectionHead, scoreTable } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { TAB_META } from './catalog.js';
import * as fundamentals from '../data/funnel-fundamentals.js';
import { runFunnel, defaultConfig, STAGES, sectorCounts, missingDataCount } from '../data/funnel.js';
import { FUNDAMENTAL_METRICS, fmtMetric } from '../data/funnel-metrics.js';
import { loadFramework, record as frameworkRecord } from '../core/framework.js';
import { frameworkRows } from '../data/framework-rows.js';

export const meta = TAB_META.funnel;

const CFG_KEY = 'glow:funnel:config:v1';
const STAGE_KEY = 'glow:funnel:stage:v1';

let ctxRef = null;
let cfg = defaultConfig();
let selectedStage = 'valuation'; // default: the fully-screened list
let companies = [];
let fwMap = new Map();
let inflection = new Set();
let lastRes = null;
let tableView = null;
let tableOff = null;
let loaded = false;

// ---- device-remembered config -------------------------------------------------
function loadCfg() {
  try {
    const raw = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
    if (raw && typeof raw === 'object') return mergeCfg(defaultConfig(), raw);
  } catch {}
  return defaultConfig();
}
function mergeCfg(base, saved) {
  const out = { ...base, ...saved };
  out.marketCap = { ...base.marketCap, ...(saved.marketCap || {}) };
  out.qualitative = { ...base.qualitative, ...(saved.qualitative || {}) };
  out.excludeSectors = Array.isArray(saved.excludeSectors) ? saved.excludeSectors : base.excludeSectors;
  out.quant = Array.isArray(saved.quant) && saved.quant.length ? saved.quant : base.quant;
  out.valuation = Array.isArray(saved.valuation) && saved.valuation.length ? saved.valuation : base.valuation;
  out.match = saved.match === 'any' ? 'any' : 'all';
  return out;
}
function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch {} }
function saveStage() { try { localStorage.setItem(STAGE_KEY, selectedStage); } catch {} }

// ---- render -------------------------------------------------------------------
export function render(ctx) {
  ctxRef = ctx;
  cfg = loadCfg();
  try { const s = localStorage.getItem(STAGE_KEY); if (s && STAGES.some((x) => x.id === s)) selectedStage = s; } catch {}

  if (!loaded) {
    ctx.root.innerHTML = `${sectionHead({ title: meta.title, description: meta.subtitle })}
      <div class="p-10 text-center text-sm text-slate-500">Loading fundamentals…</div>`;
    Promise.all([fundamentals.load(), loadFramework().catch(() => null)]).then(([rows, fw]) => {
      companies = (rows || []).filter((c) => c && c.ticker);
      fwMap = buildFwMap(fw);
      loaded = true;
      if (ctxRef === ctx) paint();
    });
    return;
  }
  paint();
}

export function destroy() {
  tableOff?.();
  tableOff = null;
  ctxRef = null;
}

function buildFwMap(fw) {
  const map = new Map();
  try {
    if (!fw) return map;
    const rows = frameworkRows(fw, frameworkRecord());
    for (const r of rows || []) {
      const t = (r.ticker || '').toUpperCase();
      if (t) map.set(t, { total: r.total, gate: r.gate, scoredCount: r.scoredCount });
    }
  } catch {}
  return map;
}

// ---- the funnel paint ---------------------------------------------------------
function paint() {
  const ctx = ctxRef;
  if (!ctx) return;
  lastRes = runFunnel(companies, cfg, { framework: fwMap, inflection });
  const stageRows = lastRes.byStage[selectedStage] || lastRes.survivors;
  const cap = fundamentals.meta();

  const table = buildTable(stageRows);

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: meta.subtitle,
      meta: `<div class="text-xs text-slate-500 text-right">
        <div><span class="font-semibold text-slate-700">${lastRes.survivors.length}</span> companies pass the full funnel</div>
        <div>${companies.length} in the universe · fundamentals ${capNote(cap)}</div>
      </div>`,
    })}
    <div class="fnl-grid">
      <aside class="fnl-left">
        ${matchToggle()}
        <div class="fnl-stages">${lastRes.steps.map((s) => stageBar(s, lastRes)).join('')}</div>
        <div class="fnl-editor">${stageEditor(selectedStage, stageRows)}</div>
      </aside>
      <section class="fnl-right">
        <div class="fnl-right-head">
          <div><span class="fnl-right-stage">${escapeHtml(stageLabel(selectedStage))}</span>
            <span class="fnl-right-count">${stageRows.length} companies</span></div>
          ${cfg.keepInflection && selectedStage === 'quant' ? `<span class="fnl-rescue-note">${stageRows.filter((c) => c._rescued).length} kept at inflection</span>` : ''}
        </div>
        ${table.html}
      </section>
    </div>
  `;

  tableOff?.();
  tableView = table.view;
  tableOff = table.wire(ctx.root);
  wireLeft(ctx.root);
}

function capNote(cap) {
  if (!cap || !cap.capturedAt) return 'snapshot';
  const d = new Date(cap.capturedAt);
  if (Number.isNaN(d.getTime())) return 'snapshot';
  return `captured ${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
}

function stageLabel(id) { return (STAGES.find((s) => s.id === id) || {}).label || id; }

function matchToggle() {
  const on = (v) => (cfg.match === v ? ' fnl-chip-on' : '');
  return `<div class="fnl-matchbar">
    <span class="fnl-matchlabel">Combine criteria by</span>
    <div class="fnl-chipgroup" role="group" aria-label="Combine criteria">
      <button type="button" class="fnl-chip${on('all')}" data-fnl-match="all">Match ALL</button>
      <button type="button" class="fnl-chip${on('any')}" data-fnl-match="any">Match ANY</button>
    </div>
    <button type="button" class="fnl-reset" data-fnl-reset>Reset</button>
  </div>`;
}

function stageBar(step, res) {
  const base = res.steps[0].after || 1;
  const pct = Math.max(2, Math.round((step.after / base) * 100));
  const active = step.id === selectedStage ? ' fnl-bar-active' : '';
  const removed = step.removed > 0 ? `<span class="fnl-bar-removed">−${step.removed}</span>` : '';
  return `<button type="button" class="fnl-bar${active}" data-fnl-stage="${step.id}" aria-pressed="${step.id === selectedStage}">
    <span class="fnl-bar-top"><span class="fnl-bar-label">${escapeHtml(step.label)}</span>
      <span class="fnl-bar-count" data-fnl-count="${step.id}">${step.after}</span></span>
    <span class="fnl-bar-track"><span class="fnl-bar-fill" data-fnl-fill="${step.id}" style="width:${pct}%"></span></span>
    <span class="fnl-bar-foot">${removed}</span>
  </button>`;
}

// ---- stage editors ------------------------------------------------------------
function stageEditor(id, stageRows) {
  if (id === 'universe') return `<p class="fnl-help">The screenable universe: ${companies.length} companies with Screener fundamentals. Narrow it with the stages below — every threshold is editable.</p>`;
  if (id === 'marketCap') return marketCapEditor();
  if (id === 'sector') return sectorEditor();
  if (id === 'quant') return criteriaEditor('quant', 'Quantitative screen', stageRows);
  if (id === 'qualitative') return qualitativeEditor();
  if (id === 'valuation') return criteriaEditor('valuation', 'Valuation screen', stageRows);
  return '';
}

function marketCapEditor() {
  const mc = cfg.marketCap;
  return `<div class="fnl-ed">
    <div class="fnl-ed-head"><h4>Market cap band</h4>
      <label class="fnl-toggle"><input type="checkbox" data-fnl-mc-enable ${mc.enabled ? 'checked' : ''}><span>On</span></label></div>
    <p class="fnl-help">The client's universe is ₹1,000–25,000 Cr. Change it freely.</p>
    <div class="fnl-range">
      <label>Min (Cr)<input type="number" inputmode="numeric" data-fnl-mc-min value="${mc.min ?? ''}" placeholder="no min"></label>
      <span class="fnl-range-dash">—</span>
      <label>Max (Cr)<input type="number" inputmode="numeric" data-fnl-mc-max value="${mc.max ?? ''}" placeholder="no max"></label>
    </div>
    <div class="fnl-presets">
      <button type="button" class="fnl-preset" data-fnl-mc-preset="1000,25000">1k–25k</button>
      <button type="button" class="fnl-preset" data-fnl-mc-preset="500,5000">500–5k</button>
      <button type="button" class="fnl-preset" data-fnl-mc-preset="25000,">25k+</button>
      <button type="button" class="fnl-preset" data-fnl-mc-preset=",">All</button>
    </div>
  </div>`;
}

function sectorEditor() {
  const counts = sectorCounts(companies);
  const excluded = new Set(cfg.excludeSectors);
  return `<div class="fnl-ed">
    <div class="fnl-ed-head"><h4>Exclude sectors</h4>
      <span class="fnl-ed-note">${excluded.size} excluded</span></div>
    <p class="fnl-help">Tick a sector to drop it (commodity, AI-at-risk, hard-to-cover).</p>
    <div class="fnl-sectors">
      ${counts.map((s) => `<label class="fnl-sector"><input type="checkbox" data-fnl-sector="${escapeHtml(s.sector)}" ${excluded.has(s.sector) ? 'checked' : ''}><span>${escapeHtml(s.sector)}</span><em>${s.count}</em></label>`).join('')}
    </div>
  </div>`;
}

function criteriaEditor(which, title, stageRows) {
  const list = cfg[which] || [];
  const missing = missingDataCount(stageRows, list);
  const rows = list.map((f, i) => critRow(which, f, i)).join('');
  const inflectionRow = which === 'quant'
    ? `<label class="fnl-toggle fnl-inflection"><input type="checkbox" data-fnl-keepinflection ${cfg.keepInflection ? 'checked' : ''}><span>Keep companies at an inflection point (recent capex / new-product announcements) even if they fail these — <em>${inflection.size} flagged</em></span></label>`
    : '';
  return `<div class="fnl-ed">
    <div class="fnl-ed-head"><h4>${escapeHtml(title)}</h4>
      <span class="fnl-ed-note">matched by <strong>${cfg.match === 'any' ? 'ANY' : 'ALL'}</strong></span></div>
    <div class="fnl-crits">${rows}</div>
    <button type="button" class="fnl-add" data-fnl-add="${which}">+ Add criterion</button>
    ${missing > 0 ? `<p class="fnl-help fnl-missing">${missing} of these companies have no data for the enabled criteria and are dropped — never counted as a pass.</p>` : ''}
    ${inflectionRow}
  </div>`;
}

function critRow(which, f, i) {
  const opts = FUNDAMENTAL_METRICS.map((m) => `<option value="${m.key}" ${m.key === f.metric ? 'selected' : ''}>${escapeHtml(m.label)}</option>`).join('');
  const mode = (v, lbl) => `<option value="${v}" ${f.mode === v ? 'selected' : ''}>${lbl}</option>`;
  const showMin = f.mode === 'gte' || f.mode === 'between';
  const showMax = f.mode === 'lte' || f.mode === 'between';
  return `<div class="fnl-crit" data-fnl-crit="${which}" data-fnl-idx="${i}">
    <label class="fnl-crit-on"><input type="checkbox" data-fnl-field="enabled" ${f.enabled ? 'checked' : ''}></label>
    <select class="fnl-crit-metric" data-fnl-field="metric" aria-label="Metric">${opts}</select>
    <select class="fnl-crit-mode" data-fnl-field="mode" aria-label="Comparison">${mode('gte', '≥')}${mode('lte', '≤')}${mode('between', 'between')}</select>
    <input class="fnl-crit-min ${showMin ? '' : 'fnl-hidden'}" type="number" inputmode="decimal" data-fnl-field="min" value="${f.min ?? ''}" placeholder="min" aria-label="Minimum">
    ${f.mode === 'between' ? '<span class="fnl-range-dash">–</span>' : ''}
    <input class="fnl-crit-max ${showMax ? '' : 'fnl-hidden'}" type="number" inputmode="decimal" data-fnl-field="max" value="${f.max ?? ''}" placeholder="max" aria-label="Maximum">
    <button type="button" class="fnl-crit-del" data-fnl-del="${which}:${i}" aria-label="Remove criterion">×</button>
  </div>`;
}

function qualitativeEditor() {
  const q = cfg.qualitative;
  const scored = [...fwMap.values()].filter((v) => v.scoredCount > 0 || v.gate).length;
  return `<div class="fnl-ed">
    <div class="fnl-ed-head"><h4>Qualitative — the Framework</h4>
      <label class="fnl-toggle"><input type="checkbox" data-fnl-qual-enable ${q.enabled ? 'checked' : ''}><span>On</span></label></div>
    <p class="fnl-help">Reads the shared Framework scores. ${scored} of ${companies.length} companies are scored so far — turning this on screens only the scored ones. Score more on the <strong>Framework</strong> tab.</p>
    <label class="fnl-toggle"><input type="checkbox" data-fnl-qual-gov ${q.requireGovPass ? 'checked' : ''}><span>Require governance not to be a Fail</span></label>
    <label class="fnl-range-single">Minimum total (out of 10)
      <input type="number" inputmode="numeric" data-fnl-qual-min value="${q.minTotal ?? ''}" min="0" max="10" placeholder="0"></label>
  </div>`;
}

// ---- the table ----------------------------------------------------------------
function buildTable(stageRows) {
  const col = (label, key, fmt) => ({
    label, align: 'right', html: true,
    get: (r) => cell(r[key], fmt),
    sortValue: (r) => (typeof r[key] === 'number' ? r[key] : -Infinity),
  });
  return scoreTable({
    rows: stageRows,
    key: (r) => r.ticker,
    watchKey: (r) => r.ticker,
    name: (r) => r.name || r.ticker,
    sub: (r) => `${r.ticker}${r.sector ? ' · ' + r.sector : ''}`,
    nameLabel: 'Company',
    searchable: (r) => `${r.name || ''} ${r.ticker || ''} ${r.sector || ''} ${r.broadSector || ''}`,
    showRank: false,
    showAvatar: false,
    dense: true,
    wrapHeads: true,
    columns: [
      col('Mkt cap', 'marketCapCr', 'cr'),
      col('ROCE', 'roce', 'pct'),
      col('ROE', 'roe', 'pct'),
      col('Sales 3Y', 'salesGrowth3y', 'pct'),
      col('Profit 3Y', 'profitVar3y', 'pct'),
      col('D/E', 'debtToEquity', 'x'),
      col('Cash conv', 'cashConversionPct', 'pct'),
      col('P/E', 'pe', 'x'),
      col('P/B', 'pb', 'x'),
      col('Div Y', 'divYieldPct', 'pct'),
      { label: 'FW', align: 'right', html: true, get: (r) => fwCell(r.ticker), sortValue: (r) => { const f = fwMap.get((r.ticker || '').toUpperCase()); return f && f.scoredCount ? f.total : -1; } },
    ],
    initialView: tableView || null,
    initialSort: { key: 'Mkt cap', dir: 'desc' },
    exportName: `glow-funnel-${stageLabel(selectedStage).toLowerCase().replace(/\W+/g, '-')}`,
  });
}

function cell(v, fmt) {
  if (v == null) return '<span class="text-slate-300">—</span>';
  const txt = fmt === 'cr' ? fmtMetric('marketCapCr', v)
    : fmt === 'pct' ? `${v}%`
    : fmt === 'x' ? `${v}×`
    : String(v);
  return `<span>${escapeHtml(txt)}</span>`;
}

function fwCell(ticker) {
  const f = fwMap.get((ticker || '').toUpperCase());
  if (!f || (!f.scoredCount && !f.gate)) return '<span class="text-slate-300">—</span>';
  if (f.gate === 'fail') return '<span class="fnl-fw fnl-fw-fail" title="Governance fail">gov ✕</span>';
  const cls = f.total >= 7 ? 'fnl-fw-hi' : f.total >= 4 ? 'fnl-fw-mid' : 'fnl-fw-lo';
  return `<span class="fnl-fw ${cls}">${f.total}/10</span>`;
}

// ---- wiring -------------------------------------------------------------------
function wireLeft(root) {
  const left = root.querySelector('.fnl-left');
  if (!left) return;

  // Stage selection (click a bar).
  left.querySelectorAll('[data-fnl-stage]').forEach((b) => b.addEventListener('click', () => {
    selectedStage = b.dataset.fnlStage; saveStage(); paint();
  }));

  // Match ALL/ANY + Reset.
  left.querySelectorAll('[data-fnl-match]').forEach((b) => b.addEventListener('click', () => {
    cfg.match = b.dataset.fnlMatch; saveCfg(); paint();
  }));
  left.querySelector('[data-fnl-reset]')?.addEventListener('click', () => {
    cfg = defaultConfig(); saveCfg(); paint();
  });

  // Market cap.
  left.querySelector('[data-fnl-mc-enable]')?.addEventListener('change', (e) => { cfg.marketCap.enabled = e.target.checked; saveCfg(); paint(); });
  const mcMin = left.querySelector('[data-fnl-mc-min]');
  const mcMax = left.querySelector('[data-fnl-mc-max]');
  mcMin?.addEventListener('input', () => { cfg.marketCap.min = numOrNull(mcMin.value); saveCfg(); liveUpdate(); });
  mcMax?.addEventListener('input', () => { cfg.marketCap.max = numOrNull(mcMax.value); saveCfg(); liveUpdate(); });
  left.querySelectorAll('[data-fnl-mc-preset]').forEach((b) => b.addEventListener('click', () => {
    const [mn, mx] = b.dataset.fnlMcPreset.split(',');
    cfg.marketCap.min = mn === '' ? null : Number(mn);
    cfg.marketCap.max = mx === '' ? null : Number(mx);
    cfg.marketCap.enabled = true; saveCfg(); paint();
  }));

  // Sector exclude.
  left.querySelectorAll('[data-fnl-sector]').forEach((c) => c.addEventListener('change', () => {
    const s = c.dataset.fnlSector;
    const set = new Set(cfg.excludeSectors);
    if (c.checked) set.add(s); else set.delete(s);
    cfg.excludeSectors = [...set]; saveCfg(); paint();
  }));

  // Quantitative / Valuation criteria.
  left.querySelectorAll('[data-fnl-crit]').forEach((rowEl) => {
    const which = rowEl.dataset.fnlCrit;
    const idx = Number(rowEl.dataset.fnlIdx);
    rowEl.querySelectorAll('[data-fnl-field]').forEach((inp) => {
      const field = inp.dataset.fnlField;
      const ev = (field === 'min' || field === 'max') ? 'input' : 'change';
      inp.addEventListener(ev, () => {
        const f = cfg[which][idx]; if (!f) return;
        if (field === 'enabled') f.enabled = inp.checked;
        else if (field === 'metric') f.metric = inp.value;
        else if (field === 'mode') f.mode = inp.value;
        else if (field === 'min') f.min = numOrNull(inp.value);
        else if (field === 'max') f.max = numOrNull(inp.value);
        saveCfg();
        if (ev === 'input') liveUpdate(); else paint();
      });
    });
  });
  left.querySelectorAll('[data-fnl-del]').forEach((b) => b.addEventListener('click', () => {
    const [which, i] = b.dataset.fnlDel.split(':');
    cfg[which].splice(Number(i), 1); saveCfg(); paint();
  }));
  left.querySelectorAll('[data-fnl-add]').forEach((b) => b.addEventListener('click', () => {
    const which = b.dataset.fnlAdd;
    cfg[which].push({ metric: 'roe', mode: 'gte', min: null, max: null, enabled: true });
    saveCfg(); paint();
  }));
  left.querySelector('[data-fnl-keepinflection]')?.addEventListener('change', (e) => { cfg.keepInflection = e.target.checked; saveCfg(); paint(); });

  // Qualitative.
  left.querySelector('[data-fnl-qual-enable]')?.addEventListener('change', (e) => { cfg.qualitative.enabled = e.target.checked; saveCfg(); paint(); });
  left.querySelector('[data-fnl-qual-gov]')?.addEventListener('change', (e) => { cfg.qualitative.requireGovPass = e.target.checked; saveCfg(); paint(); });
  const qMin = left.querySelector('[data-fnl-qual-min]');
  qMin?.addEventListener('input', () => { cfg.qualitative.minTotal = numOrNull(qMin.value); saveCfg(); liveUpdate(); });
}

// Recompute and update counts + table in place (keeps text-input focus).
function liveUpdate() {
  const ctx = ctxRef;
  if (!ctx) return;
  lastRes = runFunnel(companies, cfg, { framework: fwMap, inflection });
  const base = lastRes.steps[0].after || 1;
  for (const step of lastRes.steps) {
    const c = ctx.root.querySelector(`[data-fnl-count="${step.id}"]`);
    if (c) c.textContent = step.after;
    const f = ctx.root.querySelector(`[data-fnl-fill="${step.id}"]`);
    if (f) f.style.width = `${Math.max(2, Math.round((step.after / base) * 100))}%`;
  }
  const stageRows = lastRes.byStage[selectedStage] || lastRes.survivors;
  const host = ctx.root.querySelector('.fnl-right');
  if (host) {
    const table = buildTable(stageRows);
    host.innerHTML = `<div class="fnl-right-head">
      <div><span class="fnl-right-stage">${escapeHtml(stageLabel(selectedStage))}</span>
        <span class="fnl-right-count">${stageRows.length} companies</span></div>
    </div>${table.html}`;
    tableOff?.();
    tableView = table.view;
    tableOff = table.wire(ctx.root);
  }
}

function numOrNull(v) {
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

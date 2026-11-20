// tabs/framework.js — THE DESK'S SCORING FRAMEWORK. GLOW-OWNED.
//
// Every company in the tracked universe, scored on the desk's own rubric: five criteria at 0/1/2 with
// a one-line rationale each, plus a Governance Pass/Fail GATE. The rubric and the company list are
// DATA (public/data/framework.json, built from the workbook by scripts/build-framework.mjs); the
// scores are typed by the desk and SHARED across it (core/framework.js → /api/framework), exactly
// like the Portfolio/Watchlist research sheet. Nothing is scored here automatically and no maximum
// is hardcoded — the Total is out of (criteria × 2), read from the rubric.
//
// The table is the overview — search, sort by any criterion or the Total, export. Scoring happens in
// the drill, with each criterion's 0/1/2 definition in front of the reader, because a score is only
// meaningful read against its rubric. A missing score is "not yet", never a zero.

import { TAB_META } from './catalog.js';
import { sectionHead, scoreTable, openModal, pendingPanel } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { revalidatedJson } from '../core/store.js';
import { loadFramework, editFramework, refreshFramework, record } from '../core/framework.js';
import { frameworkRows, rankRows, rubricOf, maxScore } from '../data/framework-rows.js';

export const meta = TAB_META.framework;

let framework = null; // framework.json (rubric + company list)
let table = null;
let ctxRef = null;
let loadError = false;

const shortLabel = (label) => escapeHtml(String(label || '').replace('Catalyst/infelction', 'Catalyst').replace('Earnings materiality', 'Earnings').replace('Business quality', 'Business').replace('Growth runway', 'Growth'));

const scorePill = (v) =>
  v === null || v === undefined
    ? '<span class="fw-pill fw-pill-none" title="Not scored yet">—</span>'
    : `<span class="fw-pill fw-pill-${v}">${v}</span>`;

const gateBadge = (gate) =>
  gate === 'pass' ? '<span class="fw-gate fw-gate-pass">Pass</span>'
    : gate === 'fail' ? '<span class="fw-gate fw-gate-fail">Fail</span>'
      : '<span class="fw-pill fw-pill-none" title="Governance not judged yet">—</span>';

function buildRows() {
  return rankRows(frameworkRows(framework, record()));
}

function scopeMeta() {
  const rec = record();
  const rows = framework ? framework.companies.length : 0;
  const scored = buildRows().filter((r) => r.scoredCount > 0 || r.gate).length;
  const originWord = { live: 'Shared · up to date', store: 'Shared · saved copy', local: 'This device only (not yet shared)', empty: 'No scores yet' }[rec.origin] || '';
  return `<span class="fw-meta-pill" title="Market-wide worksheet; the scope toggle does not apply.">${rows} companies · ${scored} scored · ${escapeHtml(originWord)}</span>`;
}

export function render(ctx) {
  ctxRef = ctx;
  if (loadError) {
    ctx.root.innerHTML = sectionHead({ title: 'Framework', description: meta.subtitle })
      + pendingPanel({ title: 'Framework worksheet unavailable', body: 'The framework rubric and company list could not be read. It is a committed data file; a refresh usually recovers it.' });
    return;
  }
  if (!framework) {
    ctx.root.innerHTML = sectionHead({ title: 'Framework', description: meta.subtitle })
      + pendingPanel({ title: 'Loading the framework…', body: 'Reading the rubric and the company list.', arriving: 'reading' });
    Promise.all([
      revalidatedJson('data/framework.json').then((d) => { framework = d; }).catch(() => { loadError = true; }),
      loadFramework().catch(() => {}),
    ]).then(() => { if (ctxRef === ctx) render(ctx); });
    return;
  }

  const criteria = framework.criteria || [];
  const rows = buildRows();
  const columns = [
    { label: '#', get: (r) => (r.rank == null ? '—' : String(r.rank)), align: 'right', sortable: true, sortValue: (r) => (r.rank == null ? 1e9 : r.rank) },
    ...criteria.map((crit) => ({
      label: shortLabel(crit.label), html: true, align: 'center', sortable: true,
      get: (r) => scorePill(r.scores[crit.key]),
      sortValue: (r) => (r.scores[crit.key] == null ? -1 : r.scores[crit.key]),
    })),
    { label: 'Gov', get: (r) => gateBadge(r.gate), html: true, align: 'center', sortable: true, sortValue: (r) => (r.gate === 'fail' ? 0 : r.gate === 'pass' ? 2 : 1) },
    { label: 'Total', html: true, align: 'right', sortable: true, sortValue: (r) => (r.scoredCount ? r.total : -1), get: (r) => (r.scoredCount === 0 ? '<span class="fw-pill fw-pill-none" title="Not scored yet">—</span>' : `<strong>${r.total}</strong><span class="fw-dim">/${r.max}</span>${r.scoredCount < criteria.length ? `<span class="fw-dim" title="${r.scoredCount} of ${criteria.length} criteria scored"> (${r.scoredCount}/${criteria.length})</span>` : ''}`) },
  ];

  table = scoreTable({
    rows,
    key: (r) => r.key,
    watchKey: () => null, // a scoring worksheet, not a watchlist
    name: (r) => r.name,
    nameLabel: 'Company',
    nameAfter: 1, // the # column leads, then the company
    sub: (r) => (r.ticker ? r.ticker : (r.reason ? 'no NSE symbol in the feeds' : '')),
    showRank: false,
    showAvatar: false,
    wrapHeads: true,
    dense: true,
    columns,
    onRowClick: (r) => openScoreDrill(r.key),
    rowActionLabel: () => 'Score this company',
    countNoun: 'company',
    exportName: 'glow-framework',
    emptyMessage: 'No companies in the framework yet.',
    initialView: table ? table.view : null,
    stickyHead: 'max(320px, calc(100vh - 300px))',
  });

  ctx.root.innerHTML = `
    ${sectionHead({ title: 'Framework', description: meta.subtitle, meta: scopeMeta() })}
    <div class="fw-howto">Click a company to score it against the rubric. Total is out of ${criteria.length * 2}; a Governance <em>Fail</em> sorts last. Scores are shared with the desk.</div>
    ${table.html}
  `;
  table.wire(ctx.root);
}

// The scoring drill: the rubric in full, with a 0/1/2 control and a rationale per criterion, the
// gate, and the typed text columns. Every control writes through the shared store at once.
function openScoreDrill(key) {
  const company = (framework.companies || []).find((c) => c.key === key);
  if (!company) return;
  const criteria = rubricOf(framework);
  const rec = record();
  const val = (field) => rec.valueFor(key, field);

  const scoreButtons = (field, current) => [0, 1, 2].map((n) =>
    `<button type="button" class="fw-score-btn${current === n ? ' fw-score-btn-on' : ''}" data-fw-score data-fw-field="${escapeHtml(field)}" data-fw-value="${n}" aria-pressed="${current === n}">${n}</button>`).join('');

  const criterionBlock = (crit) => {
    const sv = val(`score:${crit.key}`);
    const why = val(`why:${crit.key}`) || '';
    const levels = (crit.levels || []).map((lvl, i) => `<li class="fw-level${sv === i ? ' fw-level-on' : ''}">${escapeHtml(lvl)}</li>`).join('');
    return `<section class="fw-crit">
      <div class="fw-crit-head"><h4>${escapeHtml(crit.label)}</h4><div class="fw-score-group" role="group" aria-label="${escapeHtml(crit.label)} score">${scoreButtons(`score:${crit.key}`, Number.isInteger(sv) ? sv : null)}<button type="button" class="fw-score-clear" data-fw-clear data-fw-field="score:${escapeHtml(crit.key)}" title="Clear this score">clear</button></div></div>
      ${crit.question ? `<p class="fw-crit-q">${escapeHtml(crit.question)}</p>` : ''}
      <ul class="fw-levels">${levels}</ul>
      <textarea class="fw-why" data-fw-text data-fw-field="why:${escapeHtml(crit.key)}" rows="2" maxlength="600" placeholder="Rationale (optional) — why this score?">${escapeHtml(why)}</textarea>
    </section>`;
  };

  const gate = val('gate');
  const html = `<div class="fw-drill" data-fw-key="${escapeHtml(key)}">
    <header class="fw-drill-head">
      <h3>${escapeHtml(company.name)}</h3>
      <p>${company.ticker ? escapeHtml(company.ticker) : 'No NSE symbol in the feeds this dashboard carries'}</p>
    </header>
    <label class="fw-field"><span>Industry</span><input type="text" data-fw-text data-fw-field="industry" maxlength="120" value="${escapeHtml(val('industry') || '')}" placeholder="e.g. Diagnostics"></label>
    <label class="fw-field"><span>What the company does</span><textarea data-fw-text data-fw-field="summary" rows="2" maxlength="400" placeholder="Products / revenue segments">${escapeHtml(val('summary') || '')}</textarea></label>
    ${criteria.map(criterionBlock).join('')}
    <section class="fw-crit fw-gate-block">
      <div class="fw-crit-head"><h4>Governance <span class="fw-dim">(gate)</span></h4>
        <div class="fw-score-group" role="group" aria-label="Governance gate">
          <button type="button" class="fw-gate-btn fw-gate-btn-pass${gate === 'pass' ? ' fw-gate-on' : ''}" data-fw-gate data-fw-value="pass" aria-pressed="${gate === 'pass'}">Pass</button>
          <button type="button" class="fw-gate-btn fw-gate-btn-fail${gate === 'fail' ? ' fw-gate-on' : ''}" data-fw-gate data-fw-value="fail" aria-pressed="${gate === 'fail'}">Fail</button>
          <button type="button" class="fw-score-clear" data-fw-clear data-fw-field="gate" title="Clear the gate">clear</button>
        </div>
      </div>
      <p class="fw-crit-q">A Governance fail disqualifies the company whatever its criterion total.</p>
    </section>
    <label class="fw-field"><span>Note</span><textarea data-fw-text data-fw-field="note" rows="2" maxlength="600" placeholder="Anything else worth recording">${escapeHtml(val('note') || '')}</textarea></label>
    <p class="fw-drill-foot" data-fw-status></p>
  </div>`;

  let dirty = false;
  openModal(html, { size: 'wide', onClose: () => { if (dirty && ctxRef) render(ctxRef); } });
  const el = document.querySelector('.fw-drill');
  if (!el) return;
  const status = el.querySelector('[data-fw-status]');
  const say = (msg) => { if (status) status.textContent = msg; };

  const send = async (intent) => {
    dirty = true;
    const ok = await editFramework([intent]);
    say(ok ? 'Saved to the shared sheet.' : 'Kept on this device — will sync when the shared sheet is reachable.');
  };

  el.querySelectorAll('[data-fw-score]').forEach((btn) => btn.addEventListener('click', () => {
    const field = btn.dataset.fwField; const value = Number(btn.dataset.fwValue);
    el.querySelectorAll(`[data-fw-score][data-fw-field="${CSS.escape(field)}"]`).forEach((b) => {
      const on = Number(b.dataset.fwValue) === value; b.classList.toggle('fw-score-btn-on', on); b.setAttribute('aria-pressed', String(on));
    });
    // light up the matching rubric level
    const block = btn.closest('.fw-crit');
    block?.querySelectorAll('.fw-level').forEach((li, i) => li.classList.toggle('fw-level-on', i === value));
    send({ op: 'set', key, field, value });
  }));

  el.querySelectorAll('[data-fw-gate]').forEach((btn) => btn.addEventListener('click', () => {
    const value = btn.dataset.fwValue;
    el.querySelectorAll('[data-fw-gate]').forEach((b) => { const on = b.dataset.fwValue === value; b.classList.toggle('fw-gate-on', on); b.setAttribute('aria-pressed', String(on)); });
    send({ op: 'set', key, field: 'gate', value });
  }));

  el.querySelectorAll('[data-fw-clear]').forEach((btn) => btn.addEventListener('click', () => {
    const field = btn.dataset.fwField;
    if (field.startsWith('score:')) { const b = btn.closest('.fw-crit'); b?.querySelectorAll('[data-fw-score]').forEach((x) => { x.classList.remove('fw-score-btn-on'); x.setAttribute('aria-pressed', 'false'); }); b?.querySelectorAll('.fw-level').forEach((li) => li.classList.remove('fw-level-on')); }
    if (field === 'gate') el.querySelectorAll('[data-fw-gate]').forEach((x) => { x.classList.remove('fw-gate-on'); x.setAttribute('aria-pressed', 'false'); });
    send({ op: 'clear', key, field });
  }));

  // Text fields save on blur (and on Enter for the single-line input), so a half-typed word is not
  // sent on every keystroke. An empty value clears the field rather than storing a blank.
  el.querySelectorAll('[data-fw-text]').forEach((input) => {
    const commit = () => {
      const field = input.dataset.fwField; const value = input.value.trim();
      send(value ? { op: 'set', key, field, value } : { op: 'clear', key, field });
    };
    input.addEventListener('blur', commit);
    if (input.tagName === 'INPUT') input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  });
}

export function destroy() {
  ctxRef = null;
  table = null;
}

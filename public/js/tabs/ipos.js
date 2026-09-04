import { escapeHtml as e } from '../core/dom.js';
import { createIpoFeed } from '../data/ipo-monitor.js';
import { buildIpoRows, matchesIpo, weeklyIpoStats, scoreIpo, validateScoring, numeric, filingEvent, ipoStory, sourceLinks, IPO_REPOSITORY } from '../data/ipo-monitor-shared.js';
import { documentUrl } from '../data/combined-filings-shared.js';
import { mountDrhpDocuments } from '../ui/drhp-documents.js';
import { openModal, closeModal } from '../ui/screener.js';
import * as marketNews from '../data/market-news.js';
import * as twitterNews from '../data/twitter-news.js';

export const meta = { id: 'ipos', title: 'IPOs', allowEmptyScope: true, subviews: [] };
let dispose = null;
const money = (v) => numeric(v) == null ? '—' : v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
const label = (s) => String(s).replace(/_/g, ' ');
const link = (name, value) => { const url = documentUrl(value); return url ? `<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(name)} ↗</a>` : ''; };
const chip = (value, muted = false) => `<span class="ipo-chip${muted ? ' muted' : ''}">${e(value)}</span>`;
const dataStatus = (row) => { const n = ['rev_growth_pct', 'ebitda_margin_pct', 'pat_growth_pct', 'pat_margin_pct'].filter((k) => numeric(row.financials?.[k]?.value) != null).length; return n === 0 ? 'Awaiting financials' : n === 4 ? 'Complete (4 metrics)' : 'Partial'; };
const metric = (value, suffix = '') => numeric(value) == null ? '—' : `${money(value)}${suffix}`;

export function render(ctx) {
  dispose?.();
  const feed = createIpoFeed();
  let controller = new AbortController(), dead = false, generation = 0, documentDispose = null;
  let tracked = [], rows = [], config = null, customConfig = false, newsReady = false, trackedUnavailable = false;
  const state = { mode: ['weekly', 'tracker', 'news', 'documents'].includes(ctx.params?.view) ? ctx.params.view : 'weekly', q: ctx.params?.company || '', stage: '', lifecycle: '', board: '', sector: '', type: '', from: '', to: '', metrics: false, order: 'date' };
  if (state.q && state.mode === 'weekly') state.mode = 'tracker';
  ctx.root.innerHTML = `<link rel="stylesheet" href="css/ipo-monitor.css"><div class="ipo-board" data-ipo-board>
    <div class="ipo-head"><div><h2>IPOs · India primary issuance</h2><p class="ipo-meta">Weekly monitor and full captured tracker from your DRHP dashboard.</p></div>
      <div class="ipo-actions"><button data-ipo-refresh>Check for updates</button><button data-ipo-settings>Scoring settings</button></div></div>
    <p class="ipo-meta">All issuers, including unlisted companies. Portfolio / Watchlist scope does not filter this tab.</p>
    <p class="ipo-note" data-ipo-freshness role="status">Reading published IPO data…</p>
    <div class="ipo-modes">${[['weekly', 'Weekly Monitor'], ['tracker', 'Full Tracker'], ['news', 'News & X'], ['documents', 'Company documents']].map(([key, title]) => `<button data-ipo-mode="${key}" aria-pressed="${state.mode === key}">${title}</button>`).join('')}</div>
    <div data-ipo-view></div><p class="ipo-foot">${link('Source repository', IPO_REPOSITORY)} · Scores are research-priority calculations, not buy/sell advice. Missing values stay unknown. Captured coverage is not a complete IPO universe.</p></div>`;
  const root = ctx.root.querySelector('[data-ipo-board]'), view = root.querySelector('[data-ipo-view]');
  const say = (value) => { root.querySelector('[data-ipo-freshness]').textContent = value; };
  function rebuild() { rows = buildIpoRows([...feed.state.snapshots.values()], tracked); }
  function freshness() {
    const s = feed.state, b = s.bundle;
    if (!b) return;
    const days = Math.max(0, Math.floor((Date.now() - Date.parse(b.latest.meta.data_as_of)) / 86400000));
    say(`${s.fallback ? 'Bundled capture' : 'Published snapshot'} · data as of ${b.latest.meta.data_as_of} (${days} days old) · week ${b.latest.meta.week_start} – ${b.latest.meta.week_end}. ${b.checkedAt ? `Source checked ${new Date(b.checkedAt).toLocaleTimeString('en-IN')}. ` : ''}The source pipeline publishes weekly, not continuously.${s.error ? ` ${s.error}` : ''}${!b.historyAvailable ? ' History index unavailable; older coverage may be incomplete.' : ''}${!config ? ' Scoring model unavailable.' : ''}${customConfig ? ' Scores use a local preview model.' : ''}`);
    if (trackedUnavailable) root.querySelector('[data-ipo-freshness]').append(' Tracked-issuer supplement unavailable; EAAA coverage may be missing.');
  }
  function filtered() {
    return rows.filter((row) => matchesIpo(row, state.q) && (!state.lifecycle || row.lifecycle === state.lifecycle) && (!state.stage || row.stage === state.stage) && (!state.board || row.board === state.board) && (!state.sector || row.sector === state.sector) && (!state.type || row.filingType === state.type) && (!state.from || row.filingDate >= state.from) && (!state.to || (row.filingDate && row.filingDate <= state.to)))
      .sort((a, b) => state.order === 'name' ? a.name.localeCompare(b.name) : state.order === 'score' ? (scoreIpo(b.financials, config).total ?? -1) - (scoreIpo(a.financials, config).total ?? -1) : (b.activityDate || '').localeCompare(a.activityDate || ''));
  }
  function rowMarkup(row, weekly = false) {
    const score = scoreIpo(row.financials, config), idx = rows.indexOf(row);
    return `<tr data-ipo-row><td><button class="ipo-company" data-ipo-detail="${idx}" aria-expanded="false">${e(row.name)}</button>${row.tracked ? `<p>${chip('Tracked issuer')}</p>` : ''}<p class="ipo-meta">${e(row.symbol || '')}</p></td>
      ${weekly ? `<td>${chip(filingEvent(row.filing || {}))}</td>` : `<td>${chip(row.lifecycle)}</td>`}
      <td>${e(row.filingType || '—')}<p class="ipo-meta">${e(row.filingDate || 'Date not supplied')}</p></td>
      <td>${chip(row.stage)}<p class="ipo-meta">As of ${e(row.stageAsOf || 'unknown')}</p></td>
      <td>${e(row.sector || 'Unclassified')}<p class="ipo-meta">${e(row.board || '')}</p></td>
      ${!weekly ? `<td class="ipo-numeric">${metric(row.market?.issue_size_cr ?? row.filing?.issue?.total_cr, ' Cr')}<p class="ipo-meta">Open ${e(row.market?.issue_open || '—')}<br>Close ${e(row.market?.issue_close || '—')}<br>Listing ${e(row.market?.listing_date || '—')}</p></td>` : ''}
      ${state.metrics ? ['rev_growth_pct', 'ebitda_margin_pct', 'pat_growth_pct', 'pat_margin_pct'].map((k) => `<td class="ipo-numeric">${metric(row.financials?.[k]?.value, '%')}</td>`).join('') : ''}
      <td><button data-ipo-score="${idx}" title="Score breakdown">${metric(score.total)}</button></td><td>${chip(score.bucket === 'INSUFFICIENT' ? 'AWAITING DATA' : score.bucket, score.total == null)}</td><td>${chip(dataStatus(row), score.total == null)}</td>
      <td>${sourceLinks(row).slice(0, 2).map((s) => link(s.label, s.url)).join('<br>')}<p><button data-ipo-documents="${idx}">Documents</button></p></td></tr>`;
  }
  function tableMarkup(display, weekly = false) {
    const headings = ['Company', weekly ? 'Weekly event' : 'Lifecycle', 'Filing / date', 'Reported stage', 'Sector / board', ...(!weekly ? ['Issue / timetable'] : []), ...(state.metrics ? ['Rev growth', 'EBITDA margin', 'PAT growth', 'PAT margin'] : []), 'Score', 'Research priority', 'Data status', 'Source / action'];
    return `<div class="ipo-table-wrap"><table><thead><tr>${headings.map((s) => `<th>${s}</th>`).join('')}</tr></thead><tbody>${display.length ? display.map((r) => rowMarkup(r, weekly)).join('') : `<tr><td colspan="${headings.length}" class="ipo-empty">No captured records match these filters. This is not proof that no IPO or filing exists.</td></tr>`}</tbody></table></div>`;
  }
  function wireTable() {
    view.querySelectorAll('[data-ipo-detail]').forEach((button) => button.addEventListener('click', () => {
      const parent = button.closest('tr'), open = button.getAttribute('aria-expanded') === 'true';
      if (open) { parent.nextElementSibling?.remove(); button.setAttribute('aria-expanded', 'false'); return; }
      button.setAttribute('aria-expanded', 'true');
      parent.insertAdjacentHTML('afterend', `<tr class="ipo-detail-row"><td colspan="${parent.children.length}">${detail(rows[Number(button.dataset.ipoDetail)])}</td></tr>`);
    }));
    view.querySelectorAll('[data-ipo-score]').forEach((button) => button.addEventListener('click', () => showScore(rows[Number(button.dataset.ipoScore)])));
    view.querySelectorAll('[data-ipo-documents]').forEach((button) => button.addEventListener('click', () => { state.q = rows[Number(button.dataset.ipoDocuments)].name; state.mode = 'documents'; draw(); }));
  }
  function detail(row) {
    const f = row.filing || {}, m = row.market || {}, issue = f.issue || {};
    const kv = (object) => `<dl>${Object.entries(object).map(([k, v]) => `<dt>${e(label(k))}</dt><dd>${v == null || v === '' ? '—' : e(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('')}</dl>`;
    return `<div class="ipo-detail"><h3>${e(row.name)}</h3>${row.tracked ? `<p class="ipo-note">${e(row.tracked.note)} Checked ${e(row.tracked.checked_at)}. ${Object.entries(row.tracked.sources).map(([k, v]) => link(label(k), v)).join(' · ')}</p>` : ''}
      <div class="ipo-detail-grid"><section><h3>Business & issue</h3><p>${e(f.business_summary || 'Business summary not supplied.')}</p>${kv(issue)}<p>Lead managers: ${e(f.lead_managers?.join(', ') || 'Not supplied')}</p></section>
      <section><h3>Market observation</h3><p class="ipo-meta">${row.market ? `Reported by the source snapshot as of ${e(row.marketAsOf)}; not a live confirmation.` : 'No exchange market observation supplied. The stage below describes the filing evidence only.'}</p>${kv({ stage: row.stage, symbol: row.symbol, open: m.issue_open, close: m.issue_close, listing: m.listing_date, price_band: m.price_band, subscription_x: m.subscription_x, issue_price: m.issue_price, current_price: m.current_price, gain_pct: m.gain_pct })}</section></div>
      <h3>Filing history · ${row.history.length} captured records</h3><div class="ipo-table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Source</th></tr></thead><tbody>${row.history.map((h) => `<tr><td>${e(h.filing_date || '—')}</td><td>${e(h.filing_type || '—')}</td><td>${sourceLinks({ sources: h.sources }).map((s) => link(s.label, s.url)).join(' · ') || 'Not supplied'}</td></tr>`).join('')}</tbody></table></div>
      <h3>Financials · original fiscal-year labels and provenance</h3><div class="ipo-table-wrap"><table><thead><tr><th>Metric</th><th>Value</th><th>Source</th><th>Confidence</th></tr></thead><tbody>${Object.entries(row.financials).map(([k, mv]) => `<tr><td>${e(label(k))}</td><td>${metric(mv?.value)}</td><td>${e(mv?.source || 'Not supplied')}</td><td>${e(mv?.confidence || 'Not supplied')}${mv?.confidence === 'low' || mv?.source === 'WEB' ? ' · Verify' : ''}</td></tr>`).join('') || '<tr><td colspan="4">Financials not supplied. No score inferred.</td></tr>'}</tbody></table></div>
      <details><summary>Secondary Groww data, conflicts & further research fields</summary><p>Secondary values remain separate from official filing values. Missing risk factors, competitor impact and sector KPIs are not generated.</p><pre>${e(JSON.stringify({ groww: row.groww || null, conflicts: [...feed.state.snapshots.values()].flatMap((s) => s.groww_conflicts || []).filter((c) => matchesIpo(row, c.company)), risk_factors: f.risk_factors ?? null, competitor_impact: f.competitor_impact ?? null, sector_kpis: f.sector_kpis ?? null }, null, 2))}</pre></details>
      <details><summary>Original source filing / market record</summary><pre>${e(JSON.stringify({ filing: f, filing_history: row.history, market: row.market || null }, null, 2))}</pre></details></div>`;
  }
  function showScore(row) {
    const score = scoreIpo(row.financials, config);
    openModal(`<div class="ipo-board"><button data-modal-close aria-label="Close score breakdown">Close</button><h2>${e(row.name)} · score</h2><p>${metric(score.total)} / 100 · ${e(score.bucket)} · input coverage ${score.coverage}/100. ${customConfig ? 'Local preview' : 'Repository model'} v${e(config?.version || 'unavailable')}.</p><p>Unprovided inputs are excluded, never replaced with zero.</p><div class="ipo-table-wrap"><table><thead><tr><th>Metric</th><th>Input</th><th>Points</th><th>Rule</th></tr></thead><tbody>${score.components.map((p) => `<tr><td>${e(p.label)}</td><td>${metric(p.value, p.unit)}</td><td>${metric(p.points)} / ${p.weight}</td><td>Linear ${p.floor} → ${p.saturation}</td></tr>`).join('')}</tbody></table></div></div>`);
  }
  function tracker() {
    const opts = (key, name, values) => `<label>${name}<select data-ipo-filter="${key}"><option value="">All</option>${[...new Set(values.filter(Boolean))].sort().map((s) => `<option${state[key] === s ? ' selected' : ''} value="${e(s)}">${e(s)}</option>`).join('')}</select></label>`;
    view.innerHTML = `<h3>Full Tracker · current & historical captures</h3><p class="ipo-meta" data-ipo-history></p>
      <div class="ipo-controls"><label class="ipo-query">Company / ticker<input type="search" data-ipo-search placeholder="Search company, ticker or alias…" value="${e(state.q)}"></label>${opts('stage', 'Stage', rows.map((r) => r.stage))}${opts('board', 'Board', rows.map((r) => r.board))}${opts('sector', 'Sector', rows.map((r) => r.sector))}${opts('type', 'Filing type', rows.map((r) => r.filingType))}
      <label>From<input type="date" data-ipo-filter="from" value="${e(state.from)}"></label><label>To<input type="date" data-ipo-filter="to" value="${e(state.to)}"></label>
      <label>Sort<select data-ipo-filter="order">${[['date', 'Latest activity'], ['name', 'Company'], ['score', 'Score']].map(([v, t]) => `<option value="${v}"${state.order === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <label><span>Review metrics</span><input data-ipo-metrics type="checkbox"${state.metrics ? ' checked' : ''}></label><button data-ipo-reset>Reset</button></div>
      <div class="ipo-facets" data-ipo-facets></div><div class="ipo-actions"><button data-ipo-export>Export CSV</button><button data-ipo-print>Print / PDF</button><button data-ipo-history-load>Load / retry older captures</button></div><p class="ipo-meta" data-ipo-count></p><div data-ipo-table></div>`;
    view.querySelector('[data-ipo-search]').addEventListener('input', (event) => { state.q = event.target.value; trackerRows(); });
    view.querySelectorAll('[data-ipo-filter]').forEach((input) => input.addEventListener('change', () => { state[input.dataset.ipoFilter] = input.value; trackerRows(); }));
    view.querySelector('[data-ipo-metrics]').addEventListener('change', (event) => { state.metrics = event.target.checked; trackerRows(); });
    view.querySelector('[data-ipo-reset]').addEventListener('click', () => { Object.assign(state, { q: '', stage: '', lifecycle: '', board: '', sector: '', type: '', from: '', to: '', order: 'date' }); tracker(); });
    view.querySelector('[data-ipo-export]').addEventListener('click', () => exportCsv(filtered()));
    view.querySelector('[data-ipo-print]').addEventListener('click', () => window.print());
    view.querySelector('[data-ipo-history-load]').addEventListener('click', () => void history());
    trackerRows();
  }
  function trackerRows() {
    const displayed = filtered();
    for (const key of ['stage', 'board', 'sector', 'type']) {
      const select = view.querySelector(`[data-ipo-filter="${key}"]`);
      const values = [...new Set(rows.map((r) => r[key === 'type' ? 'filingType' : key]).filter(Boolean))].sort();
      select.innerHTML = '<option value="">All</option>' + values.map((v) => `<option value="${e(v)}">${e(v)}</option>`).join('');
      select.value = state[key];
    }
    view.querySelector('[data-ipo-history]').textContent = `${feed.state.snapshots.size} of ${feed.state.bundle.historyDates.length || '?'} published snapshots loaded. ${feed.state.failedDates.size ? `${feed.state.failedDates.size} failed: retry available. ` : ''}${feed.state.localDates.size ? `${feed.state.localDates.size} use bundled copies. ` : ''}Older observations retain their own as-of dates.`;
    view.querySelector('[data-ipo-count]').textContent = `${displayed.length} of ${rows.length} issuers shown · all imported snapshot records remain available in expanded history.`;
    view.querySelector('[data-ipo-facets]').innerHTML = ['', 'Pre-IPO', 'IPO market', 'Listed / inactive'].map((s) => `<button data-ipo-life="${s}" aria-pressed="${state.lifecycle === s}">${s || 'All'} · ${rows.filter((r) => matchesIpo(r, state.q) && (!s || r.lifecycle === s)).length}</button>`).join('');
    view.querySelectorAll('[data-ipo-life]').forEach((b) => b.addEventListener('click', () => { state.lifecycle = b.dataset.ipoLife; trackerRows(); }));
    view.querySelector('[data-ipo-table]').innerHTML = tableMarkup(displayed); wireTable();
  }
  async function history() {
    const button = view.querySelector('[data-ipo-history-load]'); if (button?.disabled) return;
    if (button) button.disabled = true;
    const mine = generation;
    await feed.loadHistory(controller.signal);
    if (dead || mine !== generation) return;
    rebuild();
    if (state.mode === 'tracker') { trackerRows(); const next = view.querySelector('[data-ipo-history-load]'); if (next) next.disabled = false; }
  }
  function weekly() {
    const current = feed.state.bundle.latest, stats = weeklyIpoStats(current, config);
    const prev = feed.state.snapshots.get(current.meta.previous_snapshot_id), prior = prev ? weeklyIpoStats(prev, config) : null;
    const weeklyNames = new Set(current.filings.map((f) => f.company_name));
    // Weekly observations must not be replaced by a later supplementary filing or older NSE row.
    const weeklyRows = buildIpoRows([current]).filter((r) => weeklyNames.has(r.name));
    for (const row of weeklyRows) if (!rows.includes(row)) rows.push(row);
    view.innerHTML = `<h3>Week ending ${e(current.meta.week_end)} · filing monitor</h3><div class="ipo-cards">${[['drhp', 'New DRHPs'], ['prospectus', 'New prospectuses'], ['updated', 'Updated / corrected'], ['dig', 'Dig deeper']].map(([k, title]) => `<div class="ipo-card"><strong>${stats[k]}</strong><span>${title}</span><br><small>${prior ? `${stats[k] - prior[k] >= 0 ? '+' : ''}${stats[k] - prior[k]} vs prior captured week` : 'Prior comparable count unavailable'}</small></div>`).join('')}</div>
      ${tableMarkup(weeklyRows, true)}<p class="ipo-note">Prospectus filed ≠ confirmed listing. Market stages are shown only with their source observation date.</p>
      <div class="ipo-detail-grid"><section><h3>Sector concentration</h3>${(current.summary?.sector_concentration || []).map((s) => `<p>${e(s.sector)} · ${e(s.count)} filings</p>`).join('')}</section><section><h3>Coverage</h3><p>${current.filings.length} filing records. ${current.ipo_market?.available ? 'NSE market observations supplied.' : 'NSE market layer unavailable.'}</p><p>Older filings and tracked issuers such as EAAA are in Full Tracker, not added to this week’s counts.</p><button data-ipo-open-tracker>Open Full Tracker</button></section></div>`;
    view.querySelector('[data-ipo-open-tracker]').addEventListener('click', () => { state.mode = 'tracker'; draw(); void history(); }); wireTable();
  }
  function newsView() {
    const xm = twitterNews.meta();
    const stories = [...marketNews.rows().map((r) => ({ ...r, feed: 'News' })), ...twitterNews.rows().map((r) => ({ ...r, feed: 'X' }))];
    const renderStories = () => {
      const query = state.q.trim().toLowerCase();
      const selected = stories.filter((r) => ipoStory(r) && (!query || `${r.title || ''} ${r.summary || ''}`.toLowerCase().includes(query))).sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
      view.querySelector('[data-ipo-stories]').innerHTML = selected.map((r) => `<article class="ipo-story">${chip(r.feed)} <span class="ipo-meta">${e(r.publisher || r.displayName || r.handle || '')} · ${e(r.publishedAt || 'Time not supplied')}</span><p>${link(r.title, r.url)}</p></article>`).join('') || '<p class="ipo-empty">No matching items in the loaded captures. This does not mean there is no IPO news or X discussion.</p>';
    };
    view.innerHTML = `<h3>IPO news & X · separate evidence streams</h3><p class="ipo-note${!xm.capturedAt || xm.failed ? ' ipo-warning' : ''}">X: ${!xm.capturedAt ? 'No successful capture yet. Customer-reported buzz cannot be verified from this feed.' : `Capture ${e(xm.capturedAt)} · ${xm.failed} handles failed. Only monitored handles are covered; this is not all of X.`}</p><p class="ipo-meta">News capture: ${e(marketNews.meta().capturedAt || 'not available')}. This view filters existing captures; opening it does not start a scraper.</p><div class="ipo-controls"><label class="ipo-query">Company / topic<input data-ipo-news-query type="search" placeholder="EAAA, company name or IPO topic" value="${e(state.q)}"></label></div><div class="ipo-stories" data-ipo-stories></div>`;
    view.querySelector('[data-ipo-news-query]').addEventListener('input', (event) => { state.q = event.target.value; renderStories(); }); renderStories();
  }
  async function draw() {
    documentDispose?.(); documentDispose = null;
    root.querySelectorAll('[data-ipo-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ipoMode === state.mode)));
    if (state.mode === 'documents') { documentDispose = mountDrhpDocuments({ root: view }); view.querySelector('[data-drhp-company]').value = state.q; return; }
    if (!feed.state.bundle) { view.innerHTML = '<p class="ipo-empty">Reading captured IPO data…</p>'; return; }
    rebuild();
    if (state.mode === 'weekly') weekly();
    else if (state.mode === 'tracker') tracker();
    else {
      if (!newsReady) { view.innerHTML = '<p class="ipo-empty">Reading news and X captures…</p>'; await Promise.allSettled([marketNews.load(), twitterNews.load()]); if (dead || state.mode !== 'news') return; newsReady = true; }
      newsView();
    }
  }
  async function load() {
    generation++; controller.abort(); controller = new AbortController(); const mine = generation;
    root.querySelector('[data-ipo-refresh]').disabled = true;
    try {
      await feed.load(AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]));
      if (dead || mine !== generation) return;
      if (!customConfig) config = feed.state.bundle.config;
      freshness(); await draw();
      const previous = feed.state.bundle.latest.meta.previous_snapshot_id;
      if (state.mode === 'tracker') await history();
      else if (previous) { await feed.loadHistory(controller.signal, 1); if (!dead && mine === generation && state.mode === 'weekly') { rebuild(); weekly(); } }
    } catch { if (!dead && mine === generation) say('IPO data could not be read, including the bundled capture. Retry; this is not an empty IPO market.'); }
    finally { if (!dead && mine === generation) root.querySelector('[data-ipo-refresh]').disabled = false; }
  }
  function settings() {
    if (!config) return;
    const draft = structuredClone(config);
    openModal(`<div class="ipo-board"><button data-modal-close aria-label="Close scoring settings">Close</button><h2>Scoring settings</h2><p>Based on your DRHP dashboard’s model v${e(config.version)}. Changes are local previews for this tab session; no repository or shared model is published.</p><form data-ipo-score-settings><div class="ipo-score-form">${Object.entries(draft.components).map(([k, p]) => ['weight', 'floor', 'saturation'].map((field) => `<label>${e(p.label)} · ${field}<input type="number" step="any" required data-component="${e(k)}" data-field="${field}" value="${p[field]}"></label>`).join('')).join('')}<label>Minimum coverage<input type="number" required data-config="min_coverage_weight" value="${draft.min_coverage_weight}"></label><label>Dig deeper threshold<input type="number" required data-threshold="dig_deeper_min" value="${draft.thresholds.dig_deeper_min}"></label><label>Monitor threshold<input type="number" required data-threshold="monitor_min" value="${draft.thresholds.monitor_min}"></label></div><p data-score-error role="status"></p><div class="ipo-actions"><button type="submit" class="ipo-primary">Apply local preview</button><button type="button" data-score-reset>Restore repository model</button></div></form></div>`);
    const form = document.querySelector('[data-ipo-score-settings]');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      form.querySelectorAll('[data-component]').forEach((input) => { draft.components[input.dataset.component][input.dataset.field] = input.value === '' ? null : Number(input.value); });
      form.querySelectorAll('[data-config]').forEach((input) => { draft[input.dataset.config] = Number(input.value); });
      form.querySelectorAll('[data-threshold]').forEach((input) => { draft.thresholds[input.dataset.threshold] = Number(input.value); });
      try { validateScoring(draft); config = draft; customConfig = true; closeModal(); freshness(); void draw(); }
      catch { form.querySelector('[data-score-error]').textContent = 'Weights must total 100; bounds, thresholds and coverage must be valid.'; }
    });
    form.querySelector('[data-score-reset]').addEventListener('click', () => { config = feed.state.bundle.config; customConfig = false; closeModal(); freshness(); void draw(); });
  }
  function exportCsv(display) {
    const escapeCell = (v) => { const text = String(v ?? ''); return `"${(/^[=+@\-\t\r]/.test(text) ? "'" : '') + text.replace(/"/g, '""')}"`; };
    const lines = [['Company', 'Lifecycle', 'Reported stage', 'Stage as of', 'Filing type', 'Filing date', 'Board', 'Sector', 'Issue size Cr', 'Score', 'Research priority', 'Data status', 'History count', 'Source URLs'], ...display.map((r) => [r.name, r.lifecycle, r.stage, r.stageAsOf, r.filingType, r.filingDate, r.board, r.sector, r.market?.issue_size_cr ?? r.filing?.issue?.total_cr, scoreIpo(r.financials, config).total, scoreIpo(r.financials, config).bucket, dataStatus(r), r.history.length, sourceLinks(r).map((s) => s.url).join(' ')])];
    const blob = new Blob(['\ufeff', lines.map((line) => line.map(escapeCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `sattva-ipo-tracker-${feed.state.bundle.latest.meta.data_as_of}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  root.querySelectorAll('[data-ipo-mode]').forEach((b) => b.addEventListener('click', () => { state.mode = b.dataset.ipoMode; void draw(); if (state.mode === 'tracker' && feed.state.bundle) void history(); }));
  root.querySelector('[data-ipo-refresh]').addEventListener('click', () => void load());
  root.querySelector('[data-ipo-settings]').addEventListener('click', settings);
  root.querySelector('[data-ipo-refresh]').disabled = true;
  const trackedPromise = fetch('data/ipo-tracked-issuers.json', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) }).then((r) => { if (!r.ok) throw new Error('Supplement unavailable'); return r.json(); }).then((d) => { if (!Array.isArray(d?.issuers)) throw new Error('Invalid supplement'); if (!dead) tracked = d.issuers; }).catch(() => { trackedUnavailable = true; });
  void trackedPromise.then(() => { if (!dead) void load(); });
  dispose = () => { dead = true; generation++; controller.abort(); documentDispose?.(); closeModal(); };
}
export function destroy() { dispose?.(); dispose = null; }

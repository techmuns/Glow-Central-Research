import { escapeHtml as esc } from '../core/dom.js';
import * as primary from '../data/public-holdings.js';
import { exportRows } from '../ui/export.js';
const number = (n) => typeof n === 'number' ? n.toLocaleString('en-IN', { maximumFractionDigits: 4 }) : '—';
const labels = { agrees: 'Agrees with source', 'stake-difference': 'Percentage differs', 'associated-entity': 'Associated entity', 'off-cycle-disclosure': 'Later dated filing', 'additional-disclosure': 'Additional exchange evidence' };
export function publicDisclosuresHtml(id, kind = 'investor', compact = false) {
  const all = primary.forPerson(id, kind), rows = compact ? all.filter((h) => h.state !== 'historical-disclosure').slice(0, 8) : all;
  const report = primary.report();
  if (!report) return `<section data-public-disclosures><p class="my-3 text-sm text-slate-500">Exchange disclosures are temporarily unavailable.</p></section>`;
  return `<section class="mb-4 rounded-xl bg-slate-50 p-3 text-sm" data-public-disclosures>
    <div class="flex items-center justify-between gap-3"><h3 class="font-semibold">Exchange disclosures${compact ? '' : ` · ${all.length}`}</h3>${!compact && all.length ? '<button data-public-export class="text-xs font-semibold underline">Export evidence</button>' : ''}</div>
    <p class="mt-1 text-xs text-slate-500">Original NSE / BSE filings. The holder and date apply to each row. Fund disclosures remain separate from personal or account holdings.</p>
    ${Date.now() - Date.parse(report.captureCheckedAt) > 30 * 3600000 ? '<p class="mt-2 text-xs text-amber-800">Exchange capture is overdue; dated evidence is retained.</p>' : ''}
    ${primary.lastError() ? '<p class="mt-2 text-xs text-amber-800">Latest check failed; retained evidence is shown.</p>' : ''}
    ${!compact ? '<label class="mt-3 block text-xs">Find a company or holder <input data-public-search aria-label="Search exchange disclosures" class="ml-2 rounded-lg border border-slate-200 bg-white px-2 py-1"></label>' : ''}
    ${rows.length ? `<div class="mt-3 overflow-auto" style="max-height:${compact ? '260' : '460'}px"><table class="w-full text-left text-xs"><thead><tr><th scope="col" class="p-2">Company / legal holder</th><th scope="col" class="p-2">As of</th><th scope="col" class="p-2">Shares</th><th scope="col" class="p-2">Stake</th><th scope="col" class="p-2">Evidence / check</th></tr></thead><tbody>
    ${rows.map((h) => `<tr data-public-row class="border-t border-slate-200"><td class="p-2"><strong>${esc(h.company)}</strong><br>${esc(h.legalHolder)}<br><span class="text-slate-500">${esc(h.isin)}${h.relationshipUrl && h.associated ? ` · <a class="underline" href="${esc(h.relationshipUrl)}" target="_blank" rel="noopener noreferrer">Relationship ↗</a>` : ''}</span></td>
      <td class="whitespace-nowrap p-2">${esc(h.asOf)}${h.state === 'historical-disclosure' ? '<br><span class="text-slate-500">Historical disclosure</span>' : ''}</td>
      <td class="p-2">${h.state === 'source-conflict' ? 'Conflicting reports' : number(h.shares)}</td><td class="p-2">${h.state === 'source-conflict' ? 'Review evidence' : `${number(h.stakePct)}%`}</td>
      <td class="p-2">${h.sources.map((s) => `<a class="underline" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.source.toUpperCase())} ↗</a> <span title="Named holder ${esc(s.legalHolder || h.legalHolder)}; filing received ${esc(s.filedAt)}; source checked ${esc(s.checkedAt)}${s.identityNote ? `; ${esc(s.identityNote)}` : ''}">checked ${esc(s.checkedAt.slice(0,10))}</span>${s.refreshError ? ' · latest read failed' : s.partial ? ' · filing has unresolved rows' : ''}${h.state === 'source-conflict' ? ` · ${number(s.shares)} shares / ${number(s.stakePct)}%` : ''}`).join('<br>')}<br>${esc(h.state === 'source-conflict' ? 'Exchange figures disagree' : labels[h.comparison] || '')}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="mt-3 text-xs text-slate-500">No attributed holdings in the filings captured so far.</p>'}
    ${compact && all.length > rows.length ? '<p class="mt-2 text-xs text-slate-500">Open Exchange disclosures for all dated records and source checks.</p>' : ''}
    </section>`;
}
function bindControls(host, id, kind) {
  host.querySelector('[data-public-search]')?.addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase(); host.querySelectorAll('[data-public-row]').forEach((row) => { row.hidden = !row.textContent.toLowerCase().includes(query); });
  });
  host.querySelector('[data-public-export]')?.addEventListener('click', () => {
    const rows = primary.forPerson(id, kind).flatMap((h) => h.sources.map((s) => ({ Investor: h.person, 'Legal holder': s.legalHolder || h.legalHolder, Company: h.company, ISIN: h.isin,
      'Holding date': h.asOf, Shares: s.shares, 'Stake %': s.stakePct, 'Record status': h.state, Comparison: labels[h.comparison], Exchange: s.source,
      'Filing received': s.filedAt, 'Source checked': s.checkedAt, 'Filing URL': s.url, 'Relationship URL': h.relationshipUrl || '', 'Identifier note': s.identityNote || '', 'Filing exception': s.refreshError || (s.partial ? 'Some filing rows are unresolved' : ''), 'File SHA256': s.sha256 })));
    exportRows({ rows, columns: Object.keys(rows[0] || {}).map((key) => ({ key, header: key, get: (r) => r[key] })), filename: `exchange-holdings-${id}`, sheetName: 'Exchange disclosures' });
  });
}

export function wirePublicDisclosures(host, id, kind = 'investor', compact = false) {
  let section = host.querySelector('[data-public-disclosures]');
  if (!section) return;
  bindControls(section, id, kind);
  const stop = primary.onChange(() => {
    if (!section.isConnected) { stop(); observer.disconnect(); return; }
    const input = section.querySelector('[data-public-search]'), query = input?.value || '', focused = input === document.activeElement;
    const scroll = section.querySelector('.overflow-auto')?.scrollTop || 0;
    const wrapper = document.createElement('div'); wrapper.innerHTML = publicDisclosuresHtml(id, kind, compact);
    const next = wrapper.firstElementChild; section.replaceWith(next); section = next;
    bindControls(section, id, kind);
    const replacement = section.querySelector('[data-public-search]');
    if (replacement) { replacement.value = query; replacement.dispatchEvent(new Event('input')); if (focused) replacement.focus(); }
    const table = section.querySelector('.overflow-auto'); if (table) table.scrollTop = scroll;
    const badge = host.closest('#workspace-content')?.querySelector('[data-ws-tab="exchange"] .tabular-nums');
    if (badge) badge.textContent = primary.forPerson(id, kind).length;
  });
  const observer = new MutationObserver(() => { if (!section.isConnected) { stop(); observer.disconnect(); } });
  observer.observe(host.parentElement || host, { childList: true, subtree: true });
}

import { escapeHtml as esc } from '../core/dom.js';
import * as investors from '../data/super-investors.js';
import * as managers from '../data/managers.js';
import { insider } from '../data/filings.js';
import { assessCoverage } from '../data/holdings-integrity.js';
import { loadEvidence, evidence, evidenceFor } from '../data/holding-evidence.js';

const shownDate = (s) => s ? String(s).slice(0, 10) : 'Unconfirmed';
let lastRefresh = 0;

export function wireIntegrity(root, disposers, openInvestor, openManager) {
  const host = root.querySelector('[data-holdings-integrity]');
  let disposed = false, query = '', expanded = false;
  function paint() {
    if (disposed || !host?.isConnected) return;
    const report = assessCoverage({ snapshot: { investors: investors.list(),
      books: Object.fromEntries(investors.books().map((b) => [b.slug, b])),
      failed: Object.fromEntries(investors.list().filter((i) => investors.failureFor(i.slug)).map((i) => [i.slug, investors.failureFor(i.slug)])) },
      managers: { ...managers.meta(), managers: managers.all() }, deals: { bulkDeals: insider.meta().bulkDeals }, exchange: insider.meta().exchanges, evidence: evidence() });
    const rows = report.rows.filter((r) => `${r.name} ${r.kind} ${r.issues.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
    host.innerHTML = `<details class="mb-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-200" ${expanded ? 'open' : ''}>
      <summary class="cursor-pointer font-semibold">Coverage &amp; unresolved gaps · ${report.attention} of ${report.total} books need attention</summary>
      <p class="mt-3">${report.issues.map(esc).join(' · ')}. Associated funds and personal holdings are separate. No source here establishes every current holding or every trade.</p>
      <p class="mt-2">Investor books are scheduled every six hours; manager archives daily. Source check is when data was fetched; report date is when the holdings apply. Targets: investor checks within ${report.policy.investorHours} hours, PMS reports within ${report.policy.pmsDays} days, AMC holdings within ${report.policy.mfDays} days.</p>
      <label class="mt-3 block">Find an investor, manager or gap <input data-integrity-search aria-label="Search coverage" class="ml-2 rounded-lg border border-amber-200 bg-white px-2 py-1" value="${esc(query)}"></label>
      <div class="mt-3 overflow-auto" style="max-height:360px"><table class="w-full text-left"><thead><tr><th scope="col" class="p-2">Investor / manager</th><th scope="col" class="p-2">Report period</th><th scope="col" class="p-2">Source check</th><th scope="col" class="p-2">Unresolved coverage</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="border-t border-amber-200"><td class="p-2"><button class="font-semibold underline" data-integrity-person="${esc(r.id)}" data-integrity-kind="${esc(r.kind)}">${esc(r.name)}</button></td><td class="whitespace-nowrap p-2">${esc(r.asOf || 'Unavailable')}</td><td class="whitespace-nowrap p-2">${esc(shownDate(r.fetchedAt))}</td><td class="p-2">${r.issues.length ? r.issues.map(esc).join(' · ') : 'No freshness exceptions detected'}. ${esc(r.identity)}.</td></tr>`).join('')}
      </tbody></table></div>
      <p class="mt-2"><a class="font-semibold underline" href="https://github.com/techmuns/Glow-Central-Research/actions/workflows/investor-refresh.yml" target="_blank" rel="noopener noreferrer">Refresh runs and audit reports ↗</a></p>
      </details>`;
    host.querySelector('details').addEventListener('toggle', (e) => { expanded = e.target.open; });
    host.querySelector('[data-integrity-search]').addEventListener('input', (e) => {
      const start = e.target.selectionStart; query = e.target.value; paint();
      const input = host.querySelector('[data-integrity-search]'); input.focus(); input.setSelectionRange(start, start);
    });
    host.querySelectorAll('[data-integrity-person]').forEach((button) => button.addEventListener('click', () =>
      button.dataset.integrityKind === 'investor' ? openInvestor(button.dataset.integrityPerson) : openManager(button.dataset.integrityPerson)));
  }
  paint();
  // One bulk revalidation per five minutes, independent of how often the parent view repaints.
  const refresh = Date.now() - lastRefresh > 300000;
  if (refresh) lastRefresh = Date.now();
  Promise.all([loadEvidence(), refresh ? managers.refresh() : managers.load(), refresh ? investors.refreshSnapshot() : Promise.resolve()]).then(paint);
  const unsubscribe = insider.onChange(paint);
  disposers.push(() => { disposed = true; unsubscribe(); });
}

export function associatedEvidenceHtml(id, kind = 'investor') {
  const rows = evidenceFor(id, kind);
  if (!rows.length) return '';
  return `<div class="mb-4 rounded-xl bg-indigo-50 p-3 text-sm text-slate-700" data-associated-evidence>
    <h3 class="font-semibold">Associated entities · primary evidence</h3>
    ${rows.map((h) => `<p class="mt-2"><strong>${esc(h.company)}</strong> · ${esc(h.legalHolder)} · ${esc(String(h.stakePct))}% · ${esc(String(h.shares))} shares · as of ${esc(h.asOf)}.
      <a class="font-semibold text-indigo-700 underline" href="${esc(h.sourceUrl)}" target="_blank" rel="noopener noreferrer">Exchange disclosure ↗</a></p>
      <p class="mt-1 text-xs">${esc(h.relation.relationship)} <a class="underline" href="${esc(h.relation.sourceUrl)}" target="_blank" rel="noopener noreferrer">Relationship source ↗</a> ${esc(h.note)} Checked ${esc(h.verifiedAt)}.</p>`).join('')}
  </div>`;
}

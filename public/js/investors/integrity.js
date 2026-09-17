// investors/integrity.js — THE COVERAGE AUDIT, one click away. GLOW-OWNED.
//
//   ensureHoldingsFresh()                    revalidate the sources the audit reads — on mount, at
//                                            most once per five minutes, whether or not the audit
//                                            is ever opened
//   wireIntegrity(host, disposers, …)        paint the audit into a host and keep it current
//   associatedEvidenceHtml(id, kind)         the verified-relationship evidence block on a workspace
//
// IT USED TO BE A FULL-WIDTH AMBER BLOCK AT THE TOP OF SUPERSTAR INVESTORS, reading "Coverage &
// unresolved gaps · 119 of 119 books need attention" over every visit — an operator's audit trail
// (source-check ages, unconfirmed comparison cells, identity reviews) sitting above the holdings
// a reader came for, in the colour this dashboard reserves for a partial figure. The owner asked
// for it to go. It went the way every caveat here goes: MOVED BEHIND A DOOR, NEVER DELETED. The
// age is still stated on the page by the freshness chip, and this whole audit — every row, the
// review queue and the link to the refresh runs — now opens from the "How this is derived" button
// beside it. Nothing it said is gone; none of it is on the page uninvited.
//
// The revalidation the panel used to trigger as a side effect of being on the page is kept as its
// own call, because "refresh on opening" is a standing requirement and must not depend on a panel
// a reader may never open.
import { escapeHtml as esc } from '../core/dom.js';
import { closeModal } from '../ui/screener.js';
import * as investors from '../data/super-investors.js';
import * as managers from '../data/managers.js';
import { insider } from '../data/filings.js';
import { assessCoverage } from '../data/holdings-integrity.js';
import { loadEvidence, evidence, evidenceFor } from '../data/holding-evidence.js';
import * as primary from '../data/public-holdings.js';

const shownDate = (s) => s ? String(s).slice(0, 10) : 'Unconfirmed';
let lastRefresh = 0;

/** One bulk revalidation per five minutes, independent of how often the parent view repaints. */
export function ensureHoldingsFresh() {
  const refresh = Date.now() - lastRefresh > 300000;
  if (refresh) lastRefresh = Date.now();
  return Promise.all([loadEvidence(), primary.load(), refresh ? managers.refresh() : managers.load(), refresh ? investors.refreshSnapshot() : Promise.resolve()]);
}

export function coverageReport() {
  return assessCoverage({ snapshot: { investors: investors.list(),
    books: Object.fromEntries(investors.books().map((b) => [b.slug, b])),
    // The audit reports FRESHNESS, so it wants both halves of the split in `super-investors.js`:
    // a book with nothing behind it (`failureFor`) and a retained book whose latest check did not
    // answer (`uncheckedFor`). The card there shows only the first; dropping the second here would
    // silence "Refresh failed; last successful book retained" — the one line this audit exists for.
    failed: Object.fromEntries(investors.list().map((i) => [i.slug, investors.failureFor(i.slug) || investors.uncheckedFor(i.slug)]).filter(([, f]) => f)) },
    managers: { ...managers.meta(), managers: managers.all() }, deals: { bulkDeals: insider.meta().bulkDeals }, exchange: insider.meta().exchanges, evidence: evidence(), publicHoldings: primary.report() });
}

/**
 * Paint the audit into `host` — a `[data-holdings-integrity]` element inside the provenance modal —
 * and keep it current while it is on screen. Opening an investor or manager from a row closes the
 * modal first: the workspace stacks BELOW the modal (drill z-50 < workspace z-55 < modal z-60), so
 * opening one behind an open modal would be a control that works and shows nothing.
 */
export function wireIntegrity(root, disposers, openInvestor, openManager) {
  const host = root?.matches?.('[data-holdings-integrity]') ? root : root?.querySelector?.('[data-holdings-integrity]');
  if (!host) return;
  let disposed = false, query = '', reviewLimit = 50;
  function paint() {
    if (disposed || !host?.isConnected) return;
    const report = coverageReport();
    const publicReport = primary.report();
    const reviewRows = [...(publicReport?.issues || []).map((r) => ({ ...r, person: publicReport.profiles.find((p) => p.id === r.personId && p.kind === r.kind)?.name })), ...(publicReport?.sourceExceptions || []), ...(publicReport?.candidates || []).map((r) => ({ company: r.company, legalHolder: r.legalName, sourceUrl: r.sourceUrl,
      type: 'identity-review', message: `Possible connection to ${r.candidates.map((p) => p.name).join(', ')}; evidence of the relationship is still being checked.` }))]
      .filter((r) => `${r.person || ''} ${r.company || ''} ${r.legalHolder || ''} ${r.type} ${r.message}`.toLowerCase().includes(query.toLowerCase()));
    const rows = report.rows.filter((r) => `${r.name} ${r.kind} ${r.issues.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
    host.innerHTML = `<div class="text-xs text-slate-600" data-coverage-audit>
      <h3 class="font-display text-base font-bold text-slate-900">Coverage &amp; source checks · <span data-coverage-attention>${report.attention} of ${report.total}</span> profiles have an open item</h3>
      <p class="mt-2">${report.issues.length ? `${report.issues.map(esc).join(' · ')}. ` : ''}Associated funds and personal holdings are separate. Disclosures establish holdings on their stated dates.</p>
      <p class="mt-2">Public holdings are checked every six hours. Source check is when data was fetched; report date is when the holdings apply.</p>
      ${publicReport ? `<p class="mt-2">${publicReport.coverage.parsed.toLocaleString('en-IN')} exchange filings read · ${publicReport.coverage.securities.toLocaleString('en-IN')} distinct security identifiers (ISINs) · ${publicReport.holdings.length.toLocaleString('en-IN')} attributed disclosures · checked ${esc(shownDate(publicReport.captureCheckedAt))}.</p>` : ''}
      ${primary.lastError() ? '<p class="mt-2">Public disclosure refresh failed; retained evidence is shown.</p>' : ''}
      <label class="mt-3 block">Find an investor, manager or gap <input data-integrity-search aria-label="Search coverage" class="ml-2 rounded-lg border border-slate-200 bg-white px-2 py-1" value="${esc(query)}"></label>
      <div class="mt-3 overflow-auto rounded-lg ring-1 ring-slate-200" style="max-height:360px"><table class="w-full text-left"><thead class="bg-slate-50"><tr><th scope="col" class="p-2">Investor / manager</th><th scope="col" class="p-2">Report period</th><th scope="col" class="p-2">Source check</th><th scope="col" class="p-2">Unresolved coverage</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="border-t border-slate-100"><td class="p-2"><button type="button" class="font-semibold text-indigo-600 underline" data-integrity-person="${esc(r.id)}" data-integrity-kind="${esc(r.kind)}">${esc(r.name)}</button></td><td class="whitespace-nowrap p-2">${esc(r.asOf || 'Unavailable')}</td><td class="whitespace-nowrap p-2">${esc(shownDate(r.fetchedAt))}</td><td class="p-2">${r.issues.length ? r.issues.map(esc).join(' · ') : 'No freshness exceptions detected'}. ${esc(r.identity)}.</td></tr>`).join('')}
      </tbody></table></div>
      <h4 class="mt-4 font-semibold text-slate-900">Public-source review · ${reviewRows.length.toLocaleString('en-IN')} checks</h4>
      <p class="mt-1">Additional holdings are already shown with their exchange evidence. Differences and possible name connections remain here until the sources reconcile.</p>
      <div class="mt-2 overflow-auto rounded-lg ring-1 ring-slate-200" style="max-height:340px" data-public-review>${reviewRows.slice(0, reviewLimit).map((r) => `<div class="border-t border-slate-100 p-2"><strong>${esc(r.company || r.legalHolder || 'Source check')}</strong>${r.person ? ` · ${esc(r.person)}` : ''}${r.legalHolder && r.legalHolder !== r.person ? ` · ${esc(r.legalHolder)}` : ''}${r.asOf ? ` · ${esc(r.asOf)}` : ''}<br>${esc(r.message)} ${r.sourceUrl ? `<a class="underline" href="${esc(r.sourceUrl)}" target="_blank" rel="noopener noreferrer">Evidence ↗</a>` : ''}</div>`).join('') || '<p class="p-2">No matching review items.</p>'}</div>
      ${reviewRows.length > reviewLimit ? `<button type="button" class="mt-2 font-semibold text-indigo-600 underline" data-more-public-review>Show more (${reviewLimit} of ${reviewRows.length})</button>` : ''}
      <p class="mt-3"><a class="font-semibold text-indigo-600 underline" href="https://github.com/techmuns/Glow-Central-Research/actions/workflows/investor-refresh.yml" target="_blank" rel="noopener noreferrer">Refresh runs and audit reports ↗</a></p>
      </div>`;
    host.querySelector('[data-integrity-search]').addEventListener('input', (e) => {
      const start = e.target.selectionStart; query = e.target.value; reviewLimit = 50; paint();
      const input = host.querySelector('[data-integrity-search]'); input.focus(); input.setSelectionRange(start, start);
    });
    host.querySelector('[data-more-public-review]')?.addEventListener('click', () => { reviewLimit += 100; paint(); });
    host.querySelectorAll('[data-integrity-person]').forEach((button) => button.addEventListener('click', () => {
      closeModal();
      return button.dataset.integrityKind === 'investor' ? openInvestor(button.dataset.integrityPerson) : openManager(button.dataset.integrityPerson);
    }));
  }
  paint();
  ensureHoldingsFresh().then(paint);
  const unsubscribe = insider.onChange(paint);
  const unsubscribePrimary = primary.onChange(paint);
  disposers.push(() => { disposed = true; unsubscribe(); unsubscribePrimary(); });
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

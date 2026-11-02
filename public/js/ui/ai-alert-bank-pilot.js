import { buildBankPilot, BANK_PILOT, BANK_PILOT_BRIEF, bankPilotMarkdown } from '../data/ai-alert-bank-pilot.js';
import { escapeHtml } from '../core/dom.js';

const cached = new WeakMap();
function reading(report, universe) {
  if (!report || report.scope !== 'universe') return null;
  const prior = cached.get(report);
  if (prior?.universe === universe) return prior.pilot;
  const pilot = buildBankPilot(report, universe);
  cached.set(report, { universe, pilot });
  return pilot;
}
const rowsMarkup = rows => `<ol class="bank-pilot-rows">${rows.map(row => `<li data-ai-row="bank-pilot:${escapeHtml(row.eventIds.join('|'))}">
  <div class="bank-pilot-meta">${escapeHtml(row.event.day)}${row.event.time ? ` · ${escapeHtml(row.event.time)} IST` : ''} · ${escapeHtml(row.sources.join(' / '))}</div>
  <div class="bank-pilot-relation">${escapeHtml(row.relation)}${row.companies.length > 1 ? ` · Also names ${escapeHtml(row.companies.slice(1).join(', '))}` : ''}</div>
  ${row.url ? `<a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.event.headline)}</a>` : `<span>${escapeHtml(row.event.headline)} <small>(source link unavailable)</small></span>`}
  </li>`).join('')}</ol>`;
function groupMarkup(rows, key, title) {
  return `<section class="bank-pilot-group" data-ai-bank-group="${key}"><h3>${title} <span>${rows.length}</span></h3>
    ${rows.length ? rowsMarkup(rows.slice(0, 3)) : '<p>No matching dated records in the loaded evidence. This does not establish that no development occurred.</p>'}
    ${rows.length > 3 ? `<details data-ai-bank-more="${key}"><summary>Show all ${rows.length} records</summary>${rowsMarkup(rows.slice(3))}</details>` : ''}</section>`;
}
export function bankPilotMarkup(report, universe = []) {
  if (report?.scope !== 'universe') return '';
  const pilot = reading(report, universe);
  if (!pilot) return '';
  const uncertain = pilot.feeds.filter(feed => feed.status !== 'ok' || feed.reachesToday === false);
  const status = pilot.pending ? 'Reading source feeds…' : uncertain.length ? 'Partial or stale source coverage · retained records shown' : 'Captured source records · completeness not certified';
  return `<section class="bank-pilot" aria-label="J&K Bank company, peers and industry pilot" data-ai-bank-pilot-card>
    <header class="bank-pilot-head"><div><div class="bank-pilot-kicker">Universe pilot · Last 7 days</div><h2>${BANK_PILOT.name}: company, peers & industry</h2></div>
      <button type="button" data-ai-bank-export>Download full report & reading brief</button></header>
    <p>${pilot.firstDay} through ${pilot.day} (IST, inclusive). Selected as the largest bank holding in the ${BANK_PILOT.selectedFrom} statement snapshot.</p>
    <p class="bank-pilot-status" role="status">${escapeHtml(status)}. Peer and industry context does not change J&K Bank’s priority.</p>
    <p>Source disclosures, material items and specific banking topics lead the preview; all matching records, including routine reporting, remain available below and in the download.</p>
    ${pilot.metadataUnavailable ? '<p class="bank-pilot-status">Universe bank classifications are unavailable; the peer list may be incomplete.</p>' : ''}
    <div class="bank-pilot-grid">${groupMarkup(pilot.groups.company, 'company', 'Company')}${groupMarkup(pilot.groups.peers, 'peers', 'Named peers')}${groupMarkup(pilot.groups.industry, 'industry', 'Banking industry')}</div>
    <details data-ai-bank-coverage><summary>Peer list & source coverage</summary>
      <p>Peer set: ${pilot.peers.length} other Universe companies classified as Banks. This includes public, private and small finance banks; it is an industry comparison set.</p>
      <p>${escapeHtml(pilot.peers.map(company => `${company.name} (${company.ticker})`).join(', ') || 'Universe classifications unavailable')}.</p>
      <p>Dates above are source publication dates. Checks below are the feeds’ source as-of times. Undated records are excluded. Collection and source gaps can leave relevant news uncaptured; no exhaustive archive is claimed.</p>
      <ul>${pilot.feeds.map(feed => `<li><strong>${escapeHtml(feed.label || feed.id)}</strong> · ${escapeHtml(feed.status || 'unread')}${feed.reachesToday === false ? ' · does not reach today' : ''} · Source as of: ${escapeHtml(feed.asOf || 'unavailable')}${feed.note ? `<br>${escapeHtml(feed.note)}` : ''}</li>`).join('')}</ul>
    </details>
    <details data-ai-bank-brief><summary>Reading brief / prompt</summary><p>Current AI Alerts use deterministic rules. This pilot reads the existing evidence without a model call.</p><pre>${escapeHtml(BANK_PILOT_BRIEF)}</pre></details>
  </section>`;
}
export function downloadBankPilot(report, universe = []) {
  const pilot = reading(report, universe);
  if (!pilot) return;
  const url = URL.createObjectURL(new Blob([bankPilotMarkdown(pilot)], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `glow-jkbank-universe-pilot-${pilot.day}.md`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

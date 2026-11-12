import { TAB_META } from './catalog.js';
import * as feed from '../data/private-market-news.js';
import * as dealFeed from '../data/private-deals.js';
import { fundingRoundFilter } from '../data/funding-round-types.js';
import { PERIOD_PICKS, isRangeValue, rangeLabel, rangeValue, normalizePeriod, periodBounds, periodMatcher, fundingDay, istToday, latestWeekEnd } from '../data/funding-period.js';
import { sectionHead, scoreTable, openDrill, openModal } from '../ui/screener.js';
import { escapeHtml as esc } from '../core/dom.js';
import { exportRows } from '../ui/export.js';
import * as refreshRegistry from '../core/refresh.js';
import { revalidatedJson } from '../core/store.js';
import * as watchlist from '../core/watchlist.js';
import { nameKey, privateCompanyMatcher, readPrivateCompanies } from '../data/private-companies.js';
import { holdingMembership, watchScopeCompanies, isPreviousScope } from '../data/scope.js';
import * as profiles from '../data/private-company-profiles.js';
import { profileKey, roundsFor, hostOf, safeHttpUrl } from '../data/private-company-profiles-shared.js';

export const meta = TAB_META['private-market-news'];
let ctxRef = null, table = null, view = null, offTable = null, disposers = [], viewScope = null;
// GLOW-OWNED SCOPE. Universe is every funding record Inc42 reported; Portfolio narrows to the family's
// own private companies (GlowVentures' book, daily) and Watchlist to watched companies, both by EXACT
// company name. A record names no ISIN, so a name is the only join, and a near miss is not a match.
let privateCompanies = null, privateRead = null, privateError = null;
const PERIOD_DEFAULT = { universe: 'latest', portfolio: 'all', watchlist: 'all' };
function loadPrivateCompanies() {
  privateRead ||= revalidatedJson('data/portfolio-companies.json')
    .then(list => { privateCompanies = readPrivateCompanies(list); privateError = null; })
    .catch(error => { privateError = error?.message || 'unreadable'; privateRead = null; })
    .then(() => paint());
  return privateRead;
}
// The header's Holding choice narrows the family's private companies to those held that way, and
// under Universe turns the view into those companies' rounds (a listed category holds none of them).
const heldCategory = () => holdingMembership();
const companiesInView = () => {
  const held = heldCategory();
  return privateCompanies && held ? privateCompanies.filter(c => (c.categories || []).includes(held.category)) : privateCompanies;
};
function scopeRows(rows, scope) {
  if (scope === 'portfolio') {
    const companies = companiesInView();
    if (!companies) return { rows: [], holdingOf: () => null, matched: 0 };
    const match = privateCompanyMatcher(companies), holdings = new Map();
    for (const row of rows) { const company = match(row.company); if (company) holdings.set(row.id, company); }
    return { rows: rows.filter(row => holdings.has(row.id)), holdingOf: row => holdings.get(row.id) || null,
      matched: new Set([...holdings.values()].map(c => c.id)).size };
  }
  if (scope === 'watchlist') {
    const match = privateCompanyMatcher(watchScopeCompanies().filter(w => w.name).map(w => ({ name: w.name, aliases: [] })));
    // Previously owned already kept the companies held that way then; the current private list would empty it.
    const held = !isPreviousScope(scope) && heldCategory() && privateCompanyMatcher(companiesInView() || []);
    return { rows: rows.filter(row => match(row.company) && (!held || held(row.company))), holdingOf: () => null, matched: 0 };
  }
  return { rows, holdingOf: () => null, matched: 0 };
}
function scopeText(scope, matched) {
  if (scope === 'portfolio') {
    if (privateError) return 'The family’s private-company list could not be read, so no funding is matched to it. Universe still lists every record.';
    if (!privateCompanies) return 'Reading the family’s private companies from the Glow Ventures book…';
    const held = heldCategory();
    return `Funding reported by Inc42 for the family’s own private companies${held ? ` held as ${held.label}` : ''} · ${matched} of ${companiesInView().length} have a captured round · matched by exact company name.`;
  }
  if (isPreviousScope(scope)) return 'Funding reported by Inc42 for the companies the family previously owned · matched by exact company name.';
  if (scope === 'watchlist') return 'Funding reported by Inc42 for your watchlist companies · matched by exact company name.';
  return 'Funding rounds and M&A of Indian private companies from Inc42, Entrackr, Economic Times, Mint, Business Standard, YourStory, Hindustan Times, Times of India and more · one row per deal; where reports differ the more credible source is shown.';
}
function emptyText(scope, all) {
  if (!all.length) return 'Funding collection has not published readable rows yet. Coverage shows the latest attempt.';
  if (scope === 'portfolio') {
    if (privateError) return 'The family’s private-company list could not be read. This is a failed read, not an absence of funding.';
    if (!privateCompanies) return 'Reading the family’s private companies…';
    if (!privateCompanies.length) return 'The Glow Ventures book carries no private companies yet; it refreshes daily.';
    const held = heldCategory();
    if (held && !companiesInView().length) return `None of the family’s private companies is held as ${held.label}. Choose another holding type to see their funding.`;
    return `No funding for the family’s ${companiesInView().length} private companies${held ? ` held as ${held.label}` : ''} matches these filters. Try All captured history.`;
  }
  if (isPreviousScope(scope)) return 'None of the family’s previously owned companies appears in the captured funding records.';
  if (scope === 'watchlist') return 'None of your watchlist companies appears in the captured funding records.';
  return 'No funding deals match these filters.';
}
const fields = [['date','Deal date'],['company','Company'],['kind','Deal'],['sector','Sector'],['subsector','Subsector'],['businessModel','Business model'],['amount','Round size'],['round','Round type'],['investors','Investors / acquirer'],['leadInvestor','Lead investor']];
const KIND = { funding:'Funding', acquisition:'Acquisition', merger:'Merger' };
const dealText = r => `${KIND[r.kind] || 'Funding'}${r.status === 'talks' ? ' · in talks' : ''}`;
const investorsText = r => r.kind === 'funding' || !r.kind ? r.investors : [r.acquirer && `Acquirer: ${r.acquirer}`, r.investors].filter(Boolean).join(' · ');
const isoDay = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); return m ? `${Number(m[3])} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m[2]) - 1]} ${m[1]}` : v; };
const valueOf = (r, key) => key === 'date' ? isoDay(r.date) : key === 'kind' ? dealText(r) : key === 'investors' ? investorsText(r) : r[key];
const sourceList = r => r.sources?.length ? r.sources : [{ publisher:'Inc42 Funding Galore', url:r.sourceUrl, title:r.sourceTitle, publishedAt:r.publishedAt }];
const sourcesCell = r => { const list = sourceList(r); return `<div style="max-width:200px;white-space:normal">${list.slice(0, 3).map(src => `<a data-norow href="${esc(safeUrl(src.url))}" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:underline">${esc(src.publisher)}</a>`).join(', ')}${list.length > 3 ? ` <span class="text-slate-500">+${list.length - 3}</span>` : ''}</div>`; };
const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-IN', { timeZone:'Asia/Kolkata', dateStyle:'medium', timeStyle:'short' }) + ' IST' : 'Not yet confirmed';
const safeUrl = value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : 'https://inc42.com/tag/funding-galore/'; } catch { return 'https://inc42.com/tag/funding-galore/'; } };
const link = row => `<a data-norow href="${esc(safeUrl(row.sourceUrl || row.url))}" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:underline">${esc(row.publisher && row.publisher !== 'Inc42 Funding Galore' ? row.publisher : 'Inc42')} ↗</a>`;
const cell = value => `<div style="max-width:260px;white-space:normal;overflow-wrap:anywhere">${esc(value || '—')}</div>`;
// THE COMPANY CARD (GLOW-OWNED). A row click opens the company, not just the row: what it does (in
// somebody else's words — its own homepage, Wikipedia or Wikidata, reproduced and linked), its sector
// and theme as the deals report them, every deal captured for that EXACT name, and the record clicked.
const day = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('en-IN', { timeZone:'Asia/Kolkata', day:'numeric', month:'short', year:'numeric' }) : '';
const SOURCE_LABEL = { website:'company website', wikipedia:'Wikipedia', wikidata:'Wikidata' };
const sourceLink = (source, text) => { const url = safeHttpUrl(source.url); return url ? `<a data-norow href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:underline">${esc(text)} ↗</a>` : esc(text); };
function aboutHtml(name) {
  const state = profiles.status(), profile = profiles.profileFor(name);
  const box = body => `<section data-company-about="${esc(profileKey(name))}" class="mt-1"><h3 class="text-xs font-semibold uppercase tracking-wider text-slate-500">About</h3>${body}</section>`;
  if (!profile) {
    if (state === 'loading' || state === 'idle') return box('<p class="mt-2 text-sm text-slate-500">Reading the company description…</p>');
    if (state === 'failed') return box('<p class="mt-2 text-sm text-slate-600">Company descriptions could not be read right now. This is a failed read, not a missing description; reopen the card to try again.</p>');
    return box('<p class="mt-2 text-sm text-slate-600">Not looked up yet. Descriptions are collected daily on GitHub — the family’s private companies first, then the newest rounds — from the company’s own website, Wikipedia and Wikidata.</p>');
  }
  const [lead, ...others] = profile.sources || [];
  const checked = day(profile.checkedAt);
  if (profile.status !== 'found' || !lead) {
    const why = profile.status === 'failed'
      ? `No description yet: the sources could not be reached when last tried${checked ? ` (${esc(checked)})` : ''}. It is tried again daily.`
      : `No description found. Checked Wikidata and Wikipedia for this exact name and the likely company websites${checked ? ` on ${esc(checked)}` : ''}; a guessed website counts only when its own title names the company.`;
    const site = safeHttpUrl(profile.website);
    return box(`<p class="mt-2 text-sm text-slate-600">${why}</p>${site ? `<p class="mt-2 text-xs">${sourceLink({ url:site }, hostOf(site))}</p>` : ''}`);
  }
  const label = lead.kind === 'website' ? `From ${hostOf(lead.url)}, the company’s own website description` : `From ${SOURCE_LABEL[lead.kind]}`;
  return box(`<p class="mt-2 text-sm leading-relaxed text-slate-800" title="${esc(lead.full || lead.text)}">${esc(lead.text)}</p>
    <p class="mt-1 text-xs text-slate-500">${sourceLink(lead, label)} · reproduced, not reworded${day(profile.foundAt || profile.checkedAt) ? ` · read ${esc(day(profile.foundAt || profile.checkedAt))}` : ''}</p>
    ${others.length ? `<p class="mt-1 text-xs text-slate-500">Also: ${others.map(o => `<span title="${esc(o.text)}">${sourceLink(o, SOURCE_LABEL[o.kind])}</span>`).join(' · ')}</p>` : ''}
    ${lead.kind !== 'website' && safeHttpUrl(profile.website) ? `<p class="mt-1 text-xs">${sourceLink({ url:profile.website }, hostOf(profile.website))}</p>` : ''}`);
}
const distinct = values => [...new Set(values.map(v => String(v || '').trim()).filter(v => v && !/^[-–—_]$/.test(v)))];
function themeHtml(rounds) {
  const parts = [['Sector', distinct(rounds.map(r => r.sector))], ['Subsector / theme', distinct(rounds.map(r => r.subsector))], ['Business model', distinct(rounds.map(r => r.businessModel))]].filter(([, v]) => v.length);
  if (!parts.length) return '';
  return `<section class="mt-5"><h3 class="text-xs font-semibold uppercase tracking-wider text-slate-500">Sector &amp; theme</h3><dl class="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">${parts.map(([label, values]) => `<div><dt class="text-xs text-slate-500">${esc(label)}</dt><dd class="text-slate-800">${esc(values.join(' · '))}</dd></div>`).join('')}</dl><p class="mt-1 text-xs text-slate-500">As reported on the deals below.</p></section>`;
}
function roundsHtml(rounds, row) {
  const notesFor = url => feed.meta().articles?.find(a => a.url === url)?.notes || [];
  const item = r => {
    const current = r.observations.some(o => o.id === row.id);
    const srcs = [...new Map(r.observations.flatMap(o => sourceList(o.row)).map(src => [safeUrl(src.url), src])).values()];
    const links = srcs.map(src => `<a data-norow href="${esc(safeUrl(src.url))}" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:underline">${esc(src.publisher || 'Source')} ↗</a>${src.title ? ` <span class="text-slate-500">· ${esc(src.title)}</span>` : ''}`).join('<br>');
    const notes = [...new Set(r.observations.flatMap(o => notesFor(o.sourceUrl)))];
    const title = r.kind && r.kind !== 'funding' ? dealText(r) : (r.round || 'Round type not stated');
    return `<li data-company-round class="rounded-xl p-3 ring-1 ${current ? 'ring-indigo-200 bg-indigo-50/60' : 'ring-slate-100'}">
      <div class="flex flex-wrap items-baseline justify-between gap-2"><strong class="text-sm text-slate-900">${esc(title)}</strong><span class="text-sm tabular-nums text-slate-800">${esc(r.amount || 'Amount not stated')}</span></div>
      <p class="text-xs text-slate-500">${esc(isoDay(r.date) || 'Date not stated')}${r.status === 'talks' ? ' · in talks (reported)' : ''}${current ? ' · the record you opened' : ''}</p>
      <p class="mt-2 text-xs text-slate-700"><span class="text-slate-500">${r.kind && r.kind !== 'funding' ? 'Parties' : 'Investors'}:</span> ${esc(investorsText(r) || 'Not disclosed')}</p>
      ${r.leadInvestor && !/^[-–—_]$/.test(r.leadInvestor.trim()) ? `<p class="mt-1 text-xs text-slate-700"><span class="text-slate-500">Lead:</span> ${esc(r.leadInvestor)}</p>` : ''}
      ${notes.length ? `<p class="mt-1 whitespace-pre-line text-xs text-slate-500">${esc(notes.join('\n'))}</p>` : ''}
      <p class="mt-2 text-xs">${links}</p></li>`;
  };
  return `<section class="mt-5"><h3 class="text-xs font-semibold uppercase tracking-wider text-slate-500">Funding rounds · ${rounds.length} captured</h3>
    <ol class="mt-2 space-y-2">${rounds.map(item).join('')}</ol>
    <p class="mt-2 text-xs text-slate-500">Every deal captured for this exact company name, newest first. A deal shows once when every reported field matches, with each source kept; this is not a verified funding total.</p></section>`;
}
function recordHtml(row) {
  const article = feed.meta().articles?.find(a => a.url === row.sourceUrl);
  const inc42Lead = row.origin === 'inc42-table' || !row.origin;
  const readings = inc42Lead && row.sourceFields && Object.keys(row.sourceFields).length ? Object.entries(row.sourceFields) : fields.map(([key,label]) => [label, valueOf(row, key)]);
  const sources = sourceList(row);
  const conflicts = (row.conflicts || []).map(c => `<p class="mt-2 text-sm"><strong>${esc(c.field)}</strong>: shown ${esc(c.chosen.value)} (${esc(c.chosen.publisher)}, the more credible source); also reported ${c.others.map(o => `${esc(o.value)} (<a data-norow href="${esc(safeUrl(o.url))}" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:underline">${esc(o.publisher)}</a>)`).join(', ')}.</p>`).join('');
  return `<details class="mt-5 text-sm"><summary class="cursor-pointer text-xs font-semibold uppercase tracking-wider text-slate-500">This record as published</summary>${readings.map(([label,value]) => `<p class="mt-3 text-sm"><strong>${esc(label)}</strong><br>${esc(value || 'Not provided')}</p>`).join('')}
    ${conflicts ? `<div class="mt-4"><p class="text-xs font-semibold uppercase tracking-wide text-slate-500">Sources differ</p>${conflicts}</div>` : ''}
    <div class="mt-4"><p class="text-xs font-semibold uppercase tracking-wide text-slate-500">Reported by (most credible first)</p>${sources.map(src => `<p class="mt-2 text-sm"><a data-norow href="${esc(safeUrl(src.url))}" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:underline">${esc(src.publisher)} ↗</a>${src.title ? ` · ${esc(src.title)}` : ''}${src.publishedAt ? ` · ${esc(time(src.publishedAt))}` : ''}</p>`).join('')}</div>
    ${inc42Lead ? `<p class="mt-4 text-xs text-slate-500">${esc(article?.notes?.join('\n') || '')}</p>` : ''}
    <p class="mt-3 text-xs text-slate-500">${inc42Lead ? `Roundup published: ${esc(time(row.publishedAt))}. ` : ''}First captured: ${esc(time(row.firstSeenAt))}.</p>
    ${row.sourceMissing ? '<p class="mt-3 text-sm">Retained observation: this row is absent from the latest successful read of its article.</p>' : ''}
    ${row.revisions?.length ? `<details class="mt-3 text-xs"><summary>${row.revisions.length} earlier source version(s)</summary>${row.revisions.map(v => `<p class="mt-3"><strong>Captured ${esc(time(v.capturedAt))}</strong><br>${Object.entries(v.sourceFields || {}).map(([label,value]) => `${esc(label)}: ${esc(value)}`).join('<br>')}</p>`).join('')}</details>` : ''}<p class="mt-4">${link(row)} · ${esc(row.sourceTitle || row.title || '')}</p></details>`;
}
let offProfiles = null;
function details(row) {
  const rounds = roundsFor(row.company, dealFeed.consolidated(feed.rows()));
  if (!rounds.length) rounds.push({ ...row, observations:[{ id:row.id, row, sourceUrl:row.sourceUrl }] });
  const key = profileKey(row.company), site = safeHttpUrl(profiles.profileFor(row.company)?.website);
  openDrill({ name: row.company, sub: `Private company · ${rounds.length} deal${rounds.length === 1 ? '' : 's'} captured`,
    link: site, linkLabel: site ? `${hostOf(site)} ↗` : undefined,
    beforeGroupsHtml: `${aboutHtml(row.company)}${themeHtml(rounds)}${roundsHtml(rounds, row)}${recordHtml(row)}` });
  // The description file is read once, on the first card; when it lands, only the About block of
  // the card still showing this company is redrawn — a reader scrolled into the rounds stays put.
  if (profiles.status() !== 'ready') {
    offProfiles?.();
    offProfiles = profiles.onChange(() => {
      offProfiles?.(); offProfiles = null;
      const about = document.querySelector(`#drill-content [data-company-about="${CSS.escape(key)}"]`);
      if (about) about.outerHTML = aboutHtml(row.company);
    });
    void profiles.load();
  }
}
function coverage() {
  const m = feed.meta(), h = feed.health();
  if (!m.generatedAt) { openModal(`<h2 class="font-display text-lg font-bold text-slate-900">Private Market coverage</h2><p class="mt-3 text-sm">No verified capture is loaded yet. ${esc(m.readError || 'The published capture is being checked automatically.')}</p>`, { size:'wide' }); return; }
  openModal(`<h2 class="font-display text-lg font-bold text-slate-900">Private Market coverage</h2>
    <p class="mt-3 text-sm">Inc42 Funding Galore covers Indian startup funding reported in weekly roundups. It is a discovery source, not an exhaustive record of every VC or PE transaction. Rounds may include debt or undisclosed amounts; source wording and footnotes are retained.</p>
    <p class="mt-3 text-sm">Source listing checked: ${esc(time(m.sourceCheckedAt))}. Collection attempt: ${esc(time(m.attemptedAt))}. Capture prepared: ${esc(time(m.generatedAt))}. Browser checked publication: ${esc(time(m.browserCheckedAt))}.</p>
    <p class="mt-3 text-sm">${m.deals?.length || 0} retained rows across ${m.articles?.length || 0} discovered roundups. ${h.pending} awaiting capture; ${h.unavailable} failed or without a supported public table. Archive listing ${m.archive?.complete ? 'traversal complete' : `backfill in progress (next page ${m.archive?.nextPage || 2})`}. Previously captured rows are retained without an age cutoff. Repeated mentions in different roundups remain separate source observations; counts are not unique transaction totals.</p>
    <p class="mt-3 text-sm">GitHub checks every six hours, with sequential requests at least three seconds apart and at most 32 requests per run. Access refusals pause collection for at least 24 hours. Scheduled runs reconcile recent roundups and resume older work. This browser checks published captures every five minutes while visible and on return.</p>
    ${m.cooldownUntil ? `<p class="mt-3 text-sm">Source cooldown until ${esc(time(m.cooldownUntil))}.</p>` : ''}
    ${m.error || m.readError ? `<p class="mt-3 text-sm">Latest problem: ${esc(m.error || m.readError)}. Saved rows remain readable.</p>` : ''}
    <p class="mt-3 text-xs text-slate-500">${esc((m.articles || []).find(a => a.notes?.length)?.notes.join('\n') || '')}</p>
    ${newsCoverage()}
    <details class="mt-4"><summary>Roundup capture history</summary><div style="max-height:340px;overflow:auto">${(m.articles || []).map(a => `<p class="mt-2 text-xs">${link(a)} · ${esc(a.title)} · ${esc(a.status)}${a.rows != null ? ` · ${a.rows} rows` : ''}${a.error ? ` · ${esc(a.error)}` : ''}</p>`).join('')}</div></details>`, { size:'wide' });
}
// The From–To pickers sit beside the Funding period dropdown and drive it: a typed range becomes the
// dropdown's one custom option, and a quick pick fills the two dates it selects so the reader sees
// the bounds. Both write ONE filter value, so rows, the count and the export read one predicate.
function rangeControl({ today, weekEnd, min, max }) {
  const input = (edge, label) => `<input type="date" data-period-edge="${edge}" aria-label="${label}" title="${label} (deal funding date)"
    ${min ? `min="${esc(min)}"` : ''} ${max ? `max="${esc(max)}"` : ''}
    class="rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-sm tabular-nums focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">`;
  const html = `<div data-period-range class="inline-flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-600">
    <span>From</span>${input('from', 'Funding from')}<span>To</span>${input('to', 'Funding to')}</div>`;
  const boundsOf = value => periodBounds(value, today, weekEnd) || { from:'', to:'' };
  return { html, wire(host) {
    const select = host.querySelector('[data-table-filter="0"]'), box = host.querySelector('[data-period-range]');
    if (!select || !box) return null;
    select.after(box);
    const from = box.querySelector('[data-period-edge="from"]'), to = box.querySelector('[data-period-edge="to"]');
    const show = () => { const b = boundsOf(select.value); from.value = b.from || ''; to.value = b.to || ''; };
    const apply = () => {
      const value = rangeValue(from.value, to.value);
      [...select.options].filter(o => isRangeValue(o.value) && o.value !== value).forEach(o => o.remove());
      if (isRangeValue(value) && ![...select.options].some(o => o.value === value)) select.add(new Option(rangeLabel(value), value));
      if (select.value !== value) { select.value = value; select.dispatchEvent(new Event('change', { bubbles:true })); }
      show();
    };
    show();
    select.addEventListener('change', show);
    from.addEventListener('change', apply); to.addEventListener('change', apply);
    return () => { select.removeEventListener('change', show); from.removeEventListener('change', apply); to.removeEventListener('change', apply); };
  } };
}
function newsLine() {
  const d = dealFeed.meta(), ok = d.feeds.filter(f => f.ok).length;
  if (d.readError && !d.generatedAt) return 'Other publishers: capture could not be read';
  if (!d.generatedAt) return 'Other publishers: reading…';
  const age = Math.max(0, Math.round((Date.now() - Date.parse(d.generatedAt)) / 60000));
  const ago = age < 60 ? `${age} min ago` : `${Math.round(age / 60)} h ago`;
  return `${ok} of ${d.feeds.length} publisher feeds read ${ago}${d.refreshing ? ' · fetching the latest now…' : ''}`;
}
function newsCoverage() {
  const d = dealFeed.meta();
  const rows = d.feeds.map(f => `<p class="mt-1 text-xs">${esc(f.id)} · ${f.ok ? `${f.items} stories, ${f.deals} deals read` : `not read (${esc(f.error || 'failed')}) · last good ${esc(time(f.lastOkAt))}`}</p>`).join('');
  return `<h3 class="mt-5 font-display text-sm font-bold text-slate-900">Other publishers</h3>
    <p class="mt-2 text-sm">Funding and M&amp;A headlines from Entrackr, Inc42 news, YourStory, Economic Times, Mint, Business Standard, The Hindu BusinessLine, Hindustan Times, Times of India, TechCrunch and Tech in Asia feeds, plus Google News searches that bring in Moneycontrol, VCCircle and other desks. A deal is read only from a headline that plainly states who raised or who bought; a field the headline does not state stays blank. Listed companies and deals placed outside India are left out.</p>
    <p class="mt-2 text-sm">Reports of one deal are folded into one row (same company, compatible round and size, within 30 days). Each field is taken from the most credible source that states it — Inc42 Funding Galore table, then Entrackr, VCCircle, Economic Times, Mint, Business Standard / Moneycontrol / Inc42, BusinessLine, YourStory, Hindustan Times, Times of India, then other outlets — and any disagreement is shown on the row. Amounts in different currencies are never compared. Tracxn publishes no free per-deal feed, so it is not read.</p>
    <p class="mt-2 text-sm">${d.count} reports captured · prepared ${esc(time(d.generatedAt))} · browser checked ${esc(time(d.checkedAt))}${d.readError ? ` · latest read failed: ${esc(d.readError)}; saved reports remain` : ''}.</p>
    <p class="mt-2 text-sm">Kept current automatically: GitHub reads every feed hourly; if this page finds the capture more than 75 minutes old it starts a fresh read itself (at most every 30 minutes); and the page re-reads the published file every five minutes, and every minute while a read is running.</p>
    <details class="mt-2"><summary class="text-sm">Feed status</summary>${rows}</details>`;
}
function paint() {
  if (!ctxRef) return;
  const root = ctxRef.root, m = feed.meta(), all = dealFeed.consolidated(feed.rows()), h = feed.health();
  // A holding category narrows Universe to the family's private companies held that way, so it reads
  // as Portfolio here; the period default and the text follow it.
  const scope = ['portfolio', 'watchlist'].includes(ctxRef.scope) ? ctxRef.scope : heldCategory() ? 'portfolio' : 'universe';
  const { rows, holdingOf, matched } = scopeRows(all, scope);
  const searchText = root.querySelector('input')?.value;
  const focused = root.contains(document.activeElement) ? document.activeElement : null;
  const input = focused?.matches('input') ? { value:focused.value, start:focused.selectionStart, end:focused.selectionEnd } : null;
  const selected = focused?.matches('select') ? focused.getAttribute('aria-label') : null;
  const edge = focused?.dataset?.periodEdge || null;
  view = table?.view || view;
  // Search, sort and the other filters carry across a scope change; the period moves to the new
  // scope's own default only while it is still the old one's, since a week rarely holds the family's.
  if (view && viewScope && viewScope !== scope && view.filters?.[0] === PERIOD_DEFAULT[viewScope]) view = { ...view, filters: [PERIOD_DEFAULT[scope], ...view.filters.slice(1)] };
  viewScope = scope;
  const scroll = root.querySelector('[data-table-scroll]');
  const position = scroll ? { top:scroll.scrollTop, left:scroll.scrollLeft } : null;
  offTable?.(); offTable = null;
  const latestArticle = [...(m.articles || [])].filter(a => a.status === 'ok').sort((a,b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))[0];
  const weekEnd = latestWeekEnd(rows, istToday());
  const options = (key, label) => ({ label, options:[{ value:'all', label:`All ${label.toLowerCase()}` }, ...[...new Set(rows.map(r => r[key]).filter(v => v && !/^[-–—_]$/.test(v)))].sort().map(value => ({ value,label:value }))], match:(r,v) => v === 'all' || !v || r[key] === v });
  // Funding period: quick picks plus a From–To range, on each deal's own funding date (funding-period.js).
  const today = istToday(), days = rows.map(fundingDay).filter(Boolean).sort();
  const periodFilter = { label:'Funding period', value:PERIOD_DEFAULT[scope],
    options:PERIOD_PICKS.map(({ value, label }) => ({ value, label:value === 'latest' ? `Latest week (to ${weekEnd})` : label })),
    normalizeValue:normalizePeriod, accepts:isRangeValue, optionFor:value => ({ value, label:rangeLabel(value) }),
    match:periodMatcher({ today, weekEnd }) };
  const periodRange = rangeControl({ today, weekEnd, min:days[0] || '', max:[days.at(-1) || '', today].sort().at(-1) });
  table = scoreTable({ rows, key:r => r.id, name:r => r.company, watchKey:() => null, showWatchFilter:false,
    showRank:false, showAvatar:false, nameWrap:true, nameMaxPx:210, dense:true, wrapHeads:true, nameAfter:1,
    sub:r => [holdingOf(r) ? (nameKey(holdingOf(r).name) === nameKey(r.company) ? 'Family holding' : `Family holding · ${holdingOf(r).name}`) : '', r.conflicts?.length ? 'Sources differ' : '', r.sourceMissing ? 'Retained · removed from source' : ''].filter(Boolean).join(' · '),
    searchPlaceholder:'Search company, investor, sector or round...', searchable:r => [...fields.map(([key]) => valueOf(r, key)), holdingOf(r)?.name || '', ...sourceList(r).map(src => src.publisher)].join(' '),
    columns: [...fields.filter(([key]) => key !== 'company').map(([key,label]) => ({ label, get:r => cell(valueOf(r, key)), html:true, sortable:key !== 'amount', sortValue:r => key === 'date' ? r.dateISO || '' : valueOf(r, key) })),
      { label:'Sources', get:sourcesCell, html:true, sortable:true, sortValue:r => sourceList(r).length }],
    initialSort:{ key:'Deal date', dir:'desc' }, initialView:view,
    filters:[periodFilter,
      options('sector','Sectors'), fundingRoundFilter(rows), options('businessModel','Business models'),
      // Appended last, so a view saved before it existed keeps every earlier filter in its place.
      { label:'Deal types', options:[{ value:'all', label:'All deal types' }, { value:'funding', label:'Funding rounds' }, { value:'mna', label:'Acquisitions & mergers' }, { value:'talks', label:'In talks (reported)' }], match:(r,v) => !v || v === 'all' ? true : v === 'funding' ? r.kind === 'funding' || !r.kind : v === 'mna' ? r.kind === 'acquisition' || r.kind === 'merger' : r.status === 'talks' }],
    toolbarControls:periodRange,
    loading:!m.generatedAt && !m.readError,
    emptyMessage:emptyText(scope, all),
    countNoun:'deals', fillMode:'windowed', stickyHead:'max(320px, calc(100vh - 340px))', onRowClick:details,
    bookmarkDate:r => r.dateISO, bookmarkSource:r => sourceList(r)[0]?.publisher || 'Inc42 Funding Galore', link:r => safeUrl(r.sourceUrl || r.url), exportName:`glow-private-market-news-${scope}`,
    onExport:visible => exportRows({ filename:`glow-private-market-news-${scope}`, sheetName:'Private market funding', rows:visible,
      columns:[...(scope === 'portfolio' ? [{ key:'familyHolding', header:'Family holding (matched by exact name)', get:r => holdingOf(r)?.name || '', width:28 }] : []), ...fields.map(([key,header]) => ({ key,header,get:r => valueOf(r, key),width:key === 'investors' ? 70 : 24 })), { key:'acquirer', header:'Acquirer', get:r => r.acquirer || '' }, { key:'status', header:'Status', get:r => r.status === 'talks' ? 'In talks (reported)' : 'Announced' },
        { key:'sources', header:'Reported by (most credible first)', get:r => sourceList(r).map(src => `${src.publisher}: ${src.url}`).join('\n'), width:60 }, { key:'conflicts', header:'Where sources differ', get:r => (r.conflicts || []).map(c => `${c.field}: shown ${c.chosen.value} (${c.chosen.publisher}); also ${c.others.map(o => `${o.value} (${o.publisher})`).join(', ')}`).join('\n'), width:50 }, ...['sourceUrl','sourceTitle','publishedAt','firstSeenAt','updatedAt','sourceMissing'].map(key => ({ key,header:key,get:r => String(r[key] ?? '') })),
        { key:'notes',header:'Source footnotes',get:r => (m.articles || []).find(a => a.url === r.sourceUrl)?.notes?.join('\n') || '' }, { key:'sourceFields',header:'All original source fields',get:r => JSON.stringify(r.sourceFields) }, { key:'revisions',header:'Prior source versions',get:r => JSON.stringify(r.revisions || []) }] }),
  });
  root.innerHTML = `${sectionHead({ title:'Private Market', description:scopeText(scope, matched), meta:`<span class="text-xs text-slate-500">${esc(h.label)}</span>` })}
    ${table.html}<p class="mt-3 text-xs text-slate-500">Latest Inc42 roundup published ${esc(time(latestArticle?.publishedAt))} · Inc42 listing checked ${esc(time(m.sourceCheckedAt))} · ${newsLine()} · <button type="button" data-private-market-coverage class="text-brand-600 hover:underline">Coverage & source notes</button></p>`;
  offTable = table.wire(root); root.querySelector('[data-private-market-coverage]').onclick = coverage;
  const next = root.querySelector('[data-table-scroll]'); if (position && next) { next.scrollTop = position.top; next.scrollLeft = position.left; }
  const search = root.querySelector('input'); if (search && searchText != null) search.value = searchText;
  if (edge) root.querySelector(`[data-period-edge="${edge}"]`)?.focus({ preventScroll:true });
  else if (input) { const field = root.querySelector('input'); if (field && field.value === input.value) { field.focus({ preventScroll:true }); field.setSelectionRange(input.start, input.end); } }
  if (selected) [...root.querySelectorAll('select')].find(s => s.getAttribute('aria-label') === selected)?.focus({ preventScroll:true });
}
export function render(ctx) {
  ctxRef = ctx;
  if (!disposers.length) {
    // The multi-publisher capture is re-read on the same visible-page cadence as the Inc42 table.
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void dealFeed.load(); }, 5 * 60000);
    disposers = [feed.onChange(paint), dealFeed.onChange(paint), feed.bindLifecycle(), () => clearInterval(timer),
      refreshRegistry.register('private-market-news', { label:'Private Market', refresh:() => Promise.all([feed.refresh(), dealFeed.refresh()]).then(([r]) => r) })];
  }
  paint(); void feed.load(); void dealFeed.load();
  if ((ctx.scope === 'portfolio' || heldCategory()) && !privateCompanies) void loadPrivateCompanies();
}
export function destroy() { offProfiles?.(); offProfiles = null; ctxRef = null; view = table?.view || view; offTable?.(); offTable = null; table = null; disposers.forEach(fn => fn()); disposers = []; }

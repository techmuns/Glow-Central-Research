// One explicitly selected bank; public Universe evidence only. No provider calls or scoring.
import { canonicalArticleUrl } from './filings-shared.js';
import { companyNewsAttribution, newsCanSupportAI, normalizeNewsText } from './company-news-attribution.js';
import { NOTE_OPENAI_INSTRUCTIONS } from './alert-notes-shared.js';
import { STORY_INSTRUCTIONS } from './alert-stories-shared.js';

export const BANK_PILOT_EXISTING_PROMPTS = Object.freeze([
  { name: 'Current factual AI summary prompt (OpenAI variant)', text: NOTE_OPENAI_INSTRUCTIONS },
  { name: 'Current story grouping prompt', text: STORY_INSTRUCTIONS },
]);

export const BANK_PILOT = Object.freeze({
  ticker: 'J&KBANK', name: 'Jammu & Kashmir Bank', industry: 'Banks',
  selectedFrom: '2026-10-29',
  aliases: ['Jammu Kashmir Bank', 'Jammu and Kashmir Bank', 'J&K Bank', 'J & K Bank'],
});
// Expand the screener export's abbreviated labels; membership still requires industry = Banks.
const BANK_NAMES = {
  UJJIVANSFB: 'Ujjivan Small Finance Bank', AUBANK: 'AU Small Finance Bank', TMB: 'Tamilnad Mercantile Bank',
  KOTAKBANK: 'Kotak Mahindra Bank', PNB: 'Punjab National Bank', SBIN: 'State Bank of India',
  IOB: 'Indian Overseas Bank', UNIONBANK: 'Union Bank of India', MAHABANK: 'Bank of Maharashtra',
  PSB: 'Punjab & Sind Bank', CENTRALBK: 'Central Bank of India',
};
export const BANK_PILOT_BRIEF = `Review the last seven Indian calendar dates, including today, for Jammu & Kashmir Bank (J&KBANK), using the dashboard's retained Universe evidence.
1. Company: include dated records explicitly attributed to J&K Bank. Keep source headlines, issuer names, dates and links.
2. Peers: identify other companies classified as Banks in the existing Universe. Name each peer beside its own developments; never present a peer's event as J&K Bank's event.
3. Industry: include banking, RBI, bank regulation, rates, liquidity, deposits, lending and asset-quality reporting even when J&K Bank is not named. State the banking topic; do not invent company-specific impact or causation.
4. Read all available records in the interval, including routine observations. Combine duplicate delivery of the same headline/link, preserve corrections and name the delivery sources. Do not treat syndication as independent confirmation.
5. Separate source publication dates from check times. Show failed, pending, stale and unavailable sources. An empty section means no matching dated records in the loaded evidence, not that no development occurred.
6. Context contributes no company priority, sentiment or recommendation. Report earnings, valuation or thesis implications only as questions supported by evidence. Never infer that a peer's result changes J&K Bank's earnings.
7. This pilot is Universe-only and covers one anchor bank. Do not expand other scopes or companies until the pilot has been assessed.`;

const isDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function bankPilotFirstDay(day) {
  if (!isDay(day)) return null;
  const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - 6);
  return date.toISOString().slice(0, 10);
}
const textOf = event => [event.headline, event.storyText, event.sourceRecord?.summary, event.detail].filter(Boolean).join(' ');
const isNews = event => ['news', 'market-news', 'twitter'].includes(event.feed);
export function bankingTopic(event) {
  const text = textOf(event), headline = event.headline || '';
  if (/\b(?:banks? on|vote banks?|robs? bank|bank heist|bank robbery)\b/i.test(headline)) return null;
  if (/\b(?:RBI|Reserve Bank of India|repo rate|cash reserve ratio|statutory liquidity ratio)\b/i.test(text)) return 'RBI, rates & regulation';
  if (/\b(?:deposit growth|credit.deposit ratio|net interest margins?|CASA ratio|bank credit)\b/i.test(text)) return 'Deposits, credit & margins';
  // This is an Indian bank's industry reading. A foreign market wrap or a bank analyst's
  // commodity forecast is not a banking development merely because its summary says “bank”.
  const indian = /\b(?:India|Indian|RBI)\b/i.test(text);
  if (!indian && /\b(?:China|Chinese|Japan|Japanese|US|U\.S\.|America|American|Europe|European|UK|Britain|British|yuan|yen|Nikkei|Wall Street)\b/i.test(headline)) return null;
  // A common surname or a river/food bank is not the banking industry.
  if (/\b(?:river|food|blood|seed|world) bank\b/i.test(text) && !/\b(?:banking|lenders?|deposits?|RBI)\b/i.test(text)) return null;
  if (!/\b(?:banks?|banking|lenders?)\b/i.test(headline) &&
      !/\b(?:Indian banks?|Indian banking|Indian lenders?|bank credit|bank deposits?|bank lending|banking sector)\b/i.test(text)) return null;
  if (/\b(?:Goldman Sachs|Morgan Stanley|JPMorgan|Bank of America|Deutsche Bank)\b/i.test(headline) &&
      !/\b(?:banking|deposits?|loans?|earnings|profit|capital|regulat|fraud|crisis)\b/i.test(headline)) return null;
  if (/\b(?:NPA|NPAs|non.performing|asset quality|provisioning|credit costs?|bad loans?)\b/i.test(text)) return 'Asset quality & credit costs';
  if (/\b(?:deposits?|credit growth|loan growth|lending|liquidity|net interest|margins?|NIM|CASA)\b/i.test(text)) return 'Deposits, credit & margins';
  if (/\b(?:regulat|rules?|compliance|capital adequacy|fraud|cyber)/i.test(text)) return 'Bank regulation & risk';
  return 'Banking industry';
}

const sourceName = event => event.sourceRecord?.publisher || event.sourceRecord?.source || event.publisher || event.feedLabel || event.feed;
const sourceLink = event => { try { const u = new URL(event.url); return ['https:', 'http:'].includes(u.protocol) ? u.href : null; } catch { return null; } };
function keyOf(event) {
  let url = sourceLink(event);
  if (url) {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) if (/^(?:utm_|fbclid$|gclid$)/i.test(key)) parsed.searchParams.delete(key);
    parsed.hash = ''; url = canonicalArticleUrl(parsed.href);
  }
  return `${url || `${event.feed}:${event.id}`}|${event.day}|${normalizeNewsText(event.headline)}`;
}

/** Merge delivery copies without merging distinct source corrections. No presentation cap. */
function combine(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = keyOf(row.event), prior = byKey.get(key);
    if (prior) {
      prior.sources = [...new Set([...prior.sources, ...row.sources])];
      prior.companies = [...new Set([...prior.companies, ...row.companies])];
      prior.eventIds.push(row.event.id);
    } else byKey.set(key, { ...row, eventIds: [row.event.id] });
  }
  const relevance = row => row.event.importance === 'high' ? 3 :
    ['announcements', 'nse-filings'].includes(row.event.feed) ? 2.5 :
    row.topic && row.topic !== 'Banking industry' ? 2 : 1;
  return [...byKey.values()].sort((a, b) => relevance(b) - relevance(a) || b.event.day.localeCompare(a.event.day) ||
    String(b.event.time || '').localeCompare(String(a.event.time || '')) || a.event.headline.localeCompare(b.event.headline));
}

export function buildBankPilot(report, universe = []) {
  if (report?.scope !== 'universe' || !isDay(report.day)) return null;
  const banks = universe.filter(company => company.industry === BANK_PILOT.industry).map(company => ({
    ...company, name: BANK_NAMES[company.ticker] || company.name,
    aliases: [...(company.aliases || []), ...(company.ticker === 'CENTRALBK' ? [] : [company.name]),
      ...(company.ticker === 'KOTAKBANK' ? ['Kotak Bank'] : [])],
  }));
  const peers = banks.filter(company => company.ticker !== BANK_PILOT.ticker);
  const byTicker = new Map(banks.map(company => [company.ticker, company]));
  const anchor = { ...BANK_PILOT };
  const identities = [anchor, ...peers];
  const names = identities.map(identity => ({ identity, phrases: [identity.name, identity.ticker, ...(identity.aliases || [])]
    .map(normalizeNewsText).filter(Boolean) }));
  const firstDay = bankPilotFirstDay(report.day);
  const groups = { company: [], peers: [], industry: [] };
  let undated = 0;
  for (const event of report.pilotEvents || report.events || []) {
    if (event.familyPrivate || event.private || event.portfolioOnly) continue;
    if (!isDay(event.day)) { undated++; continue; }
    if (event.day < firstDay || event.day > report.day) continue;
    const ticker = String(event.ticker || '').toUpperCase();
    let company = ticker === anchor.ticker ? anchor : byTicker.get(ticker);
    // A search match, theme exposure or related subsidiary is not the named issuer's event.
    if (company && isNews(event) && !newsCanSupportAI(event)) company = null;
    let named = [];
    if (isNews(event)) {
      const row = { title: event.headline, summary: event.storyText || event.sourceRecord?.summary || event.detail };
      const text = ` ${normalizeNewsText(`${row.title || ''} ${row.summary || ''}`)} `;
      named = names.filter(({ identity, phrases }) => phrases.some(phrase => text.includes(` ${phrase} `)) &&
        companyNewsAttribution(row, identity).status === 'confirmed').map(row => row.identity);
      if (!company) company = named.find(identity => identity.ticker === anchor.ticker) || named[0];
    }
    const topic = isNews(event) ? bankingTopic(event) : null;
    if (!company && !topic) continue;
    const group = company ? company.ticker === anchor.ticker ? 'company' : 'peers' : 'industry';
    groups[group].push({ event, topic, companies: company ? [...new Set([company.name, ...named.map(identity => identity.name)])] : [],
      relation: group === 'company' ? 'Company record' : group === 'peers' ? `Peer · ${company.name}` : `Industry · ${topic}`,
      sources: [sourceName(event)], url: sourceLink(event) });
  }
  // A headline delivered for several issuers is shown once, under the anchor first, with every
  // named peer retained. It cannot look like three independent confirmations.
  const seen = new Map();
  for (const group of ['company', 'peers', 'industry']) {
    groups[group] = combine(groups[group]).filter(row => {
      const key = keyOf(row.event), prior = seen.get(key);
      if (!prior) { seen.set(key, row); return true; }
      prior.sources = [...new Set([...prior.sources, ...row.sources])];
      prior.companies = [...new Set([...prior.companies, ...row.companies])];
      prior.eventIds.push(...row.eventIds); return false;
    });
  }
  return { anchor, peers, firstDay, day: report.day, groups, undated,
    metadataUnavailable: !byTicker.has(anchor.ticker), pending: report.pending || 0,
    feeds: (report.feeds || []).filter(feed => feed.id !== 'private-company-alerts') };
}

const md = value => String(value || '').replace(/[\[\]<>]/g, '').replace(/\r?\n/g, ' ');
export function bankPilotMarkdown(pilot) {
  if (!pilot) return '';
  const lines = [`# ${BANK_PILOT.name}: company, peers & industry`, '',
    `Universe pilot · ${pilot.firstDay} through ${pilot.day} (IST, inclusive).`,
    `Selected as the largest bank holding in the ${BANK_PILOT.selectedFrom} statement snapshot. This is not a current broker ownership claim.`, '',
    'These are retained source readings. Peer/industry context changes no company priority or investment recommendation. Coverage is limited to captured sources and their successful checks.', '',
    `Peers (${pilot.peers.length}, Universe industry = Banks): ${pilot.peers.map(company => `${company.name} (${company.ticker})`).join(', ') || 'Universe classifications unavailable'}.`, ''];
  for (const [key, label] of [['company', 'Company'], ['peers', 'Peers'], ['industry', 'Industry']]) {
    lines.push(`## ${label} (${pilot.groups[key].length})`, '');
    if (!pilot.groups[key].length) lines.push('No matching dated records in the loaded evidence. This does not establish that no development occurred.', '');
    for (const row of pilot.groups[key]) lines.push(`- ${row.event.day}${row.event.time ? ` ${row.event.time} IST` : ''} · ${md(row.relation)} · ${md(row.sources.join(', '))}: ${row.url ? `[${md(row.event.headline)}](${row.url.replace(/\)/g, '%29')})` : md(row.event.headline)}${row.companies.length > 1 ? ` · Also names: ${row.companies.slice(1).map(md).join(', ')}` : ''}`);
    lines.push('');
  }
  lines.push('## Source coverage', '', `Pending feeds: ${pilot.pending}. Undated loaded records excluded: ${pilot.undated}.`,
    'Source check times below are capture checks, not this report generation time. Publication times stay on individual records. A successful feed check does not certify exhaustive Universe/company/category coverage.', '');
  for (const feed of pilot.feeds) lines.push(`- ${md(feed.label || feed.id)}: ${md(feed.status || 'unread')}${feed.reachesToday === false ? ', does not reach today' : ''}; source as of ${md(feed.asOf) || 'unavailable'}.${feed.note ? ` ${md(feed.note)}` : ''}`);
  lines.push('', '## Pilot reading brief', '', 'Company ranking is deterministic. Existing optional AI summaries and story grouping use the separate prompts below. This pilot groups retained evidence without an additional model call.', '', BANK_PILOT_BRIEF, '');
  for (const prompt of BANK_PILOT_EXISTING_PROMPTS) lines.push(`## ${prompt.name}`, '', '```text', prompt.text, '```', '');
  return lines.join('\n');
}

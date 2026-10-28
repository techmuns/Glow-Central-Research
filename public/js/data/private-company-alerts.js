// THE FAMILY'S PRIVATE COMPANIES AS ALERT EVIDENCE (GLOW-OWNED). Two public captures, joined to the
// private companies in the GlowVentures book (`privateCompanies` in portfolio-companies.json):
//   • headlines that name one — matched once per news capture by scripts/build-private-company-news.mjs
//     into data/private-company-news.json, so the browser never reads the 31 MB news archive;
//   • Inc42 funding rounds — matched here against the Private Market capture the browser already reads.
// Both joins are exact reviewed names. A name in a headline is not a verified event, a reported round
// is Inc42's report, and neither carries a direction of ours: every event is neutral.
import { revalidatedJson } from '../core/store.js';
import { record, istDay } from './alert-records.js';
import * as funding from './private-market-news.js';
import { privateCompanyMatcher, readPrivateCompanies } from './private-companies.js';

let companies = null, news = null, newsError = null, listError = null, pending = null;
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => fn());
funding.onChange(emit);

export function load() {
  pending ||= Promise.all([
    revalidatedJson('data/portfolio-companies.json').then((list) => { companies = readPrivateCompanies(list); listError = null; })
      .catch((error) => { listError = error?.message || 'unreadable'; }),
    revalidatedJson('data/private-company-news.json').then((value) => {
      if (value?.version !== 1 || !Array.isArray(value.events)) throw Error('Invalid private-company headline file');
      news = value; newsError = null;
    }).catch((error) => { newsError = error?.message || 'unreadable'; }),
    funding.load(),
  ]).then(emit).finally(() => { pending = null; });
  return pending;
}

const fields = (company) => ({ entityId: company.id, familyPrivate: true, holdingCategories: company.categories || [],
  privateHolding: { name: company.name, holdingCategories: company.categories || [] } });

export function newsRecord(event, company) {
  return record({ id: event.id, row: event, at: event.at || event.firstSeenAt, company: company.name,
    headline: event.title, detail: [event.publisher, event.summary].filter(Boolean).join(' · '), url: event.url, kind: 'news',
    importance: 'high', aiEligible: true, namesCompany: true,
    importanceReason: `The headline names ${company.name}, one of the family’s private companies.`,
    signalReason: 'A name in a headline, not a verified event; no direction is inferred.', ...fields(company) });
}

export function fundingRecord(row, company) {
  const round = row.round && !/^[-–—_]$/.test(row.round) ? ` · ${row.round}` : '';
  const amount = row.amount && !/^[-–—_]$/.test(row.amount) ? row.amount : 'an undisclosed amount';
  return record({ id: `pcf:${row.id}:${company.id}`, row, at: row.dateISO || row.publishedAt, company: company.name,
    headline: `${row.company} raised ${amount}${round} (reported by Inc42)`,
    detail: [row.leadInvestor && !/^[-–—_]$/.test(row.leadInvestor) ? `Lead: ${row.leadInvestor}` : '', row.investors ? `Investors: ${row.investors}` : ''].filter(Boolean).join(' · '),
    url: row.sourceUrl, kind: 'funding', importance: 'high', aiEligible: true,
    importanceReason: `Inc42 reports a funding round for ${company.name}, one of the family’s private companies.`,
    signalReason: 'A reported round, not a verified transaction; no direction is inferred.', ...fields(company) });
}

export function readFeed({ day } = {}) {
  const list = companies || [];
  const byId = new Map(list.map((c) => [c.id, c]));
  const events = [];
  for (const event of news?.events || []) { const company = byId.get(event.entityId); if (company) events.push(newsRecord(event, company)); }
  const match = privateCompanyMatcher(list);
  for (const row of funding.rows()) { const company = match(row.company); if (company) events.push(fundingRecord(row, company)); }
  const failed = !!(listError || newsError);
  const asOf = news?.newsCapturedAt || null;
  return { events, status: failed ? 'failed' : companies && news ? 'ok' : 'pending', asOf,
    reachesToday: !failed && !!istDay(asOf) && istDay(asOf) >= day,
    note: listError ? 'The family’s private-company list could not be read.'
      : newsError ? 'The private-company headline file could not be read; funding rounds are still matched.'
      : `${list.length} private companies from the Glow Ventures book. Headlines and Inc42 funding rounds that name one, by exact reviewed name.`,
    revision: `${news?.newsCapturedAt}:${news?.events?.length}:${list.length}:${funding.meta().generatedAt}` };
}

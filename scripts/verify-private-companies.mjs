// The family's private companies: which book lines are companies, what each is called, and that a
// funding record joins one only on an exact name. Offline; no server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { privateCompaniesFrom, privateCompanyMatcher, readPrivateCompanies, nameKey } from '../public/js/data/private-companies.js';

const line = (securityKey, security, over = {}) => ({ securityKey, security, assetClass: 'Unlisted', marketSide: 'private', valuedAtCost: true, isin: null, ...over });
const companies = privateCompaniesFrom([
  line('waterwala-labs-private-limited-drink-prime', 'Waterwala Labs Private Limited - Drink Prime'),
  line('ajay-jain-drink-prime', 'Ajay Jain - Drink Prime'),
  line('zepto', 'Zepto', { valuedAtCost: false }),
  line('everest-fleet', 'Everest Fleet Private Ltd - SIDDHARTH LADSARIYA', { isin: 'INE0LTR01029' }),
  line('lv-angel-fund-lets-venture-hoopr-vaibhav-karnavat', 'LV Angel Fund - Lets Venture (HOOPR) - VAIBHAV KARNAVAT', { assetClass: 'AIF' }),
  line('blue-ashva-india-pool-account', 'Blue Ashva India Pool Account', { assetClass: 'AIF' }),
  line('borosil-renewables-limited-warrants-13ag26', 'Borosil Renewables - Warrants 13AG26'),
  line('mother-india-forming', 'MOTHER INDIA FORMING PRIVATE LIMITED'),
  line('listed', 'Listed Co', { assetClass: 'Equity', marketSide: 'listed' }),
]);
const byName = Object.fromEntries(companies.map((c) => [c.name, c]));
assert.deepEqual(Object.keys(byName).sort(), ['DrinkPrime', 'Everest Fleet', 'Hoopr', 'Mother India Forming', 'Zepto'],
  'unlisted lines and reviewed single-company vehicles are companies; a pooled fund, a warrant and listed equity are not');
assert.deepEqual(byName.DrinkPrime.bookNames, ['Waterwala Labs Private Limited - Drink Prime', 'Ajay Jain - Drink Prime'], 'every line of one company sits under it');
assert.equal(byName['Everest Fleet'].bookNames[0], 'Everest Fleet Private Ltd - SIDDHARTH LADSARIYA', 'the person a line came through is never the company');
assert.deepEqual(byName['Everest Fleet'].isins, ['INE0LTR01029']);
assert.deepEqual(byName.Zepto.categories, ['unlisted'], 'a holding not carried at cost is Unlisted');
assert.deepEqual(byName.Hoopr.categories, ['private-investment'], 'a holding carried at cost is a Private Investment');

const match = privateCompanyMatcher(companies);
for (const [deal, company] of [['DrinkPrime', 'DrinkPrime'], ['Drink Prime', 'DrinkPrime'], ['Waterwala Labs Pvt Ltd', 'DrinkPrime'],
  ['Everest Fleet', 'Everest Fleet'], ['HOOPR', 'Hoopr'], ['Zepto', 'Zepto']]) assert.equal(match(deal)?.name, company, `${deal} is ${company}`);
for (const deal of ['Zeptonow', 'Zepto Cafe', 'Everest', 'Fleet', 'Ajay Jain', 'Siddharth Ladsariya', 'LV Angel Fund', 'Blue Ashva India Pool Account', ''])
  assert.equal(match(deal), null, `${deal || '(blank)'} matches nothing: exact names only, never the person or vehicle`);
const shared = privateCompanyMatcher([{ name: 'Alpha', aliases: ['Common Name'] }, { name: 'Beta', aliases: ['Common Name'] }]);
assert.equal(shared('Common Name'), null, 'a name two companies share matches neither');
assert.equal(shared('Alpha').name, 'Alpha');
assert.equal(nameKey('Stay Vista Private Limited'), nameKey('StayVista'), 'spacing and legal suffixes do not make two names');

assert.deepEqual(readPrivateCompanies([]), [], 'an older list with no private companies reads as none, never throws');
assert.deepEqual(readPrivateCompanies({ privateCompanies: [{ id: 'bad' }, ...companies] }).length, companies.length, 'a malformed entry is dropped');

// The shipped list, once the daily sync has published one, follows the same rules.
const shipped = JSON.parse(readFileSync(new URL('../public/data/portfolio-companies.json', import.meta.url), 'utf8'));
const published = readPrivateCompanies(shipped);
assert.equal(published.length, (shipped.privateCompanies || []).length, 'every published private company is well formed');
assert.equal(new Set(published.map((c) => c.id)).size, published.length, 'one entry per company');
// HEADLINES: a whole reviewed name, written as a proper noun, in the headline.
const { privateHeadlineMatcher } = await import('../public/js/data/private-companies.js');
const named = privateHeadlineMatcher([...companies, { id: 'private:perplexity', name: 'Perplexity', aliases: [], categories: ['private-investment'] },
  { id: 'private:incredholdings', name: 'InCred Holdings', aliases: [], categories: ['private-investment'] }]);
for (const [headline, expected] of [
  ['FSSAI issues notice to Zepto over expired besan', ['Zepto']], ['Stay Vista raises funds', []],
  ['Drink Prime and Zepto in talks', ['DrinkPrime', 'Zepto']], ['Waterwala Labs files results', ['DrinkPrime']],
  ['Aravind Srinivas’ startup before Perplexity', ['Perplexity']], ['to the perplexity of investors', []],
  ['InCred sees 29% upside in UltraTech', []], ['InCred Holdings files DRHP', ['InCred Holdings']],
  ['Zeptonow and zepto deliveries', []], ['Ajay Jain joins board', []], ['Everest base camp fleet', []],
]) assert.deepEqual(named(headline).map((c) => c.name).sort(), expected.sort(), headline);

// AS ALERT EVIDENCE: neutral, high, the family's own holding, visible under Portfolio and Universe only.
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { newsRecord, fundingRecord } = await import('../public/js/data/private-company-alerts.js');
const { matchesAlertScope } = await import('../public/js/data/daily-alerts.js');
const { rankReport, withPositionSnapshot } = await import('../public/js/data/ai-alerts.js');
const { holdingCategoryMatcher, offeredHoldingCategories } = await import('../public/js/data/holding-categories.js');
const zepto = byName.Zepto, hoopr = byName.Hoopr;
const story = newsRecord({ id: 'pcn:1:private:zepto', entityId: zepto.id, at: '2026-10-19T10:12:00Z', title: 'FSSAI issues notice to Zepto', url: 'https://example.test/zepto', publisher: 'Mint' }, zepto);
const round = fundingRecord({ id: 'a'.repeat(24), company: 'Hoopr', amount: '$451K', round: 'Pre-Series A', investors: 'Inflection Point Ventures', leadInvestor: '–', dateISO: '2026-10-20', sourceUrl: 'https://inc42.com/buzz/x/' }, hoopr);
for (const event of [story, round]) {
  assert.equal(event.direction, 'neutral', 'no direction of ours on a headline or a reported round');
  assert.equal(event.importance, 'high'); assert.equal(event.aiEligible, true); assert.equal(event.ticker, null);
  assert.equal(event.familyPrivate, true);
  assert.equal(matchesAlertScope(event, { scope: 'portfolio', wanted: new Set(), entityIds: new Set() }), true);
  assert.equal(matchesAlertScope(event, { scope: 'universe', wanted: null, entityIds: new Set() }), true);
  assert.equal(matchesAlertScope(event, { scope: 'watchlist', wanted: new Set(), entityIds: new Set() }), false);
}
assert.equal(round.headline, 'Hoopr raised $451K · Pre-Series A (reported by Inc42)');
assert(!/Lead:/.test(round.detail), 'a dash is not a lead investor');
const feeds = [{ id: 'private-companies', status: 'ok', reachesToday: true }];
const ranked = rankReport({ day: '2026-10-28', scope: 'portfolio', feeds, events: [{ ...story, feed: 'private-companies' }, { ...round, feed: 'private-companies' }] }, { holdings: [] });
const zeptoCard = ranked.allCards.find((c) => c.key === zepto.id);
assert(zeptoCard && ranked.cards.includes(zeptoCard), 'a nine-day-old headline on a family private company stays on the list');
assert.equal(zeptoCard.holding, true); assert.equal(zeptoCard.familyPrivate, true);
assert.deepEqual(zeptoCard.holdingCategories, ['unlisted']);
assert.deepEqual(ranked.allCards.find((c) => c.key === hoopr.id).holdingCategories, ['private-investment']);
const sized = withPositionSnapshot(ranked, { sizes: { complete: true, basis: 'listed-market-value' }, holdings: [{ ticker: 'LISTED', weightPct: 100 }] });
assert(sized.cards.some((c) => c.key === zepto.id), 'listed position sizes do not remove a private company from Portfolio');
assert.equal(holdingCategoryMatcher([], 'unlisted')(zeptoCard), true);
assert.equal(holdingCategoryMatcher([], 'private-investment')(zeptoCard), false);
assert.deepEqual(offeredHoldingCategories([{ holdingCategories: ['pms'] }, { holdingCategories: zeptoCard.holdingCategories }]).map(([id]) => id), ['all', 'pms', 'unlisted']);

console.log(`PASS private companies: company lines, reviewed names, categories, exact-name funding and headline joins, alert scope and ranking · ${published.length} published`);

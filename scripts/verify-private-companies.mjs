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
console.log(`PASS private companies: company lines, reviewed names, categories and exact-name funding joins · ${published.length} published`);

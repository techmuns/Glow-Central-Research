#!/usr/bin/env node
// Offline test for Private Market's company card data: the homepage parser, the identity check that
// keeps a guessed website from describing a different company, the lookup chain against stubbed
// sources, the merge that never drops a held description, the run order, and the round folding.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  readHomepage, namesCompany, candidateDomains, isPlaceholder, usableDescription, clip, leadSentences,
  validProfiles, roundsFor, profileKey, validSource, titleIsCompany,
} from '../public/js/data/private-company-profiles-shared.js';
import { lookupCompany, merge, queue, companiesFrom } from './build-private-company-profiles.mjs';

// --- homepage parsing --------------------------------------------------------------------------
const page = readHomepage(`<html><head><title>altM | Climate Tech</title><meta property="og:site_name" content="altM">
  <meta content="altM turns agricultural waste into bio-based materials that replace petrochemicals in everyday products &amp; packaging." name="description"></head></html>`);
assert.equal(page.siteName, 'altM');
assert.match(page.description, /agricultural waste .* & packaging\.$/, 'attribute order and entities are read');
assert.equal(readHomepage(`<script type="application/ld+json">{"@graph":[{"@type":"Organization","description":"Wealth advisory platform for Indian investors offering unbiased mutual fund advice."}]}</script>`).description,
  'Wealth advisory platform for Indian investors offering unbiased mutual fund advice.', 'JSON-LD Organization description is a fallback');

// --- identity: a guessed site must name the company as whole words -------------------------------
assert(namesCompany('PowerUp Money – Unbiased advice', 'PowerUp Money'));
assert(namesCompany('Power Up Money', 'PowerUp Money'), 'camel case and spacing are one name');
assert(namesCompany('altM | Climate', 'altM'));
assert(!namesCompany('Altmanx Studio', 'altM'), 'a longer word is not the name');
assert(!namesCompany('Money matters', 'PowerUp Money'), 'part of a name is not the name');
assert(!namesCompany('', 'Zepto'));
assert(titleIsCompany('altM — Climate Tech', 'altM') && titleIsCompany('Zepto: 10-minute delivery', 'Zepto') && titleIsCompany('Home | PowerUp Money', 'PowerUp Money'));
assert(!titleIsCompany('Kiko Milano cosmetics', 'Kiko'), 'a guessed site must be titled as the company, not merely mention it');
assert(!titleIsCompany('Welcome to the Money blog', 'PowerUp Money'));
assert.deepEqual(candidateDomains('PowerUp Money Pvt Ltd'), ['com', 'in', 'co', 'ai', 'io', 'co.in'].map((t) => `https://powerupmoney.${t}/`));
assert.deepEqual(candidateDomains('AB'), [], 'too short to guess');

// --- placeholders and clipping ----------------------------------------------------------------
assert(isPlaceholder('This domain is for sale. Buy this domain today!'));
assert(isPlaceholder('Coming Soon'));
assert(!usableDescription('altM', 'altM'), 'a bare name is not a description');
assert(!usableDescription('Short line.', 'X'));
const long = 'word '.repeat(120).trim();
assert(clip(long).length <= 320 && clip(long).endsWith('…') && !clip(long).includes('wor…'), 'clipped on a word boundary');
assert.equal(leadSentences('One is here. Two is there. Three. Four is cut.'), 'One is here. Two is there. Three.');

// --- the file contract --------------------------------------------------------------------------
assert(validProfiles({ version: 1, profiles: {} }));
assert(!validProfiles({ version: 2, profiles: {} }));
assert(!validProfiles({ version: 1, profiles: { wrongkey: { name: 'altM', status: 'not-found', sources: [] } } }), 'a profile is filed under its own name');
assert(!validProfiles({ version: 1, profiles: { altm: { name: 'altM', status: 'found', sources: [] } } }), 'found needs a source');
assert(!validSource({ kind: 'wikipedia', text: 'x', url: 'https://evil.example/wiki/x' }), 'an encyclopaedia link must be on its own host');
assert(!validSource({ kind: 'website', text: 'x', url: 'javascript:alert(1)' }));
assert(validProfiles(JSON.parse(fs.readFileSync('public/data/private-company-profiles.json', 'utf8'))), 'the committed file is valid');

// --- the lookup chain, against stubbed sources --------------------------------------------------
const html = (title, description) => `<html><head><title>${title}</title><meta name="description" content="${description}"></head></html>`;
function stub(routes) {
  const seen = [];
  const fetcher = async (url) => {
    seen.push(url);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new TypeError('fetch failed');
    const [status, body, type = 'text/html'] = hit[1];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
  };
  return { fetcher, seen };
}
const emptySearch = { 'https://www.wikidata.org/w/api.php?action=wbsearchentities': [200, { search: [] }, 'application/json'] };
const at = () => '2026-11-12T00:00:00.000Z';

// 1. Wikidata names an Indian company with a website and an English article.
{
  const { fetcher } = stub({
    'https://www.wikidata.org/w/api.php?action=wbsearchentities': [200, { search: [{ id: 'Q1', label: 'Zepto (film)' }, { id: 'Q2', label: 'Zepto' }] }, 'application/json'],
    'https://www.wikidata.org/w/api.php?action=wbgetentities': [200, { entities: { Q2: { descriptions: { en: { value: 'Indian quick commerce company' } }, sitelinks: { enwiki: { title: 'Zepto (company)' } },
      claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q4830453' } } } }], P856: [{ mainsnak: { datavalue: { value: 'https://www.zeptonow.com/' } } }] } } } }, 'application/json'],
    'https://www.zeptonow.com/': [200, html('Zepto: 10-minute delivery', 'Order groceries, fruits, vegetables and daily essentials online and get them delivered in minutes.')],
    'https://en.wikipedia.org/api/rest_v1/page/summary/': [200, { type: 'standard', extract: 'Zepto is an Indian quick commerce company. It was founded in 2021. It is based in Mumbai. More text.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Zepto_(company)' } } }, 'application/json'],
  });
  const p = await lookupCompany('Zepto', { fetcher, now: at });
  assert.equal(p.status, 'found');
  assert.deepEqual(p.sources.map((s) => s.kind), ['website', 'wikipedia', 'wikidata'], 'own website first, then the encyclopaedias');
  assert.equal(p.website, 'https://www.zeptonow.com/');
  assert.equal(p.sources[1].text, 'Zepto is an Indian quick commerce company. It was founded in 2021. It is based in Mumbai.');
  assert.equal(p.wikidata, 'Q2');
}
// 2. No Wikidata entity: a parked .com is refused, the .in that names the company is read.
{
  const { fetcher, seen } = stub({ ...emptySearch,
    'https://altm.com/': [200, html('altm.com is for sale', 'This domain is for sale. Buy this domain today with a payment plan.')],
    'https://altm.in/': [200, html('altM — Climate Tech', 'altM turns agricultural residue into bio-based chemicals that replace petrochemicals in everyday products.')],
  });
  const p = await lookupCompany('altM', { fetcher, now: at });
  assert.equal(p.status, 'found');
  assert.equal(p.sources[0].kind, 'website'); assert.equal(p.website, 'https://altm.in/');
  assert(!seen.includes('https://altm.co/'), 'stops at the first verified homepage');
}
// 3. A guessed homepage whose title does not name the company is not that company's.
{
  const { fetcher } = stub({ ...emptySearch, 'https://kiko.com/': [200, html('Kiko Milano cosmetics', 'Italian cosmetics brand selling make-up and skincare products across Europe and Asia.')] });
  const p = await lookupCompany('Kiko', { fetcher, now: at });
  assert.equal(p.status, 'not-found', 'a reachable source that answers nothing is "not found"');
  assert.deepEqual(p.sources, []);
}
// 4. Nothing reachable at all is a failed read, not "not found".
{
  const p = await lookupCompany('Unreachable Co', { fetcher: async () => { throw new TypeError('fetch failed'); }, now: at });
  assert.equal(p.status, 'failed');
}
// 5. A Wikidata hit that is a person, or not Indian, is not the company.
{
  const { fetcher } = stub({
    'https://www.wikidata.org/w/api.php?action=wbsearchentities': [200, { search: [{ id: 'Q9', label: 'Ather' }] }, 'application/json'],
    'https://www.wikidata.org/w/api.php?action=wbgetentities': [200, { entities: { Q9: { descriptions: { en: { value: 'American software company' } }, claims: {} } } }, 'application/json'],
  });
  const p = await lookupCompany('Ather', { fetcher, now: at });
  assert.equal(p.wikidata, null);
}

// --- merge, order, companies ------------------------------------------------------------------
const held = { name: 'altM', status: 'found', sources: [{ kind: 'website', text: 'held', url: 'https://altm.in/' }], checkedAt: '2026-01-01T00:00:00.000Z', foundAt: '2026-01-01T00:00:00.000Z' };
const kept = merge(held, { name: 'altM', status: 'failed', sources: [], checkedAt: '2026-05-01T00:00:00.000Z' });
assert.equal(kept.status, 'found'); assert.equal(kept.sources[0].text, 'held'); assert.equal(kept.checkedAt, '2026-05-01T00:00:00.000Z', 'the re-check is recorded so it is not retried every run');
assert.equal(kept.lastCheck.status, 'failed');
assert.equal(merge(null, { status: 'not-found' }).status, 'not-found');

const deals = [
  { id: 'a', company: 'altM', dateISO: '2026-11-06' }, { id: 'b', company: 'Old Co', dateISO: '2024-01-01' },
  { id: 'c', company: 'New Co', dateISO: '2026-11-07' }, { id: 'd', company: 'DrinkPrime', dateISO: '2023-01-01' }, { id: 'e', company: 'Checked Co', dateISO: '2026-11-08' },
];
const companies = companiesFrom(deals, ['DrinkPrime']);
const now = Date.parse('2026-11-12T00:00:00Z');
const order = queue(companies, { checkedco: { name: 'Checked Co', status: 'not-found', checkedAt: '2026-11-01T00:00:00Z' }, oldco: { name: 'Old Co', status: 'not-found', checkedAt: '2026-01-01T00:00:00Z' } }, { now }).map((c) => c.name);
assert.deepEqual(order, ['DrinkPrime', 'New Co', 'altM', 'Old Co'], 'family first, then never looked up (newest round first), then the oldest answer; a recent answer waits');

// --- every round for one exact name -------------------------------------------------------------
const base = { sector: 'Clean Tech', subsector: 'Climate Tech', businessModel: 'B2B', investors: 'Rainmatter', leadInvestor: 'Rainmatter' };
const rounds = roundsFor('altM', [
  { ...base, id: '1', company: 'altM', date: '6 Nov 2026', dateISO: '2026-11-06', amount: '$10.3 Mn', round: 'Series A', sourceUrl: 'https://inc42.com/buzz/a/' },
  { ...base, id: '2', company: 'ALTM', date: '6 Nov 2026', dateISO: '2026-11-06', amount: '$10.3 Mn', round: 'Series A', sourceUrl: 'https://inc42.com/buzz/b/' },
  { ...base, id: '3', company: 'altM', date: '2 Feb 2024', dateISO: '2024-02-02', amount: '$3 Mn', round: 'Seed', sourceUrl: 'https://inc42.com/buzz/c/' },
  { ...base, id: '4', company: 'altM Labs', date: '1 Jan 2025', dateISO: '2025-01-01', amount: '$1 Mn', round: 'Seed', sourceUrl: 'https://inc42.com/buzz/d/' },
]);
assert.deepEqual(rounds.map((r) => r.round), ['Series A', 'Seed'], 'newest first; a different name is not this company');
assert.deepEqual(rounds[0].observations.map((o) => o.id), ['1', '2'], 'one round reported twice keeps both sources');
assert.equal(profileKey('altM Pvt Ltd'), profileKey('altM'));

console.log('PASS private company profiles: homepage parsing, whole-word identity for guessed sites, placeholders refused, lookup chain (Wikidata site + Wikipedia + Wikidata, guessed domain, wrong company, unreachable, non-Indian), merge keeps a held description, run order, exact-name round folding.');

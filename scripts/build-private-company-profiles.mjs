#!/usr/bin/env node
// PRIVATE COMPANY PROFILES (GLOW-OWNED) — a short description of each company in Private Market's
// funding capture, from the company's own homepage and the open encyclopaedias, written to
// public/data/private-company-profiles.json for the company card. Runs on a GitHub runner only
// (.github/workflows/private-company-profiles.yml); the browser never fetches a company's site.
//
// Per company, at most: two Wikidata reads, one Wikipedia summary, and up to seven homepages (the one
// Wikidata names, else <name>.com/.in/.co/.ai/.io/.co.in). A guessed homepage counts only when its own
// title or site name IS the company's name — see private-company-profiles-shared.js. Inc42 is
// never read here: the company list comes from the published funding capture.
//
// Order: the family's private companies, then companies never looked up (newest round first), then
// the oldest answers. A found description is re-checked after 90 days, "not found" after 30, a failed
// read after 1. A re-check that finds nothing never replaces a description already held.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PROFILE_VERSION, profileKey, readHomepage, usableDescription, titleIsCompany, candidateDomains,
  clip, leadSentences, safeHttpUrl, hostOf, validSource,
} from '../public/js/data/private-company-profiles-shared.js';

const UA = 'Mozilla/5.0 (compatible; GlowResearchProfiles/1.0; +https://github.com/techmuns/Glow-Central-Research)';
const DAY = 86400000;
const RECHECK = { found: 90 * DAY, 'not-found': 30 * DAY, failed: DAY };
const COMPANY_DESCRIPTION = /\b(company|startup|start-up|business|platform|brand|firm|manufacturer|maker|provider|marketplace|app|application|service|services|bank|lender|fintech|developer|retailer|chain|operator|producer|enterprise|venture|network|software)\b/i;
const NOT_A_COMPANY = /\b(village|city|town|river|district|film|album|song|actor|actress|politician|cricketer|footballer|singer|novel|species|genus|television|episode|given name|surname|family name|disambiguation|mountain|lake|person)\b/i;

/** A bounded GET: redirects followed (at most 4), size capped, never throws — returns null on any failure. */
export async function boundedGet(url, { fetcher = fetch, timeoutMs = 10000, maxBytes = 1_500_000, accept = 'text/html,application/xhtml+xml' } = {}) {
  let current = url;
  try {
    for (let hop = 0; hop < 5; hop++) {
      const response = await fetcher(current, { headers: { 'user-agent': UA, accept, 'accept-language': 'en-IN,en;q=0.8' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel?.();
        const next = location && safeHttpUrl(new URL(location, current).href); if (!next) return null;
        current = next; continue;
      }
      if (!response.ok) { await response.body?.cancel?.(); return { status: response.status, url: current, body: null }; }
      const chunks = []; let bytes = 0;
      if (response.body?.[Symbol.asyncIterator]) {
        for await (const chunk of response.body) { bytes += chunk.length; if (bytes > maxBytes) break; chunks.push(Buffer.from(chunk)); }
      } else chunks.push(Buffer.from(await response.text()));
      return { status: response.status, url: current, type: response.headers.get('content-type') || '', body: Buffer.concat(chunks).toString('utf8') };
    }
  } catch { return null; }
  return null;
}

const getJson = async (url, fetcher) => {
  const res = await boundedGet(url, { fetcher, accept: 'application/json', maxBytes: 2_000_000 });
  if (!res?.body) return { ok: false, reached: !!res };
  try { return { ok: true, reached: true, value: JSON.parse(res.body) }; } catch { return { ok: false, reached: true }; }
};

/** Wikidata: an entity whose label (or alias) IS the name, that is an Indian business and not a person or place. */
export async function wikidataLookup(name, { fetcher = fetch } = {}) {
  const key = profileKey(name);
  const search = await getJson(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&uselang=en&type=item&limit=7&search=${encodeURIComponent(name)}`, fetcher);
  if (!search.ok) return { reached: search.reached, entity: null };
  const ids = (search.value.search || []).filter((hit) => profileKey(hit.label) === key || profileKey(hit.match?.text) === key).map((hit) => hit.id).filter((id) => /^Q\d+$/.test(id)).slice(0, 5);
  if (!ids.length) return { reached: true, entity: null };
  const got = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&languages=en&props=claims|descriptions|sitelinks|labels&sitefilter=enwiki&ids=${ids.join('|')}`, fetcher);
  if (!got.ok) return { reached: got.reached, entity: null };
  for (const id of ids) {
    const entity = got.value.entities?.[id]; if (!entity) continue;
    const description = entity.descriptions?.en?.value || '';
    const claimIds = (prop) => (entity.claims?.[prop] || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
    if (claimIds('P31').includes('Q5') || NOT_A_COMPANY.test(description)) continue;
    const website = (entity.claims?.P856 || []).map((c) => safeHttpUrl(c.mainsnak?.datavalue?.value)).find(Boolean) || null;
    const indian = claimIds('P17').includes('Q668') || /\bindia/i.test(description) || /\.in\/?$/.test(hostOf(website || '') + '/');
    const business = COMPANY_DESCRIPTION.test(description) || !!website || claimIds('P452').length > 0;
    if (!indian || !business) continue;
    return { reached: true, entity: { id, description, website, enwiki: entity.sitelinks?.enwiki?.title || null } };
  }
  return { reached: true, entity: null };
}

export async function wikipediaLead(title, { fetcher = fetch } = {}) {
  const res = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, fetcher);
  if (!res.ok || res.value.type === 'disambiguation' || !res.value.extract) return null;
  const url = res.value.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  return { text: leadSentences(res.value.extract, 3), url };
}

/** A homepage's own description, when the page answers and (for a guess) names the company. */
export async function homepageLookup(url, name, { fetcher = fetch, guessed = true } = {}) {
  const res = await boundedGet(url, { fetcher });
  if (!res) return { reached: false };
  if (!res.body || (res.type && !/html/i.test(res.type))) return { reached: true };
  const page = readHomepage(res.body);
  if (guessed && ![page.title, page.siteName, page.ogTitle].some((text) => titleIsCompany(text, name))) return { reached: true };
  if (!usableDescription(page.description, name)) return { reached: true, website: guessed ? null : res.url };
  return { reached: true, website: res.url, text: page.description };
}

/** One company: every source tried, the answer it gives, and whether anything could be read at all. */
export async function lookupCompany(name, { fetcher = fetch, now = () => new Date().toISOString() } = {}) {
  const sources = []; let reachedAny = false; let website = null;
  const wiki = await wikidataLookup(name, { fetcher }); reachedAny ||= wiki.reached;
  const entity = wiki.entity;
  const tried = [];
  if (entity?.website) {
    tried.push(entity.website);
    const home = await homepageLookup(entity.website, name, { fetcher, guessed: false }); reachedAny ||= home.reached;
    website = home.website || entity.website;
    if (home.text) sources.push({ kind: 'website', text: clip(home.text), full: home.text.length > 320 ? home.text : undefined, url: home.website });
  }
  if (!sources.length) {
    for (const url of candidateDomains(name)) {
      if (tried.includes(url)) continue;
      const home = await homepageLookup(url, name, { fetcher }); reachedAny ||= home.reached;
      if (home.text) { website = home.website; sources.push({ kind: 'website', text: clip(home.text), full: home.text.length > 320 ? home.text : undefined, url: home.website }); break; }
    }
  }
  if (entity?.enwiki) {
    const lead = await wikipediaLead(entity.enwiki, { fetcher });
    if (lead?.text && usableDescription(lead.text, name)) sources.push({ kind: 'wikipedia', text: lead.text, url: lead.url });
  }
  if (entity?.description && entity.description.length >= 12) sources.push({ kind: 'wikidata', text: clip(entity.description), url: `https://www.wikidata.org/wiki/${entity.id}` });
  const at = now();
  const kept = sources.filter(validSource).map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)));
  return {
    name, status: kept.length ? 'found' : reachedAny ? 'not-found' : 'failed',
    website: safeHttpUrl(website), wikidata: entity?.id || null, sources: kept, checkedAt: at, ...(kept.length ? { foundAt: at } : {}),
  };
}

/** Unique companies in the capture, with the newest round date each carries. */
export function companiesFrom(deals = [], familyNames = []) {
  const byKey = new Map();
  for (const row of deals) {
    const key = profileKey(row.company); if (!key) continue;
    const held = byKey.get(key);
    const date = row.dateISO || '';
    if (!held || date > held.latest) byKey.set(key, { key, name: String(row.company).trim(), latest: date, family: held?.family || false });
  }
  for (const name of familyNames) { const c = byKey.get(profileKey(name)); if (c) c.family = true; }
  return [...byKey.values()];
}

/** Which companies to (re)check this run, in order. */
export function queue(companies, profiles = {}, { now = Date.now(), limit = 120 } = {}) {
  const due = (c) => { const p = profiles[c.key]; if (!p) return true; const at = Date.parse(p.checkedAt || ''); return !Number.isFinite(at) || now - at >= (RECHECK[p.status] ?? DAY); };
  const order = (a, b) => {
    if (a.family !== b.family) return a.family ? -1 : 1;
    const pa = profiles[a.key], pb = profiles[b.key];
    if (!pa !== !pb) return pa ? 1 : -1;
    if (!pa) return b.latest.localeCompare(a.latest);
    return String(pa.checkedAt || '').localeCompare(String(pb.checkedAt || ''));
  };
  return companies.filter(due).sort(order).slice(0, limit);
}

/** Fold one lookup into what is held: a re-check that found nothing keeps the description already held. */
export function merge(previous, next) {
  if (next.status === 'found' || !previous || previous.status !== 'found') return next;
  return { ...previous, checkedAt: next.checkedAt, lastCheck: { status: next.status, at: next.checkedAt } };
}

async function readDeals() {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
    try {
      const { privateMarketRelease } = await import('./lib/private-market-release.mjs');
      const transport = privateMarketRelease();
      const entry = await transport.latest();
      if (entry) { const capture = await transport.download(entry); console.log(`Funding capture: release asset ${entry.asset.name} (${capture.deals.length} rows)`); return capture.deals; }
    } catch (error) { console.warn(`Funding release unreadable (${error.message}); using the committed capture.`); }
  }
  const capture = JSON.parse(fs.readFileSync('public/data/private-market-news.json', 'utf8'));
  console.log(`Funding capture: committed file (${capture.deals.length} rows)`);
  return capture.deals;
}

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const item = items[next++]; await fn(item); } }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = path.resolve(process.env.PROFILES_FILE || 'public/data/private-company-profiles.json');
  const held = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: PROFILE_VERSION, profiles: {} };
  const profiles = held.profiles || {};
  const deals = await readDeals();
  // Companies the other publishers' capture names (funding and M&A), so their cards get a description too.
  try { const other = JSON.parse(fs.readFileSync('public/data/private-deals.json', 'utf8')).observations || []; deals.push(...other.filter((o) => o?.company).map((o) => ({ company: o.company, dateISO: o.dateISO || o.date || '' }))); } catch {}
  let family = [];
  try { family = (JSON.parse(fs.readFileSync('public/data/portfolio-companies.json', 'utf8')).privateCompanies || []).flatMap((c) => [c.name, c.legalName, ...(c.aliases || [])]).filter(Boolean); } catch {}
  const companies = companiesFrom(deals, family);
  const limit = Math.max(1, Number(process.env.PROFILES_LIMIT || 120));
  const todo = queue(companies, profiles, { limit });
  const deadline = Date.now() + Number(process.env.PROFILES_BUDGET_MS || 25 * 60000);
  const counts = { found: 0, 'not-found': 0, failed: 0, skipped: 0 };
  const write = () => {
    const out = { version: PROFILE_VERSION, generatedAt: new Date().toISOString(), companies: companies.length,
      looked: Object.keys(profiles).length, found: Object.values(profiles).filter((p) => p.status === 'found').length,
      profiles: Object.fromEntries(Object.entries(profiles).sort(([a], [b]) => a.localeCompare(b))) };
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(out)); fs.renameSync(file + '.tmp', file);
  };
  let done = 0;
  await pool(todo, Number(process.env.PROFILES_CONCURRENCY || 6), async (company) => {
    if (Date.now() > deadline) { counts.skipped++; return; }
    const result = await lookupCompany(company.name);
    profiles[company.key] = merge(profiles[company.key], result);
    counts[result.status]++;
    if (++done % 20 === 0) { write(); console.log(`${done}/${todo.length} looked up`); }
  });
  write();
  console.log(JSON.stringify({ companies: companies.length, queued: todo.length, ...counts, held: Object.keys(profiles).length }));
}

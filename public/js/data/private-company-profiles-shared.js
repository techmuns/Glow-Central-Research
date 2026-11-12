// PRIVATE COMPANY PROFILES (GLOW-OWNED) — the short "what does this company do" line on Private
// Market's company card, and the rules that decide whether a page is that company's at all. Pure:
// imported by scripts/build-private-company-profiles.mjs (which reads the pages on a runner) and by
// the browser (which only reads the committed result), so both use one definition.
//
// Three rules, and each is a rule the rest of this dashboard already runs on:
//  1. A description is somebody's own words, reproduced — the company's website meta description,
//     Wikipedia's lead or Wikidata's one-line description — never written or reworded here. A long
//     one is clipped on a word boundary with an ellipsis, and the whole text travels beside it.
//  2. A page is the company's only on evidence. A website named by Wikidata is the company's by that
//     record; a GUESSED domain (<name>.com, .in, …) counts only when the page's own title or site
//     name carries the company's name as whole words. A parked or "coming soon" page is no answer.
//  3. "Not found" and "not looked up yet" and "could not be read" are three different answers, and
//     the card says which. An empty description is never drawn as one.

import { nameKey } from './private-companies.js';

export const PROFILE_VERSION = 1;
export const DESCRIPTION_MAX = 320;
export const profileKey = (name) => nameKey(name);

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', copy: '©', reg: '®', trade: '™' };
export function decodeEntities(text = '') {
  return String(text).replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, key) => {
    if (key[0] !== '#') return NAMED[key.toLowerCase()] ?? all;
    const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}
export const cleanText = (text) => decodeEntities(String(text || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Clip on a word boundary; the full text is kept by the caller. */
export function clip(text, max = DESCRIPTION_MAX) {
  const value = cleanText(text);
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1).replace(/\s+\S*$/, '').replace(/[\s,;:–—-]+$/, '');
  return `${cut || value.slice(0, max - 1)}…`;
}

/** The first `count` sentences of an encyclopaedia lead, clipped. */
export function leadSentences(text, count = 3) {
  const value = cleanText(text);
  const sentences = value.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [value];
  return clip(sentences.slice(0, count).join(' ').trim());
}

const metaContent = (html, attr, name) => {
  const tags = String(html).match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
    if (key && key.toLowerCase() === name) {
      const content = tag.match(/\bcontent\s*=\s*"([^"]*)"/i)?.[1] ?? tag.match(/\bcontent\s*=\s*'([^']*)'/i)?.[1];
      if (content != null) return cleanText(content);
    }
  }
  return '';
};

function jsonLdDescription(html) {
  for (const block of String(html).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(block[1].trim()); } catch { continue; }
    const nodes = [data, ...(Array.isArray(data) ? data : []), ...(Array.isArray(data?.['@graph']) ? data['@graph'] : [])];
    for (const node of nodes) {
      const type = [].concat(node?.['@type'] || []).join(' ');
      if (/Organization|Corporation|LocalBusiness|WebSite/i.test(type) && typeof node.description === 'string' && node.description.trim()) return cleanText(node.description);
    }
  }
  return '';
}

/** What a homepage says about itself: names (for the identity check) and its own description. */
export function readHomepage(html = '') {
  const head = String(html).slice(0, 400000);
  const title = cleanText(head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  return {
    title,
    siteName: metaContent(head, 'property', 'og:site_name') || metaContent(head, 'name', 'application-name'),
    ogTitle: metaContent(head, 'property', 'og:title'),
    description: metaContent(head, 'name', 'description') || metaContent(head, 'property', 'og:description')
      || metaContent(head, 'name', 'twitter:description') || jsonLdDescription(head),
  };
}

const PLACEHOLDER = /\b(domain (?:name )?(?:is |may be )?for sale|buy this domain|this domain|parked (?:free|domain)|domain parking|sedo|godaddy|hugedomains|dan\.com|coming soon|under construction|website (?:is )?under maintenance|index of \/|account suspended|default web site page|welcome to nginx|it works!|lorem ipsum)\b/i;
export const isPlaceholder = (text = '') => PLACEHOLDER.test(text);
/** A description worth printing: a sentence's worth of words, not a placeholder or a bare name. */
export function usableDescription(text, name = '') {
  const value = cleanText(text);
  if (value.length < 40 || isPlaceholder(value)) return false;
  return nameKey(value) !== nameKey(name);
}

/** "PowerUp Money" → ['power','up','money']: camel-case and punctuation both split words. */
export function nameTokens(name = '') {
  return String(name).replace(/\b(private|pvt|limited|ltd|llp|plc)\b\.?/gi, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
}
/** Does this text carry the company's name as whole words ("PowerUp Money" in "Powerup Money | Invest")? */
export function namesCompany(text = '', name = '') {
  const tokens = nameTokens(name); if (!tokens.length) return false;
  const hay = ` ${String(text).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\s${tokens.map(escape).join('\\s*')}\\s`).test(hay);
}

/**
 * The stricter test a GUESSED homepage must pass: one segment of its own title or site name IS the
 * company's name ("altM — Climate Tech", "Zepto: 10-minute delivery"), not merely contains it — so
 * kiko.com titled "Kiko Milano cosmetics" is not the Indian startup called Kiko.
 */
export function titleIsCompany(text = '', name = '') {
  const key = nameKey(name); if (!key) return false;
  return String(text).split(/\s+[-|–—:·•]\s+|[|–—:·•]/)
    .map((segment) => nameKey(segment.replace(/\b(home ?page|home|official (?:web)?site|welcome to)\b/gi, ' ')))
    .some((segment) => segment === key);
}

/** Homepages worth guessing for a name, most likely first. Only checked against the page's own title. */
export function candidateDomains(name = '') {
  const slug = nameKey(name);
  if (slug.length < 3 || slug.length > 40) return [];
  return ['com', 'in', 'co', 'ai', 'io', 'co.in'].map((tld) => `https://${slug}.${tld}/`);
}

export const safeHttpUrl = (value) => { try { const u = new URL(value); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; } };
export const hostOf = (value) => { try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; } };

const SOURCE_KINDS = new Set(['website', 'wikipedia', 'wikidata']);
const SOURCE_HOSTS = { wikipedia: /^https:\/\/en\.wikipedia\.org\/wiki\//, wikidata: /^https:\/\/www\.wikidata\.org\/wiki\/Q\d+$/ };
/** A source the card may link to: a known kind, an http(s) address, and the expected host for the encyclopaedias. */
export function validSource(source) {
  if (!source || !SOURCE_KINDS.has(source.kind) || typeof source.text !== 'string' || !source.text.trim()) return false;
  const url = safeHttpUrl(source.url); if (!url) return false;
  return !SOURCE_HOSTS[source.kind] || SOURCE_HOSTS[source.kind].test(url);
}

/** The committed file, checked field by field before the card reads a word of it. */
export function validProfiles(value) {
  if (value?.version !== PROFILE_VERSION || !value.profiles || typeof value.profiles !== 'object' || Array.isArray(value.profiles)) return false;
  return Object.entries(value.profiles).every(([key, p]) => p && typeof p === 'object' && typeof p.name === 'string' && profileKey(p.name) === key
    && ['found', 'not-found', 'failed'].includes(p.status) && Array.isArray(p.sources) && p.sources.every(validSource)
    && (p.status !== 'found' || p.sources.length > 0) && (p.website == null || !!safeHttpUrl(p.website)));
}

const roundFields = (row) => ['date', 'amount', 'round', 'investors', 'leadInvestor', 'sector', 'subsector', 'businessModel'].map((k) => String(row[k] || '').trim().toLowerCase()).join('\u0001');
/**
 * Every captured round for one company, by its EXACT normalised name. Repeated mentions in different
 * roundups share one entry only when every reported field matches, and every source link is kept —
 * not a verified transaction count, and the card says so. Newest first; an undated row last.
 */
export function roundsFor(name, deals = []) {
  const key = profileKey(name); if (!key) return [];
  const groups = new Map();
  for (const row of deals) {
    if (profileKey(row.company) !== key) continue;
    const id = roundFields(row);
    const group = groups.get(id) || { ...row, observations: [] };
    group.observations.push({ id: row.id, sourceUrl: row.sourceUrl, sourceTitle: row.sourceTitle, publishedAt: row.publishedAt || null, sourceMissing: !!row.sourceMissing });
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => (b.dateISO || '').localeCompare(a.dateISO || '') || String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
}

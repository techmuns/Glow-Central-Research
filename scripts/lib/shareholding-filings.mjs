// Read original exchange XBRL, never the provisional NSE SDD testing feed.
import { createHash } from 'node:crypto';

export const hash = (text) => createHash('sha256').update(text).digest('hex');
export const textOf = (text = '') => String(text).replace(/<[^>]*>/g, ' ').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)))
  .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (s) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[s]).replace(/\s+/g, ' ').trim();
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(['"])(.*?)\2/gs)].map((m) => [m[1].toLowerCase(), textOf(m[3])]));
export function day(value) {
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const date = s.slice(0, 10);
    return Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date ? date : null;
  }
  const m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3}|\d{1,2})[-/ ](\d{4})/);
  if (!m) return null;
  const month = /^\d+$/.test(m[2]) ? Number(m[2]) : ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(m[2].toUpperCase()) + 1;
  const out = `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return month && Number.isFinite(Date.parse(out)) && new Date(out).toISOString().slice(0, 10) === out ? out : null;
}
export function sourceUrl(value, base = 'https://www.bseindia.com') {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || !['www.bseindia.com', 'nsearchives.nseindia.com', 'archives.nseindia.com'].includes(url.hostname) || url.username || url.password) throw new Error('Unexpected filing host');
  return url.href;
}
export function filingTime(value) {
  const date = day(value), time = String(value || '').match(/(?:T| )(\d{2}:\d{2}:\d{2})/)?.[1] || '00:00:00';
  return date ? `${date}T${time}+05:30` : null;
}
export function parseIndex(body, sourceId) {
  const rows = sourceId === 'bse' ? body?.Table : body;
  if (!Array.isArray(rows)) throw new Error('Shareholding index is not an array');
  return rows.map((r) => {
    const bse = sourceId === 'bse';
    const rawUrl = bse ? r.XBRLAttachment : r.xbrl;
    const result = { sourceId, company: bse ? r.Company_NAme : r.name,
      bseCode: bse ? String(r.FLD_ScripCode) : null, ticker: bse ? null : r.symbol, isin: bse ? null : r.isin,
      indexAsOf: day(bse ? r.EndDate : r.date), filedAt: filingTime(bse ? r.D : r.broadcastDate || r.submissionDate),
      sourceUrl: rawUrl ? sourceUrl(rawUrl) : null };
    if (!result.company || !result.indexAsOf || !result.filedAt) throw new Error('Incomplete shareholding index row');
    result.id = `${sourceId}-${hash(result.sourceUrl || JSON.stringify(result)).slice(0, 20)}`;
    return result;
  });
}
const number = (f) => {
  if (!f || f.attrs['xsi:nil'] === 'true') return null;
  const value = f.value.replace(/,/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  return Number(value) * 10 ** Number(f.attrs.scale || 0) * (f.attrs.sign === '-' ? -1 : 1);
};
export function parseFiling(xml, entry, checkedAt = new Date().toISOString(), securityMap = {}, nseMaster = {}) {
  if (/only for testing purposes|without confirmation from the listed companies/i.test(xml)) throw new Error('Provisional testing data is not an issuer filing');
  if (!/<xbrli:context\b/i.test(xml)) throw new Error('No XBRL contexts in filing');
  const contexts = new Map();
  for (const m of xml.matchAll(/<xbrli:context\b([^>]*)>([\s\S]*?)<\/xbrli:context>/gi)) {
    const date = day(m[2].match(/<xbrli:(?:instant|endDate)>([^<]+)/i)?.[1]);
    const dimensions = [...m[2].matchAll(/<xbrldi:(typedMember|explicitMember)\b([^>]*)>([\s\S]*?)<\/xbrldi:\1>/gi)]
      .map((d) => `${attrs(d[2]).dimension}=${textOf(d[3])}`).sort().join('|');
    contexts.set(attrs(m[1]).id, { date, key: `${date}|${dimensions}` });
  }
  const facts = [];
  if (/<ix:non(?:Numeric|Fraction)\b/i.test(xml)) {
    for (const m of xml.matchAll(/<ix:(nonNumeric|nonFraction)\b([^>]*)>([\s\S]*?)<\/ix:\1>/gi)) {
      const a = attrs(m[2]); facts.push({ name: a.name?.split(':').at(-1), context: a.contextref, attrs: a, value: textOf(m[3]) });
    }
  } else {
    for (const m of xml.matchAll(/<([\w-]+):([\w-]+)\b([^>]*\bcontextRef\s*=\s*['"][^'"]+['"][^>]*)>([\s\S]*?)<\/\1:\2>/gi)) {
      const a = attrs(m[3]); facts.push({ name: m[2], context: a.contextref, attrs: a, value: textOf(m[4]) });
    }
  }
  const get = (name) => facts.find((f) => f.name === name)?.value;
  const isin = get('ISIN') || entry.isin, bseCode = get('ScripCode') || entry.bseCode;
  if (!/^IN[A-Z0-9]{10}$/.test(isin || '')) throw new Error('Filing lacks a valid Indian ISIN');
  let identityNote = null;
  if (entry.isin && entry.isin !== isin) {
    const symbol = get('Symbol');
    const master = securityMap[bseCode];
    const bseAgrees = master?.isin === isin && master.ticker === entry.ticker;
    const nseAgrees = nseMaster[entry.ticker]?.isin === isin;
    if (symbol !== entry.ticker || !bseAgrees && !nseAgrees) throw new Error('Filing ISIN disagrees with exchange index');
    identityNote = `Index ISIN ${entry.isin} differs; filing identity agrees with the independently captured ${bseAgrees ? 'BSE' : 'NSE'} security master (${isin}).`;
  }
  if (entry.bseCode && bseCode !== entry.bseCode) throw new Error('Filing scrip disagrees with exchange index');
  const groups = new Map();
  for (const f of facts) {
    const ctx = contexts.get(f.context);
    if (!ctx) continue;
    const group = groups.get(ctx.key) || { date: ctx.date, facts: new Map(), key: ctx.key };
    (group.facts.get(f.name) || group.facts.set(f.name, []).get(f.name)).push(f);
    groups.set(ctx.key, group);
  }
  const holders = [], issues = [];
  for (const group of groups.values()) {
    // PAC disclosures describe concert-party relationships and their counts, not this named
    // person's own stake. They have a different percentage concept and cannot be mixed in.
    if (/PersonsInConcert|SignificantBeneficial|CustodianOrDRHolder/i.test(group.key)) continue;
    const names = group.facts.get('NameOfTheShareholder') || [];
    if (!names.length) continue;
    const uniqueNames = [...new Set(names.map((f) => f.value).filter(Boolean))];
    const shareFacts = group.facts.get('NumberOfShares') || [];
    const shares = [...new Set(shareFacts.map(number))];
    const pcts = [...new Set((group.facts.get('ShareholdingAsAPercentageOfTotalNumberOfShares') || []).map((f) => { const n = number(f); return n == null ? null : Math.round(n * 100 * 1e8) / 1e8; }))];
    if (uniqueNames.length !== 1 || shares.length !== 1 || !Number.isSafeInteger(shares[0]) || shares[0] < 0 || pcts.length !== 1 || pcts[0] == null || pcts[0] < 0 || pcts[0] > 100 || !group.date) {
      issues.push(`Unresolved named shareholder context: ${names[0].context}`); continue;
    }
    holders.push([uniqueNames[0], shares[0], pcts[0], group.date]);
  }
  const asOf = contexts.get('MainI')?.date || [...new Set(holders.map((h) => h[3]))].sort().at(-1);
  if (!asOf || !facts.some((f) => f.name === 'NumberOfShares')) throw new Error('No dated share counts in filing');
  const seen = new Set();
  const deduped = holders.filter((h) => { const key = JSON.stringify(h); if (seen.has(key)) return false; seen.add(key); return true; });
  // Dates come from the share-count context. Report preparation and allotment can differ.
  return { ...entry, sourceUrl: sourceUrl(entry.sourceUrl), company: get('NameOfTheCompany') || entry.company,
    isin, ticker: entry.ticker || get('Symbol') || null, bseCode: /^\d{6}$/.test(bseCode || '') ? bseCode : null,
    asOf, reportDate: day(get('DateOfReport')), checkedAt, sha256: hash(xml), holders: deduped, ...(identityNote ? { identityNote, indexIsin: entry.isin } : {}),
    status: issues.length ? 'partial' : 'parsed', issues, parserVersion: 1 };
}

export function mergeFilings(previous, entries, results, sources, checkedAt) {
  const retained = new Map((previous?.filings || []).map((f) => [f.id, f]));
  for (const entry of entries) if (!retained.has(entry.id)) retained.set(entry.id, { ...entry, status: 'pending' });
  for (const result of results) {
    const old = retained.get(result.id);
    if (old?.sha256 && result.sha256 && old.sha256 !== result.sha256) {
      const revisionId = `${old.id}-revision-${old.sha256.slice(0, 12)}`;
      retained.set(revisionId, { ...old, id: revisionId, supersededBy: result.id });
    }
    if (result.status === 'failed' && old?.holders) retained.set(result.id, { ...old, lastAttemptAt: checkedAt, error: result.error });
    else retained.set(result.id, result);
  }
  const filingKey = (f) => `${f.sourceId}|${f.sourceId === 'bse' ? f.bseCode : f.ticker || f.isin}|${f.indexAsOf}`;
  const latest = new Map();
  for (const entry of entries) {
    const held = latest.get(filingKey(entry));
    if (!held || entry.filedAt > held.filedAt) latest.set(filingKey(entry), entry);
  }
  for (const [id, filing] of retained) {
    const replacement = latest.get(filingKey(filing));
    if (replacement && replacement.id !== id && retained.get(replacement.id)?.holders) retained.set(id, { ...filing, supersededBy: replacement.id });
  }
  return { version: 1, checkedAt, sources, filings: [...retained.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

import { filingTicker } from '../../public/js/data/announcement-identity.js';
import { boundedJson } from '../../public/js/data/family-book-contract.js';

// Include suspended/delisted issuers: trading status must not erase filing history or coverage.
export const BSE_MASTER_URL = 'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=';

export function validateBseIdentityMaster(master, previous = null) {
  if (!Array.isArray(master) || master.length < 1000) throw new Error('BSE identity directory is incomplete.');
  const byCode = new Map(), statuses = new Set();
  for (const row of master) {
    const code = String(row?.SCRIP_CD || '');
    if (!/^\d{6}$/.test(code) || byCode.has(code) || typeof row.Status !== 'string' || !row.Status) {
      throw new Error('BSE identity directory contains invalid or duplicate securities.');
    }
    byCode.set(code, row); statuses.add(row.Status);
  }
  if (!['Active', 'Suspended', 'Delisted'].every(status => statuses.has(status))) {
    throw new Error('BSE identity directory is missing required trading statuses.');
  }
  for (const entry of previous?.entries || []) {
    // Manually sourced off-directory identities are not proof of a row in this directory.
    if (entry.codeSource) continue;
    for (const code of new Set([entry.bseCode, ...(entry.bseCodes || [])].filter(Boolean))) {
      const row = byCode.get(String(code));
      if (!row || !/^IN[A-Z0-9]{10}$/.test(row.ISIN_NUMBER || '')) {
        throw new Error('BSE identity directory lost a previously verified security; retaining the published directory.');
      }
    }
  }
  return master;
}

export async function fetchBseIdentityMaster(previous, { fetcher = fetch, headers = {} } = {}) {
  const response = await fetcher(BSE_MASTER_URL, { headers, signal: AbortSignal.timeout(20000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`BSE scrip master answered HTTP ${response.status}`);
  }
  return validateBseIdentityMaster(await boundedJson(response, 8 * 1024 * 1024), previous);
}
// Verified issuers absent from the BSE master, with primary sources in DATA-CONTRACTS.md.
const OFF_DIRECTORY = [
  { isin: 'INE0R4701017', ticker: 'ALPEXSOLAR', name: 'Alpex Solar Limited' },
  { isin: 'INE0SMY01017', ticker: 'JAYBEE', name: 'Jay Bee Laminations Limited' },
  { isin: 'INE0LEX01011', ticker: 'SAHANA', name: 'Sahana System Limited' },
  { isin: 'INE935Q01015', ticker: 'FSC', bseCode: '540798', name: 'Future Supply Chain Solutions Limited',
    historical: true, verifiedAt: '2026-09-04',
    identitySource: 'https://www.nseindia.com/get-quote/equity/FSC/Future-Supply-Chain-Solutions-Limited',
    codeSource: 'https://nsearchives.nseindia.com/corporate/FSC_01092021172712_20210901_StockExchangeFiling.pdf' },
];
export function buildAnnouncementIdentities(master, mcMap = {}, capturedAt = new Date().toISOString()) {
  const tickers = new Map(Object.values(mcMap).filter(e => e.bseId && e.ticker)
    .map(e => [String(e.bseId), filingTicker(e.ticker)]));
  const byIsin = new Map();
  for (const s of master.filter(s => /^IN[A-Z0-9]{10}$/.test(s.ISIN_NUMBER || '') && /^\d{6}$/.test(String(s.SCRIP_CD)))) {
    if (!byIsin.has(s.ISIN_NUMBER)) byIsin.set(s.ISIN_NUMBER, []);
    byIsin.get(s.ISIN_NUMBER).push(s);
  }
  const statusRank = s => s.Status === 'Active' ? 0 : s.Status === 'Suspended' ? 1 : 2;
  const entries = [...byIsin.values()].map(list => {
    // Prefer the current code when old codes share its ISIN; keep old codes/symbols as aliases.
    const [s] = list.sort((a, b) => statusRank(a) - statusRank(b) || String(a.SCRIP_CD).localeCompare(String(b.SCRIP_CD)));
    const bseCode = String(s.SCRIP_CD), ticker = tickers.get(bseCode) || s.scrip_id || null;
    const bseCodes = [...new Set(list.map(row => String(row.SCRIP_CD)))];
    const aliases = [...new Set(list.flatMap(row => [tickers.get(String(row.SCRIP_CD)), row.scrip_id]).filter(Boolean))]
      .filter(value => value !== ticker && value !== s.scrip_id);
    return { isin: s.ISIN_NUMBER, bseCode, bseSymbol: s.scrip_id || null, ticker, name: s.Scrip_Name,
      ...(s.Status ? { status: s.Status } : {}), ...(bseCodes.length > 1 ? { bseCodes } : {}),
      ...(['Suspended', 'Delisted'].includes(s.Status) ? { historical: true } : {}),
      ...(aliases.length ? { aliases } : {}) };
  })
    .sort((a, b) => a.bseCode.localeCompare(b.bseCode));
  for (const entry of OFF_DIRECTORY) if (!entries.some(e => e.isin === entry.isin)) entries.push(entry);
  return { version: 1, source: BSE_MASTER_URL, symbolSource: 'mc-ticker-map by BSE code, falling back to BSE scrip_id', capturedAt, entries };
}

// An ancillary directory outage must not stop preserving source filings. Retained
// identities keep their original verification time; an invalid registry is never used.
export async function readAnnouncementIdentityDirectory(previous, mcMap, { now = Date.now(), ...options } = {}) {
  const attemptedAt = new Date(now).toISOString();
  try {
    const master = await fetchBseIdentityMaster(previous, options);
    const identities = buildAnnouncementIdentities(master, mcMap, attemptedAt);
    return { master, identities, publish: true,
      health: { ok: true, attemptedAt, lastSuccessAt: attemptedAt, source: 'current', error: null } };
  } catch {
    const seen = new Set();
    const valid = previous?.version === 1 && previous.source === BSE_MASTER_URL &&
      Number.isFinite(Date.parse(previous.capturedAt)) && Date.parse(previous.capturedAt) <= now &&
      Array.isArray(previous.entries) && previous.entries.length > 0 && previous.entries.every(entry => {
        if (!entry || !/^IN[A-Z0-9]{10}$/.test(entry.isin || '') || typeof entry.name !== 'string') return false;
        const codes = [...new Set([entry.bseCode, ...(Array.isArray(entry.bseCodes) ? entry.bseCodes : [])].filter(Boolean))];
        for (const code of codes) {
          if (!/^\d{6}$/.test(String(code)) || seen.has(String(code))) return false;
          seen.add(String(code));
        }
        return !entry.bseCodes || Array.isArray(entry.bseCodes);
      });
    return { master: null, identities: valid ? previous : null, publish: false,
      health: { ok: false, attemptedAt, lastSuccessAt: valid ? previous.capturedAt : null,
        source: valid ? 'retained' : 'unavailable', error: 'identity-directory-unavailable' } };
  }
}

export function retainedBseScripIndex(identities) {
  const result = new Map();
  for (const entry of identities?.entries || []) {
    // The retained registry proves BSE aliases. It does not freshly verify NSE mappings.
    const ticker = filingTicker(entry.bseSymbol);
    for (const code of new Set([entry.bseCode, ...(entry.bseCodes || [])].filter(Boolean))) {
      result.set(String(code), { ticker, name: entry.name || null, source: ticker ? 'bse-retained' : null });
    }
  }
  return result;
}

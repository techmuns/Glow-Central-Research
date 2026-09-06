import { join } from 'node:path';
import { readJson, writeJson } from './company-capture.mjs';

// Linked by NSE's securities-available-for-trading directory; both lists include ISINs.
export const NSE_DIRECTORIES = {
  equity: 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv',
  sme: 'https://nsearchives.nseindia.com/emerge/corporates/content/SME_EQUITY_L.csv',
};
export function parseNseIdentities(csv, kind) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field.trim()); field = '';
      if (c === '\n') { if (row.some(Boolean)) rows.push(row); row = []; }
    } else field += c;
  }
  if (quoted) throw new Error('Unterminated NSE directory field');
  if (field || row.length) { row.push(field.trim()); if (row.some(Boolean)) rows.push(row); }
  const headers = (rows.shift() || []).map(h => h.replace(/^\uFEFF/, '').replace(/[\s_]+/g, '').toUpperCase());
  const columns = ['SYMBOL', 'NAMEOFCOMPANY', 'ISINNUMBER', 'SERIES'].map(key => headers.indexOf(key));
  if (columns.some(c => c < 0)) throw new Error('NSE directory columns changed');
  const isins = new Set(), symbols = new Set();
  return rows.map(row => {
    const [ticker, name, isin, series] = columns.map(c => row[c]);
    if (!/^[A-Z0-9&._-]{1,50}$/.test(ticker || '') || !/^IN[A-Z0-9]{10}$/.test(isin || '') || !name || isins.has(isin) || symbols.has(ticker)) throw new Error('Invalid or ambiguous NSE directory identity');
    isins.add(isin); symbols.add(ticker);
    return { isin, ticker, name, ...(kind === 'sme' && ['SM', 'ST'].includes(series) ? { aliases: [`${ticker}-SM`] } : {}) };
  });
}

export async function refreshNseIdentities(dataDir, { fetcher = fetch, now = Date.now } = {}) {
  const path = join(dataDir, 'filing-capture/nse-identities.json');
  const saved = readJson(path, { version: 1, directories: {} });
  const previousIdentities = new Map(Object.values(saved.directories || {}).flatMap(d => d.entries || []).map(e => [e.isin, e]));
  const directories = {};
  await Promise.all(Object.entries(NSE_DIRECTORIES).map(async ([kind, url]) => {
    const previous = saved.directories?.[kind];
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
      if (!response.ok) throw new Error('NSE directory unavailable');
      const reader = response.body.getReader(), parts = []; let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          bytes += value.length;
          if (bytes > 2 * 1024 * 1024) throw new Error('NSE directory exceeds size limit');
          parts.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const entries = parseNseIdentities(Buffer.concat(parts).toString('utf8'), kind);
      if (entries.length < (kind === 'equity' ? 1000 : 100) || entries.length < (previous?.entries?.length || 0) * 0.8) throw new Error('Incomplete NSE directory');
      for (const entry of entries) {
        const prior = previousIdentities.get(entry.isin);
        // A rename or SME-to-main-board migration must not detach older saved filings.
        const aliases = [...new Set([...(entry.aliases || []), ...(prior?.aliases || []), prior?.ticker].filter(symbol => symbol && symbol !== entry.ticker))];
        if (aliases.length) entry.aliases = aliases;
      }
      directories[kind] = { url, checkedAt: new Date(now()).toISOString(), entries, error: null };
    } catch {
      directories[kind] = { ...previous, url, error: `NSE ${kind} company identities could not be checked; retaining the last verified directory.` };
    }
  }));
  const result = { version: 1, attemptedAt: new Date(now()).toISOString(), directories };
  writeJson(path, result);
  return result;
}

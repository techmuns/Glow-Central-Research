import { filingTicker } from '../../public/js/data/announcement-identity.js';

export const BSE_MASTER_URL = 'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active';
// NSE-only SME symbols/ISINs from exchange-hosted filings linked in DATA-CONTRACTS.md.
const NSE_SME = [
  { isin: 'INE0R4701017', ticker: 'ALPEXSOLAR', name: 'Alpex Solar Limited' },
  { isin: 'INE0SMY01017', ticker: 'JAYBEE', name: 'Jay Bee Laminations Limited' },
  { isin: 'INE0LEX01011', ticker: 'SAHANA', name: 'Sahana System Limited' },
];
export function buildAnnouncementIdentities(master, mcMap = {}, capturedAt = new Date().toISOString()) {
  const tickers = new Map(Object.values(mcMap).filter(e => e.bseId && e.ticker)
    .map(e => [String(e.bseId), filingTicker(e.ticker)]));
  const entries = master.filter(s => /^IN[A-Z0-9]{10}$/.test(s.ISIN_NUMBER || '') && /^\d{6}$/.test(String(s.SCRIP_CD)))
    .map(s => ({ isin: s.ISIN_NUMBER, bseCode: String(s.SCRIP_CD), bseSymbol: s.scrip_id || null,
      ticker: tickers.get(String(s.SCRIP_CD)) || s.scrip_id || null, name: s.Scrip_Name }))
    .sort((a, b) => a.bseCode.localeCompare(b.bseCode));
  for (const entry of NSE_SME) if (!entries.some(e => e.isin === entry.isin)) entries.push(entry);
  return { version: 1, source: BSE_MASTER_URL, symbolSource: 'mc-ticker-map by BSE code, falling back to BSE scrip_id', capturedAt, entries };
}

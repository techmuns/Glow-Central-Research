// Public market observations only. Never infer an exchange identity from a company name.
import { buildCompanyProfiles, profileIsin } from './company-profile.js';
import { marketTicker } from './market-identity.js';

const upper = value => String(value || '').trim().toUpperCase();
const positive = value => Number.isFinite(value) && value > 0 ? value : null;
export function projectCompanyQuotes(payload) {
  return { version: 1, generated_at: payload.generated_at, rows: (payload.companies || []).map(company => ({
    ticker: marketTicker(company), cmp: positive(company.cmp), price_date: company.bar_date || company.price_date || null,
    pct_change_today: company.pct_change_today ?? null,
  })) };
}

export function companyMarketLookup({ quotes = null, marketCaps = null, tickerMap = null } = {}) {
  const daily = new Map((quotes?.rows || []).map(row => [upper(row.ticker), row]));
  const owners = new Map(), byIsin = new Map(), shares = new Map(), bseOnlySymbols = new Set();
  const put = (key, entry) => {
    if (!key) return;
    if (!owners.has(key)) owners.set(key, entry);
    else if (owners.get(key)?.isin !== entry.isin) owners.set(key, null);
  };
  for (const entry of marketCaps?.entries || []) {
    byIsin.set(upper(entry.isin), entry);
    if (entry.exchanges?.includes('NSE')) put(upper(entry.ticker), entry);
    else if (entry.ticker) bseOnlySymbols.add(upper(entry.ticker));
    if (entry.bseCode) put(`BSE:${entry.bseCode}`, entry);
  }
  for (const entry of Object.values(tickerMap?.map || {})) {
    if (positive(entry.shares)) shares.set(upper(entry.ticker), entry.shares);
  }
  const profiles = buildCompanyProfiles({ marketCaps, tickerMap });
  function identity(company = {}) {
    const isin = profileIsin(company), bse = company.scripCode || company.bseCode || company.bseId;
    const ticker = upper(marketTicker(company) || company.symbol);
    const unresolved = () => ({ ...company, ticker: null, scripCode: null, bseCode: null, bseId: null });
    const owner = isin ? byIsin.get(isin) : bse ? owners.get(`BSE:${bse}`) : owners.get(ticker);
    // A supplied identifier must agree. In particular, BSE-only symbols are not NSE tickers.
    if (owner && isin && owner.isin !== isin) return unresolved();
    if (owner) return { ...company, isin: owner.isin, scripCode: owner.bseCode || null, bseCode: owner.bseCode || null,
      ticker: owner.exchanges?.includes('NSE') ? upper(owner.ticker) : null };
    if ((ticker && owners.has(ticker) && (!owners.get(ticker) || isin && owners.get(ticker).isin !== isin)) || bse || isin)
      return unresolved();
    if (bseOnlySymbols.has(ticker)) return unresolved();
    return { ...company, ticker };
  }
  return { identity, daily: ticker => daily.get(upper(ticker)) || null,
    read(company, priceInfo) {
      const resolved = identity(company), ticker = resolved.ticker;
      // Screens already own a completed-session row. Their added cap must use the same CMP
      // their existing renderer shows, even while another daily revision is arriving.
      const ownDaily = Object.hasOwn(company, 'cmp') ? { ...company, ticker, price_date: company.price_date || company.bar_date || null } : null;
      const override = company.marketQuote;
      let quote = ticker ? override ? { price: positive(override.price), label: override.label, at: null }
        : priceInfo(ownDaily || daily.get(ticker) || { ticker, cmp: null, price_date: null }) : null;
      if (!override && quote && !quote.at && daily.get(ticker)?.retained) quote = { ...quote, label: `Retained · ${quote.label} · latest daily price unavailable` };
      const captured = byIsin.get(upper(resolved.isin));
      if (!override && !(quote?.price > 0) && positive(captured?.cmp)) quote = { price: captured.cmp,
        label: `Screener saved price · ${captured.cmpPriceDateLabel || 'price date not supplied'} · checked ${captured.cmpCheckedAt || 'time not supplied'}${captured.error ? ' · latest source check failed' : ''}` };
      const cmp = positive(quote?.price);
      const profile = profiles.profileOf(resolved);
      // A source table's captured cap stays consistent with its own range filters.
      const ownCap = positive(company.mcapCr);
      const count = ticker && shares.get(ticker);
      const cap = ownCap || (count && cmp ? count * cmp / 1e7 : profile.mcapCr);
      const capSource = ownCap ? [company.mcapSource || 'Captured market cap', company.mcapAsOf && `as of ${company.mcapAsOf}`].filter(Boolean).join(' · ')
        : count && cmp ? `Moneycontrol shares outstanding × CMP · ${quote.label}`
          : [profile.mcapSource, profile.mcapAsOf && `as of ${profile.mcapAsOf}`].filter(Boolean).join(' · ');
      return { cmp, quoteLabel: cmp ? quote.label : 'No captured quote for a verified exchange identity',
        mcapCr: positive(cap), mcapLabel: capSource || 'No captured market cap for a verified exchange identity' };
    } };
}

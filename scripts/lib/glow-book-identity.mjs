// NSE/CML/76711, effective 8 October 2026, changes BUILDPRO's equity ISIN
// after subdivision. This confirms issuer continuity only; dated statement
// identifiers, quantities, costs and values remain the statement's own.
const subdivision = {
  ticker: 'BUILDPRO', before: 'INE24OJ01011', after: 'INE24OJ01029',
  effectiveAt: '2026-10-08T00:00:00Z',
  url: 'https://nsearchives.nseindia.com/content/circulars/CML76711.pdf',
};
export function statementEquityRelationship(holding, exchange) {
  if (!holding.isin || !exchange || holding.isin === exchange.isin) return null;
  if (holding.ticker === subdivision.ticker && exchange.ticker === subdivision.ticker &&
      holding.isin === subdivision.before && exchange.isin === subdivision.after &&
      Date.parse(exchange.checkedAt) >= Date.parse(subdivision.effectiveAt)) {
    return { kind: 'equity-subdivision', statementIsin: holding.isin, exchangeIsin: exchange.isin,
      effectiveAt: subdivision.effectiveAt, url: subdivision.url };
  }
  throw Error(`Statement/exchange ISIN conflict for ${holding.ticker}`);
}

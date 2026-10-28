// Glow Ventures' category axis, separate from a security's asset class.
// Source: GlowVentures src/lib/analytics.ts holdingRoute / holdingBucket.
// Only explicit account engagements establish Direct Equity or PMS membership.
import { portfolioNewsEntities } from './company-news-identity.js';
export const HOLDING_CATEGORIES = [
  ['all', 'All'], ['direct-equity', 'Direct Equity'], ['pms', 'PMS'],
  ['mutual-fund', 'Mutual Fund'], ['aif', 'AIF'], ['bond', 'Bond'],
  ['unlisted', 'Unlisted'], ['private-investment', 'Private Investment'],
];
export const normalizeHoldingCategory = value => HOLDING_CATEGORIES.some(([id]) => id === value) ? value : 'all';
export const holdingCategoryLabel = value => HOLDING_CATEGORIES.find(([id]) => id === value)?.[1] || 'All';

// Offer only the categories a researched company is filed under. The research list holds
// equity companies, so Mutual Fund, AIF or Bond could only ever narrow the alerts to nothing.
export function offeredHoldingCategories(holdings) {
  const carried = new Set(holdings.flatMap(holding => holding.holdingCategories || []));
  return HOLDING_CATEGORIES.filter(([id]) => id === 'all' || carried.has(id));
}

export function positionCategory(position, account = {}) {
  const engagement = Object.hasOwn(account, 'engagement') ? account.engagement : position.engagement;
  if (engagement === 'PMS') return 'pms';
  if (position.valuedAtCost === true) return 'private-investment';
  if (position.assetClass === 'Equity') return ['Direct', 'Execution'].includes(engagement) ? 'direct-equity' : null;
  return ({ 'Mutual Fund': 'mutual-fund', AIF: 'aif', Bond: 'bond', Unlisted: 'unlisted' })[position.assetClass] || null;
}

// Keep every category when a company occurs in multiple accounts. No fund
// look-through, guessed listing status or fuzzy issuer-name matching.
export function withHoldingCategories(holdings, book) {
  const accounts = new Map((book.accounts || []).map(account => [account.accountId, account]));
  return holdings.map(holding => {
    const categories = new Set();
    for (const position of book.positions || []) {
      const matches = holding.isin && position.isin ? holding.isin === position.isin
        : holding.ticker && position.symbol ? holding.ticker === position.symbol
        : !position.symbol && holding.bookName && holding.bookName === position.security;
      if (!matches) continue;
      const category = positionCategory(position, accounts.get(position.accountId));
      if (category) categories.add(category);
    }
    return { ...holding, holdingCategories: HOLDING_CATEGORIES.map(([id]) => id).filter(id => categories.has(id)) };
  });
}

// Category filtering always reads the current book, including after a cached
// alert report is restored or an account changes its engagement.
export function holdingCategoryMatcher(holdings, category) {
  if (category === 'all') return () => true;
  const isins = new Set(), tickers = new Set();
  for (const holding of holdings) if (holding.holdingCategories?.includes(category)) {
    if (holding.isin) isins.add(holding.isin);
    if (holding.ticker) tickers.add(holding.ticker);
  }
  const entities = new Set(portfolioNewsEntities(holdings).filter(entity => entity.portfolioIsins.some(isin => isins.has(isin))).map(entity => entity.entityId));
  // A family private company carries its own categories; it has no ISIN or ticker in the research list.
  return card => card.familyPrivate ? !!card.holdingCategories?.includes(category)
    : card.isin ? isins.has(card.isin) : tickers.has(card.ticker) || entities.has(card.entityId || card.key);
}

// Adapt Glow's existing published statements to the shared My Managers reader.
// No foreign workbook, inferred transaction, new publication or valuation is introduced.
import { snapshotIssue } from './managers-contract.js';
const number = value => Number.isFinite(value) ? value : null;
const sum = rows => rows.every(Number.isFinite) ? rows.reduce((a, b) => a + b, 0) : null;
const id = value => String(value).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 100);
const isin = value => /^[A-Z]{2}[A-Z0-9]{10}$/.test(value || '');
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(v => v.toString(16).padStart(2, '0')).join('');

export async function glowManagerSnapshot(portfolio, book, source) {
  if (!source?.source?.startsWith('techmuns/GlowVentures') || source.builtFrom !== book.builtFrom ||
      source.asOf !== book.asOf || !Array.isArray(source.managers) || !Array.isArray(book.accounts))
    throw Error('Glow manager statements do not describe the verified book revision.');
  const identities = new Map(portfolio.holdings.filter(h => h.ticker).map(h => [h.ticker, h.isin]));
  const dedupe = new Set();
  const rows = book.positions.filter(p => {
    if (p.dedupeGroup) { if (dedupe.has(p.dedupeGroup)) return false; dedupe.add(p.dedupeGroup); }
    return true;
  });
  let missingPositions = 0, missingTrades = 0;
  const managers = [];
  for (const account of book.accounts.filter(a => ['PMS', 'Direct', 'Execution'].includes(a.engagement))) {
    const held = rows.filter(p => p.accountId === account.accountId);
    if (!held.length) continue;
    const groups = new Map();
    for (const p of held.filter(p => p.assetClass !== 'Cash')) {
      const key = isin(p.isin) ? p.isin : identities.get(p.symbol);
      if (!key || !['Equity', 'ETF', 'Mutual Fund'].includes(p.assetClass)) { missingPositions++; continue; }
      const group = groups.get(key) || []; group.push(p); groups.set(key, group);
    }
    const positions = [...groups].map(([key, group]) => ({
      isin: key, ticker: group[0].symbol || null, security: group[0].security, assetClass: group[0].assetClass,
      quantity: sum(group.map(p => number(p.quantity))), marketValue: sum(group.map(p => number(p.marketValue))),
      costBasis: sum(group.map(p => number(p.costBasis))), weightPct: null,
    }));
    const marketValue = sum(held.filter(p => p.assetClass !== 'Cash').map(p => number(p.marketValue)));
    const costBasis = sum(held.filter(p => p.assetClass !== 'Cash').map(p => number(p.costBasis)));
    const transactions = [];
    for (const m of source.managers) for (const t of m.transactions || []) {
      if (t.accountId !== account.accountId) continue;
      const key = isin(t.isin) ? t.isin : identities.get(t.symbol);
      const side = String(t.side).toLowerCase();
      if (!key || !['buy', 'sell'].includes(side) || ![t.quantity, t.amount, t.unitPrice].every(Number.isFinite) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) { missingTrades++; continue; }
      const record = { date: t.date, dateSheet: null, isin: key, ticker: t.symbol || null, security: t.security,
        side, quantity: t.quantity, amount: t.amount, unitPrice: t.unitPrice, transfer: false };
      const keyId = await hash(JSON.stringify([account.accountId, record, t.source]));
      if (!transactions.some(row => row.id === keyId)) transactions.push({ id: keyId, ...record });
    }
    managers.push({ id: `account-${id(account.accountId)}`, name: [account.provider, account.strategy, account.owner].filter(Boolean).join(' · ').slice(0, 300),
      kind: 'custodian', asOf: account.asOf || book.asOf, positions, transactions,
      values: { marketValue, costBasis, unrealised: marketValue !== null && costBasis !== null ? marketValue - costBasis : null,
        cashValue: sum(held.filter(p => p.assetClass === 'Cash').map(p => number(p.marketValue))), positionCount: positions.length } });
  }
  for (const m of source.managers.filter(m => m.kind === 'aif')) {
    const value = number(m.value?.marketValue);
    const cost = m.value?.costRows === m.value?.rows ? number(m.value?.costBasis) : null;
    managers.push({ id: `fund-${id(m.id)}`, name: m.name, kind: 'fund', asOf: null, positions: [], transactions: [],
      values: { marketValue: value, costBasis: cost, unrealised: value !== null && cost !== null ? value - cost : null, cashValue: null, positionCount: 0 },
      capital: { committed: null, drawn: null, distributed: null, currentValue: value, tvpi: null, dpi: null, firstInvest: null } });
  }
  const snapshot = { version: 1, valuation: 'statements', sourceKind: 'glow-statements', bookAsOf: book.asOf,
    checkedAt: portfolio.syncedAt, sourceRevision: portfolio.sourceRevision, archiveVersion: parseInt(portfolio.sourceRevision.slice(0, 12), 16),
    listedValuationAt: null, listedValuationBasis: null, managers,
    coverage: { transactionAsOf: book.asOf, sourceCount: book.accounts.length, privateCount: managers.filter(m => m.kind === 'fund').length,
      note: `GlowVentures statements as of ${book.asOf}, source ${book.builtFrom}. Each custodian retains its own statement date. ` +
        `${missingPositions} positions and ${missingTrades} trades lack an identity or fields required by this reader; the original statement assets retain them. ` +
        'Fund commitments and cash-flow ratios are unavailable in this projection. These are retained statements, not current broker ownership or an exhaustive transaction archive.' } };
  const issue = snapshotIssue(snapshot, Date.parse(portfolio.syncedAt));
  if (issue) throw Error(`Glow manager projection failed validation (${issue}).`);
  return snapshot;
}

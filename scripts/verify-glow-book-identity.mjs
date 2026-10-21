import assert from 'node:assert/strict';
import { statementEquityRelationship } from './lib/glow-book-identity.mjs';
const statement = { ticker: 'BUILDPRO', isin: 'INE24OJ01011', units: 10, cost: 100, value: 120 };
const saved = structuredClone(statement);
const exchange = { ticker: 'BUILDPRO', isin: 'INE24OJ01029', checkedAt: '2026-10-09T00:00:00Z' };
assert.deepEqual(statementEquityRelationship(statement, exchange), {
  kind: 'equity-subdivision', statementIsin: statement.isin, exchangeIsin: exchange.isin,
  effectiveAt: '2026-10-08T00:00:00Z', url: 'https://nsearchives.nseindia.com/content/circulars/CML76711.pdf',
});
assert.deepEqual(statement, saved, 'issuer continuity must not restate the historical holding');
assert.equal(statementEquityRelationship(statement, { ...exchange, isin: statement.isin }), null);
assert.equal(statementEquityRelationship({ ticker: 'BUILDPRO' }, exchange), null);
assert.equal(statementEquityRelationship(statement, null), null);
for (const row of [
  { ...exchange, isin: 'INE000000099' }, { ...exchange, ticker: 'OTHER' },
  { ...exchange, checkedAt: '2026-10-07T00:00:00Z' }, { ...exchange, checkedAt: null },
]) assert.throws(() => statementEquityRelationship(statement, row), /ISIN conflict/);
assert.throws(() => statementEquityRelationship({ ticker: 'KAMATS', isin: 'INE564S13022' },
  { ticker: 'KAMATS', isin: 'INE564S01019' }), /ISIN conflict/, 'a warrant-to-issuer alias is not equity continuity');
console.log('PASS reviewed equity subdivision, unchanged statement figures and rejection of unrelated, undated and warrant identities');

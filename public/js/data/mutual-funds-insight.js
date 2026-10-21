// A valuation of disclosed share changes at the displayed CMP, not executed cash flow.
export function netVolumeCr(row, cmp) {
  if (row.missing || !(row.comparableFunds > 0) || !Number.isFinite(row.netChange) || !Number.isFinite(cmp) || cmp <= 0) return null;
  const value = row.netChange * cmp / 10_000_000;
  return Number.isFinite(value) ? value : null;
}

const houseName = name => String(name || '').replace(/\s+Mutual\s+Fund\s*$/i, '').trim();
const words = name => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function fundHouse(fund, amcs) {
  if (!fund?.name) return null;
  if (fund.amc?.trim()) return houseName(fund.amc);
  // Older captures contain only the exact scheme name. Use a unique published
  // AMC prefix; otherwise retain that full scheme name rather than guessing.
  const scheme = words(fund.name);
  const matches = [...new Set(amcs.map(amc => houseName(amc.name)).filter(name => name &&
    (scheme === words(name) || scheme.startsWith(words(name) + ' '))))];
  return matches.length === 1 ? matches[0] : fund.name;
}
export function fundHouseLead(row, amcs = []) {
  if (row.missing || !(row.comparableFunds > 0)) return '';
  const buyer = row.topBuyer?.change > 0 ? fundHouse(row.topBuyer, amcs) : null;
  const seller = row.topSeller?.change < 0 ? fundHouse(row.topSeller, amcs) : null;
  return [buyer && `Largest addition: ${buyer}`, seller && `Largest reduction: ${seller}`].filter(Boolean).join(' · ');
}

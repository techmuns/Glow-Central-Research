// Adapted from techmuns/DRHP's frozen data contract and scoring model (690ffa1).
// Snapshots are observations, not live lifecycle confirmations. Keep original records for drill-in.
import { documentUrl, validDay } from './combined-filings-shared.js';

export const IPO_REPOSITORY = 'https://github.com/techmuns/DRHP';
export const companyKey = (value) => String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(private|pvt|limited|ltd|llp)\b/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export const numeric = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const day = (value) => validDay(value) ? value : null;

export function validateIpoSnapshot(data) {
  if (!data || !validDay(data.meta?.snapshot_id) || !validDay(data.meta?.data_as_of) || !validDay(data.meta?.week_start) || !validDay(data.meta?.week_end) || data.meta.week_start > data.meta.week_end || !Array.isArray(data.filings) || data.filings.length > 5000) throw new Error('Invalid IPO snapshot');
  if (data.filings.some((row) => !row || typeof row.company_name !== 'string' || !row.company_name.trim())) throw new Error('Invalid IPO filing identity');
  if (data.filings.some((row) => (row.filing_date != null && !validDay(row.filing_date)) || (row.lead_managers != null && !Array.isArray(row.lead_managers)) || (row.financials != null && (typeof row.financials !== 'object' || Array.isArray(row.financials))))) throw new Error('Invalid IPO filing fields');
  for (const field of ['open_upcoming', 'recent_listings']) {
    const rows = data.ipo_market?.[field];
    if (rows != null && (!Array.isArray(rows) || rows.length > 5000 || rows.some((r) => !r || typeof r.company_name !== 'string' || !r.company_name.trim()))) throw new Error('Invalid IPO market rows');
  }
  return data;
}

export function validateScoring(config) {
  if (!config?.components || typeof config.components !== 'object' || Array.isArray(config.components)) throw new Error('Invalid scoring model');
  const parts = Object.values(config.components);
  if (!parts.length || parts.length > 20 || parts.some((p) => !p || typeof p.input !== 'string' || numeric(p.weight) == null || p.weight < 0 || numeric(p.floor) == null || numeric(p.saturation) == null || p.saturation <= p.floor)) throw new Error('Invalid scoring bands');
  if (Math.abs(parts.reduce((sum, p) => sum + p.weight, 0) - 100) > 0.001 || numeric(config.min_coverage_weight) == null || config.min_coverage_weight < 0 || config.min_coverage_weight > 100 || numeric(config.thresholds?.dig_deeper_min) == null || numeric(config.thresholds?.monitor_min) == null || config.thresholds.monitor_min < 0 || config.thresholds.dig_deeper_min > 100 || config.thresholds.monitor_min > config.thresholds.dig_deeper_min) throw new Error('Invalid scoring weights or thresholds');
  return config;
}

// Same half-to-even rounding used by the reference dashboard and Python scorer.
const round = (n, digits) => { const m = 10 ** digits, y = n * m, low = Math.floor(y); return Math.abs(y - low - 0.5) < 1e-9 ? (low % 2 === 0 ? low : low + 1) / m : Math.round(y) / m; };
export function scoreIpo(financials, config) {
  if (!config) return { total: null, bucket: 'INSUFFICIENT', coverage: 0, components: [] };
  let coverage = 0, total = 0;
  const components = Object.values(config.components).map((part) => {
    const value = numeric(financials?.[part.input]?.value);
    const points = value == null ? null : round(Math.max(0, Math.min(1, (value - part.floor) / (part.saturation - part.floor))) * part.weight, 2);
    if (points != null) { coverage += part.weight; total += points; }
    return { ...part, value, points };
  });
  total = coverage < config.min_coverage_weight ? null : round(total, 1);
  return { total, coverage, components, bucket: total == null ? 'INSUFFICIENT' : total >= config.thresholds.dig_deeper_min ? 'DIG DEEPER' : total >= config.thresholds.monitor_min ? 'MONITOR' : 'WATCH' };
}

function filingStage(filing) {
  // The reference pipeline treats any prospectus as Listed when NSE is absent. Do not repeat it.
  if (['Withdrawn', 'Cancelled', 'Deferred'].includes(filing.current_stage)) return 'Withdrawn';
  if (['Corrigendum', 'Addendum', 'UDRHP'].includes(filing.filing_type)) return 'Updated filing';
  if (['Prospectus', 'RHP'].includes(filing.filing_type)) return 'Prospectus filed';
  return filing.filing_type === 'DRHP' ? 'DRHP filed' : 'Stage not confirmed';
}
export function ipoLifecycle(stage) {
  if (stage === 'Listed' || stage === 'Withdrawn') return 'Listed / inactive';
  if (['IPO Open', 'Listing Soon', 'Upcoming', 'Closed'].includes(stage)) return 'IPO market';
  return 'Pre-IPO';
}
export function filingEvent(filing) {
  return ['Corrigendum', 'Addendum', 'UDRHP'].includes(filing.filing_type) || filing.stamps?.includes('UPDATED') ? 'Updated filing' : ['Prospectus', 'RHP'].includes(filing.filing_type) ? 'New prospectus' : 'New filing';
}

export function buildIpoRows(snapshots, tracked = []) {
  const rows = new Map();
  const get = (name) => {
    const key = companyKey(name);
    if (!rows.has(key)) rows.set(key, { key, name, aliases: [], history: [], financials: {}, sources: {}, score: null });
    return rows.get(key);
  };
  for (const snapshot of [...snapshots].sort((a, b) => a.meta.data_as_of.localeCompare(b.meta.data_as_of))) {
    for (const filing of snapshot.filings) {
      const row = get(filing.company_name);
      const date = day(filing.filing_date);
      const prior = row.history.findIndex((h) => h.filing_date === filing.filing_date && h.filing_type === filing.filing_type && h.sources?.sebi_url === filing.sources?.sebi_url);
      if (prior >= 0) row.history[prior] = filing; else row.history.push(filing);
      // Empty later snapshots never erase older companies or their disclosed financials.
      if (!row.filingDate || (date && date >= row.filingDate)) Object.assign(row, { name: filing.company_name, filingDate: date, filingType: filing.filing_type, sector: filing.sector, board: filing.board, filing, financials: filing.financials || {}, sources: filing.sources || {}, observedAt: snapshot.meta.data_as_of });
    }
    if (snapshot.ipo_market?.available) for (const market of [...(snapshot.ipo_market.open_upcoming || []), ...(snapshot.ipo_market.recent_listings || [])]) {
      const row = get(market.company_name);
      row.market = market;
      row.marketAsOf = day(snapshot.ipo_market.as_of) || snapshot.meta.data_as_of;
      row.board = market.board || row.board;
      row.symbol = market.symbol || row.symbol;
      row.groww = market.groww || row.groww;
    }
  }
  for (const issuer of tracked) {
    const row = get(issuer.company_name);
    row.aliases = issuer.aliases || [];
    row.tracked = issuer;
    for (const filing of issuer.filings || []) {
      const prior = row.history.find((h) => h.filing_date === filing.filing_date && h.filing_type === filing.filing_type);
      if (!prior) row.history.push(filing);
      if (!row.filingDate || filing.filing_date > row.filingDate) Object.assign(row, { filingDate: filing.filing_date, filingType: filing.filing_type, filing, sources: filing.sources || {}, observedAt: issuer.checked_at });
    }
  }
  return [...rows.values()].map((row) => {
    row.history.sort((a, b) => (b.filing_date || '').localeCompare(a.filing_date || ''));
    row.stage = row.market?.stage || filingStage(row.filing || {});
    row.stageAsOf = row.market ? row.marketAsOf : row.observedAt;
    row.lifecycle = ipoLifecycle(row.stage);
    row.groww ||= row.filing?.groww;
    row.activityDate = [row.filingDate, day(row.market?.listing_date), day(row.market?.issue_open)].filter(Boolean).sort().at(-1) || null;
    return row;
  }).sort((a, b) => (b.activityDate || '').localeCompare(a.activityDate || '') || a.name.localeCompare(b.name));
}

export function weeklyIpoStats(snapshot, config) {
  const filings = snapshot.filings.filter((r) => r.filing_date >= snapshot.meta.week_start && r.filing_date <= snapshot.meta.week_end);
  return { drhp: filings.filter((r) => r.filing_type === 'DRHP').length,
    prospectus: filings.filter((r) => ['Prospectus', 'RHP'].includes(r.filing_type)).length,
    updated: filings.filter((r) => filingEvent(r) === 'Updated filing').length,
    dig: new Set(filings.filter((r) => scoreIpo(r.financials, config).bucket === 'DIG DEEPER').map((r) => companyKey(r.company_name))).size };
}
export function matchesIpo(row, query) {
  const q = companyKey(query);
  return !q || [row.name, row.symbol, ...(row.aliases || [])].some((s) => companyKey(s).includes(q));
}
export const ipoStory = (row) => /\bipo\b|\bdrhp\b|red herring|prospectus|initial public offer/i.test(`${row.title || ''} ${row.summary || ''}`);
export function sourceLinks(row) {
  return Object.entries(row.sources || {}).map(([label, value]) => ({ label: label.replace(/_/g, ' '), url: documentUrl(value) })).filter((s) => s.url);
}

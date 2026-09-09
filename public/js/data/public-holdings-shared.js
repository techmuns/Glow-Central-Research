// Independent public-disclosure reconciliation. Transactions never become holdings here.
import { identity } from './investor-changes.js';
import { periodEnd, quarterOrder } from './finology-shared.js';
const DAYS = 86400000;
// BSE-only issuers often put a placeholder in the NSE-symbol XBRL field.
const listedSymbol = (value) => /^(?:NOTLISTED|NOTLSITED|NA|NIL|NONE|NOTAPPLICABLE)?$/i.test(String(value || '').replace(/[^a-z0-9]/gi, '')) ? null : value;
export const currentRelation = (r, now) => /^https:\/\//.test(r.sourceUrl || '') && Number.isFinite(Date.parse(r.verifiedAt)) && Date.parse(r.verifiedAt) <= Date.parse(now) && Date.parse(now) - Date.parse(r.verifiedAt) <= 90 * DAYS;

export function entityRegistry(snapshot, managers, evidence, now) {
  const people = [...(snapshot.investors || []).map((p) => ({ id: p.slug, name: p.name, kind: 'investor' })),
    ...(managers.managers || []).map((p) => ({ id: p.id, name: p.name, kind: 'manager' }))];
  const names = new Map();
  const add = (name, target) => { const key = identity(name); if (!key) return; const entries = names.get(key) || []; if (!entries.some((e) => e.id === target.id && e.kind === target.kind && e.entityId === target.entityId)) entries.push(target); names.set(key, entries); };
  const ownEntity = (p) => (evidence.relations || []).find((r) => ['same-person', 'same-entity'].includes(r.kind) && currentRelation(r, now) &&
    (p.kind === 'investor' ? r.investorSlugs : r.managerIds)?.includes(p.id))?.entityId || `${p.kind}:${p.id}`;
  for (const p of people) add(p.name, { ...p, entityId: ownEntity(p), relationship: 'Named in the tracked directory', associated: false, sourceUrl: p.kind === 'investor' ? `https://ticker.finology.in/investor/${p.id}` : null });
  for (const r of evidence.relations || []) if (currentRelation(r, now)) {
    for (const p of people.filter((p) => (p.kind === 'investor' ? r.investorSlugs : r.managerIds)?.includes(p.id))) {
      for (const name of [r.legalName, ...(r.aliases || [])]) add(name, { ...p, verified: true, entityId: r.entityId, associated: !['same-person', 'same-entity'].includes(r.kind), relationship: r.relationship, sourceUrl: r.sourceUrl });
    }
  }
  // One legal entity can appear in both audiences; two investors claiming different entities
  // under the same exact name remain ambiguous and are sent for review.
  for (const [name, targets] of names) {
    const distinct = new Map();
    for (const t of targets) { const key = `${t.kind}:${t.id}`; if (!distinct.has(key) || t.verified && !distinct.get(key).verified) distinct.set(key, t); }
    names.set(name, [...distinct.values()]);
  }
  return { people, names };
}
const quarterLabel = (date) => {
  const d = new Date(`${date}T00:00:00Z`), month = d.getUTCMonth() + 1;
  return [3, 6, 9, 12].includes(month) && new Date(Date.UTC(d.getUTCFullYear(), month, 0)).toISOString().slice(0, 10) === date
    ? `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][month - 1]} ${d.getUTCFullYear()}` : null;
};
const issueKey = (type, ...parts) => [type, ...parts].join('|');
export function reconcilePublicHoldings({ archive = {}, snapshot = {}, managers = {}, evidence = {}, exchange = {}, now = new Date().toISOString() } = {}) {
  const registry = entityRegistry(snapshot, managers, evidence, now), byFiling = new Map(), failed = [];
  for (const f of archive.filings || []) {
    if (f.supersededBy) continue;
    if (!f.holders) { failed.push(f); continue; }
    const key = `${f.sourceId}|${f.isin}|${f.asOf}`, prior = byFiling.get(key);
    if (!prior || f.filedAt > prior.filedAt || f.filedAt === prior.filedAt && f.checkedAt > prior.checkedAt) byFiling.set(key, f);
  }
  const filings = [...byFiling.values()], latestDates = new Map(), securities = new Map(), symbols = new Map(), datedSymbols = new Map(), companyNames = new Map(), datedNames = new Map();
  const addUnique = (map, key, isin) => { if (!key || !isin) return; map.set(key, map.has(key) && map.get(key) !== isin ? null : isin); };
  const addSymbol = (symbol, isin, date) => { if (!listedSymbol(symbol)) return; const key = String(symbol).toUpperCase(); addUnique(symbols, key, isin); if (date) addUnique(datedSymbols, `${key}|${date}`, isin); };
  const addName = (name, isin, date) => { const key = identity(name); addUnique(companyNames, key, isin); if (date) addUnique(datedNames, `${key}|${date}`, isin); };
  const resolveSecurity = (holding, date) => {
    if (holding.isin) return holding.isin;
    const symbol = String(holding.companySlug || holding.ticker || '').toUpperCase(), name = identity(holding.company);
    const symbolKey = `${symbol}|${date}`, nameKey = `${name}|${date}`;
    const bySymbol = datedSymbols.has(symbolKey) ? datedSymbols.get(symbolKey) : symbols.get(symbol);
    const byName = datedNames.has(nameKey) ? datedNames.get(nameKey) : companyNames.get(name);
    return bySymbol && byName && bySymbol !== byName ? null : bySymbol || byName || null;
  };
  for (const f of filings) {
    if (!latestDates.has(f.isin) || f.asOf > latestDates.get(f.isin)) latestDates.set(f.isin, f.asOf);
    securities.set(f.isin, f); addSymbol(f.ticker, f.isin, f.asOf); addSymbol(f.bseCode, f.isin, f.asOf); addName(f.company, f.isin, f.asOf);
  }
  for (const [code, s] of Object.entries(exchange.securityMap || {})) { addSymbol(code, s.isin); addSymbol(s.ticker, s.isin); addName(s.name, s.isin); }
  const matched = new Map(), candidates = new Map(), issues = [];
  const peopleTokens = registry.people.map((p) => ({ ...p, tokens: p.name.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((t) => t.length > 2 && !['fund','private','limited','family','investment','managers','capital','india'].includes(t)) }));
  const unknownNames = new Map();
  for (const f of filings) for (const [legalHolder, shares, stakePct, asOf] of f.holders) {
    const targets = registry.names.get(identity(legalHolder)) || [];
    if (!targets.length) { if (shares > 0 && asOf === latestDates.get(f.isin)) unknownNames.set(legalHolder, f); continue; }
    const ambiguous = ['investor', 'manager'].some((kind) => new Set(targets.filter((t) => t.kind === kind).map((t) => t.entityId)).size > 1);
    if (ambiguous) { issues.push({ id: issueKey('ambiguous-holder', identity(legalHolder), f.id), type: 'ambiguous-holder', legalHolder, company: f.company, sourceUrl: f.sourceUrl, message: 'Exact holder name maps to multiple tracked profiles; attribution withheld.' }); continue; }
    for (const target of targets) {
      // A directory name alone does not identify a person in a previously unknown company.
      // Existing source-book context or a reviewed legal identity is required for attribution.
      const knownCompany = target.kind === 'manager' || (snapshot.books?.[target.id]?.holdings || [])
        .some((h) => resolveSecurity(h, asOf) === f.isin && Object.values(h.quarterlyHoldings || {}).some((value) => value > 0));
      if (!target.verified && !knownCompany) {
        if (shares > 0 && asOf === latestDates.get(f.isin)) candidates.set(`${identity(legalHolder)}|${f.isin}|${target.id}`, {
          legalName: legalHolder, sourceUrl: f.sourceUrl, company: f.company, candidates: [{ id: target.id, kind: target.kind, name: target.name }], status: 'needs-relationship-evidence' });
        continue;
      }
      const key = `${target.kind}|${target.id}|${f.isin}|${target.entityId}|${asOf}`;
      let row = matched.get(key);
      if (!row) {
        row = { id: key, personId: target.id, person: target.name, kind: target.kind, entityId: target.entityId,
          legalHolder, associated: target.associated, attribution: target.verified ? 'reviewed-legal-identity' : 'exact-name-and-source-context', relationship: target.relationship, relationshipUrl: target.sourceUrl,
          company: f.company, ticker: listedSymbol(f.ticker) || f.bseCode, isin: f.isin, asOf, shares, stakePct, sources: [],
          state: asOf === latestDates.get(f.isin) ? 'latest-disclosure' : 'historical-disclosure' };
        matched.set(key, row);
      }
      if (shares !== row.shares || Math.abs(stakePct - row.stakePct) > 0.00500001) row.state = 'source-conflict';
      row.sources.push({ source: f.sourceId, url: f.sourceUrl, legalHolder, filedAt: f.filedAt, checkedAt: f.checkedAt, shares, stakePct, filingId: f.id, sha256: f.sha256,
        ...(f.identityNote ? { identityNote: f.identityNote } : {}), ...(f.error ? { refreshError: f.error } : {}), ...(f.status === 'partial' ? { partial: true } : {}) });
    }
  }
  // Name resemblance creates review candidates only. It never expands attribution automatically.
  for (const [legalName, f] of unknownNames) {
    const tokens = new Set(legalName.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/));
    const possible = peopleTokens.filter((p) => p.tokens.length >= 2 && p.tokens.every((t) => tokens.has(t)));
    if (possible.length) candidates.set(identity(legalName), { legalName, sourceUrl: f.sourceUrl, company: f.company,
      candidates: possible.map((p) => ({ id: p.id, kind: p.kind, name: p.name })), status: 'needs-relationship-evidence' });
  }
  const holdings = [...matched.values()];
  for (const row of holdings) {
    const q = quarterLabel(row.asOf), book = snapshot.books?.[row.personId];
    const secondary = book?.holdings?.find((h) => resolveSecurity(h, row.asOf) === row.isin);
    const value = q ? secondary?.quarterlyHoldings?.[q] : null;
    row.secondary = { source: 'Finology', url: row.kind === 'investor' ? `https://ticker.finology.in/investor/${row.personId}` : null,
      checkedAt: book?.fetchedAt || null, period: q, stakePct: value ?? null };
    if (row.state === 'source-conflict') {
      row.comparison = 'source-conflict';
      issues.push({ id: issueKey('source-conflict', row.id), type: 'source-conflict', personId: row.personId, kind: row.kind, company: row.company,
        legalHolder: row.legalHolder, asOf: row.asOf, sourceUrl: row.sources[0].url, message: 'Multiple figures are reported for the same holder name, security and date; review the original rows before combining or choosing them.' });
      continue;
    }
    if (row.associated || row.kind !== 'investor') { row.comparison = 'associated-entity'; continue; }
    if (!q) { row.comparison = 'off-cycle-disclosure'; continue; }
    if (typeof value === 'number') {
      row.comparison = Math.abs(value - row.stakePct) <= 0.00500001 ? 'agrees' : 'stake-difference';
      if (row.comparison === 'stake-difference') issues.push({ id: issueKey('stake-difference', row.id), type: 'stake-difference', personId: row.personId, kind: row.kind,
        company: row.company, legalHolder: row.legalHolder, asOf: row.asOf, sourceUrl: row.sources[0].url, message: `Exchange ${row.stakePct}%; Finology ${value}% for ${q}.` });
    } else {
      row.comparison = 'additional-disclosure';
      if (row.state === 'latest-disclosure' && row.shares > 0) issues.push({ id: issueKey('additional-disclosure', row.id), type: 'additional-disclosure', personId: row.personId, kind: row.kind,
        company: row.company, legalHolder: row.legalHolder, asOf: row.asOf, sourceUrl: row.sources[0].url, message: 'Exchange holding is absent or unconfirmed in the corresponding source quarter; shown with its original evidence.' });
    }
  }
  // Reverse check: known source positions also need a matching primary holder at that date.
  for (const person of registry.people.filter((p) => p.kind === 'investor')) {
    const book = snapshot.books?.[person.id];
    const latest = (book?.quarters || []).filter((q) => [3,6,9,12].includes(quarterOrder(q) % 100) && periodEnd(q) <= now.slice(0,10)).sort((a,b) => quarterOrder(b)-quarterOrder(a))[0];
    for (const h of book?.holdings || []) {
      if (!(h.quarterlyHoldings?.[latest] > 0)) continue;
      const at = periodEnd(latest);
      const isin = resolveSecurity(h, at);
      if (holdings.some((r) => r.personId === person.id && r.kind === person.kind && r.isin === isin && r.asOf === at)) continue;
      const f = filings.find((f) => f.isin === isin && f.asOf === at);
      issues.push({ id: issueKey('primary-unconfirmed', person.id, h.companySlug || h.company, at), type: 'primary-unconfirmed', personId: person.id, kind: person.kind,
        company: h.company, asOf: at, sourceUrl: f?.sourceUrl || `https://ticker.finology.in/investor/${person.id}`,
        message: !isin ? 'Security identifier needs review.' : f ? 'Source position has no confirmed legal-holder match in the captured exchange filing.' : 'Source position awaits a matching exchange filing.' });
    }
  }
  const uniqueIssues = [...new Map(issues.map((i) => [i.id, i])).values()];
  const sourceExceptions = (archive.filings || []).filter((f) => !f.supersededBy && (!f.holders || f.error || f.status === 'partial'))
    .map((f) => ({ id: f.id, company: f.company, asOf: f.asOf || f.indexAsOf, sourceUrl: f.sourceUrl, source: f.sourceId,
      type: 'filing-review', message: f.error || f.issues?.join('; ') || 'Filing awaits a successful read.', checkedAt: f.checkedAt || null, lastAttemptAt: f.lastAttemptAt || null }));
  return { version: 1, checkedAt: now, captureCheckedAt: archive.checkedAt || null, window: archive.window || null, sources: archive.sources || [],
    securityMaster: archive.securityMaster ? { ...archive.securityMaster, entries: undefined } : null,
    coverage: { indexed: (archive.filings || []).length, parsed: (archive.filings || []).filter((f) => f.holders).length, pending: failed.length,
      partial: filings.filter((f) => f.status === 'partial').length, failedRefresh: filings.filter((f) => f.error).length, securities: securities.size, profiles: registry.people.length },
    holdings: holdings.sort((a,b) => b.asOf.localeCompare(a.asOf) || a.id.localeCompare(b.id)), issues: uniqueIssues,
    candidates: [...candidates.values()], sourceExceptions, profiles: registry.people.map((p) => ({ ...p,
      matches: holdings.filter((r) => r.personId === p.id && r.kind === p.kind && r.state === 'latest-disclosure').length,
      issues: uniqueIssues.filter((i) => i.personId === p.id && i.kind === p.kind).length,
      relations: (evidence.relations || []).filter((r) => currentRelation(r, now) && (p.kind === 'investor' ? r.investorSlugs : r.managerIds)?.includes(p.id)).length })), complete: false };
}

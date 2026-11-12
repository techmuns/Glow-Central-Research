// scripts/lib/client-statements.mjs — lay a statement the CLIENT sent over the generated book. GLOW-OWNED.
//
// The family's book is built in techmuns/GlowVentures from the statements its archive holds, and
// copied here every morning (series-refresh.yml → build-book.mjs, build-managers.mjs). Sometimes
// the client hands the desk a statement that archive has not read yet — an AIF's month-end NAV,
// say, while the upstream still carries the fund at cost from an older statement. This module is
// how such a statement reaches every surface that reads the book, without forking the book.
//
// Five rules, each one this repository already runs on:
//
//   • THE STATEMENT'S FIGURES ARE THE FIGURES. Units, invested amount, NAV per unit, value and the
//     performance figure are transcribed as printed. Two numbers are arithmetic of printed ones and
//     say so in `derivedFields`: unrealised P&L (value − invested) and average cost (invested ÷
//     units). A figure the statement prints as "NA" is null, never zero.
//   • IT IS CHECKED BEFORE IT IS LAID. Units must equal the allotments, units × NAV must give the
//     printed value (to the statement's own rounding), the drawdowns must add to what was drawn and
//     the series' invested amounts must add to it too. A transcription slip refuses the whole run.
//   • NEWER OR NOTHING. A client statement replaces an account's rows only while it is newer than
//     the upstream's statement for that account. The day GlowVentures reads one of the same or a
//     later date, the entry is reported `superseded` and the upstream's figures stand.
//   • THE BOOK STILL RECONCILES. The headline, the listed/private split and the position count move
//     by exactly the difference the replaced rows make, and managers.json moves with it, so
//     check-book.mjs and the managers' own reconciliation hold after the overlay as before it.
//   • IDEMPOTENT. An account already carrying this statement's id is left alone, so running it on
//     a committed file changes nothing.

export const r2 = (v) => Math.round(v * 100) / 100;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Every reason a transcribed statement cannot be trusted. Empty means it may be laid. */
export function statementProblems(s) {
  const out = [];
  const at = s?.id || '(statement without an id)';
  if (!s?.id || !s.accountId || !DATE.test(s.asOf || '')) out.push(`${at}: needs id, accountId and an ISO asOf`);
  if (!Array.isArray(s?.series) || !s.series.length) {
    out.push(`${at}: carries no unit series`);
    return out;
  }
  const keys = new Set();
  for (const x of s.series) {
    const name = `${at} · ${x.security || x.securityKey}`;
    if (!x.securityKey || keys.has(x.securityKey)) out.push(`${name}: securityKey missing or repeated`);
    keys.add(x.securityKey);
    for (const f of ['units', 'invested', 'navPerUnit', 'value']) if (!isNum(x[f]) || x[f] < 0) out.push(`${name}: ${f} is ${JSON.stringify(x[f])}`);
    if (x.isin != null && !/^[A-Z]{2}[A-Z0-9]{10}$/.test(x.isin)) out.push(`${name}: ISIN ${x.isin} is malformed`);
    const allotted = sum((x.allotments || []).map((a) => a.units));
    if (Array.isArray(x.allotments) && x.allotments.length && r2(allotted) !== r2(x.units)) out.push(`${name}: allotments add to ${allotted} units, the statement holds ${x.units}`);
    for (const a of x.allotments || []) if (!DATE.test(a.date || '')) out.push(`${name}: an allotment has no ISO date`);
    // The printed value is NAV × units rounded by the fund administrator; anything past a basis
    // point is a mistyped figure, not rounding.
    if (isNum(x.units) && isNum(x.navPerUnit) && isNum(x.value) && Math.abs(x.units * x.navPerUnit - x.value) > Math.max(2, x.value * 1e-4)) {
      out.push(`${name}: ${x.units} units × NAV ${x.navPerUnit} = ${r2(x.units * x.navPerUnit)}, not the printed ${x.value}`);
    }
    if (x.performanceSinceInceptionPct != null) {
      if (!isNum(x.performanceSinceInceptionPct)) out.push(`${name}: performance is ${JSON.stringify(x.performanceSinceInceptionPct)}`);
      else if (isNum(x.faceValue) && x.faceValue > 0 && Math.abs((x.navPerUnit / x.faceValue - 1) * 100 - x.performanceSinceInceptionPct) > 0.05) {
        out.push(`${name}: NAV ${x.navPerUnit} on face value ${x.faceValue} is not the printed ${x.performanceSinceInceptionPct}% since inception`);
      }
    }
  }
  const c = s.commitment;
  if (c) {
    if (c.commitments && r2(sum(c.commitments.map((x) => x.amount))) !== r2(c.committed)) out.push(`${at}: commitments add to ${sum(c.commitments.map((x) => x.amount))}, not ${c.committed}`);
    if (c.drawdowns && r2(sum(c.drawdowns.map((x) => x.amount))) !== r2(c.drawn)) out.push(`${at}: drawdowns add to ${sum(c.drawdowns.map((x) => x.amount))}, not ${c.drawn}`);
    if (isNum(c.undrawn) && r2(c.committed - c.drawn) !== r2(c.undrawn)) out.push(`${at}: committed − drawn is ${c.committed - c.drawn}, not the printed ${c.undrawn} uncalled`);
    if (r2(sum(s.series.map((x) => x.invested))) !== r2(c.drawn)) out.push(`${at}: the series' invested amounts add to ${sum(s.series.map((x) => x.invested))}, not the ${c.drawn} drawn`);
  }
  return out;
}

/** The book rows a statement becomes — one per unit series, shaped like build-book.mjs's rows. */
export function rowsFor(s, template, account) {
  return s.series.map((x) => ({
    securityKey: x.securityKey,
    security: x.security,
    symbol: null,
    isin: x.isin ?? null,
    accountId: s.accountId,
    memberId: null,
    sector: template?.sector ?? 'Unclassified',
    providerSector: template?.providerSector ?? null,
    assetClass: template?.assetClass ?? 'AIF',
    quantity: x.units,
    marketValue: x.value,
    costBasis: x.invested,
    unrealizedPnL: r2(x.value - x.invested),
    returnPct: x.performanceSinceInceptionPct ?? null,
    avgCost: x.units ? r2(x.invested / x.units) : null,
    currentPrice: x.navPerUnit,
    costBasisSource: 'statement',
    costUnavailable: null,
    stCostBasis: null,
    ltCostBasis: null,
    daysToLT: null,
    heldSince: (x.allotments || []).map((a) => a.date).sort()[0] ?? null,
    accruedIncome: null,
    dividendReceived: null,
    positionIrrPct: null,
    dedupeGroup: null,
    alsoReportedUnder: null,
    marketSide: template?.marketSide ?? 'private',
    provider: account.provider ?? null,
    owner: account.owner ?? null,
    ownerId: account.ownerId ?? null,
    strategy: account.strategy ?? null,
    engagement: account.engagement ?? null,
    accountAsOf: s.asOf,
    clientStatement: s.id,
    derivedFields: ['unrealizedPnL', 'avgCost'],
  }));
}

const valueOf = (rows) => r2(sum(rows.filter((p) => !p.dedupeGroup).map((p) => (isNum(p.marketValue) ? p.marketValue : 0))));
const sideValue = (rows, side) => r2(sum(rows.filter((p) => !p.dedupeGroup && p.marketSide === side).map((p) => p.marketValue || 0)));

/**
 * Lay every statement over `book` IN PLACE. Returns `{ applied, report }`, where `applied` maps an
 * account id to `{ statement, before, after }` for the managers step. Throws on any refusal.
 */
export function applyToBook(book, statements) {
  const problems = statements.flatMap(statementProblems);
  if (problems.length) throw new Error(`client statements refused:\n  • ${problems.join('\n  • ')}`);
  const report = [];
  const applied = new Map();
  for (const s of statements) {
    const account = (book.accounts || []).find((a) => a.accountId === s.accountId);
    if (!account) throw new Error(`${s.id}: account ${s.accountId} is not in book.json — a statement for an account the book has never seen is a new account, and belongs upstream`);
    const entry = { id: s.id, accountId: s.accountId, asOf: s.asOf, document: s.document, receivedAt: s.receivedAt ?? null };
    if (account.clientStatement === s.id) {
      report.push({ ...entry, status: 'applied', upstreamAsOf: account.upstreamAsOf ?? null, valueBefore: account.upstreamValue ?? null, valueAfter: valueOf(book.positions.filter((p) => p.accountId === s.accountId)) });
      continue;
    }
    if (account.asOf && account.asOf >= s.asOf) {
      report.push({ ...entry, status: 'superseded', upstreamAsOf: account.asOf, reason: `GlowVentures already carries a statement dated ${account.asOf} for this account` });
      continue;
    }
    const before = book.positions.filter((p) => p.accountId === s.accountId);
    if (before.some((p) => p.dedupeGroup)) throw new Error(`${s.id}: ${s.accountId} is part of a dedupe group upstream; laying one member's statement would split the group`);
    const after = rowsFor(s, before[0], account);
    const at = book.positions.findIndex((p) => p.accountId === s.accountId);
    const rest = book.positions.filter((p) => p.accountId !== s.accountId);
    rest.splice(at < 0 ? rest.length : at, 0, ...after);
    book.positions = rest;

    const sm = book.summary;
    const delta = r2(valueOf(after) - valueOf(before));
    sm.totalValue = r2(sm.totalValue + delta);
    if (isNum(sm.privateValue)) sm.privateValue = r2(sm.privateValue + sideValue(after, 'private') - sideValue(before, 'private'));
    if (isNum(sm.listedValue)) sm.listedValue = r2(sm.listedValue + sideValue(after, 'listed') - sideValue(before, 'listed'));
    if (isNum(sm.positionsCount)) sm.positionsCount += after.length - before.length;

    account.upstreamAsOf = account.asOf ?? null;
    account.upstreamValue = valueOf(before);
    account.asOf = s.asOf;
    account.clientStatement = s.id;
    applied.set(s.accountId, { statement: s, before, after });
    report.push({ ...entry, status: 'applied', upstreamAsOf: account.upstreamAsOf, valueBefore: account.upstreamValue, valueAfter: valueOf(after) });
  }
  book.clientStatements = report;
  return { applied, report };
}

/** The managers file's consolidate(), reproduced from build-managers.mjs so the two cannot disagree. */
export function consolidate(rows) {
  const seen = new Set();
  let mv = 0, cost = 0, pnl = 0, costRows = 0, pnlRows = 0, n = 0;
  for (const p of rows) {
    if (p.dedupeGroup) {
      if (seen.has(p.dedupeGroup)) continue;
      seen.add(p.dedupeGroup);
    }
    n++;
    mv += isNum(p.marketValue) ? p.marketValue : 0;
    if (isNum(p.costBasis)) { cost += p.costBasis; costRows++; }
    if (isNum(p.unrealizedPnL)) { pnl += p.unrealizedPnL; pnlRows++; }
  }
  return {
    marketValue: r2(mv),
    costBasis: costRows ? r2(cost) : null,
    costRows,
    unrealizedPnL: pnlRows ? r2(pnl) : null,
    pnlRows,
    positions: n,
    rows: rows.length,
    returnPct: costRows && costRows === n && cost > 0 ? r2(((mv - cost) / cost) * 100) : null,
  };
}

const POSITION_KEYS = ['securityKey', 'security', 'symbol', 'isin', 'sector', 'providerSector', 'assetClass', 'quantity', 'marketValue', 'costBasis', 'unrealizedPnL', 'returnPct', 'avgCost', 'currentPrice', 'positionIrrPct', 'dividendReceived', 'dedupeGroup', 'alsoReportedUnder'];

/**
 * Move managers.json to agree with the book `applyToBook` laid. In place; idempotent (a manager
 * account already carrying the statement's id is left alone); throws if the file stops reconciling.
 * Driven by the BOOK, not by what this run changed, so a managers file rebuilt from upstream beside
 * an already-laid book is brought into step rather than left a statement behind.
 */
export function applyToManagers(file, book, statements, report) {
  const KIND_ORDER = { pms: 0, aif: 1, mf: 2 };
  const byId = new Map(statements.map((s) => [s.id, s]));
  for (const r of report.filter((x) => x.status === 'applied')) {
    const s = byId.get(r.id);
    const accountId = s.accountId;
    const after = book.positions.filter((p) => p.accountId === accountId && p.clientStatement === s.id);
    const m = file.managers.find((x) => (x.accounts || []).some((a) => a.accountId === accountId));
    if (!m) throw new Error(`${s.id}: no manager in managers.json carries ${accountId}`);
    if (m.kind !== 'aif') throw new Error(`${s.id}: ${accountId} sits under a ${m.kind} manager; only an alternative fund's units are carried as rows`);
    const account = m.accounts.find((a) => a.accountId === accountId);
    if (account.clientStatement === s.id) continue;
    account.asOf = s.asOf;
    account.clientStatement = s.id;
    const out = after.map((p) => ({ ...Object.fromEntries(POSITION_KEYS.map((k) => [k, p[k] ?? null])), accountId, owner: account.owner ?? p.owner ?? null, accountAsOf: s.asOf, clientStatement: s.id }));
    const at = m.positions.findIndex((p) => p.accountId === accountId);
    const rest = m.positions.filter((p) => p.accountId !== accountId);
    rest.splice(at < 0 ? rest.length : at, 0, ...out);
    m.positions = rest;
    m.value = consolidate(m.positions);
    m.asOf = m.accounts.map((a) => a.asOf).filter(Boolean).sort().at(-1) ?? null;

    if (s.commitment) {
      const c = (m.commitments || []).find((x) => x.accountId === accountId);
      const calls = s.commitment.drawdowns.map((d) => ({ date: d.date, label: 'Drawdown', amount: d.amount }));
      const next = { committed: s.commitment.committed, drawn: s.commitment.drawn, undrawn: s.commitment.undrawn ?? r2(s.commitment.committed - s.commitment.drawn), called: s.commitment.drawn, paid: s.commitment.drawn, calls, asOf: s.asOf, clientStatement: s.id, arithmeticHolds: true };
      if (c) Object.assign(c, next);
      else (m.commitments ||= []).push({ accountId, name: m.name, provider: account.provider, ownerId: account.ownerId, distributed: null, pending: null, payouts: null, ...next });
    }
    m.returns = (m.returns || []).filter((r) => !(r.accountId === accountId && r.reportType === 'client-nav-statement'));
    m.returns.push({
      accountId,
      reportType: 'client-nav-statement',
      source: s.id,
      series: s.series.map((x) => ({ series: x.seriesName || x.security, isBenchmark: false, mtd: null, qtd: null, fytd: null, m1: null, m3: null, m6: null, y1: null, y3: null, y5: null, y10: null, si: x.performanceSinceInceptionPct ?? null, siAnnualised: false, feeBasis: s.feeBasis ?? null })),
    });
  }
  file.managers.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.value.marketValue - a.value.marketValue || a.name.localeCompare(b.name));
  const sm = file.summary;
  sm.managedValue = r2(sum(file.managers.map((m) => m.value.marketValue)));
  sm.bookValue = book.summary.totalValue;
  for (const k of Object.keys(sm.byKind || {})) {
    const ms = file.managers.filter((m) => m.kind === k);
    sm.byKind[k].marketValue = r2(sum(ms.map((m) => m.value.marketValue)));
    sm.byKind[k].positions = sum(ms.map((m) => m.value.positions));
  }
  const residual = r2(sm.managedValue + sm.direct.marketValue - sm.bookValue);
  if (residual !== 0) throw new Error(`managers.json no longer reconciles after the client statements: managed ${sm.managedValue} + direct ${sm.direct.marketValue} ≠ book ${sm.bookValue} (residual ${residual})`);
  file.clientStatements = report;
  return file;
}

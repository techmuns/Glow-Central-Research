// data/framework-rows.js — join the Framework rubric + company list (framework.json) with the desk's
// typed scores (core/framework.js record) into ranked rows. GLOW-OWNED, pure and testable.
//
// What is summed is summable: a Total is the sum of the criterion scores the desk HAS entered, out
// of the maximum for the criteria scored — never a zero for a criterion nobody has judged (an
// unscored criterion is "not yet", not "weak"). The Governance gate is a DISQUALIFIER, not a score:
// a company failed on governance is flagged and sorts below every company that passes or is unjudged,
// whatever its criterion total — the same meaning the workbook's Pass/Fail gate carries.

export const maxScore = (framework) => (framework?.criteria?.length || 0) * 2;

/** One row per company: its scores, rationales, gate and derived total. `record` is core/framework.js's. */
export function frameworkRows(framework, record) {
  const criteria = framework?.criteria || [];
  const companies = framework?.companies || [];
  return companies.map((c) => {
    const scores = {};
    const rationale = {};
    let total = 0;
    let scoredCount = 0;
    for (const crit of criteria) {
      const v = record.valueFor(c.key, `score:${crit.key}`);
      scores[crit.key] = Number.isInteger(v) ? v : null;
      if (Number.isInteger(v)) { total += v; scoredCount++; }
      const why = record.valueFor(c.key, `why:${crit.key}`);
      rationale[crit.key] = typeof why === 'string' ? why : null;
    }
    const gate = record.valueFor(c.key, 'gate'); // 'pass' | 'fail' | null
    return {
      key: c.key,
      name: c.name,
      ticker: c.ticker || null,
      reason: c.reason || null,
      industry: record.valueFor(c.key, 'industry') || null,
      summary: record.valueFor(c.key, 'summary') || null,
      note: record.valueFor(c.key, 'note') || null,
      scores,
      rationale,
      gate: gate === 'pass' || gate === 'fail' ? gate : null,
      total,
      scoredCount,
      max: maxScore(framework),
    };
  });
}

/**
 * Rank the rows. A governance FAIL sorts last (disqualified). Among the rest, more total first, then
 * more criteria scored (a 6/6 is a firmer 6 than a 6 with four blanks), then name. A row with nothing
 * scored and no gate is "not started" and ranks below scored rows but above governance fails. The
 * rank number is assigned only to rows that carry at least one score or a gate, so an untouched row
 * shows no rank rather than a misleading one.
 */
export function rankRows(rows) {
  const touched = (r) => r.scoredCount > 0 || r.gate !== null;
  const ordered = [...rows].sort((a, b) => {
    const af = a.gate === 'fail', bf = b.gate === 'fail';
    if (af !== bf) return af ? 1 : -1;            // governance fails last
    const at = touched(a), bt = touched(b);
    if (at !== bt) return at ? -1 : 1;            // untouched rows after touched ones
    if (b.total !== a.total) return b.total - a.total;
    if (b.scoredCount !== a.scoredCount) return b.scoredCount - a.scoredCount;
    return String(a.name).localeCompare(String(b.name));
  });
  let rank = 0;
  for (const r of ordered) r.rank = touched(r) && r.gate !== 'fail' ? ++rank : null;
  return ordered;
}

/** framework.json's rubric, shaped for the drill: each criterion with its 0/1/2 definitions. */
export const rubricOf = (framework) => (framework?.criteria || []).map((c) => ({
  key: c.key, label: c.label, question: c.question || '', levels: Array.isArray(c.levels) ? c.levels : [],
}));

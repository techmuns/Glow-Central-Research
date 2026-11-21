// data/framework-rows.js — join the Framework rubric + company list (framework.json) with the desk's
// typed scores (core/framework.js record) into ranked rows. GLOW-OWNED, pure and testable.
//
// What is summed is summable: a Total is the sum of the criterion scores the desk HAS entered, out
// of the maximum for the criteria scored — never a zero for a criterion nobody has judged (an
// unscored criterion is "not yet", not "weak"). The Governance gate is a DISQUALIFIER, not a score:
// a company failed on governance is flagged and sorts below every company that passes or is unjudged,
// whatever its criterion total — the same meaning the workbook's Pass/Fail gate carries.

export const maxScore = (framework) => (framework?.criteria?.length || 0) * 2;

/**
 * One row per company: its scores, rationales, gate and derived total. `record` is
 * core/framework.js's typed sheet; `autoIndex` (optional) is the ticker→auto-score map from
 * data/framework-autoscore.js. A TYPED score always wins; otherwise the AUTO score stands in and is
 * marked so (`source[key] === 'auto'`), with its one-line basis in `autoBasis[key]`. A criterion with
 * neither is null, never 0. The Total counts typed + auto alike — the grid is self-filling, not blank.
 */
export function frameworkRows(framework, record, autoIndex = null) {
  const criteria = framework?.criteria || [];
  const companies = framework?.companies || [];
  return companies.map((c) => {
    const auto = autoIndex && c.ticker ? autoIndex.get(String(c.ticker).toUpperCase()) : null;
    const scores = {};
    const source = {};      // per criterion: 'typed' | 'auto' | null
    const autoBasis = {};   // the one-line reason behind an auto score
    const rationale = {};
    let total = 0;
    let scoredCount = 0;
    let typedCount = 0;
    let autoCount = 0;
    for (const crit of criteria) {
      const typed = record.valueFor(c.key, `score:${crit.key}`);
      const a = auto?.scores?.[crit.key];
      if (Number.isInteger(typed)) {
        scores[crit.key] = typed; source[crit.key] = 'typed'; total += typed; scoredCount++; typedCount++;
      } else if (a && Number.isInteger(a.score)) {
        scores[crit.key] = a.score; source[crit.key] = 'auto'; autoBasis[crit.key] = a.basis;
        total += a.score; scoredCount++; autoCount++;
      } else {
        scores[crit.key] = null; source[crit.key] = null;
      }
      const why = record.valueFor(c.key, `why:${crit.key}`);
      rationale[crit.key] = typeof why === 'string' ? why : null;
    }
    const typedGate = record.valueFor(c.key, 'gate'); // 'pass' | 'fail' | null
    const gate = typedGate === 'pass' || typedGate === 'fail' ? typedGate : (auto?.gate?.gate || null);
    const gateSource = typedGate === 'pass' || typedGate === 'fail' ? 'typed' : (auto?.gate ? 'auto' : null);
    return {
      key: c.key,
      name: c.name,
      ticker: c.ticker || null,
      reason: c.reason || null,
      industry: record.valueFor(c.key, 'industry') || null,
      summary: record.valueFor(c.key, 'summary') || null,
      note: record.valueFor(c.key, 'note') || null,
      scores,
      source,
      autoBasis,
      rationale,
      gate,
      gateSource,
      gateBasis: auto?.gate?.basis || null,
      total,
      scoredCount,
      typedCount,
      autoCount,
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

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { validateExchangeSnapshot } from '../public/js/data/exchange-deals-shared.js';
import { assessCoverage } from '../public/js/data/holdings-integrity.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url), 'utf8'));
let exchange = load('exchange-deals');
try {
  const base = (process.env.SI_BASE || 'https://glow-central-research.tech-441.workers.dev').replace(/\/+$/, '');
  const response = await fetch(`${base}/api/bulk-block-deals`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  exchange = validateExchangeSnapshot(await response.json());
  if (response.headers.get('x-glow-exchange-fallback') === '1') exchange.deliveryError = 'Saved capture served';
} catch { exchange.deliveryError = 'Live exchange delivery unavailable'; }
const primary = load('public-holdings');
const report = assessCoverage({ exchange, snapshot: load('super-investors'), managers: load('managers'), deals: load('insider-trades'), evidence: load('holding-evidence'), publicHoldings: primary });
report.publicSourceChecks = primary.issues;
report.entityReview = primary.candidates;
report.filingReview = primary.sourceExceptions;
const output = process.env.HOLDINGS_AUDIT_OUT || '/tmp/holdings-audit.json';
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
const snapshot = load('super-investors');
const attempt = snapshot.lastAttempt || null;
const lines = [`Coverage audit: ${report.attention}/${report.total} books need attention.`,
  attempt ? `Finology capture attempt ${attempt.at}: ${attempt.refreshed} refreshed, ${attempt.failed} failed${attempt.listError ? `; the live investor list could not be read (${attempt.listError})` : ''}.` : null,
  ...report.issues,
  `Original exchange filings: ${primary.coverage.parsed}/${primary.coverage.indexed} read; ${primary.coverage.securities} distinct ISINs; ${primary.holdings.length} attributed disclosures; ${primary.issues.length} reconciliation checks; ${primary.candidates.length} identity reviews.`,
  ...report.rows.filter((r) => r.issues.length).map((r) => `${r.name}: ${r.issues.join('; ')}. Report: ${r.asOf || 'unknown'}; source check: ${r.fetchedAt || 'unknown'}.`)].filter(Boolean);
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Holdings coverage\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`);

// Known coverage limitations stay in the report. Fail on a broken/overdue ingestion pipeline —
// BUT ONLY FOR THE SOURCES THIS RUN OWNS. The audit is shared by two workflows: investor-refresh
// captures the Finology books and the exchange filings; series-refresh copies the managers'
// statement archive from GlowVentures. Each publishes into its own reviewed data PR, and while a
// PR waits for review the other workflow's checkout still carries the older file — so measured on
// 16 September 2026 each run went red for the OTHER pipeline's unpublished capture, and neither
// summary said so. `HOLDINGS_AUDIT_OWNS` names what this run answers for; everything else is still
// printed, still in the artifact and still on the coverage screen, and is annotated as a warning
// that names the workflow whose capture it is waiting on. Unset, it owns everything (a local run).
const OWNERS = { investors: 'investor-refresh.yml', exchange: 'investor-refresh.yml', managers: 'series-refresh.yml', deals: 'insider-trades-refresh.yml' };
const owns = new Set((process.env.HOLDINGS_AUDIT_OWNS || Object.keys(OWNERS).join(',')).split(',').map((s) => s.trim()).filter(Boolean));
const failures = [];
const warnings = [];
const file = (kind, message) => (owns.has(kind) ? failures : warnings).push(`${message} (${OWNERS[kind]})`);
for (const r of report.rows) {
  const kind = r.kind === 'investor' ? 'investors' : 'managers';
  for (const issue of r.issues) {
    if (kind === 'investors' && /Book unavailable|Refresh failed|Source check overdue/.test(issue)) file(kind, `${r.name}: ${issue}`);
    if (kind === 'managers' && /archive sync not recently/.test(issue)) file(kind, `${r.name}: ${issue}`);
  }
}
for (const issue of report.issues) {
  if (/list unavailable/i.test(issue)) file(/manager/i.test(issue) ? 'managers' : 'investors', issue);
  else if (/bulk\/block feed overdue|live delivery unavailable/i.test(issue)) file('deals', issue);
  else if (/shareholding capture overdue|indexes could not be read|reconciliation unavailable/i.test(issue)) file('exchange', issue);
}
if (attempt?.listError) failures.push(`Finology relay: the live investor list could not be read at ${attempt.at} — ${attempt.listError} (investor-refresh.yml)`);
const distinct = (list) => [...new Set(list.map((line) => line.replace(/^[^:]+: /, '')))];
if (warnings.length) console.log(`::warning title=Waiting on another pipeline's publication::${distinct(warnings).slice(0, 4).join(' · ')}${warnings.length > 4 ? ` · and ${warnings.length - 4} more rows` : ''}. These are not this run's captures; they clear when that workflow's data PR merges.`);
if (failures.length) {
  console.log(`::error title=This run's sources are overdue or unreadable::${distinct(failures).slice(0, 4).join(' · ')}${failures.length > 4 ? ` · and ${failures.length - 4} more rows` : ''}`);
  process.exitCode = 1;
}

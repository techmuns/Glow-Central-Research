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
const lines = [`Coverage audit: ${report.attention}/${report.total} books need attention.`, ...report.issues,
  `Original exchange filings: ${primary.coverage.parsed}/${primary.coverage.indexed} read; ${primary.coverage.companies} companies; ${primary.holdings.length} attributed disclosures; ${primary.issues.length} reconciliation checks; ${primary.candidates.length} identity reviews.`,
  ...report.rows.filter((r) => r.issues.length).map((r) => `${r.name}: ${r.issues.join('; ')}. Report: ${r.asOf || 'unknown'}; source check: ${r.fetchedAt || 'unknown'}.`)];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Holdings coverage\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`);
// Known coverage limitations stay in the report. Fail on a broken/overdue ingestion pipeline.
const operationalFailure = report.rows.some((r) => r.issues.some((issue) => /Book unavailable|Refresh failed|Source check overdue|archive sync not recently/.test(issue))) ||
  report.issues.some((issue) => /list unavailable|bulk\/block feed overdue|live delivery unavailable|shareholding capture overdue|indexes could not be read|reconciliation unavailable/i.test(issue));
if (operationalFailure) process.exitCode = 1;

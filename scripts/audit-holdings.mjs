import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { assessCoverage } from '../public/js/data/holdings-integrity.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url), 'utf8'));
const report = assessCoverage({ snapshot: load('super-investors'), managers: load('managers'), deals: load('insider-trades'), evidence: load('holding-evidence') });
const output = process.env.HOLDINGS_AUDIT_OUT || '/tmp/holdings-audit.json';
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
const lines = [`Coverage audit: ${report.attention}/${report.total} books need attention.`, ...report.issues,
  ...report.rows.filter((r) => r.issues.length).map((r) => `${r.name}: ${r.issues.join('; ')}. Report: ${r.asOf || 'unknown'}; source check: ${r.fetchedAt || 'unknown'}.`)];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Holdings coverage\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`);
// Known coverage limitations stay in the report. Fail on a broken/overdue ingestion pipeline.
const operationalFailure = report.rows.some((r) => r.issues.some((issue) => /Book unavailable|Refresh failed|Source check overdue|archive sync not recently/.test(issue))) ||
  report.issues.some((issue) => /list unavailable|Bulk\/block feed overdue/.test(issue));
if (operationalFailure) process.exitCode = 1;

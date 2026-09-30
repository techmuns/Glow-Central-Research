// Staging-only assertion for the actual filing that exposed the collection outage.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const dir = resolve(process.argv[2] || '.');
assert.notEqual(dir, resolve('public/data'), 'The probe must not inspect or mutate a production capture');
const capture = JSON.parse(readFileSync(join(dir, 'screener-announcements.json'), 'utf8'));
assert.equal(capture.error, null, 'The source check must finish successfully');
assert.equal(capture.pending.length, 0, 'Every page in the requested interval must be read');
const target = capture.rows.find(r => r.url.includes('f6d9abb7-7050-4b1a-9725-aa4ea17421fb'));
assert(target, 'The Sep 29 Bharat Parenterals filing must be recovered from the source index');
assert.equal(target.ticker, 'BPLPHARMA');
assert.equal(target.date, '2026-09-29');
assert.match(target.title, /Board Meeting Outcome/i);
assert(target.providers.includes('Screener announcements'));
console.log(`PASS read-only recovery: Bharat Parenterals filing found; ${capture.rowCount} notices across ${new Set(capture.rows.map(r => r.ticker)).size} companies, ${capture.pagesThisRun} pages. No production data changed.`);

#!/usr/bin/env node
// Local/staging capture only. This does not push, dispatch a job, or modify any upstream source.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { captureIpoFilings } from '../worker/ipo-sources.mjs';
import { legacyIpoFilings, mergeIpoFilings, validateIpoFilings } from '../public/js/data/ipo-filings-shared.js';
const file = new URL('../public/data/ipo-filings.json', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(`../public/data/${path}`, import.meta.url), 'utf8'));
const payload = await captureIpoFilings();
for (const source of payload.sources) console.log(`${source.label}: ${source.status} · ${source.count} filings${source.reason ? ` · ${source.reason}` : ''}`);
if (!payload.ok) throw Error('Every official source failed. Existing capture untouched.');
const previous = existsSync(file) ? validateIpoFilings(JSON.parse(readFileSync(file, 'utf8'))).rows : [];
const legacy = legacyIpoFilings(read('ipo-monitor/index.json').historyDates.map((day) => read(`ipo-monitor/snapshots/${day}.json`)), read('ipo-tracked-issuers.json').issuers);
payload.rows = mergeIpoFilings(legacy, previous, payload.rows);
validateIpoFilings(payload);
writeFileSync(file, JSON.stringify(payload) + '\n');
console.log(`${payload.rows.length} filings retained. Updated local capture only.`);

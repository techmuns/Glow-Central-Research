#!/usr/bin/env node
// scripts/scrape-calendar.mjs — capture the results calendar into public/data/earnings-calendar.json
//
//   node scripts/scrape-calendar.mjs                 # today-3 .. today+21
//   CAL_BACK=7 CAL_AHEAD=30 node scripts/scrape-calendar.mjs
//   CAL_FROM=2026-08-01 CAL_TO=2026-08-31 node scripts/scrape-calendar.mjs
//
// WHY THIS SCRIPT EXISTS, HAVING ARGUED AGAINST IT
//   The first cut of the calendar had no committed file on purpose: a schedule is a claim about
//   the future, and a stale one looks exactly like a fresh one. That objection was right about the
//   danger and wrong about the remedy — the fix for "you cannot tell how old this is" is to stamp
//   it, not to have no fallback at all.
//
//   The forcing reason is that the Worker cannot reliably reach the source. The per-date COUNTS
//   come from api.moneycontrol.com, which is open. The complete company list comes from the
//   paginated HTML endpoints behind www.moneycontrol.com, which may answer an edge request
//   differently from a GitHub runner or ordinary browser. So the capture remains the fallback.
//
//   Every row this writes therefore travels with `capturedAt`, the payload says
//   `listSource: 'snapshot'`, and the UI prints how old the capture is next to a count that is
//   still live. If the schedule has moved since capture, the count and the list disagree on screen
//   — which is the whole point of keeping the count live rather than freezing both together.

import { writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCalendarStrip, fetchCalendarDay, applyIdentity, resolveMissing, CALENDAR_PAGE_SIZE } from '../worker/mc.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/data/earnings-calendar.json');
const MAP = resolve(__dirname, '../public/data/mc-ticker-map.json');

const BACK = Number(process.env.CAL_BACK || 3);
const AHEAD = Number(process.env.CAL_AHEAD || 21);
const PAUSE_MS = Number(process.env.CAL_PAUSE || 400); // politeness between page fetches

const iso = (d) => d.toISOString().slice(0, 10);
const shift = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const today = process.env.CAL_TODAY || iso(new Date());
  const from = process.env.CAL_FROM || shift(today, -BACK);
  const to = process.env.CAL_TO || shift(today, AHEAD);

  console.log(`Results calendar: ${from} .. ${to}`);

  const days = await fetchCalendarStrip({ fromDate: from, toDate: to, indexId: 'All' });
  const live = days.filter((d) => d.count > 0);
  console.log(`  ${days.length} dates in range · ${live.length} with companies scheduled`);

  let map = {};
  try {
    map = JSON.parse(await readFile(MAP, 'utf8')).map || {};
  } catch {
    console.warn('  (no ticker map yet — rows will carry no ticker)');
  }

  // Only dates that actually have companies are worth fetching. Each one follows every published
  // twenty-row page; quiet dates cost one request and weekends cost none.
  const byDate = {};
  let ok = 0;
  let failed = 0;
  for (const d of live) {
    try {
      const day = await fetchCalendarDay({ date: d.date, indexId: 'All', expectedCount: d.count });
      const { resolved } = await resolveMissing(day.rows, map, { limit: 40 });
      Object.assign(map, resolved); // later dates reuse what earlier ones resolved
      byDate[d.date] = {
        rows: applyIdentity(day.rows, map),
        scheduledCount: d.count,
        pageSize: day.pageSize,
        pagesFetched: day.pagesFetched,
        complete: day.complete,
        asOnDate: day.asOnDate,
      };
      ok++;
      process.stdout.write(`  ${d.date}  ${String(day.rows.length).padStart(3)} of ${String(d.count).padStart(3)}  (${day.pagesFetched} page${day.pagesFetched === 1 ? '' : 's'})\n`);
    } catch (err) {
      failed++;
      console.warn(`  ${d.date}  FAILED — ${err.message}`);
    }
    await sleep(PAUSE_MS);
  }

  // A run that captured nothing must not overwrite a good file with an empty one. The Worker would
  // then serve an empty schedule, which reads as "nobody reports" rather than "we did not manage".
  if (!ok) {
    console.error('scrape-calendar: every date failed — leaving the existing file untouched.');
    process.exit(1);
  }

  const payload = {
    capturedAt: new Date().toISOString(),
    from,
    to,
    pageSize: CALENDAR_PAGE_SIZE,
    source: 'Moneycontrol — Earnings Calendar (all-exchange counts plus every earnings-widget pagination page)',
    note: 'The per-date counts and company lists both cover All exchanges. Every published pagination page is captured; counts are re-fetched live by the Worker and these lists are as of capturedAt.',
    days,
    byDate,
  };
  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${OUT}`);
  console.log(`  ${ok} dates captured · ${failed} failed · ${Object.values(byDate).reduce((n, d) => n + d.rows.length, 0)} rows`);
}

main().catch((err) => {
  console.error('scrape-calendar failed:', err.message);
  process.exit(1);
});

// Lightweight scheduled feed: captures public reports, stores an artifact, never writes a branch.
import { readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { EXCHANGE_SOURCES, validateExchangeSnapshot } from '../public/js/data/exchange-deals-shared.js';
import { newsDay as indiaDay } from '../public/js/data/news-window.js';
import { parseExchange, exchangeUrl, shiftDay, applyExchangeSlice, SECURITY_URLS, securityMap, exchangeRequestHeaders } from './lib/exchange-deals.mjs';
import { latestExchangeArtifact, readLimited, MAX_CAPTURE_BYTES } from '../worker/exchange-artifact.mjs';
import { captureMunsInsiders, insiderCaptureCompanies, insiderVerdict } from './lib/muns-insider-capture.mjs';
import { captureCompanies } from './lib/company-capture.mjs';
import { loadActivePortfolio } from './lib/active-portfolio.mjs';

export async function captureExchanges(previous, { now = new Date(), fetchText, checkpoint = () => {} } = {}) {
  let snapshot = structuredClone(validateExchangeSnapshot(previous));
  const checkedAt = now.toISOString(), today = indiaDay(now.getTime());
  fetchText ||= async (url) => new TextDecoder().decode(await readLimited(await fetch(url, {
    headers: exchangeRequestHeaders(url), signal: AbortSignal.timeout(30000),
  })));
  // Matching by ISIN avoids collisions between BSE security IDs and unrelated NSE symbols.
  try {
    const [nse, bse] = await Promise.all([fetchText(SECURITY_URLS.nse), fetchText(SECURITY_URLS.bse)]);
    snapshot.securityMap = { ...snapshot.securityMap, ...securityMap(nse, bse) };
    snapshot.identity = { checkedAt, lastSuccessAt: checkedAt, ok: true, error: null };
  } catch (error) { snapshot.identity = { ...snapshot.identity, checkedAt, ok: false, error: error.message }; }
  for (const source of EXCHANGE_SOURCES) {
    const prior = snapshot.sources.find((s) => s.id === source.id);
    // Resume from the last successful interval, including a week of overlap. A long outage is
    // caught up in bounded slices rather than quietly jumping the cursor to this week.
    let from = shiftDay(prior.coverage.map((w) => w.to).sort().at(-1) || today, -7);
    while (from <= today) {
      const to = shiftDay(from, 30) < today ? shiftDay(from, 30) : today;
      try {
        const rows = parseExchange(await fetchText(exchangeUrl(source, from, to)), source);
        if (!rows.length && snapshot.records.some((r) => r[0] === source.id && r[1] >= from && r[1] <= to)) throw new Error('Unexpected empty export for an interval with retained trades');
        snapshot = applyExchangeSlice(snapshot, source, rows, { from, to, checkedAt });
        console.log(`${source.id}: ${rows.length} rows, ${from} – ${to}`);
      } catch (error) {
        snapshot = applyExchangeSlice(snapshot, source, [], { from, to, checkedAt, error: error.message });
        checkpoint(snapshot);
        console.error(`${source.id}: ${error.message}; retained prior reports`); break;
      }
      checkpoint(snapshot);
      from = shiftDay(to, 1);
    }
  }
  return snapshot;
}

/** The run's exit rule: an exchange source that failed, plus the insider supplement's own verdict. */
export function captureVerdict(snapshot, options) {
  const insiders = insiderVerdict(snapshot?.insiders, options);
  const sources = (snapshot?.sources || []).filter(s => !s.ok).map(s => `${s.id}: ${s.error || 'unavailable'}; retained reports are published.`);
  return { ...insiders, failures: [...sources, ...insiders.failures] };
}

// GitHub workflow commands end at a newline, so the text is escaped rather than trusted.
const annotate = (level, text) => console.log(`::${level}::${String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);

function report(snapshot, verdict) {
  verdict.failures.forEach(line => annotate('error', line));
  verdict.warnings.forEach(line => annotate('warning', line));
  verdict.notices.forEach(line => annotate('notice', line));
  const run = snapshot.insiders?.run;
  const lines = ['### NSE / BSE bulk and block capture', '',
    ...(snapshot.sources || []).map(s => `- ${s.id}: ${s.ok ? 'OK' : `failed — ${s.error || 'unavailable'}`}`),
    ...(run ? [`- Insider disclosures: ${run.checked} of ${snapshot.insiders.targetTickers.length} companies checked in this run (${run.answered} answered, ${run.failed} failed) in ${run.requests} requests; ${run.noRecordConfirmed} newly named no-record and ${run.noRecordReconfirmed} still refused. The run was ${run.clean ? 'clean, so refusals could be confirmed' : 'not clean, so no refusal was named no-record'}.`] : []),
    '', ...[...verdict.failures.map(l => `**Failed:** ${l}`), ...verdict.warnings.map(l => `**Pending:** ${l}`), ...verdict.notices.map(l => `**Stated:** ${l}`)].map(l => `- ${l}`)];
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  else console.log(lines.join('\n'));
}

async function main() {
  let previous = JSON.parse(readFileSync(new URL('../public/data/exchange-deals.json', import.meta.url), 'utf8'));
  if (process.env.GITHUB_ACTIONS === 'true') {
    // Failure to read history aborts the run. It must never publish a reset archive over newer data.
    const archive = await latestExchangeArtifact({ repo: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN });
    if (archive) {
      const retained = validateExchangeSnapshot(JSON.parse(archive.text));
      if (Date.parse(retained.updatedAt || retained.checkedAt) >= Date.parse(previous.updatedAt || previous.checkedAt)) previous = retained;
    }
  }
  const save = (snapshot) => {
    const text = JSON.stringify(snapshot);
    if (Buffer.byteLength(text) > MAX_CAPTURE_BYTES) throw new Error('Capture exceeds delivery limit; previous archive retained');
    mkdirSync('tmp/exchange-capture', { recursive: true });
    const file = 'tmp/exchange-capture/exchange-deals.json.gz';
    writeFileSync(`${file}.tmp`, gzipSync(text));
    renameSync(`${file}.tmp`, file);
  };
  const snapshot = await captureExchanges(previous, { checkpoint: save });
  try {
    const book = await loadActivePortfolio(fileURLToPath(new URL('../public/data/portfolio-companies.json', import.meta.url)));
    const { companies } = captureCompanies(fileURLToPath(new URL('../public/data/', import.meta.url)), {
      holdings: book.holdings.map(c => ({ ...c, priority: true })),
    });
    // The book's ISINs let a renamed holding be asked by the symbol it trades under today.
    const isins = new Map(book.holdings.filter(c => c.ticker && c.isin).map(c => [String(c.ticker).trim().toUpperCase(), c.isin]));
    const known = companies.map(c => c.isin || !isins.has(c.ticker) ? c : { ...c, isin: isins.get(c.ticker) });
    const retained = JSON.parse(readFileSync(new URL('../public/data/insider-trades.json', import.meta.url), 'utf8'));
    snapshot.insiders = await captureMunsInsiders(snapshot.insiders, insiderCaptureCompanies(known, retained, snapshot), {
      request: async (ticker, from, to) => {
        const response = await fetch(`https://glow-central-research.tech-441.workers.dev/api/insider-trades/${encodeURIComponent(ticker)}?from=${from}&to=${to}`, {
          headers: { accept: 'application/json' }, signal: AbortSignal.timeout(45000),
        });
        return JSON.parse(new TextDecoder().decode(await readLimited(response, 2 * 1024 * 1024)));
      },
      checkpoint: insiders => { snapshot.insiders = insiders; snapshot.updatedAt = insiders.checkedAt; save(snapshot); },
    });
  } catch (error) {
    // The previous run's record must not stand in for a run that did not happen.
    snapshot.insiders = { targetTickers: [], byTicker: {}, ...snapshot.insiders, run: null, error: error.message };
  }
  snapshot.updatedAt = new Date().toISOString();
  save(snapshot);
  const verdict = captureVerdict(snapshot);
  report(snapshot, verdict);
  if (verdict.failures.length) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

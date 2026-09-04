import { readFileSync } from 'node:fs';
import { boundedJson, validateResolvedPortfolio, assertBookChange } from '../../public/js/data/family-book-contract.js';

/** Scheduled collectors use the same resolved active book as the UI. Local
 * verification stays offline unless explicitly opted in. No fixture is written. */
export async function loadActivePortfolio(path, { live = process.env.FAMILY_HOLDINGS_LIVE === 'true', fetcher = fetch } = {}) {
  if (!live) return JSON.parse(readFileSync(path, 'utf8'));
  const response = await fetcher('https://sattva-central-research.tech-441.workers.dev/api/family-portfolio', {
    signal: AbortSignal.timeout(20000), cache: 'no-store', redirect: 'error',
  });
  const body = await boundedJson(response, 2 * 1024 * 1024);
  validateResolvedPortfolio(body);
  assertBookChange(body, JSON.parse(readFileSync(path, 'utf8')));
  return body;
}

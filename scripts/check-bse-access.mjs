#!/usr/bin/env node
// Read-only host qualification. No capture files, retry states or production jobs are changed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, HEADERS } from '../worker/bse-ann.mjs';
import { fetchBseIdentityMaster } from './lib/announcement-identities.mjs';
import { collectBseAnnouncements, collectBseCompanyAnnouncements } from './lib/bse-collection.mjs';

const shiftDay = (day, offset) => new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);

export async function checkBseAccess({ previousIdentities, to, scripCode = '522287', now = Date.now(),
  fetchImpl = fetch, gapMs = 500 } = {}) {
  const today = new Date(now + 330 * 60000).toISOString().slice(0, 10);
  to ||= shiftDay(today, -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to) || !Number.isFinite(Date.parse(`${to}T00:00:00Z`))
    || shiftDay(to, 0) !== to || to >= today) {
    throw new Error('BSE_PROBE_TO must be a valid completed calendar day in India (YYYY-MM-DD).');
  }
  if (!/^\d{6}$/.test(scripCode)) throw new Error('BSE_PROBE_SCRIP must be a six-digit BSE code.');
  const master = await fetchBseIdentityMaster(previousIdentities, { headers: HEADERS, fetcher: fetchImpl });
  const identity = master.find(row => String(row.SCRIP_CD) === scripCode);
  if (!identity) throw new Error(`BSE probe scrip ${scripCode} is absent from the validated directory.`);
  const options = { fetchImpl, gapMs, attempts: 1 };
  const exchange = await collectBseAnnouncements({ from: to, to }, options);
  if (!exchange.rows.length) throw new Error('BSE probe found no exchange records. Select a completed day with known filings.');
  const from = shiftDay(to, -364);
  const company = await collectBseCompanyAnnouncements({ scripCode, from, to }, options);
  if (company.pages < 2) throw new Error('BSE probe did not establish multi-page company access. Select an issuer with more than 50 filings in the past year.');
  return {
    ok: true, checkedAt: new Date().toISOString(), directoryRows: master.length,
    exchange: { from: to, to, configuredCategories: CATEGORIES.length, rows: exchange.rows.length,
      requests: exchange.requests, byCategory: exchange.byCategory },
    company: { scripCode, name: identity.Scrip_Name, from, to, declared: company.declared,
      collected: company.collected, pages: company.pages, requests: company.requests },
    limitation: 'This proves access for these requests on this host at this time; it does not establish continuous access or certify an exhaustive BSE category inventory.',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const previousIdentities = JSON.parse(readFileSync(new URL('../public/data/announcement-identities.json', import.meta.url), 'utf8'));
    console.log(JSON.stringify(await checkBseAccess({ previousIdentities,
      to: process.env.BSE_PROBE_TO, scripCode: process.env.BSE_PROBE_SCRIP || '522287' }), null, 2));
  } catch (error) {
    console.error(`BSE access qualification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

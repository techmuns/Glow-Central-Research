#!/usr/bin/env node
// Read-only comparison on the actual collection network. No credentials, writes or dispatches.
import { readFileSync } from 'node:fs';
import { HEADERS } from '../worker/bse-ann.mjs';
import { checkBseAccess } from './check-bse-access.mjs';

const previousIdentities = JSON.parse(readFileSync(new URL('../public/data/announcement-identities.json', import.meta.url), 'utf8'));
const now = Date.now();
const profiles = [
  ['previous', {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    referer: 'https://www.bseindia.com/corporates/ann.html',
    accept: 'application/json, text/plain, */*',
  }],
  ['current', HEADERS],
];
for (const [profile, headers] of profiles) {
  try {
    const result = await checkBseAccess({ previousIdentities, now,
      to: process.env.BSE_PROBE_TO, scripCode: process.env.BSE_PROBE_SCRIP || '522287',
      fetchImpl: (url, options) => fetch(url, { ...options, headers }),
    });
    console.log(JSON.stringify({ profile, ...result }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ profile, ok: false, message: error.message }));
    if (profile === 'current') process.exitCode = 1;
  }
}

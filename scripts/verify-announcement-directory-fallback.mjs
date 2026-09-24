import assert from 'node:assert/strict';
import { BSE_MASTER_URL, readAnnouncementIdentityDirectory, retainedBseScripIndex } from './lib/announcement-identities.mjs';
const now = Date.parse('2026-09-24T10:00:00Z');
const previous = { version: 1, source: BSE_MASTER_URL, capturedAt: '2026-09-20T10:00:00Z', entries: [
  { isin: 'INE000A01001', name: 'Alpha', bseCode: '500001', bseCodes: ['500001','500002'], bseSymbol: 'ALPHA', ticker: 'ALPHANSE' }
] };
let requests = 0;
const unavailable = async url => { assert.equal(url, BSE_MASTER_URL); requests++; return new Response('Access denied', { status: 403 }); };
const result = await readAnnouncementIdentityDirectory(previous, {}, { now, fetcher: unavailable });
assert.equal(requests, 1, 'a denial causes no endpoint, identity or header workaround');
assert.equal(result.identities, previous, 'retained directory and dates remain unchanged');
assert.equal(result.publish, false, 'an old directory cannot be republished as freshly verified');
assert.equal(result.health.ok, false);
assert.equal(result.health.lastSuccessAt, previous.capturedAt);
assert.equal(result.health.attemptedAt, new Date(now).toISOString());
assert.equal(result.health.source, 'retained');
const index = retainedBseScripIndex(result.identities);
assert.equal(index.get('500002').ticker, 'ALPHA', 'historical codes remain matched with BSE provenance');
assert.equal(index.get('500001').source, 'bse-retained');
assert.equal(index.get('599999'), undefined, 'unknown filers cannot acquire another issuer identity');
for (const invalid of [null, {...previous, capturedAt:'2099-01-01'}, {...previous, source:'wrong'}, {...previous, entries:[...previous.entries,...previous.entries]}]) {
  const fallback = await readAnnouncementIdentityDirectory(invalid, {}, { now, fetcher: unavailable });
  assert.equal(fallback.identities, null);
  assert.equal(fallback.health.source, 'unavailable');
  assert.equal(fallback.health.lastSuccessAt, null);
  assert.equal(fallback.publish, false);
}
const master = Array.from({length:1000}, (_,i) => ({ SCRIP_CD: String(500001+i), Status: ['Active','Suspended','Delisted'][i%3],
  ISIN_NUMBER: `INE${String(i).padStart(7,'0')}01`, scrip_id:`TEST${i}`, Scrip_Name:`Company ${i}` }));
const fresh = await readAnnouncementIdentityDirectory(previous, {}, { now, fetcher: async()=>Response.json(master) });
assert.equal(fresh.publish,true); assert.equal(fresh.health.ok,true); assert.equal(fresh.identities.capturedAt,new Date(now).toISOString());
const incomplete = await readAnnouncementIdentityDirectory(previous, {}, { now, fetcher: async()=>Response.json(master.slice(0,5)) });
assert.equal(incomplete.publish,false); assert.equal(incomplete.identities,previous);
console.log('PASS: ancillary BSE directory outages preserve raw collection, dated valid identities and explicit partial health; incomplete directories never replace evidence.');

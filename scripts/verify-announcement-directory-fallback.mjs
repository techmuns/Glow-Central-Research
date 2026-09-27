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

// Exercise the actual scheduled entry point in an isolated copy. Every fetch is
// intercepted; neither source endpoints nor the repository's data files are touched.
const { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { spawnSync } = await import('node:child_process');
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'sattva-bse-directory-'));
try {
  for (const part of ['scripts/lib','public/js/data','worker/bse-ann.mjs','scripts/scrape-bse-announcements.mjs']) {
    mkdirSync(dirname(join(temporary,part)), { recursive:true });
    cpSync(join(root,part),join(temporary,part),{recursive:true});
  }
  const data = join(temporary,'public/data'); mkdirSync(data,{recursive:true});
  const registryText = JSON.stringify(previous);
  writeFileSync(join(data,'announcement-identities.json'),registryText);
  writeFileSync(join(data,'corp-announcements.json'),JSON.stringify({ byTicker:{ ALPHA:[{newsId:'old-retained',ticker:'ALPHA',company:'Alpha',title:'Earlier evidence',headline:'Earlier evidence',date:'2026-08-01'}] }, from:'2026-08-01', to:'2026-09-23', lastCompleteTo:'2026-09-23' }));
  writeFileSync(join(temporary,'fixture.mjs'), `
    globalThis.fetch = async input => {
      const url = new URL(input);
      if (url.pathname.includes('ListofScripData')) return new Response('denied',{status:403});
      if (!url.pathname.includes('AnnSubCategoryGetData')) throw Error('Unexpected source request');
      if (process.env.FIXTURE_SOURCE_FAILURE) return new Response('unavailable',{status:503});
      const category=url.searchParams.get('strCat');
      return Response.json({Table1:[{ROWCNT:2}],Table:['500001','599999'].map(code=>({ SCRIP_CD:code, SLONGNAME:code==='500001'?'Alpha':'Unknown issuer', HEADLINE:'Original source filing', NEWSID:category+code, CATEGORYNAME:category, NEWS_DT:'2026-09-24T10:00:00', ATTACHMENTNAME:code+'.pdf' }))});
    };
  `);
  const run = failure => spawnSync(process.execPath,['--import',join(temporary,'fixture.mjs'),join(temporary,'scripts/scrape-bse-announcements.mjs')],{
    cwd:temporary, env:{PATH:process.env.PATH, ANN_FROM:'2026-09-24',ANN_TO:'2026-09-24',...(failure?{FIXTURE_SOURCE_FAILURE:'1'}:{})},encoding:'utf8',timeout:30000
  });
  const first=run(false); assert.equal(first.status,0,first.stderr);
  const captureText=readFileSync(join(data,'corp-announcements.json'),'utf8');
  const capture=JSON.parse(captureText);
  assert.equal(capture.identityDirectory.ok,false); assert.equal(capture.coversUniverse,false);
  assert.equal(capture.lastCompleteTo,'2026-09-24','successful filing pagination advances independently of identity refresh');
  assert(capture.byTicker.ALPHA.length>0); assert(capture.byTicker['BSE:599999'].length>0,'unresolved issuer filings survive');
  assert.equal(readFileSync(join(data,'announcement-identities.json'),'utf8'),registryText,'no identity timestamp or bytes are republished');
  assert(JSON.parse(readFileSync(join(data,'announcements-archive/2026-08.json'),'utf8')).rows.some(row=>row.newsId==='old-retained'),'old evidence is archived before the display window');
  const failed=run(true); assert.notEqual(failed.status,0);
  assert.equal(readFileSync(join(data,'corp-announcements.json'),'utf8'),captureText,'a filing endpoint failure cannot overwrite retained evidence');
  console.log('PASS scheduled entry point: directory 403 still captures known and unknown issuers, preserves registry/history, and refuses a failed filing response.');
} finally { rmSync(temporary,{recursive:true,force:true}); }

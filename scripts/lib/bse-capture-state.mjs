import { buildAnnouncementIdentities } from './announcement-identities.mjs';
import { bseLastCompleteTo } from './bse-collection.mjs';

// Directory availability must not decide whether an exchange notice is retained.
// Unknown issuers remain under their BSE code until a later verified directory resolves them.
export async function bseCaptureIndex({ previous, mcMap = {}, fetchMaster, now = Date.now() }) {
  const byCode = new Map();
  for (const row of Object.values(mcMap)) if (/^\d{6}$/.test(String(row?.bseId)) && row?.ticker)
    byCode.set(String(row.bseId), { ticker: String(row.ticker).toUpperCase(), name: row.fullName || null, source: 'confirmed' });
  const confirmed = byCode.size;
  try {
    const master = await fetchMaster(previous);
    for (const row of master) {
      const code = String(row.SCRIP_CD || '').trim();
      const symbol = String(row.scrip_id || '').trim().toUpperCase();
      if (!byCode.has(code)) byCode.set(code, { ticker: symbol || null, name: row.Scrip_Name || null, source: symbol ? 'bse' : null });
    }
    return { byCode, confirmed, masterRows: master.length,
      identities: buildAnnouncementIdentities(master, mcMap, new Date(now).toISOString()), identityError: null };
  } catch {
    if (previous?.version === 1 && Number.isFinite(Date.parse(previous.capturedAt)) && Array.isArray(previous.entries)) {
      for (const row of previous.entries) {
        if (!/^IN[A-Z0-9]{10}$/.test(row.isin || '')) continue;
        for (const code of new Set([row.bseCode, ...(row.bseCodes || [])])) {
          if (/^\d{6}$/.test(String(code)) && !byCode.has(String(code))) byCode.set(String(code), {
            ticker: row.ticker || row.bseSymbol || null, name: row.name || null, source: 'saved-bse',
          });
        }
      }
    }
    return { byCode, confirmed, masterRows: null, identities: null,
      identityError: { at: new Date(now).toISOString(), reason: 'directory-unavailable',
        message: 'The BSE company directory could not be refreshed. Saved identities and unresolved BSE codes are retained.' } };
  }
}

export function failedBseCapture(previous, { now = Date.now(), reason = 'upstream' } = {}) {
  const at = new Date(now).toISOString();
  const error = { reason, at, message: 'BSE announcements could not be checked. Previously captured announcements are retained.' };
  return { ...(previous || { kind: 'announcements', byTicker: {}, rowCount: 0, capturedAt: null }),
    lastAttemptAt: at, lastError: error, coversUniverse: false, lastCompleteTo: bseLastCompleteTo(previous),
    failed: { ...(previous?.failed || {}), 'BSE collection': error } };
}

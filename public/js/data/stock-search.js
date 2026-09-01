// data/stock-search.js — browser client for the Worker-held Muns company search credential.

export async function searchCompanies(query, { signal } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];

  const res = await fetch(`api/stock-search?q=${encodeURIComponent(q)}`, {
    cache: 'no-store',
    signal,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // The named error below is more useful than a JSON parser exception.
  }
  if (!res.ok || !body?.ok) {
    throw new Error(body?.message || `Company search could not be read (${res.status}).`);
  }
  return Array.isArray(body.results) ? body.results : [];
}

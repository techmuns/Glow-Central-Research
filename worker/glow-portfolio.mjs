import { readGlowBook } from '../public/js/data/glow-book-contract.js';

// Names-only interface consumed by the shell and scheduled collectors. Both files
// come from this deployment's ASSETS binding; there is no Sattva endpoint/token.
export async function handleGlowPortfolio(request, env) {
  if (request.method !== 'GET') return Response.json({ ok: false }, { status: 405 });
  try {
    const { portfolio } = await readGlowBook((path, options) => env.ASSETS.fetch(new Request(new URL(path, request.url), options)));
    return Response.json(portfolio, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ ok: false, syncStatus: 'unavailable', error: 'Glow statement snapshot could not be verified. Retaining the last saved holdings.' },
      { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}

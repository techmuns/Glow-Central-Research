// Cloudflare Worker entry point.
// Today it does exactly one thing: serve the static site in public/ via the ASSETS binding.
// The /api/* block below is the single place future server-side routes get added (live
// technicals proxying, transcript fetching, etc.) — everything else falls through to assets.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------------------------------------------------------------------------------
    // FUTURE API ROUTES GO HERE
    // e.g.
    //   if (url.pathname.startsWith('/api/technicals')) return handleTechnicals(request, env);
    //   if (url.pathname.startsWith('/api/concall'))    return handleConcall(request, env);
    // Keep handlers in their own modules and import them at the top of this file.
    // ---------------------------------------------------------------------------------
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Not implemented', path: url.pathname }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    return env.ASSETS.fetch(request);
  },
};

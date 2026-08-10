// app.js — bootstrap: load the JSON data set once, then mount the shell (which starts the
// router and renders the first tab). Every tab reads its slice off `state.data` via ctx.data,
// so there is exactly one fetch pass at startup and pollers handle everything after that.

import { $ } from './core/dom.js';
import { setData, setDataError } from './core/state.js';
import { mount } from './ui/shell.js';

// Add a file here and every tab can read it off `ctx.data.<key>` — no other wiring needed.
const DATA_SOURCES = {
  portfolio: 'data/portfolio.json',
  universe: 'data/universe.json',
  earnings: 'data/mock/earnings.json',
  concallFeed: 'data/mock/concall-feed.json',
  concallKeywords: 'data/mock/concall-keywords.json',
  chatter: 'data/mock/chatter.json',
  superinvestors: 'data/mock/superinvestors.json',
  institutions: 'data/mock/institutions.json',
  transactions: 'data/mock/transactions.json',
};

async function loadAll() {
  const entries = Object.entries(DATA_SOURCES);
  const results = await Promise.all(
    entries.map(async ([key, path]) => {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed to load ${path} (${res.status})`);
      return [key, await res.json()];
    })
  );
  return Object.fromEntries(results);
}

async function boot() {
  const root = $('#app');
  try {
    setData(await loadAll());
  } catch (err) {
    console.error('[app] data load failed', err);
    setDataError(err);
    root.innerHTML = `
      <div class="mx-auto max-w-lg px-6 py-24 text-center">
        <div class="text-3xl">⚠️</div>
        <h1 class="font-display mt-2 text-lg font-bold text-slate-900">Could not load dashboard data</h1>
        <p class="mt-1 text-sm text-slate-500">${err.message}</p>
        <p class="mt-3 text-xs text-slate-400">Serve this site over HTTP (e.g. <code class="rounded bg-slate-100 px-1 py-0.5">python3 -m http.server 8080 -d public</code>) — opening index.html from the filesystem blocks fetch().</p>
      </div>`;
    return;
  }
  mount(root);
}

boot();

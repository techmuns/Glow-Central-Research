// tabs/market-news-view.js — the Universe half of the News tab: market-wide stocks news.
//
// ONE TAB, TWO QUESTIONS, AND THE SCOPE TOGGLE PICKS WHICH.
//   Portfolio scope asks "what has been written about each of these companies" — a search, one
//   request per company, which is why it makes the reader name them. Universe scope asks the other
//   question, "what has been published", because 603 searches is ten minutes of somebody else's
//   service. They are different feeds from different publishers answering different questions, and
//   the description on each says which — a reader must never have to guess why the same tab shows
//   unrelated rows under two scopes.
//
// WHAT THE REFRESH CONTROL MAY CLAIM.
//   Neither the browser nor the Worker can read Moneycontrol — both get a 403 from TLS
//   fingerprinting, measured (see js/data/market-news.js). A scheduled Action reads it and commits
//   the capture. So this button asks whether a NEWER CAPTURE exists; it cannot and does not fetch
//   the publisher. It says so in those words, and the two times are printed separately:
//
//     "Moneycontrol last read"  the capture's own time — how fresh the NEWS is
//     "checked"                 when this browser last confirmed it has the newest capture
//
//   A twenty-minute-old capture confirmed one second ago is fresh in one sense and not the other,
//   and one combined "updated just now" would let the second stand in for the first.
//
// NO SCORE, NO SENTIMENT, NO RANKING. The order is the publisher's own, by their article id.
// Headlines and standfirsts are theirs, reproduced; the article stays on their site.

import { sectionHead, openModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as marketNews from '../data/market-news.js';

let unsub = null;
let disposers = [];
let ctxRef = null;
let busy = false;
let lastResult = null;
// The run in flight, or null. Module state, not node state — a walk outlives many repaints, and
// holding it on the button meant the control vanished mid-run and came back offering to start
// another. (See CLAUDE.md, *Work the reader has to ask for*: the result must survive its own
// repaints.) `{ phase, text, runUrl?, fix? }`.
let scrape = null;
// The reader's own filters. Module state, not node state: every repaint rebuilds the list, so a
// value held on the input would be discarded the moment a capture landed.
let listView = { q: '', section: 'all' };
let fillStop = null;

/** IST, because the market and the publisher are both there and the reader almost certainly is. */
function istTime(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function pill(m) {
  const captured = m.capturedAt ? formatRelativeTime(Date.parse(m.capturedAt)) : null;
  const label = m.reason ? 'No capture' : `Captured ${captured || 'unknown'}`;
  const tone = m.reason ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-sky-50 text-sky-700 ring-sky-200';
  return `<button type="button" data-mcnews-info
      class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1 ${tone} transition hover:brightness-95">
      <span class="h-1.5 w-1.5 rounded-full ${m.reason ? 'bg-amber-500' : 'bg-sky-500'}"></span>
      ${escapeHtml(label)}
      <span class="font-normal opacity-70">${escapeHtml(formatNumber(m.count))} stories</span>
    </button>`;
}

/**
 * The freshness line and the two controls.
 *
 * A row of its own under the heading, never the `meta` slot — the text changes as the capture ages
 * and as the buttons report, and a control that moves when you use it reads as a different page.
 *
 * TWO BUTTONS, BECAUSE THEY ARE TWO DIFFERENT ACTS AND THE READER IS OWED THE DIFFERENCE.
 *
 *   "Check for new stories"      one conditional GET, usually a bodyless 304. Costs nothing.
 *   "Fetch from Moneycontrol"    asks a GitHub runner to go and read the publisher. A real run and
 *                                a real request to somebody else's site.
 *
 * This is the Deep Dive split (CLAUDE.md, *Triggering someone else's pipeline*) arriving on a
 * second feed: separate what costs from what does not, hold that line on every surface, and let
 * nothing that costs fire on its own. Neither button is the primary one by accident — the free one
 * answers the common question ("has anything landed?") and the metered one answers the rarer one
 * ("go and look now"), so the cheap answer is the one a reader reaches for first.
 */
function controls(m) {
  const captured = m.capturedAt ? formatRelativeTime(Date.parse(m.capturedAt)) : 'never';
  const checked = m.checkedAt ? formatRelativeTime(m.checkedAt) : 'not yet';
  const result = lastResult
    ? `<span class="ml-2 font-semibold ${lastResult.tone || 'text-slate-500'}">${escapeHtml(lastResult.text)}</span>`
    : '';
  const scraping = !!scrape;
  return `
    <div class="w-full rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-100">
      <div class="flex flex-wrap items-center gap-3">
        <button type="button" data-mcnews-refresh ${busy || scraping ? 'disabled' : ''}
          class="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400">
          <span>${busy ? '…' : '⟳'}</span><span>${busy ? 'Checking' : 'Check for new stories'}</span>
        </button>
        <button type="button" data-mcnews-scrape ${scraping || busy ? 'disabled' : ''}
          title="Asks the scheduled job to read moneycontrol.com now. It runs on a GitHub runner, because neither this browser nor the edge can fetch that host."
          class="inline-flex items-center gap-1.5 rounded-xl bg-white px-3.5 py-2 text-sm font-semibold text-indigo-700 shadow-sm ring-1 ring-indigo-200 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:text-slate-400 disabled:ring-slate-200">
          <span>${scraping ? '◔' : '↧'}</span><span>${scraping ? 'Reading Moneycontrol' : 'Fetch from Moneycontrol'}</span>
        </button>
        <p class="min-w-0 flex-1 text-xs leading-relaxed text-slate-500">
          <strong class="text-slate-700">Moneycontrol last read ${escapeHtml(captured)}</strong>
          · this page checked for a newer capture ${escapeHtml(checked)}.
          Refreshed automatically every 20 minutes.${result}
        </p>
      </div>
      ${scrapeNote()}
    </div>`;
}

/**
 * What the run is doing, in GitHub's own words.
 *
 * REPRODUCE THEIR VOCABULARY, DO NOT INVENT ONE. `queued`, `in_progress` and `completed` are
 * theirs; the sentence around them is ours and says only what was observed. And there is no
 * elapsed clock and no percentage: a progress bar over a run whose length nobody knows is a
 * confidence this page does not have.
 */
function scrapeNote() {
  if (!scrape) return '';
  const tone = {
    dispatched: 'bg-indigo-50 text-indigo-800 ring-indigo-100',
    running: 'bg-indigo-50 text-indigo-800 ring-indigo-100',
    publishing: 'bg-indigo-50 text-indigo-800 ring-indigo-100',
    failed: 'bg-rose-50 text-rose-800 ring-rose-100',
  }[scrape.phase] || 'bg-slate-50 text-slate-700 ring-slate-200';
  const link = scrape.runUrl
    ? ` <a href="${escapeHtml(scrape.runUrl)}" target="_blank" rel="noopener noreferrer" class="font-semibold underline decoration-dotted underline-offset-2">watch the run</a>`
    : '';
  const fix = scrape.fix ? ` <code class="rounded bg-white/70 px-1">${escapeHtml(scrape.fix)}</code>` : '';
  return `<p data-mcnews-scrape-note class="mt-2 rounded-xl px-3 py-2 text-xs leading-relaxed ring-1 ${tone}">${escapeHtml(scrape.text)}${fix}${link}</p>`;
}

// ---------------------------------------------------------------------------------------
// AN EDITORIAL LIST, NOT A TABLE — the one place in this dashboard that hand-rolls its rows.
//
// CLAUDE.md says to build every tab out of the screener kit and not to hand-roll a table, and that
// rule stands everywhere it applies. It does not apply here: this feed's row is a thumbnail, a
// headline and a standfirst — a piece of editorial, not a record with columns — and `scoreTable`
// models a record with columns. Forcing it into one made a headline share width with a date and a
// section chip, which is exactly backwards for content whose headline IS the row.
//
// What the kit's discipline still buys, and is kept by hand here:
//   • A SCREENFUL FIRST, then the rest under requestIdleCallback. 600 cards is far more DOM than
//     600 table rows, so mounting all of it up front would block the main thread on every visit.
//     `data-rows-pending` on the section is the honest signal that stories are outstanding, and the
//     suite waits on it rather than sleeping.
//   • KEYS DERIVED FROM CONTENT — the publisher's article id — never a position.
//   • Every string escaped. These are somebody else's headlines arriving over the network.
//
// THE WHOLE CARD IS THE LINK. A news list where only a small arrow is clickable makes the reader
// hunt for the one live pixel; the anchor wraps the row, so clicking anywhere opens the publisher's
// page in a new tab. `rel="noopener noreferrer"` because the destination is not ours.

const FIRST_PAINT = 24;

/** Which stories the search box and the section filter leave. */
function visibleRows(rows) {
  const q = (listView.q || '').trim().toLowerCase();
  const section = listView.section;
  return rows.filter((r) => {
    if (section && section !== 'all' && r.section !== section) return false;
    if (!q) return true;
    return `${r.title || ''} ${r.summary || ''} ${r.section || ''}`.toLowerCase().includes(q);
  });
}

// Only an http(s) value is ever made into an anchor. These URLs come off a scraped page, so the
// same rule the Deep Dive panel follows applies: external content may not decide what a click does.
// A story that fails it still renders — with its headline and its standfirst — as a plain block
// saying the link could not be used, because dropping the row would report a bad URL as no story.
const linkable = (u) => /^https?:\/\//i.test(String(u || ''));

function cardHtml(r) {
  const canLink = linkable(r.url);
  const when = istTime(r.publishedAt);
  const section = r.section ? r.section.replace(/-/g, ' ') : null;
  // A story with no publisher time says so rather than showing the moment we captured it.
  const meta = [
    when
      ? `<span class="tabular-nums">${escapeHtml(when)}</span>`
      : `<span class="text-slate-300" title="Moneycontrol’s listing page carries no time, and this story’s own page was not read for one. It is not the time we saw it.">time not published</span>`,
    section ? `<span>${escapeHtml(section)}</span>` : '',
    r.premium ? '<span class="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">premium</span>' : '',
  ]
    .filter(Boolean)
    .join('<span class="text-slate-300">·</span>');

  // `onerror` rather than a broken-image icon: the thumbnails are on the publisher's CDN, and a
  // reader offline (or a verification run with no egress) should get a clean placeholder.
  const thumb = r.image
    ? `<img src="${escapeHtml(r.image)}" alt="" loading="lazy" decoding="async"
           class="h-full w-full object-cover" onerror="this.style.display='none'">`
    : '';

  const body = `
      <div class="h-[62px] w-[110px] flex-shrink-0 overflow-hidden rounded-lg bg-gradient-to-br from-slate-100 to-slate-200 sm:h-[76px] sm:w-[135px]">${thumb}</div>
      <div class="min-w-0 max-w-4xl flex-1">
        <h3 class="font-display text-[15px] font-bold leading-snug text-slate-900 ${canLink ? 'group-hover:text-indigo-700' : ''}">${escapeHtml(r.title || '(untitled)')}</h3>
        ${r.summary ? `<p class="mt-1 line-clamp-2 text-sm leading-relaxed text-slate-500">${escapeHtml(r.summary)}</p>` : ''}
        <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">${meta}</div>
      </div>`;
  const key = escapeHtml(String(r.id || r.url));
  const shell = 'group flex gap-4 px-5 py-4 transition-colors';

  if (!canLink) {
    return `<div data-news-key="${key}" data-news-unlinkable class="${shell}">${body}
      <span class="self-start rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500" title="The capture carried no usable http(s) address for this story.">no link</span>
    </div>`;
  }
  return `
    <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer" data-news-key="${key}"
       class="${shell} hover:bg-slate-50 focus:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500">${body}
    </a>`;
}

function listHtml(rows) {
  const shown = rows.slice(0, FIRST_PAINT);
  const pending = Math.max(0, rows.length - shown.length);
  // The section list is the WHOLE feed's, not the filtered set's — a dropdown that loses its own
  // options as you use it cannot be used to get back.
  const allSections = [...new Set(marketNews.rows().map((r) => r.section).filter(Boolean))].sort();
  return `
    <section data-mcnews-list class="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100"${pending ? ` data-rows-pending="${pending}"` : ''}>
      <div class="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <div class="relative w-full min-w-[180px] flex-1 sm:w-auto sm:max-w-md">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">🔍</span>
            <input type="text" data-news-search placeholder="Search headlines..." value="${escapeHtml(listView.q || '')}"
              class="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          ${
            allSections.length > 1
              ? `<select data-news-section aria-label="Section"
                   class="max-w-full truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                   <option value="all">All sections</option>
                   ${allSections.map((sx) => `<option value="${escapeHtml(sx)}"${listView.section === sx ? ' selected' : ''}>${escapeHtml(sx.replace(/-/g, ' '))}</option>`).join('')}
                 </select>`
              : ''
          }
        </div>
        <div class="flex items-center gap-3">
          <span class="whitespace-nowrap text-sm text-slate-500"><strong class="text-slate-800">${escapeHtml(formatNumber(rows.length))}</strong> of ${escapeHtml(formatNumber(marketNews.rows().length))} stories</span>
          <button type="button" data-news-export
            class="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700">
            <span>📊</span><span>Export Excel</span>
          </button>
        </div>
      </div>
      <div data-news-scroll class="scrollbar-thin divide-y divide-slate-100 overflow-y-auto" style="max-height: max(360px, calc(100vh - 330px))">
        ${shown.map(cardHtml).join('') || '<p class="px-5 py-10 text-center text-sm text-slate-400">No story matches your search.</p>'}
      </div>
    </section>`;
}

/**
 * Append the remainder in idle slices.
 *
 * Not virtualisation: every story ends up in the DOM, so Ctrl-F, screenshots and the accessibility
 * tree behave normally. The timeout matters — a backgrounded tab never goes idle, and without it
 * the list would sit at 24 stories until the reader came back.
 */
function fillRest(root, rows, wantScroll) {
  const host = root.querySelector('[data-news-scroll]');
  const section = root.querySelector('[data-mcnews-list]');
  if (!host || !section) return () => {};

  // Restoring a scroll offset is only possible once the rows it points into exist, so the request
  // is carried through the fill and dropped the moment the reader scrolls for themselves. See
  // CLAUDE.md: if you rebuild a scrolling container, you own restoring its scroll position.
  let want = wantScroll || 0;
  let lastSet = 0;
  const settle = () => {
    if (!want || host.scrollTop >= want) return;
    host.scrollTop = want;
    lastSet = host.scrollTop;
  };
  const onScroll = () => {
    if (Math.abs(host.scrollTop - lastSet) > 2) want = 0;
  };
  host.addEventListener('scroll', onScroll, { passive: true });
  settle();

  let at = FIRST_PAINT;
  let handle = null;
  let cancelled = false;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 16));
  const cancelIdle = window.cancelIdleCallback || clearTimeout;
  const stop = () => {
    cancelled = true;
    if (handle) cancelIdle(handle);
    handle = null;
    host.removeEventListener('scroll', onScroll);
  };

  if (rows.length <= FIRST_PAINT) {
    section.removeAttribute('data-rows-pending');
    return stop;
  }

  const step = () => {
    if (cancelled) return;
    const slice = rows.slice(at, at + 40);
    if (!slice.length) {
      section.removeAttribute('data-rows-pending');
      settle();
      host.removeEventListener('scroll', onScroll);
      return;
    }
    host.insertAdjacentHTML('beforeend', slice.map(cardHtml).join(''));
    at += slice.length;
    settle();
    const left = rows.length - at;
    if (left > 0) {
      section.setAttribute('data-rows-pending', String(left));
      handle = idle(step, { timeout: 400 });
    } else {
      section.removeAttribute('data-rows-pending');
      host.removeEventListener('scroll', onScroll);
    }
  };
  handle = idle(step, { timeout: 400 });
  return stop;
}

async function exportVisible(visible, m) {
  await exportRows({
    filename: 'sattva-market-news',
    sheetName: 'Market news',
    columns: [
      {
        header: 'Published (IST)',
        key: 'd',
        width: 18,
        get: (r) =>
          r.__banner
            ? `REAL REPORTING, NOT OURS. Market-wide stocks news as published by Moneycontrol at /news/business/stocks/, ` +
              `captured ${m.capturedAt || 'unknown'}, exported ${new Date().toISOString()}. ` +
              `HEADLINES, STANDFIRSTS AND SECTIONS ARE THE PUBLISHER'S, reproduced unchanged — nothing here is summarised, scored, ranked or judged, and the order is their own. ` +
              `A BLANK TIME MEANS THE PUBLISHER'S TIME WAS NOT READ: their listing page carries no date, so it is fetched per story and is budgeted. It is never the time this dashboard saw the story. ` +
              `${m.withPublishedAt} of ${m.count} stories carry the publisher's time.`
            : istTime(r.publishedAt) || '',
      },
      { header: 'Headline', key: 'h', width: 80, get: (r) => (r.__banner ? '' : r.title || '') },
      { header: 'Section', key: 's', width: 20, get: (r) => (r.__banner ? '' : r.section || '') },
      { header: 'Standfirst (publisher)', key: 'p', width: 80, get: (r) => (r.__banner ? '' : r.summary || '') },
      { header: 'Premium', key: 'x', width: 10, get: (r) => (r.__banner ? '' : r.premium ? 'yes' : '') },
      { header: 'URL', key: 'u', width: 70, get: (r) => (r.__banner ? '' : r.url || '') },
      { header: 'First seen by this dashboard', key: 'f', width: 26, get: (r) => (r.__banner ? '' : r.firstSeenAt || '') },
    ],
    rows: [{ __banner: true }, ...visible],
  });
}

function provenance(m) {
  return `<div class="px-7 py-6">
    <div class="mb-3 flex items-start justify-between gap-4">
      <h2 class="font-display text-xl font-bold text-slate-900">Market news</h2>
      <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
    </div>
    <div class="text-sm leading-relaxed text-slate-600">
      <p><strong>Real reporting, and not ours.</strong> Every story Moneycontrol publish to
         <code class="rounded bg-slate-100 px-1">/news/business/stocks/</code>. Headlines, standfirsts and section names are
         theirs, reproduced unchanged; the article stays on their site and every row links to it. Nothing here summarises,
         scores, ranks or flags a story as important, and <strong>the order is their own</strong> — by their article id.</p>

      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Why this is a capture rather than a live read</h3>
      <p class="mt-1 text-xs">Moneycontrol's site refuses automated readers by TLS fingerprint, not by headers. Measured:
         <code class="rounded bg-slate-100 px-1">curl</code> with a browser user-agent gets <strong>200 and 598 KB</strong>;
         Node's <code class="rounded bg-slate-100 px-1">fetch</code> gets <strong>403 with a 24-byte body</strong> on every
         header set tried, including the full browser set; and a <strong>Cloudflare Worker gets 403 as well</strong>. So there
         is no proxy route to build — a scheduled GitHub Action reads the page every twenty minutes and commits what it finds,
         and this page reads that capture.</p>
      <p class="mt-2 text-xs">That is why two times are shown and never combined: when the publisher was last
         <em>read</em>, and when this browser last <em>confirmed</em> it holds the newest capture.</p>

      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">The two buttons do different things</h3>
      <p class="mt-1 text-xs"><strong>Check for new stories</strong> asks whether a newer capture has been published —
         one conditional request, usually a bodyless 304, and it costs nothing. It cannot reach Moneycontrol.</p>
      <p class="mt-2 text-xs"><strong>Fetch from Moneycontrol</strong> asks the GitHub runner to read the publisher
         <em>now</em>: it starts the same scheduled job on demand and then watches it. That is a real run and a real
         request to somebody else's site, so <strong>nothing on this page ever starts one on its own</strong> — no poll,
         no peek on load, only a click. If a run is already going it watches that one instead of starting a second.
         The credential that authorises it lives on the Worker and has never been in a browser.</p>
      <p class="mt-2 text-xs">A finished run is <strong>not</strong> the same as new stories on screen: the job commits
         only if it found something, and the site serves the new file only after the deploy that follows. So the note
         under the button distinguishes <em>read it, nothing new</em> from <em>captured, publishing now</em> from
         <em>published, not received here yet</em> — and a run still going says so rather than being reported as a
         failure.</p>

      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">The blank times are the honest part</h3>
      <p class="mt-1 text-xs">Moneycontrol's listing page carries no date on any story — checked, there is no date, time or
         timestamp element on it. The time comes from each story's own page, which costs one request per story, so it is
         budgeted and the newest are done first. <strong>${escapeHtml(formatNumber(m.withPublishedAt))} of
         ${escapeHtml(formatNumber(m.count))}</strong> stories carry the publisher's time; the rest read
         <em>time not published</em> in those words — on a card there is no column heading to tell a reader what
         a dash would have been standing in for.
         They are <strong>never</strong> stamped with the moment this dashboard first saw them — that is a fact about the
         scraper, is kept in its own field, and reaches the export under its own heading.</p>
    </div>
  </div>`;
}

function paint(ctx) {
  const m = marketNews.meta();
  const rows = marketNews.rows();
  if (fillStop) {
    fillStop();
    fillStop = null;
  }

  if (!rows.length) {
    ctx.root.innerHTML = `
      ${sectionHead({ title: 'News', description: DESCRIPTION, meta: pill(m), controls: controls(m) })}
      <div class="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100">
        <h3 class="font-display text-lg font-bold text-slate-900">No market-news capture yet</h3>
        <p class="mx-auto mt-2 max-w-xl text-sm text-slate-500">
          The scheduled run that reads Moneycontrol has not committed a capture to this deployment.
          ${escapeHtml(m.message || '')}
        </p>
      </div>`;
    wireHead(ctx);
    return;
  }

  // A capture landing must not throw the reader back to the top of the list.
  const keep = ctx.root.querySelector('[data-news-scroll]')?.scrollTop || 0;
  const filtered = visibleRows(rows);
  ctx.root.innerHTML = `
    ${sectionHead({ title: 'News', description: DESCRIPTION, meta: pill(m), controls: controls(m) })}
    ${listHtml(filtered)}`;
  wireHead(ctx);
  wireList(ctx.root);
  fillStop = fillRest(ctx.root, filtered, keep);
}

/**
 * Rebuild ONLY the list, for a change the reader made rather than one the feed made.
 *
 * A full `paint()` would work and would also re-render the search box the reader is typing into,
 * taking the focus and the caret with it. So the head and its freshness line stay put — nothing
 * about them depends on the filter — and the scroll returns to the top, which is right here: a new
 * filter is a new list, and holding the old offset would land the reader in the middle of it.
 */
function relist(root) {
  const old = root.querySelector('[data-mcnews-list]');
  if (!old) return;
  if (fillStop) {
    fillStop();
    fillStop = null;
  }
  const search = old.querySelector('[data-news-search]');
  const hadFocus = document.activeElement === search;
  const caret = search ? search.selectionStart : null;

  const filtered = visibleRows(marketNews.rows());
  old.outerHTML = listHtml(filtered);
  wireList(root);
  fillStop = fillRest(root, filtered, 0);

  const next = root.querySelector('[data-news-search]');
  if (next && hadFocus) {
    next.focus();
    if (caret != null) next.setSelectionRange(caret, caret);
  }
}

/** The section head: the provenance pill and the freshness/refresh row. */
function wireHead(ctx) {
  ctx.root.querySelector('[data-mcnews-info]')?.addEventListener('click', () => openModal(provenance(marketNews.meta()), { size: 'default' }));
  // The ONLY caller of startScrape in the codebase. Nothing on a render, nothing on a poll.
  ctx.root.querySelector('[data-mcnews-scrape]')?.addEventListener('click', () => startScrape(ctx));
  ctx.root.querySelector('[data-mcnews-refresh]')?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    lastResult = null;
    paint(ctx);
    try {
      const out = await marketNews.refresh();
      // SAY WHAT IT FOUND. A control that spins and vanishes leaves the reader unsure anything was
      // checked — and "no newer capture" is a real, useful answer, not a failure.
      lastResult = out.added
        ? { added: out.added, text: `${out.added} new ${out.added === 1 ? 'story' : 'stories'}` }
        : { added: 0, text: 'No newer capture' };
    } catch {
      lastResult = { added: 0, text: 'Could not check' };
    } finally {
      busy = false;
      paint(ctx);
    }
  });
}

/**
 * "Fetch from Moneycontrol" — the one control on this page that starts work somewhere else.
 *
 * WHAT IT ACTUALLY DOES, AND WHY IT CANNOT DO THE OBVIOUS THING. Neither this browser nor the
 * Worker can read moneycontrol.com — 403 by TLS fingerprint, measured both ways — so "fetch" here
 * means "ask the GitHub runner that CAN read it to run now", then watch. The button says so in
 * those words, and the note beneath it reports GitHub's own status rather than a progress model
 * invented here.
 *
 * A COMPLETED RUN IS NOT NEW STORIES ON SCREEN, and the outcomes keep those apart: the scrape
 * commits only if it found something, and `public/` reaches readers only after the deploy then
 * runs. So "landed", "nothing new", "published but not here yet" and "still going" are four
 * different statements and the note makes exactly one of them.
 */
async function startScrape(ctx) {
  if (scrape || busy) return;
  scrape = { phase: 'dispatched', text: 'Asking the scraper to read Moneycontrol…' };
  lastResult = null;
  paint(ctx);

  const out = await marketNews.startScrape();
  if (out.ok === false) {
    scrape = { phase: 'failed', text: dispatchFailureText(out), fix: out.fix || null };
    paint(ctx);
    return;
  }

  scrape = {
    phase: 'running',
    text:
      out.reason === 'already-running'
        ? 'A scrape was already running, so this did not start a second one. Watching it.'
        : out.reason === 'cooling-down'
          ? 'A scrape was started moments ago. Watching that one rather than starting another.'
          : 'The scraper is reading Moneycontrol. A run takes a couple of minutes, and this page will pick the capture up when it is published.',
    runUrl: out.run?.url || null,
  };
  paint(ctx);

  const result = await marketNews.watchScrape({
    onStep: (step) => {
      if (!ctxRef) return;
      if (step.phase === 'publishing') {
        scrape = { phase: 'publishing', text: 'Moneycontrol was read and new stories were captured. Publishing them to this site now.', runUrl: step.publish?.url || scrape?.runUrl || null };
      } else if (step.phase === 'scraping' && step.scrape?.status) {
        // Their word, not ours.
        scrape = { phase: 'running', text: `The scrape run is ${step.scrape.status.replace(/_/g, ' ')}. This page will pick the capture up when it is published.`, runUrl: step.scrape.url || scrape?.runUrl || null };
      }
      if (ctxRef) paint(ctxRef);
    },
  });

  if (!ctxRef) return;
  scrape = null;
  lastResult = outcomeResult(result);
  paint(ctxRef);
}

/** One sentence per named outcome. Each says what was OBSERVED — none of them guesses. */
function outcomeResult(r) {
  switch (r.outcome) {
    case 'landed':
      return { tone: 'text-emerald-700', text: `${r.added} new ${r.added === 1 ? 'story' : 'stories'}` };
    case 'nothing-new':
      // Only sayable because a run was watched to completion and no deploy followed it. The
      // 20-minute poll can never say this — see the on-demand rule: it has no index to ask.
      return { tone: 'text-slate-500', text: 'Moneycontrol was read just now — nothing new to publish' };
    case 'published':
      return { tone: 'text-slate-500', text: 'New stories were published; this browser has not received them yet' };
    case 'publish-failed':
      return { tone: 'text-rose-700', text: r.message };
    case 'failed':
      return { tone: 'text-rose-700', text: r.message || dispatchFailureText(r) };
    case 'timed-out':
      // NOT a failure claim. The run may still be perfectly healthy.
      return { tone: 'text-slate-500', text: 'Still running — this page will pick the capture up when it lands' };
    default:
      return { tone: 'text-slate-500', text: 'Checked' };
  }
}

/** A named failure has a named fix; "could not refresh" throws the useful half away. */
function dispatchFailureText(out) {
  switch (out.reason) {
    case 'no-worker':
      return 'This origin serves static files only, so there is no Worker to start a scrape. The scheduled run every 20 minutes is unaffected.';
    case 'no-token':
      return 'This deployment has no GitHub token, so it cannot start a scrape. An operator sets one with:';
    case 'no-repo':
      return 'No repository is configured on the Worker, so it cannot start a scrape. Set GH_REPO in wrangler.jsonc and redeploy.';
    case 'unauthorised':
      return 'GitHub rejected the token. It has expired or been revoked:';
    case 'forbidden':
      return 'The token is not allowed to start this workflow. It needs "Actions: read and write" on this repository.';
    case 'rate-limited':
      return "GitHub's hourly limit for this token is spent; it resets on the hour. The scheduled run every 20 minutes is unaffected.";
    case 'not-found':
      // The chatter-API lesson: a 404 with two readings must admit both, and name what was asked.
      return `GitHub answered 404 for ${out.requested || 'the workflow'}. That means EITHER the workflow file is not on the configured branch, OR the token cannot see this repository — GitHub answers 404 rather than 403 for a repository a token has no access to.`;
    case 'refused':
      return out.message || 'GitHub refused the request.';
    case 'timeout':
      return 'GitHub did not answer in time. Nothing was started, and the scheduled run every 20 minutes is unaffected.';
    default:
      return `The scrape could not be started (${out.reason || 'unknown'}). The scheduled run every 20 minutes is unaffected.`;
  }
}

/** Search, section and export. Rebound on every list rebuild, because the nodes are new. */
function wireList(root) {
  const search = root.querySelector('[data-news-search]');
  search?.addEventListener('input', () => {
    listView.q = search.value;
    relist(root);
  });

  const select = root.querySelector('[data-news-section]');
  select?.addEventListener('change', () => {
    listView.section = select.value;
    relist(root);
  });

  // Reads the ARRAY, never the DOM — a fill still in flight must not be able to truncate a workbook.
  root.querySelector('[data-news-export]')?.addEventListener('click', () => {
    exportVisible(visibleRows(marketNews.rows()), marketNews.meta());
  });
}

const DESCRIPTION =
  'Every stocks story Moneycontrol publish, market-wide — not filtered to the companies in scope. Headlines and standfirsts are theirs; the article stays where it is published.';

export function render(ctx) {
  ctxRef = ctx;
  disposers.forEach((d) => d && d());
  disposers = [];
  // Guard on `ctxRef`, which the lifecycle owns, rather than on anything captured at subscribe
  // time: render() runs again on every scope and sub-view change, and a token captured in the
  // closure would be stale from the first one onwards.
  if (!unsub) unsub = marketNews.onChange(() => ctxRef && paint(ctxRef));

  if (!marketNews.isLoaded()) {
    ctx.root.innerHTML = `${sectionHead({ title: 'News', description: DESCRIPTION })}
      <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
    marketNews.load().then(() => ctxRef && paint(ctxRef));
    return;
  }
  paint(ctx);
}

export function destroy() {
  ctxRef = null;
  fillStop?.();
  fillStop = null;
  disposers.forEach((d) => d && d());
  disposers = [];
  unsub?.();
  unsub = null;
  lastResult = null;
  // The watch checks `ctxRef` before every paint, so clearing it above is what stops it — this is
  // the honest record that nothing is being reported into a tab that is gone. The run itself
  // carries on: it is a GitHub Action, and leaving the tab does not cancel it.
  scrape = null;
  // The filters are the reader's, and leaving the tab discards them deliberately: coming back to a
  // list silently narrowed by a search typed ten minutes ago reads as a feed that lost stories.
  listView = { q: '', section: 'all' };
}

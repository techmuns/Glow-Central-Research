// concall/deep-dive.js — the Con-call Deep Dive.
//
// Six views over one company's latest call, in the full-screen workspace overlay
// (ui/screener.js openWorkspace). Opened from four places: the tab header, a Live Feed card,
// a Keyword Scan row and a catalyst row.
//
//   Summary     what the call said
//   Comparison  what changed since last quarter — the analytical centrepiece
//   Transcript  the whole thing, searchable, with keyword highlighting and a mini-map
//   Q&A         analyst questions grouped by firm, with dodge detection
//   Keywords    per-keyword breakdown for this call, prepared vs Q&A, every matched sentence
//   Catalysts   what to watch for, from this call and from the annual report
//
// Every keyword number in here comes from keyword-engine.scanCall() at render time. Edit the
// keyword set while the Deep Dive is open and it recomputes — see refresh() at the bottom.

import { openWorkspace, refreshWorkspace, closeWorkspace, selectWorkspaceTab } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatDate } from '../core/format.js';
import * as engine from './keyword-engine.js';
import * as concalls from '../data/concalls.js';

const TABS = ['summary', 'comparison', 'transcript', 'qna', 'keywords', 'catalysts'];

let openState = null; // { company, onTabChange, onClose, activeTab }

// ---------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------

/**
 * open(company, { tab, onTabChange, onClose })
 * `company` is a record from data/concalls.js — { ticker, name, latest, previous, … }.
 */
export function open(company, { tab = 'summary', onTabChange = null, onClose = null } = {}) {
  if (!company) return false;
  const activeTab = TABS.includes(tab) ? tab : 'summary';
  openState = { company, onTabChange, onClose, activeTab };

  const call = company.latest;
  const kws = engine.getKeywords();
  const scan = call?.transcript?.length ? engine.scanCall(call, kws) : null;

  openWorkspace({
    title: company.name,
    avatarName: company.name,
    subtitle: call
      ? `${company.ticker} · ${company.sector || '—'} · ${call.quarter} call${call.date ? ` on ${formatDate(call.date)}` : ''}${call.durationMin ? ` · ${call.durationMin} min` : ''}`
      : `${company.ticker} · ${company.sector || '—'}`,
    badges: [statusBadge(company.status), mockBadge()].filter(Boolean),
    tabs: TABS.map((id) => ({
      id,
      label: TAB_LABEL[id],
      badge: tabBadge(id, company, scan),
      render: () => RENDERERS[id](company),
      wire: (root) => WIRERS[id]?.(root, company),
    })),
    activeTab,
    onTabChange: (id) => {
      if (openState) openState.activeTab = id;
      onTabChange?.(id);
    },
    onClose: () => {
      openState = null;
      onClose?.();
    },
  });
  return true;
}

export function close() {
  closeWorkspace();
}

/** Re-render the open panel — called when the keyword set changes underneath it. */
export function refresh() {
  if (openState) refreshWorkspace();
}

export function openTicker(ticker, opts) {
  return open(concalls.byTicker(ticker), opts);
}

export function currentTicker() {
  return openState?.company?.ticker || null;
}

const TAB_LABEL = {
  summary: 'Summary',
  comparison: 'Comparison',
  transcript: 'Transcript',
  qna: 'Q&A',
  keywords: 'Keywords',
  catalysts: 'Catalysts',
};

function tabBadge(id, company, scan) {
  if (id === 'keywords') return scan ? scan.keywordsMatched : null;
  if (id === 'catalysts') return concalls.catalystsFor(company.ticker).length || null;
  if (id === 'qna') return company.latest?.transcript?.length ? qaPairs(company.latest).length : null;
  return null;
}

function statusBadge(status) {
  if (status === 'live') {
    return `<span class="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700 ring-1 ring-rose-200">
      <span class="relative flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-75"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-600"></span></span>
      In progress</span>`;
  }
  if (status === 'scheduled') {
    return '<span class="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600 ring-1 ring-slate-200">Scheduled</span>';
  }
  return null;
}

function mockBadge() {
  if (!concalls.meta()?.isMock) return null;
  return '<span class="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">Illustrative</span>';
}

// The provenance strip. Rendered at the top of every Deep Dive view that shows call content,
// keyed off the data's own flag so wiring the real feed removes it with no code change here.
function provenanceStrip() {
  if (!concalls.meta()?.isMock) return '';
  return `
    <div class="mb-4 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
      <div class="text-[11px] font-bold uppercase tracking-wider text-amber-700">Illustrative transcript</div>
      <div class="mt-1 text-[11px] leading-relaxed text-amber-800">
        Company name, ticker and sector are real. Every line of speech, guidance figure and tone reading below is synthetic,
        generated by <code class="rounded bg-amber-100 px-1">scripts/gen-mock-concalls.mjs</code>.
        <strong>Every person and brokerage named here is fictional</strong> — no real individual said any of this.
      </div>
    </div>`;
}

function notHeldYet(company) {
  return `
    ${provenanceStrip()}
    <div class="rounded-2xl bg-slate-50 p-10 text-center ring-1 ring-slate-200">
      <div class="text-3xl">🗓️</div>
      <div class="font-display mt-2 text-lg font-bold text-slate-800">This call has not been held yet</div>
      <div class="mx-auto mt-1 max-w-md text-sm text-slate-500">
        ${escapeHtml(company.name)}'s ${escapeHtml(company.latest?.quarter || '')} call is scheduled for
        <span class="font-semibold text-slate-700">${escapeHtml(company.latest?.date ? formatDate(company.latest.date) : 'a date to be confirmed')}</span>.
        There is no transcript to analyse, so nothing is scored here — a zero would read as "management said nothing about this",
        which is not the same as "nobody has spoken yet".
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// (a) SUMMARY
// ---------------------------------------------------------------------------------------

function renderSummary(company) {
  const call = company.latest;
  if (!call?.transcript?.length) return notHeldYet(company);

  const catalysts = concalls.catalystsFor(company.ticker);
  return `
    ${provenanceStrip()}
    <div class="mb-5 rounded-2xl bg-white p-5 ring-1 ring-slate-200">
      <div class="mb-1 text-[11px] font-bold uppercase tracking-wider text-indigo-700">Latest call analysed</div>
      <p class="text-sm leading-relaxed text-slate-700">${escapeHtml(call.summary || '')}</p>
      ${
        call.themes?.length
          ? `<div class="mt-3 flex flex-wrap gap-1.5">
               ${call.themes.map((t) => `<span class="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-100">${escapeHtml(t)}</span>`).join('')}
             </div>`
          : ''
      }
    </div>

    <div class="mb-5 grid gap-4 lg:grid-cols-[300px_1fr]">
      ${toneCard(call.tone)}
      ${participantsCard(call.participants)}
    </div>

    ${guidanceTable(call.guidance, 'Guidance given on this call')}

    ${
      catalysts.length
        ? `<div class="mb-5">
             <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Catalysts extracted (${catalysts.length})</div>
             <div class="grid gap-2 sm:grid-cols-2">${catalysts.slice(0, 6).map(catalystCard).join('')}</div>
           </div>`
        : ''
    }

    ${
      call.risks?.length
        ? `<div class="mb-5">
             <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Risks flagged</div>
             <ul class="space-y-1.5">
               ${call.risks.map((r) => `<li class="flex gap-2 rounded-xl bg-white p-3 text-sm text-slate-700 ring-1 ring-slate-200"><span class="text-rose-500">▲</span><span>${escapeHtml(r)}</span></li>`).join('')}
             </ul>
           </div>`
        : ''
    }

    ${
      call.quotes?.length
        ? `<div>
             <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Notable quotes</div>
             <div class="space-y-3">
               ${call.quotes
                 .map(
                   (q) => `
                 <blockquote class="rounded-2xl border-l-4 border-indigo-400 bg-gradient-to-r from-indigo-50/70 to-transparent p-4">
                   <p class="text-sm italic leading-relaxed text-slate-800">“${escapeHtml(q.text)}”</p>
                   <footer class="mt-2 text-xs text-slate-500">— ${escapeHtml(q.speaker)} · <span class="italic">${escapeHtml(q.why)}</span></footer>
                 </blockquote>`
                 )
                 .join('')}
             </div>
           </div>`
        : ''
    }`;
}

/** Management tone as a -1..1 arc with a needle. */
function toneCard(tone) {
  if (!tone) return '<div class="rounded-2xl bg-slate-50 p-5 text-sm text-slate-500 ring-1 ring-slate-200">No tone reading for this call.</div>';
  const score = Math.max(-1, Math.min(1, Number(tone.score) || 0));
  // Semicircle: -1 maps to 180°, +1 to 0°.
  const angle = Math.PI * (1 - (score + 1) / 2);
  const cx = 110;
  const cy = 96;
  const r = 74;
  const nx = cx + Math.cos(angle) * r;
  const ny = cy - Math.sin(angle) * r;
  const toneColor = score > 0.25 ? '#059669' : score < -0.2 ? '#e11d48' : '#d97706';

  return `
    <div class="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
      <div class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">Management tone</div>
      <svg viewBox="0 0 220 118" class="mx-auto w-full max-w-[220px]" role="img" aria-label="Tone ${escapeHtml(tone.label)}, ${score}">
        <defs>
          <linearGradient id="toneArc" x1="0" x2="1">
            <stop offset="0%" stop-color="#e11d48"/><stop offset="50%" stop-color="#d97706"/><stop offset="100%" stop-color="#059669"/>
          </linearGradient>
        </defs>
        <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="url(#toneArc)" stroke-width="13" stroke-linecap="round" opacity="0.85"/>
        <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="#0f172a" stroke-width="3" stroke-linecap="round"/>
        <circle cx="${cx}" cy="${cy}" r="6" fill="#0f172a"/>
        <text x="${cx - r}" y="${cy + 16}" text-anchor="middle" font-size="9" fill="#94a3b8">−1</text>
        <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="9" fill="#94a3b8">0</text>
        <text x="${cx + r}" y="${cy + 16}" text-anchor="middle" font-size="9" fill="#94a3b8">+1</text>
      </svg>
      <div class="text-center">
        <div class="text-2xl font-bold tabular-nums" style="color:${toneColor}">${score > 0 ? '+' : ''}${score.toFixed(2)}</div>
        <div class="text-sm font-semibold text-slate-700">${escapeHtml(tone.label)}</div>
      </div>
      ${
        tone.drivers?.length
          ? `<ul class="mt-3 space-y-1 border-t border-slate-100 pt-3">
               ${tone.drivers.map((d) => `<li class="flex gap-1.5 text-[11px] leading-snug text-slate-500"><span class="text-slate-300">·</span><span>${escapeHtml(d)}</span></li>`).join('')}
             </ul>`
          : ''
      }
    </div>`;
}

function participantsCard(participants) {
  const mgmt = participants?.management || [];
  const analysts = participants?.analysts || [];
  return `
    <div class="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
      <div class="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">On the call</div>
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <div class="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-indigo-700">Management</div>
          <ul class="space-y-1.5">
            ${mgmt.map((m) => `<li class="text-sm"><span class="font-semibold text-slate-800">${escapeHtml(m.name)}</span><span class="block text-[11px] text-slate-500">${escapeHtml(m.role)}</span></li>`).join('') || '<li class="text-xs text-slate-400">—</li>'}
          </ul>
        </div>
        <div>
          <div class="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-purple-700">Analysts (${analysts.length})</div>
          <ul class="scrollbar-thin max-h-40 space-y-1.5 overflow-y-auto pr-1">
            ${analysts.map((a) => `<li class="text-sm"><span class="font-semibold text-slate-800">${escapeHtml(a.name)}</span><span class="block text-[11px] text-slate-500">${escapeHtml(a.firm)}</span></li>`).join('') || '<li class="text-xs text-slate-400">—</li>'}
          </ul>
        </div>
      </div>
    </div>`;
}

const DIRECTION_PILL = {
  raised: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  maintained: 'bg-slate-100 text-slate-600 ring-slate-200',
  cut: 'bg-rose-50 text-rose-700 ring-rose-200',
};

/** `title: null` renders the bare table, for callers supplying their own heading. */
function guidanceTable(guidance, title) {
  if (!guidance?.length) return '';
  return `
    <div class="${title ? 'mb-5' : ''}">
      ${title ? `<div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">${escapeHtml(title)}</div>` : ''}
      <div class="overflow-x-auto rounded-2xl bg-white ring-1 ring-slate-200">
        <table class="w-full min-w-[640px] text-sm">
          <thead class="border-b border-slate-100 bg-slate-50/70">
            <tr class="text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
              <th scope="col" class="px-4 py-2.5">Metric</th><th scope="col" class="px-4 py-2.5">Guided</th>
              <th scope="col" class="px-4 py-2.5">Prior</th><th scope="col" class="px-4 py-2.5">Direction</th>
              <th scope="col" class="px-4 py-2.5">Supporting quote</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-50">
            ${guidance
              .map(
                (g) => `
              <tr>
                <td class="px-4 py-2.5 font-semibold text-slate-800">${escapeHtml(g.metric)}</td>
                <td class="px-4 py-2.5 font-bold tabular-nums text-slate-900">${escapeHtml(g.guided)}</td>
                <td class="px-4 py-2.5 tabular-nums text-slate-500">${escapeHtml(g.priorGuided || '—')}</td>
                <td class="px-4 py-2.5"><span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${DIRECTION_PILL[g.direction] || DIRECTION_PILL.maintained}">${escapeHtml(g.direction)}</span></td>
                <td class="px-4 py-2.5 text-xs italic text-slate-500">“${escapeHtml(g.quote)}”</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

const CATALYST_STATUS_PILL = {
  upcoming: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  'in-progress': 'bg-amber-50 text-amber-700 ring-amber-200',
  delivered: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
};

function catalystCard(c) {
  return `
    <div class="rounded-xl bg-white p-3 ring-1 ring-slate-200">
      <div class="flex items-start justify-between gap-2">
        <div class="text-sm font-semibold text-slate-800">${escapeHtml(c.catalyst)}</div>
        <span class="flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${CATALYST_STATUS_PILL[c.status] || CATALYST_STATUS_PILL.upcoming}">${escapeHtml(c.status)}</span>
      </div>
      <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
        <span class="rounded bg-slate-100 px-1.5 py-0.5 font-medium">${escapeHtml(c.type)}</span>
        <span>${c.source?.kind === 'annual-report' ? 'Annual Report FY26' : `Con-call ${escapeHtml(String(c.source?.ref || '').split('-').pop() || '')}`}</span>
        <span>·</span>
        <span>expected by ${escapeHtml(formatDate(c.expectedBy))}</span>
      </div>
      ${c.quote ? `<div class="mt-2 border-l-2 border-slate-200 pl-2 text-[11px] italic text-slate-500">“${escapeHtml(c.quote)}”</div>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------------------
// (b) COMPARISON
// ---------------------------------------------------------------------------------------

function renderComparison(company) {
  const call = company.latest;
  if (!call?.transcript?.length) return notHeldYet(company);

  const prev = company.previous;
  if (!prev?.transcript?.length) {
    // One call and nothing to diff against. Rendering an empty chart of zero-deltas would
    // imply "nothing changed", which is a claim this data cannot support.
    return `
      ${provenanceStrip()}
      <div class="rounded-2xl bg-slate-50 p-10 text-center ring-1 ring-slate-200">
        <div class="text-3xl">📄</div>
        <div class="font-display mt-2 text-lg font-bold text-slate-800">Only one call on record</div>
        <div class="mx-auto mt-1 max-w-md text-sm text-slate-500">
          ${escapeHtml(company.name)} has just the ${escapeHtml(call.quarter)} call in this data set, so there is nothing to compare it against.
          Every number on this view is a difference between two calls — with one call, a zero delta would mean
          "no change" when it actually means "no comparison".
        </div>
        <button data-dd-goto="summary" class="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700">Go to the Summary</button>
      </div>`;
  }

  const kws = engine.getKeywords();
  const now = engine.scanCall(call, kws);
  const before = engine.scanCall(prev, kws);
  const cmp = engine.compareScans(now, before);

  return `
    ${provenanceStrip()}
    <div class="mb-5 flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4 ring-1 ring-slate-200">
      <span class="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">${escapeHtml(prev.quarter)}</span>
      <span class="text-slate-300">→</span>
      <span class="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-bold text-white">${escapeHtml(call.quarter)}</span>
      <span class="text-xs text-slate-500">${escapeHtml(formatDate(prev.date))} → ${escapeHtml(formatDate(call.date))}</span>
      <span class="ml-auto text-xs text-slate-500">Total keyword mentions
        <strong class="tabular-nums text-slate-800">${before.totalHits} → ${now.totalHits}</strong>
        ${deltaChip(cmp.totalDelta)}
      </span>
    </div>

    ${verdictCard(company, now, before, cmp)}
    ${divergingBars(cmp, kws)}
    ${toneShift(prev.tone, call.tone)}
    ${guidanceChangeTable(call.guidance)}
    ${topicShift(cmp, kws)}
    ${promiseTracking(call.promises, prev.quarter)}`;
}

function deltaChip(delta) {
  if (delta == null) return '<span class="ml-1 text-[11px] text-slate-400">n/a</span>';
  if (delta === 0) return '<span class="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-500">0</span>';
  const up = delta > 0;
  return `<span class="ml-1 rounded px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${up ? 'bg-indigo-50 text-indigo-700' : 'bg-slate-100 text-slate-600'}">${up ? '+' : ''}${delta}</span>`;
}

/** A one-line read on the shift, built from the same numbers shown above it. */
function verdictCard(company, now, before, cmp) {
  const toneNow = company.latest?.tone?.score ?? null;
  const tonePrev = company.previous?.tone?.score ?? null;
  const toneDelta = toneNow != null && tonePrev != null ? toneNow - tonePrev : null;
  const raised = (company.latest?.guidance || []).filter((g) => g.direction === 'raised').length;
  const cut = (company.latest?.guidance || []).filter((g) => g.direction === 'cut').length;
  const kept = (company.latest?.promises || []).filter((p) => p.status === 'delivered').length;
  const missed = (company.latest?.promises || []).filter((p) => p.status === 'missed').length;

  const parts = [];
  if (toneDelta != null) {
    parts.push(
      Math.abs(toneDelta) < 0.1
        ? 'Tone is essentially unchanged'
        : `Tone ${toneDelta > 0 ? 'improved' : 'softened'} by ${Math.abs(toneDelta).toFixed(2)}`
    );
  }
  if (raised || cut) parts.push(`${raised} metric${raised === 1 ? '' : 's'} raised and ${cut} cut`);
  else parts.push('guidance left unchanged');
  if (cmp.introduced.length) parts.push(`${cmp.introduced.length} new topic${cmp.introduced.length === 1 ? '' : 's'} introduced`);
  if (cmp.dropped.length) parts.push(`${cmp.dropped.length} dropped`);
  if (kept || missed) parts.push(`${kept} of last quarter's commitments delivered${missed ? `, ${missed} missed` : ''}`);

  const positive = (toneDelta ?? 0) > 0.1 || raised > cut;
  // Each clause becomes its own sentence, so each one starts with a capital.
  const verdict = `${parts.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('. ')}.`;
  return `
    <div class="mb-5 rounded-2xl bg-gradient-to-r ${positive ? 'from-indigo-50 to-purple-50 ring-indigo-100' : 'from-slate-50 to-slate-100/60 ring-slate-200'} p-4 ring-1">
      <div class="text-[11px] font-bold uppercase tracking-wider ${positive ? 'text-indigo-700' : 'text-slate-500'}">Verdict</div>
      <p class="mt-1 text-sm font-medium text-slate-800">${escapeHtml(verdict)}</p>
    </div>`;
}

/** Keyword mention deltas as a diverging bar chart. Inline SVG — no chart library. */
function divergingBars(cmp, keywords) {
  const rows = keywords
    .map((k) => ({ k, ...(cmp.byKeyword[k.id] || { now: 0, before: 0, delta: 0 }) }))
    .filter((r) => r.now || r.before)
    .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0));
  if (!rows.length) return '';

  const max = Math.max(1, ...rows.map((r) => Math.abs(r.delta ?? 0)));
  const rowH = 26;
  const h = rows.length * rowH + 26;
  const labelW = 148;
  const chartW = 420;
  const mid = labelW + chartW / 2;
  const scale = (v) => (v / max) * (chartW / 2 - 8);

  return `
    <div class="mb-5 rounded-2xl bg-white p-5 ring-1 ring-slate-200">
      <div class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">Keyword mentions — change vs previous call</div>
      <div class="mb-3 text-[11px] text-slate-400">Bars right of the axis mean management (or analysts) spent more time on it this quarter.</div>
      <div class="overflow-x-auto">
        <svg viewBox="0 0 ${labelW + chartW + 56} ${h}" class="w-full min-w-[620px]" role="img" aria-label="Keyword mention deltas">
          <line x1="${mid}" y1="14" x2="${mid}" y2="${h - 10}" stroke="#cbd5e1" stroke-width="1"/>
          ${rows
            .map((r, i) => {
              const y = 18 + i * rowH;
              const d = r.delta ?? 0;
              const w = Math.abs(scale(d));
              const x = d >= 0 ? mid : mid - w;
              const hex = engine.colorFor(r.k.color).hex;
              // The value sits outside the bar normally, but moves INSIDE once the bar is long
              // enough that an outside label would run into the keyword name beside it.
              const inside = w > 34;
              const vx = d >= 0 ? (inside ? mid + w - 6 : mid + w + 6) : inside ? mid - w + 6 : mid - w - 6;
              const anchor = d >= 0 ? (inside ? 'end' : 'start') : inside ? 'start' : 'end';
              return `
                <text x="${labelW - 8}" y="${y + 12}" text-anchor="end" font-size="11" fill="#475569">${escapeHtml(r.k.label)}</text>
                <rect x="${x}" y="${y + 3}" width="${Math.max(w, d === 0 ? 0 : 1.5)}" height="13" rx="3" fill="${hex}" opacity="${d === 0 ? 0.25 : 0.85}"/>
                <text x="${vx}" y="${y + 13}" text-anchor="${anchor}" font-size="10" font-weight="700" fill="${d === 0 ? '#94a3b8' : inside ? '#ffffff' : '#334155'}">${d > 0 ? '+' : ''}${d}</text>
                <text x="${labelW + chartW + 24}" y="${y + 13}" text-anchor="end" font-size="10" fill="#94a3b8">${r.before}→${r.now}</text>`;
            })
            .join('')}
        </svg>
      </div>
    </div>`;
}

function toneShift(prevTone, nowTone) {
  if (!prevTone || !nowTone) return '';
  const a = Math.max(-1, Math.min(1, prevTone.score));
  const b = Math.max(-1, Math.min(1, nowTone.score));
  const delta = b - a;
  const pos = (v) => ((v + 1) / 2) * 100;

  return `
    <div class="mb-5 rounded-2xl bg-white p-5 ring-1 ring-slate-200">
      <div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div class="text-xs font-bold uppercase tracking-wider text-slate-500">Tone shift</div>
        <div class="text-sm">
          <span class="text-slate-500">${escapeHtml(prevTone.label)} ${a.toFixed(2)}</span>
          <span class="mx-1.5 text-slate-300">→</span>
          <span class="font-bold text-slate-800">${escapeHtml(nowTone.label)} ${b.toFixed(2)}</span>
          <span class="ml-2 rounded px-1.5 py-0.5 text-xs font-bold tabular-nums ${delta > 0.05 ? 'bg-emerald-50 text-emerald-700' : delta < -0.05 ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-600'}">${delta > 0 ? '+' : ''}${delta.toFixed(2)}</span>
        </div>
      </div>
      <!-- The scale ends sit OUTSIDE the track rather than under it: a marker near either
           extreme used to land on top of them. -->
      <div class="mb-8 mt-8 flex items-center gap-2">
        <span class="flex-shrink-0 text-[10px] text-slate-400">−1 cautious</span>
        <div class="relative h-2 flex-1 rounded-full" style="background:linear-gradient(to right,#fecdd3,#fde68a,#a7f3d0)">
          <div class="absolute -top-7 -translate-x-1/2 text-center" style="left:${pos(a)}%">
            <div class="whitespace-nowrap rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">${escapeHtml(prevTone.label.slice(0, 9))}</div>
            <div class="mx-auto h-3 w-px bg-slate-400"></div>
          </div>
          <div class="absolute -bottom-7 -translate-x-1/2 text-center" style="left:${pos(b)}%">
            <div class="mx-auto h-3 w-px bg-slate-900"></div>
            <div class="whitespace-nowrap rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-bold text-white">${escapeHtml(nowTone.label.slice(0, 9))}</div>
          </div>
        </div>
        <span class="flex-shrink-0 text-[10px] text-slate-400">confident +1</span>
      </div>
      ${
        nowTone.drivers?.length
          ? `<div class="mt-2 border-t border-slate-100 pt-3">
               <div class="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">What moved it</div>
               <ul class="space-y-1">${nowTone.drivers.map((d) => `<li class="text-[11px] text-slate-500">· ${escapeHtml(d)}</li>`).join('')}</ul>
             </div>`
          : ''
      }
    </div>`;
}

function guidanceChangeTable(guidance) {
  if (!guidance?.length) return '';
  const order = { raised: 0, cut: 1, maintained: 2 };
  const sorted = [...guidance].sort((a, b) => (order[a.direction] ?? 3) - (order[b.direction] ?? 3));
  const counts = sorted.reduce((acc, g) => ({ ...acc, [g.direction]: (acc[g.direction] || 0) + 1 }), {});
  return `
    <div class="mb-5">
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <span class="text-xs font-bold uppercase tracking-wider text-slate-500">Guidance changes</span>
        <span class="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-emerald-200">${counts.raised || 0} raised</span>
        <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600 ring-1 ring-slate-200">${counts.maintained || 0} maintained</span>
        <span class="rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-700 ring-1 ring-rose-200">${counts.cut || 0} cut</span>
      </div>
      ${guidanceTable(sorted, null)}
    </div>`;
}

function topicShift(cmp, keywords) {
  const label = (id) => keywords.find((k) => k.id === id)?.label || id;
  const chip = (id, tone) => {
    const c = engine.colorFor(keywords.find((k) => k.id === id)?.color);
    return `<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${tone === 'new' ? c.chip : 'bg-slate-100 text-slate-500 ring-slate-200 line-through'}">
      <span class="h-1.5 w-1.5 rounded-full ${tone === 'new' ? c.dot : 'bg-slate-400'}"></span>${escapeHtml(label(id))}</span>`;
  };
  return `
    <div class="mb-5 grid gap-4 sm:grid-cols-2">
      <div class="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
        <div class="mb-2 text-xs font-bold uppercase tracking-wider text-indigo-700">Newly introduced</div>
        <div class="flex flex-wrap gap-1.5">
          ${cmp.introduced.length ? cmp.introduced.map((id) => chip(id, 'new')).join('') : '<span class="text-xs text-slate-400">Nothing new — the same topics as last quarter.</span>'}
        </div>
        <div class="mt-2 text-[11px] text-slate-400">Mentioned on this call, absent from the previous one.</div>
      </div>
      <div class="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
        <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Dropped since last call</div>
        <div class="flex flex-wrap gap-1.5">
          ${cmp.dropped.length ? cmp.dropped.map((id) => chip(id, 'gone')).join('') : '<span class="text-xs text-slate-400">Nothing dropped.</span>'}
        </div>
        <div class="mt-2 text-[11px] text-slate-400">Discussed last quarter, not mentioned at all this time.</div>
      </div>
    </div>`;
}

const PROMISE_PILL = {
  delivered: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  'in-progress': 'bg-amber-50 text-amber-700 ring-amber-200',
  missed: 'bg-rose-50 text-rose-700 ring-rose-200',
};

function promiseTracking(promises, prevQuarter) {
  if (!promises?.length) return '';
  return `
    <div class="mb-2">
      <div class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">Promise tracking</div>
      <div class="mb-2 text-[11px] text-slate-400">What management committed to on the ${escapeHtml(prevQuarter || 'previous')} call, and what happened.</div>
      <div class="space-y-2">
        ${promises
          .map(
            (p) => `
          <div class="rounded-xl bg-white p-3 ring-1 ring-slate-200">
            <div class="flex items-start justify-between gap-3">
              <div class="text-sm font-semibold text-slate-800">${escapeHtml(p.text)}</div>
              <span class="flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${PROMISE_PILL[p.status] || PROMISE_PILL['in-progress']}">${escapeHtml(p.status)}</span>
            </div>
            <div class="mt-1 text-[11px] text-slate-500">Said in ${escapeHtml(p.madeInQuarter)} · ${escapeHtml(p.evidence)}</div>
          </div>`
          )
          .join('')}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// (c) TRANSCRIPT
// ---------------------------------------------------------------------------------------

function renderTranscript(company) {
  const call = company.latest;
  if (!call?.transcript?.length) return notHeldYet(company);
  const kws = engine.getKeywords();
  const scan = engine.scanCall(call, kws);
  const total = call.transcript.length;

  return `
    ${provenanceStrip()}
    <div class="sticky top-0 z-10 -mx-6 mb-4 border-b border-slate-100 bg-white/95 px-6 pb-3 pt-1 backdrop-blur">
      <div class="flex flex-wrap items-center gap-2">
        <input data-tr-search type="search" placeholder="Search this transcript…"
          class="min-w-[200px] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
        <span data-tr-count class="text-xs tabular-nums text-slate-500"></span>
        <button data-tr-prev class="rounded-lg px-2.5 py-2 text-xs font-semibold text-slate-600 ring-1 ring-slate-300 hover:bg-slate-50">↑ Prev</button>
        <button data-tr-next class="rounded-lg px-2.5 py-2 text-xs font-semibold text-slate-600 ring-1 ring-slate-300 hover:bg-slate-50">↓ Next</button>
      </div>
      ${keywordMinimap(scan, kws, total, call.transcript)}
    </div>

    <div data-tr-body class="space-y-2">
      ${sectionHeading('Prepared remarks')}
      ${call.transcript.map((s, i) => (s.section === 'prepared' ? segmentHtml(s, i, kws) : '')).join('')}
      ${sectionHeading('Question &amp; answer')}
      ${call.transcript.map((s, i) => (s.section === 'qna' ? segmentHtml(s, i, kws) : '')).join('')}
    </div>`;
}

function sectionHeading(label) {
  return `<div class="sticky top-0 z-[1] -mx-1 my-3 rounded-lg bg-slate-100 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-600">${label}</div>`;
}

function segmentHtml(seg, i, kws) {
  const isAnalyst = /analyst/i.test(seg.role || '');
  return `
    <div data-seg="${i}" class="rounded-xl border-l-2 ${isAnalyst ? 'border-purple-300 bg-purple-50/30' : 'border-indigo-300 bg-white'} p-3 ring-1 ring-slate-100">
      <div class="mb-1 flex flex-wrap items-baseline gap-x-2">
        <span class="text-xs font-bold ${isAnalyst ? 'text-purple-800' : 'text-indigo-800'}">${escapeHtml(seg.speaker)}</span>
        <span class="text-[11px] text-slate-400">${escapeHtml(seg.role)}</span>
        <span class="ml-auto font-mono text-[10px] text-slate-300">${mmss(seg.t)}</span>
      </div>
      <p data-seg-text class="text-sm leading-relaxed text-slate-700">${engine.highlight(seg.text, kws, escapeHtml)}</p>
    </div>`;
}

const mmss = (t) => {
  const s = Math.max(0, Number(t) || 0);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/** Where each keyword lands across the call — one lane per keyword, ticks at each hit. */
function keywordMinimap(scan, kws, total, segments = []) {
  const active = kws.filter((k) => scan.byKeyword[k.id]?.hits);
  if (!active.length || !total) return '';
  return `
    <div class="mt-2 space-y-0.5">
      ${active
        .map((k) => {
          const b = scan.byKeyword[k.id];
          const c = engine.colorFor(k.color);
          return `
          <div class="flex items-center gap-2">
            <span class="w-28 flex-shrink-0 truncate text-right text-[10px] text-slate-500" title="${escapeHtml(k.label)}">${escapeHtml(k.label)}</span>
            <div class="relative h-2.5 flex-1 rounded bg-slate-100">
              ${[...new Set(b.segments)]
                .map(
                  (i) => `<button data-jump-seg="${i}" class="absolute top-0 h-2.5 w-[3px] rounded-sm ${c.dot} opacity-80 hover:opacity-100" style="left:${((i / total) * 100).toFixed(2)}%" title="${escapeHtml(k.label)} at ${mmss(segments[i]?.t)}"></button>`
                )
                .join('')}
            </div>
            <span class="w-6 flex-shrink-0 text-[10px] font-bold tabular-nums text-slate-500">${b.hits}</span>
          </div>`;
        })
        .join('')}
    </div>`;
}

function wireTranscript(root) {
  const search = root.querySelector('[data-tr-search]');
  const countEl = root.querySelector('[data-tr-count]');
  const body = root.querySelector('[data-tr-body]');
  if (!search || !body) return;

  let matches = [];
  let cursor = -1;

  const scrollTo = (node) => {
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('ring-2', 'ring-indigo-400');
    setTimeout(() => node.classList.remove('ring-2', 'ring-indigo-400'), 1200);
  };

  // Jump straight to a mention from the mini-map.
  root.querySelectorAll('[data-jump-seg]').forEach((tick) =>
    tick.addEventListener('click', () => scrollTo(body.querySelector(`[data-seg="${tick.dataset.jumpSeg}"]`)))
  );

  const run = () => {
    const q = search.value.trim().toLowerCase();
    // Clear any previous search marks without disturbing the keyword highlighting, which is
    // rendered markup rather than a decoration we can re-apply cheaply.
    body.querySelectorAll('mark[data-find]').forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
    body.querySelectorAll('[data-seg]').forEach((s) => s.classList.remove('hidden'));
    matches = [];
    cursor = -1;

    if (!q) {
      countEl.textContent = '';
      return;
    }
    body.querySelectorAll('[data-seg]').forEach((seg) => {
      const text = seg.querySelector('[data-seg-text]')?.textContent || '';
      if (text.toLowerCase().includes(q)) matches.push(seg);
      else seg.classList.add('hidden');
    });
    countEl.textContent = matches.length ? `${matches.length} segment${matches.length === 1 ? '' : 's'}` : 'no matches';
    if (matches.length) {
      cursor = 0;
      scrollTo(matches[0]);
    }
  };

  let debounce = null;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(run, 160);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  });

  const step = (dir) => {
    if (!matches.length) return;
    cursor = (cursor + dir + matches.length) % matches.length;
    scrollTo(matches[cursor]);
    countEl.textContent = `${cursor + 1} of ${matches.length}`;
  };
  root.querySelector('[data-tr-next]')?.addEventListener('click', () => step(1));
  root.querySelector('[data-tr-prev]')?.addEventListener('click', () => step(-1));
}

// ---------------------------------------------------------------------------------------
// (d) Q&A
// ---------------------------------------------------------------------------------------

// Phrases that mean "I am not answering that". Used to flag a question as deferred rather
// than answered — the flag is a text match on the reply, and the reply is shown next to it so
// the reader can disagree with the call.
const DEFLECTIONS = [
  'would rather not', 'not give a specific', 'at this stage', 'take that offline',
  'come back to you', 'address that at the next call', 'more visibility', 'get back to you',
];

/** Pair each analyst question with the management reply that follows it. */
function qaPairs(call) {
  const segs = call?.transcript || [];
  const pairs = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.section !== 'qna' || !/analyst/i.test(s.role || '')) continue;
    // Skip pleasantries — a question needs a question mark or some substance.
    if (!s.text.includes('?') && s.text.length < 60) continue;
    const answers = [];
    for (let j = i + 1; j < segs.length && !/analyst/i.test(segs[j].role || ''); j++) answers.push(segs[j]);
    if (!answers.length) continue;
    const answerText = answers.map((a) => a.text).join(' ');
    pairs.push({
      firm: (s.role || '').replace(/^Analyst,\s*/i, '') || 'Unattributed',
      analyst: s.speaker,
      question: s.text,
      answers,
      answerText,
      index: i,
      deferred: DEFLECTIONS.some((d) => answerText.toLowerCase().includes(d)),
    });
  }
  return pairs;
}

/** Which tracked keywords a question/answer pair touches. */
function topicsFor(text, kws) {
  const scan = engine.scanCall({ callId: `topic:${hashString(text)}`, transcript: [{ t: 0, speaker: '', role: '', section: 'qna', text }] }, kws);
  return kws.filter((k) => scan.byKeyword[k.id]?.hits);
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function renderQna(company) {
  const call = company.latest;
  if (!call?.transcript?.length) return notHeldYet(company);
  const kws = engine.getKeywords();
  const pairs = qaPairs(call);
  if (!pairs.length) {
    return `${provenanceStrip()}<div class="rounded-2xl bg-slate-50 p-8 text-center text-sm text-slate-500 ring-1 ring-slate-200">No question-and-answer section was captured for this call.</div>`;
  }

  const byFirm = new Map();
  for (const p of pairs) {
    if (!byFirm.has(p.firm)) byFirm.set(p.firm, []);
    byFirm.get(p.firm).push(p);
  }
  const deferred = pairs.filter((p) => p.deferred).length;

  return `
    ${provenanceStrip()}
    <div class="mb-4 flex flex-wrap items-center gap-2 text-xs">
      <span class="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">${pairs.length} questions</span>
      <span class="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">${byFirm.size} firms</span>
      ${deferred ? `<span class="rounded-full bg-amber-50 px-2.5 py-1 font-semibold text-amber-700 ring-1 ring-amber-200">${deferred} deferred or dodged</span>` : ''}
    </div>

    <div class="space-y-5">
      ${[...byFirm.entries()]
        .map(
          ([firm, list]) => `
        <div>
          <div class="mb-2 flex items-center gap-2">
            <span class="text-sm font-bold text-slate-800">${escapeHtml(firm)}</span>
            <span class="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">${list.length}</span>
          </div>
          <div class="space-y-2">
            ${list
              .map((p) => {
                const topics = topicsFor(`${p.question} ${p.answerText}`, kws);
                return `
              <div class="rounded-xl bg-white p-3 ring-1 ring-slate-200">
                <div class="flex items-start gap-2">
                  <span class="mt-0.5 flex-shrink-0 rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-bold text-purple-700">Q</span>
                  <div class="min-w-0 flex-1">
                    <p class="text-sm font-medium text-slate-800">${engine.highlight(p.question, kws, escapeHtml)}</p>
                    <div class="mt-0.5 text-[11px] text-slate-400">${escapeHtml(p.analyst)}</div>
                  </div>
                  ${p.deferred ? '<span class="flex-shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-700 ring-1 ring-amber-200">Deferred</span>' : ''}
                </div>
                <div class="mt-2 flex items-start gap-2 border-t border-slate-100 pt-2">
                  <span class="mt-0.5 flex-shrink-0 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">A</span>
                  <p class="min-w-0 flex-1 text-sm leading-relaxed text-slate-600">${engine.highlight(p.answerText, kws, escapeHtml)}</p>
                </div>
                ${
                  topics.length
                    ? `<div class="mt-2 flex flex-wrap gap-1">
                         ${topics.map((k) => `<span class="rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${engine.colorFor(k.color).chip}">${escapeHtml(k.label)}</span>`).join('')}
                       </div>`
                    : ''
                }
              </div>`;
              })
              .join('')}
          </div>
        </div>`
        )
        .join('')}
    </div>`;
}

// ---------------------------------------------------------------------------------------
// (e) KEYWORDS
// ---------------------------------------------------------------------------------------

function renderKeywords(company) {
  const call = company.latest;
  if (!call?.transcript?.length) return notHeldYet(company);

  const kws = engine.getKeywords();
  const now = engine.scanCall(call, kws);
  const prevScan = company.previous?.transcript?.length ? engine.scanCall(company.previous, kws) : null;
  const cmp = engine.compareScans(now, prevScan);

  const rows = kws
    .map((k) => ({ k, b: now.byKeyword[k.id], d: cmp.byKeyword[k.id] }))
    .sort((a, b) => b.b.hits - a.b.hits);

  return `
    ${provenanceStrip()}
    <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div class="text-sm text-slate-500">
        <strong class="text-slate-800">${now.totalHits}</strong> mentions of
        <strong class="text-slate-800">${now.keywordsMatched}</strong> of your ${kws.length} tracked keywords in this call.
      </div>
      <button data-open-keyword-editor class="rounded-lg px-3 py-1.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200 transition-colors hover:bg-indigo-50">Edit keyword set</button>
    </div>

    <div class="space-y-3">
      ${rows
        .map(({ k, b, d }) => {
          const c = engine.colorFor(k.color);
          const preparedPct = b.hits ? (b.prepared / b.hits) * 100 : 0;
          return `
        <div class="rounded-2xl bg-white p-4 ring-1 ring-slate-200 ${b.hits ? '' : 'opacity-60'}">
          <div class="flex flex-wrap items-center gap-2">
            <span class="h-2.5 w-2.5 rounded-full ${c.dot}"></span>
            <span class="text-sm font-bold text-slate-800">${escapeHtml(k.label)}</span>
            ${k.category ? `<span class="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">${escapeHtml(k.category)}</span>` : ''}
            <span class="ml-auto text-lg font-bold tabular-nums text-slate-900">${b.hits}</span>
            ${deltaChip(d?.delta)}
          </div>

          <div class="mt-1 font-mono text-[10px] text-slate-400">matches: ${escapeHtml(k.terms.join(' · '))}</div>

          ${
            b.hits
              ? `<div class="mt-3">
                   <div class="mb-1 flex justify-between text-[11px] font-semibold">
                     <span class="text-indigo-700">Prepared remarks ${b.prepared}</span>
                     <span class="text-purple-700">${b.qna} Q&amp;A</span>
                   </div>
                   <div class="flex h-2 overflow-hidden rounded-full bg-purple-200">
                     <div class="bg-indigo-500" style="width:${preparedPct.toFixed(1)}%"></div>
                   </div>
                   <div class="mt-1 text-[11px] text-slate-400">
                     ${
                       b.prepared && b.qna
                         ? 'Volunteered by management and pushed on by analysts.'
                         : b.prepared
                           ? 'Management raised this themselves; no analyst asked about it.'
                           : 'Only came up because analysts asked — management did not raise it.'
                     }
                     ${b.firstMentionAt != null ? ` First mention at ${mmss(b.firstMentionAt)}.` : ''}
                   </div>

                   <details class="mt-2">
                     <summary class="cursor-pointer text-[11px] font-semibold text-indigo-600 hover:text-indigo-800">${b.contexts.length} matched sentence${b.contexts.length === 1 ? '' : 's'}</summary>
                     <div class="scrollbar-thin mt-2 max-h-64 space-y-1.5 overflow-y-auto pr-1">
                       ${b.contexts
                         .map(
                           (ctx) => `
                         <div class="rounded-lg bg-slate-50 p-2">
                           <div class="mb-0.5 flex items-center gap-1.5 text-[10px]">
                             <span class="font-semibold text-slate-600">${escapeHtml(ctx.speaker)}</span>
                             <span class="rounded px-1 ${ctx.section === 'qna' ? 'bg-purple-100 text-purple-700' : 'bg-indigo-100 text-indigo-700'}">${ctx.section === 'qna' ? 'Q&A' : 'prepared'}</span>
                             <span class="text-slate-400">matched “${escapeHtml(ctx.matchedTerm)}”</span>
                           </div>
                           <p class="text-[11px] leading-snug text-slate-600">${engine.highlight(ctx.sentence, [k], escapeHtml)}</p>
                         </div>`
                         )
                         .join('')}
                     </div>
                   </details>
                 </div>`
              : `<div class="mt-2 text-[11px] text-slate-400">Not mentioned on this call${d?.before ? ` — it came up ${d.before} time${d.before === 1 ? '' : 's'} last quarter.` : '.'}</div>`
          }
        </div>`;
        })
        .join('')}
    </div>`;
}

// ---------------------------------------------------------------------------------------
// (f) CATALYSTS
// ---------------------------------------------------------------------------------------

function renderCatalysts(company) {
  const rows = concalls.catalystsFor(company.ticker);
  if (!rows.length) {
    return `${provenanceStrip()}<div class="rounded-2xl bg-slate-50 p-8 text-center text-sm text-slate-500 ring-1 ring-slate-200">
      No catalysts have been extracted for ${escapeHtml(company.name)} yet.
    </div>`;
  }
  const fromCall = rows.filter((c) => c.source?.kind === 'concall');
  const fromAr = rows.filter((c) => c.source?.kind !== 'concall');
  const block = (title, list, note) =>
    list.length
      ? `<div class="mb-5">
           <div class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">${title} (${list.length})</div>
           <div class="mb-2 text-[11px] text-slate-400">${note}</div>
           <div class="grid gap-2 sm:grid-cols-2">${list.map(catalystCard).join('')}</div>
         </div>`
      : '';
  return `
    ${provenanceStrip()}
    ${block('From this call', fromCall, 'Raised by management on the con-call, with the supporting quote.')}
    ${block('From the annual report', fromAr, 'Disclosed in the FY26 annual report rather than on a call.')}`;
}

// ---------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------

const RENDERERS = {
  summary: renderSummary,
  comparison: renderComparison,
  transcript: renderTranscript,
  qna: renderQna,
  keywords: renderKeywords,
  catalysts: renderCatalysts,
};

const WIRERS = {
  transcript: wireTranscript,
  comparison: (root) => {
    root.querySelector('[data-dd-goto]')?.addEventListener('click', (e) => selectWorkspaceTab(e.currentTarget.dataset.ddGoto));
  },
  keywords: (root) => {
    root.querySelector('[data-open-keyword-editor]')?.addEventListener('click', async () => {
      const { openKeywordEditor } = await import('./keyword-editor.js');
      openKeywordEditor();
    });
  },
};

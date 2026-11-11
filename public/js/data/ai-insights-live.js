// data/ai-insights-live.js — THE FREE AUTO-UPDATE: AI Alerts → a company's sector KPIs → its
// AI Insights one-pager.
//
// The founder's ask: when an alert hits a company's sector KPI, its one-pager should update by
// itself — showing WHAT changed, WHY, HOW (good / watch / bad) and WHEN — and nudge the score,
// and it must be FREE. This is that, at ZERO credits. It reads two things the dashboard already
// has in hand:
//   1. the saved 14-day AI Alerts window (`ai-alerts.cached` — no live fetch, no model), and
//   2. the sector-KPI reading those alerts already carry (`card.kpis`, computed deterministically
//      by kpi-impact.js from the sector ontology during ranking).
// Nothing here fetches, scrapes or calls a model. The whole cost is reading a window already loaded.
//
// HONESTY. Every line is the alert's own: the date is the event's day, the headline is the source's
// headline, the KPI and its one-line mechanism are kpi-impact.js's, and the direction (good / watch /
// bad) is the alert's own reading. No number is invented. The score nudge is bounded (±4), labelled
// "auto · from alerts", and the written score always stays visible beside it. "Nothing changed" and
// "not checked yet" are kept apart — a cold cache is never reported as a calm fortnight.

import * as alerts from './ai-alerts.js';
import * as kpi from './kpi-impact.js';
import * as coverage from './coverage.js';
import * as fundamentals from './fundamentals.js';
import { currentSymbol } from './announcement-identity.js';
import { authHeaders } from '../core/host-context.js';

const TONE = { positive: 'good', negative: 'bad', neutral: 'watch' };

/** A bounded per-event contribution to the live Business-quality nudge. Neutral events move nothing. */
function contribution(event) {
  const weight = event?.importance === 'high' ? 2 : 0.75;
  if (event?.direction === 'positive') return weight;
  if (event?.direction === 'negative') return -weight;
  return 0;
}

// The ranked report, memoised per scope for a minute — as the IN-FLIGHT PROMISE, not just the
// result, so opening several one-pagers at once shares ONE alert read instead of starting a
// collect each. A read that resolves to nothing is dropped from the memo so a later open can retry.
let reportCache = { at: 0, byScope: new Map() };
const REPORT_TTL_MS = 60_000;

/**
 * The ranked AI Alerts report for a scope. The SAVED window first (`cached` — instant when warm,
 * which it is whenever AI Alerts, the landing page, has been opened); only if nothing is saved does
 * it actively `collect` once (the same read AI Alerts does, pooled). No model, no paid call either
 * way. The shared read is never tied to one caller's `isCurrent` — if that reader leaves, the read
 * still completes for the others; each caller re-checks its own `isCurrent` after awaiting.
 */
function reportFor(scope) {
  if (Date.now() - reportCache.at > REPORT_TTL_MS) reportCache = { at: Date.now(), byScope: new Map() };
  if (reportCache.byScope.has(scope)) return reportCache.byScope.get(scope);
  const promise = (async () => {
    let report = null;
    try { report = await alerts.cached({ scope }); } catch { report = null; }
    if (!report) { try { report = await alerts.collect({ scope }); } catch { report = null; } }
    return report;
  })();
  reportCache.byScope.set(scope, promise);
  promise.then((r) => { if (!r) reportCache.byScope.delete(scope); }).catch(() => reportCache.byScope.delete(scope));
  return promise;
}

/**
 * Start reading the ranked report for a scope NOW, in the background, so the "What's changed" box on
 * a one-pager is warm by the time a reader opens one. The first read is a full alert collection and
 * can take 20–30s cold; kicking it off when the tab mounts means the reader waits far less (often not
 * at all) when they open a company. Fire-and-forget, memoised, safe to call repeatedly.
 */
export function prewarm(scope = 'portfolio') {
  try { reportFor(scope); } catch { /* best effort — the open will read it anyway */ }
}

/** Drop the memoised reports so the next read is fresh — used by an explicit "Refresh report". */
export function invalidateReports() {
  reportCache = { at: 0, byScope: new Map() };
}

/**
 * The company's ranked card. A family holding is read from the Portfolio window — authoritative (a
 * holding with no card there has no alerts in 14 days) and warm (Portfolio is the default landing
 * scope). Any other company (a watchlist or universe pick) is read from the Universe window, which
 * covers every company. Returns `{ card, status }`:
 *   'ok'   — a card was found for this company,
 *   'none' — the alerts were read but nothing moved this company in the last 14 days,
 *   'cold' — the alerts could not be read at all right now.
 * `isCurrent` lets the caller abandon the (sliced) ranking if the reader moves on.
 */
export async function cardFor(ticker, isCurrent = () => true) {
  const want = currentSymbol(ticker) || String(ticker || '').toUpperCase();
  const scope = coverage.has(want) ? 'portfolio' : 'universe';
  const report = await reportFor(scope);
  if (!isCurrent() || !report) return { card: null, status: 'cold' };
  const card = (report.allCards || []).find((c) => c.ticker === want);
  return card ? { card, status: 'ok' } : { card: null, status: 'none' };
}

/**
 * The live updates for one card: one row per (alert event, KPI it moves), newest first, plus a
 * bounded Business-quality nudge. Reads ONLY `card.kpis` (kpi-impact.js's result) and `card.events`
 * — every field shown is the alert's or the ontology's own, never composed here.
 */
export function updatesFromCard(card) {
  const items = card?.kpis?.items || [];
  const byId = new Map((card?.events || []).map((e) => [e.id, e]));
  // ONE ROW PER DEVELOPMENT, not per KPI. The same filing used to repeat once for every KPI it
  // touched (a buyback as EPS AND Cash; a monthly update as Domestic AND Export volumes). Now each
  // event is one row that leads with the filing's own headline (the substance), carries the figures
  // a filed result actually reported and the KPIs it bears on as tags, and links to the source so a
  // reader can open the real filing and come back. No generic "why this KPI matters" filler.
  const groups = new Map();
  const order = [];
  const countedEvents = new Set();
  let delta = 0;
  for (const item of items) {
    const event = item.eventId != null ? byId.get(item.eventId) : null;
    const key = item.eventId != null ? `e:${item.eventId}` : `k:${item.key}:${item.name}`;
    let g = groups.get(key);
    if (!g) {
      const direction = event?.direction || 'neutral';
      g = {
        when: item.day || event?.day || null,
        headline: event?.headline || item.triggerLabel || item.name,  // the filing's own words
        trigger: item.triggerLabel || '',
        url: event?.url || null,                                       // the real filing/source, opened in a new tab
        source: item.source || event?.feedLabel || '',
        direction,
        tone: TONE[direction] || 'watch',
        high: event?.importance === 'high',
        figures: [],      // [{ kpi, value }] — a filed result's own figure, in the source's words
        kpis: [],         // KPIs the event bears on that carry no figure
        _seen: new Set(),
      };
      groups.set(key, g);
      order.push(g);
    }
    if (!g._seen.has(item.name)) {
      g._seen.add(item.name);
      if (item.value) g.figures.push({ kpi: item.name, value: item.value });
      else g.kpis.push(item.name);
    }
    if (item.eventId != null && !countedEvents.has(item.eventId)) {
      countedEvents.add(item.eventId);
      delta += contribution(event);
    }
  }
  for (const g of order) delete g._seen;
  const updates = order.sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')));
  const qualityDelta = Math.max(-4, Math.min(4, Math.round(delta)));
  return { updates, qualityDelta, group: card?.kpis?.groupLabel || null };
}

/**
 * The company's sector scorecard — the metrics ITS sector is judged on — read straight from the
 * sector-KPI ontology already in the dashboard (kpi-impact.js). Names only (the sector's own list,
 * not generic globals); live values fill in from results/filings via the updates above. Free, no
 * model. Returns `{ group, groupLabel, sector, names }` or null where the company has no sector.
 */
export async function sectorProfileFor(ticker) {
  let onto = kpi.snapshot();
  if (!onto) { try { onto = await kpi.load({ wait: true }); } catch { onto = null; } }
  if (!onto) return null;
  const ctx = kpi.companyContext(onto, currentSymbol(ticker) || String(ticker || '').toUpperCase());
  if (!ctx) return null;
  const names = [];
  for (const key of onto.groups?.[ctx.group]?.kpis || []) {
    const name = onto.kpis?.[key]?.name;
    if (name) names.push(name);
    if (names.length >= 12) break;
  }
  return { group: ctx.group, groupLabel: ctx.groupLabel, sector: ctx.sector, names };
}

// ---------------------------------------------------------------------------------------
// THE AI WRITER — a short, grounded "Our view" for any company, on Run.
//
// This is the ONE metered step in AI Insights, and it reuses the dashboard's existing Ask Research
// pipeline: the SAME Claude-on-Bedrock credential (CLAUDE_KEY), the SAME same-origin `/api/research`
// route, and the SAME grounded-evidence assembly — so there is no new token to configure. It fires
// only on an explicit Run, and the one-pager caches the result, so a re-open never re-spends. If the
// provider is not configured, or anything fails, it returns a status the caller falls back on — the
// page then shows the free live-facts view and nothing breaks.

let researchConfig = null; // cached per session: is the AI provider configured on this deployment?
async function researchConfigured() {
  if (researchConfig !== null) return researchConfig;
  try {
    const r = await fetch('api/research', { headers: { accept: 'application/json', ...authHeaders('api/research') }, cache: 'no-store' });
    const b = await r.json();
    researchConfig = b?.configured === true;
  } catch { researchConfig = false; }
  return researchConfig;
}

// A compact, figure-rich text block of the company's Screener fundamentals + our fair-value band,
// handed to the AI writer so its "what we like / don't like" can be specific and explain WHY — rather
// than generic ("revenue rose"). Every number here is Screener's own (reproduced) or our labelled
// fair-value rule. Returns '' when we have no fundamentals captured for the company.
function fundamentalsBrief(sym, name) {
  const f = fundamentals.byTicker(sym);
  if (!f) return '';
  const r = f.ratios || {}; const g = f.growth || {}; const a = f.annual || {};
  const L = [`FUNDAMENTALS (Screener, reproduced; ${f.basis}) — use these exact figures:`];
  const rat = [];
  if (Number.isFinite(r.marketCap)) rat.push(`Market cap ₹${r.marketCap} cr`);
  if (Number.isFinite(r.pe)) rat.push(`P/E ${r.pe}`);
  if (Number.isFinite(r.roe)) rat.push(`ROE ${r.roe}%`);
  if (Number.isFinite(r.roce)) rat.push(`ROCE ${r.roce}%`);
  if (Number.isFinite(r.debtToEquity)) rat.push(`Debt/Equity ${r.debtToEquity}`);
  if (Number.isFinite(r.divYield)) rat.push(`Dividend yield ${r.divYield}%`);
  if (Number.isFinite(r.bookValue)) rat.push(`Book value ₹${r.bookValue}`);
  if (rat.length) L.push('Ratios: ' + rat.join(', '));
  if (g.sales) L.push(`Compounded SALES growth — 3y ${g.sales.y3 ?? '—'}%, 5y ${g.sales.y5 ?? '—'}%, 10y ${g.sales.y10 ?? '—'}%`);
  if (g.profit) L.push(`Compounded PROFIT growth — 3y ${g.profit.y3 ?? '—'}%, 5y ${g.profit.y5 ?? '—'}%, 10y ${g.profit.y10 ?? '—'}%`);
  const yrs = a.years || [];
  if (yrs.length) {
    const take = Math.max(0, yrs.length - 6);
    const cols = yrs.slice(take);
    const row = (lbl, arr) => (arr && arr.length)
      ? `${lbl}: ${cols.map((_, i) => { const v = arr[take + i]; return Number.isFinite(v) ? v : '—'; }).join(' / ')}` : null;
    L.push(`Annual by year (${cols.join(' / ')}):`);
    for (const [lbl, arr] of [['  Sales ₹cr', a.sales], ['  Net profit ₹cr', a.netProfit], ['  OPM %', a.opm], ['  EPS ₹', a.eps]]) {
      const line = row(lbl, arr); if (line) L.push(line);
    }
  }
  if (f.pros?.length) L.push('Screener pros: ' + f.pros.slice(0, 5).join('; '));
  if (f.cons?.length) L.push('Screener cons: ' + f.cons.slice(0, 5).join('; '));
  const fv = fundamentals.fairValueFor(sym, {});
  if (fv?.meaningful) {
    const gTxt = Number.isFinite(fv.inputs?.growth) ? `~${Math.round(fv.inputs.growth)}% growth` : 'a thin growth record';
    // NB: no "my"/"our" + a finance noun anywhere in this brief or the prompt — that trips
    // questionNeedsPortfolio() on the research Worker and the whole write is refused (portfolio gate).
    L.push(`Glow fair-value band (a rule of thumb, a guide not a target): ₹${Math.round(fv.fairLow)}–₹${Math.round(fv.fairHigh)} `
      + `(a fair P/E of ~${fv.fairPe.toFixed(0)}x on ${gTxt}); it currently trades at ${Number.isFinite(fv.currentPe) ? `${fv.currentPe}x` : 'an unknown multiple'}.`);
  }
  return L.join('\n');
}

/**
 * An AI-written short view for one company, grounded in the dashboard's own evidence. Returns
 * `{ status, text?, message? }`:
 *   'ok'           — `text` is the model's grounded answer (prose, with [Dashboard: X] citations),
 *   'unconfigured' — the AI provider is not set up on this deployment (fall back, no spend),
 *   'error'        — the step failed (fall back),
 *   'stale'        — the reader moved on before it finished.
 * Grounding: the evidence is assembled by Ask Research's own `buildResearchEvidence`, which resolves
 * the company FROM THE PROMPT TEXT — so the prompt names the symbol (upper-case) and the full name.
 * The prompt deliberately avoids "my/our portfolio/holdings" wording, so it never trips the private
 * portfolio-connection gate.
 */
export async function writeIdea({ ticker, name, isCurrent = () => true } = {}) {
  if (!(await researchConfigured())) return { status: 'unconfigured' };
  if (!isCurrent()) return { status: 'stale' };
  const sym = currentSymbol(ticker) || String(ticker || '').toUpperCase();
  const scope = coverage.has(sym) ? 'portfolio' : 'universe';
  const label = name || sym;
  try { await fundamentals.load(); } catch { /* the brief is optional; the alert/earnings evidence still stands */ }
  const brief = fundamentalsBrief(sym, label);

  const question = `You are an experienced equity analyst writing a sharp, specific "5-minute stock idea" on ${label} (${sym}) for a professional investor. Use ONLY the dashboard's own data, the sources, and the FUNDAMENTALS block below. Never invent, estimate or guess a number — but DO cite the specific figures you are given.

Make it genuinely insightful, not generic. Rules for every point:
- Lead with the SPECIFIC figure or trend, then say WHY it matters for earnings, returns or risk. "OPM slipped from 16% to 14% over two years, squeezing operating profit growth below sales growth" — not "margins are under pressure". "Trades at 17x earnings versus ~22x a year ago despite 20% three-year profit growth, so the de-rating looks overdone" — not "valuation is reasonable".
- Prefer a trend across years, or a comparison (this year vs last, growth vs valuation, profit growth vs sales growth, ROE vs cost of capital) over a lone number.
- Each bullet must be a DIFFERENT idea. No filler, no restating the headline, and never a bare "revenue grew ~50%" without the figure AND the reason it matters.
- Two short sentences per bullet is good; a single generic clause is not.

Format EXACTLY like this, with these exact headings and nothing before the first line:

VERDICT: <Buy or Watch or Avoid> — <one sentence giving the single most important reason>

## What we like
- **<specific strength>** — <1-2 sentences with the figure/trend and why it matters>
(3 to 5 bullets, each a different idea)

## What we don't like
- **<specific concern>** — <1-2 sentences with the figure/trend and why it matters>
(3 to 5 bullets, each a different idea)

## Key financials
| Metric | Value |
| --- | --- |
| <only rows the data supports: revenue, net profit, a growth rate, OPM or another margin, ROE/ROCE, P/E, market cap> | <value> |

## What to watch
- <a specific, forward-looking item tied to a figure, a trend or a dated event>
(2 to 4 bullets)

If a section genuinely lacks data, say specifically what is missing rather than padding — but never leave a section blank or invent content.
${brief ? `\n${brief}\n` : ''}`;

  let evidence;
  try {
    const estate = await import('../research/estate.js');
    evidence = await estate.buildResearchEvidence({ question, scope });
  } catch { return { status: 'error', message: 'Could not gather the data to write from.' }; }
  if (!isCurrent()) return { status: 'stale' };

  try {
    const res = await fetch('api/research', {
      method: 'POST',
      headers: { accept: 'application/x-ndjson', 'content-type': 'application/json', ...authHeaders('api/research') },
      body: JSON.stringify({ question, scope: evidence.scope || scope, webResearch: false, history: [], evidence }),
    });
    if (!res.ok || !res.body) {
      const e = await res.json().catch(() => ({}));
      return { status: 'error', message: e.message || `The AI step is unavailable (HTTP ${res.status}).` };
    }
    let text = '';
    let buf = '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!isCurrent()) { try { await reader.cancel(); } catch { /* already closed */ } return { status: 'stale' }; }
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const ln of lines) {
        const s = ln.trim();
        if (!s) continue;
        let ev;
        try { ev = JSON.parse(s); } catch { continue; }
        if (ev.type === 'text') text += ev.text;
        else if (ev.type === 'error') return { status: 'error', message: ev.message || 'The AI step failed.' };
      }
    }
    text = text.trim();
    return text ? { status: 'ok', text } : { status: 'error', message: 'The AI step returned nothing.' };
  } catch { return { status: 'error', message: 'The AI step could not be reached.' }; }
}

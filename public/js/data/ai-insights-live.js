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
  const updates = [];
  const seen = new Set();
  const countedEvents = new Set();
  let delta = 0;
  for (const item of items) {
    const event = item.eventId != null ? byId.get(item.eventId) : null;
    const dedupe = `${item.eventId}|${item.key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const direction = event?.direction || 'neutral';
    updates.push({
      when: item.day || event?.day || null,
      kpi: item.name,
      value: item.value || null,             // a filed result's figure, in the source's words
      what: event?.headline || item.triggerLabel || item.name,
      trigger: item.triggerLabel || '',
      why: item.why || '',
      source: item.source || event?.feedLabel || '',
      direction,
      tone: TONE[direction] || 'watch',
      high: event?.importance === 'high',
    });
    if (item.eventId != null && !countedEvents.has(item.eventId)) {
      countedEvents.add(item.eventId);
      delta += contribution(event);
    }
  }
  updates.sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')));
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
  const question = `Write a concise 5-minute stock idea on ${label} (${sym}), using ONLY the dashboard's own data and sources. Never invent, estimate or guess a number — include a figure only where the data gives it.

Format your answer EXACTLY like this, with these exact headings and nothing before the first line:

VERDICT: <Buy or Watch or Avoid> — <one short sentence saying why>

## What we like
- **<short point>** — <one plain line>
- (3 to 5 bullets)

## What we don't like
- **<short point>** — <one plain line>
- (3 to 5 bullets)

## Key financials
| Metric | Value |
| --- | --- |
| <only rows the data supports: e.g. Revenue, Net profit, a growth rate, a margin or key ratio, Market cap> | <value> |

## What to watch
- <one plain line>
- (2 to 4 bullets)

Keep every line short and plain. If the data does not support a verdict or a section, still use the headings and say briefly what is missing — but never leave a section blank or invent content.`;

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

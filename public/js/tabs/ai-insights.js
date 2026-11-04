// tabs/ai-insights.js — AI Insights: a table of companies with Glow's verdict, opening a
// full "5-minute" one-pager (What We Like / What We Don't Like) per company on "More →".
//
// Sits in the "alerts" navigation group, so it appears as a pill beside AI Alerts and All
// Alerts. The table themes with the app; the one-pager paints its own light surface (it opens
// in the shared white modal) so it reads the same in light and dark, like a printed report.
//
// Real data today: the live price/day-move come from the technicals feed; the company list is
// the family's real book (coverage). The verdict, the points and the financials are written
// from Glow's sector rulebook + research (Screener, concalls, web/news) — authored per company
// as each sector is wired. HAL (Defence) is the first live one-pager.

import { TAB_META } from './catalog.js';
import { escapeHtml as esc } from '../core/dom.js';
import { openModal } from '../ui/screener.js';
import * as coverage from '../data/coverage.js';
import * as technicals from '../data/technicals.js';
import { RESEARCHED_SECTORS, getInsight } from '../data/ai-insights-data.js';

export const meta = TAB_META['ai-insights'];
let ctxRef = null;
let offTech = null;

/* ---------------- styles (scoped, injected once) ---------------- */
const STYLE_ID = 'gi-insights-style';
const CSS = `
.gi-tab{max-width:1180px;margin:0 auto;}
.gi-note{font-size:.84rem;line-height:1.55;color:rgb(var(--text-slate-600,71 85 105));
  background:rgb(var(--surface-indigo-50,238 242 255));border:1px solid rgb(var(--edge-indigo-100,224 231 255));
  border-radius:12px;padding:11px 14px;margin:0 0 14px;}
.gi-note b{color:rgb(var(--text-slate-800,30 41 59));}
.gi-card{background:rgb(var(--surface-white,255 255 255));border:1px solid rgb(var(--edge-slate-200,226 232 240));
  border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgb(15 23 42 / .05);}
.gi-table{width:100%;border-collapse:collapse;font-size:.9rem;}
.gi-table thead th{text-align:left;font-size:.64rem;letter-spacing:.06em;text-transform:uppercase;font-weight:800;
  color:rgb(var(--text-slate-500,100 116 139));padding:12px 14px;border-bottom:1px solid rgb(var(--edge-slate-200,226 232 240));}
.gi-table thead th.num{text-align:right;}
.gi-table tbody td{padding:13px 14px;border-bottom:1px solid rgb(var(--edge-slate-100,241 245 249));vertical-align:middle;}
.gi-table tbody tr:last-child td{border-bottom:0;}
.gi-table tbody tr:hover{background:rgb(var(--surface-slate-50,248 250 252));}
.gi-co{font-weight:700;color:rgb(var(--text-slate-900,15 23 42));}
.gi-co small{display:block;font-weight:500;color:rgb(var(--text-slate-500,100 116 139));font-size:.72rem;margin-top:2px;}
.gi-cmp{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;color:rgb(var(--text-slate-800,30 41 59));font-weight:600;}
.gi-cmp small{display:block;font-weight:600;font-size:.72rem;margin-top:2px;}
.gi-up{color:var(--positive);} .gi-dn{color:var(--negative);} .gi-flat{color:rgb(var(--text-slate-400,148 163 184));}
.gi-view .gi-pill{display:inline-block;font-weight:800;font-size:.66rem;letter-spacing:.04em;text-transform:uppercase;
  padding:3px 9px;border-radius:999px;margin-right:8px;vertical-align:middle;}
.gi-pill.watchlist{background:#fef3e2;color:#b45309;} .gi-pill.buy{background:#ecfdf5;color:#047857;}
.gi-pill.avoid{background:#fff1f2;color:#be123c;} .gi-pill.soon{background:rgb(var(--surface-slate-100,241 245 249));color:rgb(var(--text-slate-500,100 116 139));}
.gi-take{font-size:.82rem;color:rgb(var(--text-slate-600,71 85 105));}
.gi-scores{font-size:.72rem;color:rgb(var(--text-slate-500,100 116 139));margin-top:5px;font-variant-numeric:tabular-nums;}
.gi-keys{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px;}
.gi-keys li{font-size:.8rem;color:rgb(var(--text-slate-700,51 65 85));padding-left:14px;position:relative;line-height:1.4;}
.gi-keys li::before{content:"";position:absolute;left:0;top:.52em;width:5px;height:5px;border-radius:50%;background:var(--brand-600);}
.gi-more{appearance:none;border:1px solid var(--brand-600);color:var(--brand-600);background:transparent;
  border-radius:999px;padding:6px 14px;font-weight:700;font-size:.78rem;cursor:pointer;white-space:nowrap;}
.gi-more:hover{background:var(--brand-600);color:#fff;}
.gi-more.ghost{border-color:rgb(var(--edge-slate-300,203 213 225));color:rgb(var(--text-slate-500,100 116 139));}
.gi-more.ghost:hover{background:rgb(var(--surface-slate-100,241 245 249));color:rgb(var(--text-slate-700,51 65 85));}
.gi-actcell{text-align:right;}

/* ---- the one-pager (self-contained light surface) ---- */
.gi-pager{background:#fff;color:#111827;font-family:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  line-height:1.55;max-height:86vh;overflow:auto;-webkit-font-smoothing:antialiased;}
.gi-pager *{box-sizing:border-box;}
.gi-pager .in{padding:0 22px 26px;}
.gi-pg-h1,.gi-pg-sh,.gi-badge,.gi-disp{font-family:"Plus Jakarta Sans","Inter",system-ui,sans-serif;}
.gi-hero{position:relative;overflow:hidden;color:#f4f2ff;padding:22px 24px 22px;
  background:linear-gradient(135deg,#312e81 0%,#4f46e5 44%,#7c3aed 74%,#c0287e 100%);}
.gi-hero::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(135% 130% at 90% -15%,rgb(255 255 255 / .22),transparent 55%);}
.gi-hero>*{position:relative;}
.gi-kick{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-family:"Plus Jakarta Sans",sans-serif;
  font-weight:800;letter-spacing:.15em;font-size:.65rem;text-transform:uppercase;color:#fff;}
.gi-dot{width:14px;height:14px;border-radius:5px;background:linear-gradient(135deg,#fde68a,#fb7185);box-shadow:0 0 0 3px rgb(255 255 255 / .14);}
.gi-kick .thin{font-weight:600;letter-spacing:.12em;color:#d4d1f7;}
.gi-demo{margin-left:auto;font-size:.6rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#fff;
  background:rgb(255 255 255 / .15);border:1px solid rgb(255 255 255 / .34);padding:4px 9px;border-radius:999px;}
.gi-co2{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-top:14px;}
.gi-co2 h1{font-size:1.9rem;font-weight:800;margin:0;color:#fff;letter-spacing:-.015em;line-height:1.08;}
.gi-tk{font-weight:700;font-size:.78rem;letter-spacing:.04em;color:#fff;background:rgb(255 255 255 / .17);
  border:1px solid rgb(255 255 255 / .3);border-radius:999px;padding:3px 11px;}
.gi-lead{margin-top:9px;font-size:.98rem;color:#fff;opacity:.96;max-width:64ch;}
.gi-facts{display:flex;flex-wrap:wrap;gap:6px 18px;padding:12px 24px;border-bottom:1px solid #e5e8f1;
  font-size:.83rem;color:#56617a;}
.gi-facts span{white-space:nowrap;} .gi-facts b{color:#111827;font-weight:700;}
.gi-facts .live{color:#047857;font-weight:700;} .gi-facts .asof{color:#8b94a7;font-style:italic;}
.gi-sh{display:flex;align-items:center;gap:10px;margin:22px 0 11px;font-size:1.02rem;font-weight:800;color:#111827;}
.gi-sh::before{content:"";width:4px;height:18px;border-radius:3px;background:linear-gradient(180deg,#4f46e5,#7c3aed);}
.gi-prose{font-size:.95rem;color:#56617a;max-width:74ch;} .gi-prose b{color:#111827;}
.gi-verdict{display:grid;grid-template-columns:150px 1fr;gap:16px 20px;align-items:center;
  border:1px solid #e5e8f1;border-radius:14px;padding:18px 20px;}
.gi-call{display:flex;flex-direction:column;align-items:center;gap:7px;text-align:center;}
.gi-badge{font-weight:800;font-size:1.02rem;letter-spacing:.05em;text-transform:uppercase;padding:10px 20px;
  border-radius:999px;color:#fff;white-space:nowrap;box-shadow:0 7px 18px rgb(217 119 6 / .28);
  background:linear-gradient(135deg,#f59e0b,#d97706);}
.gi-badge.buy{background:linear-gradient(135deg,#10b981,#047857);box-shadow:0 7px 18px rgb(5 150 105 / .28);}
.gi-badge.avoid{background:linear-gradient(135deg,#fb7185,#be123c);box-shadow:0 7px 18px rgb(190 18 60 / .28);}
.gi-call small{color:#8b94a7;font-size:.64rem;letter-spacing:.06em;text-transform:uppercase;font-weight:700;}
.gi-scorebox{display:flex;flex-direction:column;gap:13px;min-width:0;}
.gi-score .row{display:flex;justify-content:space-between;align-items:baseline;font-size:.84rem;margin-bottom:6px;}
.gi-score .lab{color:#111827;font-weight:700;} .gi-score .lab span{color:#8b94a7;font-weight:500;font-size:.75rem;}
.gi-score .num{font-weight:800;font-size:.95rem;font-variant-numeric:tabular-nums;}
.gi-track{height:10px;border-radius:999px;background:#e3e7f1;overflow:hidden;}
.gi-fill{height:100%;border-radius:999px;} .gi-fill.q{background:linear-gradient(90deg,#4f46e5,#7c3aed);}
.gi-fill.p{background:linear-gradient(90deg,#f59e0b,#e11d48);}
.gi-why{grid-column:1/-1;color:#56617a;font-size:.91rem;border-top:1px dashed #e5e8f1;padding-top:13px;}
.gi-why b{color:#111827;}
.gi-trig{display:block;margin-top:11px;font-size:.87rem;color:#065f46;background:#f0fdf6;border:1px solid #bdecd1;border-radius:11px;padding:9px 13px;}
.gi-cols{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.gi-col{border-radius:14px;border:1px solid;overflow:hidden;min-width:0;}
.gi-col.like{border-color:#bdecd1;background:#f0fdf6;} .gi-col.dislike{border-color:#f8ccd4;background:#fff5f6;}
.gi-colhd{display:flex;align-items:center;gap:9px;padding:12px 15px;font-family:"Plus Jakarta Sans",sans-serif;
  font-weight:800;font-size:.95rem;color:#fff;} .gi-col.like .gi-colhd{background:#059669;} .gi-col.dislike .gi-colhd{background:#e11d48;}
.gi-mk{width:22px;height:22px;border-radius:7px;background:rgb(255 255 255 / .22);display:grid;place-items:center;font-size:.82rem;font-weight:800;flex:none;}
.gi-colbody{padding:3px 15px 14px;}
.gi-pt{padding:12px 0;border-top:1px solid rgb(203 213 225 / .55);} .gi-pt:first-child{border-top:0;}
.gi-pt .t{font-weight:700;font-size:.93rem;letter-spacing:-.01em;margin-bottom:4px;display:flex;gap:8px;}
.gi-pt .t .b{flex:none;font-weight:800;opacity:.55;} .gi-col.like .gi-pt .t .b{color:#047857;} .gi-col.dislike .gi-pt .t .b{color:#be123c;}
.gi-pt .d{font-size:.86rem;color:#56617a;}
.gi-pt .tag{display:inline-block;margin-top:8px;font-size:.61rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
  color:#4338ca;background:#eef2ff;border-radius:999px;padding:3px 9px;}
.gi-ftable{width:100%;border-collapse:collapse;font-size:.88rem;}
.gi-ftable thead th{text-align:right;font-weight:800;color:#8b94a7;font-size:.64rem;letter-spacing:.05em;text-transform:uppercase;padding:9px 12px;border-bottom:2px solid #e5e8f1;}
.gi-ftable thead th:first-child{text-align:left;}
.gi-ftable tbody td{padding:10px 12px;text-align:right;border-bottom:1px solid #eef0f5;font-variant-numeric:tabular-nums;}
.gi-ftable tbody td:first-child{text-align:left;font-weight:600;color:#56617a;}
.gi-ftable tbody tr:nth-child(even){background:#f7f8fc;} .gi-ftable tbody tr:last-child td{border-bottom:0;}
.gi-ftable td.pos{color:#047857;font-weight:700;}
.gi-fnote{font-size:.77rem;color:#8b94a7;margin-top:11px;line-height:1.5;}
.gi-wrapcard{border:1px solid #e5e8f1;border-radius:14px;padding:16px 18px;}
.gi-close{margin-top:22px;display:flex;gap:13px;align-items:flex-start;font-family:"Plus Jakarta Sans",sans-serif;
  font-size:1.02rem;font-weight:700;line-height:1.5;color:#111827;letter-spacing:-.01em;}
.gi-close .q{flex:none;width:5px;align-self:stretch;border-radius:3px;background:linear-gradient(180deg,#4f46e5,#7c3aed);}
.gi-foot{margin-top:18px;color:#8b94a7;font-size:.76rem;line-height:1.55;border-top:1px solid #e5e8f1;padding-top:13px;}
.gi-foot b{color:#56617a;}
.gi-coming{padding:26px 26px 30px;color:#111827;font-family:"Inter",system-ui,sans-serif;}
.gi-coming h3{font-family:"Plus Jakarta Sans",sans-serif;font-size:1.2rem;margin:6px 0 10px;}
.gi-coming p{color:#56617a;font-size:.94rem;line-height:1.6;}
@media (max-width:680px){
  .gi-cols{grid-template-columns:1fr;}
  .gi-verdict{grid-template-columns:1fr;justify-items:center;text-align:center;} .gi-why{text-align:left;}
  .gi-co2 h1{font-size:1.5rem;}
  .gi-table thead .hide-sm,.gi-table td.hide-sm{display:none;}
}`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/* ---------------- data helpers ---------------- */
function market(ticker) {
  let row = null;
  try { row = technicals.rowFor(ticker); } catch { row = null; }
  const cmp = row && Number.isFinite(row.cmp) ? row.cmp : null;
  const chg = row && Number.isFinite(row.pct_change_today) ? row.pct_change_today : null;
  return { cmp, chg };
}
const rupee = (n) => (Number.isFinite(n) ? '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : null);
const signed = (n) => (n > 0 ? '+' : '') + n.toFixed(2) + '%';

function tableRows() {
  const held = new Map((coverage.holdings() || []).map((h) => [h.ticker, h]));
  const out = [];
  for (const g of RESEARCHED_SECTORS) {
    for (const t of g.tickers) {
      const h = held.get(t);
      if (!h) continue; // only the family's real holdings
      out.push({ ticker: t, name: h.name, sector: g.sector, insight: getInsight(t) });
    }
  }
  // Companies with a finished one-pager first, then alphabetical.
  out.sort((a, b) => (b.insight ? 1 : 0) - (a.insight ? 1 : 0) || a.name.localeCompare(b.name));
  return out;
}

/* ---------------- render ---------------- */
export function render(ctx) {
  destroy();
  ctxRef = ctx;
  ensureStyles();

  const rows = tableRows();
  const ready = rows.filter((r) => r.insight).length;

  ctx.root.innerHTML = `
    <div class="gi-tab">
      <div class="mb-5" data-section-head>
        <h2 class="text-2xl font-bold tracking-tight" style="color:rgb(var(--text-slate-900,15 23 42))">AI Insights</h2>
        <p class="text-sm mt-1" style="color:rgb(var(--text-slate-500,100 116 139))">A one-page read on each holding — what we like, what we don't, a verdict and the numbers. Click <b>More</b> to open the full one-pager.</p>
      </div>
      <div class="gi-note">Written from Glow's sector rulebook + the company's own data (Screener financials, con-calls, web &amp; news). Live price is from the dashboard; order book and financials are from Glow research until the fundamentals feed is wired. <b>${ready} compan${ready === 1 ? 'y is' : 'ies are'} fully written so far</b> — the rest show their sector is researched and the page is rolling out. Illustrative, not investment advice.</div>
      <div class="gi-card">
        <table class="gi-table">
          <thead><tr>
            <th>Company</th>
            <th class="num">Price</th>
            <th>Key takeaways</th>
            <th class="num"></th>
          </tr></thead>
          <tbody data-gi-body>${rows.map(rowHtml).join('')}</tbody>
        </table>
      </div>
    </div>`;

  ctx.root.querySelector('[data-gi-body]').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open]');
    if (btn) openCompany(btn.dataset.open);
  });

  // The technicals capture may still be loading at mount; repaint prices once it lands.
  if (!technicals.isLoaded?.()) {
    technicals.load?.().then(() => {
      if (ctxRef === ctx) {
        const body = ctx.root.querySelector('[data-gi-body]');
        if (body) body.innerHTML = tableRows().map(rowHtml).join('');
      }
    }).catch(() => {});
  }
  offTech = technicals.onChange?.(() => {
    if (ctxRef !== ctx) return;
    const body = ctx.root.querySelector('[data-gi-body]');
    if (body) body.innerHTML = tableRows().map(rowHtml).join('');
  }) || null;
}

function rowHtml(r) {
  const m = market(r.ticker);
  const price = rupee(m.cmp);
  const chgCls = m.chg == null ? 'gi-flat' : m.chg > 0 ? 'gi-up' : m.chg < 0 ? 'gi-dn' : 'gi-flat';
  const priceCell = price
    ? `${price}<small class="${chgCls}">${m.chg == null ? '' : signed(m.chg)}</small>`
    : '<span class="gi-flat">—</span>';

  let view, action;
  if (r.insight) {
    const d = r.insight;
    const cls = d.verdict.toLowerCase();
    const keys = (d.takeaways || []).map((k) => `<li>${esc(k)}</li>`).join('');
    view = `<span class="gi-pill ${cls}">${esc(d.verdict)}</span>`
      + (keys ? `<ul class="gi-keys">${keys}</ul>` : `<span class="gi-take">${esc(d.verdictSub)}</span>`)
      + `<div class="gi-scores">Business quality ${d.quality} · Price/value ${d.price}</div>`;
    action = `<button class="gi-more" data-open="${esc(r.ticker)}">More →</button>`;
  } else {
    view = `<span class="gi-pill soon">Researching</span><span class="gi-take">Sector rulebook ready — one-pager rolling out</span>`;
    action = `<button class="gi-more ghost" data-open="${esc(r.ticker)}">More →</button>`;
  }

  return `<tr>
    <td><span class="gi-co">${esc(r.name)}</span><small>${esc(r.ticker)} · ${esc(r.sector)}</small></td>
    <td class="gi-cmp hide-sm">${priceCell}</td>
    <td class="gi-view">${view}</td>
    <td class="gi-actcell">${action}</td>
  </tr>`;
}

/* ---------------- the one-pager ---------------- */
function openCompany(ticker) {
  const d = getInsight(ticker);
  if (!d) return openModal(comingHtml(ticker), { size: 'default' });
  openModal(pagerHtml(d), { size: 'magazine' });
}

function pagerHtml(d) {
  const m = market(d.ticker);
  const liveFact = m.cmp != null
    ? `<span class="live">CMP ${rupee(m.cmp)}${m.chg == null ? '' : ' · ' + signed(m.chg) + ' today'} · live</span>`
    : '';
  const facts = d.facts.map((f) => `<span>${esc(f.k)} <b>${esc(f.v)}</b></span>`).join('');
  const like = d.like.map((p, i) => ptHtml(p, i)).join('');
  const dislike = d.dislike.map((p, i) => ptHtml(p, i)).join('');
  const fcols = d.financials.cols.map((c) => `<th>${esc(c)}</th>`).join('');
  const frows = d.financials.rows.map((row) => `<tr><td>${esc(row.k)}</td>${row.v
    .map((v, i) => `<td class="${row.pos && row.pos[i] ? 'pos' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('');
  const vcls = d.verdict.toLowerCase();

  return `<div class="gi-pager">
    <div class="gi-hero">
      <div class="gi-kick"><span class="gi-dot"></span> Glow AI Insights <span class="thin">The 5-minute stock read</span>
        <span class="gi-demo">Illustrative · not advice</span></div>
      <div class="gi-co2"><h1>${esc(d.name)}</h1><span class="gi-tk">${esc(d.ticker)} · NSE</span></div>
      <div class="gi-lead">${d.lead}</div>
    </div>
    <div class="gi-facts">${facts}${liveFact}<span class="asof">as of ${esc(d.asOf)} · indicative</span></div>
    <div class="in">
      <h2 class="gi-sh">What the company does</h2>
      <p class="gi-prose">${d.what}</p>

      <h2 class="gi-sh">Our view</h2>
      <div class="gi-verdict">
        <div class="gi-call"><span class="gi-badge ${vcls}">${esc(d.verdict)}</span><small>${esc(d.verdictSub)}</small></div>
        <div class="gi-scorebox">
          <div class="gi-score"><div class="row"><span class="lab">Business quality <span>— how good is the company?</span></span><span class="num">${d.quality} / 100</span></div><div class="gi-track"><div class="gi-fill q" style="width:${d.quality}%"></div></div></div>
          <div class="gi-score"><div class="row"><span class="lab">Price / value <span>— cheap or expensive today?</span></span><span class="num">${d.price} / 100</span></div><div class="gi-track"><div class="gi-fill p" style="width:${d.price}%"></div></div></div>
        </div>
        <div class="gi-why">${d.why}<span class="gi-trig">↗ ${d.trigger}</span></div>
      </div>

      <h2 class="gi-sh">The case — for and against</h2>
      <div class="gi-cols">
        <div class="gi-col like"><div class="gi-colhd"><span class="gi-mk">✓</span> What we like</div><div class="gi-colbody">${like}</div></div>
        <div class="gi-col dislike"><div class="gi-colhd"><span class="gi-mk">✕</span> What we don't like</div><div class="gi-colbody">${dislike}</div></div>
      </div>

      <h2 class="gi-sh">Financials at a glance</h2>
      <div class="gi-wrapcard">
        <table class="gi-ftable"><thead><tr><th>₹ crore</th>${fcols}</tr></thead><tbody>${frows}</tbody></table>
        <div class="gi-fnote">${d.fnote}</div>
      </div>

      <div class="gi-close"><span class="q"></span><span>${d.close}</span></div>

      <div class="gi-foot"><b>How this is built:</b> written from Glow's ${esc(d.ourSector)} rulebook applied to the company's own data — order book, results, con-call commentary, filings and live market data. Business-quality and price scores come from weighing every signal that fired; the page shows only the few that matter here. Market price is live from the dashboard; order book and financials are from Glow research (the fundamentals feed is being wired). <b>Illustrative demo</b> — figures approximate; not investment advice.</div>
    </div>
  </div>`;
}

function ptHtml(p, i) {
  const n = String(i + 1).padStart(2, '0');
  return `<div class="gi-pt"><div class="t"><span class="b">${n}</span><span>${esc(p.t)}</span></div><div class="d">${esc(p.d)}</div><span class="tag">${esc(p.tag)}</span></div>`;
}

function comingHtml(ticker) {
  const held = (coverage.holdings() || []).find((h) => h.ticker === ticker);
  const name = held?.name || ticker;
  let sector = '';
  for (const g of RESEARCHED_SECTORS) if (g.tickers.includes(ticker)) sector = g.sector;
  return `<div class="gi-coming">
    <span class="gi-pill soon" style="font-size:.7rem">Rolling out</span>
    <h3>${esc(name)}</h3>
    <p>This company sits in a sector Glow has already researched${sector ? ` — <b>${esc(sector)}</b>` : ''}, so its signal rulebook is ready. Its full one-pager (What We Like / What We Don't Like, verdict and numbers) is being written from Screener, con-calls and web research, the same way as the live examples.</p>
    <p style="margin-top:12px;font-size:.84rem;color:#8b94a7">Illustrative feature preview — not investment advice.</p>
  </div>`;
}

export function destroy() {
  offTech?.();
  offTech = null;
  ctxRef = null;
}

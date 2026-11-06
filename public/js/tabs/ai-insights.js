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
import { push as pushNote } from '../ui/notifications.js';
import * as coverage from '../data/coverage.js';
import * as technicals from '../data/technicals.js';
import * as watchlist from '../core/watchlist.js';
import { watchScopeCompanies, isPreviousScope } from '../data/scope.js';
import { themeCatalog, themesForCompany } from '../data/theme-exposures.js';
import * as fundamentals from '../data/fundamentals.js';
import { RESEARCHED_SECTORS, getInsight } from '../data/ai-insights-data.js';

export const meta = TAB_META['ai-insights'];
let ctxRef = null;
let offTech = null;
let offRuns = null;   // the mounted tab's subscription to run-state changes
let offProg = null;   // the open progress screen's subscription
// Auto-update (AI Alerts → sector KPIs): the live result per ticker, and a token so a slow lookup
// for one company can't paint into another company's open one-pager. Zero credits — ai-insights-live.js.
const liveData = new Map();
let liveToken = null;
// The AI-written "Our view" per ticker, cached for the session so re-opening a run company never
// re-spends the metered AI step. Kept across tab mounts (not cleared in destroy) for the same reason.
const aiIdeaData = new Map();
// Which pool the Run picker offers: the family's holdings, the shared watchlist, or the wider universe.
let runScope = 'portfolio';

/* ---------------- styles (scoped, injected once) ---------------- */
const STYLE_ID = 'gi-insights-style';
const CSS = `
.gi-tab{max-width:1400px;margin:0 auto;}
.gi-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:2px 0 16px;flex-wrap:wrap;}
.gi-head h2{font-family:"Plus Jakarta Sans","Inter",sans-serif;font-size:1.55rem;font-weight:800;letter-spacing:-.02em;margin:0;color:rgb(var(--text-slate-900,15 23 42));}
.gi-info{appearance:none;border:1px solid rgb(var(--edge-slate-200,226 232 240));background:rgb(var(--surface-white,255 255 255));color:rgb(var(--text-slate-500,100 116 139));border-radius:999px;padding:6px 13px;font-size:.74rem;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:7px;white-space:nowrap;}
.gi-info:hover{color:var(--brand-600);border-color:var(--brand-600);}
.gi-info .d{width:8px;height:8px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#a855f7 55%,#ec4899);}
.gi-card{background:rgb(var(--surface-white,255 255 255));border:1px solid rgb(var(--edge-slate-200,226 232 240));border-radius:18px;overflow:hidden;box-shadow:0 1px 3px rgb(15 23 42 / .05),0 18px 40px -28px rgb(79 70 229 / .35);}
.gi-table{width:100%;border-collapse:collapse;font-size:.9rem;}
.gi-table th.c-co{width:32%;} .gi-table th.c-tk{width:38%;} .gi-table th.c-sc{width:162px;}
.gi-table th.c-px,.gi-table th.c-mo{width:1%;white-space:nowrap;}
.gi-table thead th{text-align:left;font-size:.63rem;letter-spacing:.08em;text-transform:uppercase;font-weight:800;
  color:rgb(var(--text-slate-500,100 116 139));padding:13px 16px;
  background:linear-gradient(180deg,rgb(var(--surface-indigo-50,238 242 255)) 0%,rgb(var(--surface-white,255 255 255)) 100%);
  border-bottom:1px solid rgb(var(--edge-slate-200,226 232 240));}
.gi-table thead th.num{text-align:right;}
.gi-table tbody td{padding:15px 16px;border-bottom:1px solid rgb(var(--edge-slate-100,241 245 249));vertical-align:top;}
.gi-table tbody tr:last-child td{border-bottom:0;}
.gi-row{cursor:pointer;transition:background .14s ease;}
.gi-row:hover{background:rgb(var(--surface-indigo-50,238 242 255));}
.gi-row:focus-visible{outline:2px solid var(--brand-600);outline-offset:-2px;}
.gi-cco{display:flex;align-items:center;gap:12px;min-width:0;}
.gi-av{flex:none;width:40px;height:40px;border-radius:12px;display:grid;place-items:center;color:#fff;font-weight:800;
  font-size:.84rem;font-family:"Plus Jakarta Sans",sans-serif;box-shadow:0 4px 10px -3px rgb(15 23 42 / .35);}
.gi-cometa{min-width:0;}
.gi-co{font-weight:700;color:rgb(var(--text-slate-900,15 23 42));display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gi-cometa small{display:block;font-weight:500;color:rgb(var(--text-slate-500,100 116 139));font-size:.72rem;margin-top:3px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gi-cmp{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;color:rgb(var(--text-slate-900,15 23 42));font-weight:700;}
.gi-cmp small{display:block;font-weight:700;font-size:.72rem;margin-top:3px;}
.gi-up{color:var(--positive);} .gi-dn{color:var(--negative);} .gi-flat{color:rgb(var(--text-slate-400,148 163 184));}
.gi-pill{display:inline-block;font-weight:800;font-size:.64rem;letter-spacing:.05em;text-transform:uppercase;
  padding:4px 11px;border-radius:999px;margin-bottom:8px;}
.gi-pill.watchlist{background:#fff3e0;color:#b45309;box-shadow:inset 0 0 0 1px #f7d49c;}
.gi-pill.buy{background:#e8fbf1;color:#047857;box-shadow:inset 0 0 0 1px #a3e6c4;}
.gi-pill.avoid{background:#fff0f2;color:#be123c;box-shadow:inset 0 0 0 1px #f5bcc5;}
.gi-pill.soon{background:rgb(var(--surface-slate-100,241 245 249));color:rgb(var(--text-slate-500,100 116 139));}
.gi-keys{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:5px;}
.gi-keys li{font-size:.82rem;color:rgb(var(--text-slate-700,51 65 85));padding-left:16px;position:relative;line-height:1.45;}
.gi-keys li::before{content:"";position:absolute;left:0;top:.5em;width:6px;height:6px;border-radius:2px;background:linear-gradient(135deg,#6366f1,#a855f7);}
.gi-take{font-size:.82rem;color:rgb(var(--text-slate-600,71 85 105));}
.gi-meters{display:flex;flex-direction:column;gap:11px;}
.gi-meter{display:grid;grid-template-columns:1fr auto;gap:4px 8px;align-items:baseline;}
.gi-meter .ml{font-size:.6rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:rgb(var(--text-slate-500,100 116 139));}
.gi-meter .mv{font-size:.82rem;font-weight:800;font-variant-numeric:tabular-nums;color:rgb(var(--text-slate-800,30 41 59));}
.gi-meter .mbar{grid-column:1/-1;height:6px;border-radius:999px;background:rgb(var(--surface-slate-100,241 245 249));overflow:hidden;}
.gi-meter .mbar i{display:block;height:100%;border-radius:999px;}
.gi-meter .mbar i.q{background:linear-gradient(90deg,#6366f1,#a855f7);}
.gi-meter .mbar i.p{background:linear-gradient(90deg,#f59e0b,#ec4899);}
.gi-mo{display:flex;justify-content:flex-end;padding-top:2px;}
.gi-chev{display:inline-flex;align-items:center;gap:5px;font-weight:800;font-size:.76rem;color:var(--brand-600);white-space:nowrap;transition:gap .14s ease;}
.gi-row:hover .gi-chev{gap:9px;}
.gi-chev.ghost{color:rgb(var(--text-slate-400,148 163 184));}

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
.gi-gd{width:100%;border-collapse:collapse;font-size:.87rem;}
.gi-gd thead th{text-align:left;font-weight:800;color:#8b94a7;font-size:.63rem;letter-spacing:.05em;text-transform:uppercase;padding:9px 12px;border-bottom:2px solid #e5e8f1;}
.gi-gd tbody td{padding:11px 12px;border-bottom:1px solid #eef0f5;vertical-align:top;}
.gi-gd tbody tr:last-child td{border-bottom:0;}
.gi-gd .gd-th{font-weight:700;color:#111827;}
.gi-gd .gd-gd{color:#56617a;font-size:.82rem;margin-top:2px;}
.gi-gd .gd-note{color:#56617a;}
.gi-st{display:inline-block;font-weight:800;font-size:.6rem;letter-spacing:.04em;text-transform:uppercase;padding:2px 8px;border-radius:999px;margin-right:7px;white-space:nowrap;}
.gi-st.kept{background:#ecfdf5;color:#047857;} .gi-st.watch{background:#fffbeb;color:#b45309;} .gi-st.missed{background:#fff1f2;color:#be123c;}
.gi-trend{margin-top:13px;font-size:.9rem;color:#111827;font-weight:600;line-height:1.5;border-left:3px solid #4f46e5;padding-left:12px;}
.gi-wrapcard{border:1px solid #e5e8f1;border-radius:14px;padding:16px 18px;}
.gi-close{margin-top:22px;display:flex;gap:13px;align-items:flex-start;font-family:"Plus Jakarta Sans",sans-serif;
  font-size:1.02rem;font-weight:700;line-height:1.5;color:#111827;letter-spacing:-.01em;}
.gi-close .q{flex:none;width:5px;align-self:stretch;border-radius:3px;background:linear-gradient(180deg,#4f46e5,#7c3aed);}
.gi-foot{margin-top:18px;color:#8b94a7;font-size:.76rem;line-height:1.55;border-top:1px solid #e5e8f1;padding-top:13px;}
.gi-foot b{color:#56617a;}
.gi-coming{padding:26px 26px 30px;color:#111827;font-family:"Inter",system-ui,sans-serif;}
.gi-coming h3{font-family:"Plus Jakarta Sans",sans-serif;font-size:1.2rem;margin:6px 0 10px;}
.gi-coming p{color:#56617a;font-size:.94rem;line-height:1.6;}
/* Intrinsic value vs price + sector KPIs */
.gi-iv{border:1px solid #e5e8f1;border-radius:14px;padding:15px 16px;}
.gi-iv-nums{display:flex;gap:12px;flex-wrap:wrap;}
.gi-iv-box{flex:1;min-width:150px;border-radius:12px;padding:12px 14px;background:#f7f8fc;border:1px solid #eceff5;}
.gi-iv-box span{display:block;font-size:.62rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#8b94a7;}
.gi-iv-box b{display:block;font-size:1.3rem;font-weight:800;color:#111827;margin-top:4px;letter-spacing:-.01em;}
.gi-iv-box small{color:#8b94a7;font-size:.72rem;}
.gi-iv-box.live{background:linear-gradient(135deg,#eef2ff,#faf0fb);border-color:#e3d9fb;}
.gi-iv-box.live b{color:#4f46e5;}
.gi-iv-read{margin-top:11px;font-size:.84rem;font-weight:600;border-radius:10px;padding:9px 12px;}
.gi-iv-read.good{background:#f0fdf6;color:#047857;border:1px solid #bdecd1;}
.gi-iv-read.watch{background:#fffbeb;color:#b45309;border:1px solid #fde8b0;}
.gi-iv-read.rich{background:#fff1f2;color:#be123c;border:1px solid #f8ccd4;}
.gi-iv-metric{margin-top:9px;font-size:.8rem;color:#56617a;} .gi-iv-metric b{color:#111827;}
.gi-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:8px;}
.gi-kpi{border-radius:11px;border:1px solid #eceff5;background:#fff;padding:10px 12px 10px 26px;position:relative;}
.gi-kpi::before{content:"";position:absolute;left:12px;top:14px;width:7px;height:7px;border-radius:50%;background:#94a3b8;}
.gi-kpi.good::before{background:#10b981;} .gi-kpi.watch::before{background:#f59e0b;} .gi-kpi.rich::before{background:#f43f5e;}
.gi-kpi span{display:block;font-size:.7rem;color:#56617a;line-height:1.3;} .gi-kpi b{display:block;font-size:.95rem;color:#111827;font-weight:800;margin-top:3px;}
/* Deep fundamentals (Screener, reproduced) + the fair-value band's "Glow estimate" label. */
.gi-src-tag{font-size:.6rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#0369a1;background:#e0f2fe;border:1px solid #bae6fd;border-radius:999px;padding:3px 8px;margin-left:8px;vertical-align:middle;}
.gi-fratios{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin:2px 0 10px;}
.gi-fchip{border-radius:11px;border:1px solid #eceff5;background:#fff;padding:8px 12px;}
.gi-fchip span{display:block;font-size:.68rem;color:#56617a;} .gi-fchip b{display:block;font-size:.98rem;color:#111827;font-weight:800;margin-top:2px;}
.gi-fgrows{display:flex;flex-wrap:wrap;gap:8px 20px;margin:0 0 11px;}
.gi-fgrow{font-size:.78rem;color:#56617a;} .gi-fgrow span{font-weight:700;color:#4b4257;} .gi-fgrow b{color:#111827;font-weight:700;}
.gi-fpc{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:11px;}
.gi-fpc-col{border-radius:12px;border:1px solid #eceff5;padding:10px 13px;}
.gi-fpc-col.pros{background:#f0fdf6;border-color:#bbf7d0;} .gi-fpc-col.cons{background:#fff5f7;border-color:#fecdd3;}
.gi-fpc-h{font-size:.74rem;font-weight:800;color:#374151;margin-bottom:5px;}
.gi-fpc-col ul{margin:0;padding-left:16px;} .gi-fpc-col li{font-size:.79rem;color:#4b5563;line-height:1.45;margin:3px 0;}
@media (max-width:640px){.gi-fpc{grid-template-columns:1fr;}}
/* Auto-update: "What's changed" (AI Alerts → sector KPIs). Free, 0 credits. Light surface like the rest of the pager. */
.gi-live{margin:14px 0 2px;border:1px solid #e6e9f2;border-radius:14px;background:linear-gradient(180deg,#faf9ff,#fff);padding:13px 15px;}
.gi-live-meta{font-size:.72rem;color:#56617a;margin:-2px 0 10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.gi-live-meta b{color:#059669;}
.gi-live-badge{display:inline-flex;align-items:center;gap:5px;font-weight:800;font-size:.62rem;letter-spacing:.04em;text-transform:uppercase;color:#6d28d9;background:#f0ebff;border:1px solid #e3d9ff;border-radius:999px;padding:3px 9px;}
.gi-live-wait{font-size:.82rem;color:#8b94a7;}
.gi-live-empty{font-size:.82rem;color:#56617a;}
.gi-upds{display:flex;flex-direction:column;gap:9px;}
.gi-upd{background:#fff;border:1px solid #eceff5;border-left:3px solid #cbd5e1;border-radius:10px;padding:9px 12px;}
.gi-upd.good{border-left-color:#10b981;} .gi-upd.watch{border-left-color:#f59e0b;} .gi-upd.bad{border-left-color:#f43f5e;}
.gi-upd-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.gi-upd-top b{font-size:.86rem;color:#111827;font-weight:800;}
.gi-upd-tag{font-size:.58rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#56617a;background:#f1f3f9;border-radius:999px;padding:2px 8px;}
.gi-upd-when{margin-left:auto;font-size:.72rem;color:#8b94a7;font-weight:700;}
.gi-upd-what{font-size:.82rem;color:#1f2937;margin-top:4px;}
.gi-upd-why{font-size:.76rem;color:#56617a;margin-top:4px;}
.gi-upd-side{margin-left:7px;font-weight:700;color:#475569;}
.gi-live-more{font-size:.74rem;color:#8b94a7;margin-top:8px;}
.gi-live-net{margin-top:11px;font-size:.8rem;color:#1f2937;background:#f6f4ff;border:1px solid #ece7ff;border-radius:10px;padding:9px 12px;} .gi-live-net b{color:#6d28d9;}
.gi-livedelta{font-size:.6rem;font-weight:800;letter-spacing:.03em;border-radius:999px;padding:2px 7px;margin-left:6px;vertical-align:middle;white-space:nowrap;}
.gi-livedelta.up{color:#059669;background:#e7f7f0;} .gi-livedelta.down{color:#e11d48;background:#fdeaef;}
/* Run-any-company live auto-read: the honest note at the top of the generated page. */
.gi-autonote{font-size:.8rem;color:#4b4257;background:#f6f4ff;border:1px solid #ece7ff;border-radius:10px;padding:10px 13px;margin:2px 0 11px;} .gi-autonote b{color:#6d28d9;}
/* Run picker scope toggle: Portfolio | Watchlist | Universe. */
.gi-rp-scope{display:flex;gap:6px;margin:0 0 10px;}
.gi-rp-scope button{flex:1;appearance:none;cursor:pointer;border:1px solid #e6e9f2;background:#fff;color:#56617a;font-weight:700;font-size:.8rem;border-radius:9px;padding:7px 8px;display:inline-flex;align-items:center;justify-content:center;gap:6px;}
.gi-rp-scope button b{font-weight:800;font-size:.7rem;color:#94a3b8;}
.gi-rp-scope button.on{background:linear-gradient(135deg,#6366f1,#a855f7);border-color:transparent;color:#fff;}
.gi-rp-scope button.on b{color:rgba(255,255,255,.85);}
.gi-rp-empty{padding:20px 6px;color:#8b94a7;font-size:.85rem;text-align:center;}
/* AI-written "Our view" on the live auto-read. */
.gi-ai-tag{font-size:.6rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#6d28d9;background:#f0ebff;border:1px solid #e3d9ff;border-radius:999px;padding:3px 8px;margin-left:8px;vertical-align:middle;}
.gi-ai-note{font-size:.72rem;color:#8b94a7;margin:-3px 0 9px;}
.gi-ai-wait{font-size:.82rem;color:#8b94a7;padding:2px 0 6px;}
.gi-ai-body{font-size:.86rem;color:#1f2937;line-height:1.55;}
.gi-ai-body h1,.gi-ai-body h2,.gi-ai-body h3,.gi-ai-body h4{font-size:.9rem;font-weight:800;margin:12px 0 5px;color:#111827;}
.gi-ai-body p{margin:7px 0;}
.gi-ai-body ul,.gi-ai-body ol{margin:6px 0;padding-left:20px;}
.gi-ai-body li{margin:3px 0;}
.gi-ai-body strong{color:#111827;}
.gi-ai-body blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid #c7bdf0;color:#4b4257;background:#faf9ff;border-radius:0 8px 8px 0;}
.gi-ai-body table{border-collapse:collapse;margin:8px 0;font-size:.8rem;}
.gi-ai-body th,.gi-ai-body td{border:1px solid #eceff5;padding:5px 9px;text-align:left;}
.gi-ai-tail{margin:6px 0 2px;}
.gi-ai-tail h1,.gi-ai-tail h2,.gi-ai-tail h3,.gi-ai-tail h4{font-size:1rem;font-weight:800;margin:16px 0 7px;color:#111827;letter-spacing:-.01em;}
.gi-ai-tail p{font-size:.86rem;color:#1f2937;line-height:1.55;margin:7px 0;}
.gi-ai-tail ul,.gi-ai-tail ol{margin:6px 0;padding-left:20px;font-size:.86rem;color:#1f2937;}
.gi-ai-tail li{margin:3px 0;}
.gi-ai-tail strong{color:#111827;}
.gi-ai-tail table{border-collapse:collapse;margin:8px 0;font-size:.82rem;width:100%;}
.gi-ai-tail th,.gi-ai-tail td{border:1px solid #eceff5;padding:6px 10px;text-align:left;}
.gi-ai-tail th{background:#f7f8fc;font-weight:700;color:#374151;}
.gi-emptycol{font-size:.82rem;color:#8b94a7;padding:4px 2px;}
.gi-ai-unavail{font-size:.84rem;color:#4b4257;background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:12px 14px;margin:6px 0 12px;line-height:1.5;}
.gi-rerun{appearance:none;cursor:pointer;margin-left:6px;font-weight:700;font-size:.8rem;border-radius:9px;padding:5px 12px;border:1px solid #c7d2fe;background:#eef2ff;color:#4338ca;}
.gi-rerun:hover{background:#e0e7ff;}
.gi-pill.done2{background:#ecfdf5;color:#047857;box-shadow:inset 0 0 0 1px #a7f3d0;}
/* Themes — who benefits (event → beneficiary lookup) + per-company exposure chip. */
.gi-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.gi-themes-btn{appearance:none;cursor:pointer;font-weight:700;font-size:.82rem;border-radius:10px;padding:8px 13px;border:1px solid rgb(var(--border-indigo-200,199 210 254));background:var(--surface,#fff);color:var(--brand-600,#4f46e5);}
.gi-themes-btn:hover{background:rgb(var(--surface-indigo-50,238 242 255));}
.gi-themes{display:flex;flex-direction:column;gap:14px;}
.gi-theme{border:1px solid #eceff5;border-left:4px solid var(--accent,#6d28d9);border-radius:14px;padding:13px 15px;background:var(--surface,#fff);}
.gi-theme-h{font-size:1rem;font-weight:800;color:#111827;display:flex;align-items:center;gap:9px;flex-wrap:wrap;}
.gi-theme-ic{width:10px;height:10px;border-radius:999px;background:var(--accent,#6d28d9);flex-shrink:0;}
.gi-theme-n{font-size:.68rem;font-weight:800;letter-spacing:.02em;color:var(--accent,#6d28d9);background:#f4f4f7;border:1px solid #e8e8ef;border-radius:999px;min-width:20px;text-align:center;padding:1px 8px;}
.gi-theme-rows{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:8px;margin-top:11px;}
.gi-theme-row{display:flex;align-items:center;gap:10px;border:1px solid #eceff5;border-radius:11px;padding:8px 11px;background:var(--surface,#fff);min-width:0;}
.gi-theme-co{flex:1;min-width:0;display:flex;flex-direction:column;}
.gi-theme-nm{font-size:.86rem;color:#111827;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gi-theme-co small{font-size:.72rem;color:#8b94a7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gi-theme-src{font-size:.72rem;font-weight:700;color:var(--brand-600,#4f46e5);text-decoration:none;white-space:nowrap;flex-shrink:0;}
.gi-theme-src:hover{text-decoration:underline;}
.gi-theme-chip{font-size:.8rem;color:#4b4257;background:#faf6ff;border:1px solid #efe6ff;border-radius:10px;padding:8px 12px;margin:0 0 4px;} .gi-theme-chip b{color:#6d28d9;}
/* Compact one-pager — smaller type, tighter spacing, shorter scroll (desk request). */
.gi-pager{line-height:1.48;}
.gi-pager .in{padding:0 20px 18px;}
.gi-co2 h1{font-size:1.32rem;}
.gi-lead{font-size:.86rem;margin-top:6px;}
.gi-hero{padding:15px 20px;}
.gi-facts{padding:9px 20px;font-size:.77rem;}
.gi-sh{margin:15px 0 8px;font-size:.86rem;}
.gi-prose{font-size:.83rem;}
.gi-verdict{padding:13px 15px;gap:11px 16px;}
.gi-badge{font-size:.8rem;padding:7px 14px;}
.gi-call small{font-size:.58rem;}
.gi-score .row{font-size:.77rem;margin-bottom:5px;} .gi-score .num{font-size:.85rem;} .gi-score .lab span{font-size:.7rem;}
.gi-track{height:8px;}
.gi-why{font-size:.82rem;padding-top:10px;} .gi-trig{font-size:.79rem;padding:8px 11px;margin-top:9px;}
.gi-cols{gap:12px;} .gi-colhd{font-size:.85rem;padding:9px 13px;}
.gi-pt{padding:9px 0;} .gi-pt .t{font-size:.83rem;} .gi-pt .d{font-size:.79rem;} .gi-pt .tag{font-size:.57rem;}
.gi-ftable{font-size:.79rem;} .gi-ftable tbody td{padding:7px 11px;}
.gi-gd{font-size:.78rem;} .gi-gd tbody td{padding:8px 11px;} .gi-gd .gd-gd{font-size:.75rem;}
.gi-trend{font-size:.83rem;} .gi-wrapcard{padding:13px 15px;}
.gi-close{font-size:.85rem;margin-top:16px;}
/* Download-PDF button in the one-pager hero. */
.gi-pdf{margin-left:auto;appearance:none;cursor:pointer;color:#fff;font-weight:800;font-size:.6rem;letter-spacing:.06em;
  text-transform:uppercase;background:rgb(255 255 255 / .18);border:1px solid rgb(255 255 255 / .36);border-radius:999px;
  padding:5px 11px;display:inline-flex;align-items:center;gap:6px;}
.gi-pdf:hover{background:rgb(255 255 255 / .28);}
.gi-refresh{margin-left:auto;appearance:none;cursor:pointer;color:#fff;font-weight:800;font-size:.6rem;letter-spacing:.06em;
  text-transform:uppercase;background:rgb(255 255 255 / .18);border:1px solid rgb(255 255 255 / .36);border-radius:999px;
  padding:5px 11px;display:inline-flex;align-items:center;gap:6px;}
.gi-refresh:hover{background:rgb(255 255 255 / .28);}
.gi-refresh:disabled{opacity:.6;cursor:default;}
.gi-refresh + .gi-pdf{margin-left:8px;}
.gi-live-hint{color:#9aa3b2;font-weight:400;font-size:.75rem;}
@media print{.gi-pdf,.gi-refresh{display:none;}}
/* Run a company — button, running chips, picker and the background progress screen. */
.gi-run-btn{appearance:none;border:0;cursor:pointer;color:#fff;font-weight:800;font-size:.82rem;border-radius:999px;
  padding:9px 18px;display:inline-flex;align-items:center;gap:8px;white-space:nowrap;
  background:linear-gradient(135deg,#6366f1,#7c3aed 55%,#ec4899);box-shadow:0 8px 20px -8px rgb(124 58 237 / .6);}
.gi-run-btn:hover{filter:brightness(1.07);}
.gi-runchips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px;}
.gi-runchips:empty{display:none;margin:0;}
.gi-runchip{appearance:none;cursor:pointer;border:1px solid rgb(var(--edge-indigo-100,224 231 255));
  background:rgb(var(--surface-indigo-50,238 242 255));color:var(--brand-600);font-weight:700;font-size:.76rem;
  border-radius:999px;padding:6px 13px;display:inline-flex;align-items:center;gap:8px;}
.gi-runchip b{font-variant-numeric:tabular-nums;}
.gi-spin{width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;
  display:inline-block;animation:gi-spin .7s linear infinite;}
@keyframes gi-spin{to{transform:rotate(360deg);}}
.gi-pill.firstcut{background:#eef2ff;color:#4338ca;box-shadow:inset 0 0 0 1px #c7d2fe;}
.gi-picker{padding:22px 22px 10px;font-family:"Inter",system-ui,sans-serif;color:#111827;}
.gi-picker-h h3{font-family:"Plus Jakarta Sans",sans-serif;font-size:1.25rem;font-weight:800;margin:0 0 4px;}
.gi-picker-h p{color:#56617a;font-size:.86rem;margin:0 0 14px;line-height:1.5;}
.gi-picker-search{width:100%;border:1px solid #e5e8f1;border-radius:11px;padding:10px 13px;font-size:.9rem;margin-bottom:12px;outline:none;color:#111827;}
.gi-picker-search:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgb(99 102 241 / .15);}
.gi-picker-list{max-height:56vh;overflow:auto;display:flex;flex-direction:column;gap:3px;margin:0 -6px;padding:0 6px 14px;}
.gi-rp-row{appearance:none;cursor:pointer;background:transparent;border:0;border-radius:12px;padding:10px 12px;display:flex;align-items:center;gap:12px;text-align:left;width:100%;}
.gi-rp-row:hover{background:#f4f5fb;}
.gi-av.sm{width:34px;height:34px;border-radius:10px;font-size:.74rem;box-shadow:0 3px 7px -3px rgb(15 23 42 / .35);}
.gi-av.lg{width:52px;height:52px;border-radius:15px;font-size:1.05rem;}
.gi-rp-meta{min-width:0;flex:1;}
.gi-rp-name{font-weight:700;color:#111827;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gi-rp-meta small{display:block;color:#8b94a7;font-size:.74rem;margin-top:2px;}
.gi-rp-st{font-weight:800;font-size:.72rem;white-space:nowrap;}
.gi-rp-st.go{color:#6366f1;} .gi-rp-st.run{color:#b45309;} .gi-rp-st.done{color:#047857;}
.gi-run{padding:26px 24px 24px;font-family:"Inter",system-ui,sans-serif;color:#111827;}
.gi-run-hero{display:flex;align-items:center;gap:14px;margin-bottom:18px;}
.gi-run-name{font-family:"Plus Jakarta Sans",sans-serif;font-size:1.3rem;font-weight:800;}
.gi-run-sub{color:#8b94a7;font-size:.8rem;margin-top:2px;}
.gi-run-barwrap{height:8px;border-radius:999px;background:#eef0f7;overflow:hidden;margin-bottom:18px;}
.gi-run-bar{height:100%;border-radius:999px;background:linear-gradient(90deg,#6366f1,#7c3aed 55%,#ec4899);transition:width .5s cubic-bezier(.4,0,.2,1);}
.gi-run-steps{display:flex;flex-direction:column;gap:11px;}
.gi-run-step{display:flex;align-items:center;gap:11px;font-size:.92rem;color:#8b94a7;transition:color .2s;}
.gi-run-step.done{color:#111827;} .gi-run-step.active{color:#4338ca;font-weight:700;}
.gi-run-dot{width:22px;height:22px;border-radius:50%;flex:none;display:grid;place-items:center;font-size:.72rem;font-weight:800;color:#fff;background:#dfe3ee;}
.gi-run-step.done .gi-run-dot{background:#10b981;}
.gi-run-step.active .gi-run-dot{background:#6366f1;}
.gi-run-foot{margin-top:18px;color:#56617a;font-size:.84rem;background:#f6f7fb;border-radius:11px;padding:11px 14px;line-height:1.5;}
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
const clampPct = (n) => Math.max(0, Math.min(100, Number(n) || 0));

// A deterministic, colourful gradient mark per company — adds a visual anchor to each row.
const GI_AV = [['#6366f1', '#4338ca'], ['#8b5cf6', '#6d28d9'], ['#ec4899', '#be185d'], ['#0ea5e9', '#1d4ed8'],
  ['#14b8a6', '#0f766e'], ['#f59e0b', '#c2410c'], ['#f43f5e', '#be123c'], ['#a855f7', '#7c3aed']];
function avatar(name) {
  const s = String(name || '').replace(/\b(ltd|limited|inc|corporation|co|the)\b/gi, ' ').trim();
  const w = s.split(/\s+/).filter(Boolean);
  const ini = ((w[0]?.[0] || '') + (w[1]?.[0] || w[0]?.[1] || '')).toUpperCase() || '•';
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [a, b] = GI_AV[h % GI_AV.length];
  return { ini, bg: `linear-gradient(135deg,${a},${b})` };
}
function meters(q, p) {
  return `<div class="gi-meters">
    <div class="gi-meter"><span class="ml">Quality</span><span class="mv">${esc(String(q))}</span><span class="mbar"><i class="q" style="width:${clampPct(q)}%"></i></span></div>
    <div class="gi-meter"><span class="ml">Value</span><span class="mv">${esc(String(p))}</span><span class="mbar"><i class="p" style="width:${clampPct(p)}%"></i></span></div>
  </div>`;
}

function tableRows() {
  const held = new Map((coverage.holdings() || []).map((h) => [h.ticker, h]));
  const out = [];
  const seen = new Set();
  for (const g of RESEARCHED_SECTORS) {
    for (const t of g.tickers) {
      const h = held.get(t);
      if (!h) continue; // only the family's real holdings
      const insight = getInsight(t);
      const rec = runs.get(t);
      const done = rec?.done === true;
      const running = !!rec && !rec.done;
      if (!insight && !done && !running) continue; // show authored + anything that's been run
      out.push({ ticker: t, name: h.name, sector: g.sector, insight, firstCut: !insight && done, running });
      seen.add(t);
    }
  }
  // Any company a reader has RUN that isn't in the researched map above — it must still appear in
  // the table, or a run would vanish the moment its one-pager is closed. Name/sector come from the
  // run record, then the holdings book.
  for (const rec of runs.values()) {
    if (seen.has(rec.ticker) || getInsight(rec.ticker)) continue;
    const h = held.get(rec.ticker);
    out.push({
      ticker: rec.ticker,
      name: rec.name || h?.name || rec.ticker,
      sector: rec.sector || h?.sector || '',
      insight: null,
      firstCut: rec.done === true,
      running: !rec.done,
    });
    seen.add(rec.ticker);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/* ---------------- "Run a company" — background run + progress screen ---------------- */
const RUN_STEPS = [
  'Reading the dashboard',
  'Checking recent alerts',
  'Reading the sector KPIs',
  'Writing the one-pager',
];
const RUN_STEP_MS = 1600;
// ticker -> { ticker, name, sector, step, done, failed, opened, timer, built }
// `built` is the FULLY assembled one-pager content (AI view + live alerts + sector KPIs). A run is
// only marked `done` once `built` is ready, so opening it never shows a half-written page.
const runs = new Map();
const runSubs = new Set();
function onRunChange(fn) { runSubs.add(fn); return () => runSubs.delete(fn); }
function emitRuns() { for (const fn of [...runSubs]) { try { fn(); } catch { /* keep going */ } } }
function isRunning(t) { const r = runs.get(t); return !!r && !r.done; }
function isRun(t) { return !!getInsight(t) || runs.get(t)?.done === true; }
function activeRuns() { return [...runs.values()].filter((r) => !r.done); }
function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

// Resolve `promise`, or `fallback` if it rejects or doesn't settle within `ms` — so a slow or failed
// build step degrades to a safe value instead of hanging the run.
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => done(fallback), ms);
    Promise.resolve(promise).then(done, () => done(fallback));
  });
}

// A run is a module-level job: it keeps going after the reader switches tabs, and announces itself
// in the header bell when it finishes. It does the REAL build in the background — the live alert
// read, the sector KPIs and the one AI write — and is only marked `done` once all of that is
// assembled into `rec.built`. So the page a reader opens is always complete, never half-written.
// The step bar is visual pacing that holds on the last step until the real work lands.
async function startRun(ticker, name, sector) {
  if (runs.has(ticker)) { openRunProgress(ticker); return; } // already running or done — just show it
  const rec = { ticker, name, sector, step: 0, done: false, failed: false, opened: false, built: null };
  runs.set(ticker, rec);
  emitRuns();
  openRunProgress(ticker);

  // Visual pacing: advance through the steps but HOLD on the last one (spinner) until the real
  // work below settles — the last step genuinely is "writing", and it is honest to wait on it.
  const tick = () => {
    if (rec.done) return;
    if (rec.step < RUN_STEPS.length - 1) { rec.step += 1; emitRuns(); rec.timer = setTimeout(tick, RUN_STEP_MS); }
  };
  rec.timer = setTimeout(tick, RUN_STEP_MS);

  // The real build. Every piece runs in parallel and is bounded by a timeout + a safe fallback, so
  // one slow or failed step can never hang the run or leave a half page. The AI "Our view" is the one
  // metered step (cached per ticker, so a re-run in the same session never re-spends); the sector
  // scorecard and the recent-alerts read are free. A step that doesn't land in time degrades to an
  // honest "couldn't read just now" state — never a spinner the reader is left staring at.
  try {
    const live = await import('../data/ai-insights-live.js');
    const cached = aiIdeaData.get(ticker) || null;
    const [prof, cardRes, ideaRes] = await Promise.all([
      withTimeout(live.sectorProfileFor(ticker), 10000, null),
      withTimeout(live.cardFor(ticker, () => true), 75000, { status: 'cold', card: null }),
      cached ? Promise.resolve(cached)
        : withTimeout(live.writeIdea({ ticker, name, isCurrent: () => true }), 75000, { status: 'error' }),
    ]);
    if (ideaRes?.status === 'ok' && !cached) aiIdeaData.set(ticker, ideaRes);
    rec.built = {
      aiStatus: ideaRes?.status || 'error',
      idea: ideaRes?.status === 'ok' ? parseIdea(ideaRes.text) : null,
      rawText: ideaRes?.status === 'ok' ? ideaRes.text : null,
      live: { status: cardRes?.status || 'cold', data: cardRes?.card ? live.updatesFromCard(cardRes.card) : null },
      sectorProfile: prof,
    };
    if (!rec.sector && prof?.groupLabel) rec.sector = prof.groupLabel;
  } catch {
    rec.built = { aiStatus: 'error', idea: null, rawText: null, live: { status: 'cold', data: null }, sectorProfile: null };
  }

  if (rec.timer) clearTimeout(rec.timer);
  rec.step = RUN_STEPS.length;
  rec.done = true;
  emitRuns();
  try {
    pushNote({ key: `ai-run:${ticker}`, kind: 'research',
      title: `One-pager ready — ${name}`, detail: 'Your AI Insights one-pager is ready to open.' });
  } catch { /* notifications are optional */ }
}

// Watchlist follows the list chosen on the header's Watchlist menu (Bookmarked or Previously owned).
const RUN_SCOPES = [['portfolio', 'Current portfolio'], ['watchlist', 'Watchlist'], ['universe', 'Universe']];

// The companies the Run picker offers, for one scope. Portfolio = the family's holdings; Watchlist =
// the shared watchlist; Universe = the wider screener universe. Sector is filled from the researched
// map, then the matching holding/universe row, so every row shows one. De-duped by ticker, by name.
function runScopeCompanies(scope) {
  const sectorOf = new Map();
  for (const g of RESEARCHED_SECTORS) for (const t of g.tickers) sectorOf.set(t, g.sector);
  const uni = ctxRef?.data?.universe || [];
  const uniMap = new Map(uni.map((u) => [u.ticker, u]));
  const holdMap = new Map((coverage.holdings() || []).map((h) => [h.ticker, h]));
  const sec = (t, fallback) => sectorOf.get(t) || fallback || '';
  let rows = [];
  if (scope === 'watchlist') {
    rows = (watchScopeCompanies() || []).filter((w) => w.ticker).map((w) => ({
      ticker: w.ticker,
      name: w.name || holdMap.get(w.ticker)?.name || uniMap.get(w.ticker)?.name || w.ticker,
      sector: sec(w.ticker, holdMap.get(w.ticker)?.sector || uniMap.get(w.ticker)?.sector),
    }));
  } else if (scope === 'universe') {
    rows = uni.map((u) => ({ ticker: u.ticker, name: u.name || u.ticker, sector: sec(u.ticker, u.sector) }));
  } else {
    rows = (coverage.holdings() || []).map((h) => ({ ticker: h.ticker, name: h.name, sector: sec(h.ticker, h.sector) }));
  }
  const seen = new Set();
  return rows.filter((r) => r.ticker && !seen.has(r.ticker) && seen.add(r.ticker))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function pickerRowsHtml(scope) {
  const list = runScopeCompanies(scope);
  if (!list.length) {
    const msg = scope === 'watchlist' ? isPreviousScope(scope) ? 'No previously owned company carries an NSE symbol yet.' : 'No companies on the watchlist yet — star some from any table.'
      : scope === 'universe' ? 'The universe list is still loading — try again in a moment.'
        : 'No holdings found.';
    return `<div class="gi-rp-empty">${msg}</div>`;
  }
  return list.map((c) => {
    const av = avatar(c.name);
    const st = isRunning(c.ticker) ? '<span class="gi-rp-st run">Running…</span>'
      : isRun(c.ticker) ? '<span class="gi-rp-st done">Ready ↗</span>'
        : '<span class="gi-rp-st go">Run ▶</span>';
    return `<button type="button" class="gi-rp-row" data-run="${esc(c.ticker)}" data-name="${esc(c.name)}" data-sector="${esc(c.sector)}">
      <span class="gi-av sm" style="background:${av.bg}">${av.ini}</span>
      <span class="gi-rp-meta"><span class="gi-rp-name">${esc(c.name)}</span><small>${esc(c.ticker)}${c.sector ? ` · ${esc(c.sector)}` : ''}</small></span>
      ${st}
    </button>`;
  }).join('');
}

function openRunPicker() {
  const scopeTabs = RUN_SCOPES.map(([s, label]) =>
    `<button type="button" data-scope="${s}" class="${s === runScope ? 'on' : ''}">${label} <b>${runScopeCompanies(s).length}</b></button>`).join('');
  openModal(`<div class="gi-picker">
    <div class="gi-picker-h"><h3>Run a company</h3><p>Pick a company to build its one-pager — from your portfolio, your watchlist, or the wider universe. It runs in the background while you keep working.</p></div>
    <div class="gi-rp-scope" data-run-scope>${scopeTabs}</div>
    <input type="search" class="gi-picker-search" placeholder="Search companies…" data-run-search aria-label="Search companies">
    <div class="gi-picker-list" data-run-list>${pickerRowsHtml(runScope)}</div>
  </div>`, { size: 'default' });
  const root = document.getElementById('modal-content');
  const search = root?.querySelector('[data-run-search]');
  const listEl = root?.querySelector('[data-run-list]');
  const applyFilter = () => {
    const q = (search?.value || '').trim().toLowerCase();
    for (const row of listEl.querySelectorAll('.gi-rp-row')) {
      const hay = `${row.dataset.name} ${row.dataset.run} ${row.dataset.sector}`.toLowerCase();
      row.style.display = hay.includes(q) ? '' : 'none';
    }
  };
  root?.querySelector('[data-run-scope]')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-scope]');
    if (!btn || btn.dataset.scope === runScope) return;
    runScope = btn.dataset.scope;
    for (const b of root.querySelectorAll('[data-run-scope] [data-scope]')) b.classList.toggle('on', b.dataset.scope === runScope);
    listEl.innerHTML = pickerRowsHtml(runScope);
    applyFilter();
  });
  search?.addEventListener('input', applyFilter);
  listEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-run]');
    if (!btn) return;
    const t = btn.dataset.run;
    if (isRun(t) && !isRunning(t)) openCompany(t);
    else startRun(t, btn.dataset.name, btn.dataset.sector);
  });
  setTimeout(() => search?.focus(), 40);
}

// EVENT → WHO BENEFITS. The reviewed theme-exposure map, as a reader-facing lookup: for each theme,
// the companies an event in that market bears on, each with the source that states the link. Every
// row is reviewed, cited data (never inferred) — the same map that drives the indirect alerts.
const THEME_ACCENTS = ['#6d28d9', '#b45309', '#0e7490', '#be123c', '#047857', '#4f46e5'];
function openThemes() {
  const cat = themeCatalog();
  const themesHtml = cat.map((t, ti) => {
    const accent = THEME_ACCENTS[ti % THEME_ACCENTS.length];
    const rows = t.companies.map((c) => {
      const av = avatar(c.name);
      const src = c.source
        ? `<a class="gi-theme-src" href="${esc(c.source.url)}" target="_blank" rel="noopener noreferrer">${esc(c.source.publisher)} ↗</a>`
        : '';
      return `<div class="gi-theme-row">
        <span class="gi-av sm" style="background:${av.bg}">${av.ini}</span>
        <span class="gi-theme-co"><span class="gi-theme-nm" title="${esc(c.name)}">${esc(c.name)}</span><small title="${esc(c.role)}">${esc(c.ticker)} · ${esc(c.role)}</small></span>
        ${src}
      </div>`;
    }).join('');
    return `<section class="gi-theme" style="--accent:${accent}">
      <div class="gi-theme-h"><span class="gi-theme-ic"></span>${esc(t.label)} <span class="gi-theme-n">${t.companies.length}</span></div>
      <div class="gi-theme-rows">${rows}</div>
    </section>`;
  }).join('');
  openModal(`<div class="gi-themes">
    <div class="gi-picker-h"><h3>Themes — who benefits</h3><p>When an event hits a market, these are the companies it touches — each with the source that states the link. Reviewed and cited, never guessed. Not investment advice.</p></div>
    ${themesHtml || '<div class="gi-rp-empty">No themes mapped yet.</div>'}
  </div>`, { size: 'wide' });
}

// A small "exposed to <theme>" line for a company's one-pager, when it is mapped to a reviewed theme.
function themeChipHtml(ticker) {
  const themes = themesForCompany(ticker);
  if (!themes.length) return '';
  const names = themes.map((t) => esc(t.short || t.label)).join(', ');
  return `<div class="gi-theme-chip">💡 Exposed to <b>${names}</b> — ${esc(themes[0].role)}</div>`;
}

function openRunProgress(ticker) {
  const rec = runs.get(ticker);
  if (!rec) return;
  openModal(runProgressHtml(rec), { size: 'default', onClose: () => { offProg?.(); offProg = null; } });
  offProg?.();
  offProg = onRunChange(() => paintRunProgress(ticker));
  paintRunProgress(ticker);
}

function runProgressHtml(rec) {
  const av = avatar(rec.name);
  return `<div class="gi-run" data-run-progress="${esc(rec.ticker)}">
    <div class="gi-run-hero">
      <span class="gi-av lg" style="background:${av.bg}">${av.ini}</span>
      <div><div class="gi-run-name">${esc(rec.name)}</div><div class="gi-run-sub">${esc(rec.ticker)}${rec.sector ? ` · ${esc(rec.sector)}` : ''}</div></div>
    </div>
    <div class="gi-run-barwrap"><div class="gi-run-bar" data-run-bar style="width:0%"></div></div>
    <div class="gi-run-steps" data-run-steps></div>
    <div class="gi-run-foot" data-run-foot>Building your one-pager — you can switch tabs and keep working. We'll tell you the moment it's ready.</div>
  </div>`;
}

function paintRunProgress(ticker) {
  const rec = runs.get(ticker);
  const host = document.querySelector(`[data-run-progress="${cssEsc(ticker)}"]`);
  if (!rec || !host) return;
  const bar = host.querySelector('[data-run-bar]');
  const steps = host.querySelector('[data-run-steps]');
  const foot = host.querySelector('[data-run-foot]');
  const pct = Math.round((Math.min(rec.step, RUN_STEPS.length) / RUN_STEPS.length) * 100);
  if (bar) bar.style.width = `${rec.done ? 100 : pct}%`;
  if (steps) steps.innerHTML = RUN_STEPS.map((s, i) => {
    const state = rec.done || i < rec.step ? 'done' : i === rec.step ? 'active' : 'wait';
    const mark = state === 'done' ? '✓' : state === 'active' ? '<span class="gi-spin"></span>' : '';
    return `<div class="gi-run-step ${state}"><span class="gi-run-dot">${mark}</span>${esc(s)}</div>`;
  }).join('');
  if (rec.done && !rec.opened) {
    rec.opened = true;
    if (foot) foot.textContent = 'Ready — opening your one-pager…';
    offProg?.(); offProg = null;
    setTimeout(() => {
      const still = document.getElementById('modal-content');
      if (still && still.querySelector(`[data-run-progress="${cssEsc(ticker)}"]`)) openCompany(ticker);
    }, 800);
  }
}

function paintRunChips(ctx) {
  const host = ctx.root.querySelector('[data-gi-runs]');
  if (!host) return;
  host.innerHTML = activeRuns().map((r) => {
    const pct = Math.round((r.step / RUN_STEPS.length) * 100);
    return `<button type="button" class="gi-runchip" data-run-open="${esc(r.ticker)}"><span class="gi-spin"></span> Running ${esc(r.name)}… <b>${pct}%</b></button>`;
  }).join('');
}

function firstCutHtml(ticker) {
  const rec = runs.get(ticker) || {};
  const held = (coverage.holdings() || []).find((h) => h.ticker === ticker);
  const name = held?.name || rec.name || ticker;
  const sector = rec.sector || '';
  const m = market(ticker);
  const price = m.cmp != null ? `${rupee(m.cmp)}${m.chg == null ? '' : ` · ${signed(m.chg)} today`}` : '—';
  return `<div class="gi-pager">
    <div class="gi-hero">
      <div class="gi-kick"><span class="gi-dot"></span> Glow AI Insights <span class="thin">The 5-minute stock read</span></div>
      <div class="gi-co2"><h1>${esc(name)}</h1><span class="gi-tk">${esc(ticker)} · NSE</span></div>
      <div class="gi-lead">First cut ready. The full read — what we like, what we don't, the verdict and the numbers — is being written from ${esc(name)}'s own data and its sector KPIs, and will land here shortly.</div>
    </div>
    <div class="gi-facts"><span>Sector <b>${esc(sector)}</b></span><span class="live">CMP ${esc(price)} · live</span></div>
    <div class="in">
      <h2 class="gi-sh">What happens next</h2>
      <p class="gi-prose">We read ${esc(name)}'s latest results and earnings calls, score its business quality and value against its sector's key numbers, and write the one-pager the same way as the live examples. You'll get a notification the moment the full write-up is ready.</p>
    </div>
  </div>`;
}

/* ---------------- render ---------------- */
export function render(ctx) {
  destroy();
  ctxRef = ctx;
  ensureStyles();

  const rows = tableRows();

  ctx.root.innerHTML = `
    <div class="gi-tab">
      <div class="gi-head">
        <h2>AI Insights</h2>
        <div class="gi-head-actions">
          <button class="gi-themes-btn" type="button" data-gi-themes>💡 Themes · who benefits</button>
          <button class="gi-run-btn" type="button" data-gi-run>▶ Run a company</button>
        </div>
      </div>
      <div class="gi-runchips" data-gi-runs></div>
      <div class="gi-card">
        <table class="gi-table">
          <thead><tr>
            <th class="c-co">Company</th>
            <th class="c-px num hide-sm">Price</th>
            <th class="c-tk">Key takeaways</th>
            <th class="c-sc hide-sm">Scores</th>
            <th class="c-mo"></th>
          </tr></thead>
          <tbody data-gi-body>${rows.map(rowHtml).join('')}</tbody>
        </table>
      </div>
    </div>`;

  const body = ctx.root.querySelector('[data-gi-body]');
  const openFromEvent = (e) => {
    const row = e.target.closest('[data-open]');
    if (!row) return;
    e.preventDefault();
    openCompany(row.dataset.open);
  };
  body.addEventListener('click', openFromEvent);
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openFromEvent(e); });

  ctx.root.querySelector('[data-gi-run]').addEventListener('click', openRunPicker);
  ctx.root.querySelector('[data-gi-themes]')?.addEventListener('click', openThemes);
  ctx.root.querySelector('[data-gi-runs]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-run-open]');
    if (b) openRunProgress(b.dataset.runOpen);
  });
  const repaintRuns = () => {
    if (ctxRef !== ctx) return;
    const b = ctx.root.querySelector('[data-gi-body]');
    if (b) b.innerHTML = tableRows().map(rowHtml).join('');
    paintRunChips(ctx);
  };
  offRuns = onRunChange(repaintRuns);
  paintRunChips(ctx);

  // Start the recent-alerts read NOW, in the background, so the "What's changed" box on a one-pager
  // is warm (often instant) by the time the reader opens one — the first read is a full collection
  // and is slow cold, and it used to run only when a page was opened, so it looked stuck on "reading".
  import('../data/ai-insights-live.js').then((l) => l.prewarm?.('portfolio')).catch(() => {});
  // Load the Screener fundamentals once so the "What it's worth" + "The fundamentals" sections are
  // ready (synchronous byTicker) by the time a one-pager opens. A missing file is not an error.
  fundamentals.load().then(() => { if (ctxRef === ctx) { const b = ctx.root.querySelector('[data-gi-body]'); if (b) b.innerHTML = tableRows().map(rowHtml).join(''); } }).catch(() => {});

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

  const av = avatar(r.name);

  let view, scores, chev;
  if (r.insight) {
    const d = r.insight;
    const cls = d.verdict.toLowerCase();
    const keys = (d.takeaways || []).slice(0, 3).map((k) => `<li>${esc(k)}</li>`).join('');
    view = `<span class="gi-pill ${cls}">${esc(d.verdict)}</span>`
      + (keys ? `<ul class="gi-keys">${keys}</ul>` : `<span class="gi-take">${esc(d.verdictSub)}</span>`);
    scores = meters(d.quality, d.price);
    chev = '<span class="gi-chev">More →</span>';
  } else if (r.running) {
    view = '<span class="gi-pill firstcut"><span class="gi-spin"></span> Writing…</span><span class="gi-take">Building the one-pager — tap to watch</span>';
    scores = '<span class="gi-flat" style="font-size:.78rem">—</span>';
    chev = '<span class="gi-chev">View →</span>';
  } else if (r.firstCut) {
    view = '<span class="gi-pill done2">Ready</span><span class="gi-take">AI one-pager built — tap to open</span>';
    scores = '<span class="gi-flat" style="font-size:.78rem">—</span>';
    chev = '<span class="gi-chev">Open →</span>';
  } else {
    view = '<span class="gi-pill soon">Researching</span><span class="gi-take">Sector rulebook ready — one-pager rolling out</span>';
    scores = '<span class="gi-flat" style="font-size:.78rem">—</span>';
    chev = '<span class="gi-chev ghost">More →</span>';
  }

  return `<tr class="gi-row" data-open="${esc(r.ticker)}" role="button" tabindex="0" aria-label="Open ${esc(r.name)} one-pager">
    <td><div class="gi-cco"><span class="gi-av" style="background:${av.bg}">${av.ini}</span><span class="gi-cometa"><span class="gi-co">${esc(r.name)}</span><small>${esc(r.ticker)} · ${esc(r.sector)}</small></span></div></td>
    <td class="gi-cmp hide-sm">${priceCell}</td>
    <td>${view}</td>
    <td class="hide-sm">${scores}</td>
    <td><div class="gi-mo">${chev}</div></td>
  </tr>`;
}

/* ---------------- the one-pager ---------------- */
function openCompany(ticker) {
  if (isRunning(ticker)) return openRunProgress(ticker);
  const d = getInsight(ticker);
  if (d) { openModal(pagerHtml(d), { size: 'magazine' }); wirePdf(d); fillLive(d); return; }
  if (runs.get(ticker)?.done) return openAuto(ticker);
  return openModal(comingHtml(ticker), { size: 'default' });
}

// Wire the one-pager's header buttons: Download PDF, and Refresh report (re-pull the live read and
// re-paint with the latest price and alerts). Called on first open and after every re-render.
function wirePdf(d) {
  const host = document.getElementById('modal-content');
  host?.querySelector('[data-pdf]')?.addEventListener('click', () => downloadPdf(d));
  host?.querySelector('[data-refresh]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '↻ Refreshing…';
    refreshAuthored(d);
  });
}

// Refresh an authored one-pager: the written verdict / case / financials are Glow's own research and
// stand, so what updates is the live layer — the latest price and the "What's changed" alerts. Force
// a fresh alert read (drop the memo), re-paint to the reading state, then fill it in.
async function refreshAuthored(d) {
  try { const live = await import('../data/ai-insights-live.js'); live.invalidateReports?.(); } catch { /* fall through */ }
  liveData.delete(d.ticker);
  const host = document.getElementById('modal-content');
  if (host?.querySelector('.gi-pager')?.dataset.ticker === d.ticker) { host.innerHTML = pagerHtml(d); wirePdf(d); }
  fillLive(d);
}
function downloadPdf(d) {
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(d.name)} — Glow AI Insights</title>
<style>${CSS}
  *{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;}
  html,body{margin:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .gi-pager{max-height:none;overflow:visible;}
  .gi-pdf,.gi-refresh{display:none;}
  .gi-hero,.gi-col.like,.gi-col.dislike,.gi-colhd{break-inside:avoid;}
  @page{margin:11mm;}
</style></head><body>${pagerHtml(d)}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => { try { win.print(); } catch { /* reader can print manually */ } }, 400);
}

function pagerHtml(d) {
  const like = d.like.map((p, i) => ptHtml(p, i)).join('');
  const dislike = d.dislike.map((p, i) => ptHtml(p, i)).join('');
  const fcols = d.financials.cols.map((c) => `<th>${esc(c)}</th>`).join('');
  const frows = d.financials.rows.map((row) => `<tr><td>${esc(row.k)}</td>${row.v
    .map((v, i) => `<td class="${row.pos && row.pos[i] ? 'pos' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('');
  const vcls = d.verdict.toLowerCase();
  const live = liveData.get(d.ticker);
  const qd = live?.data?.qualityDelta || 0;
  const qAdj = Math.max(0, Math.min(100, d.quality + qd));
  const qChip = qd ? ` <span class="gi-livedelta ${qd > 0 ? 'up' : 'down'}" title="Auto-adjusted from recent AI Alerts; the written score is ${d.quality}.">${qd > 0 ? '▲ +' : '▼ '}${qd} live</span>` : '';

  return `<div class="gi-pager" data-ticker="${esc(d.ticker)}">
    <div class="gi-hero">
      <div class="gi-kick"><span class="gi-dot"></span> Glow AI Insights <span class="thin">The 5-minute stock read</span>
        <button class="gi-refresh" type="button" data-refresh="${esc(d.ticker)}">↻ Refresh report</button>
        <button class="gi-pdf" type="button" data-pdf>⬇ Download PDF</button></div>
      <div class="gi-co2"><h1>${esc(d.name)}</h1><span class="gi-tk">${esc(d.ticker)} · NSE</span></div>
    </div>
    <div class="in">
      <h2 class="gi-sh" style="margin-top:4px">Our view</h2>
      <div class="gi-verdict">
        <div class="gi-call"><span class="gi-badge ${vcls}">${esc(d.verdict)}</span><small>${esc(d.verdictSub)}</small></div>
        <div class="gi-scorebox">
          <div class="gi-score"><div class="row"><span class="lab">Business quality <span>— how good is the company?</span></span><span class="num">${d.quality} / 100${qChip}</span></div><div class="gi-track"><div class="gi-fill q" style="width:${qAdj}%"></div></div></div>
          <div class="gi-score"><div class="row"><span class="lab">Price / value <span>— cheap or expensive today?</span></span><span class="num">${d.price} / 100</span></div><div class="gi-track"><div class="gi-fill p" style="width:${d.price}%"></div></div></div>
        </div>
        <div class="gi-why">${d.why}<span class="gi-trig">↗ ${d.trigger}</span></div>
      </div>

      ${themeChipHtml(d.ticker)}
      ${liveSectionHtml(d, live)}

      ${d.intrinsic ? ivHtml(d) : ''}
      ${d.kpis ? kpisHtml(d) : ''}

      <h2 class="gi-sh">The case — for and against</h2>
      <div class="gi-cols">
        <div class="gi-col like"><div class="gi-colhd"><span class="gi-mk">✓</span> What we like</div><div class="gi-colbody">${like}</div></div>
        <div class="gi-col dislike"><div class="gi-colhd"><span class="gi-mk">✕</span> What we don't like</div><div class="gi-colbody">${dislike}</div></div>
      </div>

      ${d.concalls ? concallHtml(d) : ''}

      ${fundamentals.byTicker(d.ticker) ? fundamentalsHtml(d.ticker) : `
      <h2 class="gi-sh">Financials at a glance</h2>
      <div class="gi-wrapcard">
        <table class="gi-ftable"><thead><tr><th>₹ crore</th>${fcols}</tr></thead><tbody>${frows}</tbody></table>
      </div>`}

      <div class="gi-close"><span class="q"></span><span>${d.close}</span></div>
    </div>
  </div>`;
}

// Intrinsic value vs the live price — the one thing the desk said was missing.
function ivHtml(d) {
  const iv = d.intrinsic;
  const m = market(d.ticker);
  const now = m.cmp != null ? rupee(m.cmp) : (iv.price || '—');
  const v = d.valuation;
  return `<h2 class="gi-sh">What it's worth vs where it trades</h2>
    <div class="gi-iv">
      <div class="gi-iv-nums">
        <div class="gi-iv-box"><span>Our fair value</span><b>${esc(iv.low)} – ${esc(iv.high)}</b><small>${esc(iv.basis)}</small></div>
        <div class="gi-iv-box live"><span>Trading now</span><b>${esc(now)}</b><small>live price</small></div>
      </div>
      <div class="gi-iv-read ${esc(iv.tone || 'watch')}">${esc(iv.read)}</div>
      ${v ? `<div class="gi-iv-metric">${esc(v.metric)}: <b>${esc(v.now)}</b> vs ${esc(v.fair)} fair${v.extra ? ` · ${esc(v.extra)}` : ''}</div>` : ''}
    </div>`;
}

// The sector's own KPIs, shown on the page (the back-end ontology, surfaced).
function kpisHtml(d) {
  const items = d.kpis.map((x) => `<div class="gi-kpi ${esc(x.tone || '')}"><span>${esc(x.k)}</span><b>${esc(x.v)}</b></div>`).join('');
  return `<h2 class="gi-sh">The numbers that matter in ${esc(d.ourSector)}</h2>
    <div class="gi-kpis">${items}</div>`;
}

/* ---- Deep fundamentals (Screener, reproduced) + a fair-value band (ours) ---- */

// A ₹-crore figure: large caps as "₹2.98 L Cr", smaller as "₹1,234 Cr".
function crVal(n) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 100000) return `₹${(n / 100000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} L Cr`;
  return `₹${Math.round(n).toLocaleString('en-IN')} Cr`;
}
const pctTxt = (n) => (Number.isFinite(n) ? `${n}%` : '—');

// The fair-value band for ANY captured company — OUR rule of thumb (js/data/fair-value.js), labelled
// "Glow estimate", built on Screener's EPS + growth + quality. An honest refusal for a loss-making
// company rather than a made-up number. Authored pages keep their hand-written intrinsic value instead.
function fairValueBandHtml(ticker) {
  const f = fundamentals.byTicker(ticker);
  if (!f) return '';
  const m = market(ticker);
  const fv = fundamentals.fairValueFor(ticker, { cmp: m.cmp });
  if (!fv) return '';
  if (!fv.meaningful) {
    return `<h2 class="gi-sh">What it's worth vs where it trades</h2>
      <div class="gi-iv"><div class="gi-iv-read watch">${esc(fv.reason)}</div></div>`;
  }
  const now = m.cmp != null ? rupee(m.cmp) : (Number.isFinite(fv.price) ? rupee(fv.price) : '—');
  const up = Number.isFinite(fv.upside) ? Math.round(fv.upside * 100) : null;
  const readTone = fv.tone === 'cheap' ? 'good' : fv.tone === 'rich' ? 'bad' : 'watch';
  const read = up == null ? 'No live price to compare against right now.'
    : fv.tone === 'cheap' ? `Trading about ${Math.abs(up)}% below our fair-value band — looks cheap on these numbers.`
      : fv.tone === 'rich' ? `Trading about ${Math.abs(up)}% above our fair-value band — looks rich on these numbers.`
        : `Trading roughly in line with our fair-value band${up ? ` (${up > 0 ? '+' : ''}${up}% to the middle)` : ''}.`;
  const peLine = Number.isFinite(fv.currentPe)
    ? `Priced at <b>${fv.currentPe}×</b> earnings vs a fair <b>~${fv.fairPe.toFixed(0)}×</b>${fv.limited ? ' · based on a thin growth record' : ''}`
    : '';
  return `<h2 class="gi-sh">What it's worth vs where it trades <span class="gi-ai-tag">Glow estimate</span></h2>
    <div class="gi-iv">
      <div class="gi-iv-nums">
        <div class="gi-iv-box"><span>Our fair value</span><b>${rupee(fv.fairLow)} – ${rupee(fv.fairHigh)}</b><small>${esc(fv.basis)}</small></div>
        <div class="gi-iv-box live"><span>Trading now</span><b>${esc(now)}</b><small>live price</small></div>
      </div>
      <div class="gi-iv-read ${readTone}">${esc(read)}</div>
      ${peLine ? `<div class="gi-iv-metric">${peLine}</div>` : ''}
    </div>`;
}

// The multi-year fundamentals, reproduced from Screener and labelled as theirs: headline ratios,
// compounded growth, a compact annual table (Sales / Net profit / OPM / EPS), and Screener's pros/cons.
function fundamentalsHtml(ticker) {
  const f = fundamentals.byTicker(ticker);
  if (!f) return '';
  const r = f.ratios || {};
  const chip = (label, val) => (val == null || val === '—') ? '' : `<div class="gi-fchip"><span>${esc(label)}</span><b>${esc(val)}</b></div>`;
  const ratios = [
    chip('Market cap', r.marketCap != null ? crVal(r.marketCap) : null),
    chip('P/E', Number.isFinite(r.pe) ? `${r.pe}×` : null),
    chip('ROE', Number.isFinite(r.roe) ? `${r.roe}%` : null),
    chip('ROCE', Number.isFinite(r.roce) ? `${r.roce}%` : null),
    chip('Debt / equity', Number.isFinite(r.debtToEquity) ? `${r.debtToEquity}` : null),
    chip('Div yield', Number.isFinite(r.divYield) ? `${r.divYield}%` : null),
    chip('Book value', Number.isFinite(r.bookValue) ? rupee(r.bookValue) : null),
  ].filter(Boolean).join('');

  const g = f.growth || {};
  const grow = (lbl, obj) => obj ? `<div class="gi-fgrow"><span>${lbl}</span> <b>${pctTxt(obj.y3)}</b> 3y · <b>${pctTxt(obj.y5)}</b> 5y · <b>${pctTxt(obj.y10)}</b> 10y</div>` : '';
  const growth = [grow('Sales growth', g.sales), grow('Profit growth', g.profit)].filter(Boolean).join('');

  const a = f.annual || {};
  const yrs = a.years || [];
  const n = yrs.length;
  const take = Math.max(0, n - 6);
  const cell = (arr, idx, kind) => {
    const v = (arr || [])[idx];
    if (!Number.isFinite(v)) return '—';
    if (kind === 'cr') return v.toLocaleString('en-IN');
    if (kind === '%') return `${v}%`;
    return v;
  };
  let table = '';
  if (n) {
    const cols = yrs.slice(take);
    const head = cols.map((y) => `<th>${esc(y.replace('Mar ', "FY'").replace("FY'20", "FY'").replace('TTM', 'TTM'))}</th>`).join('');
    const rowFor = (label, arr, kind) => `<tr><td>${esc(label)}</td>${cols.map((_, j) => `<td>${cell(arr, take + j, kind)}</td>`).join('')}</tr>`;
    table = `<div class="gi-wrapcard"><table class="gi-ftable"><thead><tr><th>₹ cr / %</th>${head}</tr></thead><tbody>
      ${rowFor('Sales', a.sales, 'cr')}
      ${rowFor('Net profit', a.netProfit, 'cr')}
      ${rowFor('OPM', a.opm, '%')}
      ${rowFor('EPS (₹)', a.eps, '')}
    </tbody></table></div>`;
  }

  const li = (xs) => xs.slice(0, 4).map((p) => `<li>${esc(p)}</li>`).join('');
  const pros = (f.pros || []).length ? `<div class="gi-fpc-col pros"><div class="gi-fpc-h">✓ Screener sees in favour</div><ul>${li(f.pros)}</ul></div>` : '';
  const cons = (f.cons || []).length ? `<div class="gi-fpc-col cons"><div class="gi-fpc-h">✕ Screener flags</div><ul>${li(f.cons)}</ul></div>` : '';
  const proscons = (pros || cons) ? `<div class="gi-fpc">${pros}${cons}</div>` : '';

  return `<h2 class="gi-sh">The fundamentals <span class="gi-src-tag">Source: Screener · ${esc(f.basis || '')}</span></h2>
    <div class="gi-fratios">${ratios}</div>
    ${growth ? `<div class="gi-fgrows">${growth}</div>` : ''}
    ${table}
    ${proscons}`;
}

// AUTO-UPDATE — fill the one-pager's "What's changed" box from the AI Alerts the dashboard already
// holds. The alerts engine is imported lazily, only when a one-pager opens (never on the tab), so it
// stays on-click and the tab stays lean. Zero credits. A slow lookup for one company can't paint
// into another's: `liveToken` is renewed per open, and the result is stored by ticker so the PDF
// (which re-renders pagerHtml) carries the same resolved box the screen shows.
async function fillLive(d) {
  const token = (liveToken = {});
  try {
    const live = await import('../data/ai-insights-live.js');
    // Bounded: if the alert read can't land in time, show the honest "couldn't read" state rather
    // than leaving the box stuck on "Reading…" forever.
    const res = await withTimeout(live.cardFor(d.ticker, () => token === liveToken), 150000, { status: 'cold', card: null });
    liveData.set(d.ticker, { status: res.status, data: res.card ? live.updatesFromCard(res.card) : null });
  } catch {
    liveData.set(d.ticker, { status: 'cold', data: null });
  }
  if (token !== liveToken) return;                          // a different company was opened meanwhile
  const host = document.getElementById('modal-content');
  const pager = host?.querySelector('.gi-pager');
  if (!pager || pager.dataset.ticker !== d.ticker) return;  // modal closed, or switched away
  host.innerHTML = pagerHtml(d);                            // one re-render, so screen and PDF match
  wirePdf(d);
}

const GI_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDay(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return esc(iso || '');
  const [, m, dd] = iso.slice(0, 10).split('-');
  return `${Number(dd)} ${GI_MONTHS[Number(m) - 1] || ''}`.trim();
}

// The "What's changed since we wrote this" box — AI Alerts that moved this company's sector KPIs,
// newest first, each with WHAT / WHY / HOW (good/watch/bad) / WHEN, and the 0-credits badge. Honest
// about the three states: checking, cold cache (not checked), and genuinely nothing in 14 days.
function liveSectionHtml(d, live) {
  const head = `<h2 class="gi-sh">What's changed since we wrote this</h2>
    <div class="gi-live-meta"><span class="gi-live-badge">⚡ Auto-updated from AI Alerts</span> last 14 days · <b>0 credits</b></div>`;
  if (!live) return `<div class="gi-live">${head}<div class="gi-live-wait"><span class="gi-spin"></span> Reading recent alerts… <span class="gi-live-hint">the first read can take up to a minute — the rest of the page is ready to use</span></div></div>`;
  if (live.status === 'cold') {
    return `<div class="gi-live">${head}<div class="gi-live-empty">Couldn't read recent alerts just now — this box will fill in automatically next time it can.</div></div>`;
  }
  const ups = live.data?.updates || [];
  if (!ups.length) {
    return `<div class="gi-live">${head}<div class="gi-live-empty">No alerts moved ${esc(d.name)}'s key numbers in the last 14 days — the view above stands.</div></div>`;
  }
  const SIDE = { positive: '👍 adds to What we like', negative: '👎 to What we don\'t like', neutral: '• one to watch' };
  const rows = ups.slice(0, 10).map((u) => `<div class="gi-upd ${esc(u.tone)}">
      <div class="gi-upd-top"><b>${esc(u.kpi)}${u.value ? ` ${esc(u.value)}` : ''}</b><span class="gi-upd-tag">${esc(u.trigger)}</span><span class="gi-upd-when">${fmtDay(u.when)}</span></div>
      <div class="gi-upd-what">${esc(u.what)}</div>
      <div class="gi-upd-why">${esc(u.why)}<span class="gi-upd-side">${SIDE[u.direction] || SIDE.neutral}</span></div>
    </div>`).join('');
  const extra = ups.length - 10;
  const more = extra > 0 ? `<div class="gi-live-more">+${extra} more recent alert${extra > 1 ? 's' : ''}</div>` : '';
  const qd = live.data?.qualityDelta || 0;
  const net = qd
    ? `<div class="gi-live-net">Net read: <b>${qd > 0 ? 'slightly stronger' : 'slightly softer'}</b> — Business quality auto-nudged ${qd > 0 ? '+' : ''}${qd} (written ${d.quality} → now ${Math.max(0, Math.min(100, d.quality + qd))}). The written view and every number above stay visible.</div>`
    : '';
  return `<div class="gi-live">${head}<div class="gi-upds">${rows}</div>${more}${net}</div>`;
}

// RUN ANY COMPANY — a real LIVE page, built free (0 credits) from the dashboard's own data: the
// company's recent developments (the auto-update box) and the numbers that matter for its sector
// (the KPI rulebook). It writes no analyst verdict — that is the team's hand-written layer — so it
// says so plainly rather than inventing one. The full written report for any company is the next
// layer (the GitHub + AI step, which needs the one-time token).
function openAuto(ticker) {
  const rec = runs.get(ticker);
  if (!rec || !rec.built) { openModal(comingHtml(ticker), { size: 'default' }); return; }
  // Pre-render the Markdown parts (the financials table, what-to-watch, or a prose fallback) to HTML
  // up front, so the page opens FULLY FORMED in one paint — a reader (or a client) never sees an
  // empty slot, a spinner, or a half-written report.
  Promise.all([
    mdToHtml(rec.built.idea?.tail || ''),
    rec.built.idea ? Promise.resolve('') : mdToHtml(rec.built.rawText || ''),
    fundamentals.load().catch(() => null),   // so "What it's worth" + "The fundamentals" are ready in the first paint
  ]).then(([tailHtml, proseHtml]) => {
    openModal(autoPagerHtml(rec, { tailHtml, proseHtml }), { size: 'magazine' });
    wireAutoPdf();
    wireRerun();
  });
}

// Render a KNOWN Markdown string to safe HTML up front (no streaming, no network — the AI text was
// already written during the run) using the shared research renderer, so the one-pager opens whole.
async function mdToHtml(md) {
  if (!md) return '';
  const div = document.createElement('div');
  try {
    const renderer = await import('../research/renderer.js');
    if (renderer?.renderResearchAnswer) renderer.renderResearchAnswer(div, md, { cite: null });
    else div.textContent = md;
  } catch { div.textContent = md; }
  return div.innerHTML;
}

function autoPagerHtml(rec, pre = {}) {
  const b = rec.built || {};
  const ticker = rec.ticker;
  const name = rec.name || ticker;
  const sectorLabel = b.sectorProfile?.groupLabel || rec.sector || '';
  const m = market(ticker);
  const price = m.cmp != null ? `${rupee(m.cmp)}${m.chg == null ? '' : ` · ${signed(m.chg)} today`}` : '—';

  // "Our view" — the AI verdict and the for/against columns, when the structured idea parsed cleanly.
  let viewBlock;
  if (b.idea) {
    const idea = b.idea;
    const vcls = (idea.verdict || 'watch').toLowerCase();
    const like = idea.like.length ? idea.like.map((p, i) => ptHtml(p, i)).join('') : '<div class="gi-emptycol">No clear positives in the data read.</div>';
    const dislike = idea.dislike.length ? idea.dislike.map((p, i) => ptHtml(p, i)).join('') : '<div class="gi-emptycol">No clear concerns in the data read.</div>';
    viewBlock = `
      <h2 class="gi-sh">Our view <span class="gi-ai-tag">✨ AI-written</span></h2>
      <div class="gi-ai-note">Written from Glow's own dashboard data — recent developments, filings and sector signals. Not investment advice.</div>
      ${idea.verdict ? `<div class="gi-verdict"><div class="gi-call"><span class="gi-badge ${vcls}">${esc(idea.verdict)}</span><small>${esc(idea.verdictWhy)}</small></div></div>` : ''}
      <h2 class="gi-sh">The case — for and against</h2>
      <div class="gi-cols">
        <div class="gi-col like"><div class="gi-colhd"><span class="gi-mk">✓</span> What we like</div><div class="gi-colbody">${like}</div></div>
        <div class="gi-col dislike"><div class="gi-colhd"><span class="gi-mk">✕</span> What we don't like</div><div class="gi-colbody">${dislike}</div></div>
      </div>`;
  } else if (b.aiStatus === 'ok' && b.rawText) {
    // The AI wrote a view but not in the expected shape — render the whole answer as prose. Complete,
    // just not split into columns; never half.
    viewBlock = `
      <h2 class="gi-sh">Our view <span class="gi-ai-tag">✨ AI-written</span></h2>
      <div class="gi-ai-note">Written from Glow's own dashboard data. Not investment advice.</div>
      <div class="gi-ai-body">${pre.proseHtml || ''}</div>`;
  } else {
    // The AI step was unavailable — say so plainly and offer a re-run. The live read and the sector
    // KPIs below still make this a complete page, not a broken one.
    viewBlock = `<div class="gi-ai-unavail">The written view couldn't be generated just now. Below is Glow's live read for ${esc(name)} — its recent developments and the numbers that matter for its sector. <button type="button" class="gi-rerun" data-rerun="${esc(ticker)}">Try again</button></div>`;
  }

  const tailBlock = pre.tailHtml ? `<div class="gi-ai-tail">${pre.tailHtml}</div>` : '';

  return `<div class="gi-pager" data-ticker="${esc(ticker)}" data-auto="1">
    <div class="gi-hero">
      <div class="gi-kick"><span class="gi-dot"></span> Glow AI Insights <span class="thin">The 5-minute stock read</span>
        <button class="gi-refresh" type="button" data-refresh-auto="${esc(ticker)}">↻ Refresh report</button>
        <button class="gi-pdf" type="button" data-pdf-auto>⬇ Download PDF</button></div>
      <div class="gi-co2"><h1>${esc(name)}</h1><span class="gi-tk">${esc(ticker)} · NSE</span></div>
    </div>
    <div class="in">
      <div class="gi-facts"><span>Sector <b>${esc(sectorLabel || '—')}</b></span><span class="live">CMP ${esc(price)} · live</span></div>
      ${themeChipHtml(ticker)}
      ${viewBlock}
      ${fairValueBandHtml(ticker)}
      ${fundamentalsHtml(ticker)}
      ${fundamentals.byTicker(ticker) ? '' : tailBlock}
      <div id="gi-auto-live">${liveSectionHtml({ ticker, name }, b.live)}</div>
      <div id="gi-auto-kpis">${autoKpisHtml({ ticker, name, ourSector: sectorLabel }, b.sectorProfile || { names: [] })}</div>
      <div class="gi-close"><span class="q"></span><span>A quick, data-grounded read built from Glow's own dashboard — not investment advice.</span></div>
    </div>
  </div>`;
}

function autoKpisHtml(d, sector) {
  const label = d.ourSector || sector?.groupLabel || 'this sector';
  if (sector === null) {
    return `<h2 class="gi-sh">The numbers that matter in ${esc(label)}</h2><div class="gi-live-wait">Loading the sector scorecard…</div>`;
  }
  if (!sector.names?.length) {
    return `<h2 class="gi-sh">The numbers that matter in ${esc(label)}</h2><div class="gi-live-empty">A sector scorecard isn't available for this company yet.</div>`;
  }
  const chips = sector.names.map((n) => `<div class="gi-kpi"><span>Key metric</span><b>${esc(n)}</b></div>`).join('');
  return `<h2 class="gi-sh">The numbers that matter in ${esc(label)}</h2>
    <p class="gi-prose" style="margin:-2px 0 9px;color:#56617a">These are the metrics ${esc(label)} companies are judged on — live values fill in from results and filings as they land.</p>
    <div class="gi-kpis">${chips}</div>`;
}

// Download the auto one-pager as a PDF — print the pager exactly as rendered (the AI view is already
// in the DOM), so nothing is regenerated and the file matches the screen.
function wireAutoPdf() {
  const host = document.getElementById('modal-content');
  host?.querySelector('[data-pdf-auto]')?.addEventListener('click', () => {
    const pager = host.querySelector('.gi-pager');
    if (!pager) return;
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Glow AI Insights</title>
<style>${CSS}
  *{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;}
  html,body{margin:0;background:#fff;}
  .gi-pager{max-height:none;overflow:visible;}
  .gi-pdf,.gi-rerun,.gi-refresh{display:none;}
  .gi-hero,.gi-col.like,.gi-col.dislike,.gi-colhd{break-inside:avoid;}
  @page{margin:11mm;}
</style></head><body>${pager.outerHTML}</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => { try { win.print(); } catch { /* reader can print manually */ } }, 400);
  });
}

// "Refresh report" and "Try again" on an auto page — both re-run the whole build from scratch
// (fresh alerts + a fresh AI write), showing the progress screen and reopening the complete page.
function wireRerun() {
  const host = document.getElementById('modal-content');
  const rerun = (t) => {
    const rec = runs.get(t);
    const name = rec?.name;
    const sector = rec?.sector;
    import('../data/ai-insights-live.js').then((l) => l.invalidateReports?.()).catch(() => {});
    runs.delete(t);
    aiIdeaData.delete(t);     // drop the cached AI view so the refresh writes a fresh one
    emitRuns();
    startRun(t, name || t, sector || '');
  };
  host?.querySelector('[data-rerun]')?.addEventListener('click', (e) => rerun(e.currentTarget.dataset.rerun));
  host?.querySelector('[data-refresh-auto]')?.addEventListener('click', (e) => rerun(e.currentTarget.dataset.refreshAuto));
}

// Parse the AI's structured idea Markdown into a verdict + for/against + a Markdown tail (financials
// and what-to-watch). Lenient: if the expected shape isn't found, returns null and the caller renders
// the whole answer as prose instead — so a differently-shaped answer is still shown in full.
function parseIdea(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let verdict = '';
  let verdictWhy = '';
  const vm = text.match(/(?:^|\n)\s*(?:\*\*)?\s*verdict\s*(?:\*\*)?\s*[:\-–—]\s*(?:\*\*)?\s*(buy|watch|avoid|hold|add|accumulate|reduce|sell|neutral)\b(?:\*\*)?\s*[-–—:]*\s*(.*)/i);
  if (vm) { verdict = vm[1].charAt(0).toUpperCase() + vm[1].slice(1).toLowerCase(); verdictWhy = cleanInline(vm[2]); }
  const secs = sectionSpans(text);
  const find = (re) => secs.find((s) => re.test(s.key));
  const likeSec = find(/what we like|the case for|in (its )?favou?r|positives/);
  const dislikeSec = find(/do ?n'?t like|do not like|concern|risk|the case against|negatives/);
  const like = likeSec ? bullets(likeSec.body) : [];
  const dislike = dislikeSec ? bullets(dislikeSec.body) : [];
  const tail = secs.filter((s) => s !== likeSec && s !== dislikeSec)
    .map((s) => `## ${s.title}\n\n${s.body}`).join('\n\n').trim();
  if (!like.length && !dislike.length && !verdict) return null; // not the expected shape → prose
  return { verdict, verdictWhy, like, dislike, tail };
}

// Split a Markdown answer into its `## ` sections, each with a normalised key for matching.
function sectionSpans(text) {
  const re = /^##\s+(.+)$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(text))) heads.push({ title: m[1].trim(), start: m.index, bodyStart: re.lastIndex });
  return heads.map((h, i) => ({
    title: h.title,
    key: h.title.toLowerCase().replace(/[^a-z' ]/g, '').trim(),
    body: text.slice(h.bodyStart, i + 1 < heads.length ? heads[i + 1].start : text.length).trim(),
  }));
}

// A section's bullet lines, parsed into { t: point, d: detail } for the for/against columns.
function bullets(body) {
  return String(body || '').split('\n').map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => {
      const s = l.replace(/^[-*]\s+/, '');
      let mm = s.match(/^\*\*(.+?)\*\*\s*[—–\-:]\s*(.+)$/);
      if (!mm) mm = s.match(/^(.+?)\s+[—–]\s+(.+)$/);
      if (mm) return { t: cleanInline(mm[1]), d: cleanInline(mm[2]), tag: '' };
      return { t: cleanInline(s), d: '', tag: '' };
    })
    .filter((p) => p.t)
    .slice(0, 6);
}

function cleanInline(s) { return String(s || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(); }

function ptHtml(p, i) {
  const n = String(i + 1).padStart(2, '0');
  const detail = p.d ? `<div class="d">${esc(p.d)}</div>` : '';
  const tag = p.tag ? `<span class="tag">${esc(p.tag)}</span>` : '';
  return `<div class="gi-pt"><div class="t"><span class="b">${n}</span><span>${esc(p.t)}</span></div>${detail}${tag}</div>`;
}

function concallHtml(d) {
  const c = d.concalls;
  const LABEL = { kept: 'Kept', watch: 'Watch', missed: 'Slipping' };
  const rows = c.rows.map((r) => `<tr>
    <td><div class="gd-th">${esc(r.theme)}</div><div class="gd-gd">${esc(r.guided)}</div></td>
    <td><span class="gi-st ${r.status}">${LABEL[r.status] || ''}</span><span class="gd-note">${esc(r.note)}</span></td>
  </tr>`).join('');
  return `<h2 class="gi-sh">Guidance vs delivery — the last 3 earnings calls</h2>
    <div class="gi-wrapcard">
      <table class="gi-gd"><thead><tr><th>What management said</th><th>How it’s tracking</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="gi-trend">${c.trend}</div>
      <div class="gi-fnote">${esc(c.note)}</div>
    </div>`;
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
  offRuns?.();
  offRuns = null;
  liveData.clear();
  liveToken = null;
  ctxRef = null;
}

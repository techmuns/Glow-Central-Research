import { TAB_META } from './catalog.js';
import { escapeHtml as e } from '../core/dom.js';
import { scoreTable, sectionHead, openDrill } from '../ui/screener.js';
import * as fundamentals from '../data/fundamentals.js';
import * as coverage from '../data/coverage.js';
import { stockIdeas, THEMES, themeById, ideaBasis } from '../data/stock-ideas.js';

// AI RECOMMENDATIONS — ideas to research from the universe's published fundamentals, with the basis
// on the face of every one (Yamini, 22 Oct: "recommend some new names … What is the basis for that?").
// A transparent deterministic screen (data/stock-ideas.js), never advice and never a generated number.

export const meta = TAB_META['ai-recommendations'];

let dead = false, tableDispose = null, ctxRef = null;

const stamp = (at) => (at ? new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST' : 'not yet loaded');
const crore = (v) => (Number.isFinite(v) ? (v >= 100000 ? `₹${(v / 100000).toFixed(2)} L Cr` : `₹${Math.round(v).toLocaleString('en-IN')} Cr`) : '—');
const themeLabel = (id) => themeById(id)?.label || id;
const chip = (text) => `<span class="mr-1 mb-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">${e(text)}</span>`;
const leadSignal = (idea) => { const t = themeById(idea.lead); const b = t ? t.basis(idea.fundamentals) : []; return b[0] ? `${t.label}: ${b[0][1]}` : (t?.label || '—'); };

function openIdea(idea) {
  const f = idea.fundamentals;
  openDrill({
    name: idea.name,
    sub: [idea.symbol, idea.sector].filter(Boolean).join(' · '),
    link: f.sourceUrl || (idea.symbol ? `https://www.screener.in/company/${idea.symbol}/` : null),
    linkLabel: 'View on Screener.in ↗',
    headerStats: [
      { label: 'Themes cleared', value: `${idea.score} of ${THEMES.length}`, tone: 'neutral' },
      { label: 'Market cap', value: crore(f.ratios?.marketCap), caption: idea.sector || '' },
    ],
    banner: {
      tone: 'slate',
      title: idea.held ? 'Already in your book' : 'A new name — not currently held',
      body: 'Ideas to research from the published fundamentals, not advice. Every figure below is read from Screener; nothing is estimated.',
    },
    beforeGroupsHtml: `<p class="mb-4 text-xs text-slate-500">Source: Screener.in${f.basis ? ` · ${e(f.basis)}` : ''}${f.fetchedAt ? ` · captured ${e(stamp(f.fetchedAt))}` : ''}. <a class="text-indigo-600 hover:text-indigo-800" href="#/research/ai-insights?company=${e(idea.symbol)}">Open the AI one-pager for ${e(idea.name)} →</a></p>`,
    groups: idea.themes.map((id) => {
      const basis = ideaBasis(f, id);
      return {
        category: basis.label,
        items: [{ label: basis.blurb, value: '' }, ...basis.rows.map(([label, value]) => ({ label, value }))],
      };
    }),
  });
}

function paint() {
  if (dead || !ctxRef) return;
  const root = ctxRef.root, m = fundamentals.meta();
  const universe = fundamentals.all();
  const ideas = stockIdeas(universe, (sym) => { try { return coverage.has(sym); } catch { return false; } });
  const newCount = ideas.filter((i) => !i.held).length;
  const description = `Companies screening strongest on four fundamental themes, from the ${m.count || universe.length} we hold multi-year fundamentals for — the exact figures are the basis, read from Screener. “New” marks names not in your book (${newCount} here); a wider pool of new names needs fundamentals we do not yet capture for the full market. Ideas to research, not advice.`;
  const table = scoreTable({
    rows: ideas, key: (i) => i.symbol, name: (i) => i.name, sub: (i) => i.sector || i.symbol,
    watchKey: (i) => i.symbol, showRank: true, dense: true, nameMaxPx: 230,
    stickyHead: 'max(320px, calc(100vh - 320px))', fillMode: 'auto',
    columns: [
      { label: 'Themes', get: (i) => i.themes.map((id) => chip(themeLabel(id))).join(''), html: true, sortValue: (i) => i.score, align: 'left' },
      { label: 'Signals', get: (i) => `${i.score} of ${THEMES.length}`, sortValue: (i) => i.score, align: 'right' },
      { label: 'Top signal', get: (i) => leadSignal(i), sortValue: (i) => themeById(i.lead)?.rankBy(i.fundamentals) ?? -1, align: 'left' },
      { label: 'In book', get: (i) => (i.held ? '<span class="text-slate-500">Held</span>' : '<span class="font-semibold text-indigo-600">New</span>'), html: true, sortValue: (i) => (i.held ? 1 : 0), align: 'left' },
      { label: 'Market cap', get: (i) => crore(i.fundamentals.ratios?.marketCap), sortValue: (i) => i.fundamentals.ratios?.marketCap ?? -1, align: 'right' },
      { label: 'Sector', get: (i) => i.sector || '—', align: 'left' },
    ],
    filters: [
      { label: 'Theme', options: [{ value: 'all', label: 'All themes' }, ...THEMES.map((t) => ({ value: t.id, label: t.label }))], match: (i, v) => i.themes.includes(v) },
      { label: 'Holding', options: [{ value: 'all', label: 'Held & new' }, { value: 'new', label: 'New names only' }, { value: 'held', label: 'Already held' }], match: (i, v) => (v === 'new' ? !i.held : i.held) },
    ],
    searchable: (i) => `${i.name} ${i.symbol} ${i.sector || ''} ${i.themes.map(themeLabel).join(' ')}`,
    initialSort: { key: 'Signals', dir: 'desc' },
    countNoun: 'ideas', exportName: 'glow-stock-ideas',
    onRowClick: openIdea,
    emptyMessage: 'No company clears these themes in the fundamentals we hold. This is not a market-wide screen — a wider universe needs fundamentals we do not yet capture.',
  });
  root.innerHTML = `${sectionHead({ title: 'AI Recommendations', description, meta: `Fundamentals captured ${stamp(m.fetchedAt)}` })}${table.html}`;
  tableDispose = table.wire(root);
}

export function render(ctx) {
  dead = false; ctxRef = ctx;
  ctx.root.innerHTML = `${sectionHead({ title: 'AI Recommendations', description: 'Screening the companies we hold fundamentals for, on four transparent themes…' })}<div class="p-6 text-sm text-slate-500">Loading fundamentals…</div>`;
  fundamentals.load().then(() => { if (!dead) paint(); }).catch(() => { if (!dead) paint(); });
}

export function destroy() { dead = true; tableDispose?.(); tableDispose = null; ctxRef = null; }

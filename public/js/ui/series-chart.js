// ui/series-chart.js — an SVG time-series chart for the macro tabs. GLOW-OWNED.
//
//   seriesChart({ series: [{ meta, points }], type, height, forceRebase })  → { html, wire(root) }
//   yieldCurveChart({ rows, asOf, priorDate })                               → { html, wire(root) }
//
// No chart library: the app has no bundler and no npm dependency, so this draws the four chart
// types the spec asks for (line, area, bar, scatter) as inline SVG, sized to its container at wire
// time and redrawn on resize. It reproduces the rules of `SeriesChart.tsx` in techmuns/GlowVentures:
//
//   • OVERLAYING SERIES WITH DIFFERENT UNITS IS REBASED TO 100, AND SAYS SO. Brent is $/bbl, the
//     Nifty is index points, USD/INR is a ratio — on one linear axis the largest number is the only
//     visible line. When more than one unit is on screen every series is rebased at the start of
//     the window; the caption states it, and a single-series level chart is never rebased.
//   • TICKS ARE CHOSEN, NOT FORMATTED INTO SUBMISSION. One tick per period (year, quarter or month
//     by span), taken from the first observation in that period, strided down to at most twelve.
//   • A NULL IS A GAP. A series with no observation on a date draws nothing there — never a zero.

import { escapeHtml } from '../core/dom.js';
import { fmtLevel, rebase } from '../data/series.js';

// Categorical palette on the light chassis: the brand's deep gold first, then the decorative
// accents the Tailwind config carries (violet, teal, fuchsia, sky, blue). Emerald/amber/rose are
// semantic on this dashboard and are kept out of the overlay palette on purpose.
export const CHART_COLORS = ['#8a6a1c', '#6d4bb5', '#0f7d6c', '#b93d67', '#12768f', '#4f46e5', '#c3a962', '#7f5cc2', '#2b9d8a', '#e0709b', '#3f9dbe', '#818cf8'];

const PAD = { top: 12, right: 14, bottom: 26, left: 58 };

const axisFmt = (v) => (Math.abs(v) >= 10000 ? `${(v / 1000).toFixed(0)}k` : Math.abs(v) >= 1 ? v.toFixed(Math.abs(v) >= 100 ? 0 : 1) : v.toFixed(3));

function niceTicks(min, max, n = 5) {
  if (!(max > min)) return [min];
  const span = max - min;
  const step0 = span / Math.max(1, n - 1);
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step / 2; v += step) out.push(v);
  return out;
}

/** One tick per period, ≤ 12 — see the file header. */
function timeTicks(dates) {
  if (!dates.length) return { ticks: [], fmt: (t) => t };
  const spanDays = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 86400000;
  const period = spanDays > 365 * 3 ? 'year' : spanDays > 200 ? 'quarter' : spanDays > 60 ? 'month' : 'none';
  if (period === 'none') {
    const stride = Math.max(1, Math.ceil(dates.length / 10));
    return { ticks: dates.filter((_, i) => i % stride === 0), fmt: (t) => t.slice(5) };
  }
  const keyOf = (t) => (period === 'year' ? t.slice(0, 4) : period === 'quarter' ? `${t.slice(0, 4)}Q${Math.floor(Number(t.slice(5, 7)) / 3.01) + 1}` : t.slice(0, 7));
  const firsts = [];
  let last = '';
  for (const t of dates) {
    const k = keyOf(t);
    if (k !== last) {
      firsts.push(t);
      last = k;
    }
  }
  const stride = Math.max(1, Math.ceil(firsts.length / 12));
  return { ticks: firsts.filter((_, i) => i % stride === 0), fmt: (t) => (period === 'year' ? t.slice(0, 4) : t.slice(0, 7)) };
}

let uid = 0;

/**
 * Build the chart. `series` is `[{ meta: { id, label, unit }, points: [{ t, v }] }]`. The markup is
 * a placeholder; `wire(root)` measures the container and draws the SVG, and redraws on resize.
 */
export function seriesChart({ series = [], type = 'line', height = 320, forceRebase = null } = {}) {
  const id = `sc-${++uid}`;
  const units = new Set(series.map((s) => s.meta.unit));
  const rebased = forceRebase ?? (units.size > 1 && series.length > 1);
  const unit = rebased ? 'index' : series[0]?.meta.unit ?? '';

  // One row per date across every series, sorted.
  const byDate = new Map();
  const keys = series.map((s, i) => {
    const pts = rebased ? rebase(s.points) : s.points;
    for (const p of pts) {
      if (!Number.isFinite(p.v)) continue;
      const row = byDate.get(p.t) ?? { t: p.t, v: {} };
      row.v[s.meta.id] = p.v;
      byDate.set(p.t, row);
    }
    return { key: s.meta.id, label: s.meta.label, color: CHART_COLORS[i % CHART_COLORS.length] };
  });
  const rows = [...byDate.values()].sort((a, b) => (a.t < b.t ? -1 : 1));

  const html = `
    <div data-series-chart="${id}" class="relative" style="height:${height}px">
      <div data-chart-canvas class="h-full w-full"></div>
      <div data-chart-tip class="pointer-events-none absolute z-10 hidden rounded-lg bg-white px-2.5 py-1.5 text-[11px] shadow-lg ring-1 ring-slate-200"></div>
    </div>
    ${keys.length > 1 ? `<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600">${keys.map((k) => `<span class="inline-flex items-center gap-1.5"><span class="inline-block h-2 w-2 rounded-full" style="background:${k.color}"></span>${escapeHtml(k.label)}</span>`).join('')}</div>` : ''}
    ${rebased ? `<p class="mt-1.5 text-[11px] text-slate-500">Rebased to 100 at the start of the window — these series are quoted in different units (${escapeHtml([...units].join(', '))}), so levels are not comparable and only their paths are.</p>` : ''}`;

  function draw(host) {
    const W = Math.max(320, host.clientWidth || 900);
    const H = height;
    if (!rows.length) {
      host.innerHTML = `<div class="grid h-full place-items-center text-xs text-slate-400">No observations in this window.</div>`;
      return null;
    }
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const dates = rows.map((r) => r.t);
    const t0 = Date.parse(dates[0]);
    const t1 = Date.parse(dates[dates.length - 1]);
    const isBar = type === 'bar';
    // Bars are positioned by index (a bar per observation); the others by time.
    const xOf = (i, t) => (isBar ? PAD.left + ((i + 0.5) / rows.length) * plotW : PAD.left + (t1 > t0 ? ((Date.parse(t) - t0) / (t1 - t0)) * plotW : plotW / 2));
    let min = Infinity;
    let max = -Infinity;
    for (const r of rows) for (const v of Object.values(r.v)) { if (v < min) min = v; if (v > max) max = v; }
    if (isBar) { min = Math.min(0, min); max = Math.max(0, max); }
    if (!(max > min)) { max = min + Math.abs(min || 1) * 0.1; min = min - Math.abs(min || 1) * 0.1; }
    const padY = (max - min) * 0.06;
    const y0 = min - padY;
    const y1 = max + padY;
    const yOf = (v) => PAD.top + (1 - (v - y0) / (y1 - y0)) * plotH;
    const yTicks = niceTicks(y0, y1, 5).filter((v) => v >= y0 && v <= y1);
    const { ticks, fmt } = timeTicks(dates);

    const grid = yTicks.map((v) => `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${yOf(v).toFixed(1)}" y2="${yOf(v).toFixed(1)}" stroke="#e4ddcd" stroke-dasharray="2 4"/><text x="${PAD.left - 8}" y="${(yOf(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="11" fill="#736f88">${axisFmt(v)}</text>`).join('');
    const xAxis = ticks.map((t) => { const i = dates.indexOf(t); const x = xOf(i, t); return `<text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#736f88">${fmt(t)}</text>`; }).join('');

    let marks = '';
    keys.forEach((k, ki) => {
      const pts = rows.map((r, i) => ({ i, t: r.t, v: r.v[k.key] })).filter((p) => Number.isFinite(p.v));
      if (!pts.length) return;
      if (type === 'bar') {
        const bw = Math.max(1, (plotW / rows.length) * 0.72 / keys.length);
        const base = yOf(0);
        marks += pts.map((p) => { const x = xOf(p.i, p.t) - ((plotW / rows.length) * 0.72) / 2 + ki * bw; const y = yOf(p.v); return `<rect x="${x.toFixed(1)}" y="${Math.min(y, base).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, Math.abs(base - y)).toFixed(1)}" fill="${k.color}" opacity="0.85"/>`; }).join('');
        return;
      }
      if (type === 'scatter') {
        marks += pts.map((p) => `<circle cx="${xOf(p.i, p.t).toFixed(1)}" cy="${yOf(p.v).toFixed(1)}" r="2.2" fill="${k.color}" opacity="0.8"/>`).join('');
        return;
      }
      const d = pts.map((p, j) => `${j ? 'L' : 'M'}${xOf(p.i, p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`).join('');
      if (type === 'area') {
        const first = pts[0];
        const last = pts[pts.length - 1];
        const bottom = PAD.top + plotH;
        marks += `<defs><linearGradient id="${id}-g${ki}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${k.color}" stop-opacity="0.35"/><stop offset="100%" stop-color="${k.color}" stop-opacity="0"/></linearGradient></defs>`;
        marks += `<path d="${d}L${xOf(last.i, last.t).toFixed(1)},${bottom}L${xOf(first.i, first.t).toFixed(1)},${bottom}Z" fill="url(#${id}-g${ki})"/>`;
      }
      marks += `<path d="${d}" fill="none" stroke="${k.color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`;
    });

    host.innerHTML = `
      <svg data-chart-svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="block max-w-full" role="img" aria-label="${escapeHtml(keys.map((k) => k.label).join(', '))}">
        ${grid}${xAxis}
        <line x1="${PAD.left}" x2="${W - PAD.right}" y1="${PAD.top + plotH}" y2="${PAD.top + plotH}" stroke="#e4ddcd"/>
        ${marks}
        <line data-guide x1="0" x2="0" y1="${PAD.top}" y2="${PAD.top + plotH}" stroke="#928da1" stroke-dasharray="3 3" class="hidden"/>
      </svg>`;
    return { W, H, xOf, dates, rows };
  }

  function wire(root) {
    const wrap = root.querySelector(`[data-series-chart="${id}"]`);
    if (!wrap) return () => {};
    const host = wrap.querySelector('[data-chart-canvas]');
    const tip = wrap.querySelector('[data-chart-tip]');
    let geo = draw(host);
    const onMove = (ev) => {
      if (!geo) return;
      const svg = host.querySelector('svg');
      const rect = svg.getBoundingClientRect();
      const x = ((ev.clientX - rect.left) / rect.width) * geo.W;
      // Nearest row by x — a binary search on the drawn positions.
      let lo = 0;
      let hi = geo.rows.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (geo.xOf(mid, geo.dates[mid]) < x) lo = mid + 1;
        else hi = mid;
      }
      const cand = [lo, lo - 1].filter((i) => i >= 0 && i < geo.rows.length);
      const i = cand.sort((a, b) => Math.abs(geo.xOf(a, geo.dates[a]) - x) - Math.abs(geo.xOf(b, geo.dates[b]) - x))[0];
      const row = geo.rows[i];
      const gx = geo.xOf(i, row.t);
      const guide = svg.querySelector('[data-guide]');
      guide.setAttribute('x1', gx.toFixed(1));
      guide.setAttribute('x2', gx.toFixed(1));
      guide.classList.remove('hidden');
      tip.innerHTML = `<div class="font-semibold text-slate-700">${escapeHtml(row.t)}</div>${keys
        .map((k) => (Number.isFinite(row.v[k.key]) ? `<div class="flex items-center gap-1.5"><span class="inline-block h-1.5 w-1.5 rounded-full" style="background:${k.color}"></span><span class="text-slate-500">${escapeHtml(k.label)}</span><span class="ml-auto pl-3 tabular-nums font-medium text-slate-800">${rebased ? row.v[k.key].toFixed(1) : escapeHtml(fmtLevel(row.v[k.key], unit))}</span></div>` : ''))
        .join('')}`;
      tip.classList.remove('hidden');
      const px = (gx / geo.W) * rect.width;
      tip.style.left = `${Math.min(rect.width - 170, Math.max(0, px + 12))}px`;
      tip.style.top = `${Math.max(0, ev.clientY - rect.top - 10)}px`;
    };
    const onLeave = () => {
      tip.classList.add('hidden');
      host.querySelector('[data-guide]')?.classList.add('hidden');
    };
    host.addEventListener('mousemove', onMove);
    host.addEventListener('mouseleave', onLeave);
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        geo = draw(host);
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      host.removeEventListener('mousemove', onMove);
      host.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    };
  }

  return { html, wire, rebased, empty: rows.length === 0 };
}

/**
 * THE YIELD CURVE — many instruments at ONE moment, maturity on the x-axis. `rows` is
 * `[{ label, years, now, then }]` in tenor order; a null `now`/`then` is left undrawn.
 */
export function yieldCurveChart({ rows = [], asOf = null, priorDate = null, height = 300 } = {}) {
  const id = `yc-${++uid}`;
  const html = `<div data-yield-curve="${id}" class="relative" style="height:${height}px"><div data-chart-canvas class="h-full w-full"></div></div>
    <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600">
      <span class="inline-flex items-center gap-1.5"><span class="inline-block h-0.5 w-4" style="background:${CHART_COLORS[0]}"></span>Current${asOf ? ` (${escapeHtml(asOf)})` : ''}</span>
      <span class="inline-flex items-center gap-1.5"><span class="inline-block h-0.5 w-4 border-t border-dashed" style="border-color:${CHART_COLORS[1]}"></span>A year earlier${priorDate ? ` (${escapeHtml(priorDate)})` : ''}</span>
    </div>`;

  function draw(host) {
    const W = Math.max(320, host.clientWidth || 900);
    const H = height;
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const vals = rows.flatMap((r) => [r.now, r.then]).filter((v) => Number.isFinite(v));
    if (!rows.length || !vals.length) {
      host.innerHTML = '<div class="grid h-full place-items-center text-xs text-slate-400">No tenors to draw.</div>';
      return;
    }
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    const padY = Math.max(0.05, (max - min) * 0.15);
    min -= padY;
    max += padY;
    const yOf = (v) => PAD.top + (1 - (v - min) / (max - min)) * plotH;
    const xOf = (i) => PAD.left + ((i + 0.5) / rows.length) * plotW;
    const yTicks = niceTicks(min, max, 5).filter((v) => v >= min && v <= max);
    const grid = yTicks.map((v) => `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${yOf(v).toFixed(1)}" y2="${yOf(v).toFixed(1)}" stroke="#e4ddcd" stroke-dasharray="2 4"/><text x="${PAD.left - 8}" y="${(yOf(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="11" fill="#736f88">${v.toFixed(2)}%</text>`).join('');
    const xAxis = rows.map((r, i) => `<text x="${xOf(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#736f88">${escapeHtml(r.label)}</text>`).join('');
    const line = (key, color, dashed) => {
      const pts = rows.map((r, i) => ({ i, v: r[key] })).filter((p) => Number.isFinite(p.v));
      if (pts.length < 1) return '';
      const d = pts.map((p, j) => `${j ? 'L' : 'M'}${xOf(p.i).toFixed(1)},${yOf(p.v).toFixed(1)}`).join('');
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${dashed ? 1.5 : 2}" ${dashed ? 'stroke-dasharray="4 3"' : ''}/>${pts.map((p) => `<circle cx="${xOf(p.i).toFixed(1)}" cy="${yOf(p.v).toFixed(1)}" r="${dashed ? 2.5 : 3.5}" fill="${color}"><title>${escapeHtml(rows[p.i].label)} ${key === 'now' ? 'current' : 'a year earlier'}: ${p.v.toFixed(3)}%</title></circle>`).join('')}`;
    };
    host.innerHTML = `<svg data-chart-svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="block max-w-full" role="img" aria-label="US Treasury yield curve">${grid}${xAxis}<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${PAD.top + plotH}" y2="${PAD.top + plotH}" stroke="#e4ddcd"/>${line('then', CHART_COLORS[1], true)}${line('now', CHART_COLORS[0], false)}</svg>`;
  }

  function wire(root) {
    const wrap = root.querySelector(`[data-yield-curve="${id}"]`);
    if (!wrap) return () => {};
    const host = wrap.querySelector('[data-chart-canvas]');
    draw(host);
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => draw(host));
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    };
  }
  return { html, wire };
}

/**
 * Download the chart as a PNG with a caption band — its title, unit, source and window drawn INTO
 * the image, because an exported chart travels without the page around it.
 */
export async function exportChartPng(root, { title = '', subtitle = '', footer = '', filename = 'chart.png' } = {}) {
  const svg = root?.querySelector('svg[data-chart-svg]');
  if (!svg) return false;
  const W = Number(svg.getAttribute('width')) || 900;
  const H = Number(svg.getAttribute('height')) || 320;
  const band = 64;
  const foot = 26;
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
    const canvas = document.createElement('canvas');
    const scale = 2;
    canvas.width = W * scale;
    canvas.height = (H + band + foot) * scale;
    const c = canvas.getContext('2d');
    c.scale(scale, scale);
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, W, H + band + foot);
    c.fillStyle = '#1a1830';
    c.font = '600 16px Inter, system-ui, sans-serif';
    c.fillText(title, 16, 26);
    c.fillStyle = '#55516b';
    c.font = '12px Inter, system-ui, sans-serif';
    c.fillText(subtitle, 16, 46);
    c.drawImage(img, 0, band, W, H);
    c.fillStyle = '#736f88';
    c.font = '11px Inter, system-ui, sans-serif';
    c.fillText(footer, 16, H + band + 17);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return false;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return true;
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

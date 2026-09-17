// The windowed list keeps the reader's row through an update — including when the caller then
// corrects the scroll position itself against the real layout, as All Alerts does after every
// repaint. Real browser, real module, no data files: the geometry is the whole subject.
//
// WHY THIS EXISTS. `verify-general-alerts-ui.mjs` asserted "visible row moved 0px during refresh"
// and failed on roughly a third of capture branches with 110px or 194px, never on a fixed amount.
// The mechanism is deterministic once isolated: replaced row objects come back at the estimated
// height, the rows painted above the held record render at their real height at once, so the
// scrollTop `update()` computed from the estimate lands rows away from the record until the next
// frame's measurement. The tab's own re-anchor runs in that gap and puts the record back — and the
// deferred measurement then re-anchors from a geometry that no longer describes the DOM, scrolling
// the reader to a different row. A reader on row 13 landed on row 10, every time.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const html = `<!doctype html><html><head><style>
 body{margin:0;font:14px/1.4 system-ui}
 #scroller{height:600px;overflow:auto;border:1px solid #ccc}
 table{border-collapse:collapse;width:100%}
 thead th{position:sticky;top:0;background:#eee;height:40px}
 td{padding:8px;border-bottom:1px solid #eee;vertical-align:top}
</style></head><body>
<div id="scroller"><table><thead><tr><th>Subject</th></tr></thead><tbody id="body"></tbody></table></div>
<script type="module">
import { mountWindowedList } from '/js/ui/windowed-list.js';
// Every row is shorter than the 120px estimate and they vary, so an estimate-placed scroll is
// always wrong by a different amount — the shape that made the tab's failure look random.
const lines = (i) => 1 + ((i * 7) % 4);
window.make = (n, gen) => Array.from({ length: n }, (_, i) => ({ key: 'k' + i, gen,
  text: Array.from({ length: lines(i) }, (_, l) => 'row ' + i + ' (' + gen + ') line ' + l).join('<br>') }));
const scroller = document.querySelector('#scroller'), body = document.querySelector('#body');
const render = (rows, s, e) => rows.slice(s, e).map(r => '<tr data-row-key="' + r.key + '"><td>' + r.text + '</td></tr>').join('');
const spacer = (h, edge) => '<tr aria-hidden="true"><td data-window-spacer="' + edge + '" style="height:' + h + 'px;padding:0;border:0"></td></tr>';
window.mount = (rows, initialKey = null) => {
  window.list?.destroy();
  body.innerHTML = '';
  window.list = mountWindowedList({ scroller, content: body, items: rows, key: r => r.key, renderRows: render,
    rowSelector: 'tr[data-row-key]', estimateHeight: 120, initialKey, spacerHtml: spacer });
};
const boundary = () => scroller.getBoundingClientRect().top + scroller.querySelector('thead').offsetHeight;
// The same reading the tab takes: the first row still below the sticky head, and where its top sits.
window.edgeRow = () => {
  const b = boundary();
  const row = [...body.querySelectorAll('tr[data-row-key]')].find(r => r.getBoundingClientRect().bottom > b);
  return { key: row?.dataset.rowKey || null, offset: row ? row.getBoundingClientRect().top - b : null, scrollTop: scroller.scrollTop };
};
// The tab's own restoreTablePosition, verbatim in effect: move by the difference in the real layout.
window.restore = (pos) => {
  const b = boundary();
  const anchor = [...body.querySelectorAll('tr[data-row-key]')].find(r => r.dataset.rowKey === pos.key);
  if (anchor) scroller.scrollTop += anchor.getBoundingClientRect().top - b - pos.offset;
};
window.frames = (n) => new Promise(done => { const step = () => n-- > 0 ? requestAnimationFrame(step) : done(); step(); });
window.mount(window.make(300, 'a'));
window.ready = true;
</script></body></html>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-store');
  if (path === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
  const file = resolve(root, `.${path}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
  try { res.setHeader('content-type', { '.js': 'text/javascript' }[extname(file)] || 'text/plain'); res.end(readFileSync(file)); } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(origin);
  await page.waitForFunction(() => window.ready && document.querySelectorAll('tr[data-row-key]').length > 0);

  const settle = () => page.evaluate(async () => {
    window.list.update(window.make(300, 'a'), { resetScroll: true });
    await window.frames(3);
    document.querySelector('#scroller').scrollTop = 900;
    await window.frames(3);
    return window.edgeRow();
  });
  const held = (before, after) => {
    assert.equal(after.key, before.key, `reader is still on ${before.key}, not ${after.key}`);
    assert(Math.abs(after.offset - before.offset) <= 1, `row ${before.key} moved ${Math.round(after.offset - before.offset)}px`);
  };

  // 1. An update that replaces every row object and inserts one above the viewport: the held
  //    record is placed exactly, at once — no frame in which other rows show at its position.
  let before = await settle();
  assert(before.key && before.scrollTop > 0, 'the reader is somewhere below the top');
  let after = await page.evaluate(async () => {
    window.list.update([{ key: 'new', gen: 'n', text: 'NEW ROW above the viewport' }, ...window.make(300, 'b')], { resetScroll: false });
    const immediate = window.edgeRow();
    await window.frames(4);
    return { immediate, settled: window.edgeRow() };
  });
  held(before, after.immediate);
  held(before, after.settled);
  console.log('PASS replaced rows: the record is placed exactly on update, not a frame later');

  // 2. The same update, followed by the caller re-anchoring against the real layout in the same
  //    task — what All Alerts does after every repaint. The deferred measurement must not undo it.
  before = await settle();
  after = await page.evaluate(async () => {
    const pos = window.edgeRow();
    window.list.update([{ key: 'new', gen: 'n', text: 'NEW ROW above the viewport' }, ...window.make(300, 'c')], { resetScroll: false });
    window.restore(pos);
    await window.frames(4);
    return window.edgeRow();
  });
  held(before, after);
  console.log('PASS caller re-anchor: the next frame keeps the row the caller put back');

  // 3. A fresh mount at a saved row, then the caller's re-anchor — the tab's full-rebuild path.
  before = await settle();
  after = await page.evaluate(async (pos) => {
    window.mount(window.make(300, 'd'), pos.key);
    window.restore(pos);
    await window.frames(4);
    return window.edgeRow();
  }, before);
  held(before, after);
  console.log('PASS mount at a saved row, then re-anchor');

  // 4. A reader who has not scrolled is left at the top; an explicit reset goes there too.
  await page.evaluate(async () => { window.list.update(window.make(300, 'e'), { resetScroll: true }); await window.frames(3); });
  assert.equal(await page.evaluate(() => document.querySelector('#scroller').scrollTop), 0);
  await page.evaluate(async () => { window.list.update(window.make(300, 'f'), { resetScroll: false }); await window.frames(3); });
  assert.equal(await page.evaluate(() => document.querySelector('#scroller').scrollTop), 0);
  assert.equal(await page.evaluate(() => document.querySelector('tr[data-row-key]').dataset.rowKey), 'k0');
  console.log('PASS unscrolled and reset updates stay at the top');

  assert.deepEqual(errors, []);
  console.log('PASS windowed list: the reader keeps their row through replaced rows, inserted rows and a caller re-anchor');
} finally { await browser.close(); await new Promise(done => server.close(done)); }

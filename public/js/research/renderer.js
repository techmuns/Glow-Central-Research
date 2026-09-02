// research/renderer.js — a small safe renderer for model prose.
// Model text never reaches innerHTML. The supported markdown subset is deliberately restrained:
// headings, paragraphs, callouts, bullets, numbering, bold, emphasis, code and valid pipe tables.

import { el, empty } from '../core/dom.js';

function appendInline(parent, text) {
  const source = String(text || '');
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) parent.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith('**')) parent.appendChild(el('strong', { class: 'font-bold text-slate-900' }, token.slice(2, -2)));
    else if (token.startsWith('`')) parent.appendChild(el('code', { class: 'rounded bg-slate-100 px-1 py-0.5 text-[0.92em] text-slate-700' }, token.slice(1, -1)));
    else parent.appendChild(el('em', { class: 'italic' }, token.slice(1, -1)));
    cursor = match.index + token.length;
  }
  if (cursor < source.length) parent.appendChild(document.createTextNode(source.slice(cursor)));
}

function splitPipe(line) {
  const body = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split('|').map((cell) => cell.trim());
}

function isDivider(line) {
  const cells = splitPipe(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderTable(lines, start) {
  if (!lines[start]?.includes('|') || !isDivider(lines[start + 1] || '')) return null;
  const headers = splitPipe(lines[start]);
  const rows = [];
  let cursor = start + 2;
  while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) {
    const cells = splitPipe(lines[cursor]);
    if (cells.length !== headers.length) return null;
    rows.push(cells);
    cursor += 1;
  }
  if (!rows.length) return null;

  const table = el('table', { class: 'min-w-full border-separate border-spacing-0 text-left text-xs' });
  const headRow = el('tr');
  for (const header of headers) {
    const th = el('th', { scope: 'col', class: 'border-b border-slate-200 bg-slate-50 px-3 py-2 font-bold text-slate-600' });
    appendInline(th, header);
    headRow.appendChild(th);
  }
  table.appendChild(el('thead', {}, headRow));
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td', { class: 'border-b border-slate-100 px-3 py-2 align-top text-slate-700' });
      appendInline(td, cell);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  return {
    node: el('div', { class: 'scrollbar-thin my-4 overflow-x-auto rounded-xl border border-slate-200', tabindex: '0', 'aria-label': 'Answer data table' }, table),
    next: cursor,
  };
}

export function renderResearchAnswer(container, text) {
  empty(container);
  const lines = String(text || '').replaceAll('\r\n', '\n').split('\n');
  let cursor = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = el('p', { class: 'research-answer-paragraph' });
    appendInline(p, paragraph.join(' '));
    container.appendChild(p);
    paragraph = [];
  };

  while (cursor < lines.length) {
    const line = lines[cursor];
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      cursor += 1;
      continue;
    }

    const table = renderTable(lines, cursor);
    if (table) {
      flushParagraph();
      container.appendChild(table.node);
      cursor = table.next;
      continue;
    }

    const heading = trimmed.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const h = el('h3', { class: 'research-answer-heading' });
      appendInline(h, heading[2]);
      container.appendChild(h);
      cursor += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushParagraph();
      const quote = el('blockquote', { class: 'research-answer-callout' });
      appendInline(quote, trimmed.replace(/^>\s?/, ''));
      container.appendChild(quote);
      cursor += 1;
      continue;
    }

    const bullet = trimmed.match(/^[-•*]\s+(.+)$/);
    const numbered = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = !!numbered;
      const list = el(ordered ? 'ol' : 'ul', { class: ordered ? 'research-answer-list list-decimal' : 'research-answer-list list-disc' });
      if (ordered) list.start = Number(numbered[1]);
      while (cursor < lines.length) {
        const candidate = lines[cursor].trim();
        const match = ordered ? candidate.match(/^(\d+)[.)]\s+(.+)$/) : candidate.match(/^[-•*]\s+(.+)$/);
        if (!match) break;
        const li = el('li');
        appendInline(li, ordered ? match[2] : match[1]);
        if (ordered) li.value = Number(match[1]);
        list.appendChild(li);
        cursor += 1;
      }
      container.appendChild(list);
      continue;
    }

    paragraph.push(trimmed);
    cursor += 1;
  }
  flushParagraph();
}

export function renderResearchSources(container, { dashboard = [], web = [] } = {}) {
  empty(container);
  if (!dashboard.length && !web.length) return;

  const label = el('span', { class: 'mr-1 text-[10px] font-bold uppercase tracking-wider text-slate-400' }, 'Sources');
  container.appendChild(label);
  for (const item of dashboard) {
    const chip = el('a', {
      class: 'research-source-chip',
      href: item.route || '#',
      title: `Open ${item.tab || item.id}`,
    }, item.tab || item.id);
    container.appendChild(chip);
  }
  for (const item of web) {
    let url;
    try {
      url = new URL(item.url);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
    } catch {
      continue;
    }
    const link = el('a', {
      class: 'research-source-chip research-source-chip-web',
      href: url.href,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: item.title || url.hostname,
    }, item.title || url.hostname);
    container.appendChild(link);
  }
}

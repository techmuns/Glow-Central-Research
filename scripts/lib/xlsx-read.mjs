// scripts/lib/xlsx-read.mjs — read an .xlsx with nothing but the Node standard library.
//
//   readWorkbook(buffer)  ->  { 'Sheet name': [ [cell, cell, …], … ], … }
//
// WHY THIS EXISTS RATHER THAN `npm i xlsx`
//   This repo has no package.json and no node_modules, deliberately (see CLAUDE.md). The scripts
//   under scripts/ are plain Node 22 and stay that way, so a one-off data import must not be the
//   thing that drags a dependency tree into the project. An .xlsx is a ZIP of XML, both of which
//   Node can already do: `node:zlib` inflates the entries and a small tag scanner reads the rows.
//
// PURE AND OFFLINE, like scripts/lib/trendlyne.mjs. No fetch, no fs, no globals — a Buffer in and
// arrays out, so it can be exercised against a committed fixture without touching the network.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   No styles, no number formats, no formulas, no dates-as-serials. It returns what the cell
//   STORES: a string for text, a JS number for a numeric cell, and '' for an empty one. Everything
//   downstream of this is a percentage or a rupee figure that is already a plain number in the
//   source, and inventing a date interpretation for a column that has none is exactly the kind of
//   silent transformation this codebase treats as a bug.

import { inflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

/**
 * Every file in a ZIP, by name.
 *
 * Read through the CENTRAL DIRECTORY rather than by scanning for local file headers. A local
 * header may carry zeroed sizes with the real ones in a trailing data descriptor, so scanning
 * forwards can silently truncate an entry; the central directory always holds the true sizes.
 */
export function unzip(buf) {
  // The end-of-central-directory record sits at the end, after a comment of unknown length.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error(`corrupt central directory at entry ${n}`);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // The local header repeats the name and extra fields, and its extra field length can differ
    // from the central one — so the payload offset must be computed from the LOCAL header.
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compressedSize);

    if (method === 0) files.set(name, Buffer.from(raw));
    else if (method === 8) files.set(name, inflateRawSync(raw));
    else throw new Error(`${name}: unsupported compression method ${method}`);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------------------------------------------------------------------------------------
// XML — just enough of it
// ---------------------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const decode = (s) =>
  s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10));
    return ENTITIES[e] ?? m;
  });

/** Every attribute on one start tag. */
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decode(m[2]);
  return out;
}

/** Concatenated text of every <t> inside a fragment — how a shared string with runs is stored. */
const textOf = (frag) => [...frag.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');

/** "BC" -> 54. Column letters are base-26 with no zero. */
function colIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------------------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------------------

/**
 * Read every sheet into an array of rows, each row an array of cells.
 *
 * Rows are returned in document order with BLANK ROWS DROPPED, and each row is padded out to its
 * own widest populated cell — so a row's index is its position among populated rows, not its
 * spreadsheet row number. Callers here read a fixed header row and then the body, so that is the
 * shape they want; anything needing true row numbers should not use this.
 */
export function readWorkbook(buf) {
  const files = unzip(buf);
  const read = (name) => {
    const f = files.get(name.replace(/^\//, ''));
    if (!f) throw new Error(`${name} is not in this workbook`);
    return f.toString('utf8');
  };

  // Shared strings are optional: a writer may inline every string instead (both Bandhan exports do).
  const shared = [];
  if (files.has('xl/sharedStrings.xml')) {
    for (const m of read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  }

  const rels = new Map();
  for (const m of read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.Id && a.Target) rels.set(a.Id, a.Target.replace(/^\/?(xl\/)?/, 'xl/'));
  }

  const out = {};
  for (const m of read('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    const target = rels.get(a['r:id']);
    if (!target) continue;
    out[a.name || target] = readSheet(read(target), shared);
  }
  return out;
}

function readSheet(xml, shared) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = new Map();
    for (const cm of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(cm[1]);
      const body = cm[2] || '';
      const i = colIndex(a.r || 'A');
      const t = a.t;

      if (t === 's') {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1]);
        cells.set(i, shared[idx] ?? '');
      } else if (t === 'inlineStr') {
        cells.set(i, textOf(body));
      } else if (t === 'e') {
        // An error cell (#N/A, #DIV/0!) is not a value. Empty, so it cannot be read as a figure.
        cells.set(i, '');
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v == null) continue;
        // `t="str"` is a formula's cached STRING result; anything else numeric-looking is a number.
        // Number('') is 0, which is why the empty case is filtered out above rather than coerced.
        if (t === 'str' || t === 'b') cells.set(i, decode(v));
        else {
          const n = Number(v);
          cells.set(i, Number.isFinite(n) ? n : decode(v));
        }
      }
    }
    if (!cells.size) continue;
    const width = Math.max(...cells.keys()) + 1;
    rows.push(Array.from({ length: width }, (_, i) => (cells.has(i) ? cells.get(i) : '')));
  }
  return rows;
}

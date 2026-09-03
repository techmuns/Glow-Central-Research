// data/filings-shared.js — the vocabulary for news, corporate announcements and insider trades.
//
//   parseMarkdownTable(md)        a markdown table -> { headers, rows }
//   normaliseInsiderTrades(body)  the insider payload -> [{ ...cells, date, ticker }]
//   normaliseAnnouncements(body)  the announcements payload -> [{ date, title, source, url, … }]
//   normaliseArticles(body)       the news payload -> [{ date, title, source, url, summary }]
//   pickField(obj, names)         first present, non-empty value among candidate keys
//
// PURE, AND IMPORTED BY `worker/muns.mjs`. Same arrangement as stockscans-shared.js and
// finology-shared.js: one definition of what a row is, so the Worker and the browser cannot drift.
// Nothing here touches the DOM, `fetch` or any global.
//
// WHY EVERYTHING HERE IS DELIBERATELY LOOSE ABOUT FIELD NAMES
//   These three payloads are not ours and their shapes are not pinned by any contract we control.
//   Insider trades is documented as returning **a markdown table string**, not JSON; announcements
//   as "results grouped by source", with the grouping unspecified; news as an article list with no
//   stated field names at all.
//
//   So this reads by SHAPE and by a list of candidate keys rather than by one guessed name — the
//   same rule the Concall Deep Dive panel follows for a schema that lives in someone else's repo. A
//   field renamed upstream costs one column, not the whole tab, and an unknown extra field is
//   carried through rather than dropped. What it will NOT do is invent a value: a field that is
//   absent stays null and renders as an em dash, because a blank that means "they did not tell us"
//   must never be filled in to look complete.
//
// NOTHING IN HERE PARSES A NUMBER OUT OF PROSE. Quantities and rupee values arrive as the upstream
// wrote them and are kept as strings unless they are unambiguously numeric — a "value" column that
// reads "1,20,000 (approx)" is not a number, and coercing it would silently produce 1.2.

/** The first candidate key that carries something. Case- and separator-insensitive. */
export function pickField(obj, names) {
  if (!obj || typeof obj !== 'object') return null;
  const flat = new Map();
  for (const [k, v] of Object.entries(obj)) flat.set(String(k).toLowerCase().replace(/[^a-z0-9]/g, ''), v);
  for (const n of names) {
    const v = flat.get(String(n).toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (v != null && v !== '' && v !== '-' && v !== 'N/A') return v;
  }
  return null;
}

const str = (v) => (v == null ? null : String(v).trim() || null);

/** Only an http(s) address may ever become an anchor — this is external content. */
export const safeUrl = (v) => {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
};

const INSIDER_URL_FIELDS = ['link', 'url', 'source', 'source url', 'source link', 'filing url', 'filing link', 'document url', 'document link'];

/** Prefer the filing URL carried upstream; otherwise narrow a public disclosure search by insider. */
export function insiderTradeSourceUrl(row) {
  const candidates = [row?.url, pickField(row?.cells, INSIDER_URL_FIELDS)];
  for (const value of candidates) {
    const direct = safeUrl(value);
    if (direct) return direct;
    const embedded = String(value || '').match(/https?:\/\/[^\s<>)]+/i)?.[0] || null;
    const parsed = safeUrl(embedded);
    if (parsed) return parsed;
  }

  // The current table carries an exchange name but no exchange filing id. An exact-person search
  // is the narrowest traceable public record we can derive without inventing an identifier.
  const cells = row?.cells || {};
  const nameKey = Object.keys(cells).find((key) => /person|insider|holder|acquirer/i.test(key))
    || Object.keys(cells).find((key) => /name/i.test(key));
  const query = String((nameKey ? cells[nameKey] : null) || row?.ticker || '').trim();
  return query ? `https://trendlyne.com/equity/insider-trading-sast/custom/?query=${encodeURIComponent(query)}` : null;
}

/**
 * A date in whatever the upstream felt like, normalised to YYYY-MM-DD, or null.
 *
 * Returns null rather than guessing when the string is not a date this understands. A row with an
 * unreadable date sorts to the bottom and shows a dash; inventing today's date for it would make a
 * two-year-old filing look like this morning's.
 */
export function isoDate(v) {
  const s = str(v);
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s); // BSE's YYYYMMDD
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(s); // DD-MM-YYYY, the Indian convention
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  m = /^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{4})/.exec(s); // 14-Aug-2026
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

/**
 * The same value as a full instant, or null — for upstreams that carry a TIME as well as a date.
 *
 * IT HAS TO BE ITS OWN COMMITTED FIELD, and that is the whole point of it. General Alerts read the
 * news time off `raw.page_age`, and `raw` is the upstream record again — deliberately stripped by
 * `scrape-filings.mjs` before writing, because committing it would multiply the snapshot several
 * times over. So the time was present on a live-walked row and absent on every row that came from
 * the file, which is all of them: the TIME column read an em dash for every company story on the
 * page while market-wide news, whose `publishedAt` IS committed, showed times beside it. It looked
 * exactly like a scope bug and was a field that never survived the write.
 *
 * Returns null where the upstream gave only a day. A date with a zero time would claim midnight.
 */
export function isoInstant(v) {
  const s = str(v);
  if (!s) return null;
  // A bare YYYY-MM-DD carries no time, and neither do the day-only forms `isoDate` understands.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{8}$/.test(s)) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  // Guard against a parse that invented midnight from a day-only string in some other shape.
  return /\d{1,2}:\d{2}/.test(s) ? new Date(t).toISOString() : null;
}

// ---------------------------------------------------------------------------------------
// Markdown tables — because one of these three upstreams answers with prose
// ---------------------------------------------------------------------------------------

/**
 * `| A | B |\n| --- | --- |\n| 1 | 2 |` -> `{ headers: ['A','B'], rows: [{A:'1', B:'2'}] }`
 *
 * The insider-trades endpoint is documented as returning "markdown table string", so this is the
 * whole parser for that feed. Written to survive the variations a generator actually produces:
 * leading and trailing pipes optional, alignment row optional and in any of its forms, prose above
 * or below the table ignored, and ragged rows padded rather than dropped.
 *
 * A CELL COUNT THAT DOES NOT MATCH THE HEADER IS NOT A REASON TO DISCARD THE ROW. A trade with one
 * stray pipe in a remark field would vanish silently, and a table quietly one row short looks
 * exactly like a table that is complete. Short rows pad with null; long rows keep the overflow
 * under a numbered key so nothing is thrown away.
 */
export function parseMarkdownTable(md) {
  const text = String(md || '');
  if (!text.trim()) return { headers: [], rows: [] };

  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  const isDivider = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

  const lines = text.split(/\r?\n/);
  // The header is the line immediately above the first alignment row. Finding the table by its
  // divider rather than by "the first line with a pipe" is what lets prose above it be ignored.
  const divider = lines.findIndex((l, i) => i > 0 && isDivider(l) && lines[i - 1].includes('|'));
  if (divider < 1) return { headers: [], rows: [] };

  const headers = cells(lines[divider - 1]).map((h, i) => h || `Column ${i + 1}`);
  const rows = [];
  for (let i = divider + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('|')) {
      if (!line.trim()) continue; // a blank line inside the table is not the end of it
      break; // prose after the table
    }
    if (isDivider(line)) continue;
    const c = cells(line);
    if (!c.length || c.every((x) => !x)) continue;
    const row = {};
    headers.forEach((h, j) => {
      const v = c[j];
      row[h] = v == null || v === '' || v === '-' ? null : v;
    });
    for (let j = headers.length; j < c.length; j++) if (c[j]) row[`Column ${j + 1}`] = c[j];
    rows.push(row);
  }
  return { headers, rows };
}

// ---------------------------------------------------------------------------------------
// The three feeds
// ---------------------------------------------------------------------------------------

/**
 * Find the array of records inside a payload whose envelope we do not know.
 *
 * The documented shapes say "grouped by source" and nothing more, so this walks one level of
 * objects and arrays and collects every object that looks like a record. Order is preserved and the
 * group key travels with each row, because "which source said this" is information and losing it
 * would flatten BSE, NSE and DRHP into one undifferentiated list.
 */
// The keys a group object hides its actual records under. `data` is what the announcements API
// uses; the rest are what a service of this shape uses when it does not.
const NESTED_KEYS = ['data', 'items', 'records', 'results', 'rows', 'announcements', 'articles', 'trades'];

/**
 * Is this a GROUP — a small wrapper whose real content is a nested array — rather than a record?
 *
 * The announcements API answers `[{ source: 'BSE', data: [ … ] }, { source: 'NSE', data: [ … ] }]`,
 * and an earlier version of this function returned those two wrappers AS the records. Every field
 * was then null except `source`, so the tab rendered one row per exchange reading "(no subject)"
 * with no date — a table that looked populated and contained nothing. Descending is the fix, and
 * the test is deliberately narrow: a nested array under a known key, and no more than a couple of
 * other fields beside it, so a genuine record that merely happens to carry an array is not eaten.
 */
function nestedArrayIn(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const key = NESTED_KEYS.find((k) => Array.isArray(r[k]));
  if (!key) return null;
  return Object.keys(r).length <= 3 ? { key, rows: r[key] } : null;
}

export function collectRecords(body, { groupKey = 'source' } = {}) {
  const out = [];
  const push = (arr, group) => {
    for (const r of arr) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      // A group carries its label down onto every record inside it. Losing that would flatten BSE,
      // NSE and DRHP into one undifferentiated list.
      const nested = nestedArrayIn(r);
      if (nested) {
        push(nested.rows, r[groupKey] ?? group);
        continue;
      }
      out.push(group ? { ...r, [groupKey]: r[groupKey] ?? group } : { ...r });
    }
  };

  if (Array.isArray(body)) {
    push(body, null);
    return out;
  }
  if (!body || typeof body !== 'object') return out;

  // A single named array is the common case: { announcements: [...] } / { data: [...] }.
  for (const key of ['data', 'results', 'items', 'records', 'announcements', 'articles', 'news', 'trades', 'rows']) {
    if (Array.isArray(body[key])) {
      push(body[key], null);
      return out;
    }
    // …or that key holds the groups: { data: { bse: [...], nse: [...] } }.
    if (body[key] && typeof body[key] === 'object' && !Array.isArray(body[key])) {
      const inner = body[key];
      const groups = Object.entries(inner).filter(([, v]) => Array.isArray(v));
      if (groups.length) {
        for (const [g, arr] of groups) push(arr, g);
        return out;
      }
    }
  }
  // Otherwise the top level is itself the grouping: { bse: [...], nse: [...], drhp: [...] }.
  for (const [g, v] of Object.entries(body)) if (Array.isArray(v)) push(v, g);
  return out;
}

/**
 * One corporate announcement.
 *
 * `raw` keeps the untouched record so the drill can show every field the upstream sent, including
 * ones this normaliser knows nothing about. That is the difference between a view that degrades
 * when they add a field and one that silently hides it.
 */
export function normaliseAnnouncement(r, ticker = null) {
  const date = isoDate(pickField(r, ['date', 'announcementDate', 'submissionDate', 'dt', 'newsDate', 'an_dt', 'exchdisstime', 'dissemDT', 'timestamp']));
  return {
    ticker: str(pickField(r, ['ticker', 'symbol', 'scrip', 'scripCode'])) || ticker,
    date,
    title: str(pickField(r, ['title', 'headline', 'subject', 'newsSub', 'attachmentName', 'name'])),
    category: str(pickField(r, ['category', 'type', 'newsType', 'subcategory', 'purpose', 'attchmntText'])),
    source: str(pickField(r, ['source', 'exchange', 'group'])),
    // `attachment` is what BSE call the PDF. Learned from the live payload, not guessed.
    url: safeUrl(pickField(r, ['url', 'link', 'attachment', 'attachmentUrl', 'pdfUrl', 'fileUrl', 'attchmntFile', 'href'])),
    summary: str(pickField(r, ['desc', 'description', 'summary', 'body', 'text', 'details', 'more', 'newsBody'])),
    raw: r,
  };
}

/** One news article. Same rules as above; `query` records what was asked, not what was returned. */
/**
 * GLOW: IS THIS HEADLINE ENGLISH? The news search matches a company's bare name, and a short name
 * matches the world: "KSB" brought a Japanese broadcaster (KSB瀬戸内海放送) and an Indonesian
 * outlet, "HFCL" brought Hindi wire copy, "FCONSUMER" a Mexican marketing site. None of it is
 * readable here and none of it is about the holding. Measured on the shipped capture: 155 of
 * 11,868 rows under 79 companies. Four tests, in order, and the first to decide wins:
 *   1. the title or the outlet carries letters from a NON-LATIN script (Devanagari, kana, Han,
 *      Hangul, Arabic, Cyrillic, Thai…) — two or more, so a stray symbol does not decide it → no;
 *   2. the title carries an ENGLISH function word or a word of English financial news → yes.
 *      This is the safety valve for everything below: the list is function words and English
 *      inflections, deliberately NOT the international loanwords (bank, digital, online, update)
 *      that a headline in any language may carry, so a foreign headline cannot pass on those;
 *   3. a LOWER-CASE function word from a Latin-script language that is not English (dengan, dan,
 *      untuk, und, der, les, para, de, el…). Lower case matters: "Dan Bilzerian", "Los Angeles"
 *      and "Die Hard" are proper nouns and keep their rows; a headline is sentence case in every
 *      one of these languages, so its function words are lower case wherever they are not first;
 *   4. two or more LETTERS ENGLISH DOES NOT USE (ı ğ ş ç ñ ã ß ø å, accented vowels — Turkish,
 *      Vietnamese, Polish, Czech), or two or more words from a short list of Indonesian / Malay
 *      headline vocabulary that has no English homograph (pemkab, bupati, sertifikat, tanah…),
 *      for the title-case headlines those languages write, in which no function word appears.
 * A headline that passes may still be unreadable; a headline that fails is never a loss. The
 * scrape applies the same test at capture, so the committed snapshot and the live walk agree.
 */
const NON_LATIN_LETTER = /[\p{L}--\p{Script=Latin}]/gv; // g: count every such letter, not the first
const NON_ENGLISH_LATIN_LETTER = /[\p{Script=Latin}--[A-Za-z]]/gv; // é ü ı ğ ş ñ ã ç ø å ß ł ř…
const ENGLISH_WORDS = /\b(the|and|of|to|in|for|on|with|at|by|from|as|is|are|was|were|be|been|its|it|this|that|these|those|after|before|over|under|amid|says|said|will|would|could|should|can|may|might|has|have|had|up|down|out|new|shares|share|stock|stocks|profit|loss|order|orders|results|result|per|cent|crore|lakh|q[1-4]|buy|sell|sees|see|why|how|what|who|when|where|which|top|best|today|week|year|years|month|months|day|days|market|markets|india|indian|rs|ltd|limited|inc|company|companies|firm|fund|funds|net|revenue|sales|growth|deal|report|reports|announces|launches|plans|set|sets|not|no|vs|or|but|about|into|than|more|most|less|first|last|next|big|high|low|record|strong|weak|investors|investor|analyst|analysts|brokerage|nse|bse|sensex|nifty|ceo|chairman|board|shareholders|dividend|bonus|split|ipo|listing|trade|trading|quarter|fy\d{2,4})\b/i;
// Lower-case only, and never adjacent to another letter (so "Trabzonspor'dan" counts and "dance" does not).
const FOREIGN_WORDS = /(?<![A-Za-z])(dan|yang|untuk|dengan|dari|akan|dalam|pada|tidak|adalah|oleh|juga|telah|bisa|ini|itu|ada|sebagai|karena|hingga|setelah|sudah|masih|lebih|kini|saat|agar|bagi|serta|atau|tapi|namun|jadi|und|der|die|das|mit|für|nicht|auf|ist|eine|ein|zum|zur|von|nach|über|bei|wird|sind|hat|vor|aus|im|am|um|zu|den|dem|wie|noch|auch|nur|oder|aber|les|des|une|pour|dans|avec|est|sur|le|la|du|au|aux|et|à|qui|que|los|las|una|para|con|por|del|como|más|de|el|en|al|se|su|sus|es|uma|não|do|da|dos|das|na|em|ao|é|het|een|van|voor|met|niet|te|bij|ook|wordt|naar|uit|aan|dat|zijn|worden|door|tegen|della|delle|dei|degli|nel|nella|sul|sulla|che|gli|alla|dal|ve|bir|için|ile|olarak|bu|ne|var|yok|oldu|olan|sonra|kadar|ang|mga|ng|sa|katika|kwa)(?![A-Za-z])/;
// Case-insensitive, because these headlines are written in title case; two distinct hits decide.
const INDONESIAN_WORDS = /\b(pemkab|pemprov|pemkot|bupati|gubernur|kabupaten|kecamatan|kelurahan|walikota|polres|polda|polsek|kapolres|kapolda|menteri|kementerian|presiden|wakil|dprd|polri|warga|masyarakat|pemerintah|pemerintahan|kerajaan|negeri|proses|sertifikat|tanah|harga|saham|rupiah|ringgit|ribu|juta|miliar|triliun|diusulkan|asuransi|perikanan|bisnis|perniagaan|syarikat|waspada|pengolah|pemasar|untung|janji|kerja|pekerja|sekolah|siswa|mahasiswa|rumah|sakit|jalan|kota|desa|provinsi|pulau|bandara|pelabuhan|tersangka|korban|kecelakaan|banjir|gempa|kebakaran|hujan|cuaca|prakiraan|dukung|dukungan|tingkatkan|peningkatan|pembangunan|pengembangan|layanan|pelayanan|terkait|resmi|segera|hari|tahun|bulan|orang|dapat|besar)\b/gi;
const countOf = (text, re) => (String(text || '').match(re) || []).length;
export function isEnglishHeadline(title, source = '') {
  const text = String(title || '');
  if (!text.trim()) return true; // nothing to judge; the row is judged on other grounds
  if (countOf(text, NON_LATIN_LETTER) + countOf(source, NON_LATIN_LETTER) >= 2) return false;
  if (ENGLISH_WORDS.test(text)) return true;
  if (FOREIGN_WORDS.test(text)) return false;
  if (countOf(text, NON_ENGLISH_LATIN_LETTER) >= 2) return false;
  const indonesian = new Set((text.match(INDONESIAN_WORDS) || []).map((w) => w.toLowerCase()));
  return indonesian.size < 2;
}

export function normaliseArticle(r, query = null) {
  // The outlet is NESTED: the live payload carries `profile: { name, url }` and no flat publisher
  // field at all, so a top-level lookup finds nothing and every row reads as sourceless.
  const profile = r && typeof r.profile === 'object' && r.profile ? r.profile : null;
  return {
    // `page_age` is the article's own timestamp. `age` beside it is a human string ("2 days ago"),
    // which is deliberately LAST: it parses to nothing, so it only ever confirms there is no date
    // rather than inventing one.
    date: isoDate(pickField(r, ['page_age', 'pageAge', 'date', 'publishedAt', 'published_at', 'published', 'pubDate', 'datetime', 'timestamp'])),
    // The instant, where the upstream gave one — a first-class field precisely so it survives the
    // `raw` strip that `scrape-filings.mjs` does before committing. See `isoInstant`.
    publishedAt: isoInstant(pickField(r, ['page_age', 'pageAge', 'publishedAt', 'published_at', 'published', 'pubDate', 'datetime', 'timestamp'])),
    title: str(pickField(r, ['title', 'headline', 'name'])),
    source: str(pickField(profile, ['name', 'title'])) || str(pickField(r, ['source', 'publisher', 'site', 'domain', 'provider'])),
    url: safeUrl(pickField(r, ['url', 'link', 'href', 'articleUrl'])),
    summary: str(pickField(r, ['description', 'summary', 'snippet', 'content', 'text', 'excerpt'])),
    query,
    raw: r,
  };
}

/**
 * The insider-trades payload, whichever form it arrives in.
 *
 * Documented as a markdown table string, but a service that returns markdown today can return JSON
 * tomorrow, so both are handled and the caller is told which by `format`. The COLUMNS ARE NOT
 * RENAMED: they are carried through exactly as the upstream headed them, because this is somebody
 * else's table and relabelling "Acq/Disp" as "Action" would be our word under their data.
 */
export function normaliseInsiderTrades(body, ticker = null) {
  const markdown = typeof body === 'string' ? body : str(pickField(body, ['markdown', 'table', 'data', 'result', 'text', 'content']));

  if (markdown && markdown.includes('|')) {
    const { headers, rows } = parseMarkdownTable(markdown);
    return {
      format: 'markdown',
      headers,
      rows: rows.map((cells) => ({ ticker, date: isoDate(pickField(cells, DATE_KEYS)), cells, raw: cells })),
    };
  }

  const records = collectRecords(body);
  const headers = [...new Set(records.flatMap((r) => Object.keys(r)))];
  return {
    format: records.length ? 'json' : 'empty',
    headers,
    rows: records.map((r) => ({ ticker: str(pickField(r, ['ticker', 'symbol'])) || ticker, date: isoDate(pickField(r, DATE_KEYS)), cells: r, raw: r })),
  };
}

// The column a date could be under, in either a markdown header or a JSON key. Broad on purpose:
// missing the date column costs the table its sort, and there is no cost to trying another name.
const DATE_KEYS = [
  'date',
  'reportedDate',
  'report date',
  'transactionDate',
  'transaction date',
  'acquisitionDate',
  'disclosureDate',
  'broadcastDate',
  'filingDate',
  'filing date',
  'dt',
  'when',
];

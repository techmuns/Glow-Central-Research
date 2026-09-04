// worker/nse-ann.mjs — NSE's live "latest announcements" feed, company-tagged.
//
// This is the one exchange feed that answers "what did MY companies just file", live. The Muns news
// API is a per-company search (one request each, so it is a scheduled snapshot here), and the BSE
// feed is date-indexed for the whole exchange and committed daily. NSE publishes an RSS of the most
// recent announcements across the exchange, rebuilt every few minutes, and every item names the
// filing company — so it can be resolved to a ticker and narrowed to a reader's Portfolio or
// Watchlist. That is why it exists as its own live surface rather than folding into either.
//
// PURE AND fetchImpl-INJECTED, exactly like worker/mc-news.mjs and worker/rss-news.mjs, so the
// parser and the resolver are testable offline and the same code runs in the Worker and in the
// committed-snapshot scraper.
//
// THE BROWSER CANNOT READ NSE DIRECTLY. Measured: nsearchives.nseindia.com answers
// `access-control-allow-origin: null`, so a page fetch is blocked by CORS. A Cloudflare Worker
// CAN read it — 5/5 at 200 with a full desktop user-agent — so this is proxied through our Worker,
// unlike the chatter API which the browser calls itself. A short/blank user-agent is Akamai-blocked
// (a 430-byte "Access Denied"), so the UA below is not optional.
//
// THE FILENAME PREFIX IS NOT A RELIABLE SYMBOL. Every item links to a PDF whose name usually starts
// with the filer's NSE symbol — but measured on a live pull, only 31% of prefixes were a symbol this
// dashboard knows: the rest are truncations (LAXMI for LAXDENTAL), a different entity's code
// (SAIIM on a Bank of Maharashtra filing), or an XBRL filename with no clean prefix at all. So the
// COMPANY NAME in <title> is the identity, resolved against the universe, and the prefix is only a
// last-resort fallback when it happens to equal a symbol we already know.

export class NseAnnError extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.reason = reason;
    this.detail = detail;
  }
}

export const FEED_URL = 'https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml';

// A full desktop UA is required — Akamai refuses a blank or short one with a 430-byte "Access
// Denied", which is the same trap the Moneycontrol and Mint feeds spring on a weak reader.
export const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  accept: 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+|#\d+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? NAMED[n] ?? m);
}

const el = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')).trim() : null;
};

/** The symbol the filename STARTS with, if any — a candidate, never trusted on its own. */
export function symbolHint(url) {
  const file = String(url || '').split('/').pop() || '';
  const m = /^([A-Za-z0-9&.-]{1,20}?)_\d/.exec(file);
  return m ? m[1].toUpperCase() : null;
}

/** "03-Sep-2026 17:06:55" (IST, no zone) -> ISO. NSE stamps every item, so this rarely returns null. */
export function parsePubDate(raw) {
  if (!raw) return null;
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const mo = months[m[2].toLowerCase()];
  if (!mo) return null;
  // NSE publishes on IST and the stamp carries no zone, so it is read as IST. Reading it as UTC
  // would date every filing 5.5 hours early — the same trap the Investing.com feed sprang.
  const t = Date.parse(`${m[3]}-${mo}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * The SUBJECT the description ends with. NSE writes "<company> has informed the Exchange about
 * <gist> |SUBJECT: <subject>", so the subject after the pipe is the filing's own category — kept
 * verbatim, never re-worded into a category of ours.
 */
export function subjectOf(description) {
  const d = String(description || '');
  const m = /\|SUBJECT:\s*(.+)$/s.exec(d);
  return m ? m[1].trim() : null;
}

/** Every <item>, as neutral rows. No resolution here — that needs the universe, which is injected. */
export function parseAnnouncements(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const it = m[1];
    const company = el(it, 'title');
    // The COMPANY NAME is the identity and the only required field. The URL is not: 214 of 1728 items
    // on a measured pull were exchange surveillance notices ("Significant movement in price has been
    // observed in <company>") filed with an empty <link/>. Those are real announcements about the
    // company — dropping them for want of a document would hide the exact rows a reader most wants to
    // see on their holdings. A row with no link renders without an "open filing" action, the same way
    // the market-news list keeps a story whose URL it cannot use.
    if (!company) continue;
    const url = el(it, 'link') || null;
    const description = el(it, 'description');
    out.push({
      company,
      url,
      subject: subjectOf(description),
      description,
      publishedAt: parsePubDate(el(it, 'pubDate')),
      symbolHint: symbolHint(url),
    });
  }
  return out;
}

/**
 * A 200 that is not the feed is not an empty news day.
 *
 * Akamai's refusal is a tiny "Access Denied" HTML page served with status 200 sometimes and 403
 * others; either way it carries no <item> and no RSS root. The Moneycontrol lesson, applied before
 * it can cost anything: a body with an RSS root but zero items is a real (rare) empty feed; a body
 * with neither is a refusal wearing whatever status it came with.
 */
export function assertShape(xml, { status = 200 } = {}) {
  const s = String(xml || '');
  const bytes = s.length;
  const items = (s.match(/<item[\s>]/gi) || []).length;
  if (items > 0) return items;
  if (/Access Denied|errors\.edgesuite\.net/i.test(s)) {
    throw new NseAnnError('blocked', `NSE refused this reader (Access Denied) — ${bytes} bytes, status ${status}.`, { status, bytes });
  }
  if (!/<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/i.test(s)) {
    throw new NseAnnError('blocked', `NSE returned ${bytes} bytes that are not an RSS document — a refusal, not an empty feed.`, { status, bytes });
  }
  throw new NseAnnError('shape', `NSE returned a well-formed feed with zero items in ${bytes} bytes.`, { status, bytes });
}

// ---------------------------------------------------------------------------------------
// RESOLUTION — company name -> NSE symbol, so a filing can be narrowed to a reader's scope
// ---------------------------------------------------------------------------------------
//
// NORMALISED-NAME MATCH, with the FILENAME PREFIX as a last resort. Building a token-wise index
// (scripts/lib/company-index.mjs) is the heavier, fuzzier tool the offline scrapers use; here the
// need is exact enough that a normalised exact match carries it — company suffixes stripped, case
// and punctuation folded, HTML entities decoded (measured: "Mahindra &amp; Mahindra" failed to
// resolve until `&amp;` was decoded). A name that does not resolve keeps `ticker: null` and its
// company name: it still shows in Universe, exactly as an unresolved row does on every other feed,
// and it simply cannot appear under a narrowed scope because nothing says which company it is.

const SUFFIX = /\b(limited|ltd|private|pvt|corporation|corp|company|co|the|and|&)\b/gi;

/** Fold a company name to a comparison key. */
export function nameKey(name) {
  return decodeEntities(name)
    .toLowerCase()
    .replace(/&amp;/g, ' ')
    .replace(SUFFIX, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Build the resolver from the data files this dashboard already ships.
 *
 * `nameToTicker` is every name we can name — the book's own names first (so a book company always
 * wins its own ticker), then mc-ticker-map's full names, then the technicals universe. `symbols`
 * is every ticker we know, for validating a filename prefix before trusting it.
 */
export function buildResolver({ book = [], mcMap = {}, tech = [] } = {}) {
  const nameToTicker = new Map();
  const symbols = new Set();
  const add = (name, ticker) => {
    if (!name || !ticker) return;
    const k = nameKey(name);
    if (k && !nameToTicker.has(k)) nameToTicker.set(k, ticker.toUpperCase());
  };
  // Book first — its names are hand-checked and it is the Portfolio scope, so it must never lose
  // its own ticker to a same-key collision from a broader feed.
  for (const c of book) {
    if (!c?.ticker) continue;
    symbols.add(c.ticker.toUpperCase());
    add(c.name, c.ticker);
    add(c.bookName, c.ticker);
    add(c.matchedName, c.ticker);
  }
  for (const k in mcMap) {
    const e = mcMap[k];
    if (e?.ticker) { symbols.add(e.ticker.toUpperCase()); add(e.fullName, e.ticker); }
  }
  for (const r of tech) {
    if (r?.ticker) { symbols.add(r.ticker.toUpperCase()); add(r.name, r.ticker); }
  }
  return { nameToTicker, symbols };
}

/** Resolve one row in place-ish: returns a new row with `ticker` and `resolvedBy`. */
export function resolveRow(row, resolver) {
  const byName = resolver.nameToTicker.get(nameKey(row.company));
  if (byName) return { ...row, ticker: byName, resolvedBy: 'name' };
  if (row.symbolHint && resolver.symbols.has(row.symbolHint)) return { ...row, ticker: row.symbolHint, resolvedBy: 'filename' };
  return { ...row, ticker: null, resolvedBy: null };
}

export function resolveAll(rows, resolver) {
  return rows.map((r) => resolveRow(r, resolver));
}

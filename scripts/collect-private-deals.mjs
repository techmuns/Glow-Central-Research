#!/usr/bin/env node
// GLOW-OWNED. Private Market deal sourcing — funding rounds and M&A read from many publishers.
//
// Reads every feed in DEAL_FEEDS (public RSS: Inc42, Entrackr, YourStory, Economic Times, Hindustan
// Times, Times of India, Mint, Business Standard, BusinessLine, TechCrunch, Tech in Asia, plus Google
// News searches that bring in Moneycontrol, VCCircle and other desks without a usable feed), reads a
// deal out of each headline with the shared rules in public/js/data/private-deals-shared.js, and
// MERGES the reports into public/data/private-deals.json. Nothing is deleted: a report once captured
// stays, so the history only grows. The browser folds these reports, together with Inc42's weekly
// Funding Galore table, into one row per deal.
//
// curl, not fetch: Mint and Economic Times refuse node's fetch with a 24-byte 403 (see worker/rss-news.mjs).
// Exit 0 wrote (or nothing new), 2 every feed failed (the committed file is untouched), 1 a real fault.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { decodeEntities, publishedAtFrom } from '../worker/rss-news.mjs';
import { DEAL_FEEDS, extractDeal, inIndia, credibilityOf, companyKey } from '../public/js/data/private-deals-shared.js';

const execFileP = promisify(execFile);
const FILE = path.resolve(process.env.PRIVATE_DEALS_FILE || 'public/data/private-deals.json');
const MAX_AGE_DAYS = 45;       // a search result older than this is history, not this week's flow
const KEEP = 25000;            // a bytes ceiling (~600 bytes a report), newest kept
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function curlFetch(url) {
  const args = ['-sS', '--compressed', '--max-time', '40', '-L', '--max-redirs', '3', '-A', UA, '-H', 'accept: application/rss+xml,application/xml;q=0.9,*/*;q=0.8', '-w', '\n%{http_code}', url];
  try {
    const { stdout } = await execFileP('curl', args, { maxBuffer: 32 * 1024 * 1024 });
    const cut = stdout.lastIndexOf('\n');
    return { status: Number(stdout.slice(cut + 1).trim()) || 0, body: stdout.slice(0, Math.max(0, cut)) };
  } catch (error) { return { status: 0, body: '', error: String(error?.message || error).slice(0, 200) }; }
}

const text = (xml, tag) => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!m) return '';
  return decodeEntities(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

/** Every <item> as { title, url, summary, publishedAt, publisher }. Google News names the real publisher. */
export function parseItems(xml, feed) {
  const out = [];
  for (const m of String(xml).matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const it = m[1];
    let title = text(it, 'title'), url = text(it, 'link');
    if (!title || !/^https:\/\//i.test(url)) continue;
    let publisher = feed.publisher;
    const summary = feed.google ? '' : text(it, 'description');
    if (feed.google) {
      publisher = text(it, 'source');
      if (!publisher) continue;
      const suffix = ` - ${publisher}`;
      if (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
    }
    out.push({ title, url, summary, publishedAt: publishedAtFrom(it), publisher });
  }
  return out;
}

export function listedNames() {
  const keys = new Set();
  try { for (const v of Object.values(JSON.parse(fs.readFileSync('public/data/mc-ticker-map.json')).map || {})) if (v?.fullName) keys.add(companyKey(v.fullName)); } catch {}
  try { for (const v of JSON.parse(fs.readFileSync('public/data/universe.json'))) if (v?.Company) keys.add(companyKey(v.Company)); } catch {}
  return keys;
}

/** One report -> one observation, or a reason it is not one. */
export function observe(item, feed, { listed = new Set(), now = Date.now() } = {}) {
  const at = Date.parse(item.publishedAt || '');
  if (Number.isFinite(at) && now - at > MAX_AGE_DAYS * 86400000) return { skip: 'old' };
  const deal = extractDeal(item.title, item.summary);
  if (!deal) return { skip: 'not-a-deal' };
  const cred = credibilityOf(item.publisher);
  if (!inIndia(item.title, item.summary, cred.id, { ...deal, publisher: item.publisher, indiaFeed: !!feed.india })) return { skip: 'not-india' };
  const key = companyKey(deal.company);
  if (listed.has(key)) return { skip: 'listed' };
  const day = Number.isFinite(at) ? new Date(at + 19800000).toISOString().slice(0, 10) : null;
  const id = createHash('sha256').update(`${item.url}\n${deal.kind}\n${key}`).digest('hex').slice(0, 24);
  const { subject, ...fields } = deal;
  return { observation: { id, ...fields, date: day, publisher: cred.publisher === 'Unknown publisher' ? item.publisher : (cred.id === 'other' ? item.publisher : cred.publisher), credibility: cred.score, sourceId: cred.id, url: item.url, title: item.title, publishedAt: Number.isFinite(at) ? new Date(at).toISOString() : null, feed: feed.id, origin: 'news' } };
}

export function emptyCapture() { return { version: 1, generatedAt: null, feeds: [], observations: [] }; }

export async function collect(state, { fetcher = curlFetch, now = () => new Date().toISOString(), feeds = DEAL_FEEDS, listed = listedNames(), gapMs = 400 } = {}) {
  const held = new Map(state.observations.map(o => [o.id, o]));
  const report = [];
  let added = 0, ok = 0;
  for (const feed of feeds) {
    const res = await fetcher(feed.url);
    const entry = { id: feed.id, publisher: feed.publisher, checkedAt: now(), status: res.status, ok: false, items: 0, deals: 0, added: 0, error: null };
    if (res.status >= 200 && res.status < 300 && /<item[\s>]/i.test(res.body)) {
      const items = parseItems(res.body, feed);
      entry.ok = true; entry.items = items.length; ok++;
      for (const item of items) {
        const r = observe(item, feed, { listed, now: Date.parse(now()) });
        if (!r.observation) continue;
        entry.deals++;
        const before = held.get(r.observation.id);
        if (!before) { held.set(r.observation.id, { ...r.observation, firstSeenAt: now() }); entry.added++; added++; }
      }
    } else entry.error = res.error || (res.status ? `HTTP ${res.status}` : 'unreachable') + (res.status === 200 ? ' — not an RSS document' : '');
    report.push(entry);
    console.log(`${feed.id.padEnd(20)} ${entry.ok ? `${String(entry.items).padStart(3)} items · ${String(entry.deals).padStart(3)} deals · ${entry.added} new` : `FAILED ${entry.error}`}`);
    if (gapMs) await new Promise(r => setTimeout(r, gapMs));
  }
  const observations = [...held.values()].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.id.localeCompare(b.id)).slice(0, KEEP);
  // A failed feed keeps its last good check time, so the page can say how old that source's read is.
  const previous = new Map((state.feeds || []).map(f => [f.id, f]));
  const feedsOut = report.map(f => ({ ...f, lastOkAt: f.ok ? f.checkedAt : previous.get(f.id)?.lastOkAt || null }));
  return { state: { version: 1, generatedAt: now(), feeds: feedsOut, observations }, added, ok };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const state = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : emptyCapture();
  if (state.version !== 1 || !Array.isArray(state.observations)) { console.error('Unreadable private-deals capture; refusing to overwrite.'); process.exit(1); }
  const { state: next, added, ok } = await collect(state);
  if (!ok) { console.error('Every deal feed failed; the committed capture is unchanged.'); process.exit(2); }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(next)); fs.renameSync(FILE + '.tmp', FILE);
  console.log(JSON.stringify({ feedsRead: ok, feeds: next.feeds.length, added, observations: next.observations.length }));
}

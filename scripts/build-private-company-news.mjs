#!/usr/bin/env node
// HEADLINES THAT NAME THE FAMILY'S PRIVATE COMPANIES (GLOW-OWNED) → public/data/private-company-news.json
//
// AI Alerts shows private companies the way it shows listed ones, and the evidence for a private
// company is mostly a headline. The committed market-news capture (head + monthly archive, ~31 MB)
// is far too large for the browser to read on every AI Alerts open, so the join is done here, once
// per capture, and the browser reads this small file. Nothing is fetched: it reads the committed
// news capture and the private companies build-book.mjs published.
//
// A match is the company's reviewed name written as a proper noun in the HEADLINE
// (`privateHeadlineMatcher`) — never the standfirst, never a fuzzy match. It is a name in a
// headline, not a verified event, and every row says which name matched.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEverything } from './lib/news-store.mjs';
import { readPrivateCompanies, privateHeadlineMatcher } from '../public/js/data/private-companies.js';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = process.env.PRIVATE_NEWS_OUT || resolve(ROOT, 'public/data/private-company-news.json');
const KEEP_DAYS = Number(process.env.PRIVATE_NEWS_DAYS || 120);

const companiesFile = resolve(ROOT, 'public/data/portfolio-companies.json');
const list = JSON.parse(readFileSync(companiesFile, 'utf8'));
const companies = readPrivateCompanies(list);
const { head, all } = loadEverything();
const now = Date.now(), floor = now - KEEP_DAYS * 86400000;
const match = privateHeadlineMatcher(companies);

const events = [];
for (const article of all.values()) {
  const at = article.publishedAt || null;
  const seen = Date.parse(at || article.firstSeenAt || '');
  if (!Number.isFinite(seen) || seen < floor || seen > now + 600000) continue;
  for (const company of match(article.title || '')) {
    events.push({
      id: `pcn:${article.id || article.url}:${company.id}`,
      entityId: company.id, company: company.name, categories: company.categories,
      at, firstSeenAt: article.firstSeenAt || null,
      title: String(article.title || '').slice(0, 400),
      summary: String(article.summary || '').slice(0, 400),
      url: article.url || null, publisher: article.publisher || article.source || null,
    });
  }
}
const stamp = (e) => e.at || e.firstSeenAt || '';
events.sort((a, b) => stamp(b).localeCompare(stamp(a)) || a.id.localeCompare(b.id));

const out = {
  _provenance: 'Headlines from the committed market-news capture that name one of the family’s private companies (portfolio-companies.json → privateCompanies, from the GlowVentures book), matched by reviewed name as a proper noun in the headline. A name in a headline, not a verified event. Built by scripts/build-private-company-news.mjs; read by AI Alerts.',
  version: 1,
  newsCapturedAt: head.capturedAt || null,
  bookAsOf: list.asOf || null,
  companies: companies.length,
  windowDays: KEEP_DAYS,
  events,
};
// The build time changes on every run; write only when the content moved, so a quiet hour commits nothing.
const content = (value) => JSON.stringify({ ...value, generatedAt: undefined });
const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
if (previous && content(previous) === content(out)) {
  console.log(`private-company-news.json unchanged: ${events.length} headline(s) naming ${new Set(events.map((e) => e.entityId)).size} of ${companies.length} private companies`);
} else {
  writeFileSync(`${OUT}.tmp`, `${JSON.stringify({ ...out, generatedAt: new Date(now).toISOString() }, null, 1)}\n`);
  renameSync(`${OUT}.tmp`, OUT);
  console.log(`private-company-news.json: ${events.length} headline(s) naming ${new Set(events.map((e) => e.entityId)).size} of ${companies.length} private companies, last ${KEEP_DAYS} days → ${OUT}`);
}

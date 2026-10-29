#!/usr/bin/env node
// Read-only local production-data retrieval. No API or actual model calls.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { researchLocalBrowser } from './lib/research-local-browser.mjs';
const book = JSON.parse(readFileSync(new URL('../public/data/portfolio-companies.json', import.meta.url)));
const heldTickers = new Set(book.holdings.map(h => h.ticker).filter(Boolean));
// The peer question must name a company the synced book HOLDS: a peer anchor outside it has no
// held comparables and correctly falls back to portfolio reasoning, which is how this check broke
// when Birla Cable left the book on 28 October 2026. So the anchor is read from the book rather
// than named here, and the next held company is tried when one has no source-backed comparison.
const peerAnchors = book.holdings.filter(h => h.ticker && h.listed !== false)
  .sort((a, b) => a.ticker.localeCompare(b.ticker))
  .map(h => ({ ticker: h.ticker, name: h.name.replace(/\s+(?:Ltd|Limited)\.?$/i, '') }));
const PEER_ATTEMPTS = 5;
const h = await researchLocalBrowser();
try {
  const report = await h.page.evaluate(async ({ peerAnchors, attempts }) => {
    const { researchEvidenceChars } = await import('/js/research/evidence-shared.js');
    const { researchPreview } = await import('/js/research/preview.js');
    const questions = [
      'If crude oil prices fall, which portfolio companies could benefit or be hurt?',
      'If interest rates fall, which of my portfolio companies have upside and what could offset it?',
      'Which portfolio companies are exposed to a weaker rupee, positively or negatively?',
      'PEER_QUESTION',
      'Which portfolio companies depend on the same customer demand and could disappoint together?',
      'Which portfolio companies have improving earnings but conflicting risks in public chatter?',
    ];
    const cases = [];
    const retrieve = async (question, extra = {}) => {
      const start = performance.now();
      const evidence = await research.buildResearchEvidence({ question, prepared, scope: 'portfolio' });
      return { question, ...extra, ms: Math.round(performance.now() - start), chars: researchEvidenceChars(evidence),
        companies: evidence.selection.companies, context: evidence.businessContext, sourceIds:research.DASHBOARD_RESEARCH_SOURCES.map(s=>s.id),
        evidence, sources: evidence.sources.map(s => ({ id: s.id, status: s.status, count: s.rows.length })), preview: researchPreview(evidence) };
    };
    for (const question of questions) {
      if (question !== 'PEER_QUESTION') { cases.push(await retrieve(question)); continue; }
      let peer;
      for (const anchor of peerAnchors.slice(0, attempts)) {
        peer = await retrieve(`Which portfolio companies have businesses similar to ${anchor.name}?`, { anchor: anchor.ticker });
        if (peer.context?.kind === 'source-backed-business-comparison' && peer.context.references.some(r => r.ticker === anchor.ticker && r.evidence.length)) break;
      }
      cases.push(peer);
    }
    return cases;
  }, { peerAnchors, attempts: PEER_ATTEMPTS });
  for (const r of report) {
    const expectedKind = r.question.includes('similar to') ? 'source-backed-business-comparison' : 'portfolio-reasoning';
    assert.equal(r.context.kind, expectedKind, r.anchor ? `${r.question} (no source-backed comparison for the first ${PEER_ATTEMPTS} held anchors)` : r.question);
    if (r.context.kind === 'portfolio-reasoning') {
      assert.equal(r.context.businessProfiles.total, book.holdings.length);
      assert.equal(r.context.businessProfiles.omitted, 0);
      assert.equal(r.context.businessProfiles.rows.length, book.holdings.length);
      assert.deepEqual(new Set(r.context.businessProfiles.rows.map(p => p[0])), new Set(book.holdings.map(h => h.ticker || h.isin)));
      assert(r.context.businessProfiles.analyses.rows.length > 0, 'business map must carry source-backed analysis, not only sector labels');
    } else {
      assert.equal(r.context.holdingsExamined, book.holdings.length);
      assert(r.context.candidatesFound >= r.context.candidates.length);
      assert.match(r.context.sourceCoverage, /no match is not proof/);
    }
    assert(r.context.candidates.every(c => c.weightPct === null));
    assert(r.context.candidates.every(c => heldTickers.has(c.ticker)), 'reasoning must use Glow holdings');
    assert.match(r.context.holdingsBasis, /ownership and weights not established/);
    assert.deepEqual(r.sources.map(s=>s.id).sort(), r.sourceIds.sort());
    assert(r.sources.some(s => s.count));
    assert(r.chars <= 30000);
    assert(r.preview.items.every(p => p.kind === 'excerpt' || p.kind === 'headline'));
    assert(r.context.candidates.every(c => c.evidence.every(e => e.tab && e.text && e.sourceStatus)));
  }
  assert.deepEqual(report[0].companies, [], 'crude oil must not resolve to Oil India');
  if (heldTickers.has('MRPL')) assert(report[0].context.candidates.some(c => c.ticker === 'MRPL'), 'actual crude sourcing evidence must survive');
  assert(!report[0].context.candidates.some(c => c.ticker === 'HDFCBANK'), 'a market-wrap co-mention is not oil exposure');
  if (heldTickers.has('SAMMAANCAP')) assert(report[1].context.businessProfiles.analyses.rows.some(p => p[0] === 'SAMMAANCAP' && p[2]), 'the model must see funding analysis beyond lexical leaders');
  assert(report[3].context.references.some(r => r.ticker === report[3].anchor && r.evidence.length), `the Glow peer anchor ${report[3].anchor} needs source-linked business evidence`);
  if (process.env.RESEARCH_EVAL_EXPORT) {
    const checkedAt = new Date().toISOString();
    const tests = report.map((r, i) => {
      const evidence = r.evidence;
      evidence.portfolio = { status: 'limited', mode: 'public-snapshot-fixture', checkedAt, archiveVersion: 1, bookAsOf: book.asOf,
        answer: 'Saved public identity snapshot for evaluation. Current ownership, actual weights and quotes are unavailable.' };
      evidence.portfolioPositions = { sizes: { basis: 'listed-market-value', complete: false, checkedAt, archiveVersion: 1, bookAsOf: book.asOf,
        quotes: { asOf: null, status: 'unavailable', priced: 0, notLive: book.holdings.length } }, holdings: book.holdings.map(h => ({ isin: h.isin, ticker: h.ticker, name: h.name, sector: h.sector, weightPct: null })) };
      return { id: ['oil', 'rates', 'currency', 'peers', 'demand', 'conflicts'][i], question: r.question,
        must: [], forbidden: ['public-snapshot-fixture', 'industrySourceIndex'],
        body: { question: r.question, requirePortfolio: true, scope: 'portfolio', history: [], evidence },
        review: 'Check relevance, dates, exact source citations, opposing mechanisms, conditional vs realised benefits, missing inputs, legal-entity attribution, and unknown actual ownership. Keyword checks are not a quality pass.' };
    });
    writeFileSync(process.env.RESEARCH_EVAL_EXPORT, JSON.stringify({ kind: 'public-snapshot-fixture', tests }, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify({ pass: true, cases: report.map(r => ({ question: r.question, retrievalMs: r.ms, chars: r.chars, holdings: r.context.businessProfiles ? r.context.businessProfiles.rows.length : r.context.holdingsExamined, candidates: r.context.candidates.map(c => c.ticker) })) }, null, 2));
} finally { await h.close(); }

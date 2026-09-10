#!/usr/bin/env node
// Whole saved dashboard regression for the customer's Sterlite peer questions.
// API and external requests are blocked; this never queries the live portfolio or model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { researchLocalBrowser } from './lib/research-local-browser.mjs';
const book = JSON.parse(readFileSync(new URL('./fixtures/template-portfolio-companies.json', import.meta.url)));
const harness = await researchLocalBrowser({ intercept: (route, url) => {
  if (url.pathname !== '/data/portfolio-companies.json') return false;
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(book) }).then(() => true);
} });
try {
  const report = await harness.page.evaluate(async () => {
    const { providerEvidence, researchEvidenceChars } = await import('/js/research/evidence-shared.js');
    const { researchPreview } = await import('/js/research/preview.js');
    const questions = [
      'Which are my ai related stocks and how are they performing after sterlite news?',
      'the benefit that sterlite comparable business which other stocks in my portfolio have got benefit',
      'Which other portfolio stocks could benefit?',
      'Latest news on Sterlite?',
    ];
    const results = [];
    for (const question of questions) {
      const started = performance.now();
      const packet = await research.buildResearchEvidence({ question, prepared, scope: 'portfolio',
        history: [{ role: 'user', text: 'Latest Sterlite news?' }] });
      // WHAT THE COMPARISON FOUND AND WHAT SURVIVED THE BYTE FIT ARE TWO QUESTIONS, so this asks
      // them separately. The shipped packet above is the one the model receives, fitted to the
      // production budget; `retrieved` re-runs the same retrieval with room to spare, so the
      // candidate list can be read before `fitBusinessContext` trims it to fit. Asking only the
      // first is what made this suite depend on where a byte boundary fell - see the note on the
      // assertions below.
      const retrieved = await research.buildResearchEvidence({ question, prepared, scope: 'portfolio',
        history: [{ role: 'user', text: 'Latest Sterlite news?' }], charBudget: 200000 });
      results.push({ question, ms: Math.round(performance.now() - started), chars: researchEvidenceChars(packet),
        context: providerEvidence(packet).businessContext, companies: packet.selection.companies,
        found: providerEvidence(retrieved).businessContext?.candidates.map(c => c.ticker) || [],
        foundOmitted: providerEvidence(retrieved).businessContext?.candidatesOmitted ?? 0,
        sources: packet.sources.map(s => ({ id: s.id, status: s.status, rows: s.rows.length })), preview: researchPreview(packet) });
    }
    return results;
  });
  for (const row of report.slice(0, 3)) {
    assert(row.chars <= 18000);
    assert.deepEqual(row.companies.map(c => c.ticker), ['STLTECH']);
    // ASK WHETHER THE COMPARISON FOUND THE COMPANY, NOT WHETHER ITS EXCERPTS SURVIVED THE TRIM.
    // These read `row.context.candidates` - the list AFTER the fit - so they asserted where a byte
    // boundary happened to fall on the day the suite ran. Measured: the comparison found 24
    // comparable companies and the budget kept two, Tejas being the second. A capture carrying
    // MORE Tejas coverage than the day before (42 rows against 20) grew the packet, popped one
    // more candidate, and the richer capture read as missing evidence - the suite failing because
    // the data got better. `found` is the same retrieval with room to spare, so what the
    // comparison discovered is asserted against the comparison rather than against the budget.
    // ROOM TO SPARE IS A CLAIM AND IS CHECKED. If the wider budget ever starts trimming too, this
    // list stops being the full retrieval and these assertions quietly become the byte-boundary
    // bet they replaced - so the suite fails here instead, naming the budget rather than a company.
    assert.equal(row.foundOmitted, 0, 'the wider retrieval must trim nothing; raise its budget');
    assert(row.found.includes('HFCL'), `${row.question}: HFCL evidence missing`);
    assert(row.found.includes('TEJASNET'), `${row.question}: Tejas evidence missing`);
    assert(!row.found.includes('HDFCBANK'), 'emoji round-up must not invent a bank telecom business');
    assert(row.found.every(t => t !== 'STLTECH'));
    // The fitted packet is still checked - it must carry evidenced candidates, in the same rank
    // order, and never a company the retrieval did not find.
    assert(row.context.candidates.length, 'the fitted comparison keeps at least one company');
    assert(row.context.candidates.every(c => row.found.includes(c.ticker)), 'the fit adds no company');
    assert.deepEqual(row.context.candidates.map(c => c.ticker), row.found.slice(0, row.context.candidates.length),
      'the fit keeps the highest-ranked companies, in rank order');
    assert.equal(row.found[0], 'HFCL', 'fibre product overlap should lead broad AI activity');
    assert.equal(row.context.holdingsExamined, book.holdings.length);
    assert.match(row.context.holdingsBasis, /ownership and weights not established/);
    assert(row.context.candidates.every(c => c.weightPct === null));
    assert(row.sources.some(s => s.id === 'portfolio'), 'the shared sources include Glow Family Book');
    assert(!row.sources.some(s => s.id === 'earnings-surprise'), 'the retired estimates view is not a research source');
    assert(row.sources.reduce((n, s) => n + s.rows, 0) >= 3, 'comparison cannot crowd out all original feed rows');
    // The preview quotes literal excerpts and is capped at three, so naming a SECOND company in it
    // is the same byte-boundary bet as the candidates were. What must hold is that it previews
    // only companies whose evidence is in the fitted packet - never one the fit dropped.
    assert(row.preview.items.some(p => p.ticker === 'HFCL'));
    const evidenced = row.context.candidates.map(c => c.ticker);
    const droppedByFit = row.found.filter(t => !evidenced.includes(t));
    assert(row.preview.items.every(p => !droppedByFit.includes(p.ticker)),
      'a company the fit dropped has no excerpt in the packet and must not be previewed');
    assert(row.context.candidates.every(c => c.evidence.length && c.evidence.every(e => e.tab && e.text && e.sourceStatus)));
  }
  assert(!report[3].context, 'ordinary single-company research is unchanged');
  console.log(JSON.stringify({ pass: true, cases: report.map(r => ({ question: r.question, retrievalMs: r.ms,
    evidenceChars: r.chars, found: r.found, candidates: r.context?.candidates.map(c => c.ticker), preview: r.preview.items.map(p => p.ticker) })) }, null, 2));
} finally { await harness.close(); }

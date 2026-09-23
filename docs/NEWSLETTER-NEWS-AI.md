# Grounded news summaries and OpenAI cost control

This extends the source-reading work in `NEWSLETTER-SOURCE-CONTENT.md`. The configured
`NEWSLETTER_NEWS_AI_PROVIDER=openai` route uses the Worker's `OPENAI_API_KEY` for news only.
The existing Claude/Bedrock filing/PDF reader and filing writer remain separate. No secret is
stored in source, sent to publishers, exposed by an endpoint, or copied into the job ledger.

## Evidence and output

The original publisher headline and link remain visible. Accessible, identified article bodies
are read before an AI note is allowed. Ticker tags alone cannot establish company relevance.
The model identifies the company, product and role (applicant, subject or participant), extracts
supporting passages, and writes the note in the same request. Quotes must occur in the received
article, the company/product relationship must be explicit in a quoted passage, figures must be
supported, and the summary must identify the company and affected product. Partial/paywalled
articles remain partial without a generated note. A copied publisher subtitle is never called AI.

GPT-6 Luna handles the first pass with reasoning disabled. GPT-6 Sol independently checks the
whole article and draft for multi-event stories, investigations/allegations/denials, headlines
without the company, failed grounding checks, or any proposed impact statement. The reviewer may
correct the output or withhold it. It is not gated solely by the cheap model's confidence.
Both models use the Responses API, strict JSON schema, no tools, `store:false`, Standard service,
and a maximum of 2,200 output tokens per article pass. Errors and incomplete replies withhold the
note; there is no automatic fallback to an unbudgeted provider.

Potential impact is optional and omitted when unsupported. Trade-remedy stories use the neutral
**Trade policy** topic, so a probe requested by a producer does not imply trouble at that producer.
DCW's complaint regression distinguishes Avid Organics' glycine investigation from DCW/Epigral/
Lubrizol's CPVC anti-circumvention application. An investigation is not a final duty decision.
The original headline can describe the other event; the company-specific AI note makes the
relevant connection explicit.

News notes are saved with the durable source job and reused across editions. A separate cache
keys the complete input article, issuer, headline, models and policy version; changed source text
cannot reuse an old answer. Completed but rejected company-evidence assessments are also cached,
so an unchanged article does not repeatedly spend credits trying to produce a publishable answer.
Provider failures remain retryable; changed article text or policy creates a fresh assessment. The news identity version advances while filing identities remain
unchanged. Existing completed article jobs are not paid for again on every send. News-only grouped
updates use the lead article's cached note and explicitly say linked reports may add details;
all original sources remain visible. Filing writing continues to consider its grouped evidence.
Unchanged-URL article corrections that do not change captured feed text remain a limitation of
the underlying discovery queue; this change does not add universal article recrawling.

## Spending and recovery

`NewsletterNewsBudget` uses the existing newsletter Durable Object's SQLite database. It admits
at most **$1 per IST day and $25 per IST calendar month** for news reading, review and semantic
grouping together. It reserves a conservative request cost in a transaction *before* network I/O,
so concurrent wakes and restarts cannot each spend the whole allowance. Each request uses the
ledger’s current clock, so a batch crossing midnight cannot charge later calls to the prior day. Failed or interrupted
requests without usage keep their full reservation. Completed requests use total input/output
usage, including reasoning tokens and the 25% cache-write input premium. No cache-read discount
is assumed; missing cache-write details conservatively price all input at the higher rate. Three calls per request identity
per day bound retries. A missing budget fails closed. Budget-limited content jobs remain pending,
retain their source links and retry automatically; news collection and history are unaffected.

Prices checked 24 September 2026: Luna $0.10/$0.50 and Sol $2/$10 per million input/output tokens.
Admission uses UTF-8 request bytes plus protocol allowance as an upper input-token bound and the
maximum output allowance, with all input reserved at the 1.25x cache-write rate. Requests are limited below long-context pricing thresholds. The ledger
is a conservative application estimate, not an invoice or an OpenAI account-wide spending cap.
It excludes filing/PDF processing, Ask Research, hosting, taxes and unrelated API use. Price changes
require updating the allow-listed rates before changing models. Unknown models fail closed.

The existing newsletter status exposes `newsAi` with configured state, IST periods, caps and used
amounts (including uncertain reservations). Public previews read state but make no model calls.
They still do not display final AI notes; shared dashboard summaries remain outside this change.
Normal merge-triggered deployment makes the code available to existing scheduled work. No manual
production send, backfill, restart or deployment is part of this implementation.

## Validation

`node scripts/verify-newsletter-openai.mjs` tests the DCW reproducer, company/product rejection,
stronger review, unsupported impact omission, reuse, correction identities, daily/monthly limits,
concurrent reservations, restarts, failure accounting, access restrictions, source credential
isolation, grouping cache and zero paid preview calls. Existing newsletter, content, event and UI
checks remain required. Fixture replies test these contracts, not the statistical accuracy of a
model. Live checks use an isolated Cloudflare remote-development preview with no production data
bindings and no email route; only OpenAI receives the stored key. Limited examples do not establish
accuracy across all articles, and source capture is not an exhaustive news archive.

Live validation on 24 September 2026: the stored key completed a minimal Luna request (13 input,
5 output tokens). The full source-reading prompts were exercised on DCW and six additional
accessible publisher reports. The final DCW run identified CPVC and applicant status, preserved
that this was an investigation rather than a finding, and omitted impact (approximately 1.1 cents at uncached input rates, before any cache-write adjustment). An Engineers India contract case passed after adding source-defined abbreviation
support (approximately 0.9 cents at uncached input rates). A Jindal Stainless/Nasscom case used Luna alone; two Vedanta
entity-mismatch cases were withheld. These are a small diagnostic sample, not an accuracy rate
or an estimate of future daily volume. Test output and article bodies were kept outside the repo.

Official references:
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/api/docs/models/gpt-6-sol
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://developers.openai.com/api/docs/guides/prompt-caching
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync

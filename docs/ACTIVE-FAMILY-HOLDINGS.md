# Active Family Office holdings

## Why this changes the connection

Family Office rebuilds its on-screen holdings from the newest eligible uploaded workbook.
`src/data/sattvaData.ts` is only its built-in baseline, not the updated portfolio. Research
Central must not read that file as a current sync source.

The Family Office companion change adds `GET /api/research-holdings`. It uses the same
workbook-selection and open-lot parser as the screen, deduplicates equity ISINs, and exports
only names, sectors and provenance. The response never carries quantities, values or accounts.

Research's `GET /api/family-portfolio` authenticates to that fixed route server-side and uses
the same resolver as the scheduled snapshot. The browser checks it on load, once per minute
while visible and on Refresh. A workbook replacement replaces membership: sold holdings are
not unioned back in from old periods. Missing ticker mappings remain held-but-uncovered.

The dashboard renders its saved list immediately and labels it as a snapshot while checking.
A failed read preserves the last good browser cache and displays an explicit warning. The
source workbook and last successful check are visible beside the Portfolio controls. Existing
browser-local manual overrides remain local; the label identifies when they are present.

## Activation — requires approval of both PRs and the exact production actions

No production credentials, runs or deployments are changed by these PRs themselves.

1. Deploy the companion Family Office PR after approval. Keep its existing `AUDIT` KV binding.
2. Generate a dedicated random secret of at least 32 characters using a password manager.
   Store the same value as `RESEARCH_HOLDINGS_TOKEN` in Family Office's Pages secrets and
   `FAMILY_HOLDINGS_TOKEN` in Research Central's Worker secrets. Do not use the dashboard
   password, browser cookie, Muns token or broad Cloudflare/GitHub credential.
3. Add `FAMILY_HOLDINGS_TOKEN` to Research Central's Actions secrets for the snapshot job.
4. Deploy Research Central after approval. Its scheduled collectors now ask its live
   names-only endpoint for holdings instead of using the old snapshot. Until the companion
   route/secret is available, they fail explicitly rather than silently use June's book.
5. Compare the export's ISIN set to Family Office's active Holdings view (equities only),
   including Sterlite `INE089C01029` → `STLTECH`. Then verify the same set in Research Central
   on two devices with no local portfolio overrides. Test additions/removals in staging,
   not by modifying the production workbook.

An uploaded workbook kept **only in a browser** cannot be a shared source. Family Office's
Data Audit panel identifies that case and offers publication to shared storage; it needs the
user's approval to publish. Do not silently upload local customer files as part of sync.

`asOf` is the source's declared workbook period, not a live trade timestamp. In particular,
the existing `FY27 till Q2 Aug.` period label is interpreted by Family Office as a full
financial year. This change preserves that interpretation, does not infer a different date,
and shows the workbook label plus actual check time. Correcting period metadata is separate.

## Snapshot workflow and review

`Family book sync` retains its daily/manual/dispatch triggers, but now opens or updates
`codex/family-book-snapshot` as a PR. It never pushes to main or merges. Live scope and
scheduled collectors do not wait for that fallback PR.

Allow Actions to create PRs. To trigger CI automatically on bot-created snapshot PRs, set
`FAMILY_SYNC_PR_TOKEN` to a repository-scoped GitHub App/PAT with Contents and Pull requests
write permissions. Without it, the default `GITHUB_TOKEN` creates the PR but does not trigger
another Actions workflow; required review/checks must still be obtained before any merge.

The schema, duplicate-ISIN checks and 80% retention guard reject corrupt/empty/partial data.
A genuine reduction beyond 20% needs explicit reconciliation and a reviewed update to the
fallback snapshot; do not bypass the guard merely to get a green run.

## Local verification

`node scripts/verify-family-sync.mjs` exercises the resolver, additions/removals, auth boundary,
failure retention and browser state with synthetic/local data. `wrangler deploy --dry-run`
bundles without deployment. The Family Office PR has matching producer/auth tests and a
Pages Functions build check. No live collection jobs are executed in these tests.

For an offline snapshot import, set `FAMILY_BOOK_PATH` to a names-only JSON export and run
`node scripts/sync-family-book.mjs`. It no longer accepts a TypeScript portfolio file.

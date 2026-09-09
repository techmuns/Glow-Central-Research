# Glow Central Research

Glow Ventures family-office research dashboard, using the shared
[Sattva template](https://github.com/techmuns/Sattva-Central-Research) with Glow's own portfolio,
branding, Family Book, My Managers, Mutual Funds and macro research.

The September 2026 template upgrade includes light/dark themes, Bookmarks, streaming Ask Research,
portfolio-aware alerts, news archives, company filings, con-calls and summaries, IPO monitoring,
source health and continuous capture recovery. See the [Glow deployment and credential checklist](docs/GLOW-TEMPLATE-SYNC.md)
for the exact upstream revision, preserved differences, required settings and future sync process.

Portfolio membership comes from `techmuns/GlowVentures` platform statements. The daily producer
builds the book, company identities and manager summaries. The dashboard revalidates its published
snapshot on opening, during visible sessions and before portfolio questions. It preserves the
source's statement dates and reports failed checks; a successful read is not a live broker update.
Equity weights use the complete deduplicated equity statement book, not total family NAV.
Unknown costs and P&L remain unknown and the ring-fenced promoter holding stays outside totals.
The Family Book tab retains detailed statement evidence.

Every source must retain captured history and report stale, partial and failed checks honestly.
This is a standing requirement, not certification of complete provider coverage. See
[reliability criteria](docs/INTELLIGENCE-RELIABILITY.md) and [project instructions](AGENTS.md).

Static vanilla ES modules, a committed Tailwind stylesheet and a Cloudflare Worker; no frontend
framework, bundler or application dependency installation. Local check:

```sh
python3 -m http.server 8080 -d public
node scripts/verify-glow-parity.mjs
node scripts/check-book.mjs
npx --yes wrangler@4 deploy --dry-run
```

Use Node 22 for the full Verify suite. Browser checks pin Playwright 1.62.1 and run without
production API calls. The shared contracts, local Worker tests and browser workflows are in
[Verify](.github/workflows/verify.yml). Production secrets remain server-side.

Upgrades follow a `codex/*` branch and pull request, checks and review, then merge. The scheduled
[template sync](.github/workflows/sync-upstream.yml) prepares PRs and preserves Glow captures;
it never writes directly to main. Historical upstream operational notes are reference material:
[Glow's deployment contract](docs/GLOW-TEMPLATE-SYNC.md) takes precedence for portfolio wiring
and account settings.

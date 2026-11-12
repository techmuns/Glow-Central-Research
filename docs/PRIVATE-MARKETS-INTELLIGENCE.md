# Private Markets Intelligence

A separate weekly newsletter, requested 21 October 2026. The fixed clock is
Monday **09:00 Asia/Kolkata** (03:30 UTC). It uses each desk's existing active
newsletter recipient list, including later additions/removals, without altering
morning/evening settings, claims, reported items or saved PDFs. Unsubscribing
from the shared list stops both newsletters. No immediate production test send
is part of activation.

The existing GitHub newsletter processor and serialized account mutex own this
edition. A dedicated Monday 03:30 UTC wake targets 09:00 IST; the five-minute wake
and independent collector-completion recovery are retained. A newly due Monday boundary bypasses recent-check coalescing.
GitHub schedules are best effort; delays beyond three hours are recorded as
missed, with pending late arrivals/corrections retained for a later edition.
No browser visit is required. Launching midweek does not resend an earlier Monday.

The whole-universe section covers the prior Monday 09:00 through this Monday
09:00, plus captured late arrivals/corrections. Initial old history is a baseline,
not a mass email. Original dates, round, amount, sector, business model, investors,
lead investor, footnotes and links survive. Only identical complete sets of
reported fields share a row, retaining all source links/observation identities;
these are not verified transaction totals. No currency aggregation or AI is used.
Source check, capture and publication times remain separate, with stale, partial,
failed and cooldown states explicit. Inc42 public table coverage is not an
exhaustive VC/PE universe. Funding collection pacing/budgets are unchanged.

The invested-funds section matches the desk's own My Managers roster. Full-name
or curated public house-name spellings use word boundaries, never fuzzy issuer
matching. A house match explicitly leaves the specific vehicle unconfirmed.
Unnamed investors and unrecognized aliases can prevent matches. A failed roster
read says unavailable rather than zero investments. Fund names/relationships,
recipient bodies, frozen plans and claims remain in the existing encrypted GitHub
newsletter checkpoint, never plaintext public artifacts. Preview requires the
reader's verified Munshot identity and current active subscription; no send API
or model call is exposed for the weekly edition.

Each complete email stays below 90,000 UTF-8 HTML bytes, split at whole funding
observations with both sections and source coverage. Preview loads all parts.
Delivery is sequential and paced one second apart. Frozen claims are published
and acknowledged before each external request, and recipient membership is checked
again immediately before sending. Confirmed 429 responses wait 30/60 minutes
and have at most three attempts; uncertain acceptance/interruption never resends
automatically. Later parts require acknowledgement of the root and share its thread.
Uncertain observations are quarantined by identity and content hash across future
editions, with the frozen claim retained for reconciliation. A roster outage keeps
separate matching work after the universe section is delivered; recovered matches
appear in a later fund section with a recovery label. Provider holds also pause
the public newsletter timer/retry paths sharing that sender; checks and retained
history continue. Future source clocks over ten minutes ahead are flagged stale.
The sender's existing credential/provider is reused; no additional paid search,
model service, runner or Cloudflare background work is introduced.

Offline checks: `node scripts/verify-private-markets-intelligence.mjs`, existing
newsletter GitHub/scheduling/reading/delivery suites, funding capture tests and the
navigation/returning-session UI checks. Production activation is through normal
PR merges and automatic deployment; a prepared preview/status does not prove a
scheduled provider acceptance or inbox receipt.

Glow verifies its own committed manager/book revision and statement period,
then reads its alternative-fund names. Statement dates remain explicit. Glow
reads the single public Sattva funding release in its existing automatic static
publication pipeline; it never scrapes Inc42 a second time or copies Sattva
private portfolios, subscribers, credentials or newsletter state.

Private Market’s Round types filter groups spelling, hyphenation and footnote
variants, series sub-rounds/extensions, Credit/Debt and mixed equity/debt labels.
Pre-Series stages remain distinct from their Series stages. Missing, misplaced
amounts and unrecognised values appear under Unspecified; All retains every
source observation. Original round wording, monetary amounts, footnotes and
source fields remain unchanged in the table, drilldown and filtered export.
Saved raw round selections migrate to their display group during an upgrade.

The weekly inbox layout shares `worker/newsletter-style.mjs` with the total
portfolio newsletter: the same indigo palette, serif masthead/company headings,
640px paper, section rules and dark subscription footer. Both desktop and narrow
mobile inboxes retain complete reported funding fields and per-company source links.
Newly prepared editions use this layout; previously frozen delivery bodies stay
unchanged. Local visual check: `NEWSLETTER_LAYOUT=1 node
scripts/verify-private-markets-intelligence.mjs` (with the existing Playwright runtime).

Funding sections begin directly below the masthead. The former edition-count
introduction, orange coverage banner and closing Coverage & sources section are
removed, including its timestamps, coverage copy and global source footnotes.
Source notes and coverage metadata remain in the retained model and capture;
per-company evidence links and correction labels remain in each funding entry.

## Many publishers, one row per deal (12 November 2026, GLOW-OWNED)

The desk asked for Private Market (Universe) to track every funding round and M&A deal of Indian
private companies for deal sourcing, from as many sources as possible, without repeats, and with the
more credible source winning where reports disagree.

- **Capture.** `scripts/collect-private-deals.mjs` (`.github/workflows/private-deals-refresh.yml`,
  hourly, commits to main) reads the public RSS of Inc42, Entrackr, YourStory, Economic
  Times (tech funding and startups), Hindustan Times, Times of India, Mint, Business Standard, The
  Hindu BusinessLine, TechCrunch India and Tech in Asia, plus Google News searches that bring in
  Moneycontrol, VCCircle, HT, TOI and smaller startup desks (each item names its real publisher).
  Every feed was checked live for a same-day newest item on 12 November 2026. Entrackr's `/feed/`
  is dead; `/rss` is the live one. **Tracxn publishes no free per-deal feed and is not read.**
  Reports are merged into `public/data/private-deals.json`; nothing captured is deleted, and a failed
  feed keeps its last good time. curl on the runner, because Mint and ET refuse node's fetch.
- **Reading.** `public/js/data/private-deals-shared.js` reads a deal only from a headline that plainly
  states who raised, invested or bought: company, kind (funding / acquisition / merger), status
  (announced or reported talks), size, round, investors, lead investor, acquirer. A field the text
  does not state stays blank. Fund raises by VC funds, roundups, orders, capex, IPOs, valuations,
  listed companies (exact name against the Moneycontrol map and the NSE universe) and deals whose
  subject is placed outside India are left out. A minority stake is an investment; a majority one an
  acquisition.
- **Folding.** The browser folds these reports with Inc42's Funding Galore table rows into one row per
  deal: same company (names equal, or one is the other plus trailing words), same kind, compatible
  round type and size (within 3x), within 30 days. One outlet printing two different sizes is two
  tranches. Two rows of one Inc42 roundup are never folded.
- **Credibility.** `SOURCE_CREDIBILITY`: Inc42 Funding Galore table 95, Entrackr 90, VCCircle 89,
  ET / Reuters / Bloomberg 88, Mint 86, Business Standard / Moneycontrol / Inc42 news 85, BusinessLine
  82, YourStory / TechCrunch / Financial Express 80, Tech in Asia 78, HT 75, TOI 72, others 50. Each
  field comes from the most credible report that states it. A size or round disagreement is kept on
  the row ("Sources differ"), named in the drill and the export. A $ and a ₹ figure are never compared.
- **Table.** New Deal and Sources columns, a Deal types filter (funding, acquisitions & mergers, in
  talks), and the period filter's Latest week is the seven days ending on the newest captured deal
  date (never after today), with Last 30 days and years. The bookmark on each row is the shortlist.
  Portfolio and Watchlist scopes still match the family's companies by exact name. The weekly email
  and the private-company alerts still read the Inc42 table only.
- **Always current.** Hourly schedule; because GitHub sheds schedules, an open Private Market tab whose
  capture is over 75 minutes old starts the workflow itself through `POST /api/private-deals/refresh`
  (Worker, 20-minute cooldown, declined while a run is in flight; at most one try per 30 minutes per
  page) and re-reads the file every minute until the new capture lands. The page also re-reads the
  file every five minutes, and the header Refresh starts a read when the capture is over 10 minutes
  old. The footer says how long ago the feeds were read and when a fresh read is under way.
- **Tests.** `node scripts/verify-private-deals.mjs` (offline) and
  `scripts/verify-private-market-news-ui.mjs` (a second publisher folds into the Inc42 row, and the
  disagreement shows).

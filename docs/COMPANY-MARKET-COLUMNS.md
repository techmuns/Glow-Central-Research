# CMP and market cap in company tables

The October 2026 table audit covers every registered tab and its company tables:

| Surface | Company tables |
| --- | --- |
| Portfolio / Watchlist | Existing paired market columns, editing and exports retained |
| All Alerts | Timeline and upcoming events |
| Announcements | Corporate Announcements, Corporate Actions, Bulk/Block Deal, IPO filings and issuer directory |
| Earnings | Results, Calendar, Concall and summary coverage |
| Screens | Momentum, Strong Breakouts, Technical Scanner, FII Accumulation and scan exceptions |
| Mutual Funds | Company ownership table (fund schemes and source cohorts retain their own NAV/return measurements) |
| Public Chatter | Company coverage and retained company/topic catalogue |
| Super Investors / Capital | Company holdings, quarterly comparisons, public deals, manager securities and exchange-disclosure tables |
| NSE Filings | Retained company filing table, including old direct routes |

AI Alerts, News, Bookmarks and Ask Research use cards or retained source documents rather than company tables. Investor/fund directories, source-health tables and financial metric/quarter series are not company lists. Source-document tables are preserved as published.

`scoreTable({companyMarket: true})` adds missing CMP and market-cap fields as a pair. A source-specific CMP/cap renderer is retained. `cmpLabel` explicitly identifies an existing current-price column; an unrelated deal price is never adopted. New fields join their counterpart in older saved column orders; subsequent user ordering wins. Portfolio and Watchlist already supply both columns through `sheet-market.js`.

Screens already owns a visible quote poller. Its `companyMarket.watchPrices: false` subscribes to that poller without starting another price check when thresholds or views repaint.

`company-market.js` shares the saved intraday capture and `company-quotes.json`, a small projection of the existing completed-session technicals. The projection retains each row's session date, is emitted by both existing technicals writers and is served from a fixed GitHub revision by `/api/technicals/prices`. No browser visit starts provider collection. Mounted tables check saved quotes on the existing 15-second cadence; the compact daily snapshot revalidates once a minute while visible and on returning after that interval, and public cap/share references revalidate every fifteen minutes. Failed daily reads retain dated observations with an unavailable-check label.

The existing daily public market-cap collector also saves the CMP already present in its screen/company-page responses, without more requests. These observations retain their own check time and publisher price label. Existing entries without a saved CMP remain unavailable until a normal scheduled capture supplies one. A source check time is never presented as a trade time, and a partial day/month label never supplies an inferred year.

ISIN, NSE symbol and BSE code determine joins. Names and Finology display slugs do not imply a ticker. An unresolved or unlisted issuer shows a dash with an explanation. Company tables with a verified identifier use their own quotes; BSE-only display symbols cannot borrow NSE prices. New market caps use Moneycontrol shares × the displayed CMP when available, otherwise the captured public cap with its own provenance. Announcement caps retain their source figure so range filters and values continue to agree.

Source-specific company exports opt into the same missing-column rule and include provenance for new fields. Missing numbers export as blanks, not zero.

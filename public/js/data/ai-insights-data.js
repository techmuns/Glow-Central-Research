// data/ai-insights-data.js — the AI Insights one-pagers.
//
// This is the "brain" output in a readable shape: for each company, the handful of
// What-We-Like / What-We-Don't-Like points that matter, a Business-Quality and a
// Price/Value score, a verdict and the numbers — written from Glow's sector signal
// rulebook (docs: the scratchpad signal research) applied to the company's own data.
//
// PHASE 1: company pages are authored from Glow's research as each sector is wired.
// HAL (Defence) is the first live example. Market price is read live from the
// technicals feed at render time; order book and financials are from Glow research
// until the fundamentals feed is connected. Nothing here is a recommendation.
//
// Each point's `tag` is the exact signal from the sector rulebook that fired it, so a
// reader can see the page is signal-driven, not hand-waved.

export const INSIGHTS = {
  HAL: {
    ticker: 'HAL',
    name: 'Hindustan Aeronautics',
    ourSector: 'Defence & Aerospace',
    asOf: 'Q2 FY27',
    lead:
      "India's monopoly maker of military aircraft — it designs and builds the fighters, " +
      'helicopters and engines the armed forces fly, and maintains them for life.',
    what:
      'HAL is a government-owned company that <b>designs, builds and maintains India\'s military ' +
      'aircraft</b> — the Tejas fighter, the Dhruv/Prachand helicopters, aero-engines, and the ' +
      'decades-long servicing that follows each one. It is effectively the <b>only domestic maker</b> ' +
      'of fighters and military choppers, so most of its work is handed to it directly by the Ministry ' +
      'of Defence. Its real signature is the <b>order book</b> — signed work not yet delivered — which ' +
      'now stretches well past a decade of sales, funded largely by government advances.',
    facts: [
      { k: 'Government-owned', v: 'Maharatna PSU' },
      { k: 'Order book', v: '≈ ₹2.55 lakh cr' },
      { k: 'Order-book cover', v: '≈ 7.5× sales' },
      { k: 'EBITDA margin', v: '≈ 30%' },
      { k: 'Balance sheet', v: 'Net cash' },
    ],
    quality: 84,
    price: 44,
    verdict: 'Watchlist',
    verdictSub: 'Great franchise · rich price',
    takeaways: [
      'Order book ~7.5× sales — but converting slowly (sales +7%)',
      'Fat ~30% margins, net cash, owns its technology',
      'Premium price already assumes flawless delivery',
    ],
    why:
      'We score the <b>business</b> and the <b>price</b> as two separate questions. HAL is a near-monopoly ' +
      'with an enormous order book and fat margins — excellent on the first. But the price already assumes ' +
      'that backlog converts smoothly into sales, and conversion has been the weak spot.',
    trigger:
      'It becomes a <b>Buy</b> if the price cools, <b>or</b> once revenue clearly starts converting the ' +
      '₹2.55 lakh cr backlog — Tejas Mk1A deliveries ramping and the engine-supply bottleneck easing — ' +
      'rather than the order book simply growing.',
    like: [
      { t: 'A decade-plus of work already locked in', tag: 'Years of work in hand',
        d: 'The ~₹2.55 lakh crore backlog is about 7.5× a full year\'s sales — one of the longest revenue runways on the market, visible years ahead.' },
      { t: 'Funded by the customer, not by debt', tag: 'Advances · net cash',
        d: 'It runs largely on government advances and sits on net cash, so it funds a huge build programme with almost no borrowing.' },
      { t: 'Owns the design — not screwdriver assembly', tag: 'Owns the design',
        d: 'It designs its own aircraft, helicopters and engines and does the lifetime maintenance — deep IP and a captive after-market a rival cannot displace.' },
      { t: 'Fat, rising margins', tag: 'Margin & mix',
        d: 'EBITDA margin around 30% and guided to 30–31% — unusually high, helped by the high-value design-and-maintenance mix.' },
      { t: 'Near-monopoly on Indian military aircraft', tag: 'Dominant franchise',
        d: 'Effectively the only domestic maker of fighters and military helicopters, riding India\'s long push to build its defence kit at home.' },
      { t: 'Still winning work faster than it books it', tag: 'Book-to-bill > 1',
        d: 'The order book has jumped from ~₹1.9 lakh cr to ~₹2.55 lakh cr in a year, so the runway is still lengthening, not shrinking.' },
    ],
    dislike: [
      { t: 'The order book isn\'t turning into sales fast enough', tag: 'Order book → sales',
        d: 'The one that matters most here: the backlog is at a record while revenue grew only ~2% (FY25) and ~7% (FY26). A huge book means little until it converts.' },
      { t: 'Deliveries keep slipping', tag: 'Delivering on time',
        d: 'Tejas Mk1A hand-overs have run late, largely on engine supply from GE. Sales only count when the forces accept delivery — and acceptances have lagged.' },
      { t: 'Almost a single customer', tag: 'One-customer risk',
        d: 'Overwhelmingly dependent on the Ministry of Defence and weighted to a few big programmes, so a budget or priority shift hits a lot at once.' },
      { t: 'Cash can get stuck', tag: 'Cash stuck',
        d: 'The government pays and accepts slowly, so unpaid bills and work-in-progress inventory can swell — worth checking that profit becomes cash.' },
      { t: 'Priced for flawless delivery', tag: 'Price assumes perfect delivery',
        d: 'At a premium multiple (~30×+ earnings) the price already assumes the backlog converts smoothly — if execution keeps slipping, there is little under the valuation.' },
    ],
    financials: {
      cols: ['FY24', 'FY25', 'FY26'],
      rows: [
        { k: 'Revenue', v: ['≈ 30,380', '≈ 30,980', '≈ 33,050'] },
        { k: '— growth', v: ['—', '+2%', '+7%'], pos: [false, true, true] },
        { k: 'Net profit', v: ['≈ 7,600', '≈ 8,360', '≈ 8,400'] },
        { k: 'Operating (EBITDA) margin', v: ['≈ 27%', '≈ 29%', '≈ 30%'] },
      ],
    },
    fnote:
      'Order book ≈ ₹2.55 lakh cr (up from ~₹1.9 lakh cr a year earlier). FY27 guidance: 10–12% revenue ' +
      'growth, 30–31% margin, weighted to the second half. Notice how the backlog has raced ahead while ' +
      'revenue growth stayed single-digit — that gap is the conversion watch above. Figures approximate/indicative.',
    close:
      'A near-monopoly with a decade-plus of orders and fat margins — the quality is not in doubt. The ' +
      'debate is whether that record backlog finally converts into sales, and whether today\'s premium ' +
      'price leaves any room if it doesn\'t. We\'d rather own it on better conversion, or a better price.',
  },
};

// Which of the family's holdings fall in a sector Glow has already researched.
// Tickers are the NSE symbols in portfolio-companies.json. Only HAL has a full
// one-pager so far; the rest show that their sector rulebook is ready and the page
// is rolling out — honest about what is and isn't wired yet.
export const RESEARCHED_SECTORS = [
  { sector: 'Defence & Aerospace', tickers: ['HAL', 'PARAS', 'MIDHANI'] },
  { sector: 'IT Services', tickers: ['CYIENT', 'ECLERX', 'INTELLECT', 'MASTEK', 'MPSLTD', 'BSOFT', 'FRACTAL'] },
  { sector: 'Auto OEMs', tickers: ['BAJAJ-AUTO', 'M&M', 'ATHERENERG'] },
  { sector: 'Auto Components', tickers: ['EXIDEIND', 'CEATLTD', 'JAMNAAUTO', 'BANCOINDIA', 'BELRISE', 'GREAVESCOT'] },
  { sector: 'NBFC & Housing Finance', tickers: ['CANFINHOME', 'PFC', 'CGCL', 'ABCAPITAL', 'FUSION'] },
  { sector: 'Capital Goods / EPC', tickers: ['KPIL', 'PRAJIND', 'ISGEC', 'BHEL', 'DBL', 'ENGINERSIN', 'ANUP', 'KSB'] },
  { sector: 'Building Products', tickers: ['KAJARIACER', 'APOLLOPIPE'] },
  { sector: 'FMCG / Consumer Staples', tickers: ['JYOTHYLAB', 'GAEL', 'KSCL', 'BECTORFOOD'] },
  { sector: 'Broking & Markets', tickers: ['MOTILALOFS', 'IEX'] },
  { sector: 'Insurance', tickers: ['LICI'] },
  { sector: 'AMC & Wealth', tickers: ['HDFCAMC', 'NUVAMA'] },
];

export function getInsight(ticker) {
  return (ticker && INSIGHTS[ticker]) || null;
}

/** Every ticker that sits in a researched sector, mapped to that sector name. */
export function researchedSectorOf(ticker) {
  for (const g of RESEARCHED_SECTORS) if (g.tickers.includes(ticker)) return g.sector;
  return null;
}

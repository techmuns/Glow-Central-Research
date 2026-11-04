// data/ai-insights-data.js — the AI Insights one-pagers.
//
// This is the "brain" output in a readable shape: for each company, the handful of
// What-We-Like / What-We-Don't-Like points that matter, a Business-Quality and a
// Price/Value score, a verdict, a "Guidance vs Delivery" read of the last few
// earnings calls, and the numbers — written from Glow's sector signal rulebook
// applied to the company's own data.
//
// SOURCES PER COMPANY (full-depth standard):
//   • Live price / day move  → the dashboard's technicals feed (read at render time)
//   • Financials             → Screener (exact figures, dated)
//   • Management commentary  → the company's last 2–3 earnings calls (concalls),
//                              organised the way dakshamconcall does it — Guidance
//                              vs Delivery — reporting management's own words, not
//                              opinions put in their mouth
//   • Context / events       → web & news research
// The verdict and scores are Glow's analysis of the above. Nothing is invented;
// figures are marked and dated. This is not investment advice.
//
// Each point's `tag` is the exact signal from the sector rulebook that fired it.

export const INSIGHTS = {
  HAL: {
    ticker: 'HAL',
    name: 'Hindustan Aeronautics',
    ourSector: 'Defence & Aerospace',
    asOf: 'Q1 FY27 · Q2 due 12 Nov',
    lead:
      "India's monopoly maker of military aircraft — it designs and builds the fighters, " +
      'helicopters and engines the armed forces fly, and maintains them for life.',
    what:
      "Think of HAL as the maker of India's military aircraft — the Tejas fighter, the Dhruv and " +
      'Prachand helicopters, aero-engines — and, just as importantly, the company that <b>repairs and ' +
      'overhauls that fleet for decades</b> afterwards (a steady, captive income). It is effectively the ' +
      '<b>only domestic maker</b> of fighters and military helicopters, so most of its work is handed to it ' +
      'directly by the Ministry of Defence. Its signature is the <b>order book</b> — signed work not yet ' +
      'delivered — which now stretches to around 2032, funded largely by government advances.',
    facts: [
      { k: 'Government-owned', v: 'Maharatna PSU' },
      { k: 'Order book', v: '≈ ₹2.54 lakh cr' },
      { k: 'Order-book cover', v: '≈ 7.7× sales' },
      { k: 'Operating margin', v: '≈ 30%' },
      { k: 'P/E', v: '≈ 36×' },
      { k: 'Balance sheet', v: 'Net cash ₹46k cr' },
    ],
    quality: 83,
    price: 40,
    verdict: 'Watchlist',
    verdictSub: 'Elite franchise · still pricey',
    takeaways: [
      'Record ₹2.54 lakh cr order book — but the jets aren’t shipping yet',
      'It all hinges on GE engine supply; the 12 Nov call is the test',
      'Elite ~30% margins and net cash — but priced at ~36×',
    ],
    why:
      'We score the <b>business</b> and the <b>price</b> as two separate questions. HAL is an elite ' +
      'franchise — a decade of orders, ~30% margins, net cash. But the one thing that matters most, <b>turning ' +
      'that record order book into delivered jets</b>, keeps slipping on engine supply, and the price (~36× ' +
      'earnings) still assumes it all converts smoothly.',
    trigger:
      'It becomes a <b>Buy</b> if the price cools, <b>or</b> once the GE F404 engines actually ramp and Tejas ' +
      'Mk1A deliveries start flowing — the <b>12 November Q2 call</b> is the first real test of management’s ' +
      '"deliveries from Aug–Sep 2026" promise.',
    // Guidance vs Delivery — organised from HAL's last three earnings calls.
    concalls: {
      rows: [
        { theme: 'Order book & inflow', guided: 'Keep winning big orders', status: 'kept',
          note: 'Backlog grew ₹1.89 → ₹2.54 lakh cr in FY26 on ₹97,000 cr of fresh orders (incl. the ₹62,370 cr / 97-jet Tejas deal); ~₹90,000 cr more guided over the next two years.' },
        { theme: 'Revenue growth', guided: '10–12% in FY27, H2-weighted', status: 'watch',
          note: 'Guided the same in Feb, May and Aug 2026 — but FY26 actually grew only ~7%, below HAL’s own norm, because of the Tejas delays.' },
        { theme: 'Tejas Mk1A deliveries', guided: 'Start Aug–Sep 2026; ~20 in FY27', status: 'missed',
          note: 'Zero delivered in FY26 despite 20–30 jets built and parked. The "delivering soon" promise has slipped across several quarters.' },
        { theme: 'GE F404 engines', guided: 'GE to supply 15–22 a year', status: 'watch',
          note: 'The bottleneck: only 5 → 6 → 7 engines received across the three calls (~2 in six months). The FY27 plan needs a big, still-unproven jump.' },
        { theme: 'Margins', guided: '30–31% held', status: 'kept',
          note: 'FY26 landed ~30% (quarterly figures are lumpy — judge the full year, not one quarter).' },
        { theme: 'Cash tied up', guided: '—', status: 'watch',
          note: 'Inventory jumped ₹21,700 → ₹30,900 cr as undelivered airframes pile up waiting for engines.' },
      ],
      trend:
        'The order book is the promise HAL keeps; turning it into delivered jets is the one it keeps pushing ' +
        'out. Everything now hinges on the GE engine ramp — the 12 November Q2 call is the first real test of ' +
        'the "deliveries from Aug–Sep 2026" promise.',
      note:
        'Read from HAL’s last three earnings calls — Q3 FY26, Q4 FY26 (official transcript) and Q1 FY27 ' +
        '(broker notes). We organise management’s own words; we don’t put words in their mouth.',
    },
    like: [
      { t: 'A decade of orders already locked in', tag: 'Years of work in hand',
        d: 'The ~₹2.54 lakh crore order book is about 7.7× a full year’s sales — management says it gives revenue visibility out to 2032.' },
      { t: 'Funded by the customer, not by debt', tag: 'Advances · net cash',
        d: 'Runs on government advances and sits on ~₹46,000 cr of net cash with zero debt — it funds a huge build programme without borrowing.' },
      { t: 'Owns the design — and the after-market', tag: 'Design · ROH moat',
        d: 'It designs its own jets, helicopters and engines, and earns a steady repair-and-overhaul income servicing the fleet for life — a captive annuity a rival cannot touch.' },
      { t: 'Among the best margins in defence', tag: 'Margin & mix',
        d: 'Operating margin ~30% (easing gently from 32% two years ago) and guided at 30–31% — elite for a manufacturer, helped by the design-and-servicing mix.' },
      { t: 'Near-monopoly riding a national tailwind', tag: 'Dominant franchise',
        d: 'Effectively the only domestic maker of fighters and military helicopters, as India pushes hard to build its defence kit at home.' },
      { t: 'Orders still growing faster than sales', tag: 'Book-to-bill > 1',
        d: 'The backlog jumped on ₹97,000 cr of FY26 wins, with ~₹90,000 cr more guided over two years — the runway keeps lengthening.' },
    ],
    dislike: [
      { t: 'The order book isn’t turning into sales', tag: 'Order book → sales',
        d: 'The one that matters most: a record book, yet FY26 revenue grew only ~7%. Management itself blamed delays on the Tejas and trainer programmes.' },
      { t: 'Tejas deliveries keep slipping', tag: 'Delivering on time',
        d: 'Zero Mk1A were delivered in FY26 despite 20–30 jets built and parked — delivery has been promised "soon" through several quarters running.' },
      { t: 'One engine supplier is the choke point', tag: 'Engine supply',
        d: 'It all waits on GE’s F404 engines, and just 5 → 6 → 7 arrived across three quarters. FY27’s plan needs a steep, unproven ramp in that supply.' },
      { t: 'Cash is piling up as unsold stock', tag: 'Working capital',
        d: 'Inventory ballooned ₹21,700 → ₹30,900 cr as finished jets sit waiting for engines — so reported profit isn’t fully turning into cash.' },
      { t: 'A chunk of profit is "other income"', tag: 'Earnings quality',
        d: 'In the June quarter about ₹900 cr of profit was interest and other income rather than the core business — one broker flagged the earnings quality.' },
      { t: 'Priced for perfection', tag: 'Valuation',
        d: 'At ~36× earnings the price already assumes smooth conversion; big investors have trimmed (foreign holding 12% → 9.3%) and one broker cut it to Hold.' },
    ],
    financials: {
      cols: ['FY24', 'FY25', 'FY26'],
      rows: [
        { k: 'Revenue', v: ['30,381', '30,981', '33,089'] },
        { k: '— growth', v: ['—', '+2%', '+7%'], pos: [false, true, true] },
        { k: 'Net profit', v: ['7,621', '8,364', '9,116'] },
        { k: '— growth', v: ['—', '+10%', '+9%'], pos: [false, true, true] },
        { k: 'Operating (EBITDA) margin', v: ['32%', '31%', '30%'] },
      ],
    },
    fnote:
      'Order book ≈ ₹2.54 lakh cr (Mar 2026). Latest quarter — Q1 FY27: revenue ₹5,515 cr (+14% YoY), net profit ' +
      '₹1,590 cr (+15%); Q2 FY27 is due 12 Nov 2026. Net cash ≈ ₹46,000 cr, zero debt · P/E ≈ 36× · ROE ≈ 24% · ' +
      'dividend yield ≈ 0.9%. Figures from Screener (4 Nov 2026); growth is on revenue from operations.',
    close:
      'A genuinely elite franchise — a decade of orders, ~30% margins, net cash and a captive after-market. The ' +
      'whole debate is execution: can HAL finally turn that record ₹2.54 lakh cr book into delivered jets as the GE ' +
      'engines arrive? Until deliveries actually flow, a ~36× price leaves little room for error. We’d rather buy ' +
      'on proof of conversion, or a cheaper price.',
    sources:
      'Numbers: Screener (4 Nov 2026). Management commentary: HAL’s Q3 FY26, Q4 FY26 (official transcript) and ' +
      'Q1 FY27 earnings calls. Live price: the dashboard feed.',
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

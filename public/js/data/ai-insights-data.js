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
    intrinsic: {
      low: '₹3,900', high: '₹4,400',
      basis: '~28–32× FY27E EPS — elite, but below today’s ~36×',
      read: 'Trading above our range — priced for flawless execution, with little margin of safety.',
      tone: 'rich',
    },
    valuation: {
      metric: 'P/E · order-book cover — the defence lens',
      now: '~36×', fair: '~30×',
      extra: 'order book ~7.7× sales · net cash ₹46k cr',
    },
    kpis: [
      { k: 'Order book', v: '₹2.54 lakh cr', tone: 'good' },
      { k: 'Order-book cover', v: '~7.7× sales', tone: 'good' },
      { k: 'Revenue growth (FY26)', v: '+7%', tone: 'watch' },
      { k: 'Tejas Mk1A delivered', v: '0 in FY26', tone: 'rich' },
      { k: 'EBITDA margin', v: '~30%', tone: 'good' },
      { k: 'ROE', v: '~24%', tone: 'good' },
      { k: 'Net cash', v: '₹46,000 cr', tone: 'good' },
    ],
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
        d: 'At ~36× earnings the price already assumes smooth conversion; one broker cut it to Hold.' },
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

  'BAJAJ-AUTO': {
    ticker: 'BAJAJ-AUTO', name: 'Bajaj Auto', ourSector: 'Auto OEMs', asOf: 'Q2 FY27',
    lead: `One of the world's largest two- and three-wheeler makers — Pulsar and KTM/Triumph bikes, Chetak electric scooters and a dominant auto-rickshaw franchise, with nearly half its sales exported.`,
    what: `Bajaj makes motorcycles, scooters and three-wheelers (auto-rickshaws), sold in India and exported to ~70 countries. It owns strong brands (Pulsar) and premium stakes (<b>KTM, Triumph</b>), runs a <b>profitable</b> electric-scooter business (Chetak) and dominates three-wheelers. Roughly <b>40% of sales are exports</b>, so it earns heavily in foreign currency — a tailwind when the rupee is weak, and a swing factor when it isn't.`,
    facts: [
      { k: 'Exports', v: '≈ 40% of sales' },
      { k: 'Operating margin', v: '≈ 21%' },
      { k: 'Balance sheet', v: 'Net cash ₹15.5k cr' },
      { k: 'P/E', v: '≈ 25×' },
      { k: 'ROCE', v: '≈ 38%' },
    ],
    quality: 80, price: 52, verdict: 'Watchlist', verdictSub: 'Strong franchise · fairly priced',
    takeaways: [
      `Exports inflected (+40%) and EV turned profitable`,
      `Domestic 2-wheelers near-flat; growth leans on exports + premium`,
      `High returns (ROCE ~38%), ~100% cash payout — fairly priced at ~25×`,
    ],
    why: `Bajaj is a high-return, cash-rich franchise where <b>exports and premium bikes are firing and EV is finally profitable</b>. The watch is the domestic mass-market (nearly flat) and a margin that leans on a weak rupee — and at ~25× earnings the good news is largely in the price.`,
    trigger: `It becomes a <b>Buy</b> if the price cools, <b>or</b> domestic two-wheeler volumes re-accelerate (the 125cc revamp working) while the export run-rate holds — turning a two-engine story into a three-engine one.`,
    intrinsic: {
      low: '₹9,000', high: '₹10,500',
      basis: '~20–23× FY27E EPS — its own through-cycle multiple',
      read: 'At / just above our range — fairly-to-fully valued, with little margin of safety today.',
      tone: 'watch',
    },
    valuation: {
      metric: 'P/E — the auto-OEM lens',
      now: '~25×', fair: '~22×',
      extra: '~9× book · ~1.4% dividend yield · ~100% payout',
    },
    kpis: [
      { k: 'Domestic 2W volume growth', v: '+1.8%', tone: 'watch' },
      { k: 'Exports · share of sales', v: '~40%', tone: 'good' },
      { k: 'EBITDA margin', v: '~21%', tone: 'good' },
      { k: 'Premium mix (KTM/Triumph)', v: '+45% YoY', tone: 'good' },
      { k: 'ROCE', v: '~38%', tone: 'good' },
      { k: 'Net cash', v: '₹15,500 cr', tone: 'good' },
      { k: 'Dividend payout', v: '~100%', tone: 'good' },
    ],
    concalls: {
      rows: [
        { theme: 'Exports', guided: 'Cross 2.5 lakh/month', status: 'kept', note: 'Q2 exports 7,78,528 (+40%) ≈ 2.6 lakh/month — crossed it; Nigeria ~60% share, Mexico now a top-5 market.' },
        { theme: 'Domestic 2-wheelers', guided: 'Grow above industry, win share', status: 'watch', note: 'Premium (150cc+) share gains held, but Q2 domestic 2W volumes were only +1.8%; the entry 100–125cc segment stayed weak.' },
        { theme: 'EV (Chetak)', guided: 'Profitable, ~1/3 of domestic revenue', status: 'kept', note: 'EV ~1/3 of domestic revenue at double-digit EBITDA margins, ~2 lakh units/quarter — no longer a cash drain.' },
        { theme: 'Margins', guided: 'Hold ~20% despite cost inflation', status: 'kept', note: 'Held ~20.9% through heavy commodity inflation — but helped by a weak rupee (realised ~₹94/$).' },
        { theme: 'Premium (KTM/Triumph)', guided: 'Scale the premium network', status: 'kept', note: 'KTM + Triumph domestic revenue +45%, over 40,000 units.' },
        { theme: '3-wheelers', guided: 'Defend leadership', status: 'kept', note: '~70% of domestic ICE three-wheelers and over 65% of India’s 3W exports — a high-margin moat.' },
      ],
      trend: `Exports, EV and premium are all delivering what management promised; the one soft spot is the domestic mass-market two-wheeler, barely growing. The franchise is firing on its new engines while its oldest one idles.`,
      note: `Read from Bajaj Auto’s last three earnings calls (Q4 FY26, Q1 FY27, Q2 FY27). We organise management’s own words.`,
    },
    like: [
      { t: 'Export engine has inflected', tag: 'Exports', d: 'Q2 exports +40% (~2.6 lakh/month), ~40% of sales — real geographic spread (Nigeria, Mexico, Latin America), not one lucky market.' },
      { t: 'EV is finally profitable', tag: 'EV turned profitable', d: 'Chetak/EV is ~1/3 of domestic revenue at double-digit margins and ~2 lakh units a quarter — a rare electric-scooter business that actually makes money.' },
      { t: 'High returns, fortress balance sheet', tag: 'Returns · net cash', d: 'ROCE ~38%, ROE ~29%, ~₹15,500 cr net cash, and it returns almost all its profit via dividends and buybacks.' },
      { t: 'Premiumisation is working', tag: 'Premium mix', d: 'KTM + Triumph domestic revenue +45% YoY and over 40,000 units — a richer mix lifting blended realisations.' },
      { t: 'Three-wheeler moat', tag: 'Dominant franchise', d: '~70% of India’s ICE three-wheelers and over 65% of 3W exports — a high-margin niche rivals struggle to contest.' },
      { t: 'Margin resilience', tag: 'Margins', d: 'Held ~21% EBITDA margin through a quarter of unusually high commodity inflation.' },
    ],
    dislike: [
      { t: 'Domestic two-wheelers near-flat', tag: 'Volume growth', d: 'Q2 domestic 2W volumes were only +1.8%; the entry 100–125cc franchise is stagnant, so growth leans on exports and premium.' },
      { t: 'Lost the EV #1 spot', tag: 'Market share', d: 'TVS iQube leads electric scooters; Chetak is a close #2, and Ather/Hero are pushing price-led competition that pressures EV margins.' },
      { t: 'Margin leans on the rupee', tag: 'Currency risk', d: 'A realised ~₹94/$ (vs ~₹86 a year earlier) did much of the margin heavy-lifting; a stronger rupee could squeeze it.' },
      { t: 'Full valuation', tag: 'Valuation', d: '~25× earnings and ~9× book — most of the good news is in the price, and broker targets cluster around today’s level.' },
      { t: 'Consolidated earnings are noisy', tag: 'Earnings quality', d: 'Headline consolidated profit (+62%) is inflated by the KTM AG (Pierer) consolidation; the cleaner standalone grew ~35%.' },
      { t: 'Capacity and external shocks', tag: 'Execution risk', d: 'A ransomware attack and West-Asia disruptions cost ~10% of a quarter’s volume, and capacity is now a binding constraint being expanded.' },
    ],
    financials: {
      cols: ['FY24', 'FY25', 'FY26'],
      rows: [
        { k: 'Revenue', v: ['44,685', '50,010', '58,732'] },
        { k: '— growth', v: ['—', '+12%', '+17%'], pos: [false, true, true] },
        { k: 'Net profit', v: ['7,479', '8,151', '9,825'] },
        { k: '— growth', v: ['—', '+9%', '+21%'], pos: [false, true, true] },
        { k: 'Operating (EBITDA) margin', v: ['20%', '20%', '20%'] },
      ],
    },
    fnote: `Standalone figures. Latest quarter — Q2 FY27 (reported 27 Oct 2026): revenue ₹20,003 cr (+34% YoY), net profit ₹3,354 cr (+35%), EBITDA margin ~21%. Net cash ≈ ₹15,500 cr · P/E ≈ 25× · ROCE ≈ 38% · ROE ≈ 29% · dividend yield ≈ 1.4%. Consolidated numbers are higher but include KTM AG. Figures from Screener (4 Nov 2026).`,
    close: `A high-quality, cash-rich exporter with a profitable EV arm and a three-wheeler moat — genuinely firing on exports and premium. The debate is the flat domestic mass-market and a rupee-assisted margin, with the price already fair-to-full at ~25×. One to own on a dip, or on proof the home market re-accelerates.`,
    sources: `Numbers: Screener (4 Nov 2026). Management commentary: Bajaj Auto’s Q4 FY26, Q1 FY27 and Q2 FY27 earnings calls. Live price: the dashboard feed.`,
  },

  CYIENT: {
    ticker: 'CYIENT', name: 'Cyient', ourSector: 'IT Services', asOf: 'Q2 FY27',
    lead: `An engineering-R&D and digital-engineering services firm (aerospace, rail, telecom, semiconductors) with a separately-listed electronics-manufacturing arm, Cyient DLM.`,
    what: `Cyient does outsourced <b>engineering and design</b> — helping aerospace, rail, telecom and energy companies design and build their products (its services business, "DET") — and separately owns a listed <b>electronics-manufacturing arm, Cyient DLM</b>, that assembles circuit boards and systems. So it is really two businesses: a people-led engineering-services firm and a factory-led manufacturer, each with very different economics.`,
    facts: [
      { k: 'Two businesses', v: 'Services + DLM mfg' },
      { k: 'Operating margin', v: '≈ 13%' },
      { k: 'Order intake', v: 'Record' },
      { k: 'P/E', v: '≈ 30×' },
      { k: 'ROE', v: '≈ 9%' },
    ],
    quality: 58, price: 38, verdict: 'Watchlist', verdictSub: 'Turnaround bet · priced ahead',
    takeaways: [
      `Record order book, but organic growth has stalled (M&A-led)`,
      `Profit fell ~28% in FY26; margins now recovering`,
      `Priced at ~30× on ~9% ROE — a recovery already in the price`,
    ],
    why: `Cyient has <b>strong order intake and recovering margins</b>, but the core services business has barely grown organically and profit has fallen hard — and the stock (~30× earnings) already prices a recovery that hasn’t yet shown up in the base business.`,
    trigger: `It becomes a <b>Buy</b> once organic (ex-acquisition) services growth turns clearly positive and the delayed 15% services-margin target lands — proof the turnaround is real, not just order-book optimism.`,
    intrinsic: {
      low: '₹830', high: '₹1,020',
      basis: '~20–24× once margins recover — today’s ~30× pays ahead of it',
      read: 'Trading above our range — a recovery is already in the price.',
      tone: 'rich',
    },
    valuation: {
      metric: 'P/E — the IT-services lens',
      now: '~30×', fair: '~22×',
      extra: 'on a depressed ~9% ROE · net cash',
    },
    kpis: [
      { k: 'Organic services growth', v: '~+0.4% YoY', tone: 'rich' },
      { k: 'Order intake', v: 'US$158m (+21%)', tone: 'good' },
      { k: 'Services EBIT margin', v: '14.2% (rising)', tone: 'good' },
      { k: 'Net profit (FY26)', v: '−28%', tone: 'rich' },
      { k: 'Attrition', v: '14.6%', tone: 'good' },
      { k: 'DLM revenue', v: '+26.5% YoY', tone: 'good' },
      { k: 'ROE', v: '~9%', tone: 'watch' },
    ],
    concalls: {
      rows: [
        { theme: 'Organic growth', guided: 'Mid-to-high single digit in FY27', status: 'missed', note: 'Services (DET) organic growth was roughly flat (Q2 organic ~+0.4% YoY); the reported rise leans on the TAO acquisition.' },
        { theme: 'Order intake', guided: 'Keep winning deals', status: 'kept', note: 'Record services order intake US$158m (+21%) and a record DLM order book (book-to-bill 1.6×) — the strongest point.' },
        { theme: 'Services margin', guided: '15% EBIT, first set for Q4 FY27', status: 'watch', note: 'Target pushed to H1 FY28, but margin is recovering: 12.4% → 13.2% → 14.2% over three quarters.' },
        { theme: 'Manufacturing (DLM)', guided: 'Grow the factory arm', status: 'watch', note: 'DLM revenue +26.5% YoY, but its margin fell (EBITDA 8.7%, −135bps).' },
        { theme: 'Attrition', guided: 'Keep it low', status: 'kept', note: 'Attrition 14.6%, down from an ~18% peak — talent costs under control.' },
        { theme: 'Profit', guided: '—', status: 'missed', note: 'FY26 profit fell ~28%; Q2 profit was still down YoY even as revenue rose 25%.' },
      ],
      trend: `The order book keeps hitting records and margins are climbing back — but the base services business isn’t actually growing and profit has fallen, so the recovery is a promise the next few quarters still have to deliver.`,
      note: `Read from Cyient’s last three earnings calls (Q4 FY26, Q1 FY27, Q2 FY27). We organise management’s own words.`,
    },
    like: [
      { t: 'Record order book', tag: 'Deal wins', d: 'Services order intake US$158m (+21%, technology orders +40%) and a record DLM order book (book-to-bill 1.6×) — strong forward visibility.' },
      { t: 'Margins are recovering', tag: 'Margin recovery', d: 'Services EBIT margin climbed 12.4% → 13.2% → 14.2% over three quarters on cost and productivity actions.' },
      { t: 'Manufacturing growth engine', tag: 'DLM growth', d: 'Cyient DLM revenue grew +26.5% YoY (aerospace +62%) with a record order book — a structural manufacturing tailwind.' },
      { t: 'Low attrition', tag: 'People economics', d: 'Attrition down to 14.6% from an ~18% peak — retention and talent costs under control.' },
      { t: 'Clean balance sheet + buyback', tag: 'Cash · payout', d: 'Net cash, a completed ₹720 cr buyback and an interim dividend — shareholder-friendly through the downturn.' },
      { t: 'Secular end-markets', tag: 'End-markets', d: 'Exposure to defence, aerospace aftermarket, AI/semiconductors and data-centre infrastructure — with Cyient Semiconductors funded separately.' },
    ],
    dislike: [
      { t: 'Organic growth has stalled', tag: 'Real sales growth', d: 'Services organic growth is roughly flat (Q2 ~+0.4% YoY); reported growth leans on the TAO acquisition, not the base business.' },
      { t: 'Profit is falling', tag: 'Earnings', d: 'FY26 profit fell ~28% to ₹463 cr and is still declining — revenue up, profit down.' },
      { t: 'Margin promise slipped', tag: 'Guidance cut', d: 'The 15% services-margin target moved from Q4 FY27 to H1 FY28, and wage hikes land in H2 FY27.' },
      { t: 'Manufacturing margins eroding', tag: 'DLM margin', d: 'DLM’s EBITDA margin fell to 8.7% (−135bps).' },
      { t: 'Weak top accounts', tag: 'Client concentration', d: 'Top-5 clients grew only +0.2% QoQ, and the energy and utilities verticals shrank.' },
      { t: 'Rich on depressed earnings', tag: 'Valuation', d: '~30× earnings on a ~9% ROE — a recovery is already in the price.' },
    ],
    financials: {
      cols: ['FY24', 'FY25', 'FY26'],
      rows: [
        { k: 'Revenue', v: ['7,147', '7,360', '7,268'] },
        { k: '— growth', v: ['—', '+3%', '−1%'], pos: [false, true, false] },
        { k: 'Net profit', v: ['703', '648', '463'] },
        { k: '— growth', v: ['—', '−8%', '−28%'], pos: [false, false, false] },
        { k: 'Operating (EBITDA) margin', v: ['18%', '15%', '12%'] },
      ],
    },
    fnote: `Consolidated figures (services + Cyient DLM). Latest quarter — Q2 FY27 (reported 22 Oct 2026): revenue ₹2,235 cr (+25% YoY, flattered by DLM and the TAO acquisition), net profit ~₹121 cr (owners) / ₹132 cr total, down YoY. P/E ≈ 30× · ROE ≈ 9% · ROCE ≈ 12% · net cash · interim dividend ₹12. Figures from Screener (4 Nov 2026).`,
    close: `A genuine turnaround candidate — the order book and margins are healing — but the base services business still isn’t growing and profit has fallen, while the stock already prices a recovery. We’d want to see organic growth actually turn before paying ~30× for it.`,
    sources: `Numbers: Screener (4 Nov 2026, consolidated). Management commentary: Cyient’s Q4 FY26, Q1 FY27 and Q2 FY27 earnings calls. Live price: the dashboard feed.`,
  },

  HDFCAMC: {
    ticker: 'HDFCAMC', name: 'HDFC Asset Management', ourSector: 'AMC & Wealth', asOf: 'Q2 FY27',
    lead: `India's largest active mutual-fund manager by equity assets — it runs ~₹9.7 lakh crore for millions of investors and earns a fee on every rupee, with HDFC Bank as its parent.`,
    what: `HDFC AMC runs <b>mutual funds</b> — it manages money for millions of investors and earns a small annual fee (a fraction of a percent) on the total assets it manages. The more assets it gathers, especially higher-fee <b>equity</b> funds, the more it earns — at very high margins, because managing one more rupee costs almost nothing. It is ~63% equity-weighted and backed by HDFC Bank.`,
    facts: [
      { k: 'Assets managed', v: '≈ ₹9.7 lakh cr' },
      { k: 'Equity mix', v: '≈ 63%' },
      { k: 'Operating margin', v: '≈ 80%' },
      { k: 'ROE', v: '≈ 33%' },
      { k: 'P/E', v: '≈ 36×' },
    ],
    quality: 86, price: 42, verdict: 'Watchlist', verdictSub: 'Elite economics · richly valued',
    takeaways: [
      `Elite economics — ~33% ROE, ~80% margins, AUM +10%`,
      `Market share is slipping and SIP momentum lags the industry`,
      `Richly valued at ~36× — priced for sustained premium growth`,
    ],
    why: `HDFC AMC is one of the highest-quality businesses on the market — tiny capital, ~80% margins, ~33% ROE, and fees that compound as assets grow. The watch is that its <b>market share is slipping</b> and its SIP flows lag a booming industry — and at ~36× earnings the price assumes the premium holds.`,
    trigger: `It becomes a <b>Buy</b> if the price cools, <b>or</b> its flow and market-share momentum turn back up (SIP book growing with the industry again) — proof the share erosion was a pause, not a trend.`,
    intrinsic: {
      low: '₹1,950', high: '₹2,250',
      basis: '~28–32× FY27E EPS — a premium, below today’s ~36×',
      read: 'Trading above our range — priced for sustained premium growth.',
      tone: 'rich',
    },
    valuation: {
      metric: 'P/E — the AMC lens',
      now: '~36×', fair: '~30×',
      extra: '~12× book · fees ~47bps of AUM · ~2.2% yield',
    },
    kpis: [
      { k: 'AUM growth', v: '+10% YoY', tone: 'good' },
      { k: 'Equity mix', v: '~63%', tone: 'good' },
      { k: 'Fee yield', v: '~47 bps', tone: 'good' },
      { k: 'Market share', v: '11.1% (slipping)', tone: 'watch' },
      { k: 'SIP momentum', v: 'flat QoQ', tone: 'watch' },
      { k: 'Operating margin', v: '~80%', tone: 'good' },
      { k: 'ROE', v: '~33%', tone: 'good' },
    ],
    concalls: {
      rows: [
        { theme: 'AUM growth', guided: 'Grow above industry', status: 'kept', note: 'Average AUM ₹9.69 lakh cr (+10% YoY); equity assets +14% YoY.' },
        { theme: 'Fee yields', guided: 'Hold a ~33–35bps net-margin corridor', status: 'kept', note: 'Blended yield held ~47bps — no compression despite the 2026 fee-regulation reforms.' },
        { theme: 'SIP / flows', guided: 'Over 75% of flows from sticky SIPs', status: 'watch', note: 'The SIP book was flat quarter-on-quarter while the industry hit record SIP inflows — flow momentum is lagging.' },
        { theme: 'Market share', guided: 'Maintain leadership', status: 'missed', note: 'Overall share slipped for a second straight quarter to 11.1%; active-equity share −20bps YoY.' },
        { theme: 'Costs', guided: 'Operating leverage', status: 'kept', note: 'Cost-to-income improved to 21.1% — scale economics intact.' },
        { theme: 'Profit', guided: '—', status: 'watch', note: 'Headline profit was only +4% YoY (weak treasury gains); core pre-tax profit grew +16%.' },
      ],
      trend: `The engine — assets, fees, margins — keeps delivering, but the share of new money coming in is quietly slipping and SIP momentum lags the industry. The quality is intact while the growth edge is being tested.`,
      note: `Read from HDFC AMC’s last three earnings calls (Q4 FY26, Q1 FY27, Q2 FY27). We organise management’s own words.`,
    },
    like: [
      { t: 'Best-in-class economics', tag: 'Returns · margins', d: '~33% ROE, ~43% ROCE, ~80% operating margin, near debt-free, ~79% payout — an exceptional, capital-light compounder.' },
      { t: '#1 active-equity franchise', tag: 'Dominant franchise', d: 'The largest active-equity manager; equity is ~63% of assets — the highest-fee, stickiest pool.' },
      { t: 'Double-digit AUM growth', tag: 'AUM growth', d: 'Assets under management grew ~10% YoY to ₹9.7 lakh cr; equity assets +14%.' },
      { t: 'Fee yields holding up', tag: 'Fee yield', d: 'Blended fee yield held ~47bps with no compression, even after 2026’s fee-cap reforms.' },
      { t: 'Structural SIP tailwind', tag: 'SIP flows', d: 'Over 75% of net flows are sticky monthly SIPs — a recurring, resilient inflow base.' },
      { t: 'Strong parent + optionality', tag: 'Parent · diversification', d: 'HDFC Bank owns ~52%, and new engines (SIF, PMS incl. large EPFO mandates, private credit, passives) widen the base.' },
    ],
    dislike: [
      { t: 'Market share is slipping', tag: 'Market share', d: 'Overall AUM share fell for a second straight quarter to 11.1%, and active-equity share is down ~20bps YoY.' },
      { t: 'SIP momentum lagging', tag: 'Flow momentum', d: 'Its SIP book was flat QoQ while the industry set record SIP inflows — it isn’t fully capturing the boom.' },
      { t: 'Earnings swing with markets', tag: 'Earnings quality', d: 'Headline profit was only +4% YoY as treasury/mark-to-market gains fell — profit moves with market levels.' },
      { t: 'Fee-regulation overhang', tag: 'Regulation', d: 'SEBI’s 2026 expense-ratio reforms put slow, structural downward pressure on fee yields over time.' },
      { t: 'Passives threat', tag: 'Passives', d: 'Low-cost index funds keep gaining — a structural risk to HDFC’s high-margin active core.' },
      { t: 'Rich valuation', tag: 'Valuation', d: '~36× earnings and ~12× book — priced for sustained premium growth, with little cushion if share or yields slip.' },
    ],
    financials: {
      cols: ['FY24', 'FY25', 'FY26'],
      rows: [
        { k: 'Revenue', v: ['3,159', '4,050', '4,611'] },
        { k: '— growth', v: ['—', '+28%', '+14%'], pos: [false, true, true] },
        { k: 'Net profit', v: ['1,946', '2,461', '2,859'] },
        { k: '— growth', v: ['—', '+26%', '+16%'], pos: [false, true, true] },
        { k: 'Operating margin', v: ['80%', '83%', '82%'] },
      ],
    },
    fnote: `Latest quarter — Q2 FY27 (reported 15 Oct 2026): core revenue ₹1,169 cr (+14% YoY), net profit ₹750 cr (+4% YoY, −11% QoQ on lower treasury gains; core pre-tax +16%). Average AUM ₹9.69 lakh cr, equity ~63%. P/E ≈ 36× · ROE ≈ 33% · operating margin ≈ 80% · dividend yield ≈ 2.2%. Figures from Screener (4 Nov 2026).`,
    close: `One of the finest compounders on the market — tiny capital, fat margins, a sticky SIP base — but its share of new money is slipping and the price (~36×) already assumes the premium endures. A wonderful business we’d rather own at a less demanding price, or on proof the flow momentum has turned.`,
    sources: `Numbers: Screener (4 Nov 2026). Management commentary: HDFC AMC’s Q4 FY26, Q1 FY27 and Q2 FY27 earnings calls. Live price: the dashboard feed.`,
  },

  LICI: {
    ticker: 'LICI', name: 'Life Insurance Corporation', ourSector: 'Insurance', asOf: 'Q1 FY27 · Q2 due 5 Nov',
    lead: `India's dominant life insurer — ~₹57 lakh crore of assets, ~200 million policies and over half the market — now slowly shifting toward higher-margin products.`,
    what: `LIC is India's state-owned life-insurance giant — it collects premiums from <b>~200 million policyholders</b>, invests the money (it is the country's largest investor, ~₹57 lakh crore), and pays claims. It still writes over half of India's new life policies. For years it leaned on low-margin savings products sold by a vast agent army; the story now is a slow shift to <b>higher-margin "non-par" products</b> that lift the profit on each new policy.`,
    facts: [
      { k: 'New-premium share', v: '≈ 57%' },
      { k: 'New-business margin', v: '≈ 21%' },
      { k: 'Embedded value', v: '₹7.9 lakh cr' },
      { k: 'Price / EV', v: '≈ 0.66×' },
      { k: 'Govt-owned', v: '≈ 96%' },
    ],
    quality: 68, price: 70, verdict: 'Watchlist', verdictSub: 'Deep value · slow turnaround',
    takeaways: [
      `Dominant scale (~57% share) now improving its product mix`,
      `New-business margin jumped to ~21% (+360bps); profit +19%`,
      `Deeply cheap (~0.66× embedded value) — but persistency and share slip`,
    ],
    why: `LIC is unmatched in scale and genuinely improving where it matters most — the <b>profit on new business</b> (margin up sharply). It is also strikingly cheap (~0.66× embedded value). The offsets: weakening long-term persistency, slipping market share, near-total reliance on agents, and heavy government ownership.`,
    trigger: `A clear re-rating catalyst — new-business margin and persistency improving together while market share stabilises — would turn the deep discount into a <b>Buy</b>; today the overhangs (government stake, regulation) cap it.`,
    intrinsic: {
      low: '₹520', high: '₹600',
      basis: '~0.85–1.0× embedded value — still a discount to private peers',
      read: 'Trading below our range — a real discount to embedded value, with the slow turnaround the catch.',
      tone: 'good',
    },
    valuation: {
      metric: 'Price / embedded value — the insurer lens',
      now: '~0.66×', fair: '~0.9–1.0×',
      extra: '~8.6× earnings · ~2.4% yield',
    },
    kpis: [
      { k: 'New-business margin (VNB)', v: '~22.9%', tone: 'good' },
      { k: 'VNB growth', v: '+41.6%', tone: 'good' },
      { k: 'Non-par mix', v: '35.1%', tone: 'good' },
      { k: '61-month persistency', v: '59.3% (down)', tone: 'rich' },
      { k: 'New-premium share', v: '56.7% (slipping)', tone: 'watch' },
      { k: 'Embedded value growth', v: '+1.6%', tone: 'watch' },
      { k: 'Solvency', v: '2.35', tone: 'good' },
    ],
    concalls: {
      rows: [
        { theme: 'New-business margin (VNB)', guided: 'Expand via non-par mix', status: 'kept', note: 'Net VNB margin rose 17.6% → 21.2% in FY26 (+360bps), and 22.9% in Q1 FY27 — the clearest win.' },
        { theme: 'New-business profit', guided: 'Keep growing VNB', status: 'kept', note: 'Value of new business +41.6% to ₹14,179 cr in FY26; +61% in Q1 FY27.' },
        { theme: 'Non-par mix', guided: 'Raise the higher-margin share', status: 'kept', note: 'Non-par share of individual new business rose 27.7% → 35.1%.' },
        { theme: 'Persistency', guided: 'Improve retention', status: 'missed', note: 'Long-term (61-month) persistency FELL to 59.3% (from 63.1%) — customers lapsing earlier than private peers.' },
        { theme: 'Market share', guided: 'Maintain leadership', status: 'watch', note: 'New-premium share slipped to 56.7% (from 57.1%); private players grow faster on the individual side.' },
        { theme: 'Embedded value', guided: 'Grow EV', status: 'watch', note: 'Embedded value grew only +1.6% as market and rate moves offset the operating gains.' },
      ],
      trend: `LIC is delivering exactly where the market wanted — richer product mix and much higher new-business margins — but it is leaking on the slower-moving dials: persistency, market share and embedded-value growth. A real mix turnaround, shadowed by a retention problem.`,
      note: `Read from LIC’s FY26 (Q4) and Q1 FY27 earnings calls and disclosures. We organise management’s own words. Q2 FY27 is due 5 Nov 2026.`,
    },
    like: [
      { t: 'Unmatched scale and leadership', tag: 'Dominant franchise', d: '~57% of new-business premium, ~200 million policies and ₹57 lakh cr of assets — India’s largest investor and by far its biggest insurer.' },
      { t: 'Margin transformation under way', tag: 'VNB margin', d: 'The profit margin on new business jumped 17.6% → 21.2% in FY26 (22.9% in Q1 FY27) as it sold more higher-margin non-par products.' },
      { t: 'Record new-business profit', tag: 'VNB growth', d: 'Value of new business grew +41.6% to ₹14,179 cr in FY26 — its fastest-improving metric.' },
      { t: 'High profit and strong capital', tag: 'Profit · solvency', d: 'Profit +19% to ₹57,419 cr, solvency a comfortable 2.35, and the expense ratio improved to ~11.9%.' },
      { t: 'Deep value + shareholder returns', tag: 'Valuation', d: 'Trades at ~0.66× embedded value and ~8.6× earnings — a steep discount to private insurers — with a first-ever 1:1 bonus and a ~2.4% dividend yield.' },
      { t: 'Channel diversification starting', tag: 'Channel mix', d: 'Bank and alternate new-business premium grew +45% to cross ₹5,000 cr — early progress beyond the agent army.' },
    ],
    dislike: [
      { t: 'Long-term persistency weakening', tag: 'Persistency', d: '61-month persistency fell to 59.3% (from 63.1%) — too many customers lapse before policies mature, behind private peers.' },
      { t: 'Market share slipping', tag: 'Market share', d: 'New-premium share eased to 56.7%, and on the individual side private insurers are clearly growing faster.' },
      { t: 'Embedded value barely grew', tag: 'EV growth', d: 'Embedded value rose only +1.6% as market and rate moves wiped out most of the operating gain.' },
      { t: 'Over-reliant on agents', tag: 'Channel concentration', d: 'Agents still write ~92% of individual new-business premium — a concentrated, old-style distribution model.' },
      { t: 'Margins still below peers', tag: 'Margin gap', d: '~21% new-business margin still trails SBI Life and HDFC Life (high-20s); the par-savings book caps the mix.' },
      { t: 'Government & regulation overhang', tag: 'Ownership · regulation', d: '~96% government-owned (thin free float), plus GST changes, new surrender-value rules and pending accounting/capital reforms cloud the outlook.' },
    ],
    financials: {
      cols: ['FY24', 'FY25', 'FY26'],
      rows: [
        { k: 'Net profit', v: ['40,676', '48,151', '57,419'] },
        { k: '— growth', v: ['—', '+18%', '+19%'], pos: [false, true, true] },
        { k: 'Total income', v: ['8,42,708', '8,86,763', '9,76,280'] },
        { k: 'New-business margin', v: ['—', '17.6%', '21.2%'] },
      ],
    },
    fnote: `Figures reflect the 1:1 bonus (shares ~doubled, price ~halved). Latest quarter — Q1 FY27 (reported Aug 2026): net profit ₹13,492 cr (+23% YoY); new-business margin ~22.9%. Q2 FY27 is due 5 Nov 2026. Embedded value ₹7.9 lakh cr (Mar 2026) · Price/EV ≈ 0.66× · P/E ≈ 8.6× · ROE ≈ 38% · dividend yield ≈ 2.4%. "Total income" is premium plus investment income, not premium alone. Figures from Screener (4 Nov 2026).`,
    close: `The cheapest name here by far (~0.66× embedded value) and genuinely improving its product mix and new-business margins — but it is leaking on persistency, market share and embedded-value growth, and carries a heavy government-ownership overhang. A deep-value turnaround to watch: a lot to like on price, with real structural work still to prove.`,
    sources: `Numbers: Screener (4 Nov 2026). Management commentary: LIC’s FY26 (Q4) and Q1 FY27 earnings calls and disclosures. Live price: the dashboard feed.`,
  },

  CANFINHOME: {
    ticker: 'CANFINHOME', name: 'Can Fin Homes', ourSector: 'NBFC & Housing Finance', asOf: 'Q2 FY27',
    lead: `A conservative, Canara Bank-backed home-loan lender with a salaried-heavy book and some of the lowest bad loans in the sector.`,
    what: `Can Fin Homes <b>lends money to people to buy homes</b>. It borrows (from banks, the National Housing Bank and bond markets) and lends at a higher rate; the gap is its profit. Its edge is caution: it lends mostly to <b>salaried borrowers</b> with small-to-mid-size loans, which keeps defaults extremely low. It is promoted by <b>Canara Bank</b>, which lends credibility and access to cheap funding.`,
    facts: [
      { k: 'Loan book', v: '≈ ₹43,500 cr' },
      { k: 'Bad loans (GNPA)', v: '0.90%' },
      { k: 'Margin (NIM)', v: '≈ 3.9%' },
      { k: 'ROE', v: '≈ 19.7%' },
      { k: 'P/E', v: '≈ 8×' },
    ],
    quality: 76, price: 66, verdict: 'Watchlist', verdictSub: 'Low-risk lender · cheap but slow',
    takeaways: [
      `Among the cleanest books in the sector (bad loans 0.9%)`,
      `Loan growth keeps missing its ~14% target (~10%)`,
      `Cheap at ~8× earnings / ~1.5× book for a ~20% ROE`,
    ],
    why: `Can Fin is a conservative, high-return lender with <b>pristine asset quality</b> and a cheap valuation. The catch is <b>growth</b>: its loan book keeps growing below its own ~14% target, and a recent IT-system migration dented disbursements — so it is a safe, cheap compounder that needs growth to re-accelerate to re-rate.`,
    trigger: `It becomes a <b>Buy</b> once loan growth re-accelerates toward the ~14% target (disbursements recovering after the IT migration) while asset quality stays pristine — the catalyst to close the valuation discount.`,
    intrinsic: {
      low: '₹880', high: '₹980',
      basis: '~1.8–2.0× book / ~10–11× earnings for a ~20% ROE',
      read: 'Trading below our range — cheap for the quality, if growth comes back.',
      tone: 'good',
    },
    valuation: {
      metric: 'Price / book — the lender lens',
      now: '~1.5×', fair: '~1.8–2.0×',
      extra: '~8× earnings · ROE ~20% · GNPA 0.90%',
    },
    kpis: [
      { k: 'Loan-book growth', v: '~9.8% (vs ~14% goal)', tone: 'watch' },
      { k: 'Net interest margin', v: '~3.9%', tone: 'good' },
      { k: 'Bad loans (GNPA)', v: '0.90%', tone: 'good' },
      { k: 'ROE', v: '~19.7%', tone: 'good' },
      { k: 'Credit cost', v: '~7–9 bps', tone: 'good' },
      { k: 'Disbursements (Q2)', v: '−7%', tone: 'watch' },
      { k: 'Capital ratio', v: '~21–23%', tone: 'good' },
    ],
    concalls: {
      rows: [
        { theme: 'Loan-book growth', guided: '~14% in FY27', status: 'missed', note: 'AUM grew only ~9.8% YoY (₹43,539 cr) — persistently below the ~14% target as prepayments stay high.' },
        { theme: 'Disbursements', guided: '₹13,000 cr (+20%) in FY27', status: 'watch', note: 'Q1 beat (+29%) but Q2 missed (−7%) after a core IT-system migration; H2 now needs a sharp catch-up.' },
        { theme: 'Margins (NIM)', guided: '3.75–3.80%', status: 'kept', note: 'NIM came in ahead at ~3.88%, with cost of funds stable ~7.0%.' },
        { theme: 'Asset quality', guided: 'Keep it pristine', status: 'kept', note: 'GNPA ~0.90%, NNPA ~0.42%, credit cost only ~7–9bps — among the lowest in the sector.' },
        { theme: 'Funding mix', guided: 'Reduce short-term reliance', status: 'kept', note: 'Short-term borrowings cut to ~12% (from ~27%), with cheap NHB refinance at ~6.6–6.7%.' },
        { theme: 'Returns', guided: 'ROE 18%+', status: 'watch', note: 'ROE drifted to ~17% as costs rose — below the 18%+ aspiration.' },
      ],
      trend: `On safety and funding, Can Fin delivers exactly what it promises — pristine loans, healthy margins, cheaper borrowing. Where it keeps falling short is growth: the loan book won’t hit its target, and an IT migration knocked disbursements. A low-risk lender whose growth engine is stuck in a lower gear.`,
      note: `Read from Can Fin Homes’ last three earnings calls (Q4 FY26, Q1 FY27, Q2 FY27). We organise management’s own words.`,
    },
    like: [
      { t: 'Pristine asset quality', tag: 'Bad loans', d: 'GNPA ~0.90%, NNPA ~0.42% and credit cost of just ~7–9bps — among the cleanest books in housing finance.' },
      { t: 'Low-risk, salaried book', tag: 'Loan mix', d: '~68% salaried/professional borrowers and ~84% home loans with modest ticket sizes — the backbone of those sub-1% defaults.' },
      { t: 'Strong, steady returns', tag: 'Returns', d: 'ROE ~20% and ROA ~2.5%, built conservatively rather than on risky lending.' },
      { t: 'Cheap funding + strong parent', tag: 'Funding · parent', d: 'Canara Bank promoter, well-capitalised (capital ratio ~21–23%), with access to cheap NHB refinance at ~6.6–6.7%.' },
      { t: 'Improving funding & margins', tag: 'Spread', d: 'Short-term borrowings cut to ~12% (from ~27%) and NIM expanding to ~3.9% — a more stable, cheaper funding mix.' },
      { t: 'Cheap for the quality', tag: 'Valuation', d: '~8× earnings and ~1.5× book for a ~20% ROE franchise.' },
    ],
    dislike: [
      { t: 'Growth keeps missing target', tag: 'Loan growth', d: 'The loan book grew only ~9.8% vs a ~14% goal; high prepayments keep net growth low.' },
      { t: 'IT-migration disruption', tag: 'Execution', d: 'A core system migration cut ~₹360 cr off Q2 disbursements (−7%); the FY27 target now needs an unproven H2 rebound.' },
      { t: 'Narrow spreads & bank competition', tag: 'NIM pressure', d: 'A thin ~2.75% spread and aggressive bank home-loan pricing limit how much margin it can hold.' },
      { t: 'South-India concentration', tag: 'Geography', d: '~65% of branches are in the South, with thin presence in high-demand northern and eastern states.' },
      { t: 'Returns drifting down', tag: 'Returns · costs', d: 'ROE slipped toward ~17% on rising costs, and FY26 profit was flattered by an unusually low tax rate.' },
      { t: 'Growth / re-rating overhang', tag: 'Re-rating overhang', d: 'A past branch-fraud episode and a slow growth narrative keep the valuation discount in place until growth re-accelerates.' },
    ],
    financials: {
      cols: ['FY24', 'FY25', 'FY26'],
      rows: [
        { k: 'Total income', v: ['3,523', '3,879', '4,217'] },
        { k: '— growth', v: ['—', '+10%', '+9%'], pos: [false, true, true] },
        { k: 'Net profit', v: ['751', '857', '1,086'] },
        { k: '— growth', v: ['—', '+14%', '+27%'], pos: [false, true, true] },
      ],
    },
    fnote: `Latest quarter — Q2 FY27 (reported Oct 2026): net profit ₹275 cr (+9% YoY); H1 profit ₹543 cr (+14%). Loan book ₹43,539 cr (+9.8%). Bad loans: GNPA 0.90%, NNPA 0.42%. P/E ≈ 8× · P/B ≈ 1.5× · ROE ≈ 19.7% · dividend yield ≈ 2.1%. FY26 profit growth (+27%) was flattered by a low tax rate; underlying ~20%. Figures from Screener (4 Nov 2026).`,
    close: `A conservative, high-return home-loan lender with some of the cleanest loans in the business, going cheap at ~8× earnings — the kind of quality that rarely trades this low. What is missing is growth: until the loan book re-accelerates toward its target, the discount is likely to persist. A safe, cheap name to own if growth returns.`,
    sources: `Numbers: Screener (4 Nov 2026). Management commentary: Can Fin Homes’ Q4 FY26, Q1 FY27 and Q2 FY27 earnings calls. Live price: the dashboard feed.`,
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

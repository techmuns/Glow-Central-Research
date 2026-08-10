#!/usr/bin/env node
// gen-mock-concalls.mjs — generates the ILLUSTRATIVE con-call data set.
//
//   node scripts/gen-mock-concalls.mjs
//
// Writes three files:
//   public/data/mock/concall-calls.json    60 companies x 2 calls (latest + previous quarter)
//   public/data/mock/concall-keywords.json the 9 default keywords with their alias lists
//   public/data/mock/catalysts.json        ~100 catalysts across those companies
//
// WHAT IS REAL AND WHAT IS NOT
//   Real:      company names, tickers, sectors and market caps — from public/data/universe.json,
//              the actual NSE-500 screener export.
//   Synthetic: every transcript line, every guidance number, every catalyst.
//   Fictional: EVERY PERSON AND EVERY BROKERAGE FIRM. Unlike the financials in earnings.json —
//              where inventing a number for a real company is clearly labelled and bounded —
//              putting invented words in the mouth of a real, named analyst or executive
//              misattributes speech to a person. So the management and analyst names here, and
//              the firms they are shown working for, are all made up. The generated firm list
//              below is deliberately unlike any real Indian brokerage.
//
// The dashboard states all of this everywhere it shows the data: an amber ribbon on the tab,
// "Mock data" on the freshness card, `mock` rows in the Sources modal, and a banner row in the
// Excel export.
//
// THE TRANSCRIPTS ARE THE POINT. The keyword engine (js/concall/keyword-engine.js) scans this
// text at runtime — nothing here is a precomputed count. So the sentence templates below embed
// the tracked terms the way a real call would: management volunteering capex in prepared
// remarks, an analyst asking about margin guidance in Q&A, aliases ("capital outlay",
// "capital expenditure") used interchangeably with the headline term. Edit a keyword's aliases
// in the UI and the counts move because the text genuinely contains these words.
//
// Determinism: mulberry32 seeded from SEED, so reruns are byte-identical and a diff means a
// real change.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UNIVERSE_PATH = resolve(__dirname, '../public/data/universe.json');
const CALLS_PATH = resolve(__dirname, '../public/data/mock/concall-calls.json');
const KEYWORDS_PATH = resolve(__dirname, '../public/data/mock/concall-keywords.json');
const CATALYSTS_PATH = resolve(__dirname, '../public/data/mock/catalysts.json');
const PORTFOLIO_PATH = resolve(__dirname, '../public/data/portfolio.json');

const SEED = 20260811;
const COMPANY_COUNT = 60;
const LATEST_QUARTER = 'Q1FY27'; // Apr–Jun 2026
const PREV_QUARTER = 'Q4FY26';
const TODAY = '2026-08-10';
const LIVE_COUNT = 4; // calls shown as in progress
const SCHEDULED_COUNT = 8; // calls scheduled in the next 7 days
const FIRST_CALL_ONLY = 4; // companies with no prior-quarter call, so Comparison has to degrade

// ---------------------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const rand = (lo, hi) => lo + rng() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const chance = (p) => rng() < p;
const round = (n, d = 1) => {
  const m = 10 ** d;
  return Math.round(n * m) / m;
};
/** Sample `n` distinct members of `arr`. */
function sample(arr, n) {
  const pool = arr.slice();
  const out = [];
  while (out.length < n && pool.length) out.push(...pool.splice(Math.floor(rng() * pool.length), 1));
  return out;
}

const parseMarketCapCr = (value) => {
  const n = Number(String(value ?? '').replace(/,/g, '').replace(/Cr\.?/i, '').trim());
  return Number.isFinite(n) ? n : null;
};
const tickerFromUrl = (url) => String(url || '').match(/\/company\/([^/]+)/)?.[1]?.toUpperCase() || null;
const isoDate = (d) => d.toISOString().slice(0, 10);
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

// ---------------------------------------------------------------------------------------
// The default keyword set. `terms` is what the engine actually matches on — the label is only
// a display name. Aliases matter: a call that says "capital outlay" three times and never says
// "capex" should still register under Capex.
//
// COLOURS are restricted to the categorical half of the design system. Emerald, amber and rose
// are semantic in this dashboard (pass / partial / fail), so a keyword may never take one —
// "Exports" tinted emerald would read as a verdict. See CLAUDE.md.
// ---------------------------------------------------------------------------------------
const DEFAULT_KEYWORDS = [
  { id: 'capex', label: 'Capex', category: 'Investment', color: 'indigo',
    terms: ['capex', 'capital expenditure', 'capital outlay', 'capital spend'] },
  { id: 'order-book', label: 'Order book', category: 'Demand', color: 'violet',
    terms: ['order book', 'order inflow', 'order backlog', 'order intake'] },
  { id: 'capacity-expansion', label: 'Capacity expansion', category: 'Investment', color: 'purple',
    terms: ['capacity expansion', 'brownfield', 'greenfield', 'debottlenecking', 'new line'] },
  { id: 'margin-guidance', label: 'Margin guidance', category: 'Guidance', color: 'fuchsia',
    terms: ['margin guidance', 'margin outlook', 'margin trajectory', 'EBITDA margin'] },
  { id: 'demand-outlook', label: 'Demand outlook', category: 'Demand', color: 'pink',
    terms: ['demand outlook', 'demand environment', 'demand momentum', 'offtake'] },
  { id: 'pricing-power', label: 'Pricing power', category: 'Margins', color: 'sky',
    terms: ['pricing power', 'price hike', 'price increase', 'realisation'] },
  { id: 'debt-reduction', label: 'Debt reduction', category: 'Balance sheet', color: 'cyan',
    terms: ['debt reduction', 'deleveraging', 'net debt', 'debt repayment'] },
  { id: 'exports', label: 'Exports', category: 'Demand', color: 'blue',
    terms: ['exports', 'export markets', 'overseas markets', 'international business'] },
  { id: 'new-product', label: 'New product', category: 'Growth', color: 'teal',
    terms: ['new product', 'product launch', 'new SKU', 'product pipeline'] },
];

// ---------------------------------------------------------------------------------------
// People and firms — ALL FICTIONAL. See the header note.
// ---------------------------------------------------------------------------------------
const FIRST_NAMES = ['Arvind', 'Meera', 'Rohit', 'Kavya', 'Sanjay', 'Divya', 'Nikhil', 'Ananya', 'Prashant', 'Sneha',
  'Vikram', 'Ritu', 'Harish', 'Preeti', 'Karthik', 'Nandini', 'Suresh', 'Ishita', 'Manoj', 'Lakshmi',
  'Aditya', 'Shruti', 'Rajeev', 'Payal', 'Girish', 'Tanvi', 'Mohan', 'Deepa'];
const LAST_NAMES = ['Iyer', 'Nair', 'Deshpande', 'Bhattacharya', 'Raghavan', 'Menon', 'Kulkarni', 'Sundaram',
  'Chandrasekhar', 'Mahadevan', 'Venkatesh', 'Rangarajan', 'Bhargava', 'Sridharan', 'Padmanabhan',
  'Krishnamurthy', 'Balasubramanian', 'Ramaswamy', 'Gopalakrishnan', 'Vaidyanathan'];
const MGMT_ROLES = ['Managing Director & CEO', 'Chief Financial Officer', 'Chief Operating Officer',
  'Whole-time Director', 'Head — Investor Relations', 'President — Operations'];
// Deliberately unlike any real Indian brokerage.
const FIRMS = ['Meridian Securities', 'Chakra Capital', 'Nandan Research', 'Kaveri Broking',
  'Northlight Equities', 'Sundara Securities', 'Vantage Bharat Research', 'Palladin Capital',
  'Trikon Investment Research', 'Anvaya Securities'];

const fullName = () => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;

/** `n` distinct names. Drawing independently let the same person appear twice on one call. */
function distinctNames(n) {
  const seen = new Set();
  let guard = 0;
  while (seen.size < n && guard++ < n * 40) seen.add(fullName());
  return [...seen];
}

// ---------------------------------------------------------------------------------------
// Sentence banks.
//
// Each topic maps to one keyword id and supplies MANAGEMENT lines (used in prepared remarks
// and in answers) and ANALYST lines (used as questions). `{n}`-style slots are filled with
// plausible numbers so no two calls read identically. Every line embeds at least one of the
// keyword's aliases in natural position — that is what gives the scanner real text to find.
// ---------------------------------------------------------------------------------------
const TOPICS = {
  capex: {
    mgmt: [
      'On the capital expenditure side, we have committed ₹{amt} crore for FY{fy}, of which roughly {pct}% has already been drawn down.',
      'Our capex for the quarter stood at ₹{amt} crore, broadly in line with the phasing we laid out at the start of the year.',
      'We are guiding to a capital outlay of about ₹{amt} crore over the next eighteen months, funded entirely through internal accruals.',
      'The board has approved an incremental capital expenditure of ₹{amt} crore, and we expect commissioning towards the end of FY{fy}.',
      'Maintenance capex remains steady at around ₹{amt} crore a year; the growth capital spend sits on top of that.',
    ],
    analyst: [
      'Could you help us with the capex phasing for the rest of the year — how much of the ₹{amt} crore is back-ended?',
      'On capital expenditure, is there any risk of the outlay slipping into the next financial year?',
      'What is the peak capex you envisage before this cycle of investment tapers off?',
    ],
  },
  'order-book': {
    mgmt: [
      'Our order book at the end of the quarter stood at ₹{big} crore, which gives us revenue visibility of about {mon} months.',
      'Order inflow during the quarter was ₹{amt} crore, up {pct}% year on year, with a healthy mix from the private sector.',
      'The order backlog remains well diversified, and we have consciously stayed away from low-margin tenders.',
      'We booked order intake of ₹{amt} crore in the first quarter and the pipeline for the second half looks encouraging.',
    ],
    analyst: [
      'On the order book — what is the average execution period, and are you seeing any client-side delays?',
      'Order inflow has been lumpy for a few quarters now. Should we model this ₹{amt} crore as the new run-rate?',
      'How much of the order backlog is executable within this financial year?',
    ],
  },
  'capacity-expansion': {
    mgmt: [
      'The brownfield capacity expansion at our {plant} facility is on track and should come on stream by {mth}.',
      'We have completed debottlenecking at two of our older units, which adds roughly {pct}% to installed capacity at very low incremental cost.',
      'The greenfield project has received all statutory clearances and civil work has commenced.',
      'A new line is being installed at the {plant} plant; trial runs are expected to begin next quarter.',
    ],
    analyst: [
      'On the capacity expansion — what utilisation are you running at today, and when does the new capacity get absorbed?',
      'Is the greenfield project still within the original cost estimate, or have input costs pushed it up?',
      'Post debottlenecking, what does your total installed capacity look like exiting FY{fy}?',
    ],
  },
  'margin-guidance': {
    mgmt: [
      'On margin guidance, we are comfortable holding the {pct}% to {pct2}% EBITDA margin band for the full year.',
      'Our margin outlook for the second half is more constructive, largely on the back of operating leverage.',
      'We would rather not revise the margin trajectory upward on the strength of a single quarter.',
      'EBITDA margin for the quarter came in at {pct}%, an expansion of {bps} basis points year on year.',
    ],
    analyst: [
      'You have held margin guidance at {pct}% for three quarters now — what would have to happen for you to revise it upward?',
      'On the margin outlook, how much of the improvement this quarter is structural versus one-off?',
      'Is the EBITDA margin band you have guided to inclusive of the new capacity ramp-up costs?',
    ],
  },
  'demand-outlook': {
    mgmt: [
      'The demand environment through the quarter was steady, with rural offtake improving sequentially.',
      'Our demand outlook for the second half remains constructive, supported by a normal monsoon and festive restocking.',
      'Demand momentum in the institutional segment has been softer than we would like, and we are watching it closely.',
      'Primary offtake tracked secondary sales closely this quarter, which tells us channel inventory is healthy.',
    ],
    analyst: [
      'On the demand environment — are you seeing any down-trading in the entry-level portfolio?',
      'How would you characterise demand momentum exiting the quarter versus what you saw in the previous quarter?',
      'Has the demand outlook changed at all for your export-facing segments?',
    ],
  },
  'pricing-power': {
    mgmt: [
      'We took a calibrated price increase of about {pct}% across the portfolio in {mth}, and the pass-through has been orderly.',
      'Our pricing power in the premium segment remains intact; realisation improved {pct}% year on year.',
      'We have not needed a price hike this quarter — the benign input cost environment has done the work for us.',
      'Blended realisation for the quarter was ₹{amt} per unit, up from ₹{amt2} in the corresponding quarter.',
    ],
    analyst: [
      'On pricing power — has the price hike taken in {mth} stuck, or have you had to fund promotions to hold volumes?',
      'What is the realisation trajectory you are assuming for the rest of the year?',
      'If input costs revert, would you defend realisation or chase volume with a price decrease?',
    ],
  },
  'debt-reduction': {
    mgmt: [
      'Net debt at the end of the quarter stood at ₹{big} crore, down ₹{amt} crore sequentially.',
      'Our deleveraging programme is ahead of schedule and we expect to be net-debt-free by {mth} FY{fy}.',
      'We made a scheduled debt repayment of ₹{amt} crore during the quarter and prepaid a further ₹{amt2} crore.',
      'Debt reduction remains a stated priority; the board has reaffirmed a net-debt-to-EBITDA ceiling of {x} times.',
    ],
    analyst: [
      'On debt reduction — is the net debt target still achievable given the capex you have just announced?',
      'What is the cost of the debt you prepaid, and what does the blended cost look like post-repayment?',
      'Should we expect deleveraging to slow while the expansion is being funded?',
    ],
  },
  exports: {
    mgmt: [
      'Exports contributed {pct}% of revenue this quarter, up from {pct2}% a year ago.',
      'Our export markets, particularly in West Asia and Africa, grew {pct}% and remain a focus area.',
      'The international business has stabilised after two difficult quarters and is back to growth.',
      'We have received approvals that open up two new overseas markets for us from the next financial year.',
    ],
    analyst: [
      'On exports — how much of the growth is volume versus a currency tailwind?',
      'Are the overseas markets you have entered margin-accretive relative to the domestic business?',
      'What is the medium-term ambition for the international business as a share of revenue?',
    ],
  },
  'new-product': {
    mgmt: [
      'We completed a new product launch in the {seg} category during the quarter, and initial response has been encouraging.',
      'Our product pipeline for the next four quarters includes {n} launches, weighted towards the premium end.',
      'The new SKU introduced last quarter has already reached {pct}% of the category\'s revenue in the markets where it is available.',
      'Innovation contributed {pct}% of revenue this quarter, and we are targeting a higher share exiting FY{fy}.',
    ],
    analyst: [
      'On the new product launch — what kind of gross margin does it carry relative to the base portfolio?',
      'How should we think about the product pipeline translating into revenue over the next two years?',
      'Is the new SKU cannibalising the existing portfolio or genuinely expanding the category?',
    ],
  },
};
const TOPIC_IDS = Object.keys(TOPICS);

// Lines with no tracked keyword in them — filler that keeps the transcript from reading like a
// keyword-stuffed test fixture, and gives the scanner true negatives to skip over.
const NEUTRAL_MGMT = [
  'Thank you, and good evening to everyone joining us today.',
  'Before we take questions, let me hand over to my colleague to walk through the financials.',
  'Revenue for the quarter was ₹{big} crore, a growth of {pct}% over the corresponding quarter.',
  'Profit after tax came in at ₹{amt} crore for the quarter.',
  'Our balance sheet remains comfortable and working capital days improved by {n} days sequentially.',
  'We added {n} new distribution touchpoints during the quarter.',
  'Employee costs were slightly elevated on account of the annual increment cycle.',
  'I will stop here and open the floor for questions.',
  'That is a fair question, and let me give you some colour on it.',
  'We will take that offline and get back to you with the specifics.',
];
const NEUTRAL_ANALYST = [
  'Thank you for taking my question, and congratulations on the quarter.',
  'Just one clarification on the numbers you mentioned earlier.',
  'Could you repeat the figure you gave for the quarter?',
  'That is helpful, thank you. I will get back in the queue.',
];

const PLANTS = ['Halol', 'Hosur', 'Silvassa', 'Dahej', 'Sanand', 'Ranjangaon', 'Vizag', 'Haridwar', 'Pantnagar', 'Chittoor'];
const MONTHS = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];
const SEGMENTS = ['premium', 'value', 'institutional', 'rural', 'e-commerce', 'export', 'industrial'];

/** Fill the {slot} placeholders with plausible numbers. */
function fill(template) {
  return template
    .replace(/\{big\}/g, () => String(randInt(800, 9000).toLocaleString('en-IN')))
    .replace(/\{amt2\}/g, () => String(randInt(40, 400)))
    .replace(/\{amt\}/g, () => String(randInt(50, 900)))
    .replace(/\{pct2\}/g, () => String(round(rand(4, 22), 1)))
    .replace(/\{pct\}/g, () => String(round(rand(3, 26), 1)))
    .replace(/\{bps\}/g, () => String(randInt(20, 240)))
    .replace(/\{mon\}/g, () => String(randInt(14, 40)))
    .replace(/\{fy\}/g, () => pick(['26', '27', '28']))
    .replace(/\{mth\}/g, () => pick(MONTHS))
    .replace(/\{plant\}/g, () => pick(PLANTS))
    .replace(/\{seg\}/g, () => pick(SEGMENTS))
    .replace(/\{x\}/g, () => String(round(rand(0.8, 2.5), 1)))
    .replace(/\{n\}/g, () => String(randInt(2, 9)));
}

// ---------------------------------------------------------------------------------------
// Tone, themes, guidance, promises, risks
// ---------------------------------------------------------------------------------------
const TONE_DRIVERS_POS = ['repeated use of forward-looking commitments', 'guidance raised on two metrics',
  'unprompted disclosure of order pipeline', 'management volunteered capacity numbers before being asked',
  'confident answers on margin questions'];
const TONE_DRIVERS_NEG = ['hedged language around the demand environment', 'guidance withdrawn on one metric',
  'two analyst questions deferred to a follow-up', 'repeated references to input cost uncertainty',
  'management declined to quantify the second-half ramp'];
const TONE_DRIVERS_NEU = ['balanced commentary on costs and volumes', 'guidance maintained without revision',
  'consistent language versus the previous call'];

const THEME_POOL = ['Premiumisation', 'Rural recovery', 'Input cost normalisation', 'Capacity ramp-up',
  'Export diversification', 'Channel inventory correction', 'Deleveraging', 'Market share gains',
  'Distribution expansion', 'Operating leverage', 'Regulatory tailwind', 'Working capital discipline'];

const RISK_POOL = ['Input cost volatility, particularly crude-linked derivatives',
  'Slower-than-expected absorption of new capacity', 'Competitive intensity in the entry-level segment',
  'Currency exposure on the export book', 'Delayed government payments stretching receivables',
  'Monsoon dependence in rural demand', 'Regulatory review of pricing in one product category',
  'Concentration risk — top five customers are a large share of the order book'];

const GUIDANCE_METRICS = [
  { metric: 'FY27 revenue growth', unit: '%', lo: 6, hi: 22 },
  { metric: 'FY27 EBITDA margin', unit: '%', lo: 11, hi: 27 },
  { metric: 'FY27 capex', unit: '₹ Cr', lo: 150, hi: 1800 },
  { metric: 'Net debt / EBITDA', unit: 'x', lo: 0.3, hi: 2.4 },
  { metric: 'Export share of revenue', unit: '%', lo: 5, hi: 30 },
];

const PROMISE_POOL = [
  'Commission the {plant} expansion before the end of the financial year',
  'Bring net debt below ₹{amt} crore',
  'Hold EBITDA margin within the guided band for the full year',
  'Launch {n} new products in the premium portfolio',
  'Take export share above {pct}% of revenue',
  'Complete the debottlenecking programme at two units',
];

const CATALYST_TYPES = ['capacity expansion', 'new order', 'margin guidance', 'new product',
  'regulatory', 'M&A', 'demerger', 'capital allocation'];
const CATALYST_TEXT = {
  'capacity expansion': ['{plant} plant expansion commissioning', 'New line at {plant} going live', 'Debottlenecking programme completion'],
  'new order': ['Large infrastructure order expected to be booked', 'Repeat order from an anchor client', 'Export order from a new geography'],
  'margin guidance': ['Margin guidance revision at the next call', 'Full-year margin band to be reset upward', 'Cost programme benefits to land in H2'],
  'new product': ['Premium SKU national rollout', 'New product launch in the {seg} category', 'Product pipeline refresh across three categories'],
  regulatory: ['Pending approval for a new overseas market', 'Tariff review outcome', 'Environmental clearance for the greenfield site'],
  'M&A': ['Bolt-on acquisition under evaluation', 'Stake increase in the joint venture', 'Acquisition of a regional distributor'],
  demerger: ['Demerger of the non-core division', 'Listing of the subsidiary', 'Restructuring of the holding structure'],
  'capital allocation': ['Buyback under consideration', 'Dividend policy revision', 'Capital allocation framework to be published'],
};

// ---------------------------------------------------------------------------------------
// Transcript builder
// ---------------------------------------------------------------------------------------

/**
 * Build one call's transcript.
 *
 * `topicWeights` biases which keywords get talked about, so the same company's two calls
 * differ and the quarter-on-quarter deltas in the UI are meaningful rather than noise.
 */
function buildTranscript(management, analysts, topicWeights) {
  const segments = [];
  let t = 0;
  const push = (speaker, role, section, text) => {
    segments.push({ t, speaker, role, section, text });
    // A spoken sentence runs roughly 18–45 seconds of call time.
    t += randInt(18, 45);
  };

  const ir = management.find((m) => m.role.startsWith('Head')) || management[0];
  const ceo = management.find((m) => m.role.includes('CEO')) || management[0];
  const cfo = management.find((m) => m.role.includes('Financial')) || management[1] || management[0];

  // Weighted topic draw.
  const weightedPick = () => {
    const total = TOPIC_IDS.reduce((s, id) => s + (topicWeights[id] || 1), 0);
    let r = rng() * total;
    for (const id of TOPIC_IDS) {
      r -= topicWeights[id] || 1;
      if (r <= 0) return id;
    }
    return TOPIC_IDS[0];
  };

  // ---- prepared remarks -------------------------------------------------------------
  push(ir.name, ir.role, 'prepared',
    `Good evening everyone, and thank you for joining our ${LATEST_QUARTER} earnings call. On the call today we have ${ceo.name}, ${ceo.role}, and ${cfo.name}, ${cfo.role}.`);
  push(ceo.name, ceo.role, 'prepared', fill(pick(NEUTRAL_MGMT)));

  const preparedTopics = randInt(12, 18);
  for (let i = 0; i < preparedTopics; i++) {
    const topic = weightedPick();
    const speaker = chance(0.6) ? ceo : cfo;
    push(speaker.name, speaker.role, 'prepared', fill(pick(TOPICS[topic].mgmt)));
    if (chance(0.35)) push(speaker.name, speaker.role, 'prepared', fill(pick(NEUTRAL_MGMT)));
  }
  push(cfo.name, cfo.role, 'prepared', fill(pick(NEUTRAL_MGMT)));
  push(ceo.name, ceo.role, 'prepared', 'I will stop here and open the floor for questions.');

  // ---- Q&A ---------------------------------------------------------------------------
  const qaBlocks = randInt(14, 24);
  for (let i = 0; i < qaBlocks; i++) {
    const analyst = pick(analysts);
    const topic = weightedPick();
    if (chance(0.45)) push(analyst.name, `Analyst, ${analyst.firm}`, 'qna', pick(NEUTRAL_ANALYST));
    push(analyst.name, `Analyst, ${analyst.firm}`, 'qna', fill(pick(TOPICS[topic].analyst)));

    const responder = chance(0.55) ? ceo : cfo;
    // Most answers engage the topic; a minority deflect, which the Q&A tab flags.
    if (chance(0.15)) {
      push(responder.name, responder.role, 'qna', pick([
        'We would rather not give a specific number on that at this stage.',
        'That is something we will address at the next call once we have more visibility.',
        'I will take that offline and come back to you with the details.',
      ]));
    } else {
      push(responder.name, responder.role, 'qna', fill(pick(TOPICS[topic].mgmt)));
      if (chance(0.4)) push(responder.name, responder.role, 'qna', fill(pick(NEUTRAL_MGMT)));
    }
    if (chance(0.3)) push(analyst.name, `Analyst, ${analyst.firm}`, 'qna', pick(NEUTRAL_ANALYST));
  }

  push(ir.name, ir.role, 'qna', 'That was the last question. Thank you all for joining, and please reach out to investor relations for any follow-ups.');
  return segments;
}

// ---------------------------------------------------------------------------------------
// Call builder
// ---------------------------------------------------------------------------------------
function buildCall({ entry, ticker, sector, quarter, date, status, management, analysts, topicWeights, priorGuidance }) {
  const segments = buildTranscript(management, analysts, topicWeights);
  const durationMin = Math.max(32, Math.round(segments.at(-1).t / 60) + randInt(2, 7));

  const toneScore = round(rand(-0.65, 0.85), 2);
  const toneLabel = toneScore > 0.25 ? 'Confident' : toneScore < -0.2 ? 'Cautious' : 'Measured';
  const drivers = toneScore > 0.25 ? sample(TONE_DRIVERS_POS, randInt(2, 3))
    : toneScore < -0.2 ? sample(TONE_DRIVERS_NEG, randInt(2, 3))
      : sample(TONE_DRIVERS_NEU, 2);

  // Guidance: reuse the prior call's metrics where they exist so direction is a real comparison.
  const metrics = priorGuidance?.length
    ? priorGuidance.map((g) => GUIDANCE_METRICS.find((m) => m.metric === g.metric)).filter(Boolean)
    : sample(GUIDANCE_METRICS, randInt(2, 4));
  const guidance = metrics.map((m, i) => {
    const prior = priorGuidance?.[i]?.guided ?? null;
    const priorNum = prior == null ? round(rand(m.lo, m.hi), 1) : Number(String(prior).replace(/[^\d.]/g, ''));
    const move = chance(0.3) ? rand(0.04, 0.16) : chance(0.5) ? -rand(0.04, 0.16) : 0;
    const nowNum = round(Math.max(m.lo * 0.6, priorNum * (1 + move)), 1);
    const direction = nowNum > priorNum ? 'raised' : nowNum < priorNum ? 'cut' : 'maintained';
    const fmt = (v) => (m.unit === '₹ Cr' ? `₹${Math.round(v)} Cr` : m.unit === 'x' ? `${v}x` : `${v}%`);
    return {
      metric: m.metric,
      guided: fmt(nowNum),
      priorGuided: priorGuidance ? fmt(priorNum) : null,
      direction: priorGuidance ? direction : 'maintained',
      quote: fill(pick([
        `We are guiding to ${fmt(nowNum)} for the full year and see no reason to move off that today.`,
        `Taking everything together, ${fmt(nowNum)} is where we expect to land on this metric.`,
        `We have revisited our assumptions and are now comfortable with ${fmt(nowNum)}.`,
      ])),
    };
  });

  const promises = priorGuidance
    ? sample(PROMISE_POOL, randInt(2, 4)).map((p) => {
      const status_ = pick(['delivered', 'delivered', 'in-progress', 'in-progress', 'missed']);
      return {
        text: fill(p),
        madeInQuarter: PREV_QUARTER,
        status: status_,
        evidence: status_ === 'delivered'
          ? fill(pick(['Commissioned during the quarter, as committed on the previous call.', 'Completed ahead of the timeline indicated last quarter.']))
          : status_ === 'in-progress'
            ? fill(pick(['Work is underway; management reiterated the original timeline on this call.', 'Partially complete — management now expects closure by {mth}.']))
            : fill(pick(['Slipped: management cited {mth} approvals as the reason for the delay.', 'Not achieved this quarter; no revised date was given.'])),
      };
    })
    : [];

  const quotes = sample(segments.filter((s) => s.role !== 'Analyst' && !s.speaker.includes('Analyst') && s.text.length > 90), Math.min(3, 3))
    .map((s) => ({
      speaker: `${s.speaker}, ${s.role}`,
      text: s.text,
      why: pick(['Sets the tone for the full-year outlook.', 'The most specific number management gave on the call.',
        'Directly answers the question the street has been asking.', 'A commitment that can be checked next quarter.']),
    }));

  return {
    ticker,
    name: entry.Company,
    sector,
    callId: `${ticker}-${quarter}`,
    quarter,
    date,
    durationMin,
    status,
    participants: {
      management: management.map(({ name, role }) => ({ name, role })),
      analysts: analysts.map(({ name, firm }) => ({ name, firm })),
    },
    transcript: segments,
    summary: fill(pick([
      `Management held the full-year outlook and spent most of the call on execution — the capacity ramp, the order book and the cost programme. Q&A was dominated by margin questions.`,
      `A steady call. The topline commentary was unchanged, but management was noticeably more specific on capital expenditure and deleveraging than in the previous quarter.`,
      `Management sounded more constructive on demand than last quarter, while staying deliberately non-committal on the margin trajectory until the new capacity stabilises.`,
      `The call was defensive in tone. Several analyst questions on pricing and the second-half ramp were deferred, and guidance was left unchanged rather than reaffirmed with conviction.`,
    ])),
    themes: sample(THEME_POOL, randInt(3, 5)),
    tone: { score: toneScore, label: toneLabel, drivers },
    guidance,
    promises,
    risks: sample(RISK_POOL, randInt(2, 4)),
    quotes,
  };
}

// ---------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------
const universe = JSON.parse(readFileSync(UNIVERSE_PATH, 'utf8'));
const eligible = universe.filter((e) => tickerFromUrl(e['Screener URL']) && e.Company);

// The portfolio's holdings go in FIRST. A stride sample over 535 names almost never lands on
// the twelve a user actually owns, which left the Portfolio scope showing an empty matrix —
// the one view where "what did MY companies say" is the whole question.
const holdings = JSON.parse(readFileSync(PORTFOLIO_PATH, 'utf8'))?.holdings || [];
const heldTickers = new Set(holdings.map((h) => String(h.ticker).toUpperCase()));
const chosen = eligible.filter((e) => heldTickers.has(tickerFromUrl(e['Screener URL'])));

// Then stride-sample the rest, so the set still spans the whole market-cap range.
const rest = eligible.filter((e) => !heldTickers.has(tickerFromUrl(e['Screener URL'])));
const stride = Math.max(1, Math.floor(rest.length / Math.max(1, COMPANY_COUNT - chosen.length)));
for (let i = 0; chosen.length < COMPANY_COUNT && i < rest.length; i += stride) chosen.push(rest[i]);

// Which companies are live / scheduled. Live calls need a transcript in the file (the ticker
// reveals it progressively at runtime); scheduled ones have no transcript yet.
const liveIdx = new Set(sample([...chosen.keys()], LIVE_COUNT));
const remaining = [...chosen.keys()].filter((i) => !liveIdx.has(i));
const scheduledIdx = new Set(sample(remaining, SCHEDULED_COUNT));

// A few companies get ONE call only — newly covered names with no prior quarter on file. The
// Deep Dive's Comparison view has to say "nothing to compare against" rather than render a
// diff of zeroes, and that path only stays honest if the data actually exercises it.
const firstCallOnlyIdx = new Set(sample(remaining.filter((i) => !scheduledIdx.has(i)), FIRST_CALL_ONLY));

const calls = [];
chosen.forEach((entry, idx) => {
  const ticker = tickerFromUrl(entry['Screener URL']);
  const sector = entry.Sector || entry['Broad Sector'] || 'Services';

  const mgmtRoles = sample(MGMT_ROLES, randInt(3, 4));
  const analystFirms = sample(FIRMS, randInt(4, 7));
  const people = distinctNames(mgmtRoles.length + analystFirms.length);
  const management = mgmtRoles.map((role, i) => ({ name: people[i], role }));
  const analysts = analystFirms.map((firm, i) => ({ name: people[mgmtRoles.length + i], firm }));

  // Two different topic-weight profiles so the deltas between calls mean something.
  const prevWeights = {};
  const nowWeights = {};
  for (const id of TOPIC_IDS) {
    prevWeights[id] = rand(0.4, 3);
    nowWeights[id] = Math.max(0.2, prevWeights[id] * rand(0.35, 2.4));
  }

  const prevDate = isoDate(addDays('2026-04-25', randInt(0, 28)));
  const prevCall = buildCall({
    entry, ticker, sector, quarter: PREV_QUARTER, date: prevDate, status: 'completed',
    management, analysts, topicWeights: prevWeights, priorGuidance: null,
  });

  let status = 'completed';
  let date = isoDate(addDays('2026-07-14', randInt(0, 26)));
  if (liveIdx.has(idx)) {
    status = 'live';
    date = TODAY;
  } else if (scheduledIdx.has(idx)) {
    status = 'scheduled';
    date = isoDate(addDays(TODAY, randInt(1, 7)));
  }

  const firstOnly = firstCallOnlyIdx.has(idx);
  const latestCall = buildCall({
    entry, ticker, sector, quarter: LATEST_QUARTER, date, status,
    management, analysts, topicWeights: nowWeights,
    // No prior call on file means no prior guidance to compare against and no promises to
    // track — carrying them over would reference a call the data set does not contain.
    priorGuidance: firstOnly ? null : prevCall.guidance,
  });

  if (status === 'scheduled') {
    // A call that has not happened yet has no transcript and no analysis. Saying "0 mentions"
    // for a call nobody has given would be a fabricated reading, so these fields go empty and
    // the UI shows the row as upcoming rather than as a zero-hit company.
    latestCall.transcript = [];
    latestCall.summary = null;
    latestCall.themes = [];
    latestCall.tone = null;
    latestCall.guidance = [];
    latestCall.promises = [];
    latestCall.risks = [];
    latestCall.quotes = [];
    latestCall.durationMin = null;
    latestCall.participants = { management: [], analysts: [] };
  }
  if (status === 'live') {
    // How far into the call we are at the moment the page loads. The ticker counts up from
    // here in session time — see js/tabs/concall.js. Storing a wall-clock start instead would
    // read "started 340 days ago" the moment this file ages.
    latestCall.initialElapsedSec = randInt(9 * 60, 34 * 60);
  }

  if (firstCallOnlyIdx.has(idx)) calls.push(latestCall);
  else calls.push(prevCall, latestCall);
});

// ---- catalysts -----------------------------------------------------------------------
const catalysts = [];
const catalystHosts = sample(chosen, 44);
for (const entry of catalystHosts) {
  const ticker = tickerFromUrl(entry['Screener URL']);
  const n = randInt(2, 3);
  const seenText = new Set();
  for (let i = 0; i < n; i++) {
    const type = pick(CATALYST_TYPES);
    const fromConcall = chance(0.65);
    const status = pick(['upcoming', 'upcoming', 'in-progress', 'in-progress', 'delivered']);
    const catalystText = fill(pick(CATALYST_TEXT[type]));
    if (seenText.has(catalystText)) continue; // no company lists the same catalyst twice
    seenText.add(catalystText);
    catalysts.push({
      ticker,
      name: entry.Company,
      sector: entry.Sector || entry['Broad Sector'] || 'Services',
      catalyst: catalystText,
      type,
      source: fromConcall
        ? { kind: 'concall', ref: `${ticker}-${LATEST_QUARTER}`, date: isoDate(addDays('2026-07-14', randInt(0, 26))) }
        : { kind: 'annual-report', ref: 'Annual Report FY26', date: isoDate(addDays('2026-06-05', randInt(0, 40))) },
      expectedBy: isoDate(addDays(TODAY, randInt(20, 400))),
      status,
      confidence: pick(['high', 'medium', 'medium', 'low']),
      quote: fill(pick([
        'We expect this to be commissioned before the end of the financial year.',
        'The board has approved it and execution has already started.',
        'This is in our plan, though we are not putting a date on it yet.',
        'Management reiterated the timeline in response to an analyst question.',
      ])),
    });
  }
}

// ---- write ------------------------------------------------------------------------------
const PROVENANCE_CALLS =
  'ILLUSTRATIVE DATA. Company names, tickers and sectors are real (from public/data/universe.json). ' +
  'Every transcript line, guidance figure and tone reading is synthetic, generated by scripts/gen-mock-concalls.mjs. ' +
  'All individuals and all brokerage firms named here are FICTIONAL — no real person said any of this.';

const stamp = {
  generated_at: new Date('2026-08-10T09:30:00Z').toISOString(),
  generator: 'scripts/gen-mock-concalls.mjs',
  seed: SEED,
  source: 'Mock data',
};

// The calls file is written COMPACT, unlike the two small ones. Pretty-printed it runs past
// 2.5MB of mostly-whitespace, and nobody reviews ten thousand transcript lines by eye anyway —
// the review path for a seeded artefact is to rerun the generator and confirm the bytes match.
writeFileSync(CALLS_PATH, `${JSON.stringify({
  _provenance: PROVENANCE_CALLS,
  ...stamp,
  quarter: LATEST_QUARTER,
  previous_quarter: PREV_QUARTER,
  as_of: TODAY,
  company_count: chosen.length,
  call_count: calls.length,
  calls,
})}\n`);

writeFileSync(KEYWORDS_PATH, `${JSON.stringify({
  _provenance: 'The default keyword set. Terms are matched against transcript text at runtime by js/concall/keyword-engine.js — no count is stored here. Users may edit this set in the UI; edits live in localStorage.',
  ...stamp,
  source: 'Default configuration',
  keyword_count: DEFAULT_KEYWORDS.length,
  keywords: DEFAULT_KEYWORDS,
}, null, 1)}\n`);

writeFileSync(CATALYSTS_PATH, `${JSON.stringify({
  _provenance:
    'ILLUSTRATIVE DATA. Company names, tickers and sectors are real; every catalyst, date and quote is synthetic, generated by scripts/gen-mock-concalls.mjs.',
  ...stamp,
  as_of: TODAY,
  catalyst_count: catalysts.length,
  catalysts,
}, null, 1)}\n`);

// ---- report ------------------------------------------------------------------------------
const segTotal = calls.reduce((s, c) => s + c.transcript.length, 0);
const withTranscript = calls.filter((c) => c.transcript.length).length;
console.log(`companies:            ${chosen.length}`);
console.log(`calls:                ${calls.length} (${withTranscript} with a transcript)`);
console.log(`transcript segments:  ${segTotal} (avg ${Math.round(segTotal / withTranscript)}/call)`);
console.log(`live / scheduled:     ${calls.filter((c) => c.status === 'live').length} / ${calls.filter((c) => c.status === 'scheduled').length}`);
console.log(`single-call cos:      ${firstCallOnlyIdx.size} (Comparison must degrade for these)`);
console.log(`catalysts:            ${catalysts.length}`);
console.log(`keywords:             ${DEFAULT_KEYWORDS.length}`);
console.log(`\nwrote ${CALLS_PATH}`);
console.log(`wrote ${KEYWORDS_PATH}`);
console.log(`wrote ${CATALYSTS_PATH}`);

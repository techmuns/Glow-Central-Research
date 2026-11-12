// GLOW-OWNED. Private Market deal sourcing: one record per funding round or M&A deal, consolidated
// across every publisher that reported it. Pure and dependency-free, so the runner
// (scripts/collect-private-deals.mjs), the browser (js/tabs/private-market-news.js) and the offline
// test (scripts/verify-private-deals.mjs) share one definition of a source, a deal and a duplicate.
//
// THREE RULES, each one this dashboard already runs on:
//  1. A deal is read from the publisher's OWN headline and standfirst. Nothing is guessed: a field
//     the text does not state stays blank, and a headline that does not plainly say who raised or
//     who bought is not a deal (it stays a news story elsewhere).
//  2. One deal is one row, whoever reported it. Every report is kept as a source on that row, with
//     its own link, so nothing is dropped — only folded.
//  3. Where reports disagree about the same deal, the field is taken from the MORE CREDIBLE source
//     (the ranking below), and the disagreement is kept and shown, never silently overwritten.

// Higher is more credible. Inc42's weekly Funding Galore table is a curated, structured record of
// each round, so it leads; deal-tracking desks and financial dailies follow; general news after.
// A publisher not named here (seen through Google News) gets UNKNOWN_CREDIBILITY.
export const SOURCE_CREDIBILITY = [
  { id: 'inc42-table', publisher: 'Inc42 Funding Galore', score: 95, match: /^inc42 funding galore$/i },
  { id: 'entrackr', publisher: 'Entrackr', score: 90, match: /^entrackr\b/i },
  { id: 'vccircle', publisher: 'VCCircle', score: 89, match: /^vccircle\b/i },
  { id: 'economic-times', publisher: 'Economic Times', score: 88, match: /^(the )?economic times\b|^et (tech|entrepreneur|now|infra|retail|bfsi|health|auto|enterprise)|^etnow|^economictimes/i },
  { id: 'mint', publisher: 'Mint', score: 86, match: /^(mint|livemint)\b/i },
  { id: 'inc42', publisher: 'Inc42', score: 85, match: /^inc42\b/i },
  { id: 'moneycontrol', publisher: 'Moneycontrol', score: 85, match: /^moneycontrol\b/i },
  { id: 'business-standard', publisher: 'Business Standard', score: 85, match: /^business standard\b/i },
  { id: 'businessline', publisher: 'The Hindu BusinessLine', score: 82, match: /businessline|business line/i },
  { id: 'yourstory', publisher: 'YourStory', score: 80, match: /^yourstory\b/i },
  { id: 'techcrunch', publisher: 'TechCrunch', score: 80, match: /^techcrunch\b/i },
  { id: 'financial-express', publisher: 'Financial Express', score: 80, match: /^(the )?financial express\b/i },
  { id: 'techinasia', publisher: 'Tech in Asia', score: 78, match: /^tech in asia\b/i },
  { id: 'reuters', publisher: 'Reuters', score: 88, match: /^reuters\b/i },
  { id: 'bloomberg', publisher: 'Bloomberg', score: 88, match: /^bloomberg\b/i },
  { id: 'hindustan-times', publisher: 'Hindustan Times', score: 75, match: /^(the )?hindustan times\b|^ht tech/i },
  { id: 'times-of-india', publisher: 'Times of India', score: 72, match: /^(the )?times of india\b|^toi\b/i },
  { id: 'the-hindu', publisher: 'The Hindu', score: 75, match: /^the hindu$/i },
  { id: 'indian-express', publisher: 'Indian Express', score: 74, match: /^(the )?indian express\b/i },
  { id: 'medianama', publisher: 'MediaNama', score: 74, match: /^medianama\b/i },
  { id: 'bw-disrupt', publisher: 'BW Disrupt', score: 65, match: /^bw /i },
  { id: 'indian-startup-news', publisher: 'Indian Startup News', score: 60, match: /^indian startup news\b/i },
];
export const UNKNOWN_CREDIBILITY = 50;
export function credibilityOf(publisher) {
  const text = String(publisher || '').trim();
  const hit = SOURCE_CREDIBILITY.find(s => s.match.test(text));
  return hit ? { id: hit.id, publisher: hit.publisher, score: hit.score } : { id: 'other', publisher: text || 'Unknown publisher', score: UNKNOWN_CREDIBILITY };
}

// Publishers that write about Indian startups only, so a report from them needs no "India" word in
// the headline. Everyone else must place the deal in India in the text itself.
export const INDIA_NATIVE = new Set(['inc42-table', 'inc42', 'entrackr', 'yourstory', 'vccircle', 'indian-startup-news']);
// Startup desks seen through Google News that cover Indian startups only.
export const INDIA_NATIVE_PUBLISHER = /^(?:indian startup news|d2c insider|sahyadri startups|bw disrupt|vccircle|entrackr|inc42|yourstory)/i;

// The feeds the runner reads. `india` = an India-native desk (see above). Google News searches bring
// in publishers without a usable feed of their own — HT, TOI, Moneycontrol, VCCircle — and each of
// their items names its own publisher, which is what its credibility is read from.
const g = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
export const DEAL_FEEDS = [
  { id: 'inc42', publisher: 'Inc42', india: true, url: 'https://inc42.com/feed/' },
  { id: 'entrackr', publisher: 'Entrackr', india: true, url: 'https://entrackr.com/rss' },
  { id: 'yourstory', publisher: 'YourStory', india: true, url: 'https://yourstory.com/feed' },
  { id: 'et-funding', publisher: 'Economic Times', india: true, url: 'https://economictimes.indiatimes.com/tech/funding/rssfeeds/78570540.cms' },
  { id: 'et-startups', publisher: 'Economic Times', india: true, url: 'https://economictimes.indiatimes.com/tech/startups/rssfeeds/78570550.cms' },
  { id: 'hindustan-times', publisher: 'Hindustan Times', url: 'https://www.hindustantimes.com/feeds/rss/business/rssfeed.xml' },
  { id: 'times-of-india', publisher: 'Times of India', url: 'https://timesofindia.indiatimes.com/rssfeeds/1898055.cms' },
  { id: 'mint', publisher: 'Mint', url: 'https://www.livemint.com/rss/companies' },
  { id: 'business-standard', publisher: 'Business Standard', url: 'https://www.business-standard.com/rss/companies-101.rss' },
  { id: 'businessline', publisher: 'The Hindu BusinessLine', url: 'https://www.thehindubusinessline.com/companies/feeder/default.rss' },
  { id: 'techcrunch', publisher: 'TechCrunch', url: 'https://techcrunch.com/tag/india/feed/' },
  { id: 'techinasia', publisher: 'Tech in Asia', url: 'https://www.techinasia.com/feed' },
  { id: 'google-funding', publisher: 'Google News', google: true, url: g('Indian startup raises funding when:7d') },
  { id: 'google-series', publisher: 'Google News', google: true, url: g('startup raises Series India when:7d') },
  { id: 'google-seed', publisher: 'Google News', google: true, url: g('seed funding startup India when:7d') },
  { id: 'google-acquires', publisher: 'Google News', google: true, url: g('acquires startup India when:7d') },
  { id: 'google-acquisition', publisher: 'Google News', google: true, url: g('acquisition Indian startup when:7d') },
  { id: 'google-merger', publisher: 'Google News', google: true, url: g('merger startup India when:14d') },
  { id: 'google-ht', publisher: 'Google News', google: true, url: g('site:hindustantimes.com startup raises when:14d') },
  { id: 'google-toi', publisher: 'Google News', google: true, url: g('site:timesofindia.indiatimes.com startup raises when:14d') },
  { id: 'google-moneycontrol', publisher: 'Google News', google: true, india: true, url: g('site:moneycontrol.com startup raises when:7d') },
  { id: 'google-vccircle', publisher: 'Google News', google: true, india: true, url: g('site:vccircle.com raises when:7d') },
  { id: 'google-yourstory', publisher: 'Google News', google: true, india: true, url: g('site:yourstory.com raises when:7d') },
];

// ---------------------------------------------------------------------------------------------
// Reading a deal out of a headline
// ---------------------------------------------------------------------------------------------
const INDIA = /\b(india|indian|bengaluru|bangalore|mumbai|delhi|new delhi|gurugram|gurgaon|noida|hyderabad|chennai|pune|kolkata|ahmedabad|jaipur|kochi|indore|chandigarh|lucknow|surat|coimbatore)\b|₹|\brs\.?\s?\d|\binr\b|\bcrores?\b|\bcr\b|\blakh\b/i;
const FOREIGN = /\b(israeli|german|american|british|chinese|japanese|korean|singaporean|czech|french|swedish|dutch|australian|canadian|indonesian|vietnamese|philippine|filipino|thai|malaysian|european|swiss|saudi|emirati|nigerian|kenyan|brazilian|spanish|italian|irish|danish|finnish|norwegian|polish|estonian|turkish|egyptian|pakistani|bangladeshi|(?:us|uk|usa|u\.s\.|uae|dubai|singapore|london|berlin|paris|silicon valley|san francisco|new york|california|texas|china|japan|europe)-based)\b/i;
const ROUND = /\b(?:extended\s+|extension of\s+)?(pre[-\s]?series\s+[a-h]\b|series\s+[a-h](?:\d)?\b|pre[-\s]?seed|seed|angel|bridge|pre[-\s]?ipo|venture debt|credit facility|debt(?=\s+(?:round|funding|financing))|(?:growth|secondary|strategic)(?=\s+(?:round|funding|investment|financing)))(?:\s+(?:funding\s+)?(?:round|funding|financing|extension|investment))?/i;
const MONEY = /(?:(us\$|\$|usd|₹|rs\.?|inr|€|eur|£|gbp)\s?(\d[\d,]*(?:\.\d+)?)\s*(million|mn|m|billion|bn|b|crores?|cr|lakhs?|k)?\b|(\d[\d,]*(?:\.\d+)?)\s*(million|mn|billion|bn|crores?|cr|lakhs?)\s*(dollars?|rupees?)?)/i;

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const TITLE_PREFIX = /^(?:\[[^\]]{1,24}\]|\{[^}]{1,24}\}|(?:exclusive|breaking|update|funding alert|funding|deal|m&a|just in|scoop|report)\s*[:|–—-])\s*/i;

// Words that describe what a company IS, sitting before its name ("Wealthtech firm PowerUp Money",
// "Story TV parent Eloelo", "YC-backed healthtech startup BioStack"). The name is what follows the last one.
const DESCRIPTOR = /\b(?:startup|start-up|firm|platform|company|brand|maker|parent|player|provider|unicorn|marketplace|app|lender|label|chain|operator|developer|manufacturer|venture|business|outfit|major|aggregator|retailer|service|services|solutions? provider|network|label|house|studio|school|nbfc|fintech|edtech|healthtech|agritech|insurtech|proptech|spacetech|deeptech|cleantech|foodtech|traveltech|legaltech|wealthtech|ed-tech|e-commerce|d2c|saas|co|founder['’]s|'s|’s)\s+/gi;

export function companyName(raw) {
  let text = clean(raw).replace(TITLE_PREFIX, '').replace(TITLE_PREFIX, '');
  let last = -1, m;
  DESCRIPTOR.lastIndex = 0;
  while ((m = DESCRIPTOR.exec(text))) last = m.index + m[0].length;
  if (last > 0 && last < text.length) text = text.slice(last);
  text = text.replace(/^(?:the\s+)?(?:indian\s+)?/i, m => (/^the\s+$/i.test(m) ? m : '')).replace(/^[-–—:,\s]+|[-–—:,\s]+$/g, '');
  text = text.replace(/\s*\((?:[^)]*)\)\s*$/, '').replace(/^[A-Z][\w.]*(?:\s[A-Z][\w.]*)?-based\s+/, '').trim();
  return text;
}
// A party that is not the subject (an acquirer or investor): only the dressing is removed, never its descriptor.
export function partyName(raw) {
  return clean(raw).replace(TITLE_PREFIX, '').replace(TITLE_PREFIX, '')
    .replace(/\s+(?:is\s+)?(?:in (?:early |advanced |final )?talks|set|plans|likely|said|reportedly|has|have)$/i, '')
    .replace(/^[-–—:,\s]+|[-–—:,\s]+$/g, '').trim();
}
const PLACE = /^(?:india|indian market|andhra pradesh|ap|up|uttar pradesh|tamil nadu|tn|karnataka|maharashtra|gujarat|telangana|kerala|odisha|rajasthan|punjab|haryana|bihar|west bengal|assam|madhya pradesh|mp|goa|delhi|mumbai|bengaluru|hyderabad|chennai|pune)\b/i;
function plausibleCompany(name) {
  if (!name || name.length < 2 || name.length > 48) return false;
  if (PLACE.test(name) || /\b(has|have|had|is|was|were|will|would|are|its|their|projects?|plants?|facility|facilities|capex|units?)\b/i.test(name)) return false;
  const words = name.split(/\s+/);
  if (words.length > 6) return false;
  if (!/[A-Za-z0-9]/.test(name[0])) return false;
  if (/^(it|this|these|indian|india|startups?|companies|firms|investors?|funding|govt|government|centre|state|we|how|why|what|who|when|top|sebi|rbi|report|tech|ai|d2c|edtech|fintech)$/i.test(name)) return false;
  if (/\b(startups|companies|firms|brands|players|ventures? capital funds?)\b/i.test(name) && words.length > 1 && !/^[A-Z]/.test(words.at(-1))) return false;
  // A company name starts with a capital, a digit, or is a known lower-case brand style (altM, iD Fresh).
  if (!/^[A-Z0-9]/.test(name) && !/^[a-z]+[A-Z]/.test(name)) return false;
  if (/\b(?:crore|million|billion|stake|funding|round)\b/i.test(name)) return false;
  return true;
}

const RANGE = /(us\$|\$|usd|₹|rs\.?|inr|€|eur)?\s?(\d[\d,]*(?:\.\d+)?)\s*(?:-|–|—|to)\s*(?:us\$|\$|₹|rs\.?)?\s?(\d[\d,]*(?:\.\d+)?)\s*(million|mn|m|billion|bn|crores?|cr|lakhs?)\b/i;
export function parseAmount(text) {
  const r = RANGE.exec(String(text || ''));
  if (r && (r[1] || /crore|cr|lakh/i.test(r[4]))) {
    const lo = parseAmount(`${r[1] || ''}${r[2]} ${r[4]}`), hi = parseAmount(`${r[1] || ''}${r[3]} ${r[4]}`);
    if (lo && hi && lo.currency === hi.currency && hi.value > lo.value) {
      const v = Math.round((lo.value + hi.value) / 2 * 100) / 100;
      const sym = { USD: '$', INR: '₹', EUR: '€', GBP: '£' }[lo.currency], unit = lo.currency === 'INR' ? 'Cr' : 'Mn';
      const fmt = n => n.toLocaleString(lo.currency === 'INR' ? 'en-IN' : 'en-US');
      return { currency: lo.currency, value: v, display: `${sym}${fmt(lo.value)}–${fmt(hi.value)} ${unit}`, range: true };
    }
  }
  const m = MONEY.exec(String(text || ''));
  if (!m) return null;
  let symbol = (m[1] || '').toLowerCase(), value = Number(String(m[2] || m[4]).replace(/,/g, '')), unit = (m[3] || m[5] || '').toLowerCase();
  const word = (m[6] || '').toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return null;
  let currency = /\$|usd/.test(symbol) || /dollar/.test(word) ? 'USD' : /₹|rs|inr/.test(symbol) || /rupee/.test(word) ? 'INR' : /€|eur/.test(symbol) ? 'EUR' : /£|gbp/.test(symbol) ? 'GBP' : null;
  if (!currency) currency = /crore|cr|lakh/.test(unit) ? 'INR' : null;
  if (!currency) return null;
  if (!unit && currency === 'INR' && value < 1e5) return null;
  // One unit per currency, so two reports of one deal compare directly: Mn for foreign currencies,
  // Cr for rupees. No exchange rate is applied anywhere — a $ and a ₹ figure are never compared.
  let normal;
  if (currency === 'INR') {
    normal = /crore|^cr$/.test(unit) ? value : /lakh/.test(unit) ? value / 100 : /billion|bn|^b$/.test(unit) ? value * 100 : /million|mn|^m$/.test(unit) ? value / 10 : /^k$/.test(unit) ? value / 1e4 : value / 1e7;
  } else {
    normal = /billion|bn|^b$/.test(unit) ? value * 1000 : /million|mn|^m$/.test(unit) ? value : /^k$/.test(unit) ? value / 1000 : /crore|cr/.test(unit) ? null : value / 1e6;
  }
  if (!Number.isFinite(normal) || normal <= 0) return null;
  const sym = { USD: '$', INR: '₹', EUR: '€', GBP: '£' }[currency];
  const n = Math.round(normal * 100) / 100;
  return { currency, value: n, display: currency === 'INR' ? `${sym}${n.toLocaleString('en-IN')} Cr` : `${sym}${n.toLocaleString('en-US')} Mn` };
}

export function roundOf(text) {
  const m = ROUND.exec(String(text || ''));
  if (!m) return '';
  const r = m[1].toLowerCase().replace(/\s+/g, ' ');
  if (/^pre[- ]?series ([a-h])/.test(r)) return `Pre-Series ${r.match(/series ([a-h])/)[1].toUpperCase()}`;
  if (/^series ([a-h])/.test(r)) return `Series ${r.match(/^series ([a-h])/)[1].toUpperCase()}`;
  if (/^pre[- ]?seed/.test(r)) return 'Pre-Seed';
  if (/^pre[- ]?ipo/.test(r)) return 'Pre-IPO';
  if (/venture debt|credit facility|^debt/.test(r)) return 'Debt';
  return r[0].toUpperCase() + r.slice(1);
}

// Investor names after "led by" / "from" / "backed by", up to where the sentence moves on.
function investorsIn(text) {
  const out = { investors: '', leadInvestor: '' };
  // Only the clause about this round: "…led by Amazon funds, secures Rs 100 Cr loan from TDB" ends at the comma.
  text = String(text || '').split(/,\s+(?=[a-z])|;/)[0];
  const tail = s => clean(s.split(/\s+(?:to|for|as|amid|at|in a|in its|in an|after|with|which|that|while|on|valuing|valuation)\s+|[;:|]|\s[-–—]\s|\.\s/i)[0].split(/,\s+(?=[a-z])/)[0])
    .replace(/,?\s*(?:and\s+)?others?$/i, '').replace(/,?\s*(?:among|and) others$/i, '').replace(/[,.\s]+$/, '');
  const led = /\b(?:led|co-led) by\s+([^]+)/i.exec(text);
  if (led) { out.leadInvestor = tail(led[1]); out.investors = out.leadInvestor; }
  const from = /\b(?:from|backed by|with participation from|participation of)\s+([^]+)/i.exec(text);
  if (from) {
    const names = tail(from[1]);
    if (names && !/^(existing|its|investors|the|a|an|new|several|multiple|global|marquee)\b/i.test(names) && /^[A-Z0-9]/.test(names)) {
      out.investors = out.investors && !names.includes(out.investors) ? `${out.investors}, ${names}` : names;
    }
  }
  if (out.leadInvestor && !/^[A-Z0-9]|^[a-z]+\s+[A-Z]/.test(out.leadInvestor)) { out.leadInvestor = ''; if (!from) out.investors = ''; }
  return out;
}

const TALKS = /\b(in talks|to raise|looks to raise|looking to raise|plans to raise|eyes|set to raise|seeks|seeking|in early talks|in advanced talks|mulls|considering|could raise|may raise|likely to raise|to acquire|plans to acquire|in talks to acquire|to merge|set to acquire|nears deal)\b/i;
const FUNDING_VERB = /\s+(?:raises|raised|secures|secured|bags|bagged|nets|netted|garners|mops up|closes|closed|scoops up|lands|receives|gets|is looking to raise|looks to raise|looking to raise|plans to raise|set to raise|to raise|in talks to raise|in early talks to raise|in advanced talks to raise|eyes|seeks)\s+/i;
const ACQ_VERB = /\s+(?:acquires|acquired|has acquired|to acquire|set to acquire|in talks to acquire|buys|bought|to buy|snaps up|picks up|takes over|completes acquisition of|completes the acquisition of|announces acquisition of|announces the acquisition of)\s+/i;
const INVEST_VERB = /\s+(?:invests|invested|to invest|leads)\s+/i;
const MERGE = /^(.+?)\s+(?:to merge with|merges with|merged with|and (.+?) merge|amalgamates with)\s+(.+?)(?:$|[,;:]|\s+(?:to|in|for|amid|after)\s)/i;
const FUND_RAISE = /\b(first close|final close|maiden fund|fund (?:i|ii|iii|iv|v)\b|vc fund|venture fund|debt fund|corpus|aif\b(?! invests)|growth fund|fund of funds|close of (?:its|the)|crore fund|million fund)/i;
const NOT_A_DEAL = /\b(forecast|outlook|guidance|capex|takeover bid|funding winter|funding slump|funding (?:falls|drops|rises|hits|jumps|plunges|dips)|startups raised|raised over|this week|weekly|roundup|round-up|digest|wrap|explained|in charts|ipo|listing|prices|price band|bonds?|ncds?|qip|rights issue|ofs|block deal|shares worth|naming rights|order|orders|contract|land|plot|site|office space|tower|building|stadium|player|pick in|draft|club|tournament|govt|government|ministry|policy|state|rbi|sebi|cci approves|approval|approves)\b/i;

/** One deal read from a headline (and its standfirst), or null when the text does not state one. */
export function extractDeal(title, summary = '') {
  const head = clean(String(title || '').replace(TITLE_PREFIX, '').replace(TITLE_PREFIX, '')).replace(/\s+\|\s+[^|]{2,40}$/, '').replace(/\s+\|\s+[^|]{2,40}$/, '');
  if (!head || head.length > 220) return null;
  if (FUND_RAISE.test(head)) return null;
  const text = `${head} ${clean(summary).slice(0, 400)}`;
  const status = TALKS.test(head) ? 'talks' : 'announced';

  const merge = MERGE.exec(head);
  if (merge && !NOT_A_DEAL.test(head)) {
    const a = companyName(merge[1]), b = companyName(merge[3]);
    if (plausibleCompany(a) && plausibleCompany(b)) {
      return { kind: 'merger', status, company: b, subject: merge[3], acquirer: a, round: '', ...amountOf(head), investors: '', leadInvestor: '' };
    }
  }
  const acq = ACQ_VERB.exec(head);
  if (acq) {
    const before = head.slice(0, acq.index), after = head.slice(acq.index + acq[0].length);
    if (/\b(acquires|acquired|buys|bought|snaps up|picks up|takes over)\b/i.test(acq[0]) && /^(?:a\s+)?(?:majority|minority|controlling|significant|strategic|\d+(?:\.\d+)?%|nearly\s+\d+%|additional|further|more|an?\s+)?\s*stake/i.test(after) && /\bstake in\s+/i.test(after)) {
      // "X picks up stake in Y" is an INVESTMENT in Y unless a majority/controlling stake is named.
      const target = companyName(after.split(/\bstake in\s+/i)[1].split(/\s+(?:for|to|at|in a|amid|from|via|worth)\s+|[,;:|]|\s[-–—]\s/i)[0]);
      const majority = /\b(majority|controlling|100%|5[1-9]%|[6-9]\d%)\b/i.test(after);
      const investor = partyName(before);
      if (!plausibleCompany(target) || !plausibleCompany(investor) || NOT_A_DEAL.test(target)) return null;
      return majority
        ? { kind: 'acquisition', status, company: target, subject: after, acquirer: investor, round: '', ...amountOf(head), investors: '', leadInvestor: '' }
        : { kind: 'funding', status, company: target, subject: after, acquirer: '', round: roundOf(text) || 'Strategic', ...amountOf(head), investors: investor, leadInvestor: '' };
    }
    if (/\b(picks up)\b/i.test(acq[0])) return null;
    const target = companyName(after.split(/\s+(?:for|to|at|in a|amid|from|via|worth|in an?|valued|as|after|with)\s+|[,;:|]|\s[-–—]\s/i)[0]);
    const acquirer = partyName(before);
    if (!plausibleCompany(target) || !plausibleCompany(acquirer) || NOT_A_DEAL.test(head.replace(/\bstake\b/gi, ''))) return null;
    if (/\b(assets?|portfolio|business|division|unit|brand portfolio|plant|facility|loan|book)\b$/i.test(target)) return null;
    return { kind: 'acquisition', status, company: target, subject: after, acquirer, round: '', ...amountOf(head), investors: '', leadInvestor: '' };
  }
  const fund = FUNDING_VERB.exec(head);
  if (fund) {
    if (NOT_A_DEAL.test(head)) return null;
    const subject = head.slice(0, fund.index), company = companyName(subject);
    if (!plausibleCompany(company)) return null;
    const rest = head.slice(fund.index + fund[0].length);
    if (!MONEY.test(rest) && !ROUND.test(rest) && !/\b(funding|round|investment|capital)\b/i.test(rest)) return null;
    if (/\b(eyes|seeks|gets|receives|lands|closes|closed)\s+$/i.test(fund[0]) && !/\b(funding|round|raise|investment|from|led by|series|seed|investors?)\b/i.test(rest)) return null;
    if (/\bfunds?\b(?!ing)/i.test(rest.split(/\b(?:led by|from|backed by)\b/i)[0])) return null;
    return { kind: 'funding', status, company, subject, acquirer: '', round: roundOf(rest) || roundOf(clean(summary).slice(0, 300)), ...amountOf(rest), ...investorsIn(rest) };
  }
  const inv = INVEST_VERB.exec(head);
  if (inv && /\s+in\s+/i.test(head.slice(inv.index + inv[0].length)) && !NOT_A_DEAL.test(head)) {
    const after = head.slice(inv.index + inv[0].length);
    const target = companyName(after.split(/\s+in\s+/i).slice(1).join(' in ').split(/\s+(?:for|to|at|amid|via|as|after|with)\s+|[,;:|]|\s[-–—]\s/i)[0]);
    const investor = partyName(head.slice(0, inv.index));
    if (!plausibleCompany(target) || !plausibleCompany(investor) || /round$/i.test(target)) return null;
    const isRound = /\bround\b/i.test(after);
    return { kind: 'funding', status, company: target, subject: after, acquirer: '', round: roundOf(after), ...amountOf(after), investors: investor, leadInvestor: /\bleads\b/i.test(inv[0]) || isRound && /\bleads\b/i.test(head) ? investor : '' };
  }
  return null;
}
function amountOf(text) {
  // A valuation is not the round's size: "secures $1.35 billion valuation" states no amount raised.
  const a = parseAmount(String(text || '').replace(/(?:at\s+(?:an?\s+)?)?(?:us\$|\$|₹|rs\.?|€)?\s?\d[\d,.]*\s*(?:million|mn|billion|bn|crores?|cr)?\s+(?:post-money\s+|pre-money\s+)?valuation/gi, ' '));
  return a ? { amount: a.display, currency: a.currency, amountValue: a.value } : { amount: '', currency: '', amountValue: null };
}

/** Does this report place the deal in India? India-native desks are assumed to, unless they say otherwise. */
export function inIndia(title, summary, sourceId, deal = null) {
  const head = clean(title);
  // A foreign descriptor on the company itself ("Israeli AI security startup Bay") rules it out; one on
  // an investor ("from US-based Vector Line Capital") does not.
  const subject = clean(deal?.subject ?? head).split(/\s+(?:for|from|led by|to|at)\s+/i)[0];
  if (FOREIGN.test(subject) && !/\b(india|indian)\b/i.test(subject)) return false;
  if (deal?.indiaFeed || INDIA_NATIVE.has(sourceId) || INDIA_NATIVE_PUBLISHER.test(String(deal?.publisher || ''))) return true;
  return INDIA.test(`${head} ${clean(summary).slice(0, 400)}`);
}

// ---------------------------------------------------------------------------------------------
// One company, one key. Legal suffixes and punctuation are dropped; nothing fuzzy beyond that.
// ---------------------------------------------------------------------------------------------
const KEYS = new Map();
export function companyKey(name) {
  const raw = String(name || '');
  let key = KEYS.get(raw);
  if (key === undefined) { key = keyOf(raw); if (KEYS.size > 50000) KEYS.clear(); KEYS.set(raw, key); }
  return key;
}
function keyOf(name) {
  return String(name || '').normalize('NFKC').toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/\b(private|pvt|limited|ltd|llp|inc|corp|corporation|co|india|technologies|technology|tech|labs?|ventures?|solutions|services|platforms?|group|holdings)\b\.?/g, ' ')
    .replace(/\.(ai|io|com|in|co|app)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim() || String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// ---------------------------------------------------------------------------------------------
// Consolidation: many reports -> one deal
// ---------------------------------------------------------------------------------------------
// Round types as display groups (the funding-round-types reading, repeated here so this module stays
// importable by the runner without the browser's module graph).
export function roundGroup(value) {
  const text = String(value || '').toLowerCase().replace(/[‐‑‒–—−_-]+/g, ' ').replace(/\s*[*†‡]+\s*$/, '').trim();
  const s = text.match(/(pre\s*)?series\s+([a-h])\b/);
  if (s) return `${s[1] ? 'Pre-Series' : 'Series'} ${s[2].toUpperCase()}`;
  if (/pre\s*seed/.test(text)) return 'Pre-Seed';
  if (/\bseed\b/.test(text)) return 'Seed';
  if (/\bangel\b/.test(text)) return 'Angel';
  if (/pre\s*ipo/.test(text)) return 'Pre-IPO';
  if (/equity.*debt|debt.*equity/.test(text)) return 'Equity & Debt';
  if (/\b(debt|credit)\b/.test(text)) return 'Debt';
  if (/\bbridge\b/.test(text)) return 'Bridge';
  return '';
}
const DAY = 86400000;
const WINDOW_DAYS = 30;
const emptyish = v => !v || /^(?:[-–—_]|n\/?a|na|undisclosed|not disclosed|—)$/i.test(String(v).trim());
const dayMs = d => { const t = Date.parse(d || ''); return Number.isFinite(t) ? t : null; };

// "Cosmoserve" and "Cosmoserve Space" are one company; "Godrej Capital" and "Godrej Properties" are not.
// Names are compatible when their keys are equal, or one is the other plus trailing words.
export function sameCompany(a, b) {
  const ka = companyKey(a), kb = companyKey(b);
  if (ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (short.length < 5 || !long.startsWith(short)) return false;
  const wa = String(a).trim().split(/\s+/), wb = String(b).trim().split(/\s+/);
  const [sw, lw] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return sw.every((w, i) => companyKey(w) === companyKey(lw[i]) || !companyKey(w));
}
const bucketOf = name => companyKey(String(name || '').trim().split(/\s+/)[0]) || companyKey(name);

/** Two reports of one company: could they be the same deal? */
function sameDeal(a, b) {
  if (!sameCompany(a.company, b.company)) return false;
  if (a.kind !== b.kind) return a.kind !== 'funding' && b.kind !== 'funding'; // acquisition/merger reported either way
  if (a.url && a.url === b.url) return false; // one roundup listing a company twice is two rounds
  const ra = roundGroup(a.round), rb = roundGroup(b.round);
  if (ra && rb && ra !== rb) return false;
  if (a.currency && a.currency === b.currency && a.amountValue && b.amountValue) {
    const ratio = Math.max(a.amountValue, b.amountValue) / Math.min(a.amountValue, b.amountValue);
    if (ratio > 3) return false;
    // One outlet printing two different sizes for one company a few weeks apart is reporting two
    // tranches or rounds, not disagreeing with itself.
    if ((a.sourceId || a.publisher) === (b.sourceId || b.publisher) && ratio > 1.1) return false;
  }
  return true;
}

/**
 * Fold reports into deals. `observations` carry: id, kind, status, company, acquirer, date (YYYY-MM-DD),
 * amount, currency, amountValue, round, investors, leadInvestor, sector, subsector, businessModel,
 * publisher, credibility, url, title, publishedAt, firstSeenAt. Returns one deal per cluster with every
 * report kept under `sources` and every disagreement under `conflicts`.
 */
export function consolidateDeals(observations) {
  const groups = new Map();
  for (const o of observations) {
    const key = bucketOf(o.company);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  const deals = [];
  for (const list of groups.values()) {
    list.sort((a, b) => (a.date || '').localeCompare(b.date || '') || b.credibility - a.credibility);
    const clusters = [];
    for (const o of list) {
      const t = dayMs(o.date);
      let home = null;
      for (let i = clusters.length - 1; i >= 0; i--) {
        const c = clusters[i];
        if (t != null && c.last != null && t - c.last > WINDOW_DAYS * DAY) break;
        if (c.members.every(m => sameDeal(m, o))) { home = c; break; }
      }
      if (!home) { home = { members: [], last: t }; clusters.push(home); }
      home.members.push(o);
      if (t != null) home.last = Math.max(home.last ?? t, t);
    }
    for (const c of clusters) deals.push(resolveDeal(c.members));
  }
  return deals;
}

const FIELDS = ['date', 'amount', 'round', 'investors', 'leadInvestor', 'sector', 'subsector', 'businessModel', 'acquirer'];
function resolveDeal(members) {
  const ranked = [...members].sort((a, b) => b.credibility - a.credibility || (a.publishedAt || '').localeCompare(b.publishedAt || '') || a.id.localeCompare(b.id));
  const lead = ranked[0];
  const pick = field => ranked.find(m => !emptyish(m[field])) || null;
  const out = { ...lead };
  const chosenFrom = {};
  for (const field of FIELDS) {
    const from = pick(field);
    out[field] = from ? from[field] : (lead[field] || '');
    if (from) chosenFrom[field] = from;
  }
  // The amount travels with its own currency and value, from the same report.
  const amountFrom = ranked.find(m => m.amountValue) || null;
  if (amountFrom) { out.amount = amountFrom.amount; out.currency = amountFrom.currency; out.amountValue = amountFrom.amountValue; chosenFrom.amount = amountFrom; }
  out.kind = ranked.some(m => m.kind === 'acquisition') ? 'acquisition' : ranked.some(m => m.kind === 'merger') ? 'merger' : 'funding';
  out.status = members.some(m => m.status === 'announced') ? 'announced' : 'talks';
  out.company = lead.company;
  out.dateISO = /^\d{4}-\d{2}-\d{2}$/.test(out.date || '') ? out.date : (lead.dateISO || null);
  // Disagreements, kept and shown. Amounts only compare within one currency (no exchange rate).
  const conflicts = [];
  if (amountFrom) {
    const others = ranked.filter(m => m !== amountFrom && m.amountValue && m.currency === amountFrom.currency && Math.abs(m.amountValue - amountFrom.amountValue) / amountFrom.amountValue > 0.05);
    if (others.length) conflicts.push({ field: 'Round size', chosen: { value: amountFrom.amount, publisher: amountFrom.publisher }, others: others.map(m => ({ value: m.amount, publisher: m.publisher, url: m.url })) });
  }
  const roundFrom = chosenFrom.round;
  if (roundFrom) {
    const mine = roundGroup(roundFrom.round);
    const others = ranked.filter(m => m !== roundFrom && roundGroup(m.round) && mine && roundGroup(m.round) !== mine);
    if (others.length) conflicts.push({ field: 'Round type', chosen: { value: roundFrom.round, publisher: roundFrom.publisher }, others: others.map(m => ({ value: m.round, publisher: m.publisher, url: m.url })) });
  }
  out.conflicts = conflicts;
  // Every report is kept: one entry per distinct link, most credible first.
  const seen = new Set();
  // The same article reached twice (its own feed and a Google News link) is one source.
  out.sources = ranked.filter(m => { const keys = [m.url || m.id, `${m.publisher}\n${String(m.title || '').toLowerCase()}`]; if (keys.some(k => seen.has(k))) return false; keys.forEach(k => seen.add(k)); return true; })
    .map(m => ({ id: m.id, publisher: m.publisher, credibility: m.credibility, url: m.url, title: m.title || m.sourceTitle || '', publishedAt: m.publishedAt || null, origin: m.origin || 'news' }));
  out.memberIds = members.map(m => m.id);
  out.firstSeenAt = members.map(m => m.firstSeenAt).filter(Boolean).sort()[0] || lead.firstSeenAt || null;
  return out;
}

/** An Inc42 Funding Galore table row as one report, keeping every field the table printed. */
export function fromInc42Row(row) {
  const parsed = parseAmount(row.amount);
  const day = row.dateISO || (Number.isFinite(Date.parse(row.publishedAt || '')) ? new Date(Date.parse(row.publishedAt) + 19800000).toISOString().slice(0, 10) : null);
  return { ...row, kind: 'funding', status: 'announced', acquirer: '', date: day, dateISO: row.dateISO || day,
    currency: parsed?.currency || '', amountValue: parsed?.value ?? null,
    publisher: 'Inc42 Funding Galore', credibility: 95, sourceId: 'inc42-table', url: row.sourceUrl, title: row.sourceTitle || '', origin: 'inc42-table' };
}

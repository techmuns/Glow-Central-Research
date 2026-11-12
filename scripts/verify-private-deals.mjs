// Offline test for Private Market deal sourcing (GLOW-OWNED): headline reading, India and listed
// filters, cross-source folding, credibility-led field choice and shown disagreements, and the
// collector's merge-never-delete capture. No network.
import assert from 'node:assert/strict';
import { extractDeal, inIndia, parseAmount, credibilityOf, consolidateDeals, fromInc42Row, sameCompany, companyKey } from '../public/js/data/private-deals-shared.js';
import { collect, parseItems, observe, emptyCapture } from './collect-private-deals.mjs';

// --- Reading a headline ---------------------------------------------------------------------------
const d1 = extractDeal('Specialty chemicals startup altM raises $10.3 Mn led by Rainmatter, Mela Ventures');
assert.deepEqual([d1.kind, d1.status, d1.company, d1.amount, d1.leadInvestor, d1.investors], ['funding', 'announced', 'altM', '$10.3 Mn', 'Rainmatter, Mela Ventures', 'Rainmatter, Mela Ventures']);
const d2 = extractDeal('Exclusive: Olyv raises Rs 58 Cr in extended Series C round led by Nippon India Digital');
assert.deepEqual([d2.company, d2.amount, d2.round], ['Olyv', '₹58 Cr', 'Series C']);
assert.equal(extractDeal('Exclusive: Dhruva Space to raise $15.5 Mn in pre-Series B; revenue surges 8X').status, 'talks');
assert.equal(extractDeal('Exclusive: Dhruva Space to raise $15.5 Mn in pre-Series B').round, 'Pre-Series B');
const acq = extractDeal('MakeMyTrip acquires majority stake in Quick Ride');
assert.deepEqual([acq.kind, acq.company, acq.acquirer], ['acquisition', 'Quick Ride', 'MakeMyTrip']);
const acq2 = extractDeal('Prestige Estates acquires Noida-based Allure Developers for ₹523.76 crore');
assert.deepEqual([acq2.company, acq2.amount], ['Allure Developers', '₹523.76 Cr']);
const minority = extractDeal('Mahesh Babu picks up stake in gaming startup Shortgun Games');
assert.deepEqual([minority.kind, minority.company, minority.investors], ['funding', 'Shortgun Games', 'Mahesh Babu'], 'A stake without "majority" is an investment, not an acquisition');
const inv = extractDeal('The Wealth Company AIF invests Rs 400 crore in Boldfit');
assert.deepEqual([inv.company, inv.investors, inv.amount], ['Boldfit', 'The Wealth Company AIF', '₹400 Cr']);
assert.equal(extractDeal('Greenjoules raises Rs 150 Cr in Series B led by Amazon funds, secures Rs 100 Cr loan from TDB').investors, 'Amazon funds', 'Investors stop where the clause about the round ends');
assert.equal(extractDeal('General Atlantic, ChrysCapital in talks to invest Rs 300-400 crore in ice cream brand Hocco').amount, '₹300–400 Cr', 'A range is kept as a range');
assert.equal(extractDeal('German startup 1Komma5Grad secures $1.35 billion valuation in new financing round').amount, '', 'A valuation is not the round size');
for (const notDeal of ['Norwest closes $4 Bn global fund, takes AUM to $18 Bn', 'Canonicus Capital raises Rs 192 Cr in first close of Rs 500 Cr special situations fund',
  "Moody’s raises India’s FY27 growth forecast to 7% on strong economic momentum", 'Kia to invest $2 billion in AP to expand operations', 'ReNew to invest ₹29,500 cr in 2 new projects in Andhra Pradesh',
  'Gokaldas Exports eyes ₹450–500 crore capex by FY29 as demand outlook improves', 'Palo Alto CEO Nikesh Arora has secured $147 million through share-linked deal',
  'Funding and acquisitions in Indian startups this week [Nov 02- Nov 07]', 'HFCL bags export orders worth ₹834 crore for optical fibre cables', 'InMobi Secures Naming Rights For Bengaluru’s Ibbaluru Metro Station For ₹65 Cr'])
  assert.equal(extractDeal(notDeal), null, `Not a deal: ${notDeal}`);
assert.deepEqual(parseAmount('Rs 7.6 crore'), { currency: 'INR', value: 7.6, display: '₹7.6 Cr' });
assert.deepEqual(parseAmount('$6M'), { currency: 'USD', value: 6, display: '$6 Mn' });
assert.equal(parseAmount('$1.35 billion').value, 1350);

// --- India only, and the subject decides ---------------------------------------------------------
assert.equal(inIndia('Israeli AI security startup Bay raises $50 million', '', 'economic-times', extractDeal('Israeli AI security startup Bay raises $50 million')), false);
const tess = 'Tessolve raises $75 million from US-based Vector Line Capital';
assert.equal(inIndia(tess, 'Bengaluru-based Tessolve…', 'economic-times', extractDeal(tess)), true, 'A foreign investor does not make the company foreign');
assert.equal(inIndia('OpenAI acquires AI travel startup Odessia', '', 'other', extractDeal('OpenAI acquires AI travel startup Odessia')), false, 'A general outlet must place the deal in India');
assert.equal(inIndia('Hundo Pizza raises maiden institutional round led by Titan Capital', '', 'entrackr', extractDeal('Hundo Pizza raises maiden institutional round led by Titan Capital')), true);

// --- Credibility ----------------------------------------------------------------------------------
assert(credibilityOf('Inc42 Funding Galore').score > credibilityOf('Entrackr').score);
assert(credibilityOf('Entrackr').score > credibilityOf('Hindustan Times').score);
assert(credibilityOf('The Economic Times').score > credibilityOf('Times of India').score);
assert.equal(credibilityOf('Some Blog').score, 50);
assert(sameCompany('Cosmoserve', 'Cosmoserve Space') && !sameCompany('Godrej Capital', 'Godrej Properties') && !sameCompany('Fixture Company 3', 'Fixture Company 30'));
assert.equal(companyKey('NuSynth Technologies Pvt Ltd'), companyKey('NuSynth'));

// --- Folding --------------------------------------------------------------------------------------
const obs = (o) => ({ id: o.id.padEnd(24, '0'), kind: 'funding', status: 'announced', acquirer: '', round: '', amount: '', currency: '', amountValue: null, investors: '', leadInvestor: '', origin: 'news', ...o, credibility: credibilityOf(o.publisher).score, sourceId: credibilityOf(o.publisher).id });
const inc = fromInc42Row({ id: 'a'.repeat(24), company: 'Greenjoules', date: '11 Nov 2026', dateISO: '2026-11-11', sector: 'Clean Tech', subsector: 'Biofuel', businessModel: 'B2B', amount: '$17 Mn', round: 'Series B', investors: 'Amazon Climate Fund', leadInvestor: 'Amazon Climate Fund', sourceUrl: 'https://inc42.com/buzz/x/', sourceTitle: 'Funding this week', publishedAt: '2026-11-14T09:00:00+05:30' });
const deals = consolidateDeals([
  inc,
  obs({ id: 'b1', company: 'Greenjoules', round: 'Series B', amount: '₹150 Cr', currency: 'INR', amountValue: 150, publisher: 'Entrackr', url: 'https://entrackr.com/g', date: '2026-11-11' }),
  obs({ id: 'b2', company: 'Greenjoules', round: 'Series B', amount: '₹250 Cr', currency: 'INR', amountValue: 250, publisher: 'ESG News', url: 'https://esg.example/g', date: '2026-11-12' }),
  obs({ id: 'b3', company: 'Greenjoules', amount: '₹150 Cr', currency: 'INR', amountValue: 150, publisher: 'Business Standard', url: 'https://bs.example/g', date: '2026-11-11' }),
  obs({ id: 'c1', company: 'Cosmoserve Space', round: 'Seed', amount: '$6 Mn', currency: 'USD', amountValue: 6, publisher: 'Entrackr', url: 'https://entrackr.com/c', date: '2026-11-05' }),
  obs({ id: 'c2', company: 'Cosmoserve', round: 'Seed', amount: '$6 Mn', currency: 'USD', amountValue: 6, publisher: 'YourStory', url: 'https://yourstory.com/c', date: '2026-11-05' }),
  obs({ id: 'c3', company: 'Cosmoserve', round: 'Series A', amount: '$20 Mn', currency: 'USD', amountValue: 20, publisher: 'Entrackr', url: 'https://entrackr.com/c2', date: '2026-11-20' }),
  obs({ id: 'q1', kind: 'acquisition', company: 'Quick Ride', acquirer: 'MakeMyTrip', publisher: 'Bharat Fast', url: 'https://bf.example/q', date: '2026-11-06' }),
  obs({ id: 'q2', kind: 'acquisition', company: 'Quick Ride', acquirer: 'MakeMyTrip', publisher: 'Entrackr', url: 'https://entrackr.com/q', date: '2026-11-06' }),
  obs({ id: 'q3', kind: 'acquisition', company: 'Quick Ride', acquirer: 'MakeMyTrip', publisher: 'Entrackr', url: 'https://entrackr.com/q-old', date: '2025-01-06' }),
]);
const by = name => deals.filter(d => sameCompany(d.company, name));
const g = by('Greenjoules');
assert.equal(g.length, 1, 'Four reports of one round are one row');
assert.equal(g[0].id, inc.id, 'The most credible report leads the row and keeps its id');
assert.equal(g[0].amount, '$17 Mn', 'The Inc42 table supplies the shown size');
assert.equal(g[0].sources.length, 4, 'Every report is kept as a source');
assert.deepEqual(g[0].sources.map(s => s.publisher), ['Inc42 Funding Galore', 'Entrackr', 'Business Standard', 'ESG News']);
assert.equal(g[0].conflicts.length, 0, 'A dollar and a rupee figure are never compared');
const g2 = consolidateDeals([...[1, 2, 3].map(i => obs({ id: `b${i}`, company: 'Greenjoules', round: 'Series B', amount: i === 2 ? '₹250 Cr' : '₹150 Cr', currency: 'INR', amountValue: i === 2 ? 250 : 150, publisher: ['Entrackr', 'ESG News', 'Times of India'][i - 1], url: `https://x.example/${i}`, date: '2026-11-11' }))]);
assert.equal(g2.length, 1); assert.equal(g2[0].amount, '₹150 Cr', 'The more credible source wins a disagreement');
assert.deepEqual(g2[0].conflicts.map(c => [c.field, c.chosen.publisher, c.others.map(o => o.publisher)]), [['Round size', 'Entrackr', ['ESG News']]], 'The disagreement is kept and named');
assert.equal(by('Cosmoserve').length, 2, 'A later round of different type is a different deal');
assert.equal(by('Cosmoserve').find(d => d.round === 'Seed').sources.length, 2, 'Name variants of one company fold together');
const q = by('Quick Ride');
assert.equal(q.length, 2, 'A report more than 30 days apart is a different deal'); assert.equal(q.find(d => d.date === '2026-11-06').publisher, 'Entrackr');
const tranches = consolidateDeals([fromInc42Row({ ...inc, id: 'd'.repeat(24), amount: '$10 Mn', sourceUrl: 'https://inc42.com/buzz/a/' }), fromInc42Row({ ...inc, id: 'e'.repeat(24), amount: '$25 Mn', dateISO: '2026-11-20', sourceUrl: 'https://inc42.com/buzz/b/' })]);
assert.equal(tranches.length, 2, 'One outlet printing two sizes is two tranches, not a disagreement');

// --- Collector -------------------------------------------------------------------------------------
const rss = items => `<?xml version="1.0"?><rss><channel>${items.map(([t, l, src]) => `<item><title><![CDATA[${t}${src ? ` - ${src}` : ''}]]></title><link>${l}</link><pubDate>Thu, 12 Nov 2026 08:00:00 GMT</pubDate>${src ? `<source url="https://x">${src}</source>` : ''}</item>`).join('')}</channel></rss>`;
const feeds = [{ id: 'entrackr', publisher: 'Entrackr', india: true, url: 'https://entrackr.com/rss' }, { id: 'google-x', publisher: 'Google News', google: true, url: 'https://news.google.com/rss/search?q=x' }, { id: 'dead', publisher: 'Mint', url: 'https://www.livemint.com/rss/companies' }];
const bodies = {
  'https://entrackr.com/rss': rss([['Hundo Pizza raises maiden institutional round led by Titan Capital', 'https://entrackr.com/h'], ['Funding and acquisitions in Indian startups this week', 'https://entrackr.com/w'], ['Listed Co raises Rs 50 crore', 'https://entrackr.com/l']]),
  'https://news.google.com/rss/search?q=x': rss([['Hundo Pizza raises funding led by Titan Capital in Bengaluru', 'https://news.google.com/a/1', 'Times of India'], ['Bay raises $50 million', 'https://news.google.com/a/2', 'Some Blog']]),
};
const fetcher = async url => bodies[url] ? { status: 200, body: bodies[url] } : { status: 403, body: '' };
const items = parseItems(bodies['https://news.google.com/rss/search?q=x'], feeds[1]);
assert.deepEqual(items.map(i => [i.title, i.publisher]), [['Hundo Pizza raises funding led by Titan Capital in Bengaluru', 'Times of India'], ['Bay raises $50 million', 'Some Blog']], 'Google News names the real publisher and its suffix is removed');
assert.equal(observe(items[1], feeds[1], { now: Date.parse('2026-11-12T10:00:00Z') }).skip, 'not-india');
const listed = new Set([companyKey('Listed Co Ltd')]);
let state = emptyCapture();
const first = await collect(state, { fetcher, feeds, listed, gapMs: 0, now: () => '2026-11-12T10:00:00.000Z' });
assert.equal(first.ok, 2); assert.equal(first.added, 2);
assert.deepEqual(first.state.observations.map(o => [o.company, o.publisher]).sort(), [['Hundo Pizza', 'Entrackr'], ['Hundo Pizza', 'Times of India']], 'Listed companies and roundups are left out');
assert.equal(first.state.feeds.find(f => f.id === 'dead').ok, false);
const later = await collect(first.state, { fetcher: async () => ({ status: 0, body: '' }), feeds, listed, gapMs: 0, now: () => '2026-11-12T12:00:00.000Z' });
assert.equal(later.ok, 0); assert.equal(later.state.observations.length, 2, 'A failed read never deletes a captured report');
assert.equal(later.state.feeds.find(f => f.id === 'entrackr').lastOkAt, '2026-11-12T10:00:00.000Z', 'A failed feed keeps its last good time');
assert.equal(consolidateDeals(first.state.observations).length, 1, 'The two reports fold into one deal');
console.log('PASS private deals: headline reading, India and listed filters, folding across sources, credibility-led fields, shown disagreements, merge-never-delete capture.');

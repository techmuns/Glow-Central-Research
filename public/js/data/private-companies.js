// THE FAMILY'S PRIVATE COMPANIES (GLOW-OWNED) — the unlisted shares and private investments in
// GlowVentures' book, named as the COMPANY rather than as the statement line, with the exact names a
// funding report or a headline may print for it. scripts/build-book.mjs writes them into
// portfolio-companies.json as `privateCompanies`; the Private Market tab reads them for its Portfolio
// scope. Pure: imported by the build and by the browser, so both use one definition.
//
// A statement line often names the person or vehicle the shares came through ("Ajay Jain - Drink
// Prime", "LV Angel Fund - Lets Venture (HOOPR)"), so the company is read from REVIEWED below where
// the line needs it, and is otherwise the line's first segment. Every alias is stated in the book
// line itself, in GlowVentures' own security key, or is the company's known legal-name/brand pair.
// Matching is EXACT on a normalised name — never a substring, a token overlap or a fuzzy score.

/** GlowVentures securityKey → the company and the other names it is reported under. */
export const REVIEWED = {
  'waterwala-labs-private-limited-drink-prime': { name: 'DrinkPrime', legalName: 'Waterwala Labs Private Limited', aliases: ['Drink Prime', 'Waterwala Labs'] },
  'ajay-jain-drink-prime': { name: 'DrinkPrime', legalName: 'Waterwala Labs Private Limited', aliases: ['Drink Prime', 'Waterwala Labs'] },
  'hanok-reuben-medhari-drink-prime': { name: 'DrinkPrime', legalName: 'Waterwala Labs Private Limited', aliases: ['Drink Prime', 'Waterwala Labs'] },
  'vineet-sethia-drink-prime': { name: 'DrinkPrime', legalName: 'Waterwala Labs Private Limited', aliases: ['Drink Prime', 'Waterwala Labs'] },
  'stay-vista-private-limited-anandkumar-radhakrishna-ladsariya': { name: 'StayVista', legalName: 'Stay Vista Private Limited', aliases: ['Stay Vista'] },
  'stay-vista-private-limited-artha-energy-projects': { name: 'StayVista', legalName: 'Stay Vista Private Limited', aliases: ['Stay Vista'] },
  'swapeco-solutions': { name: 'ScrapUncle', legalName: 'Swapeco Solutions Private Limited', aliases: ['Scrap Uncle', 'Swapeco Solutions'] },
  'swapeco-solutions-private-limited-scrap-uncle-mukul-chabra': { name: 'ScrapUncle', legalName: 'Swapeco Solutions Private Limited', aliases: ['Scrap Uncle', 'Swapeco Solutions'] },
  'lv-angel-fund-lets-venture-hoopr-vaibhav-karnavat': { name: 'Hoopr', aliases: [] },
  'al-trust-collabmates-pvt-ltd-angellist-likeminds': { name: 'Collabmates', legalName: 'Collabmates Private Limited', aliases: [] },
  'al-trust-karban-envirotech-ruv-nilesh-angelist': { name: 'Karban Envirotech', aliases: [] },
  'big-bang-boom-solutions-private-limited-0-001-pref-12sp44': { name: 'Big Bang Boom Solutions', aliases: ['Big Bang Boom'] },
  'innoviti-payment-solutions-private-ltd-pranav-koranne': { name: 'Innoviti', legalName: 'Innoviti Payment Solutions Private Limited', aliases: ['Innoviti Payment Solutions'] },
  'nopo-nanotechnologies-india-pvt-ltd-gadhadar-reddy': { name: 'NoPo Nanotechnologies', legalName: 'Nopo Nanotechnologies India Private Limited', aliases: ['Nopo Nanotechnologies India'] },
  'third-eye-distillery-holdings-pvt-ltd-skyventures-lv-angel-fund-aakash-sachdev': { name: 'Third Eye Distillery', legalName: 'Third Eye Distillery Holdings Private Limited', aliases: ['Third Eye Distillery Holdings'] },
  'edugorilla-community': { name: 'EduGorilla', legalName: 'EduGorilla Community Private Limited', aliases: ['EduGorilla Community'] },
  'landcraft-retail-pvt-ltd-food-square': { name: 'Food Square', legalName: 'Landcraft Retail Private Limited', aliases: ['Landcraft Retail'] },
  'hyprkytchen-foodtech-private-limited-mr-bansi': { name: 'HyprKytchen', legalName: 'HyprKytchen Foodtech Private Limited', aliases: ['HyprKytchen Foodtech'] },
  'incred-holdings': { name: 'InCred Holdings', legalName: 'InCred Holdings Limited', aliases: [] },
  'runable-investment': { name: 'Runable', aliases: [] },
  'perplexity-investment': { name: 'Perplexity', aliases: [] },
  'integris-medtech': { name: 'Integris Medtech', aliases: [] },
  'oilmax-energy': { name: 'Oilmax Energy', aliases: ['Oil Max'] },
  'radiant-innovative-manufacturing': { name: 'Radiant Innovative Manufacturing', aliases: [] },
  'rays-power-experts': { name: 'Rays Power Experts', aliases: [] },
  'sotefin-bharat': { name: 'Sotefin Bharat', aliases: [] },
  'zenith-leisure-holidays': { name: 'Zenith Leisure Holidays', aliases: [] },
  'sks-fasteners': { name: 'SKS Fasteners', aliases: [] },
  'assetgro-fintech-private-limited-1-series-b-pref-25nv44': { name: 'Assetgro Fintech', legalName: 'Assetgro Fintech Private Limited', aliases: ['Assetgro'] },
};

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const LEGAL = /\b(private|pvt|limited|ltd|llp|plc)\b\.?/gi;

/** The key two names must share to be the same name: lower case, legal suffixes and punctuation gone. */
export const nameKey = (value) => clean(value).toLowerCase().replace(/&/g, ' and ').replace(LEGAL, ' ').replace(/[^a-z0-9]+/g, '');

/** A statement line's own company name: its first segment, before any " - person / vehicle". */
const firstSegment = (security) => clean(String(security || '').split(/\s+[-–—]\s+|\(/)[0]);
// A name printed all in capitals reads as one in title case; short initialisms (URB, SKS) stay.
const titleCase = (value) => /[a-z]/.test(value) ? value : value.split(' ').map((w) => w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase()).join(' ');
const displayName = (value) => titleCase(clean(value.replace(LEGAL, ' ').replace(/\s*\.\s*$/, '')));

/**
 * The private companies in a GlowVentures book: `Unlisted` shares, and single-company private
 * investments the review names (a pooled fund is an AIF, not a company, and is left out). Warrants
 * on a listed company are not a private company. One entry per company, every statement line under it.
 */
export function privateCompaniesFrom(positions = []) {
  const byId = new Map();
  for (const p of positions) {
    if (p?.marketSide !== 'private' || /\bwarrants?\b/i.test(p.security || '')) continue;
    const reviewed = REVIEWED[p.securityKey];
    if (p.assetClass !== 'Unlisted' && !reviewed) continue;
    const name = reviewed?.name || displayName(firstSegment(p.security)) || clean(p.security);
    const id = `private:${nameKey(name)}`;
    if (!nameKey(name)) continue;
    const entry = byId.get(id) || { id, name, legalName: reviewed?.legalName || null, aliases: [], isins: [], securityKeys: [], bookNames: [], categories: [] };
    for (const alias of reviewed?.aliases || []) if (!entry.aliases.includes(alias)) entry.aliases.push(alias);
    if (/^INE[A-Z0-9]{9}$/.test(p.isin || '') && !entry.isins.includes(p.isin)) entry.isins.push(p.isin);
    if (!entry.securityKeys.includes(p.securityKey)) entry.securityKeys.push(p.securityKey);
    if (!entry.bookNames.includes(p.security)) entry.bookNames.push(p.security);
    // GlowVentures' own category axis: a holding carried at cost is a private investment.
    const category = p.valuedAtCost === true ? 'private-investment' : 'unlisted';
    if (!entry.categories.includes(category)) entry.categories.push(category);
    byId.set(id, entry);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every exact name a company is matched on. */
export const matchNames = (company) => [company.name, company.legalName, ...(company.aliases || [])].filter(Boolean);

/**
 * `(name) => company | null` over a list of private companies. EXACT normalised equality only; a
 * name two companies share matches neither, because it cannot say which one it means.
 */
export function privateCompanyMatcher(companies = []) {
  const byKey = new Map();
  for (const company of companies) for (const name of matchNames(company)) {
    const key = nameKey(name);
    if (key.length < 3) continue;
    const held = byKey.get(key);
    byKey.set(key, held && held !== company ? null : company);
  }
  return (name) => byKey.get(nameKey(name)) || null;
}

/** The private companies a published company list carries (`privateCompanies`), validated. */
export function readPrivateCompanies(list) {
  const rows = Array.isArray(list?.privateCompanies) ? list.privateCompanies : [];
  return rows.filter((c) => /^private:[a-z0-9]+$/.test(c?.id || '') && typeof c.name === 'string' && c.name.trim() &&
    Array.isArray(c.aliases) && Array.isArray(c.categories));
}

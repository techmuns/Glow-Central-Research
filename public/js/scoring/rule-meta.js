// scoring/rule-meta.js — per-rule provenance for the drill-down cards.
//
// Ported verbatim from the reference dashboard's rule-meta.js (the `technicals`
// section plus the source helpers it depends on). Only the export surface changed:
// this file exports the technicals block directly rather than a multi-tab META map.
//
// Structure: RULE_META[ruleKey] = {
//   source:      (company) => { url, label, section }   // mandatory
//   calculation: string | null                          // null = no calc, just fetched
//   clientLogic: string                                 // verbatim from the client's sheet
//   ourLogic:    string | null                          // null = same as client
// }
//
// `ourLogic` being non-null is what turns the Implementation chip amber in the drill
// panel — it means our computation deviates from the client's stated logic.

// ---------- source helpers ----------

const SCREENER = (c) => ({
  url: c?.screenerUrl || c?.['Screener URL'] || 'https://www.screener.in/',
  label: 'Screener.in',
  section: 'Company page · Top Ratios',
});
const SCREENER_SHAREHOLD = (c) => ({ ...SCREENER(c), section: 'Company page · Shareholding Pattern' });

// For rules whose final value is COMPUTED in our pipeline (not pulled from a public
// page), still point at the OHLCV source so the inputs can be sanity-checked — but
// label it so the computed nature is obvious.
const COMPUTED_FROM_YAHOO = (c) => {
  const ticker = c?.ticker || String(c?.screenerUrl || '').match(/\/company\/([^/]+)/)?.[1] || '';
  return {
    url: ticker ? `https://finance.yahoo.com/quote/${ticker}.NS/history` : 'https://finance.yahoo.com',
    label: 'Calculated (from Yahoo OHLCV)',
    section: 'Daily closes — see input source on Yahoo Finance',
  };
};

// TradingView is the source of truth for an indicator WHEN technicals-source.json
// carries a scraped value for it (the data layer sets row._source_tech_fields).
// Without one, the rule falls back to the Yahoo-computed path so the Source button
// always reflects where the value actually came from.
const TRADINGVIEW = (c) => {
  const ticker = c?.ticker || '';
  return {
    url: ticker ? `https://in.tradingview.com/symbols/NSE-${ticker}/technicals/` : 'https://in.tradingview.com',
    label: 'TradingView · Technical Analysis',
    section: 'Live indicator value read from /technicals/ page',
  };
};

// Factory: picks TradingView when the named field was externally sourced for this
// company, else the Yahoo-calc path.
const techSource = (fieldName) => (c) => (c?._source_tech_fields?.has(fieldName) ? TRADINGVIEW(c) : COMPUTED_FROM_YAHOO(c));

const NSE_BHAVCOPY = () => ({ url: 'https://www.nseindia.com/all-reports', label: 'NSE archives', section: 'sec_bhavdata_full daily CSV' });

// ---------- the technicals rule map ----------

export const RULE_META = {
  ema50: {
    source: techSource("ema50"),
    calculation: "Standard 50-day EMA. When we have a TradingView scrape for this ticker, the value is read directly from the moving-averages table. Otherwise we compute it locally from Yahoo daily closes (EMA today = price × (2/51) + EMA yesterday × (49/51), seeded with first 50-day SMA). PASS if today's close > 50 EMA.",
    clientLogic: "PASS if CMP > 50 EMA on daily timeframe; 2 pts. Below 50 EMA = 0 pts. Confirms short-to-medium term uptrend.",
    ourLogic: null,
  },
  dma200: {
    source: techSource("sma200"),
    calculation: "200-day SMA. When we have a TradingView scrape for this ticker, the value is read directly from the moving-averages table. Otherwise computed locally as the simple average of the last 200 Yahoo daily closes. PASS if today's close > 200 DMA. Returns N/A for companies with < 200 trading days of history.",
    clientLogic: "PASS if CMP > 200 DMA on daily timeframe; 2 pts. Fail = stock exits pipeline (primary trend filter).",
    ourLogic: null,
  },
  gold: {
    source: (c) => (c?._source_tech_fields?.has("sma50") || c?._source_tech_fields?.has("sma200")) ? TRADINGVIEW(c) : COMPUTED_FROM_YAHOO(c),
    calculation: "50-day SMA and 200-day SMA — read from TradingView when scraped, computed locally from Yahoo closes otherwise. Golden Cross active if 50 SMA > 200 SMA. Death Cross if 50 SMA < 200 SMA.",
    clientLogic: "PASS if 50 DMA > 200 DMA (Golden Cross active); 1 pt. Death Cross (50 < 200) = 0 pts.",
    ourLogic: null,
  },
  hhhl: {
    source: COMPUTED_FROM_YAHOO,
    calculation: "Aggregate daily Yahoo OHLCV into weekly bars (max high + min low per 5-day group). Take 26 weekly bars ≈ 6 months. Split into recent 13-week window vs prior 13-week window. Pattern present if recent max(high) > prior max(high) AND recent min(low) > prior min(low).",
    clientLogic: "PASS if HH-HL visible on weekly chart over 6+ months; 1 pt. Lower-lows pattern = 0 pts.",
    ourLogic: null,
  },
  rsi: {
    source: techSource("rsi14"),
    calculation: "RSI(14). When we have a TradingView scrape for this ticker, the value is read directly from the oscillators table. Otherwise computed locally from Yahoo closes: RSI = 100 − 100 / (1 + RS) where RS = average gain / average loss over last 14 daily closes, Wilder smoothing for subsequent updates.",
    clientLogic: "PASS if RSI 55–75 (ideal momentum zone); 2 pts. RSI > 80 = overbought = 1 pt. RSI < 40 = weak/failing = 0 pts.",
    ourLogic: null,
  },
  macd: {
    source: COMPUTED_FROM_YAHOO,
    calculation: "MACD line = EMA(12) − EMA(26). Signal = EMA(9) of MACD line. Computed locally from Yahoo closes (TradingView shows MACD Level but not Signal separately, so we keep the local computation). PASS if MACD line > signal AND MACD line > 0. Positive crossover detected if MACD crossed above signal in last day.",
    clientLogic: "PASS if MACD line > signal line and above zero (positive crossover); 2 pts. Negative crossover = 0 pts.",
    ourLogic: null,
  },
  adx: {
    source: techSource("adx14"),
    calculation: "ADX(14). When we have a TradingView scrape for this ticker, the value is read directly from the oscillators table. Otherwise computed locally from Yahoo OHLCV using Wilder smoothing: True Range / +DM / −DM each day → +DI / −DI → DX = 100 × |+DI − −DI| / (+DI + −DI) → ADX = 14-period Wilder smoothing of DX. Scoring: > 25 = 1 pt, 20–25 = 0.5 pt (per client framework), < 20 = 0.",
    clientLogic: "PASS if ADX > 25 (strong trend); 1 pt. ADX 20–25 = 0.5 pts (developing). ADX < 20 = choppy/no trend = 0 pts.",
    ourLogic: null,
  },
  rs: {
    source: COMPUTED_FROM_YAHOO,
    calculation: "Compute 6-month return for stock and for Nifty 500 index (^CRSLDX). Relative Strength = stock_return − index_return.",
    clientLogic: "PASS if 6M price return > Nifty 500 index return; 2 pts. Underperforming benchmark = 1 pt.",
    ourLogic: null,
  },
  volbo: {
    source: COMPUTED_FROM_YAHOO,
    calculation: "Compare today's volume against the average of the prior 20 trading days' volume. Volume ratio = today / 20-day avg. PASS if ratio ≥ 1.5×.",
    clientLogic: "PASS if breakout-day volume ≥ 1.5× 20-day avg; 2 pts. Low volume breakout = suspect = 1 pt.",
    ourLogic: null,
  },
  delivery: {
    source: NSE_BHAVCOPY,
    calculation: "Fetch NSE sec_bhavdata_full daily CSV for the last ~30 trading days. Extract DELIV_PER per ticker per day. Compute recent-half average vs older-half average. PASS if recent average > older average by > 1 pp.",
    clientLogic: "PASS if delivery % trending up over last 30 trading days; 1 pt. Declining delivery % = 0 pts.",
    ourLogic: null,
  },
  instact: {
    source: SCREENER_SHAREHOLD,
    calculation: "Pull 'Chg in FII Hold' + 'Chg in DII Hold' from each company's Screener Top Ratios. Sum > 0 = PASS. PARTIAL if sum positive but FII alone falling > 2%.",
    clientLogic: "PASS if FII + DII cumulative buying in last 2 quarters; 1 pt. Net institutional selling = 0 pts.",
    ourLogic: null,
  },
  near52w: {
    source: COMPUTED_FROM_YAHOO,
    calculation: "Compute 52-week high from last 250 daily closes. Proximity ratio = today's close / 52W high. Distance from high = (1 − ratio) × 100%.",
    clientLogic: "PASS if within 10% of 52-week high; 2 pts. > 20% below 52W high = weak structure = 0 pts.",
    ourLogic: null,
  },
  consolidation: {
    source: COMPUTED_FROM_YAHOO,
    calculation: "Look at the last 30 trading days = 6 weeks. Base range % = (max(high) − min(low)) / avg(close) × 100. Tight base = range < 12%. Breakout = today's close > prior 6-week high. Volume confirm = today's volume > 1.5× base avg volume. Strong = all three; partials documented in the note.",
    clientLogic: "PASS if breaking out of at least 6-week base on strong volume; 2 pts. No base = 0 pts.",
    ourLogic: null,
  },
  base: {
    source: COMPUTED_FROM_YAHOO,
    calculation: "Take last 60 daily closes. Drawdown % = (max − min) / max × 100. Closing-range tightness = standard deviation of closes ÷ mean of closes, expressed as %. Healthy = drawdown < 15% AND tightness < 4%.",
    clientLogic: "PASS if base formed with controlled drawdown < 15% and tight closing range; 1 pt.",
    ourLogic: null,
  },
  beta: {
    source: COMPUTED_FROM_YAHOO,
    calculation: "Beta = covariance(stock_daily_returns, index_daily_returns) / variance(index_daily_returns). Inputs are 1-year (up to 252 trading days) of daily closes from Yahoo Chart v8 for the stock and Nifty 500 (^CRSLDX). Stock and index series are intersected by calendar DATE before returns are computed — earlier versions used slice(-252) on each series independently, which silently misaligned dates whenever the stock and index histories had different lengths (e.g. recent IPOs with shorter histories). That bug compressed beta toward 0 across the universe; this fix restores it.",
    clientLogic: "PASS if Beta 0.7–1.3 (moderate); 1 pt. Beta > 1.5 = high risk, weight penalty. Beta < 0.5 = drag risk.",
    ourLogic: null,
  },
  atr: {
    source: COMPUTED_FROM_YAHOO,
    calculation: "ATR(14) using Wilder smoothing over True Range values. ATR % = ATR ÷ latest close × 100. Trend assessed from atr_history.json accumulator (≥10 daily snapshots needed for trend): recent-half avg vs older-half avg. Scoring combines absolute level (<2.5% / 2.5–4% / >4%) AND trend direction (declining boosts to PASS, rising downgrades to partial). Accumulator builds 1 snapshot per daily Technicals scrape, so the trend signal strengthens over ~2 weeks.",
    clientLogic: "PASS if 14-day ATR % declining or stable (< 2.5% for large cap); 1 pt. Rising ATR = position-size flag.",
    ourLogic: null,
  },};

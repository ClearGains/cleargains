// IG spread-bet epics for individual stocks.
// The prefix (UA./UB./UC./UD./SA./SB./SC./SD./SE./SG./SH./KA. etc.) varies
// per instrument — there's no single scheme, confirmed against IG's own
// market search. Each epic below was individually verified live.
// CS.D. prefix is for currencies/commodities — do NOT use it for share spread bets.
// minSize: IG enforces a minimum bet size per point — 1 for most stocks.

export type IGStockInfo = {
  epic:       string;
  name:       string;
  exchange:   'NASDAQ' | 'NYSE' | 'LSE';
  currency:   'USD' | 'GBP';
  pointValue: number;
  minSize:    number;  // minimum £/$ per point enforced by IG
};

// Confirmed live against IG's own market search on 2026-07-31: the actual
// epic prefix varies per instrument (UA./UB./UC./UD./SA./SB./SC./SD./SE./
// SG./SH./KA. etc.), not a flat UC.D. scheme — most of the old codes here
// didn't resolve on IG at all.
export const IG_STOCK_EPICS: Record<string, IGStockInfo> = {
  // ── US Mega-cap Tech (NASDAQ) ──────────────────────────────────────────────
  'AAPL':  { epic: 'UA.D.AAPL.DAILY.IP',   name: 'Apple Inc',          exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'MSFT':  { epic: 'UC.D.MSFT.DAILY.IP',   name: 'Microsoft',          exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'GOOGL': { epic: 'UB.D.GOOGL.DAILY.IP',  name: 'Alphabet',           exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'AMZN':  { epic: 'UA.D.AMZN.DAILY.IP',   name: 'Amazon',             exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'NVDA':  { epic: 'UC.D.NVDA.DAILY.IP',   name: 'NVIDIA',             exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'META':  { epic: 'UB.D.FB.DAILY.IP',     name: 'Meta Platforms',     exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'TSLA':  { epic: 'UD.D.TSLA.DAILY.IP',   name: 'Tesla',              exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'NFLX':  { epic: 'UC.D.NFLX.DAILY.IP',   name: 'Netflix',            exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'AMD':   { epic: 'SA.D.AMD.DAILY.IP',    name: 'AMD',                exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'INTC':  { epic: 'UB.D.INTC.DAILY.IP',   name: 'Intel',              exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'MU':    { epic: 'UC.D.MU.DAILY.IP',     name: 'Micron Technology',  exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'QCOM':  { epic: 'UC.D.QCOM.DAILY.IP',   name: 'Qualcomm',           exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'CRM':   { epic: 'SB.D.CRM.DAILY.IP',    name: 'Salesforce',         exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'ORCL':  { epic: 'SE.D.ORCLUS.DAILY.IP', name: 'Oracle',             exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  // ── US High-beta / Screener regulars ──────────────────────────────────────
  'PLTR':  { epic: 'SE.D.PLTRUS.DAILY.IP', name: 'Palantir',           exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'COIN':  { epic: 'UA.D.COINUS.DAILY.IP', name: 'Coinbase',           exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'SNAP':  { epic: 'SG.D.SNAPUS.DAILY.IP', name: 'Snap Inc',           exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'UBER':  { epic: 'SH.D.UBERUS.DAILY.IP', name: 'Uber',               exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'SHOP':  { epic: 'SG.D.SHOPUS.DAILY.IP', name: 'Shopify',            exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'SQ':    { epic: 'SG.D.SQUS.DAILY.IP',   name: 'Block Inc',          exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'PYPL':  { epic: 'UC.D.PYPLVUS.DAILY.IP',name: 'PayPal',             exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'RBLX':  { epic: 'SG.D.RBLXUS.DAILY.IP', name: 'Roblox',             exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'DKNG':  { epic: 'UB.D.DKNGUS.DAILY.IP', name: 'DraftKings',         exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'RIVN':  { epic: 'UC.D.RIVNUS.DAILY.IP', name: 'Rivian',             exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'NIO':   { epic: 'SE.D.NIOUS.DAILY.IP',  name: 'NIO Inc',            exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'GME':   { epic: 'SC.D.GMEUS.DAILY.IP',  name: 'GameStop',           exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  // ── US Finance / Consumer (NYSE) ──────────────────────────────────────────
  'JPM':   { epic: 'SD.D.JPM.DAILY.IP',    name: 'JPMorgan Chase',     exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'BAC':   { epic: 'SA.D.BAC.DAILY.IP',    name: 'Bank of America',    exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'GS':    { epic: 'SC.D.GS.DAILY.IP',     name: 'Goldman Sachs',      exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'DIS':   { epic: 'SB.D.DIS.DAILY.IP',    name: 'Disney',             exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  // ── US Energy (NYSE) ───────────────────────────────────────────────────────
  'XOM':   { epic: 'SH.D.XOM.DAILY.IP',    name: 'ExxonMobil',         exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'CVX':   { epic: 'SB.D.CVX.DAILY.IP',    name: 'Chevron',            exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  // ── US Healthcare ─────────────────────────────────────────────────────────
  'JNJ':   { epic: 'SD.D.JNJ.DAILY.IP',    name: 'Johnson & Johnson',  exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'PFE':   { epic: 'SE.D.PFE.DAILY.IP',    name: 'Pfizer',             exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  // ── UK Stocks (LSE) — priced in pence ─────────────────────────────────────
  'VOD':   { epic: 'KA.D.VOD.DAILY.IP',    name: 'Vodafone',           exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
  'BP':    { epic: 'KA.D.BP.DAILY.IP',     name: 'BP',                 exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
  'SHEL':  { epic: 'KA.D.SHELLN.DAILY.IP', name: 'Shell',              exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
  'BARC':  { epic: 'KA.D.BARC.DAILY.IP',   name: 'Barclays',           exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
  'LLOY':  { epic: 'KA.D.LLOY.DAILY.IP',   name: 'Lloyds Banking',     exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
  'AZN':   { epic: 'KA.D.AZN.DAILY.IP',    name: 'AstraZeneca',        exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
  'GSK':   { epic: 'KA.D.GSK.DAILY.IP',    name: 'GSK',                exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
  'HSBA':  { epic: 'KA.D.HSBA.DAILY.IP',   name: 'HSBC',               exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
};

/** Build a UC.D.DAILY.IP epic from a raw ticker symbol. */
export function tickerToEpic(ticker: string): string {
  return `UC.D.${ticker.toUpperCase()}.DAILY.IP`;
}

/** Detect the currency from the epic. */
export function epicCurrency(epic: string): 'GBP' | 'USD' {
  for (const info of Object.values(IG_STOCK_EPICS)) {
    if (info.epic === epic) return info.currency;
  }
  return 'USD';
}

/** Exchange flag emoji for display. */
export function exchangeFlag(exchange: string): string {
  return exchange === 'LSE' ? '🇬🇧' : '🇺🇸';
}

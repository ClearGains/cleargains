// IG spread-bet epics for individual stocks.
// Shares use CS.D.{TICKER}.TODAY.IP (Daily Funded Bet) on spread-bet accounts.
// UK shares are priced in pence; US shares in USD cents/dollars.
// Note: the old UA.D.{TICKER}.CASH.IP format is for CFD accounts — do NOT use
// those epics on a SPREADBET account or you'll get REJECT_CFD_ORDER_ON_SPREADBET_ACCOUNT.

export type IGStockInfo = {
  epic:       string;
  name:       string;
  exchange:   'NASDAQ' | 'NYSE' | 'LSE';
  currency:   'USD' | 'GBP';
  pointValue: number;
};

export const IG_STOCK_EPICS: Record<string, IGStockInfo> = {
  // ── US Technology (NASDAQ) ─────────────────────────────────────────────────
  'AAPL':  { epic: 'CS.D.AAPL.TODAY.IP',  name: 'Apple Inc',         exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'MSFT':  { epic: 'CS.D.MSFT.TODAY.IP',  name: 'Microsoft',         exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'GOOGL': { epic: 'CS.D.GOOGL.TODAY.IP', name: 'Alphabet',          exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'AMZN':  { epic: 'CS.D.AMZN.TODAY.IP',  name: 'Amazon',            exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'NVDA':  { epic: 'CS.D.NVDA.TODAY.IP',  name: 'NVIDIA',            exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'META':  { epic: 'CS.D.META.TODAY.IP',  name: 'Meta Platforms',    exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'TSLA':  { epic: 'CS.D.TSLA.TODAY.IP',  name: 'Tesla',             exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'NFLX':  { epic: 'CS.D.NFLX.TODAY.IP',  name: 'Netflix',           exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'AMD':   { epic: 'CS.D.AMD.TODAY.IP',   name: 'AMD',               exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'INTC':  { epic: 'CS.D.INTC.TODAY.IP',  name: 'Intel',             exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  // ── US Finance (NYSE) ──────────────────────────────────────────────────────
  'JPM':   { epic: 'CS.D.JPM.TODAY.IP',   name: 'JPMorgan Chase',    exchange: 'NYSE',   currency: 'USD', pointValue: 1 },
  'BAC':   { epic: 'CS.D.BAC.TODAY.IP',   name: 'Bank of America',   exchange: 'NYSE',   currency: 'USD', pointValue: 1 },
  'GS':    { epic: 'CS.D.GS.TODAY.IP',    name: 'Goldman Sachs',     exchange: 'NYSE',   currency: 'USD', pointValue: 1 },
  // ── US Energy (NYSE) ───────────────────────────────────────────────────────
  'XOM':   { epic: 'CS.D.XOM.TODAY.IP',   name: 'ExxonMobil',        exchange: 'NYSE',   currency: 'USD', pointValue: 1 },
  'CVX':   { epic: 'CS.D.CVX.TODAY.IP',   name: 'Chevron',           exchange: 'NYSE',   currency: 'USD', pointValue: 1 },
  // ── US Healthcare (NYSE) ──────────────────────────────────────────────────
  'JNJ':   { epic: 'CS.D.JNJ.TODAY.IP',   name: 'Johnson & Johnson',  exchange: 'NYSE',  currency: 'USD', pointValue: 1 },
  'PFE':   { epic: 'CS.D.PFE.TODAY.IP',   name: 'Pfizer',            exchange: 'NYSE',   currency: 'USD', pointValue: 1 },
  // ── UK Stocks (LSE) — priced in pence ─────────────────────────────────────
  'VOD':   { epic: 'CS.D.VOD.TODAY.IP',   name: 'Vodafone',          exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
  'BP':    { epic: 'CS.D.BP.TODAY.IP',    name: 'BP',                exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
  'SHEL':  { epic: 'CS.D.SHEL.TODAY.IP',  name: 'Shell',             exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
  'BARC':  { epic: 'CS.D.BARC.TODAY.IP',  name: 'Barclays',          exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
  'LLOY':  { epic: 'CS.D.LLOY.TODAY.IP',  name: 'Lloyds Banking',    exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
  'AZN':   { epic: 'CS.D.AZN.TODAY.IP',   name: 'AstraZeneca',       exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
  'GSK':   { epic: 'CS.D.GSK.TODAY.IP',   name: 'GSK',               exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
  'HSBA':  { epic: 'CS.D.HSBA.TODAY.IP',  name: 'HSBC',              exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
};

/** Build a CS.D.TODAY.IP epic from a raw ticker symbol. */
export function tickerToEpic(ticker: string): string {
  return `CS.D.${ticker.toUpperCase()}.TODAY.IP`;
}

/** Detect the currency from the epic: UK LSE shares in pence (GBP), US in USD. */
export function epicCurrency(epic: string): 'GBP' | 'USD' {
  // Known UK LSE epics end with .TODAY.IP and contain known UK tickers
  // Heuristic: if it resolves to LSE in our map, it's GBP — otherwise USD
  for (const info of Object.values(IG_STOCK_EPICS)) {
    if (info.epic === epic) return info.currency;
  }
  return 'USD'; // default US shares
}

/** Exchange flag emoji for display. */
export function exchangeFlag(exchange: string): string {
  return exchange === 'LSE' ? '🇬🇧' : '🇺🇸';
}

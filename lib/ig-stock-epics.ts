// IG spread-bet epics for individual stocks.
// All use the UA.D.{TICKER}.CASH.IP format (DFB cash bets).
// UK stocks are priced in pence; US stocks in USD.

export type IGStockInfo = {
  epic:       string;
  name:       string;
  exchange:   'NASDAQ' | 'NYSE' | 'LSE';
  currency:   'USD' | 'GBP';
  pointValue: number;  // £ per 1-point move per £1/pt size = 1 for all stocks
};

export const IG_STOCK_EPICS: Record<string, IGStockInfo> = {
  // ── US Technology (NASDAQ) ─────────────────────────────────────────────────
  'AAPL':  { epic: 'UA.D.AAPL.CASH.IP',  name: 'Apple Inc',        exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'MSFT':  { epic: 'UA.D.MSFT.CASH.IP',  name: 'Microsoft',        exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'GOOGL': { epic: 'UA.D.GOOGL.CASH.IP', name: 'Alphabet',         exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'AMZN':  { epic: 'UA.D.AMZN.CASH.IP',  name: 'Amazon',           exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'NVDA':  { epic: 'UA.D.NVDA.CASH.IP',  name: 'NVIDIA',           exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'META':  { epic: 'UA.D.META.CASH.IP',  name: 'Meta Platforms',   exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'TSLA':  { epic: 'UA.D.TSLA.CASH.IP',  name: 'Tesla',            exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'NFLX':  { epic: 'UA.D.NFLX.CASH.IP',  name: 'Netflix',          exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'AMD':   { epic: 'UA.D.AMD.CASH.IP',   name: 'AMD',              exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  'INTC':  { epic: 'UA.D.INTC.CASH.IP',  name: 'Intel',            exchange: 'NASDAQ', currency: 'USD', pointValue: 1 },
  // ── US Finance (NYSE) ──────────────────────────────────────────────────────
  'JPM':   { epic: 'UA.D.JPM.CASH.IP',   name: 'JPMorgan Chase',   exchange: 'NYSE',   currency: 'USD', pointValue: 1 },
  'BAC':   { epic: 'UA.D.BAC.CASH.IP',   name: 'Bank of America',  exchange: 'NYSE',   currency: 'USD', pointValue: 1 },
  'GS':    { epic: 'UA.D.GS.CASH.IP',    name: 'Goldman Sachs',    exchange: 'NYSE',   currency: 'USD', pointValue: 1 },
  // ── US Energy (NYSE) ───────────────────────────────────────────────────────
  'XOM':   { epic: 'UA.D.XOM.CASH.IP',   name: 'ExxonMobil',       exchange: 'NYSE',   currency: 'USD', pointValue: 1 },
  'CVX':   { epic: 'UA.D.CVX.CASH.IP',   name: 'Chevron',          exchange: 'NYSE',   currency: 'USD', pointValue: 1 },
  // ── US Healthcare (NYSE) ──────────────────────────────────────────────────
  'JNJ':   { epic: 'UA.D.JNJ.CASH.IP',   name: 'Johnson & Johnson', exchange: 'NYSE',  currency: 'USD', pointValue: 1 },
  'PFE':   { epic: 'UA.D.PFE.CASH.IP',   name: 'Pfizer',           exchange: 'NYSE',   currency: 'USD', pointValue: 1 },
  // ── UK Stocks (LSE) — priced in pence ─────────────────────────────────────
  'VOD':   { epic: 'UA.D.VOD.CASH.IP',   name: 'Vodafone',         exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
  'BP':    { epic: 'UA.D.BP.CASH.IP',    name: 'BP',               exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
  'SHEL':  { epic: 'UA.D.RDSB.CASH.IP',  name: 'Shell',            exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
  'BARC':  { epic: 'UA.D.BARC.CASH.IP',  name: 'Barclays',         exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
  'LLOY':  { epic: 'UA.D.LLOY.CASH.IP',  name: 'Lloyds Banking',   exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
  'AZN':   { epic: 'UA.D.AZN.CASH.IP',   name: 'AstraZeneca',      exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
  'GSK':   { epic: 'UA.D.GSK.CASH.IP',   name: 'GSK',              exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
  'HSBA':  { epic: 'UA.D.HSBA.CASH.IP',  name: 'HSBC',             exchange: 'LSE',    currency: 'GBP', pointValue: 1 },
};

/** Exchange flag emoji for display. */
export function exchangeFlag(exchange: string): string {
  if (exchange === 'LSE') return '🇬🇧';
  return '🇺🇸';
}

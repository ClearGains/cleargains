// IG spread-bet epics for individual stocks.
// Shares use UC.D.{TICKER}.DAILY.IP (Daily Funded Bet) on spread-bet accounts.
// CS.D. prefix is for currencies/commodities — do NOT use it for share spread bets.
// UA.D. / SA.D. are CFD variants — will get REJECT_CFD_ORDER_ON_SPREADBET_ACCOUNT.
// minSize: IG enforces a minimum bet size per point — 1 for most stocks.

export type IGStockInfo = {
  epic:       string;
  name:       string;
  exchange:   'NASDAQ' | 'NYSE' | 'LSE';
  currency:   'USD' | 'GBP';
  pointValue: number;
  minSize:    number;  // minimum £/$ per point enforced by IG
};

export const IG_STOCK_EPICS: Record<string, IGStockInfo> = {
  // ── US Mega-cap Tech (NASDAQ) ──────────────────────────────────────────────
  'AAPL':  { epic: 'UC.D.AAPL.DAILY.IP',  name: 'Apple Inc',          exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'MSFT':  { epic: 'UC.D.MSFT.DAILY.IP',  name: 'Microsoft',          exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'GOOGL': { epic: 'UC.D.GOOGL.DAILY.IP', name: 'Alphabet',           exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'AMZN':  { epic: 'UC.D.AMZN.DAILY.IP',  name: 'Amazon',             exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'NVDA':  { epic: 'UC.D.NVDA.DAILY.IP',  name: 'NVIDIA',             exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'META':  { epic: 'UC.D.META.DAILY.IP',  name: 'Meta Platforms',     exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'TSLA':  { epic: 'UC.D.TSLA.DAILY.IP',  name: 'Tesla',              exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'NFLX':  { epic: 'UC.D.NFLX.DAILY.IP',  name: 'Netflix',            exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'AMD':   { epic: 'UC.D.AMD.DAILY.IP',   name: 'AMD',                exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'INTC':  { epic: 'UC.D.INTC.DAILY.IP',  name: 'Intel',              exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'MU':    { epic: 'UC.D.MU.DAILY.IP',    name: 'Micron Technology',  exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'QCOM':  { epic: 'UC.D.QCOM.DAILY.IP',  name: 'Qualcomm',           exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'CRM':   { epic: 'UC.D.CRM.DAILY.IP',   name: 'Salesforce',         exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'ORCL':  { epic: 'UC.D.ORCL.DAILY.IP',  name: 'Oracle',             exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  // ── US High-beta / Screener regulars ──────────────────────────────────────
  'PLTR':  { epic: 'UC.D.PLTR.DAILY.IP',  name: 'Palantir',           exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'COIN':  { epic: 'UC.D.COIN.DAILY.IP',  name: 'Coinbase',           exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'SNAP':  { epic: 'UC.D.SNAP.DAILY.IP',  name: 'Snap Inc',           exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'UBER':  { epic: 'UC.D.UBER.DAILY.IP',  name: 'Uber',               exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'SHOP':  { epic: 'UC.D.SHOP.DAILY.IP',  name: 'Shopify',            exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'SQ':    { epic: 'UC.D.SQ.DAILY.IP',    name: 'Block Inc',          exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'PYPL':  { epic: 'UC.D.PYPL.DAILY.IP',  name: 'PayPal',             exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'RBLX':  { epic: 'UC.D.RBLX.DAILY.IP',  name: 'Roblox',             exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'DKNG':  { epic: 'UC.D.DKNG.DAILY.IP',  name: 'DraftKings',         exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'RIVN':  { epic: 'UC.D.RIVN.DAILY.IP',  name: 'Rivian',             exchange: 'NASDAQ', currency: 'USD', pointValue: 1, minSize: 1 },
  'NIO':   { epic: 'UC.D.NIO.DAILY.IP',   name: 'NIO Inc',            exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'GME':   { epic: 'UC.D.GME.DAILY.IP',   name: 'GameStop',           exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  // ── US Finance / Consumer (NYSE) ──────────────────────────────────────────
  'JPM':   { epic: 'UC.D.JPM.DAILY.IP',   name: 'JPMorgan Chase',     exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'BAC':   { epic: 'UC.D.BAC.DAILY.IP',   name: 'Bank of America',    exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'GS':    { epic: 'UC.D.GS.DAILY.IP',    name: 'Goldman Sachs',      exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'DIS':   { epic: 'UC.D.DIS.DAILY.IP',   name: 'Disney',             exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  // ── US Energy (NYSE) ───────────────────────────────────────────────────────
  'XOM':   { epic: 'UC.D.XOM.DAILY.IP',   name: 'ExxonMobil',         exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'CVX':   { epic: 'UC.D.CVX.DAILY.IP',   name: 'Chevron',            exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  // ── US Healthcare ─────────────────────────────────────────────────────────
  'JNJ':   { epic: 'UC.D.JNJ.DAILY.IP',   name: 'Johnson & Johnson',  exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  'PFE':   { epic: 'UC.D.PFE.DAILY.IP',   name: 'Pfizer',             exchange: 'NYSE',   currency: 'USD', pointValue: 1, minSize: 1 },
  // ── UK Stocks (LSE) — priced in pence ─────────────────────────────────────
  'VOD':   { epic: 'UC.D.VOD.DAILY.IP',   name: 'Vodafone',           exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
  'BP':    { epic: 'UC.D.BP.DAILY.IP',    name: 'BP',                 exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
  'SHEL':  { epic: 'UC.D.SHEL.DAILY.IP',  name: 'Shell',              exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
  'BARC':  { epic: 'UC.D.BARC.DAILY.IP',  name: 'Barclays',           exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
  'LLOY':  { epic: 'UC.D.LLOY.DAILY.IP',  name: 'Lloyds Banking',     exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
  'AZN':   { epic: 'UC.D.AZN.DAILY.IP',   name: 'AstraZeneca',        exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
  'GSK':   { epic: 'UC.D.GSK.DAILY.IP',   name: 'GSK',                exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
  'HSBA':  { epic: 'UC.D.HSBA.DAILY.IP',  name: 'HSBC',               exchange: 'LSE',    currency: 'GBP', pointValue: 1, minSize: 1 },
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

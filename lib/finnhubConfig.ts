/**
 * Finnhub configuration — symbol mapping, epic resolution, category helpers.
 * Free tier: 60 requests / minute.
 */

export const FINNHUB_KEY  = process.env.FINNHUB_API_KEY ?? '';
export const FINNHUB_BASE = 'https://finnhub.io/api/v1';

export type FinnhubCategory = 'US_STOCK' | 'UK_STOCK' | 'FOREX' | 'CRYPTO';

export const CATEGORY_LABELS: Record<FinnhubCategory, string> = {
  US_STOCK: 'US Stocks',
  UK_STOCK: 'UK Stocks',
  FOREX:    'Forex',
  CRYPTO:   'Crypto',
};

export const FINNHUB_EXCHANGE: Record<FinnhubCategory, { type: 'stock' | 'forex' | 'crypto'; exchange: string }> = {
  US_STOCK: { type: 'stock',  exchange: 'US' },
  UK_STOCK: { type: 'stock',  exchange: 'L'  },
  FOREX:    { type: 'forex',  exchange: 'oanda'   },
  CRYPTO:   { type: 'crypto', exchange: 'binance' },
};

// ── Finnhub symbol → IG CFD epic ─────────────────────────────────────────────

export function toIgEpic(symbol: string, cat: FinnhubCategory): string | null {
  switch (cat) {
    case 'US_STOCK':
      // Plain ticker: AAPL → UA.D.AAPL.CASH.IP
      if (/^[A-Z]{1,5}$/.test(symbol)) return `UA.D.${symbol}.CASH.IP`;
      return null;

    case 'UK_STOCK': {
      // BARC.L → UA.D.BARC.CASH.IP
      const t = symbol.replace(/\.(L|LON)$/, '');
      if (/^[A-Z]{2,6}$/.test(t)) return `UA.D.${t}.CASH.IP`;
      return null;
    }

    case 'FOREX': {
      // OANDA:GBP_USD → CS.D.GBPUSD.TODAY.IP
      const pair = symbol.replace(/^[^:]+:/, '').replace('_', '');
      if (pair.length === 6 && /^[A-Z]{6}$/.test(pair)) return `CS.D.${pair}.TODAY.IP`;
      return null;
    }

    case 'CRYPTO': {
      const CRYPTO_EPICS: Record<string, string> = {
        'BINANCE:BTCUSDT':  'CS.D.BITCOIN.TODAY.IP',
        'BINANCE:ETHUSDT':  'CS.D.ETHEREUM.TODAY.IP',
        'BINANCE:XRPUSDT':  'CS.D.RIPPLE.TODAY.IP',
        'BINANCE:LTCUSDT':  'CS.D.LITECOIN.TODAY.IP',
        'BINANCE:ADAUSDT':  'CS.D.BITCOIN.TODAY.IP',  // fallback to BTC if no direct epic
        'BINANCE:BNBUSDT':  'CS.D.BITCOIN.TODAY.IP',
        'BINANCE:SOLUSDT':  'CS.D.BITCOIN.TODAY.IP',
        'BINANCE:DOTUSDT':  'CS.D.BITCOIN.TODAY.IP',
      };
      return CRYPTO_EPICS[symbol] ?? null;
    }
  }
}

// ── Finnhub symbol → Yahoo Finance symbol (for indicator calculation) ─────────

export function toYahooSymbol(symbol: string, cat: FinnhubCategory): string | null {
  switch (cat) {
    case 'US_STOCK':
      return /^[A-Z]{1,5}$/.test(symbol) ? symbol : null;

    case 'UK_STOCK':
      // BARC.L is directly usable on Yahoo Finance
      return /\.(L|LON)$/.test(symbol) ? symbol : `${symbol}.L`;

    case 'FOREX': {
      // OANDA:GBP_USD → GBPUSD=X  (special case: USD pairs)
      const pair = symbol.replace(/^[^:]+:/, '').replace('_', '');
      if (pair.length !== 6) return null;
      const base = pair.slice(0, 3), quote = pair.slice(3);
      if (quote === 'USD') return `${base}USD=X`;
      if (base === 'USD') return `${quote}=X`;
      return `${pair}=X`;
    }

    case 'CRYPTO': {
      // BINANCE:BTCUSDT → BTC-USD
      const raw = symbol.replace(/^[^:]+:/, '');
      if (raw.endsWith('USDT')) return `${raw.replace('USDT', '')}-USD`;
      if (raw.endsWith('BTC'))  return `${raw.replace('BTC', '')}-BTC`;
      return null;
    }
  }
}

// ── Curated tier-1 symbol shortlists (guaranteed liquid + CFD available) ─────
// Used as the screener's first pass when the full universe isn't loaded yet.

export const TIER1_SYMBOLS: Record<FinnhubCategory, string[]> = {
  US_STOCK: [
    // Mega-cap tech
    'AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AMD','NFLX','CRM',
    'ORCL','INTC','QCOM','AVGO','TXN','MU','AMAT','LRCX','ADBE','PYPL',
    // Finance
    'JPM','BAC','WFC','GS','MS','V','MA','AXP','C','BLK',
    // Healthcare
    'JNJ','PFE','MRK','ABBV','LLY','BMY','GILD','AMGN','CVS',
    // Energy
    'XOM','CVX','COP','SLB','EOG',
    // Consumer
    'WMT','TGT','COST','HD','LOW','MCD','SBUX','NKE','DIS',
    // Industrial
    'BA','CAT','GE','HON','MMM','RTX','LMT','UPS','FDX',
    // EV/Clean energy
    'RIVN','LCID','PLUG','ENPH','FSLR',
  ],
  UK_STOCK: [
    'BARC.L','HSBA.L','LLOY.L','NWG.L','STAN.L',   // Banks
    'BP.L','SHEL.L',                                  // Energy
    'AZN.L','GSK.L','HLN.L',                          // Pharma
    'ULVR.L','RKT.L','DGE.L',                         // Consumer
    'RIO.L','BHP.L','AAL.L','GLEN.L','ANTO.L',        // Mining
    'VOD.L','BT.A.L',                                 // Telecoms
    'LSEG.L','HSBA.L','ABDN.L',                       // Finance
    'IAG.L','EZJ.L',                                  // Airlines
    'SPX.L','ABF.L','MKS.L',                          // Misc
  ],
  FOREX: [
    'OANDA:GBP_USD','OANDA:EUR_USD','OANDA:USD_JPY','OANDA:USD_CHF',
    'OANDA:AUD_USD','OANDA:USD_CAD','OANDA:NZD_USD','OANDA:EUR_GBP',
    'OANDA:EUR_JPY','OANDA:GBP_JPY','OANDA:EUR_CHF','OANDA:AUD_JPY',
  ],
  CRYPTO: [
    'BINANCE:BTCUSDT','BINANCE:ETHUSDT','BINANCE:BNBUSDT','BINANCE:XRPUSDT',
    'BINANCE:ADAUSDT','BINANCE:SOLUSDT','BINANCE:DOTUSDT','BINANCE:LTCUSDT',
    'BINANCE:MATICUSDT','BINANCE:AVAXUSDT','BINANCE:LINKUSDT','BINANCE:UNIUSDT',
  ],
};

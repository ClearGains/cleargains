/**
 * Browser-side Yahoo Finance client.
 * Called directly from client components — bypasses Vercel server-side blocking.
 * Yahoo Finance allows CORS from browsers but blocks automated server requests.
 */

export type QuoteResult = {
  symbol:        string;
  name:          string;
  price:         number;
  bid:           number;
  ask:           number;
  changePercent: number;
  volume:        number;
  marketCap?:    number;
  week52High?:   number;
  week52Low?:    number;
  currency:      string;
  exchange:      string;
};

export type YahooCandle = {
  time:   string; // YYYY-MM-DD
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
};

// Market name → Yahoo Finance symbol (for IGStrategyTrader)
export const YAHOO_SYMBOL_MAP: Record<string, string> = {
  'FTSE 100':      '^FTSE',
  'S&P 500':       '^GSPC',
  'NASDAQ 100':    '^IXIC',
  'Germany 40':    '^GDAXI',
  'Wall Street':   '^DJI',
  'Japan 225':     '^N225',
  'Australia 200': '^AXJO',
  'Gold':          'GC=F',
  'Oil (WTI)':     'CL=F',
  'Brent Crude':   'BZ=F',
  'Silver':        'SI=F',
  'Natural Gas':   'NG=F',
  'GBP/USD':       'GBPUSD=X',
  'EUR/USD':       'EURUSD=X',
  'EUR/GBP':       'EURGBP=X',
  'USD/JPY':       'JPY=X',
  'AUD/USD':       'AUDUSD=X',
  'USD/CHF':       'USDCHF=X',
  'Bitcoin':       'BTC-USD',
  'Ethereum':      'ETH-USD',
};

// ── Quote fetch (v7 batch) ────────────────────────────────────────────────────

type YahooQuoteRaw = {
  symbol:                      string;
  shortName?:                  string;
  longName?:                   string;
  regularMarketPrice?:         number;
  bid?:                        number;
  ask?:                        number;
  regularMarketChangePercent?: number;
  regularMarketVolume?:        number;
  marketCap?:                  number;
  fiftyTwoWeekHigh?:           number;
  fiftyTwoWeekLow?:            number;
  currency?:                   string;
  fullExchangeName?:           string;
};

export async function fetchYahooQuotes(symbols: string[]): Promise<QuoteResult[]> {
  if (!symbols.length) return [];
  const batch = symbols.slice(0, 50);
  const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(batch.join(','))}`;
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`Yahoo Finance ${res.status}`);
    const raw = await res.json() as { quoteResponse?: { result?: YahooQuoteRaw[] } };
    return (raw.quoteResponse?.result ?? []).map(q => {
      const price  = q.regularMarketPrice ?? 0;
      const spread = price * 0.001;
      return {
        symbol:        q.symbol,
        name:          q.shortName ?? q.longName ?? q.symbol,
        price,
        bid:           q.bid ?? price - spread,
        ask:           q.ask ?? price + spread,
        changePercent: q.regularMarketChangePercent ?? 0,
        volume:        q.regularMarketVolume ?? 0,
        marketCap:     q.marketCap,
        week52High:    q.fiftyTwoWeekHigh,
        week52Low:     q.fiftyTwoWeekLow,
        currency:      q.currency ?? 'USD',
        exchange:      q.fullExchangeName ?? '',
      };
    });
  } catch {
    return [];
  }
}

// ── Historical OHLCV (v8 chart) ──────────────────────────────────────────────

type YahooChartRaw = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?:   (number | null)[];
          high?:   (number | null)[];
          low?:    (number | null)[];
          close?:  (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
    error?: { description?: string };
  };
};

function parseYahooChart(raw: YahooChartRaw, intraday: boolean): YahooCandle[] {
  if (raw.chart?.error) return [];
  const result = raw.chart?.result?.[0];
  if (!result) return [];
  const timestamps = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  return timestamps
    .map((ts, i) => ({
      time: intraday
        ? new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')
        : new Date(ts * 1000).toISOString().slice(0, 10),
      open:   q.open?.[i]   ?? 0,
      high:   q.high?.[i]   ?? 0,
      low:    q.low?.[i]    ?? 0,
      close:  q.close?.[i]  ?? 0,
      volume: q.volume?.[i] ?? 0,
    }))
    .filter(c => c.close > 0);
}

// 90-day daily fetch (used by PennyScanner / IGSharesAutoTrader)
export async function fetchYahooHistory(symbol: string): Promise<YahooCandle[]> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    return parseYahooChart(await res.json() as YahooChartRaw, false);
  } catch {
    return [];
  }
}

// Resolution-aware fetch for Graph Analysis
export type ChartResolution = '1D' | '1W' | '1M' | '3M' | '6M' | '1Y';

const RESOLUTION_MAP: Record<ChartResolution, { interval: string; range: string; intraday: boolean }> = {
  '1D': { interval: '5m',  range: '1d',  intraday: true  },
  '1W': { interval: '60m', range: '5d',  intraday: true  },
  '1M': { interval: '1d',  range: '1mo', intraday: false },
  '3M': { interval: '1d',  range: '3mo', intraday: false },
  '6M': { interval: '1d',  range: '6mo', intraday: false },
  '1Y': { interval: '1d',  range: '1y',  intraday: false },
};

export async function fetchYahooHistoryByResolution(
  symbol: string,
  resolution: ChartResolution,
): Promise<YahooCandle[]> {
  const cfg = RESOLUTION_MAP[resolution];
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${cfg.interval}&range=${cfg.range}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    return parseYahooChart(await res.json() as YahooChartRaw, cfg.intraday);
  } catch {
    return [];
  }
}

// Ticker search (browser-side)
export type TickerSearchResult = {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
};

export async function searchYahooTickers(query: string): Promise<TickerSearchResult[]> {
  if (!query.trim()) return [];
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const raw = await res.json() as {
      quotes?: Array<{ symbol?: string; shortname?: string; longname?: string; exchDisp?: string; quoteType?: string }>;
    };
    return (raw.quotes ?? [])
      .filter(q => q.symbol && q.quoteType !== 'MUTUALFUND' && q.quoteType !== 'CURRENCY')
      .map(q => ({
        symbol:   q.symbol ?? '',
        name:     q.shortname ?? q.longname ?? q.symbol ?? '',
        exchange: q.exchDisp ?? '',
        type:     q.quoteType ?? '',
      }));
  } catch {
    return [];
  }
}

// ── Snapshot for IGStrategyTrader ────────────────────────────────────────────

export async function fetchMarketSnapshot(marketName: string): Promise<{
  price: number; changePercent: number; signal: 'BUY' | 'SELL' | 'NEUTRAL'; source: string; error?: string;
} | null> {
  const symbol = YAHOO_SYMBOL_MAP[marketName];
  if (!symbol) return { price: 0, changePercent: 0, signal: 'NEUTRAL', source: 'yahoo', error: `No Yahoo symbol for "${marketName}"` };
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return { price: 0, changePercent: 0, signal: 'NEUTRAL', source: 'yahoo', error: `Yahoo ${res.status}` };
    const json = await res.json() as {
      chart?: {
        result?: Array<{ meta?: { regularMarketPrice?: number; previousClose?: number; chartPreviousClose?: number } }>;
        error?: unknown;
      };
    };
    if (json.chart?.error) return { price: 0, changePercent: 0, signal: 'NEUTRAL', source: 'yahoo', error: 'Yahoo returned error' };
    const meta  = json.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price         = meta.regularMarketPrice ?? 0;
    const previousClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
    const changePercent = previousClose ? ((price - previousClose) / previousClose) * 100 : 0;
    const signal: 'BUY' | 'SELL' | 'NEUTRAL' = changePercent > 0.3 ? 'BUY' : changePercent < -0.3 ? 'SELL' : 'NEUTRAL';
    return { price, changePercent, signal, source: 'yahoo' };
  } catch (e) {
    return { price: 0, changePercent: 0, signal: 'NEUTRAL', source: 'yahoo', error: e instanceof Error ? e.message : 'Fetch failed' };
  }
}

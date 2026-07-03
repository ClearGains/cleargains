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
  'Bitcoin':       'BTC-USD',
  'Ethereum':      'ETH-USD',
};

// ── Quote fetch (v7 batch via server proxy) ───────────────────────────────────

export async function fetchYahooQuotes(symbols: string[]): Promise<QuoteResult[]> {
  if (!symbols.length) return [];
  const batch = symbols.slice(0, 50);
  // Route through our own API which handles crumb auth — Yahoo now requires it
  // even for browser requests, so direct calls return empty results.
  try {
    const res = await fetch(`/api/market/quotes?symbols=${encodeURIComponent(batch.join(','))}`);
    if (res.ok) {
      const data = await res.json() as QuoteResult[];
      if (data.length) return data;
    }
  } catch { /* fall through to chart fallback */ }

  // Fallback: v8 chart endpoint — no crumb needed, works for individual symbols
  const results: QuoteResult[] = [];
  await Promise.allSettled(batch.map(async sym => {
    try {
      const r = await fetch(
        `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d`,
        { headers: { Accept: 'application/json' } },
      );
      if (!r.ok) return;
      const json = await r.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; previousClose?: number; chartPreviousClose?: number; currency?: string; fullExchangeName?: string; shortName?: string } }> } };
      const meta = json.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) return;
      const price = meta.regularMarketPrice;
      const prev  = meta.previousClose ?? meta.chartPreviousClose ?? price;
      results.push({
        symbol: sym, name: meta.shortName ?? sym,
        price, bid: price, ask: price,
        changePercent: prev > 0 ? ((price - prev) / prev) * 100 : 0,
        volume: 0, currency: meta.currency ?? 'USD', exchange: meta.fullExchangeName ?? '',
      });
    } catch { /* skip symbol */ }
  }));
  return results;
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

// Generic OHLCV fetch with custom interval/range (used by the Backtest Lab).
// Yahoo caps intraday history: 5m bars are available for ~60 days.
export async function fetchYahooBars(
  symbol:   string,
  interval: '1m' | '5m' | '15m' | '1h' | '1d',
  range:    string,   // e.g. '60d', '2y', '5y'
): Promise<YahooCandle[]> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&range=${range}&includePrePost=false`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    return parseYahooChart(await res.json() as YahooChartRaw, interval !== '1d');
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

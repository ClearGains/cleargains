import { NextRequest, NextResponse } from 'next/server';
import { YAHOO_SYMBOL_MAP } from '@/lib/yahooClient';
import { getSignal, TIMEFRAME_CONFIG, type Candle, type Timeframe } from '@/lib/igStrategyEngine';

/**
 * GET /api/ig/signal?name=FTSE%20100&timeframe=triple-ema
 *
 * Runs the ACTUAL named strategy from lib/igStrategyEngine.ts (Triple EMA,
 * Bollinger, Supertrend, RSI(2), EMA9/21, EMA20/50+MACD, Golden/Death Cross)
 * against real Yahoo Finance candles at the resolution that strategy needs.
 *
 * Zero IG data-allowance cost (Yahoo, not IG's /prices). Yahoo blocks
 * requests without browser-like headers (429) — a normal User-Agent fixes
 * that; it's not an IP block.
 */

const IG_RES_TO_YAHOO_INTERVAL: Record<string, '5m' | '1h' | '1d'> = {
  MINUTE_5: '5m',
  HOUR:     '1h',
  DAY:      '1d',
};

const IG_RES_TO_YAHOO_RANGE: Record<string, string> = {
  MINUTE_5: '5d',
  HOUR:     '60d',
  DAY:      '2y',
};

const CACHE_TTL = 10 * 60_000; // 10 min — Yahoo has no allowance cost, just be polite
const cache = new Map<string, { signal: ReturnType<typeof getSignal>; ts: number }>();

type YahooChartRaw = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[]; high?: (number | null)[];
          low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[];
        }>;
      };
    }>;
    error?: unknown;
  };
};

export async function GET(req: NextRequest) {
  const name      = req.nextUrl.searchParams.get('name') ?? '';
  const timeframe = (req.nextUrl.searchParams.get('timeframe') ?? 'daily') as Timeframe;
  const force     = req.nextUrl.searchParams.get('force') === '1';

  const yahoo = YAHOO_SYMBOL_MAP[name];
  if (!yahoo) {
    return NextResponse.json({ ok: false, error: `No Yahoo mapping for "${name}"` }, { status: 400 });
  }
  const cfg = TIMEFRAME_CONFIG[timeframe];
  if (!cfg) {
    return NextResponse.json({ ok: false, error: `Unknown timeframe: ${timeframe}` }, { status: 400 });
  }

  const cacheKey = `${yahoo}:${timeframe}`;
  const cached = cache.get(cacheKey);
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json({ ok: true, ...cached.signal, cached: true });
  }

  try {
    const interval = IG_RES_TO_YAHOO_INTERVAL[cfg.resolution] ?? '1d';
    const range    = IG_RES_TO_YAHOO_RANGE[cfg.resolution] ?? '60d';
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}` +
      `?interval=${interval}&range=${range}&includePrePost=false`;

    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`Yahoo ${res.status}`);

    const raw = await res.json() as YahooChartRaw;
    if (raw.chart?.error) throw new Error('Yahoo returned an error for this symbol');
    const result = raw.chart?.result?.[0];
    if (!result) throw new Error('No chart data from Yahoo');

    const timestamps = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0] ?? {};
    const candles: Candle[] = timestamps.map((t, i) => ({
      time:   new Date(t * 1000).toISOString(),
      open:   q.open?.[i]   ?? 0,
      high:   q.high?.[i]   ?? 0,
      low:    q.low?.[i]    ?? 0,
      close:  q.close?.[i]  ?? 0,
      volume: q.volume?.[i] ?? 0,
    })).filter(c => c.close > 0);

    const signal = getSignal(timeframe, candles);
    cache.set(cacheKey, { signal, ts: Date.now() });
    return NextResponse.json({ ok: true, ...signal, cached: false });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

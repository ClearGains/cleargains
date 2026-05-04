/**
 * /api/market/history
 * Fetches 90-day daily OHLCV from Yahoo Finance for a given ticker symbol.
 * Cached 12h (daily bars don't change intraday).
 */
import { NextRequest, NextResponse } from 'next/server';
import type { Candle } from '@/lib/indicators';

const cache = new Map<string, { candles: Candle[]; expiresAt: number }>();
const CACHE_TTL = 12 * 60 * 60_000;

export async function GET(request: NextRequest) {
  try {
    const symbol = request.nextUrl.searchParams.get('symbol') ?? '';
    if (!symbol) {
      return NextResponse.json({ ok: false, error: 'symbol is required' }, { status: 400 });
    }

    const hit = cache.get(symbol);
    if (hit && hit.expiresAt > Date.now()) {
      return NextResponse.json({ ok: true, candles: hit.candles, cached: true });
    }

    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `Yahoo Finance error ${res.status}` }, { status: 502 });
    }

    const raw = await res.json() as {
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

    if (raw.chart?.error) {
      return NextResponse.json({ ok: false, error: raw.chart.error.description ?? 'Yahoo error' }, { status: 502 });
    }

    const result = raw.chart?.result?.[0];
    if (!result) {
      return NextResponse.json({ ok: false, error: 'No data returned' }, { status: 502 });
    }

    const timestamps = result.timestamp ?? [];
    const quote      = result.indicators?.quote?.[0] ?? {};
    const opens      = quote.open   ?? [];
    const highs      = quote.high   ?? [];
    const lows       = quote.low    ?? [];
    const closes     = quote.close  ?? [];
    const volumes    = quote.volume ?? [];

    const candles: Candle[] = timestamps
      .map((ts, i) => ({
        time:   new Date(ts * 1000).toISOString().slice(0, 10),
        open:   opens[i]   ?? 0,
        high:   highs[i]   ?? 0,
        low:    lows[i]    ?? 0,
        close:  closes[i]  ?? 0,
        volume: volumes[i] ?? 0,
      }))
      .filter(c => c.close > 0); // remove nulled candles

    cache.set(symbol, { candles, expiresAt: Date.now() + CACHE_TTL });
    return NextResponse.json({ ok: true, candles, cached: false });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

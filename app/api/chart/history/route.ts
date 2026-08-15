import { NextRequest, NextResponse } from 'next/server';
import { getYahooCrumb, yfHeaders } from '@/lib/yahooServer';

type Resolution = '5D' | '1M' | '3M' | '6M' | '1Y' | '2Y' | '5DH' | '10DH';

const RESOLUTION_MAP: Record<Resolution, { interval: string; range: string; intraday?: boolean }> = {
  '5D':  { interval: '1d',  range: '5d'  },
  '1M':  { interval: '1d',  range: '1mo' },
  '3M':  { interval: '1d',  range: '3mo' },
  '6M':  { interval: '1d',  range: '6mo' },
  '1Y':  { interval: '1d',  range: '1y'  },
  '2Y':  { interval: '1d',  range: '2y'  },
  // Intraday — for stock signal generation
  '5DH': { interval: '1h',  range: '5d',  intraday: true },  // 5-day hourly (~30–40 bars)
  '10DH':{ interval: '1h',  range: '10d', intraday: true },  // 10-day hourly (~60–80 bars)
};

type YahooRaw = {
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

export async function GET(req: NextRequest) {
  const symbol     = (req.nextUrl.searchParams.get('symbol') ?? '').toUpperCase().trim();
  const resolution = (req.nextUrl.searchParams.get('resolution') ?? '3M') as Resolution;

  if (!symbol) return NextResponse.json({ error: 'symbol is required' }, { status: 400 });

  const cfg = RESOLUTION_MAP[resolution] ?? RESOLUTION_MAP['3M'];
  const auth = await getYahooCrumb();

  const baseUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${cfg.interval}&range=${cfg.range}`;
  const url = auth?.crumb ? `${baseUrl}&crumb=${encodeURIComponent(auth.crumb)}` : baseUrl;

  try {
    const res = await fetch(url, { headers: yfHeaders(auth?.cookie) });

    if (!res.ok) {
      return NextResponse.json({ error: `Yahoo Finance returned HTTP ${res.status}` }, { status: 502 });
    }

    const raw = await res.json() as YahooRaw;

    if (raw.chart?.error) {
      const msg = raw.chart.error.description ?? 'Yahoo Finance error';
      return NextResponse.json({ error: msg }, { status: 404 });
    }

    const result = raw.chart?.result?.[0];
    if (!result?.timestamp?.length) {
      return NextResponse.json({ error: `No data found for "${symbol}" — check the ticker symbol` }, { status: 404 });
    }

    const timestamps = result.timestamp;
    const q = result.indicators?.quote?.[0] ?? {};

    const intraday = cfg.intraday ?? false;
    const candles = timestamps
      .map((ts, i) => ({
        // lightweight-charts only accepts a UTCTimestamp (seconds) or a strict
        // 'yyyy-mm-dd' string for Time — a "yyyy-mm-dd HH:MM" string silently
        // breaks the Candlestick series, so intraday bars use the raw epoch seconds.
        time: intraday ? ts : new Date(ts * 1000).toISOString().slice(0, 10),
        open:   q.open?.[i]   ?? 0,
        high:   q.high?.[i]   ?? 0,
        low:    q.low?.[i]    ?? 0,
        close:  q.close?.[i]  ?? 0,
        volume: q.volume?.[i] ?? 0,
      }))
      .filter(c => c.close > 0);

    // Shorter cache for intraday data
    const cacheHeader = intraday
      ? 's-maxage=300, stale-while-revalidate=120'
      : 's-maxage=60, stale-while-revalidate=300';

    return NextResponse.json({ symbol, resolution, candles }, {
      headers: { 'Cache-Control': cacheHeader },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

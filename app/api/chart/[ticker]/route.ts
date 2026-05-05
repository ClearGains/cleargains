import { NextRequest, NextResponse } from 'next/server';

type Params = { params: Promise<{ ticker: string }> };

type ResConfig = { endpoint: 'intraday' | 'daily'; interval?: string; timeseries: number };

const CONFIGS: Record<string, ResConfig> = {
  '1D': { endpoint: 'intraday', interval: '15min', timeseries: 96  },
  '1W': { endpoint: 'intraday', interval: '1hour', timeseries: 168 },
  '1M': { endpoint: 'daily',    timeseries: 30  },
  '3M': { endpoint: 'daily',    timeseries: 90  },
  '6M': { endpoint: 'daily',    timeseries: 180 },
  '1Y': { endpoint: 'daily',    timeseries: 365 },
};

type RawIntraday = { date: string; open: number; high: number; low: number; close: number; volume: number };
type RawDaily    = { date: string; open: number; high: number; low: number; close: number; volume: number };

export async function GET(req: NextRequest, { params }: Params) {
  const { ticker } = await params;
  const resolution = req.nextUrl.searchParams.get('resolution') ?? '3M';
  const key = process.env.FMP_API_KEY;
  if (!key) return NextResponse.json({ error: 'FMP_API_KEY not configured' }, { status: 500 });

  const cfg = CONFIGS[resolution] ?? CONFIGS['3M'];

  try {
    let url: string;
    if (cfg.endpoint === 'intraday') {
      url = `https://financialmodelingprep.com/api/v3/historical-chart/${cfg.interval}/${encodeURIComponent(ticker)}?limit=${cfg.timeseries}&apikey=${key}`;
    } else {
      url = `https://financialmodelingprep.com/api/v3/historical-price-full/${encodeURIComponent(ticker)}?timeseries=${cfg.timeseries}&apikey=${key}`;
    }

    const res = await fetch(url, { next: { revalidate: 60 } });
    if (!res.ok) return NextResponse.json({ error: `FMP ${res.status}` }, { status: 502 });
    const raw = await res.json() as RawIntraday[] | { historical?: RawDaily[] };

    type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number };

    let candles: Candle[];
    if (cfg.endpoint === 'intraday') {
      candles = (Array.isArray(raw) ? raw : [])
        .filter(c => c.close > 0)
        .map(c => ({ time: c.date.slice(0, 16), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 }))
        .reverse();
    } else {
      const daily = (raw as { historical?: RawDaily[] }).historical ?? [];
      candles = daily
        .filter(c => c.close > 0)
        .map(c => ({ time: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 }))
        .reverse();
    }

    return NextResponse.json({ ticker: ticker.toUpperCase(), resolution, candles });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

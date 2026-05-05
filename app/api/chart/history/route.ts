import { NextRequest, NextResponse } from 'next/server';

type Resolution = '5D' | '1M' | '3M' | '6M' | '1Y' | '2Y';

const RESOLUTION_MAP: Record<Resolution, { interval: string; range: string }> = {
  '5D': { interval: '1d', range: '5d'  },
  '1M': { interval: '1d', range: '1mo' },
  '3M': { interval: '1d', range: '3mo' },
  '6M': { interval: '1d', range: '6mo' },
  '1Y': { interval: '1d', range: '1y'  },
  '2Y': { interval: '1d', range: '2y'  },
};

// Realistic browser User-Agent — avoids Yahoo's bot detection
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Module-level crumb cache — reused across invocations of the same serverless instance
let crumbCache: { crumb: string; cookie: string; ts: number } | null = null;

async function getYahooCrumb(): Promise<{ crumb: string; cookie: string } | null> {
  if (crumbCache && Date.now() - crumbCache.ts < 30 * 60_000) return crumbCache;
  try {
    // Step 1: get A1 consent cookie from Yahoo's FC domain
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      redirect: 'manual',
    });
    const setCookie = r1.headers.get('set-cookie') ?? '';
    const a1Match  = setCookie.match(/A1=([^;]+)/);
    const cookie   = a1Match ? `A1=${a1Match[1]}` : '';

    // Step 2: exchange the cookie for a crumb string
    const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, Accept: 'text/plain', Cookie: cookie },
    });
    if (!r2.ok) return null;
    const crumb = (await r2.text()).trim();
    // Sanity-check: crumbs are short alphanumeric strings, not HTML pages
    if (!crumb || crumb.length > 30 || crumb.includes('<')) return null;

    crumbCache = { crumb, cookie, ts: Date.now() };
    return crumbCache;
  } catch {
    return null;
  }
}

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
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        ...(auth?.cookie ? { Cookie: auth.cookie } : {}),
      },
    });

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

    const candles = timestamps
      .map((ts, i) => ({
        time:   new Date(ts * 1000).toISOString().slice(0, 10),
        open:   q.open?.[i]   ?? 0,
        high:   q.high?.[i]   ?? 0,
        low:    q.low?.[i]    ?? 0,
        close:  q.close?.[i]  ?? 0,
        volume: q.volume?.[i] ?? 0,
      }))
      .filter(c => c.close > 0);

    return NextResponse.json({ symbol, resolution, candles }, {
      headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=300' },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

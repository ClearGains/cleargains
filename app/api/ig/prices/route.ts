import { NextRequest, NextResponse } from 'next/server';

/** Resolution → approximate interval mapping for labelling */
export type IGResolution =
  | 'MINUTE' | 'MINUTE_2' | 'MINUTE_3' | 'MINUTE_5'
  | 'MINUTE_10' | 'MINUTE_15' | 'MINUTE_30'
  | 'HOUR' | 'HOUR_2' | 'HOUR_3' | 'HOUR_4'
  | 'DAY' | 'WEEK' | 'MONTH';

const priceCache = new Map<string, { data: unknown; expiresAt: number }>();
const CACHE_TTL: Record<string, number> = {
  MINUTE: 30_000,
  MINUTE_5: 60_000,
  MINUTE_15: 2 * 60_000,
  HOUR: 5 * 60_000,
  DAY: 30 * 60_000,
};

function cacheTtl(resolution: string) {
  return CACHE_TTL[resolution] ?? 60_000;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const epic = searchParams.get('epic') ?? '';
    const resolution = (searchParams.get('resolution') ?? 'HOUR') as IGResolution;
    const max = parseInt(searchParams.get('max') ?? '100', 10);

    const cst = request.headers.get('x-ig-cst') ?? '';
    const securityToken = request.headers.get('x-ig-security-token') ?? '';
    const apiKey = request.headers.get('x-ig-api-key') ?? '';
    const env = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

    if (!epic) return NextResponse.json({ ok: false, error: 'epic is required' }, { status: 400 });
    if (!cst || !securityToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }

    const cacheKey = `${env}:${epic}:${resolution}:${max}`;
    const cached = priceCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return NextResponse.json({ ok: true, ...(cached.data as object) });
    }

    const baseUrl = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    // Version 3 endpoint: /prices/{epic}?resolution={res}&max={n}
    const url = `${baseUrl}/prices/${encodeURIComponent(epic)}?resolution=${resolution}&max=${max}&pageSize=${max}&pageNumber=1`;

    const res = await fetch(url, {
      headers: {
        'X-IG-API-KEY': apiKey,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
        'Accept': 'application/json; charset=UTF-8',
        'Version': '3',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      let errMsg = `IG API error ${res.status}`;
      try { const j = JSON.parse(text) as { errorCode?: string }; if (j.errorCode) errMsg = j.errorCode; } catch {}
      return NextResponse.json({ ok: false, error: errMsg }, { status: res.status });
    }

    const raw = await res.json() as {
      instrumentType?: string;
      allowance?: { remainingAllowance: number; totalAllowance: number; allowanceExpiry: number };
      prices?: Array<{
        snapshotTime: string;
        snapshotTimeUTC?: string;
        openPrice: { bid: number; ask: number; lastTraded: number | null };
        highPrice: { bid: number; ask: number; lastTraded: number | null };
        lowPrice:  { bid: number; ask: number; lastTraded: number | null };
        closePrice: { bid: number; ask: number; lastTraded: number | null };
        lastTradedVolume: number;
      }>;
    };

    // Normalise to simple OHLCV using mid-prices
    const candles = (raw.prices ?? []).map(p => ({
      time: p.snapshotTimeUTC ?? p.snapshotTime,
      open:  ((p.openPrice.bid  + p.openPrice.ask)  / 2),
      high:  ((p.highPrice.bid  + p.highPrice.ask)  / 2),
      low:   ((p.lowPrice.bid   + p.lowPrice.ask)   / 2),
      close: ((p.closePrice.bid + p.closePrice.ask) / 2),
      volume: p.lastTradedVolume,
    }));

    const payload = { candles, allowance: raw.allowance, instrumentType: raw.instrumentType };
    priceCache.set(cacheKey, { data: payload, expiresAt: Date.now() + cacheTtl(resolution) });

    return NextResponse.json({ ok: true, ...payload });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

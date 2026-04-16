import { NextRequest, NextResponse } from 'next/server';

/** Simple 5-minute cache for market search results */
const searchCache = new Map<string, { results: unknown[]; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const query = searchParams.get('q') ?? '';
    const cst = request.headers.get('x-ig-cst') ?? '';
    const securityToken = request.headers.get('x-ig-security-token') ?? '';
    const apiKey = request.headers.get('x-ig-api-key') ?? '';
    const env = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

    if (!query) {
      return NextResponse.json({ ok: false, error: 'q parameter is required' }, { status: 400 });
    }
    if (!cst || !securityToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }

    const cacheKey = `${env}:${query.toLowerCase()}`;
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return NextResponse.json({ ok: true, markets: cached.results });
    }

    const baseUrl = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    const res = await fetch(
      `${baseUrl}/markets?searchTerm=${encodeURIComponent(query)}`,
      {
        headers: {
          'X-IG-API-KEY': apiKey,
          'CST': cst,
          'X-SECURITY-TOKEN': securityToken,
          'Accept': 'application/json; charset=UTF-8',
          'Version': '1',
        },
      }
    );

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `IG API error ${res.status}` }, { status: res.status });
    }

    const data = await res.json() as { markets?: unknown[] };
    const markets = data.markets ?? [];
    searchCache.set(cacheKey, { results: markets, expiresAt: Date.now() + CACHE_TTL_MS });

    return NextResponse.json({ ok: true, markets });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

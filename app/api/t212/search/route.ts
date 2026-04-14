import { NextRequest, NextResponse } from 'next/server';

type FinnhubSearchResult = {
  description: string;
  displaySymbol: string;
  symbol: string;
  type: string;
};

/**
 * GET /api/t212/search?q=QUERY
 * Proxy to Finnhub symbol search — returns common stocks & ETFs.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q');
  if (!q || q.trim().length < 1) return NextResponse.json({ results: [], count: 0 });

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'FINNHUB_API_KEY not configured' }, { status: 503 });
  }

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q.trim())}&token=${apiKey}`,
      { signal: AbortSignal.timeout(5_000) }
    );
    if (!res.ok) return NextResponse.json({ results: [], count: 0 });

    const data = await res.json() as { count: number; result: FinnhubSearchResult[] };

    const ALLOWED_TYPES = new Set(['Common Stock', 'ETC', 'ETF', 'ADR']);
    const results = (data.result ?? [])
      .filter(r => ALLOWED_TYPES.has(r.type))
      .slice(0, 12)
      .map(r => {
        const isUK = r.symbol.endsWith('.L') || r.symbol.endsWith('.l');
        const t212Ticker = isUK
          ? `${r.symbol.replace(/\.l$/i, '')}_GB_EQ`
          : `${r.symbol}_US_EQ`;
        return {
          symbol: r.symbol.toUpperCase(),
          description: r.description,
          type: r.type,
          t212Ticker,
          isUK,
        };
      });

    return NextResponse.json({ results, count: results.length });
  } catch (err) {
    console.error('[t212/search]', err);
    return NextResponse.json({ results: [], count: 0, error: String(err) });
  }
}

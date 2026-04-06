import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const { symbols } = await request.json() as { symbols: string[] };
  const apiKey = process.env.FINNHUB_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: 'FINNHUB_API_KEY not configured.' }, { status: 503 });
  }

  if (!Array.isArray(symbols) || symbols.length === 0) {
    return NextResponse.json({ prices: {} });
  }

  const prices: Record<string, number> = {};

  // Fetch in parallel — Finnhub free tier allows 60 req/min
  await Promise.all(
    symbols.slice(0, 20).map(async (symbol) => {
      try {
        const res = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`,
          { signal: AbortSignal.timeout(5_000) }
        );
        if (!res.ok) return;
        const data = await res.json() as { c: number };
        if (data.c && data.c > 0) prices[symbol] = data.c;
      } catch {
        // Skip failed symbols
      }
    })
  );

  return NextResponse.json({ prices });
}

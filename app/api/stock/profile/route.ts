import { NextRequest, NextResponse } from 'next/server';

/** Fetch a UK LSE quote via Yahoo Finance. Returns null on failure. */
async function fetchYahooQuote(ticker: string): Promise<{ price: number; changePercent: number } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClearGains/1.0)', Accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; regularMarketChangePercent?: number } }> };
    };
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice || meta.regularMarketPrice <= 0) return null;
    return { price: meta.regularMarketPrice, changePercent: meta.regularMarketChangePercent ?? 0 };
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });

  const apiKey = process.env.FINNHUB_API_KEY;
  const isUK = symbol.endsWith('.L') || symbol.endsWith('.l');

  // ── UK LSE stocks: use Yahoo Finance for quotes (Finnhub free tier = 403) ──
  if (isUK) {
    const yahoo = await fetchYahooQuote(symbol);
    return NextResponse.json({
      symbol: symbol.toUpperCase(),
      name: null,       // Yahoo Finance chart API doesn't return company name
      exchange: 'LSE',
      industry: null,
      marketCap: null,
      logo: null,
      price: yahoo?.price ?? null,
      changePercent: yahoo?.changePercent ?? null,
      source: yahoo ? 'yahoo' : null,
      badge: yahoo ? '🇬🇧 LSE · 15min delay' : null,
    });
  }

  if (!apiKey) {
    console.error(
      '[stock/profile] FINNHUB_API_KEY is not set. ' +
      'Add it in Vercel Dashboard → Settings → Environment Variables. ' +
      'Visit /api/health to check all required env vars.'
    );
    return NextResponse.json(
      { error: 'FINNHUB_API_KEY is not configured on this server. See /api/health for diagnostics.' },
      { status: 503 }
    );
  }

  // ── US stocks: use Finnhub ──────────────────────────────────────────────────
  try {
    const [profileRes, quoteRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`, {
        signal: AbortSignal.timeout(5000),
        next: { revalidate: 86400 }, // cache 24h on server
      }),
      fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`, {
        signal: AbortSignal.timeout(5000),
      }),
    ]);

    const profile = profileRes.ok ? await profileRes.json() : {};
    const quote = quoteRes.ok ? await quoteRes.json() as { c: number; dp: number; pc: number } : null;

    return NextResponse.json({
      symbol: symbol.toUpperCase(),
      name: profile.name ?? null,
      exchange: profile.exchange ?? null,
      industry: profile.finnhubIndustry ?? null,
      marketCap: profile.marketCapitalization ?? null,
      logo: profile.logo ?? null,
      price: quote?.c ?? null,
      changePercent: quote?.dp ?? null,
    });
  } catch (err) {
    console.error('[stock/profile] Finnhub fetch error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });

  const apiKey = process.env.FINNHUB_API_KEY;
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

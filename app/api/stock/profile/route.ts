import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'FINNHUB_API_KEY not configured' }, { status: 503 });

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
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

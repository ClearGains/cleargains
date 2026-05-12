import { NextRequest, NextResponse } from 'next/server';
import { getYahooCrumb, yfHeaders } from '@/lib/yahooServer';

type RawQuote = {
  symbol: string;
  shortName?: string; longName?: string;
  regularMarketPrice?: number;
  bid?: number; ask?: number;
  regularMarketChangePercent?: number;
  regularMarketVolume?: number;
  marketCap?: number;
  fiftyTwoWeekHigh?: number; fiftyTwoWeekLow?: number;
  currency?: string; fullExchangeName?: string;
  averageDailyVolume3Month?: number;
  fiftyDayAverage?: number; twoHundredDayAverage?: number;
};

export async function GET(req: NextRequest) {
  const symbols = (req.nextUrl.searchParams.get('symbols') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) return NextResponse.json({ error: 'symbols required' }, { status: 400 });

  const auth = await getYahooCrumb();
  const batch = symbols.slice(0, 100).join(',');
  const baseUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(batch)}`;
  const url = auth?.crumb ? `${baseUrl}&crumb=${encodeURIComponent(auth.crumb)}` : baseUrl;

  try {
    const res = await fetch(url, { headers: yfHeaders(auth?.cookie) });
    if (!res.ok) return NextResponse.json({ error: `Yahoo ${res.status}` }, { status: 502 });

    const raw = await res.json() as { quoteResponse?: { result?: RawQuote[] } };
    const results = (raw.quoteResponse?.result ?? []).map(q => {
      const price  = q.regularMarketPrice ?? 0;
      const spread = price * 0.001;
      return {
        symbol:        q.symbol,
        name:          q.shortName ?? q.longName ?? q.symbol,
        price,
        bid:           q.bid ?? price - spread,
        ask:           q.ask ?? price + spread,
        changePercent: q.regularMarketChangePercent ?? 0,
        volume:        q.regularMarketVolume ?? 0,
        marketCap:     q.marketCap,
        week52High:    q.fiftyTwoWeekHigh,
        week52Low:     q.fiftyTwoWeekLow,
        currency:      q.currency ?? 'USD',
        exchange:      q.fullExchangeName ?? '',
        avgVolume3m:   q.averageDailyVolume3Month,
        sma50:         q.fiftyDayAverage,
        sma200:        q.twoHundredDayAverage,
      };
    });

    return NextResponse.json(results, {
      headers: { 'Cache-Control': 's-maxage=10, stale-while-revalidate=5' },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

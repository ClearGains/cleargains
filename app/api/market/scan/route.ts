/**
 * /api/market/scan
 * Batch quote fetch from Yahoo Finance. No IG connection needed.
 * Returns price, % change, bid, ask, volume, 52w range for each symbol.
 */
import { NextRequest, NextResponse } from 'next/server';

const cache = new Map<string, { data: QuoteResult[]; expiresAt: number }>();
const CACHE_TTL = 2 * 60_000; // 2 minutes

export type QuoteResult = {
  symbol:          string;
  name:            string;
  price:           number;
  bid:             number;
  ask:             number;
  changePercent:   number;
  volume:          number;
  marketCap?:      number;
  week52High?:     number;
  week52Low?:      number;
  currency:        string;
  exchange:        string;
};

type YahooQuote = {
  symbol:                        string;
  shortName?:                    string;
  longName?:                     string;
  regularMarketPrice?:           number;
  bid?:                          number;
  ask?:                          number;
  regularMarketChangePercent?:   number;
  regularMarketVolume?:          number;
  marketCap?:                    number;
  fiftyTwoWeekHigh?:             number;
  fiftyTwoWeekLow?:              number;
  currency?:                     string;
  fullExchangeName?:             string;
};

export async function POST(request: NextRequest) {
  try {
    const { symbols } = await request.json() as { symbols: string[] };
    if (!symbols?.length) {
      return NextResponse.json({ ok: false, error: 'symbols array is required' }, { status: 400 });
    }

    const key = symbols.sort().join(',');
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return NextResponse.json({ ok: true, quotes: hit.data });
    }

    const batch = symbols.slice(0, 50); // Yahoo caps at 50
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(batch.join(','))}`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `Yahoo Finance error ${res.status}` }, { status: 502 });
    }

    const raw = await res.json() as { quoteResponse?: { result?: YahooQuote[] } };
    const results: YahooQuote[] = raw.quoteResponse?.result ?? [];

    const quotes: QuoteResult[] = results.map(q => {
      const price = q.regularMarketPrice ?? 0;
      const spread = price * 0.001; // approx 0.1% spread
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
      };
    });

    cache.set(key, { data: quotes, expiresAt: Date.now() + CACHE_TTL });
    return NextResponse.json({ ok: true, quotes });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

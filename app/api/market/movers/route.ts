import { NextRequest, NextResponse } from 'next/server';
import { getYahooCrumb, yfHeaders } from '@/lib/yahooServer';

// Yahoo Finance predefined screener IDs
const SCREEN_IDS: Record<string, string> = {
  gainers: 'day_gainers',
  losers:  'day_losers',
  active:  'most_actives',
};

type RawQuote = {
  symbol: string;
  shortName?: string; longName?: string;
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  regularMarketVolume?: number;
  averageDailyVolume3Month?: number;
  marketCap?: number;
  fiftyTwoWeekHigh?: number; fiftyTwoWeekLow?: number;
  currency?: string; fullExchangeName?: string;
  regularMarketDayHigh?: number; regularMarketDayLow?: number;
  fiftyDayAverage?: number; twoHundredDayAverage?: number;
};

type ScreenerRaw = {
  finance?: {
    result?: Array<{ quotes?: RawQuote[] }>;
    error?: unknown;
  };
};

function mapQuote(q: RawQuote) {
  const price  = q.regularMarketPrice ?? 0;
  const w52h   = q.fiftyTwoWeekHigh ?? price;
  const w52l   = q.fiftyTwoWeekLow  ?? price;
  const avgVol = q.averageDailyVolume3Month ?? 1;
  const vol    = q.regularMarketVolume ?? 0;
  const sma50  = q.fiftyDayAverage ?? price;
  const sma200 = q.twoHundredDayAverage ?? price;

  return {
    symbol:        q.symbol,
    name:          q.shortName ?? q.longName ?? q.symbol,
    price,
    changePercent: q.regularMarketChangePercent ?? 0,
    volume:        vol,
    avgVolume:     avgVol,
    volumeRatio:   avgVol > 0 ? vol / avgVol : 1,
    marketCap:     q.marketCap,
    week52High:    w52h,
    week52Low:     w52l,
    fromHigh:      w52h > 0 ? ((price - w52h) / w52h) * 100 : 0,
    fromLow:       w52l > 0 ? ((price - w52l) / w52l) * 100 : 0,
    currency:      q.currency ?? 'USD',
    exchange:      q.fullExchangeName ?? '',
    dayHigh:       q.regularMarketDayHigh ?? price,
    dayLow:        q.regularMarketDayLow  ?? price,
    sma50,
    sma200,
    aboveSma50:    price > sma50,
    aboveSma200:   price > sma200,
    goldenCross:   sma50 > sma200,
  };
}

export type Mover = ReturnType<typeof mapQuote>;

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get('type') ?? 'gainers';
  const scrId = SCREEN_IDS[type] ?? SCREEN_IDS.gainers;

  const auth = await getYahooCrumb();
  const baseUrl = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=${scrId}&start=0`;
  const url = auth?.crumb ? `${baseUrl}&crumb=${encodeURIComponent(auth.crumb)}` : baseUrl;

  try {
    const res = await fetch(url, { headers: yfHeaders(auth?.cookie) });
    if (!res.ok) return NextResponse.json({ error: `Yahoo ${res.status}` }, { status: 502 });

    const raw = await res.json() as ScreenerRaw;
    if (raw.finance?.error) return NextResponse.json({ error: 'Yahoo screener error' }, { status: 502 });

    const quotes = raw.finance?.result?.[0]?.quotes ?? [];
    const movers = quotes.map(mapQuote);

    return NextResponse.json(movers, {
      headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=120' },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

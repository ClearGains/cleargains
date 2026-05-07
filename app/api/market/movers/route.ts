import { NextRequest, NextResponse } from 'next/server';
import { getYahooCrumb, yfHeaders } from '@/lib/yahooServer';
import { fetchFinnhubBatch } from '@/lib/finnhub';

export const dynamic = 'force-dynamic';

// Yahoo Finance predefined screener IDs
const SCREEN_IDS: Record<string, string> = {
  gainers: 'day_gainers',
  losers:  'day_losers',
  active:  'most_actives',
};

// Module-level cache — keyed by scrId, 20s TTL
// Prevents re-fetching Yahoo on every warm serverless instance within a
// frontend poll cycle (frontend polls every 30s, so 20s < 30s is safe).
const moverCache = new Map<string, { data: Mover[]; ts: number }>();
const MOVER_CACHE_TTL = 4_000;

type RawQuote = {
  symbol: string;
  shortName?: string; longName?: string;
  regularMarketPrice?: number;
  regularMarketPreviousClose?: number;
  regularMarketChangePercent?: number;
  regularMarketVolume?: number;
  averageDailyVolume3Month?: number;
  marketCap?: number;
  fiftyTwoWeekHigh?: number; fiftyTwoWeekLow?: number;
  currency?: string; fullExchangeName?: string;
  regularMarketDayHigh?: number; regularMarketDayLow?: number;
  fiftyDayAverage?: number; twoHundredDayAverage?: number;
  preMarketPrice?: number;
  preMarketChangePercent?: number;
  postMarketPrice?: number;
  postMarketChangePercent?: number;
  marketState?: string; // 'PRE' | 'REGULAR' | 'POST' | 'CLOSED'
};

type ScreenerRaw = {
  finance?: {
    result?: Array<{ quotes?: RawQuote[] }>;
    error?: unknown;
  };
};

type QuoteResponse = {
  quoteResponse?: {
    result?: RawQuote[];
    error?: unknown;
  };
};

function mapQuote(q: RawQuote, fhPrice?: number) {
  const closePrice = q.regularMarketPrice ?? 0;
  // Current price: Finnhub real-time > Yahoo extended hours fields > close
  const price =
    (fhPrice && fhPrice > 0)                        ? fhPrice           :
    q.marketState === 'REGULAR'                     ? closePrice        :
    (q.marketState === 'POST' && q.postMarketPrice) ? q.postMarketPrice :
    (q.marketState === 'PRE'  && q.preMarketPrice)  ? q.preMarketPrice  :
    (q.postMarketPrice ?? q.preMarketPrice ?? closePrice);

  const w52h   = q.fiftyTwoWeekHigh ?? closePrice;
  const w52l   = q.fiftyTwoWeekLow  ?? closePrice;
  const avgVol = q.averageDailyVolume3Month ?? 1;
  const vol    = q.regularMarketVolume ?? 0;
  const sma50  = q.fiftyDayAverage ?? closePrice;
  const sma200 = q.twoHundredDayAverage ?? closePrice;

  // At Close: Yahoo's regularMarketChangePercent directly (no computation)
  const changePercent: number = q.regularMarketChangePercent ?? 0;

  // Overnight: only shown outside regular session.
  // Use Finnhub real-time price first (most accurate), fall back to Yahoo fields.
  let extendedChangePercent: number | undefined;
  let extendedLabel: 'PRE' | 'POST' | undefined;
  if (q.marketState !== 'REGULAR') {
    const extPrice = (fhPrice && fhPrice > 0) ? fhPrice : (q.postMarketPrice ?? q.preMarketPrice);
    if (extPrice && closePrice > 0) {
      extendedChangePercent = ((extPrice - closePrice) / closePrice) * 100;
      extendedLabel = q.marketState === 'PRE' ? 'PRE' : 'POST';
    }
  }

  return {
    symbol:        q.symbol,
    name:          q.shortName ?? q.longName ?? q.symbol,
    price,
    closePrice,
    changePercent,
    extendedChangePercent,
    extendedLabel,
    volume:        vol,
    avgVolume:     avgVol,
    volumeRatio:   avgVol > 0 ? vol / avgVol : 1,
    marketCap:     q.marketCap,
    week52High:    w52h,
    week52Low:     w52l,
    fromHigh:      w52h > 0 ? ((closePrice - w52h) / w52h) * 100 : 0,
    fromLow:       w52l > 0 ? ((closePrice - w52l) / w52l) * 100 : 0,
    currency:      q.currency ?? 'USD',
    exchange:      q.fullExchangeName ?? '',
    dayHigh:       q.regularMarketDayHigh ?? closePrice,
    dayLow:        q.regularMarketDayLow  ?? closePrice,
    sma50,
    sma200,
    aboveSma50:    closePrice > sma50,
    aboveSma200:   closePrice > sma200,
    goldenCross:   sma50 > sma200,
    marketState:   q.marketState,
  };
}

export type Mover = ReturnType<typeof mapQuote>;

async function fetchLiveQuotes(
  symbols: string[],
  auth: { crumb: string; cookie: string } | null,
): Promise<Map<string, RawQuote>> {
  const joined  = encodeURIComponent(symbols.join(','));
  const baseUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${joined}`;
  const url     = auth?.crumb ? `${baseUrl}&crumb=${encodeURIComponent(auth.crumb)}` : baseUrl;

  const res = await fetch(url, { headers: yfHeaders(auth?.cookie) });
  if (!res.ok) throw new Error(`Yahoo quote ${res.status}`);

  const raw     = await res.json() as QuoteResponse;
  const results = raw.quoteResponse?.result ?? [];

  const map = new Map<string, RawQuote>();
  for (const q of results) map.set(q.symbol, q);
  return map;
}

export async function GET(req: NextRequest) {
  const type  = req.nextUrl.searchParams.get('type') ?? 'gainers';
  const scrId = SCREEN_IDS[type] ?? SCREEN_IDS.gainers;

  // ── Module-level cache check ─────────────────────────────────────────────
  const cached = moverCache.get(scrId);
  if (cached && Date.now() - cached.ts < MOVER_CACHE_TTL) {
    return NextResponse.json(cached.data, {
      headers: {
        'Cache-Control': 's-maxage=15, stale-while-revalidate=10',
        'X-Cache': 'HIT',
      },
    });
  }

  const auth = await getYahooCrumb();

  // ── Step 1: Screener — ranked symbol list ────────────────────────────────
  const screenerBase = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=${scrId}&start=0`;
  const screenerUrl  = auth?.crumb
    ? `${screenerBase}&crumb=${encodeURIComponent(auth.crumb)}`
    : screenerBase;

  try {
    const screenerRes = await fetch(screenerUrl, { headers: yfHeaders(auth?.cookie) });
    if (!screenerRes.ok) {
      return NextResponse.json({ error: `Yahoo screener ${screenerRes.status}` }, { status: 502 });
    }

    const screenerRaw = await screenerRes.json() as ScreenerRaw;
    if (screenerRaw.finance?.error) {
      return NextResponse.json({ error: 'Yahoo screener error' }, { status: 502 });
    }

    const screenerQuotes = screenerRaw.finance?.result?.[0]?.quotes ?? [];
    if (!screenerQuotes.length) {
      return NextResponse.json([], {
        headers: { 'Cache-Control': 's-maxage=15, stale-while-revalidate=10' },
      });
    }

    const symbols = screenerQuotes.map(q => q.symbol);

    // ── Step 2: Yahoo quote + Finnhub real-time price in parallel ────────
    let liveMap: Map<string, RawQuote>;
    let fhMap: Map<string, { c: number; pc: number; dp: number }>;
    try {
      [liveMap, fhMap] = await Promise.all([
        fetchLiveQuotes(symbols, auth),
        fetchFinnhubBatch(symbols),
      ]);
    } catch {
      // Quote step failed: fall back to screener data (stale but not an outage)
      const fallback = screenerQuotes.map(q => mapQuote(q));
      moverCache.set(scrId, { data: fallback, ts: Date.now() });
      return NextResponse.json(fallback, {
        headers: {
          'Cache-Control': 's-maxage=15, stale-while-revalidate=10',
          'X-Data-Source': 'screener-fallback',
        },
      });
    }

    // ── Step 3: Merge — screener rank, Yahoo metadata, Finnhub price ──────
    const movers = screenerQuotes.map(sq => {
      const raw = liveMap.get(sq.symbol) ?? sq;
      const fhPrice = fhMap.get(sq.symbol)?.c;
      return mapQuote(raw, fhPrice);
    });
    moverCache.set(scrId, { data: movers, ts: Date.now() });

    return NextResponse.json(movers, {
      headers: {
        'Cache-Control': 's-maxage=15, stale-while-revalidate=10',
        'X-Cache': 'MISS',
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

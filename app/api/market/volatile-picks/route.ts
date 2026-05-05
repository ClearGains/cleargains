import { NextRequest, NextResponse } from 'next/server';
import { getYahooCrumb, yfHeaders } from '@/lib/yahooServer';

const SCREENER_IDS = ['day_gainers', 'small_cap_gainers', 'most_actives'];

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
};

type ScreenerRaw = {
  finance?: {
    result?: Array<{ quotes?: RawQuote[] }>;
    error?: unknown;
  };
};

const cache = new Map<string, { data: VolatilePick[]; fetchedAt: number }>();
const CACHE_TTL = 30 * 60 * 1000;

export type VolatilePick = {
  symbol:          string;
  name:            string;
  price:           number;
  changePercent:   number;
  volume:          number;
  avgVolume:       number;
  volumeSurge:     number;
  dayRangePct:     number;
  dayHigh:         number;
  dayLow:          number;
  marketCap:       number | null;
  week52High:      number;
  week52Low:       number;
  fromLow:         number;
  currency:        string;
  exchange:        string;
  volatilityScore: number;
  signal:          'BREAKOUT' | 'MOMENTUM' | 'VOLUME_SPIKE' | 'RECOVERY';
  // Trade levels
  direction:       'BUY' | 'SELL';
  entry:           number;
  stopLoss:        number;
  takeProfit1:     number;
  takeProfit2:     number;
  stopPct:         number;  // stop distance as % of entry
  tp1Pct:          number;
  tp2Pct:          number;
  riskReward:      number;
};

function round(n: number, dp: number) {
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

function computeLevels(price: number, dayHigh: number, dayLow: number, changePercent: number, w52l: number, signal: VolatilePick['signal']) {
  // Direction: follow momentum
  const direction: 'BUY' | 'SELL' = changePercent >= 0 ? 'BUY' : 'SELL';

  // Stop distance = larger of: 60% of today's range, or 5% of price (penny stocks need room)
  const dayRange     = dayHigh - dayLow;
  const minStop      = price * 0.05;
  const stopDistance = Math.max(dayRange * 0.6, minStop);

  // For BREAKOUTs add a small buffer above current price as entry
  const entryBuffer  = signal === 'BREAKOUT' ? price * 0.005 : 0;
  const entry        = round(direction === 'BUY' ? price + entryBuffer : price - entryBuffer, price < 1 ? 4 : 2);

  // R multiples: 1.5R and 2.5R
  const tp1Distance  = stopDistance * 1.5;
  const tp2Distance  = stopDistance * 2.5;

  const stopLoss    = round(direction === 'BUY' ? entry - stopDistance  : entry + stopDistance,  price < 1 ? 4 : 2);
  const takeProfit1 = round(direction === 'BUY' ? entry + tp1Distance   : entry - tp1Distance,   price < 1 ? 4 : 2);
  const takeProfit2 = round(direction === 'BUY' ? entry + tp2Distance   : entry - tp2Distance,   price < 1 ? 4 : 2);

  // For BUY, ensure SL never drops below 52w low (use whichever is higher)
  const effectiveSL = direction === 'BUY' && w52l > 0
    ? Math.max(stopLoss, round(w52l * 0.98, price < 1 ? 4 : 2))
    : stopLoss;

  const actualStopDist = Math.abs(entry - effectiveSL);
  const riskReward     = actualStopDist > 0 ? round(tp1Distance / actualStopDist, 2) : 1.5;

  return {
    direction,
    entry,
    stopLoss:    effectiveSL,
    takeProfit1,
    takeProfit2,
    stopPct:     round((Math.abs(entry - effectiveSL) / entry) * 100, 2),
    tp1Pct:      round((Math.abs(takeProfit1 - entry) / entry) * 100, 2),
    tp2Pct:      round((Math.abs(takeProfit2 - entry) / entry) * 100, 2),
    riskReward,
  };
}

function scoreQuote(q: RawQuote): VolatilePick | null {
  const price    = q.regularMarketPrice ?? 0;
  const change   = q.regularMarketChangePercent ?? 0;
  const vol      = q.regularMarketVolume ?? 0;
  const avgVol   = q.averageDailyVolume3Month ?? 1;
  const dayHigh  = q.regularMarketDayHigh ?? price;
  const dayLow   = q.regularMarketDayLow  ?? price;
  const w52h     = q.fiftyTwoWeekHigh ?? price;
  const w52l     = q.fiftyTwoWeekLow  ?? price;
  const isGBp    = q.currency === 'GBp';

  if (isGBp ? price >= 500 : price >= 5) return null;
  if (price <= 0) return null;
  if (vol < 100_000) return null;

  const volumeSurge  = avgVol > 0 ? vol / avgVol : 1;
  const dayRangePct  = price > 0 ? ((dayHigh - dayLow) / price) * 100 : 0;
  const fromLow      = w52l > 0 ? ((price - w52l) / w52l) * 100 : 0;
  const changeAbs    = Math.abs(change);

  const volatilityScore = Math.round(
    Math.min(changeAbs / 30, 1)        * 40 +
    Math.min(dayRangePct / 20, 1)      * 20 +
    Math.min((volumeSurge - 1) / 9, 1) * 25 +
    (fromLow > 0 && fromLow < 100 ? 15 : 0)
  );

  let signal: VolatilePick['signal'] = 'MOMENTUM';
  if (volumeSurge >= 5 && changeAbs >= 15) signal = 'BREAKOUT';
  else if (volumeSurge >= 3)               signal = 'VOLUME_SPIKE';
  else if (fromLow < 50 && change > 5)     signal = 'RECOVERY';

  const levels = computeLevels(price, dayHigh, dayLow, change, w52l, signal);

  return {
    symbol: q.symbol,
    name:   q.shortName ?? q.longName ?? q.symbol,
    price, changePercent: change, volume: vol, avgVolume: avgVol,
    volumeSurge, dayRangePct, dayHigh, dayLow,
    marketCap: q.marketCap ?? null,
    week52High: w52h, week52Low: w52l, fromLow,
    currency: q.currency ?? 'USD', exchange: q.fullExchangeName ?? '',
    volatilityScore, signal,
    ...levels,
  };
}

export async function GET(req: NextRequest) {
  const market   = (req.nextUrl.searchParams.get('market') ?? 'US') as 'US' | 'UK';
  const hourKey  = new Date().toISOString().slice(0, 13);
  const cacheKey = `${market}-${hourKey}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  const auth  = await getYahooCrumb();
  const picks: VolatilePick[] = [];
  const seen  = new Set<string>();

  for (const scrId of SCREENER_IDS) {
    try {
      const base = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=50&scrIds=${scrId}&start=0`;
      const url  = auth?.crumb ? `${base}&crumb=${encodeURIComponent(auth.crumb)}` : base;
      const res  = await fetch(url, { headers: yfHeaders(auth?.cookie) });
      if (!res.ok) continue;
      const raw    = await res.json() as ScreenerRaw;
      const quotes = raw.finance?.result?.[0]?.quotes ?? [];
      for (const q of quotes) {
        if (seen.has(q.symbol)) continue;
        seen.add(q.symbol);
        const pick = scoreQuote(q);
        if (pick) picks.push(pick);
      }
    } catch { /* skip screener on error */ }
  }

  picks.sort((a, b) => b.volatilityScore - a.volatilityScore);
  const top = picks.slice(0, 25);

  cache.set(cacheKey, { data: top, fetchedAt: Date.now() });
  for (const [k] of cache) if (k !== cacheKey) cache.delete(k);

  return NextResponse.json(top, {
    headers: { 'Cache-Control': 's-maxage=1800, stale-while-revalidate=600' },
  });
}

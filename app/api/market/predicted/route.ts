import { NextRequest, NextResponse } from 'next/server';
import { getYahooCrumb, yfHeaders } from '@/lib/yahooServer';
import { fetchFinnhubBatch } from '@/lib/finnhub';
import type { Mover } from '../movers/route';

export const revalidate = 0;

// Base universe — supplemented at runtime by live screener symbols
const US_UNIVERSE = [
  'AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','NFLX','PLTR',
  'COIN','RIVN','SNAP','SOFI','HOOD','UBER','LYFT','NIO','F','BAC',
  'SNDL','TLRY','MMAT','NKLA','CLOV','SPCE','SKLZ','CHPT','EVGO','LCID',
  'SPY','QQQ','IWM','XOM','CVX','JPM','GS','INTC','MU','QCOM',
  'IONQ','RXRX','OPEN','DKNG','RBLX','PARA','WKHS','BLNK','GME','AMC',
  'BBBY','WISH','CLOV','RIDE','GOEV','HYZN','PTRA','ARVL','SBE','GREE',
];
const UK_UNIVERSE = [
  'LLOY.L','BARC.L','VOD.L','BP.L','SHEL.L','AZN.L','GSK.L','HSBA.L',
  'RR.L','NWG.L','BT-A.L','IAG.L','EZJ.L','MKS.L','JD.L','BOO.L',
  'OCDO.L','ITV.L','SBRY.L','DGE.L','STAN.L','WPP.L','RKT.L','LAND.L',
];

// Yahoo screener IDs to pull live hot stocks into the universe
const US_SCREENERS = ['day_gainers', 'most_actives', 'small_cap_gainers'];

type Signal = 'STRONG_BUY' | 'BUY' | 'WATCH' | 'SELL' | 'STRONG_SELL';

export type PredictedMover = Mover & {
  signal: Signal;
  signalReasons: string[];
  score: number;
  scannedAt: string;
  // Pre-market / post-market extras
  preMarketChangePercent?: number;
  preMarketPrice?: number;
  marketState?: string; // 'PRE' | 'REGULAR' | 'POST' | 'CLOSED'
};

function scoreQuote(q: Mover): { signal: Signal; signalReasons: string[]; score: number } {
  const reasons: string[] = [];
  let score = 0;

  // Total effective move from yesterday's close, including overnight/extended hours.
  // This is the actual price change an investor faces when entering a position.
  const overnight = q.extendedChangePercent ?? 0;
  const totalChange = q.changePercent + overnight;

  if (q.volumeRatio > 3)        { score += 3; reasons.push(`Volume ${q.volumeRatio.toFixed(1)}× average`); }
  else if (q.volumeRatio > 2)   { score += 2; reasons.push(`Volume ${q.volumeRatio.toFixed(1)}× average`); }
  else if (q.volumeRatio > 1.5) { score += 1; reasons.push(`Volume elevated ${q.volumeRatio.toFixed(1)}×`); }

  if (q.fromLow < 5)             { score += 3; reasons.push('Near 52-week low — bounce zone'); }
  else if (q.fromLow < 10)       { score += 1; reasons.push('Within 10% of 52-week low'); }

  if (q.fromHigh > -3)           { score += 2; reasons.push('At/near 52-week high — momentum'); }
  else if (q.fromHigh > -8)      { score += 1; reasons.push('Near 52-week high'); }

  if (q.goldenCross && q.aboveSma50)   { score += 2; reasons.push('Golden cross + above SMA50'); }
  if (!q.goldenCross && !q.aboveSma50) { score -= 2; reasons.push('Death cross + below SMA50'); }

  // Momentum — upside: reward moderate moves, penalise stocks that have already run hard.
  // A stock up 15%+ has likely made its move — buying at that point is chasing, not investing.
  if (totalChange > 15)       { score -= 2; reasons.push(`Already up ${totalChange.toFixed(1)}% — chasing risk, move likely priced in`); }
  else if (totalChange > 10)  { score -= 1; reasons.push(`Up ${totalChange.toFixed(1)}% — stretched entry, limited upside`); }
  else if (totalChange > 5)   { score += 2; reasons.push(`Up ${totalChange.toFixed(1)}% momentum`); }
  else if (totalChange > 3)   { score += 1; reasons.push(`Up ${totalChange.toFixed(1)}% from yesterday`); }

  // Momentum — downside: oversold bounce candidates.
  // Very large drops (>15%) get less credit — could be fundamental, not just a dip.
  if (totalChange < -15)      { score += 1; reasons.push(`Sharp drop ${Math.abs(totalChange).toFixed(1)}% — oversold, bounce possible`); }
  else if (totalChange < -5)  { score += 2; reasons.push(`Down ${Math.abs(totalChange).toFixed(1)}% — oversold bounce candidate`); }
  else if (totalChange < -3)  { score += 1; reasons.push(`Down ${Math.abs(totalChange).toFixed(1)}% from yesterday`); }

  // Overnight risk: penalise stocks that have already moved significantly in
  // extended hours — entering at open would be at a much higher price than close
  if (overnight > 15)         { score -= 4; reasons.push(`Already +${overnight.toFixed(1)}% overnight — entry price far above close`); }
  else if (overnight > 8)     { score -= 3; reasons.push(`Already +${overnight.toFixed(1)}% overnight — elevated entry risk`); }
  else if (overnight > 4)     { score -= 1; reasons.push(`Up ${overnight.toFixed(1)}% overnight — check entry price`); }
  else if (overnight < -8)    { score -= 1; reasons.push(`Down ${Math.abs(overnight).toFixed(1)}% overnight — gap down risk`); }

  if (q.fromHigh < -40) { score -= 2; reasons.push('Far from 52-week high (>40%)'); }
  if (!q.aboveSma200)   score -= 1;

  const signal: Signal =
    score >= 6  ? 'STRONG_BUY'  :
    score >= 3  ? 'BUY'         :
    score <= -4 ? 'STRONG_SELL' :
    score <= -2 ? 'SELL'        : 'WATCH';

  return { signal, signalReasons: reasons.slice(0, 5), score };
}

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
  marketState?: string;
};

// Module-level cache — 60s TTL. force=1 bypasses it for manual refresh.
const MODULE_CACHE_TTL = 60_000;
const scanCache = new Map<string, { data: PredictedMover[]; ts: number }>();

// Pull additional hot-stock symbols from Yahoo screeners
async function fetchScreenerSymbols(
  scrId: string,
  auth: { crumb: string; cookie: string } | null,
): Promise<string[]> {
  const base = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=25&scrIds=${scrId}&start=0`;
  const url  = auth?.crumb ? `${base}&crumb=${encodeURIComponent(auth.crumb)}` : base;
  try {
    const res = await fetch(url, { headers: yfHeaders(auth?.cookie) });
    if (!res.ok) return [];
    const raw = await res.json() as {
      finance?: { result?: Array<{ quotes?: Array<{ symbol: string }> }> };
    };
    return raw.finance?.result?.[0]?.quotes?.map(q => q.symbol) ?? [];
  } catch {
    return [];
  }
}

async function fetchAndScore(universe: string[], market: string): Promise<PredictedMover[]> {
  const auth = await getYahooCrumb();

  // For US: expand universe with live screener symbols in parallel
  let dynamicSymbols: string[] = [];
  if (market === 'US') {
    const results = await Promise.all(
      US_SCREENERS.map(scrId => fetchScreenerSymbols(scrId, auth))
    );
    dynamicSymbols = results.flat();
  }

  // Merge fixed + dynamic, deduplicate, cap at 100 (Yahoo quote limit)
  const allSymbols = [...new Set([...universe, ...dynamicSymbols])].slice(0, 100);

  const baseUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(allSymbols.join(','))}`;
  const url = auth?.crumb ? `${baseUrl}&crumb=${encodeURIComponent(auth.crumb)}` : baseUrl;

  // Fetch Yahoo quotes + Finnhub real-time prices in parallel (US only; UK free tier is limited)
  const [res, fhMap] = await Promise.all([
    fetch(url, { headers: yfHeaders(auth?.cookie) }),
    market === 'US' ? fetchFinnhubBatch(allSymbols, 50) : Promise.resolve(new Map<string, { c: number; pc: number; dp: number }>()),
  ]);
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);

  const raw = await res.json() as { quoteResponse?: { result?: RawQuote[] } };
  const quotes = raw.quoteResponse?.result ?? [];
  const scannedAt = new Date().toISOString();

  const predicted: PredictedMover[] = quotes.map(q => {
    const closePrice = q.regularMarketPrice ?? 0;
    const w52h   = q.fiftyTwoWeekHigh ?? closePrice;
    const w52l   = q.fiftyTwoWeekLow  ?? closePrice;
    const avgVol = q.averageDailyVolume3Month ?? 1;
    const vol    = q.regularMarketVolume ?? 0;
    const sma50  = q.fiftyDayAverage ?? closePrice;
    const sma200 = q.twoHundredDayAverage ?? closePrice;

    // For scoring: use pre-market % during PRE state, otherwise regular session %
    const effectiveChange =
      q.marketState === 'PRE' && q.preMarketChangePercent != null
        ? q.preMarketChangePercent
        : (q.regularMarketChangePercent ?? 0);

    const fhPrice = fhMap.get(q.symbol)?.c;
    // Current price: Finnhub real-time > Yahoo extended hours > close
    const currentPrice =
      (fhPrice && fhPrice > 0)                        ? fhPrice           :
      q.marketState === 'REGULAR'                     ? closePrice        :
      (q.marketState === 'POST' && q.postMarketPrice) ? q.postMarketPrice :
      (q.marketState === 'PRE'  && q.preMarketPrice)  ? q.preMarketPrice  :
      (q.postMarketPrice ?? q.preMarketPrice ?? closePrice);

    const base: Mover = {
      symbol:        q.symbol,
      name:          q.shortName ?? q.longName ?? q.symbol,
      price:         currentPrice,
      closePrice,
      changePercent: effectiveChange,
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
      aboveSma50:            closePrice > sma50,
      aboveSma200:           closePrice > sma200,
      goldenCross:           sma50 > sma200,
      marketState:           q.marketState,
      extendedChangePercent: (() => {
        if (q.marketState === 'REGULAR') return undefined;
        const ext = (fhPrice && fhPrice > 0) ? fhPrice : (q.postMarketPrice ?? q.preMarketPrice);
        return ext && closePrice > 0 ? ((ext - closePrice) / closePrice) * 100 : undefined;
      })(),
      extendedLabel: (() => {
        if (q.marketState === 'REGULAR') return undefined;
        return (q.marketState === 'PRE' ? 'PRE' : 'POST') as 'PRE' | 'POST';
      })(),
    };

    return {
      ...base,
      ...scoreQuote(base),
      scannedAt,
      preMarketChangePercent: q.preMarketChangePercent,
      preMarketPrice:         q.preMarketPrice,
      marketState:            q.marketState,
    };
  });

  predicted.sort((a, b) => b.score - a.score);
  return predicted;
}

export async function GET(req: NextRequest) {
  const market = (req.nextUrl.searchParams.get('market') ?? 'US').toUpperCase();
  const force  = req.nextUrl.searchParams.get('force') === '1';

  const universe = market === 'UK' ? UK_UNIVERSE : US_UNIVERSE;
  const key      = market;

  const cached = scanCache.get(key);
  if (!force && cached && Date.now() - cached.ts < MODULE_CACHE_TTL) {
    return NextResponse.json(cached.data, {
      headers: {
        'Cache-Control': 'no-store',
        'X-Cache': 'HIT',
        'X-Data-Age': String(Math.round((Date.now() - cached.ts) / 1000)) + 's',
      },
    });
  }

  try {
    const predicted = await fetchAndScore(universe, market);
    scanCache.set(key, { data: predicted, ts: Date.now() });

    return NextResponse.json(predicted, {
      headers: { 'Cache-Control': 'no-store', 'X-Cache': 'MISS' },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

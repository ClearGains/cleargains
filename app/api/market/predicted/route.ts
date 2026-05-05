import { NextRequest, NextResponse } from 'next/server';
import { getYahooCrumb, yfHeaders } from '@/lib/yahooServer';
import type { Mover } from '../movers/route';

// Curated universe for prediction scanning
const US_UNIVERSE = [
  'AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','NFLX','PLTR',
  'COIN','RIVN','SNAP','SOFI','HOOD','UBER','LYFT','NIO','F','BAC',
  'SNDL','TLRY','MMAT','NKLA','CLOV','SPCE','SKLZ','CHPT','EVGO','LCID',
  'SPY','QQQ','IWM','XOM','CVX','JPM','GS','INTC','MU','QCOM',
];
const UK_UNIVERSE = [
  'LLOY.L','BARC.L','VOD.L','BP.L','SHEL.L','AZN.L','GSK.L','HSBA.L',
  'RR.L','NWG.L','BT-A.L','IAG.L','EZJ.L','MKS.L','JD.L','BOO.L',
  'OCDO.L','ITV.L','SBRY.L','DGE.L','STAN.L','WPP.L','RKT.L','LAND.L',
];

type Signal = 'STRONG_BUY' | 'BUY' | 'WATCH' | 'SELL' | 'STRONG_SELL';

export type PredictedMover = Mover & {
  signal: Signal;
  signalReasons: string[];
  score: number;
};

function scoreQuote(q: Mover): { signal: Signal; signalReasons: string[]; score: number } {
  const reasons: string[] = [];
  let score = 0;

  // Volume spike — unusual interest
  if (q.volumeRatio > 3)       { score += 3; reasons.push(`Volume ${q.volumeRatio.toFixed(1)}× average`); }
  else if (q.volumeRatio > 2)  { score += 2; reasons.push(`Volume ${q.volumeRatio.toFixed(1)}× average`); }
  else if (q.volumeRatio > 1.5){ score += 1; reasons.push(`Volume elevated ${q.volumeRatio.toFixed(1)}×`); }

  // Near 52-week low → bounce candidate
  if (q.fromLow < 5)            { score += 3; reasons.push('Near 52-week low — bounce zone'); }
  else if (q.fromLow < 10)      { score += 1; reasons.push('Within 10% of 52-week low'); }

  // Near 52-week high → momentum
  if (q.fromHigh > -3)          { score += 2; reasons.push('At/near 52-week high — momentum'); }
  else if (q.fromHigh > -8)     { score += 1; reasons.push('Near 52-week high'); }

  // SMA structure
  if (q.goldenCross && q.aboveSma50)  { score += 2; reasons.push('Golden cross + above SMA50'); }
  if (!q.goldenCross && !q.aboveSma50){ score -= 2; reasons.push('Death cross + below SMA50'); }

  // Oversold today → bounce potential
  if (q.changePercent < -5)    { score += 2; reasons.push(`Down ${Math.abs(q.changePercent).toFixed(1)}% — oversold bounce`); }
  else if (q.changePercent < -3){ score += 1; reasons.push(`Down ${Math.abs(q.changePercent).toFixed(1)}% today`); }

  // Strong up day → momentum continuation
  if (q.changePercent > 5)     { score += 2; reasons.push(`Up ${q.changePercent.toFixed(1)}% — momentum`); }
  else if (q.changePercent > 3) { score += 1; reasons.push(`Up ${q.changePercent.toFixed(1)}% today`); }

  // Bearish signals (reduce score)
  if (q.fromHigh < -40)         { score -= 2; reasons.push('Far from 52-week high (>40%)'); }
  if (!q.aboveSma200)           score -= 1;

  const signal: Signal =
    score >= 6  ? 'STRONG_BUY'  :
    score >= 3  ? 'BUY'         :
    score <= -4 ? 'STRONG_SELL' :
    score <= -2 ? 'SELL'        : 'WATCH';

  return { signal, signalReasons: reasons.slice(0, 4), score };
}

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

export async function GET(req: NextRequest) {
  const market = (req.nextUrl.searchParams.get('market') ?? 'US').toUpperCase();
  const universe = market === 'UK' ? UK_UNIVERSE : US_UNIVERSE;

  const auth = await getYahooCrumb();
  const baseUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(universe.join(','))}`;
  const url = auth?.crumb ? `${baseUrl}&crumb=${encodeURIComponent(auth.crumb)}` : baseUrl;

  try {
    const res = await fetch(url, { headers: yfHeaders(auth?.cookie) });
    if (!res.ok) return NextResponse.json({ error: `Yahoo ${res.status}` }, { status: 502 });

    const raw = await res.json() as { quoteResponse?: { result?: RawQuote[] } };
    const quotes = raw.quoteResponse?.result ?? [];

    const predicted: PredictedMover[] = quotes.map(q => {
      const price  = q.regularMarketPrice ?? 0;
      const w52h   = q.fiftyTwoWeekHigh ?? price;
      const w52l   = q.fiftyTwoWeekLow  ?? price;
      const avgVol = q.averageDailyVolume3Month ?? 1;
      const vol    = q.regularMarketVolume ?? 0;
      const sma50  = q.fiftyDayAverage ?? price;
      const sma200 = q.twoHundredDayAverage ?? price;

      const base: Mover = {
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

      return { ...base, ...scoreQuote(base) };
    });

    // Sort: highest score first, but separate strong signals at top
    predicted.sort((a, b) => b.score - a.score);

    return NextResponse.json(predicted, {
      headers: { 'Cache-Control': 's-maxage=120, stale-while-revalidate=300' },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

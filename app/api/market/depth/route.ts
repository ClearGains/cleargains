import { NextRequest, NextResponse } from 'next/server';
import { getYahooCrumb, yfHeaders } from '@/lib/yahooServer';
import { calcSupportResistance } from '@/lib/supportResistance';
import type { LWCandle } from '@/lib/chartIndicators';

export const revalidate = 0;

const depthCache = new Map<string, { data: DepthData; ts: number }>();
const DEPTH_TTL  = 30_000; // 30s — live enough for order book context

export type SRLevel = {
  price:    number;
  type:     'support' | 'resistance';
  strength: number;
  note:     string;
};

export type DepthData = {
  symbol:        string;
  name:          string;
  price:         number;
  changePercent: number;
  currency:      string;
  exchange:      string;
  // L1 order book (best bid / best ask)
  bid:           number | null;
  ask:           number | null;
  bidSize:       number | null;   // in shares (bidSize × 100 for US lots)
  askSize:       number | null;
  spread:        number | null;
  spreadPct:     number | null;
  // Options: today's directional bets (US stocks only)
  callVolume:    number | null;
  putVolume:     number | null;
  callOI:        number | null;
  putOI:         number | null;
  putCallRatio:  number | null;
  nearestExpiry: string | null;
  // Price levels
  levels:        SRLevel[];
  scannedAt:     string;
};

type RawContract = { strike: number; volume?: number | null; openInterest?: number | null };
type RawExpiry   = { expirationDate: number; calls: RawContract[]; puts: RawContract[] };

type QuoteFields = {
  symbol: string;
  shortName?: string; longName?: string;
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  bid?: number; ask?: number; bidSize?: number; askSize?: number;
  currency?: string; fullExchangeName?: string;
  fiftyTwoWeekHigh?: number; fiftyTwoWeekLow?: number;
  fiftyDayAverage?: number; twoHundredDayAverage?: number;
  regularMarketDayHigh?: number; regularMarketDayLow?: number;
};

type OptionsResponse = {
  optionChain?: {
    result?: Array<{
      quote:   QuoteFields;
      options: RawExpiry[];
    }>;
  };
};

type ChartResponse = {
  chart?: {
    result?: Array<{
      indicators?: {
        quote?: Array<{
          open:  (number|null)[];
          high:  (number|null)[];
          low:   (number|null)[];
          close: (number|null)[];
        }>;
      };
    }>;
  };
};

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get('symbol') ?? '').toUpperCase().trim();
  const force  = req.nextUrl.searchParams.get('force') === '1';

  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });

  const cached = depthCache.get(symbol);
  if (!force && cached && Date.now() - cached.ts < DEPTH_TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    const auth = await getYahooCrumb();
    const q    = auth?.crumb ? `&crumb=${encodeURIComponent(auth.crumb)}` : '';
    const hdrs = yfHeaders(auth?.cookie);

    // Fetch options (includes L1 quote) + 6-month chart in parallel
    const [optRes, chartRes] = await Promise.allSettled([
      fetch(`https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}?lang=en-US&region=US${q}`, {
        headers: hdrs, signal: AbortSignal.timeout(10_000),
      }),
      fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=6mo${q}`, {
        headers: hdrs, signal: AbortSignal.timeout(10_000),
      }),
    ]);

    const scannedAt = new Date().toISOString();

    // Parse options data
    let quote:   QuoteFields | null = null;
    let callVol: number | null = null;
    let putVol:  number | null = null;
    let callOI:  number | null = null;
    let putOI:   number | null = null;
    let nearestExpiry: string | null = null;

    if (optRes.status === 'fulfilled' && optRes.value.ok) {
      const raw = await optRes.value.json() as OptionsResponse;
      const r   = raw.optionChain?.result?.[0];
      if (r) {
        quote = r.quote;
        // Sum across nearest 3 expiries for "current bets"
        const near = r.options.slice(0, 3);
        let cv = 0, pv = 0, co = 0, po = 0;
        for (const exp of near) {
          for (const c of exp.calls) { cv += c.volume ?? 0; co += c.openInterest ?? 0; }
          for (const p of exp.puts)  { pv += p.volume ?? 0; po += p.openInterest ?? 0; }
        }
        if (cv + pv > 0) { callVol = cv; putVol = pv; }
        if (co + po > 0) { callOI = co;  putOI = po;  }
        if (near[0]?.expirationDate) {
          nearestExpiry = new Date(near[0].expirationDate * 1000)
            .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        }
      }
    }

    if (!quote) return NextResponse.json({ error: `No data found for ${symbol}` }, { status: 404 });

    const price     = quote.regularMarketPrice ?? 0;
    const bid       = quote.bid ?? null;
    const ask       = quote.ask ?? null;
    const spread    = bid != null && ask != null ? +(ask - bid).toFixed(4) : null;
    const spreadPct = spread != null && price > 0 ? +((spread / price) * 100).toFixed(3) : null;
    const pcr       = callVol != null && putVol != null && callVol > 0
      ? +(putVol / callVol).toFixed(2) : null;

    // Build price levels: named (SMA, 52wk) + pivot-based S/R from chart
    const levels: SRLevel[] = [];

    const addLevel = (lPrice: number, type: 'support'|'resistance', strength: number, note: string) => {
      if (!lPrice || lPrice <= 0) return;
      if (!levels.some(l => Math.abs(l.price - lPrice) / lPrice < 0.003)) {
        levels.push({ price: lPrice, type, strength, note });
      }
    };

    if (quote.fiftyTwoWeekHigh)
      addLevel(quote.fiftyTwoWeekHigh, 'resistance', 5, '52-week high — strongest sell zone');
    if (quote.fiftyTwoWeekLow)
      addLevel(quote.fiftyTwoWeekLow,  'support',    5, '52-week low — strongest buy zone');
    if (quote.twoHundredDayAverage)
      addLevel(quote.twoHundredDayAverage,
        quote.twoHundredDayAverage < price ? 'support' : 'resistance', 4,
        quote.twoHundredDayAverage < price ? 'SMA200 — long-term dynamic support' : 'SMA200 — long-term resistance');
    if (quote.fiftyDayAverage)
      addLevel(quote.fiftyDayAverage,
        quote.fiftyDayAverage < price ? 'support' : 'resistance', 3,
        quote.fiftyDayAverage < price ? 'SMA50 — medium-term support' : 'SMA50 — medium-term resistance');
    if (quote.regularMarketDayHigh && quote.regularMarketDayHigh > price)
      addLevel(quote.regularMarketDayHigh, 'resistance', 1, "Today's session high — intraday resistance");
    if (quote.regularMarketDayLow && quote.regularMarketDayLow < price)
      addLevel(quote.regularMarketDayLow, 'support', 1, "Today's session low — intraday support");

    // Pivot-based levels from chart data
    if (chartRes.status === 'fulfilled' && chartRes.value.ok) {
      const raw = await chartRes.value.json() as ChartResponse;
      const qd  = raw.chart?.result?.[0]?.indicators?.quote?.[0];
      if (qd) {
        const candles: LWCandle[] = [];
        for (let i = 0; i < (qd.close?.length ?? 0); i++) {
          const c = qd.close?.[i], h = qd.high?.[i], l = qd.low?.[i], o = qd.open?.[i];
          if (c != null && h != null && l != null && o != null && c > 0)
            candles.push({ time: i, open: o, high: h, low: l, close: c });
        }
        if (candles.length >= 10) {
          for (const z of calcSupportResistance(candles, 60, 2, 0.01)) {
            addLevel(z.price, z.type, z.strength,
              z.type === 'resistance'
                ? `Resistance zone (${z.strength} price touches) — sellers have appeared here`
                : `Support zone (${z.strength} price touches) — buyers have stepped in here`);
          }
        }
      }
    }

    levels.sort((a, b) => b.strength - a.strength || b.price - a.price);

    const data: DepthData = {
      symbol,
      name:          quote.shortName ?? quote.longName ?? symbol,
      price,
      changePercent: quote.regularMarketChangePercent ?? 0,
      currency:      quote.currency ?? 'USD',
      exchange:      quote.fullExchangeName ?? '',
      bid, ask,
      bidSize:  quote.bidSize != null ? quote.bidSize * 100 : null,
      askSize:  quote.askSize != null ? quote.askSize * 100 : null,
      spread,   spreadPct,
      callVolume: callVol, putVolume: putVol,
      callOI,   putOI,
      putCallRatio: pcr,
      nearestExpiry,
      levels:   levels.slice(0, 12),
      scannedAt,
    };

    depthCache.set(symbol, { data, ts: Date.now() });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/**
 * /api/ig/indicators
 *
 * Calculates technical indicators from 3 months of Yahoo Finance daily data.
 * No IG allowance consumed — all data from Yahoo.
 *
 * Query params: name=<instrument name>&epic=<IG epic (optional, for symbol guessing)>
 *
 * Returns:
 *   price, previousClose, changePercent, gapPercent (open vs prev close)
 *   rsi14, ema20, ema50, emaCross (bullish/bearish/neutral)
 *   macdLine, macdSignal, macdHistogram, macdCross
 *   volumeSurge (ratio vs 20-period avg)
 *   vwapDeviation (% above/below 20-day VWAP)
 *   bullScore, bearScore (0–100 each)
 *   confidenceScore = max(bull, bear)
 *   direction = BUY | SELL | NEUTRAL
 *
 * Cache: 30 minutes per symbol (indicators change slowly intraday)
 */

import { NextRequest, NextResponse } from 'next/server';

// ── Yahoo symbol map (same instruments as candles route) ───────────────────────

const YAHOO_MAP: Record<string, string> = {
  // Indices
  'FTSE 100': '^FTSE', 'FTSE 100 CFD': '^FTSE',
  'S&P 500': '^GSPC', 'S&P 500 CFD': '^GSPC',
  'NASDAQ 100': '^NDX', 'NASDAQ 100 CFD': '^NDX',
  'Wall Street': '^DJI', 'Wall Street (Dow)': '^DJI', 'Dow Jones': '^DJI',
  'Germany 40': '^GDAXI', 'Germany 40 (DAX)': '^GDAXI',
  'Japan 225': '^N225', 'Australia 200': '^AXJO',
  // Volatility
  'VIX': '^VIX',
  // Commodities
  'Gold': 'GC=F', 'Silver': 'SI=F',
  'Oil (WTI)': 'CL=F', 'Brent Crude': 'BZ=F', 'Natural Gas': 'NG=F',
  // Forex
  'GBP/USD': 'GBPUSD=X', 'EUR/USD': 'EURUSD=X', 'EUR/GBP': 'EURGBP=X',
  'USD/JPY': 'JPY=X', 'AUD/USD': 'AUDUSD=X', 'USD/CHF': 'CHF=X',
  // Crypto
  'Bitcoin': 'BTC-USD', 'Ethereum': 'ETH-USD',
  // US stocks
  'Apple': 'AAPL', 'Tesla': 'TSLA', 'Microsoft': 'MSFT', 'Amazon': 'AMZN',
  'NVIDIA': 'NVDA', 'Meta': 'META', 'Alphabet (GOOGL)': 'GOOGL',
  'Google': 'GOOGL', 'Netflix': 'NFLX',
};

function guessYahooSymbol(name: string, epic?: string): string | null {
  if (epic) {
    const stockMatch = epic.match(/^UA\.D\.([A-Z]+)\.CASH\.IP$/);
    if (stockMatch) return stockMatch[1];
    const fxMatch = epic.match(/^CS\.D\.([A-Z]{6})\./);
    if (fxMatch) return `${fxMatch[1]}=X`;
  }
  const n = name.toLowerCase();
  if (n.includes('ftse') || n.includes('uk 100'))        return '^FTSE';
  if (n.includes('s&p') || n.includes('sp 500'))         return '^GSPC';
  if (n.includes('nasdaq'))                               return '^NDX';
  if (n.includes('dow') || n.includes('wall street'))     return '^DJI';
  if (n.includes('dax') || n.includes('germany 40'))      return '^GDAXI';
  if (n.includes('nikkei') || n.includes('japan 225'))    return '^N225';
  if (n.includes('hang seng') || n.includes('hong kong')) return '^HSI';
  if (n.includes('asx') || n.includes('australia'))       return '^AXJO';
  if (n.includes('cac') || n.includes('france 40'))       return '^FCHI';
  if (n.includes('euro stoxx'))                           return '^STOXX50E';
  if (n.includes('gold'))                                 return 'GC=F';
  if (n.includes('silver'))                               return 'SI=F';
  if (n.includes('crude') || n.includes('wti') || (n.includes('oil') && !n.includes('brent'))) return 'CL=F';
  if (n.includes('brent'))                                return 'BZ=F';
  if (n.includes('natural gas') || n.includes('natgas')) return 'NG=F';
  if (n.includes('copper'))                               return 'HG=F';
  if (n.includes('bitcoin') || n.includes('btc'))         return 'BTC-USD';
  if (n.includes('ethereum') || n.includes('eth'))        return 'ETH-USD';
  return null;
}

// ── Indicator calculations ─────────────────────────────────────────────────────

function calcEMA(prices: number[], period: number): number[] {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  const emas: number[] = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    emas.push(prices[i] * k + emas[i - 1] * (1 - k));
  }
  return emas;
}

function calcRSI(prices: number[], period = 14): number[] {
  if (prices.length < period + 1) return [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  const rsi: number[] = [avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)];
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

function calcMACD(prices: number[], fast = 12, slow = 26, signal = 9) {
  const ema12 = calcEMA(prices, fast);
  const ema26 = calcEMA(prices, slow);
  const macdLine   = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calcEMA(macdLine, signal);
  const histogram  = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface IndicatorOutput {
  symbol:        string;
  price:         number;
  previousClose: number;
  changePercent: number;
  gapPercent:    number;
  rsi14:         number;
  ema20:         number;
  ema50:         number;
  emaCross:      'bullish' | 'bearish' | 'neutral';
  macdLine:      number;
  macdSignal:    number;
  macdHistogram: number;
  macdCross:     'bullish' | 'bearish' | 'neutral';
  volumeSurge:   number;
  vwapDeviation: number;
  bullScore:     number;
  bearScore:     number;
  confidenceScore: number;
  direction:     'BUY' | 'SELL' | 'NEUTRAL';
}

function compute(candles: { open: number; high: number; low: number; close: number; volume: number }[]): IndicatorOutput | null {
  if (candles.length < 30) return null;
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const n = closes.length;
  const cur  = candles[n - 1];
  const prev = candles[n - 2];

  const price         = cur.close;
  const previousClose = prev.close;
  const changePercent = ((price - previousClose) / previousClose) * 100;
  const gapPercent    = ((cur.open - previousClose) / previousClose) * 100;

  // RSI(14)
  const rsiArr = calcRSI(closes, 14);
  const rsi14  = rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : 50;

  // EMA(20) and EMA(50)
  const ema20Arr = calcEMA(closes, 20);
  const ema50Arr = calcEMA(closes, 50);
  const ema20    = ema20Arr[n - 1];
  const ema50    = ema50Arr[n - 1];
  const prevEma20 = ema20Arr[n - 2];
  const prevEma50 = ema50Arr[n - 2];
  const emaCross: 'bullish' | 'bearish' | 'neutral' =
    ema20 > ema50 && prevEma20 <= prevEma50 ? 'bullish' :
    ema20 < ema50 && prevEma20 >= prevEma50 ? 'bearish' :
    ema20 > ema50 ? 'bullish' : 'bearish';

  // MACD(12,26,9)
  const { macdLine, signalLine, histogram } = calcMACD(closes);
  const macdLineVal   = macdLine[n - 1];
  const macdSignalVal = signalLine[n - 1];
  const macdHistVal   = histogram[n - 1];
  const prevHistVal   = histogram[n - 2];
  const macdCross: 'bullish' | 'bearish' | 'neutral' =
    macdHistVal > 0 && prevHistVal <= 0 ? 'bullish' :
    macdHistVal < 0 && prevHistVal >= 0 ? 'bearish' :
    macdHistVal > 0 ? 'bullish' : 'bearish';

  // Volume surge (current vs 20-period avg)
  const recentVols = volumes.slice(-21, -1);
  const avgVol     = recentVols.length > 0 ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 1;
  const volumeSurge = avgVol > 0 ? volumes[n - 1] / avgVol : 1;

  // VWAP approximation (20-day)
  const vwapCandles = candles.slice(-20);
  const totalVol    = vwapCandles.reduce((s, c) => s + c.volume, 0);
  const vwap        = totalVol > 0
    ? vwapCandles.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0) / totalVol
    : price;
  const vwapDeviation = ((price - vwap) / vwap) * 100;

  // ── Confidence scoring (0–100 each side) ────────────────────────────────────
  let bullScore = 0, bearScore = 0;

  // RSI (25 pts) — oversold = buy, overbought = sell
  if      (rsi14 < 30)  bullScore += 25;
  else if (rsi14 < 45)  bullScore += 8;
  else if (rsi14 > 70)  bearScore += 25;
  else if (rsi14 > 55)  bearScore += 8;

  // EMA crossover (25 pts)
  if (ema20 > ema50) bullScore += 25; else bearScore += 25;

  // MACD histogram sign (25 pts)
  if (macdHistVal > 0) bullScore += 25; else bearScore += 25;

  // Volume surge confirms direction (10 pts)
  if (volumeSurge >= 1.5) {
    if (changePercent > 0) bullScore += 10; else bearScore += 10;
  }

  // Daily price change (10 pts)
  if      (changePercent >  0.5) bullScore += 10;
  else if (changePercent < -0.5) bearScore += 10;

  // VWAP position (5 pts)
  if      (vwapDeviation >  0.5) bullScore += 5;
  else if (vwapDeviation < -0.5) bearScore += 5;

  // Total max = 25+25+25+10+10+5 = 100
  bullScore = Math.min(100, bullScore);
  bearScore = Math.min(100, bearScore);

  const confidenceScore = Math.max(bullScore, bearScore);
  const direction: 'BUY' | 'SELL' | 'NEUTRAL' =
    bullScore > bearScore && bullScore >= 50 ? 'BUY'  :
    bearScore > bullScore && bearScore >= 50 ? 'SELL' :
    'NEUTRAL';

  return {
    symbol: '', price, previousClose, changePercent, gapPercent,
    rsi14, ema20, ema50, emaCross,
    macdLine: macdLineVal, macdSignal: macdSignalVal, macdHistogram: macdHistVal, macdCross,
    volumeSurge, vwapDeviation,
    bullScore, bearScore, confidenceScore, direction,
  };
}

// ── Cache (30 min) ─────────────────────────────────────────────────────────────

const cache = new Map<string, { data: IndicatorOutput; expiresAt: number }>();
const CACHE_TTL = 30 * 60_000;

// ── Route handler ──────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const name = searchParams.get('name') ?? '';
  const epic = searchParams.get('epic') ?? undefined;

  if (!name) {
    return NextResponse.json({ ok: false, error: 'name parameter required' }, { status: 400 });
  }

  const symbol = YAHOO_MAP[name] ?? guessYahooSymbol(name, epic);
  if (!symbol) {
    return NextResponse.json(
      { ok: false, error: `No Yahoo Finance symbol for "${name}". Pass epic= for auto-detection.` },
      { status: 400 },
    );
  }

  const hit = cache.get(symbol);
  if (hit && hit.expiresAt > Date.now()) {
    return NextResponse.json({ ok: true, ...hit.data, cached: true });
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `Yahoo HTTP ${res.status}` }, { status: 502 });
    }

    const json = await res.json() as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open:   (number | null)[];
              high:   (number | null)[];
              low:    (number | null)[];
              close:  (number | null)[];
              volume: (number | null)[];
            }>;
          };
        }>;
        error?: { description?: string };
      };
    };

    if (json.chart?.error) {
      return NextResponse.json({ ok: false, error: json.chart.error.description ?? 'Yahoo error' }, { status: 502 });
    }

    const result = json.chart?.result?.[0];
    const quote  = result?.indicators?.quote?.[0];
    if (!result || !quote) {
      return NextResponse.json({ ok: false, error: 'No data from Yahoo Finance' }, { status: 502 });
    }

    // Build clean candle array (drop any bars with null values)
    const candles: { open: number; high: number; low: number; close: number; volume: number }[] = [];
    const len = result.timestamp?.length ?? 0;
    for (let i = 0; i < len; i++) {
      const o = quote.open[i], h = quote.high[i], l = quote.low[i],
            c = quote.close[i], v = quote.volume[i];
      if (o != null && h != null && l != null && c != null && v != null) {
        candles.push({ open: o, high: h, low: l, close: c, volume: v });
      }
    }

    if (candles.length < 30) {
      return NextResponse.json(
        { ok: false, error: `Only ${candles.length} candles available (need ≥30)` },
        { status: 502 },
      );
    }

    const indicators = compute(candles);
    if (!indicators) {
      return NextResponse.json({ ok: false, error: 'Indicator calculation failed' }, { status: 500 });
    }
    indicators.symbol = symbol;

    cache.set(symbol, { data: indicators, expiresAt: Date.now() + CACHE_TTL });
    return NextResponse.json({ ok: true, ...indicators, cached: false });

  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

/**
 * Shared Yahoo Finance indicator fetch + compute logic.
 * Used by both /api/ig/indicators and /api/finnhub/opportunities.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface IndicatorResult {
  symbol:          string;
  price:           number;
  previousClose:   number;
  changePercent:   number;
  gapPercent:      number;
  rsi14:           number;
  ema20:           number;
  ema50:           number;
  emaCross:        'bullish' | 'bearish' | 'neutral';
  macdLine:        number;
  macdSignal:      number;
  macdHistogram:   number;
  macdCross:       'bullish' | 'bearish' | 'neutral';
  volumeSurge:     number;
  vwapDeviation:   number;
  bullScore:       number;
  bearScore:       number;
  confidenceScore: number;
  direction:       'BUY' | 'SELL' | 'NEUTRAL';
}

// ── Math helpers ───────────────────────────────────────────────────────────────

export function calcEMA(prices: number[], period: number): number[] {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  const emas: number[] = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    emas.push(prices[i] * k + emas[i - 1] * (1 - k));
  }
  return emas;
}

export function calcRSI(prices: number[], period = 14): number[] {
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

export function calcMACD(prices: number[], fast = 12, slow = 26, signal = 9) {
  const ema12 = calcEMA(prices, fast);
  const ema26 = calcEMA(prices, slow);
  const macdLine   = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calcEMA(macdLine, signal);
  const histogram  = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

// ── Core compute (requires ≥30 candles) ───────────────────────────────────────

type Candle = { open: number; high: number; low: number; close: number; volume: number };

export function computeIndicators(candles: Candle[]): IndicatorResult | null {
  if (candles.length < 30) return null;

  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const n       = closes.length;
  const cur     = candles[n - 1];
  const prev    = candles[n - 2];

  const price         = cur.close;
  const previousClose = prev.close;
  const changePercent = ((price - previousClose) / previousClose) * 100;
  const gapPercent    = ((cur.open - previousClose) / previousClose) * 100;

  const rsiArr = calcRSI(closes, 14);
  const rsi14  = rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : 50;

  const ema20Arr  = calcEMA(closes, 20);
  const ema50Arr  = calcEMA(closes, 50);
  const ema20     = ema20Arr[n - 1];
  const ema50     = ema50Arr[n - 1];
  const prevEma20 = ema20Arr[n - 2];
  const prevEma50 = ema50Arr[n - 2];
  const emaCross: IndicatorResult['emaCross'] =
    ema20 > ema50 && prevEma20 <= prevEma50 ? 'bullish' :
    ema20 < ema50 && prevEma20 >= prevEma50 ? 'bearish' :
    ema20 > ema50 ? 'bullish' : 'bearish';

  const { macdLine, signalLine, histogram } = calcMACD(closes);
  const macdLineVal  = macdLine[n - 1];
  const macdSigVal   = signalLine[n - 1];
  const macdHistVal  = histogram[n - 1];
  const prevHistVal  = histogram[n - 2];
  const macdCross: IndicatorResult['macdCross'] =
    macdHistVal > 0 && prevHistVal <= 0 ? 'bullish' :
    macdHistVal < 0 && prevHistVal >= 0 ? 'bearish' :
    macdHistVal > 0 ? 'bullish' : 'bearish';

  const recentVols  = volumes.slice(-21, -1);
  const avgVol      = recentVols.length > 0 ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 1;
  const volumeSurge = avgVol > 0 ? volumes[n - 1] / avgVol : 1;

  const vwapCandles   = candles.slice(-20);
  const totalVol      = vwapCandles.reduce((s, c) => s + c.volume, 0);
  const vwap          = totalVol > 0
    ? vwapCandles.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0) / totalVol
    : price;
  const vwapDeviation = ((price - vwap) / vwap) * 100;

  let bullScore = 0, bearScore = 0;
  if      (rsi14 < 30)  bullScore += 25;
  else if (rsi14 < 45)  bullScore += 8;
  else if (rsi14 > 70)  bearScore += 25;
  else if (rsi14 > 55)  bearScore += 8;
  if (ema20 > ema50) bullScore += 25; else bearScore += 25;
  if (macdHistVal > 0) bullScore += 25; else bearScore += 25;
  if (volumeSurge >= 1.5) { if (changePercent > 0) bullScore += 10; else bearScore += 10; }
  if      (changePercent >  0.5) bullScore += 10;
  else if (changePercent < -0.5) bearScore += 10;
  if      (vwapDeviation >  0.5) bullScore += 5;
  else if (vwapDeviation < -0.5) bearScore += 5;

  bullScore = Math.min(100, bullScore);
  bearScore = Math.min(100, bearScore);
  const confidenceScore = Math.max(bullScore, bearScore);
  const direction: IndicatorResult['direction'] =
    bullScore > bearScore && bullScore >= 50 ? 'BUY'  :
    bearScore > bullScore && bearScore >= 50 ? 'SELL' :
    'NEUTRAL';

  return {
    symbol: '', price, previousClose, changePercent, gapPercent,
    rsi14, ema20, ema50, emaCross,
    macdLine: macdLineVal, macdSignal: macdSigVal, macdHistogram: macdHistVal, macdCross,
    volumeSurge, vwapDeviation, bullScore, bearScore, confidenceScore, direction,
  };
}

// ── Yahoo Finance fetch + compute (shared) ────────────────────────────────────

const YAHOO_CACHE = new Map<string, { data: IndicatorResult; expiresAt: number }>();
const YAHOO_TTL   = 30 * 60_000; // 30 min

export async function fetchYahooIndicators(symbol: string): Promise<IndicatorResult | null> {
  const hit = YAHOO_CACHE.get(symbol);
  if (hit && hit.expiresAt > Date.now()) return { ...hit.data };

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const json = await res.json() as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open: (number|null)[]; high: (number|null)[];
              low:  (number|null)[]; close: (number|null)[];
              volume: (number|null)[];
            }>;
          };
        }>;
        error?: { description?: string };
      };
    };

    if (json.chart?.error) return null;
    const result = json.chart?.result?.[0];
    const quote  = result?.indicators?.quote?.[0];
    if (!result || !quote) return null;

    const candles: Candle[] = [];
    const len = result.timestamp?.length ?? 0;
    for (let i = 0; i < len; i++) {
      const o = quote.open[i], h = quote.high[i], l = quote.low[i],
            c = quote.close[i], v = quote.volume[i];
      if (o != null && h != null && l != null && c != null && v != null)
        candles.push({ open: o, high: h, low: l, close: c, volume: v });
    }

    const indicators = computeIndicators(candles);
    if (!indicators) return null;
    indicators.symbol = symbol;
    YAHOO_CACHE.set(symbol, { data: indicators, expiresAt: Date.now() + YAHOO_TTL });
    return indicators;
  } catch {
    return null;
  }
}

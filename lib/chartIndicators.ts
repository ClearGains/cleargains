/**
 * Technical indicators formatted for lightweight-charts v5.
 * All functions return { time: string|number, value: number }[] arrays.
 */

export type LWCandle = { time: string | number; open: number; high: number; low: number; close: number; volume?: number };
export type LWPoint  = { time: string | number; value: number };
export type LWHistPoint = { time: string | number; value: number; color: string };

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i === 0) { out.push(values[0]); continue; }
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

export function calcSMA(candles: LWCandle[], period: number): LWPoint[] {
  const closes = candles.map(c => c.close);
  return candles
    .map((c, i) => {
      if (i < period - 1) return null;
      const slice = closes.slice(i - period + 1, i + 1);
      return { time: c.time, value: slice.reduce((a, b) => a + b, 0) / period };
    })
    .filter((v): v is LWPoint => v !== null);
}

export function calcBollingerBands(candles: LWCandle[], period = 20, mult = 2): {
  upper: LWPoint[]; mid: LWPoint[]; lower: LWPoint[];
} {
  const closes = candles.map(c => c.close);
  const upper: LWPoint[] = [], mid: LWPoint[] = [], lower: LWPoint[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean  = slice.reduce((a, b) => a + b, 0) / period;
    const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    upper.push({ time: candles[i].time, value: mean + mult * std });
    mid.push(  { time: candles[i].time, value: mean });
    lower.push({ time: candles[i].time, value: mean - mult * std });
  }
  return { upper, mid, lower };
}

export function calcRSI(candles: LWCandle[], period = 14): LWPoint[] {
  const closes = candles.map(c => c.close);
  const out: LWPoint[] = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period; avgLoss /= period;
  const rsi0 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  out.push({ time: candles[period].time, value: rsi0 });
  for (let i = period + 1; i < candles.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    out.push({ time: candles[i].time, value: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss) });
  }
  return out;
}

export function calcMACD(candles: LWCandle[], fast = 12, slow = 26, signal = 9): {
  macd: LWPoint[]; signal: LWPoint[]; hist: LWHistPoint[];
} {
  const closes = candles.map(c => c.close);
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdLine = closes.map((_, i) => ({ time: candles[i].time, value: fastEma[i] - slowEma[i] }));
  const sigEma   = ema(macdLine.map(m => m.value), signal);
  const macdOut: LWPoint[] = [], sigOut: LWPoint[] = [], histOut: LWHistPoint[] = [];
  for (let i = slow - 1; i < candles.length; i++) {
    const m = macdLine[i].value;
    const s = sigEma[i];
    const h = m - s;
    macdOut.push({ time: candles[i].time, value: m });
    sigOut.push( { time: candles[i].time, value: s });
    histOut.push({ time: candles[i].time, value: h, color: h >= 0 ? '#10b981' : '#ef4444' });
  }
  return { macd: macdOut, signal: sigOut, hist: histOut };
}

export function calcVWAP(candles: LWCandle[]): LWPoint[] {
  let cumTP = 0, cumVol = 0;
  return candles.map(c => {
    const vol = c.volume ?? 0;
    const tp  = (c.high + c.low + c.close) / 3;
    cumTP  += tp * vol;
    cumVol += vol;
    return { time: c.time, value: cumVol > 0 ? cumTP / cumVol : tp };
  });
}

export function calcVolumeHistogram(candles: LWCandle[]): LWHistPoint[] {
  return candles.map(c => ({
    time:  c.time,
    value: c.volume ?? 0,
    color: c.close >= c.open ? 'rgba(16,185,129,0.5)' : 'rgba(239,68,68,0.5)',
  }));
}

// ── Summary values for Claude prompt ─────────────────────────────────────────

export type IndicatorSummary = {
  rsi:       number | null;
  rsiTrend:  'rising' | 'falling' | 'flat';
  macdValue: number; macdSignal: number; macdHist: number;
  macdCross: 'bullish' | 'bearish' | 'none';
  sma20: number | null; sma50: number | null; sma200: number | null;
  bbUpper: number | null; bbMid: number | null; bbLower: number | null;
  bbWidth: number | null;
  priceVsBB: 'above' | 'inside' | 'below' | null;
};

export function summarizeIndicators(candles: LWCandle[]): IndicatorSummary {
  if (candles.length < 27) {
    return { rsi: null, rsiTrend: 'flat', macdValue: 0, macdSignal: 0, macdHist: 0, macdCross: 'none',
      sma20: null, sma50: null, sma200: null, bbUpper: null, bbMid: null, bbLower: null, bbWidth: null, priceVsBB: null };
  }
  const rsiArr = calcRSI(candles, 14);
  const rsi    = rsiArr.at(-1)?.value ?? null;
  const rsiPrev= rsiArr.at(-2)?.value ?? rsi;
  const rsiTrend = rsi !== null && rsiPrev !== null ? (rsi > rsiPrev + 0.3 ? 'rising' : rsi < rsiPrev - 0.3 ? 'falling' : 'flat') : 'flat';

  const { macd: macdArr, signal: sigArr, hist: histArr } = calcMACD(candles);
  const macdValue  = macdArr.at(-1)?.value ?? 0;
  const macdSig    = sigArr.at(-1)?.value  ?? 0;
  const macdHist   = histArr.at(-1)?.value ?? 0;
  const macdHistPrev = histArr.at(-2)?.value ?? 0;
  const macdCross: 'bullish' | 'bearish' | 'none' =
    macdHistPrev < 0 && macdHist >= 0 ? 'bullish' :
    macdHistPrev > 0 && macdHist <= 0 ? 'bearish' : 'none';

  const last = candles.at(-1)!;
  const sma20  = calcSMA(candles, 20).at(-1)?.value  ?? null;
  const sma50  = candles.length >= 50  ? calcSMA(candles, 50).at(-1)?.value  ?? null : null;
  const sma200 = candles.length >= 200 ? calcSMA(candles, 200).at(-1)?.value ?? null : null;

  const { upper: bbU, mid: bbM, lower: bbL } = calcBollingerBands(candles);
  const bbUpper = bbU.at(-1)?.value ?? null;
  const bbMid   = bbM.at(-1)?.value ?? null;
  const bbLower = bbL.at(-1)?.value ?? null;
  const bbWidth = (bbUpper !== null && bbLower !== null) ? ((bbUpper - bbLower) / (bbMid ?? 1)) * 100 : null;
  const priceVsBB = bbUpper !== null && bbLower !== null
    ? last.close > bbUpper ? 'above' : last.close < bbLower ? 'below' : 'inside'
    : null;

  return { rsi, rsiTrend, macdValue, macdSignal: macdSig, macdHist, macdCross,
    sma20, sma50, sma200, bbUpper, bbMid, bbLower, bbWidth, priceVsBB };
}

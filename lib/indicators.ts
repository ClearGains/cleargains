export type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number };

export type IndicatorResult = {
  sma20:  (number | null)[];
  sma50:  (number | null)[];
  rsi14:  (number | null)[];
  macd:   { macd: number | null; signal: number | null; hist: number | null }[];
  bb:     { upper: number | null; mid: number | null; lower: number | null }[];
  latest: {
    rsi:          number | null;
    macdLine:     number | null;
    macdSignal:   number | null;
    macdHist:     number | null;
    bbUpper:      number | null;
    bbMid:        number | null;
    bbLower:      number | null;
    sma20:        number | null;
    sma50:        number | null;
    smaGoldenCross: boolean;  // sma20 crossed above sma50
    smaCross:     'bullish' | 'bearish' | 'none';
    bbPosition:   'above' | 'below' | 'inside' | null;
    rsiZone:      'oversold' | 'overbought' | 'neutral' | null;
    macdZone:     'bullish' | 'bearish' | 'neutral' | null;
  };
};

function sma(closes: number[], period: number): (number | null)[] {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

function ema(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { result.push(closes[0]); continue; }
    result.push(closes[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function rsi(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(period).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period; avgLoss /= period;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

function macd(closes: number[]): { macd: number | null; signal: number | null; hist: number | null }[] {
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const macdLine = closes.map((_, i) => i < 25 ? null : fast[i] - slow[i]);
  const validMacd = macdLine.filter((v): v is number => v !== null);
  const signalEma = ema(validMacd, 9);
  const result: { macd: number | null; signal: number | null; hist: number | null }[] = [];
  let sigIdx = 0;
  for (let i = 0; i < closes.length; i++) {
    const m = macdLine[i];
    if (m === null) { result.push({ macd: null, signal: null, hist: null }); continue; }
    const s = sigIdx >= 8 ? signalEma[sigIdx] : null;
    result.push({ macd: m, signal: s, hist: s !== null ? m - s : null });
    sigIdx++;
  }
  return result;
}

function bollingerBands(closes: number[], period = 20, stdMult = 2): { upper: number | null; mid: number | null; lower: number | null }[] {
  return closes.map((_, i) => {
    if (i < period - 1) return { upper: null, mid: null, lower: null };
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    return { upper: mean + stdMult * std, mid: mean, lower: mean - stdMult * std };
  });
}

export function calcIndicators(candles: Candle[]): IndicatorResult {
  const closes = candles.map(c => c.close);
  const s20  = sma(closes, 20);
  const s50  = sma(closes, 50);
  const r14  = rsi(closes, 14);
  const mac  = macd(closes);
  const bb   = bollingerBands(closes, 20);

  const last = closes.length - 1;
  const prev = last - 1;

  // SMA crossover detection
  const s20L = s20[last], s20P = s20[prev], s50L = s50[last], s50P = s50[prev];
  let smaCross: 'bullish' | 'bearish' | 'none' = 'none';
  if (s20L !== null && s50L !== null && s20P !== null && s50P !== null) {
    if (s20P <= s50P && s20L > s50L) smaCross = 'bullish';
    else if (s20P >= s50P && s20L < s50L) smaCross = 'bearish';
  }

  const lastRsi = r14[last];
  const lastBb  = bb[last];
  const close   = closes[last];

  return {
    sma20: s20,
    sma50: s50,
    rsi14: r14,
    macd:  mac,
    bb,
    latest: {
      rsi:            lastRsi,
      macdLine:       mac[last].macd,
      macdSignal:     mac[last].signal,
      macdHist:       mac[last].hist,
      bbUpper:        lastBb.upper,
      bbMid:          lastBb.mid,
      bbLower:        lastBb.lower,
      sma20:          s20L,
      sma50:          s50L,
      smaGoldenCross: smaCross === 'bullish',
      smaCross,
      bbPosition:     lastBb.upper !== null && lastBb.lower !== null
        ? close > lastBb.upper ? 'above' : close < lastBb.lower ? 'below' : 'inside'
        : null,
      rsiZone:  lastRsi === null ? null : lastRsi < 30 ? 'oversold' : lastRsi > 70 ? 'overbought' : 'neutral',
      macdZone: mac[last].hist === null ? null : mac[last].hist! > 0 ? 'bullish' : mac[last].hist! < 0 ? 'bearish' : 'neutral',
    },
  };
}

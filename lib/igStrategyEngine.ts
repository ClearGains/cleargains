'use client';

// ── Types ─────────────────────────────────────────────────────────────────────

export type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type SignalDirection = 'BUY' | 'SELL' | 'HOLD';

export type StrategySignal = {
  direction: SignalDirection;
  strength: number;        // 0-100
  reason: string;
  indicators: {
    label: string;
    value: string;
    status: 'bullish' | 'bearish' | 'neutral';
  }[];
  stopPoints: number;
  targetPoints: number;
  riskReward: string;
};

export type Timeframe = 'hourly' | 'daily' | 'longterm';

export type IGSavedStrategy = {
  id: string;
  name: string;
  epic: string;
  instrumentName: string;
  timeframe: Timeframe;
  size: number;
  maxPositions: number;
  accounts: ('demo' | 'live')[];
  autoTrade: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastSignal?: SignalDirection;
};

// ── Technical indicators ──────────────────────────────────────────────────────

export function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

export function rsi(closes: number[], period = 14): number[] {
  if (closes.length < period + 1) return [];
  const changes = closes.slice(1).map((v, i) => v - closes[i]);
  const result: number[] = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.abs(Math.min(change, 0))) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs));
  }
  return result;
}

export function macd(
  closes: number[],
  fast = 12, slow = 26, signal = 9
): { macdLine: number[]; signalLine: number[]; histogram: number[] } {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const offset = slow - fast;
  const macdLine = slowEma.map((v, i) => fastEma[i + offset] - v);
  const signalLine = ema(macdLine, signal);
  const sigOffset = macdLine.length - signalLine.length;
  const histogram = signalLine.map((v, i) => macdLine[i + sigOffset] - v);
  return { macdLine, signalLine, histogram };
}

// ── Strategy engines ──────────────────────────────────────────────────────────

/**
 * Hourly Scalping — EMA(9)/EMA(21) crossover + RSI(14) filter
 * Uses 5-minute candles (need ≥25 candles)
 */
export function hourlySignal(candles: Candle[]): StrategySignal {
  const closes = candles.map(c => c.close);
  const ema9  = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const rsiVals = rsi(closes, 14);

  if (ema9.length < 2 || ema21.length < 2) {
    return { direction: 'HOLD', strength: 0, reason: 'Insufficient data', indicators: [], stopPoints: 15, targetPoints: 30, riskReward: '2:1' };
  }

  const curE9  = ema9[ema9.length - 1];
  const prevE9 = ema9[ema9.length - 2];
  const curE21  = ema21[ema21.length - 1];
  const prevE21 = ema21[ema21.length - 2];
  const curRsi  = rsiVals.length > 0 ? rsiVals[rsiVals.length - 1] : 50;

  const crossedAbove = prevE9 <= prevE21 && curE9 > curE21;
  const crossedBelow = prevE9 >= prevE21 && curE9 < curE21;
  const aboveNow = curE9 > curE21;

  let direction: SignalDirection = 'HOLD';
  let strength = 0;
  let reason = '';

  if (crossedAbove && curRsi < 70 && curRsi > 35) {
    direction = 'BUY';
    strength = Math.min(90, 60 + (50 - Math.abs(curRsi - 50)));
    reason = `EMA9 crossed above EMA21 — bullish momentum. RSI ${curRsi.toFixed(0)} confirms entry room.`;
  } else if (crossedBelow && curRsi > 30 && curRsi < 65) {
    direction = 'SELL';
    strength = Math.min(90, 60 + (50 - Math.abs(curRsi - 50)));
    reason = `EMA9 crossed below EMA21 — bearish momentum. RSI ${curRsi.toFixed(0)} confirms entry room.`;
  } else if (aboveNow && curRsi < 65) {
    direction = 'BUY';
    strength = 45;
    reason = `EMA9 above EMA21 — uptrend intact. Waiting for fresh cross.`;
  } else if (!aboveNow && curRsi > 35) {
    direction = 'SELL';
    strength = 45;
    reason = `EMA9 below EMA21 — downtrend intact. Waiting for fresh cross.`;
  } else {
    reason = 'No clear signal — market neutral or RSI extreme.';
  }

  return {
    direction,
    strength,
    reason,
    indicators: [
      { label: 'EMA9', value: curE9.toFixed(2), status: aboveNow ? 'bullish' : 'bearish' },
      { label: 'EMA21', value: curE21.toFixed(2), status: aboveNow ? 'bearish' : 'bullish' },
      { label: 'RSI(14)', value: curRsi.toFixed(1), status: curRsi > 60 ? 'bearish' : curRsi < 40 ? 'bullish' : 'neutral' },
      { label: 'Cross', value: crossedAbove ? '▲ Bull Cross' : crossedBelow ? '▼ Bear Cross' : aboveNow ? 'Above' : 'Below', status: crossedAbove ? 'bullish' : crossedBelow ? 'bearish' : 'neutral' },
    ],
    stopPoints: 15,
    targetPoints: 30,
    riskReward: '2:1',
  };
}

/**
 * Daily Swing — EMA(20)/EMA(50) + MACD(12,26,9) confirmation
 * Uses 1-hour candles (need ≥60 candles)
 */
export function dailySignal(candles: Candle[]): StrategySignal {
  const closes = candles.map(c => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const { macdLine, signalLine, histogram } = macd(closes);

  if (ema50.length < 2 || macdLine.length < 2) {
    return { direction: 'HOLD', strength: 0, reason: 'Insufficient data', indicators: [], stopPoints: 30, targetPoints: 90, riskReward: '3:1' };
  }

  const curE20 = ema20[ema20.length - 1];
  const curE50 = ema50[ema50.length - 1];
  const curMacd = macdLine[macdLine.length - 1];
  const prevMacd = macdLine[macdLine.length - 2];
  const curSig = signalLine[signalLine.length - 1];
  const prevSig = signalLine[signalLine.length - 2];
  const curHist = histogram[histogram.length - 1];

  const macdCrossedAbove = prevMacd <= prevSig && curMacd > curSig;
  const macdCrossedBelow = prevMacd >= prevSig && curMacd < curSig;
  const trendUp = curE20 > curE50;

  let direction: SignalDirection = 'HOLD';
  let strength = 0;
  let reason = '';

  if (trendUp && macdCrossedAbove) {
    direction = 'BUY';
    strength = 85;
    reason = `Strong BUY: EMA20 above EMA50 (uptrend) + MACD crossed above signal line. High-probability swing setup.`;
  } else if (!trendUp && macdCrossedBelow) {
    direction = 'SELL';
    strength = 85;
    reason = `Strong SELL: EMA20 below EMA50 (downtrend) + MACD crossed below signal line. High-probability swing setup.`;
  } else if (trendUp && curMacd > curSig) {
    direction = 'BUY';
    strength = 55;
    reason = `Uptrend confirmed (EMA20 > EMA50). MACD positive. Waiting for fresh cross to enter.`;
  } else if (!trendUp && curMacd < curSig) {
    direction = 'SELL';
    strength = 55;
    reason = `Downtrend confirmed (EMA20 < EMA50). MACD negative. Waiting for fresh cross to enter.`;
  } else {
    reason = 'Conflicting signals — trend and MACD diverging. Stand aside.';
  }

  return {
    direction,
    strength,
    reason,
    indicators: [
      { label: 'EMA20', value: curE20.toFixed(2), status: trendUp ? 'bullish' : 'bearish' },
      { label: 'EMA50', value: curE50.toFixed(2), status: trendUp ? 'bearish' : 'bullish' },
      { label: 'MACD', value: curMacd.toFixed(3), status: curMacd > curSig ? 'bullish' : 'bearish' },
      { label: 'Histogram', value: curHist.toFixed(3), status: curHist > 0 ? 'bullish' : 'bearish' },
      { label: 'Trend', value: trendUp ? 'Uptrend' : 'Downtrend', status: trendUp ? 'bullish' : 'bearish' },
    ],
    stopPoints: 30,
    targetPoints: 90,
    riskReward: '3:1',
  };
}

/**
 * Long-term Trend — Golden/Death Cross (EMA50 / EMA200)
 * Uses daily candles (need ≥210 candles)
 */
export function longtermSignal(candles: Candle[]): StrategySignal {
  const closes = candles.map(c => c.close);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);

  if (ema200.length < 2) {
    return { direction: 'HOLD', strength: 0, reason: 'Need at least 210 daily candles for long-term analysis', indicators: [], stopPoints: 100, targetPoints: 300, riskReward: '3:1' };
  }

  const off = ema50.length - ema200.length;
  const cur50  = ema50[ema50.length - 1];
  const prev50 = ema50[ema50.length - 2];
  const cur200  = ema200[ema200.length - 1];
  const prev200 = ema200[ema200.length - 2];

  const golden = prev50 <= prev200 && cur50 > cur200;
  const death  = prev50 >= prev200 && cur50 < cur200;
  const above  = cur50 > cur200;
  const gap    = ((cur50 - cur200) / cur200 * 100);

  let direction: SignalDirection = 'HOLD';
  let strength = 0;
  let reason = '';

  if (golden) {
    direction = 'BUY';
    strength = 95;
    reason = `🌟 GOLDEN CROSS — EMA50 just crossed above EMA200. This is one of the most reliable long-term buy signals. Strong uptrend likely to follow.`;
  } else if (death) {
    direction = 'SELL';
    strength = 95;
    reason = `💀 DEATH CROSS — EMA50 just crossed below EMA200. Strong long-term bearish signal. Consider short position.`;
  } else if (above && gap > 0) {
    direction = 'BUY';
    strength = Math.min(75, 50 + gap * 2);
    reason = `EMA50 ${Math.abs(gap).toFixed(1)}% above EMA200 — sustained uptrend. Bullish bias maintained.`;
  } else if (!above && gap < 0) {
    direction = 'SELL';
    strength = Math.min(75, 50 + Math.abs(gap) * 2);
    reason = `EMA50 ${Math.abs(gap).toFixed(1)}% below EMA200 — sustained downtrend. Bearish bias maintained.`;
  } else {
    reason = 'EMAs converging — no clear long-term trend. Hold off.';
  }

  void off; // unused but kept for debugging

  return {
    direction,
    strength,
    reason,
    indicators: [
      { label: 'EMA50', value: cur50.toFixed(2), status: above ? 'bullish' : 'bearish' },
      { label: 'EMA200', value: cur200.toFixed(2), status: above ? 'bearish' : 'bullish' },
      { label: 'Gap', value: `${gap >= 0 ? '+' : ''}${gap.toFixed(2)}%`, status: gap > 0 ? 'bullish' : gap < 0 ? 'bearish' : 'neutral' },
      { label: 'Pattern', value: golden ? '🌟 Golden Cross' : death ? '💀 Death Cross' : above ? 'Uptrend' : 'Downtrend', status: golden || above ? 'bullish' : 'bearish' },
    ],
    stopPoints: 100,
    targetPoints: 300,
    riskReward: '3:1',
  };
}

export function getSignal(timeframe: Timeframe, candles: Candle[]): StrategySignal {
  if (timeframe === 'hourly')   return hourlySignal(candles);
  if (timeframe === 'daily')    return dailySignal(candles);
  return longtermSignal(candles);
}

// Resolution + candle count per timeframe
export const TIMEFRAME_CONFIG: Record<Timeframe, { resolution: string; max: number; label: string; pollMs: number; description: string }> = {
  hourly:   { resolution: 'MINUTE_5', max: 60,  label: 'Hourly (Scalp)', pollMs: 5 * 60_000,   description: '5-min candles · EMA9/21 + RSI · 2:1 R:R' },
  daily:    { resolution: 'HOUR',     max: 100,  label: 'Daily (Swing)',  pollMs: 60 * 60_000,  description: '1-hr candles · EMA20/50 + MACD · 3:1 R:R' },
  longterm: { resolution: 'DAY',      max: 210,  label: 'Long-term',      pollMs: 24 * 60_000 * 60, description: 'Daily candles · Golden/Death Cross EMA50/200 · 3:1 R:R' },
};

// ── Storage helpers ───────────────────────────────────────────────────────────

const LS_KEY = 'ig_strategies';

export function loadStrategies(): IGSavedStrategy[] {
  if (typeof localStorage === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as IGSavedStrategy[]; } catch { return []; }
}

export function saveStrategy(s: IGSavedStrategy): void {
  const all = loadStrategies();
  const idx = all.findIndex(x => x.id === s.id);
  if (idx >= 0) all[idx] = s; else all.push(s);
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch {}
}

export function deleteStrategy(id: string): void {
  const all = loadStrategies().filter(s => s.id !== id);
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch {}
}

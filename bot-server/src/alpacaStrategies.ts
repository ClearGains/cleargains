import type { AlpacaBar } from './alpacaApi';

// ── Indicators ────────────────────────────────────────────────────────────────

export function calcRsi(bars: AlpacaBar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const closes = bars.map(b => b.c);
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function calcEma(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const seed = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out: number[] = [seed];
  for (let i = period; i < closes.length; i++) {
    out.push(closes[i] * k + out[out.length - 1] * (1 - k));
  }
  return out;
}

export function calcSma(bars: AlpacaBar[], period: number): number | null {
  if (bars.length < period) return null;
  return bars.slice(-period).reduce((s, b) => s + b.c, 0) / period;
}

export function calcAtr(bars: AlpacaBar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1];
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)));
  }
  return trs.slice(-period).reduce((s, v) => s + v, 0) / period;
}

export function calcVwap(bars: AlpacaBar[]): number | null {
  if (!bars.length) return null;
  let cumVol = 0, cumTPV = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    cumTPV += tp * b.v;
    cumVol += b.v;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

export function calcMacdHist(bars: AlpacaBar[]): number | null {
  if (bars.length < 26) return null;
  const closes = bars.map(b => b.c);
  const ema12 = calcEma(closes, 12);
  const ema26 = calcEma(closes, 26);
  if (!ema12.length || !ema26.length) return null;
  const macdLine = ema12[ema12.length - 1] - ema26[ema26.length - 1];
  return macdLine;
}

// ── Signal type ───────────────────────────────────────────────────────────────

export type StrategySignal = {
  action:           'BUY' | 'SELL' | 'CLOSE_LONG' | 'CLOSE_SHORT' | 'HOLD';
  reason:           string;
  stopPrice?:       number;
  takeProfitPrice?: number;
  trailPercent?:    number;
  orderType?:       'market' | 'trailing_stop';
  optionType?:      'call' | 'put';   // options_directional: direction of the options trade
  optionContract?:  string;           // OCC symbol to order (filled in by evaluateSymbol)
  optionQty?:       number;           // contracts to buy (filled in by evaluateSymbol)
};

export type PositionSide = 'long' | 'short';

// ── 1. RSI Mean Reversion (5-min intraday) ────────────────────────────────────
// Universe: liquid large-caps / ETFs
// Entry: RSI < 30 (long) or RSI > 70 (short) on 5-min bars, confirmed by MACD
// Exit:  RSI crosses 55 (long) or 45 (short), or stop 1.5× ATR
export function rsiMeanReversionSignal(
  bars:       AlpacaBar[],
  inPosition: boolean,
  side?:      PositionSide,
): StrategySignal {
  if (bars.length < 20) return { action: 'HOLD', reason: 'insufficient bars' };

  const rsi  = calcRsi(bars);
  const atr  = calcAtr(bars);
  const macd = calcMacdHist(bars);
  const last = bars[bars.length - 1].c;

  if (rsi === null || atr === null) return { action: 'HOLD', reason: 'indicators not ready' };

  if (inPosition) {
    if (side === 'long') {
      if (rsi > 65) return { action: 'CLOSE_LONG', reason: `RSI recovered to ${rsi.toFixed(1)}` };
      if (last < bars[bars.length - 1].l - atr * 1.5) return { action: 'CLOSE_LONG', reason: 'ATR stop hit' };
    }
    if (side === 'short') {
      if (rsi < 35) return { action: 'CLOSE_SHORT', reason: `RSI recovered to ${rsi.toFixed(1)}` };
    }
    return { action: 'HOLD', reason: `RSI ${rsi.toFixed(1)} — in position` };
  }

  if (rsi < 30 && (macd === null || macd < 0.01)) {
    return {
      action:           'BUY',
      reason:           `RSI oversold ${rsi.toFixed(1)} — mean reversion long`,
      stopPrice:        +(last - atr * 1.5).toFixed(4),
      takeProfitPrice:  +(last + atr * 3).toFixed(4),
      orderType:        'market',
    };
  }

  if (rsi > 70 && (macd === null || macd > -0.01)) {
    return {
      action:           'SELL',
      reason:           `RSI overbought ${rsi.toFixed(1)} — mean reversion short`,
      stopPrice:        +(last + atr * 1.5).toFixed(4),
      takeProfitPrice:  +(last - atr * 3).toFixed(4),
      orderType:        'market',
    };
  }

  return { action: 'HOLD', reason: `RSI ${rsi.toFixed(1)} — neutral zone` };
}

// ── 2. EMA Crossover (daily swing — hold days to weeks) ───────────────────────
// Entry: EMA9 crosses above EMA21 (long) or below (short)
// Exit:  opposite crossover
export function emaCrossoverSignal(
  bars:       AlpacaBar[],
  inPosition: boolean,
  side?:      PositionSide,
): StrategySignal {
  if (bars.length < 25) return { action: 'HOLD', reason: 'insufficient bars' };

  const closes = bars.map(b => b.c);
  const ema9   = calcEma(closes, 9);
  const ema21  = calcEma(closes, 21);

  if (ema9.length < 2 || ema21.length < 2) return { action: 'HOLD', reason: 'EMA not ready' };

  // Align tails — ema9 is longer (starts from period 9 vs 21)
  const e9curr  = ema9[ema9.length - 1];
  const e9prev  = ema9[ema9.length - 2];
  const e21curr = ema21[ema21.length - 1];
  const e21prev = ema21[ema21.length - 2];
  const last    = bars[bars.length - 1].c;
  const atr     = calcAtr(bars) ?? last * 0.01;

  const crossedAbove = e9prev <= e21prev && e9curr > e21curr;
  const crossedBelow = e9prev >= e21prev && e9curr < e21curr;

  if (inPosition) {
    if (side === 'long'  && crossedBelow) return { action: 'CLOSE_LONG',  reason: `EMA9 crossed below EMA21 (${e9curr.toFixed(2)} < ${e21curr.toFixed(2)})` };
    if (side === 'short' && crossedAbove) return { action: 'CLOSE_SHORT', reason: `EMA9 crossed above EMA21 (${e9curr.toFixed(2)} > ${e21curr.toFixed(2)})` };
    return { action: 'HOLD', reason: `EMA9=${e9curr.toFixed(2)} EMA21=${e21curr.toFixed(2)}` };
  }

  if (crossedAbove) {
    return {
      action:           'BUY',
      reason:           `EMA9 crossed above EMA21 (${e9curr.toFixed(2)} > ${e21curr.toFixed(2)})`,
      stopPrice:        +(last - atr * 2).toFixed(4),
      takeProfitPrice:  +(last + atr * 5).toFixed(4),
      orderType:        'market',
    };
  }

  if (crossedBelow) {
    return {
      action:           'SELL',
      reason:           `EMA9 crossed below EMA21 (${e9curr.toFixed(2)} < ${e21curr.toFixed(2)})`,
      stopPrice:        +(last + atr * 2).toFixed(4),
      takeProfitPrice:  +(last - atr * 5).toFixed(4),
      orderType:        'market',
    };
  }

  return { action: 'HOLD', reason: `EMA9=${e9curr.toFixed(2)} EMA21=${e21curr.toFixed(2)} — no crossover` };
}

// ── 3. Opening Range Breakout (ORB — daily intraday) ─────────────────────────
// During first 30 min: track high/low. After that: trade breakouts.
// Exit: EOD, or stop at 50% retracement of range
export function orbSignal(
  orbHigh:      number,
  orbLow:       number,
  currentPrice: number,
  inPosition:   boolean,
  side?:        PositionSide,
): StrategySignal {
  if (!orbHigh || !orbLow || orbHigh <= orbLow) {
    return { action: 'HOLD', reason: 'ORB not established' };
  }

  const range     = orbHigh - orbLow;
  const midpoint  = orbLow + range * 0.5;

  if (inPosition) {
    if (side === 'long'  && currentPrice < midpoint)  return { action: 'CLOSE_LONG',  reason: `Price broke below ORB midpoint ${midpoint.toFixed(2)}` };
    if (side === 'short' && currentPrice > midpoint)  return { action: 'CLOSE_SHORT', reason: `Price broke above ORB midpoint ${midpoint.toFixed(2)}` };
    return { action: 'HOLD', reason: `ORB ${orbLow.toFixed(2)}–${orbHigh.toFixed(2)} — holding` };
  }

  if (currentPrice > orbHigh * 1.002) {
    return {
      action:           'BUY',
      reason:           `Breakout above ORB high ${orbHigh.toFixed(2)} (+0.2%)`,
      stopPrice:        +(midpoint).toFixed(4),
      takeProfitPrice:  +(orbHigh + range * 2).toFixed(4),
      orderType:        'market',
    };
  }

  if (currentPrice < orbLow * 0.998) {
    return {
      action:           'SELL',
      reason:           `Breakdown below ORB low ${orbLow.toFixed(2)} (-0.2%)`,
      stopPrice:        +(midpoint).toFixed(4),
      takeProfitPrice:  +(orbLow - range * 2).toFixed(4),
      orderType:        'market',
    };
  }

  return { action: 'HOLD', reason: `Price ${currentPrice.toFixed(2)} inside ORB ${orbLow.toFixed(2)}–${orbHigh.toFixed(2)}` };
}

// ── 4. VWAP Reversion (1-min intraday) ───────────────────────────────────────
// Entry: price dips >0.5% below VWAP + RSI < 45 → buy bounce
// Exit:  price reaches VWAP or 0.5% below VWAP stop
export function vwapSignal(
  todayBars:    AlpacaBar[],
  currentPrice: number,
  inPosition:   boolean,
  side?:        PositionSide,
): StrategySignal {
  if (todayBars.length < 5) return { action: 'HOLD', reason: 'insufficient intraday bars' };

  const vwap = calcVwap(todayBars);
  const rsi  = calcRsi(todayBars, Math.min(14, todayBars.length - 1));
  const atr  = calcAtr(todayBars, Math.min(14, todayBars.length - 1)) ?? currentPrice * 0.003;

  if (!vwap) return { action: 'HOLD', reason: 'VWAP not calculated' };

  const pctFromVwap = (currentPrice - vwap) / vwap * 100;

  if (inPosition) {
    if (side === 'long') {
      if (currentPrice >= vwap * 1.005) return { action: 'CLOSE_LONG',  reason: `Price hit VWAP +0.5% target` };
      if (currentPrice < vwap * 0.995)  return { action: 'CLOSE_LONG',  reason: `Stop: 0.5% below VWAP` };
    }
    if (side === 'short') {
      if (currentPrice <= vwap * 0.995) return { action: 'CLOSE_SHORT', reason: `Price hit VWAP -0.5% target` };
      if (currentPrice > vwap * 1.005)  return { action: 'CLOSE_SHORT', reason: `Stop: 0.5% above VWAP` };
    }
    return { action: 'HOLD', reason: `VWAP=${vwap.toFixed(2)} price ${pctFromVwap > 0 ? '+' : ''}${pctFromVwap.toFixed(2)}%` };
  }

  if (pctFromVwap < -0.5 && (rsi === null || rsi < 45)) {
    return {
      action:           'BUY',
      reason:           `Price ${Math.abs(pctFromVwap).toFixed(2)}% below VWAP (${vwap.toFixed(2)}) RSI=${rsi?.toFixed(1) ?? 'N/A'}`,
      stopPrice:        +(vwap * 0.995).toFixed(4),
      takeProfitPrice:  +(vwap * 1.005).toFixed(4),
      orderType:        'market',
    };
  }

  if (pctFromVwap > 0.5 && (rsi === null || rsi > 55)) {
    return {
      action:           'SELL',
      reason:           `Price ${pctFromVwap.toFixed(2)}% above VWAP (${vwap.toFixed(2)}) RSI=${rsi?.toFixed(1) ?? 'N/A'}`,
      stopPrice:        +(vwap * 1.005).toFixed(4),
      takeProfitPrice:  +(vwap * 0.995).toFixed(4),
      orderType:        'market',
    };
  }

  return { action: 'HOLD', reason: `VWAP=${vwap.toFixed(2)} price ${pctFromVwap > 0 ? '+' : ''}${pctFromVwap.toFixed(2)}%` };
}

// ── 5. Weekly Momentum (weekly bars — hold weeks to months) ───────────────────
// Entry: price above 12-week SMA + 4-week momentum > 1% + RSI 50–70
// Exit:  price drops below 12-week SMA × 0.97, or trailing stop 5%
export function weeklyMomentumSignal(
  weeklyBars: AlpacaBar[],
  dailyBars:  AlpacaBar[],
  inPosition: boolean,
  side?:      PositionSide,
): StrategySignal {
  if (weeklyBars.length < 13) return { action: 'HOLD', reason: 'insufficient weekly bars (need 13)' };

  const sma12w    = calcSma(weeklyBars, 12);
  const rsi       = calcRsi(weeklyBars);
  const lastClose = weeklyBars[weeklyBars.length - 1].c;
  const prev4wClose = weeklyBars[weeklyBars.length - 5]?.c ?? lastClose;
  const momentum4w  = (lastClose - prev4wClose) / prev4wClose * 100;
  const dailyAtr    = calcAtr(dailyBars) ?? lastClose * 0.015;

  if (inPosition) {
    if (side === 'long' && sma12w && lastClose < sma12w * 0.97) {
      return { action: 'CLOSE_LONG', reason: `Price fell below 97% of 12-week SMA (${sma12w.toFixed(2)})` };
    }
    return { action: 'HOLD', reason: `Weekly momentum ${momentum4w.toFixed(2)}% — holding` };
  }

  const aboveSma  = sma12w !== null && lastClose > sma12w;
  const bullMom   = momentum4w > 1.0;
  const goodRsi   = rsi !== null && rsi >= 50 && rsi <= 70;

  if (aboveSma && bullMom && goodRsi) {
    return {
      action:           'BUY',
      reason:           `Weekly mom ${momentum4w.toFixed(2)}% | above 12w SMA | RSI ${rsi?.toFixed(1)}`,
      stopPrice:        +(lastClose - dailyAtr * 4).toFixed(4),
      takeProfitPrice:  +(lastClose + dailyAtr * 10).toFixed(4),
      orderType:        'trailing_stop',
      trailPercent:     5,
    };
  }

  return { action: 'HOLD', reason: `Weekly: mom=${momentum4w.toFixed(2)}% sma=${sma12w?.toFixed(2) ?? 'N/A'} rsi=${rsi?.toFixed(1) ?? 'N/A'}` };
}

// ── 6. Options Directional (5-min intraday) ────────────────────────────────────
// Entry: RSI extreme → buy call (oversold) or put (overbought)
// Exit:  +75% profit, −50% loss, or ≤2 DTE
export function optionsDirectionalSignal(
  bars:         AlpacaBar[],
  inPosition:   boolean,
  currentPlPct?: number,   // unrealized P/L % on the options position (0–100 scale)
  dte?:          number,    // days to expiry
): StrategySignal {
  if (bars.length < 20) return { action: 'HOLD', reason: 'insufficient bars' };

  const rsi  = calcRsi(bars);
  const macd = calcMacdHist(bars);

  if (rsi === null) return { action: 'HOLD', reason: 'RSI not ready' };

  if (inPosition) {
    if (dte !== undefined && dte <= 2) {
      return { action: 'CLOSE_LONG', reason: `≤2 DTE (${dte}) — closing to avoid expiry risk` };
    }
    if (currentPlPct !== undefined && currentPlPct >= 75) {
      return { action: 'CLOSE_LONG', reason: `Profit target hit: +${currentPlPct.toFixed(1)}%` };
    }
    if (currentPlPct !== undefined && currentPlPct <= -50) {
      return { action: 'CLOSE_LONG', reason: `Stop loss hit: ${currentPlPct.toFixed(1)}%` };
    }
    return { action: 'HOLD', reason: `RSI ${rsi.toFixed(1)} | P/L ${currentPlPct?.toFixed(1) ?? '?'}% | ${dte ?? '?'}d to expiry` };
  }

  // Buy calls when oversold — expecting mean reversion upward
  if (rsi < 30 && (macd === null || macd <= 0)) {
    return {
      action:     'BUY',
      reason:     `RSI oversold ${rsi.toFixed(1)} — buying call (mean reversion up)`,
      optionType: 'call',
    };
  }

  // Buy puts when overbought — expecting mean reversion downward
  if (rsi > 70 && (macd === null || macd >= 0)) {
    return {
      action:     'BUY',
      reason:     `RSI overbought ${rsi.toFixed(1)} — buying put (mean reversion down)`,
      optionType: 'put',
    };
  }

  return { action: 'HOLD', reason: `RSI ${rsi.toFixed(1)} — not extreme enough for options entry` };
}

// ── Strategy metadata ─────────────────────────────────────────────────────────

export type StrategyName = 'rsi_mean_reversion' | 'ema_crossover' | 'orb' | 'vwap' | 'weekly_momentum' | 'options_directional';

export const STRATEGY_META: Record<StrategyName, {
  label:     string;
  timeframe: 'intraday' | 'daily' | 'weekly';
  pollMs:    number;   // how often to poll for signals
  barPeriod: '5Min' | '1Min' | '1Day' | '1Week';
  barsNeeded: number;
}> = {
  rsi_mean_reversion:  { label: 'RSI Mean Reversion',    timeframe: 'intraday', pollMs: 5 * 60_000,  barPeriod: '5Min',  barsNeeded: 60  },
  ema_crossover:       { label: 'EMA Crossover',          timeframe: 'daily',    pollMs: 60 * 60_000, barPeriod: '1Day',  barsNeeded: 60  },
  orb:                 { label: 'Opening Range Breakout', timeframe: 'intraday', pollMs: 60_000,      barPeriod: '1Min',  barsNeeded: 60  },
  vwap:                { label: 'VWAP Reversion',         timeframe: 'intraday', pollMs: 60_000,      barPeriod: '1Min',  barsNeeded: 60  },
  weekly_momentum:     { label: 'Weekly Momentum',        timeframe: 'weekly',   pollMs: 60 * 60_000, barPeriod: '1Week', barsNeeded: 20  },
  options_directional: { label: 'Options Directional',    timeframe: 'intraday', pollMs: 5 * 60_000,  barPeriod: '5Min',  barsNeeded: 60  },
};

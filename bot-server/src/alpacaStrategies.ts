import type { AlpacaBar } from './alpacaApi';
import { ruleBasedAnalysis } from './ruleBasedAnalysis';
import type { LWCandle } from './chartIndicators';

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

// Kaufman's Efficiency Ratio — net directional progress over a window,
// divided by the total distance price actually travelled to get there.
// 1.0 = moved in a straight line (real trend); near 0 = oscillated back and
// forth and ended up roughly where it started (pure noise/chop), even if
// each individual swing looked dramatic. Confirmed live this matters:
// SanDisk was bought long twice and shorted once in a single day, losing
// on every leg — a textbook whipsaw the RSI/MACD/day-move signals never
// caught, because each individual reading looked reasonable in isolation;
// what they missed was that the instrument wasn't actually going anywhere.
export function calcEfficiencyRatio(bars: AlpacaBar[], period = 20): number | null {
  if (bars.length < period + 1) return null;
  const window = bars.slice(-(period + 1));
  const netChange = Math.abs(window[window.length - 1].c - window[0].c);
  let pathLength = 0;
  for (let i = 1; i < window.length; i++) pathLength += Math.abs(window[i].c - window[i - 1].c);
  return pathLength > 0 ? netChange / pathLength : 0;
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

// True MACD histogram: (EMA_fast − EMA_slow) − EMA_signal of that
// difference. Returns the last two values so callers can detect the
// histogram turning. Periods default to the standard 12/26/9 (bar-count
// based, not time based) — a caller feeding finer-than-usual bars (e.g.
// gemini_opinion's 30-min bars) can double them to preserve the same
// wall-clock window the defaults represent on hourly bars.
export function calcMacdHist(bars: AlpacaBar[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): { hist: number; prevHist: number } | null {
  if (bars.length < slowPeriod + signalPeriod) return null;
  const closes = bars.map(b => b.c);
  const emaFast = calcEma(closes, fastPeriod);
  const emaSlow = calcEma(closes, slowPeriod);
  if (!emaFast.length || !emaSlow.length) return null;
  // Align tails: both series end at the last close
  const n = Math.min(emaFast.length, emaSlow.length);
  const macdLine: number[] = [];
  for (let i = 0; i < n; i++) {
    macdLine.push(emaFast[emaFast.length - n + i] - emaSlow[emaSlow.length - n + i]);
  }
  const signal = calcEma(macdLine.map((v, i) => v), signalPeriod);
  if (signal.length < 2) return null;
  const hist     = macdLine[macdLine.length - 1] - signal[signal.length - 1];
  const prevHist = macdLine[macdLine.length - 2] - signal[signal.length - 2];
  return { hist, prevHist };
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
  // Donchian only: the exact entryHigh/entryLow that triggered a BUY/SELL.
  // Lets a caller require a genuinely new/more-extreme breakout before
  // re-entering, instead of re-firing on the same still-valid historical
  // level all day — see igStrategyBot.ts's lastEntryTrigger check.
  triggerLevel?:    number;
  // gemini_opinion only: Gemini's own confidence in this idea (0-100). Lets
  // a caller compare a fresh candidate against an already-held position's
  // last-known confidence to decide whether it's worth swapping — see the
  // position-rotation logic in igStrategyBot.ts.
  confidence?:      number;
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
    // Hard stop / take-profit live server-side as bracket legs; here we only
    // exit on the mean-reversion thesis completing.
    if (side === 'long'  && rsi > 60) return { action: 'CLOSE_LONG',  reason: `RSI recovered to ${rsi.toFixed(1)}` };
    if (side === 'short' && rsi < 40) return { action: 'CLOSE_SHORT', reason: `RSI recovered to ${rsi.toFixed(1)}` };
    return { action: 'HOLD', reason: `RSI ${rsi.toFixed(1)} — in position` };
  }

  // Momentum filter: only take oversold longs when downside momentum is easing
  // (histogram rising) or already recovered (histogram positive) — avoids
  // catching a falling knife. Mirrored for shorts. Epsilon absorbs float noise.
  const eps = last * 1e-9;
  const histTurningUp   = macd === null || macd.hist >= macd.prevHist - eps || macd.hist > 0;
  const histTurningDown = macd === null || macd.hist <= macd.prevHist + eps || macd.hist < 0;

  if (rsi < 30 && histTurningUp) {
    return {
      action:           'BUY',
      reason:           `RSI oversold ${rsi.toFixed(1)} + MACD hist turning up — mean reversion long`,
      stopPrice:        +(last - atr * 1.5).toFixed(2),
      takeProfitPrice:  +(last + atr * 3).toFixed(2),
      orderType:        'market',
    };
  }

  if (rsi > 70 && histTurningDown) {
    return {
      action:           'SELL',
      reason:           `RSI overbought ${rsi.toFixed(1)} + MACD hist turning down — mean reversion short`,
      stopPrice:        +(last + atr * 1.5).toFixed(2),
      takeProfitPrice:  +(last - atr * 3).toFixed(2),
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
      stopPrice:        +(last - atr * 2).toFixed(2),
      takeProfitPrice:  +(last + atr * 5).toFixed(2),
      orderType:        'market',
    };
  }

  if (crossedBelow) {
    return {
      action:           'SELL',
      reason:           `EMA9 crossed below EMA21 (${e9curr.toFixed(2)} < ${e21curr.toFixed(2)})`,
      stopPrice:        +(last + atr * 2).toFixed(2),
      takeProfitPrice:  +(last - atr * 5).toFixed(2),
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
      stopPrice:        +(midpoint).toFixed(2),
      takeProfitPrice:  +(orbHigh + range * 2).toFixed(2),
      orderType:        'market',
    };
  }

  if (currentPrice < orbLow * 0.998) {
    return {
      action:           'SELL',
      reason:           `Breakdown below ORB low ${orbLow.toFixed(2)} (-0.2%)`,
      stopPrice:        +(midpoint).toFixed(2),
      takeProfitPrice:  +(orbLow - range * 2).toFixed(2),
      orderType:        'market',
    };
  }

  return { action: 'HOLD', reason: `Price ${currentPrice.toFixed(2)} inside ORB ${orbLow.toFixed(2)}–${orbHigh.toFixed(2)}` };
}

// ── 4. VWAP Reversion (1-min intraday) ───────────────────────────────────────
// Entry: price dips >0.5% below VWAP + RSI < 45 → buy bounce
// Exit:  price reaches VWAP or VWAP_STOP_BAND beyond VWAP stop
//
// VWAP_STOP_BAND was 1% (entries at ~0.5% away, so ~0.5% adverse from entry)
// — widened to 1.5%, still a small, recoverable band, to give spread-bet-
// scale noise a bit more room before treating a dip as thesis failure.
// Every stop-band width is a tradeoff, not a free improvement: wider means
// fewer trades get shaken out right before a real reversion, but bigger
// realized losses on the (more common) trades that don't come back — this
// isn't a "correct" number, just a deliberately modest widening rather than
// loosening it enough to turn VWAP into an unsized trend-following bet.
const VWAP_STOP_BAND = 0.015;

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
  const stopPct = (VWAP_STOP_BAND * 100).toFixed(1);

  if (inPosition) {
    // Target: price reverts to VWAP. Stop: stretch extends to VWAP_STOP_BAND
    // beyond VWAP — the server-side bracket stop is the primary protection,
    // this is the software-level backup check in case a gap slips past it.
    if (side === 'long') {
      if (currentPrice >= vwap)                            return { action: 'CLOSE_LONG',  reason: `Price reverted to VWAP ${vwap.toFixed(2)} — target hit` };
      if (currentPrice < vwap * (1 - VWAP_STOP_BAND))       return { action: 'CLOSE_LONG',  reason: `Stop: stretched >${stopPct}% below VWAP` };
    }
    if (side === 'short') {
      if (currentPrice <= vwap)                             return { action: 'CLOSE_SHORT', reason: `Price reverted to VWAP ${vwap.toFixed(2)} — target hit` };
      if (currentPrice > vwap * (1 + VWAP_STOP_BAND))        return { action: 'CLOSE_SHORT', reason: `Stop: stretched >${stopPct}% above VWAP` };
    }
    return { action: 'HOLD', reason: `VWAP=${vwap.toFixed(2)} price ${pctFromVwap > 0 ? '+' : ''}${pctFromVwap.toFixed(2)}%` };
  }

  if (pctFromVwap < -0.5 && (rsi === null || rsi < 45)) {
    return {
      action:           'BUY',
      reason:           `Price ${Math.abs(pctFromVwap).toFixed(2)}% below VWAP (${vwap.toFixed(2)}) RSI=${rsi?.toFixed(1) ?? 'N/A'}`,
      stopPrice:        +Math.min(currentPrice - atr * 1.2, vwap * (1 - VWAP_STOP_BAND)).toFixed(2),
      takeProfitPrice:  +vwap.toFixed(2),
      orderType:        'market',
    };
  }

  if (pctFromVwap > 0.5 && (rsi === null || rsi > 55)) {
    return {
      action:           'SELL',
      reason:           `Price ${pctFromVwap.toFixed(2)}% above VWAP (${vwap.toFixed(2)}) RSI=${rsi?.toFixed(1) ?? 'N/A'}`,
      stopPrice:        +Math.max(currentPrice + atr * 1.2, vwap * (1 + VWAP_STOP_BAND)).toFixed(2),
      takeProfitPrice:  +vwap.toFixed(2),
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
    // Enter at market; the bot attaches a 5% trailing stop as the exit order.
    return {
      action:           'BUY',
      reason:           `Weekly mom ${momentum4w.toFixed(2)}% | above 12w SMA | RSI ${rsi?.toFixed(1)}`,
      stopPrice:        +(lastClose - dailyAtr * 4).toFixed(2),
      takeProfitPrice:  +(lastClose + dailyAtr * 10).toFixed(2),
      orderType:        'market',
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

  // Buy calls when oversold and downside momentum is easing (hist turning up
  // or already positive); mirrored for puts
  const lastClose = bars[bars.length - 1].c;
  const eps = lastClose * 1e-9;
  const histTurningUp   = macd === null || macd.hist >= macd.prevHist - eps || macd.hist > 0;
  const histTurningDown = macd === null || macd.hist <= macd.prevHist + eps || macd.hist < 0;

  if (rsi < 30 && histTurningUp) {
    return {
      action:     'BUY',
      reason:     `RSI oversold ${rsi.toFixed(1)} + MACD hist turning up — buying call (mean reversion up)`,
      optionType: 'call',
    };
  }

  // Buy puts when overbought and upside momentum is fading (hist turning down)
  if (rsi > 70 && histTurningDown) {
    return {
      action:     'BUY',
      reason:     `RSI overbought ${rsi.toFixed(1)} + MACD hist turning down — buying put (mean reversion down)`,
      optionType: 'put',
    };
  }

  return { action: 'HOLD', reason: `RSI ${rsi.toFixed(1)} — not extreme enough for options entry` };
}

// ── 7. Donchian / Turtle-style Breakout (daily bars — hold days to weeks) ─────
// Backtested best performer: +8.9% avg return/symbol after financing costs,
// profit factor 1.38, 30/52 symbols profitable (Backtest Lab leaderboard).
// Entry: close breaks above the 20-day high (long) or below the 20-day low
// (short). Exit: opposite breakout of the shorter 10-day channel — the actual
// Turtle System 1 exit rule, letting winners run past the entry band. No fixed
// take-profit by design — takeProfitPrice below is a wide backstop only (also
// keeps the bot's naked-position self-heal from clamping it to a tight one).
export function donchianBreakoutSignal(
  bars:        AlpacaBar[],
  inPosition:  boolean,
  side?:       PositionSide,
  entryPeriod = 20,
  exitPeriod  = 10,
  periodUnit: 'day' | 'hour' = 'day',
): StrategySignal {
  if (bars.length < entryPeriod + 1) return { action: 'HOLD', reason: 'insufficient bars' };

  const n = bars.length;
  const entryWindow = bars.slice(n - 1 - entryPeriod, n - 1);
  const exitWindow  = bars.slice(Math.max(0, n - 1 - exitPeriod), n - 1);
  const last = bars[n - 1].c;
  const entryHigh = Math.max(...entryWindow.map(b => b.h));
  const entryLow  = Math.min(...entryWindow.map(b => b.l));
  const exitHigh  = Math.max(...exitWindow.map(b => b.h));
  const exitLow   = Math.min(...exitWindow.map(b => b.l));
  const atr = calcAtr(bars) ?? last * 0.015;

  // Stop distance: tighter of 2×ATR or 3% of price. Pure 2×ATR blows out
  // during genuinely volatile stretches (a real semiconductor-sector
  // selloff drove ATR-implied stops to 5-9x a name's own price live) —
  // every signal ends up skipped by the account's loss ceiling instead of
  // trading at a smaller, still-real size. Same 3% ratio the self-heal
  // fallback already uses for naked positions, so this isn't a new number,
  // just applying it up front instead of after the fact.
  const stopDist = Math.min(atr * 2, last * 0.03);

  // Take-profit distance: deliberately wide (trailing stop, not this level,
  // is what actually locks in gains on a sustained trend — see
  // igStrategyBot.ts's trailing-stop block for donchian_breakout), but
  // still capped. Raw atr*10 with no ceiling produced a limit level IG
  // rejected outright (confirmed live: Amazon's ATR was volatile enough
  // that atr*10 worked out to ~35% of price — a limit that far out reads
  // as unreasonable rather than "wide but real"). 15% keeps it well past
  // where the trailing stop would ever actually let a trade run to, while
  // staying inside what IG will accept.
  const tpDist = Math.min(atr * 10, last * 0.15);

  if (inPosition) {
    if (side === 'long'  && last < exitLow)  return { action: 'CLOSE_LONG',  reason: `Broke below ${exitPeriod}-${periodUnit} low ${exitLow.toFixed(2)}` };
    if (side === 'short' && last > exitHigh) return { action: 'CLOSE_SHORT', reason: `Broke above ${exitPeriod}-${periodUnit} high ${exitHigh.toFixed(2)}` };
    return { action: 'HOLD', reason: `Inside ${exitPeriod}-${periodUnit} exit channel ${exitLow.toFixed(2)}–${exitHigh.toFixed(2)} — holding` };
  }

  if (last > entryHigh) {
    return {
      action:           'BUY',
      reason:           `Breakout above ${entryPeriod}-${periodUnit} high ${entryHigh.toFixed(2)}`,
      stopPrice:        +(last - stopDist).toFixed(2),
      takeProfitPrice:  +(last + tpDist).toFixed(2),
      orderType:        'market',
      triggerLevel:     entryHigh,
    };
  }
  if (last < entryLow) {
    return {
      action:           'SELL',
      reason:           `Breakdown below ${entryPeriod}-${periodUnit} low ${entryLow.toFixed(2)}`,
      stopPrice:        +(last + stopDist).toFixed(2),
      takeProfitPrice:  +(last - tpDist).toFixed(2),
      orderType:        'market',
      triggerLevel:     entryLow,
    };
  }
  return { action: 'HOLD', reason: `Price ${last.toFixed(2)} inside ${entryPeriod}-${periodUnit} range ${entryLow.toFixed(2)}–${entryHigh.toFixed(2)}` };
}

// ── 8. MACD Signal-Line Crossover (daily bars — hold days to weeks) ───────────
// Backtested: +6.1% avg return/symbol after financing costs, profit factor
// 1.17, 21/52 symbols profitable. Different lag profile than the EMA9/21
// price cross above — reacts to momentum turning, not price alone. A
// histogram crossing zero is exactly the MACD line crossing its signal line,
// so this reuses calcMacdHist rather than re-deriving both lines.
// Entry: MACD crosses its own signal line. Exit: opposite crossover.
export function macdCrossoverSignal(
  bars:       AlpacaBar[],
  inPosition: boolean,
  side?:      PositionSide,
): StrategySignal {
  if (bars.length < 36) return { action: 'HOLD', reason: 'insufficient bars' };

  const macd = calcMacdHist(bars);
  const atr  = calcAtr(bars);
  const last = bars[bars.length - 1].c;
  if (macd === null || atr === null) return { action: 'HOLD', reason: 'indicators not ready' };

  const crossedAbove = macd.prevHist <= 0 && macd.hist > 0;
  const crossedBelow = macd.prevHist >= 0 && macd.hist < 0;

  if (inPosition) {
    if (side === 'long'  && crossedBelow) return { action: 'CLOSE_LONG',  reason: `MACD crossed below signal (hist ${macd.hist.toFixed(3)})` };
    if (side === 'short' && crossedAbove) return { action: 'CLOSE_SHORT', reason: `MACD crossed above signal (hist ${macd.hist.toFixed(3)})` };
    return { action: 'HOLD', reason: `MACD hist ${macd.hist.toFixed(3)} — in position` };
  }

  if (crossedAbove) {
    return {
      action:           'BUY',
      reason:           `MACD crossed above signal line (hist ${macd.hist.toFixed(3)})`,
      stopPrice:        +(last - atr * 2).toFixed(2),
      takeProfitPrice:  +(last + atr * 5).toFixed(2),
      orderType:        'market',
    };
  }
  if (crossedBelow) {
    return {
      action:           'SELL',
      reason:           `MACD crossed below signal line (hist ${macd.hist.toFixed(3)})`,
      stopPrice:        +(last + atr * 2).toFixed(2),
      takeProfitPrice:  +(last - atr * 5).toFixed(2),
      orderType:        'market',
    };
  }
  return { action: 'HOLD', reason: `MACD hist ${macd.hist.toFixed(3)} — no crossover` };
}

// ── 9. Daily Pivot Points (daily bars — hold hours to a day) ──────────────────
// Classic floor-trader pivots computed from the prior COMPLETE day's H/L/C
// (bars[n-2] — bars[n-1] is treated as "today, still forming", same
// convention donchianBreakoutSignal already uses). Trades a bounce off S1/R1
// back toward the pivot — same revert-to-a-reference-level structure as
// vwapSignal, just anchored to yesterday's range instead of today's VWAP.
// P = (H+L+C)/3, R1 = 2P-L, S1 = 2P-H — the standard formula, not the
// Fibonacci variant (that scales R/S distance by 0.382/0.618/1.0 instead of
// the flat H-L range; a reasonable follow-up if the classic version proves
// worth keeping, not worth building both unverified up front).
export function pivotPointsSignal(
  bars:       AlpacaBar[],
  inPosition: boolean,
  side?:      PositionSide,
): StrategySignal {
  if (bars.length < 15) return { action: 'HOLD', reason: 'insufficient bars' };

  const n     = bars.length;
  const prior = bars[n - 2];
  const last  = bars[n - 1].c;
  const atr   = calcAtr(bars) ?? last * 0.015;

  const pivot = (prior.h + prior.l + prior.c) / 3;
  const r1 = 2 * pivot - prior.l;
  const s1 = 2 * pivot - prior.h;

  if (inPosition) {
    if (side === 'long'  && last >= pivot) return { action: 'CLOSE_LONG',  reason: `Reverted to pivot ${pivot.toFixed(2)} — target hit` };
    if (side === 'short' && last <= pivot) return { action: 'CLOSE_SHORT', reason: `Reverted to pivot ${pivot.toFixed(2)} — target hit` };
    return { action: 'HOLD', reason: `Pivot ${pivot.toFixed(2)} S1=${s1.toFixed(2)} R1=${r1.toFixed(2)} — holding` };
  }

  // Bounce off S1: price dipped to/through support, buy for reversion to the pivot.
  if (last <= s1) {
    return {
      action:           'BUY',
      reason:           `Price ${last.toFixed(2)} at/below S1 ${s1.toFixed(2)} — bounce toward pivot ${pivot.toFixed(2)}`,
      stopPrice:        +(s1 - atr * 1.2).toFixed(2),
      takeProfitPrice:  +pivot.toFixed(2),
      orderType:        'market',
    };
  }

  // Bounce off R1: price rallied to/through resistance, sell for reversion to the pivot.
  if (last >= r1) {
    return {
      action:           'SELL',
      reason:           `Price ${last.toFixed(2)} at/above R1 ${r1.toFixed(2)} — bounce toward pivot ${pivot.toFixed(2)}`,
      stopPrice:        +(r1 + atr * 1.2).toFixed(2),
      takeProfitPrice:  +pivot.toFixed(2),
      orderType:        'market',
    };
  }

  return { action: 'HOLD', reason: `Price ${last.toFixed(2)} inside S1=${s1.toFixed(2)}–R1=${r1.toFixed(2)}` };
}

// ── Rule-Based Analysis (Daily Brief's swing engine, ported) ──────────────────
// Same RSI/MACD/SMA/Bollinger scoring + trend filter as lib/ruleBasedAnalysis.ts
// (the Daily Brief page) — added here after that engine backtested a real edge
// (2026-08-15: walk-forward, 2y daily bars, 27 instruments, avg 0.10R/trade
// with the trend filter vs 0.002R/trade without). Ported rather than shared
// via package, since bot-server and the Next.js app are separately deployed —
// see bot-server/src/ruleBasedAnalysis.ts's own header for the inlined-types
// note. Needs a long daily history for its SMA200 trend filter to actually be
// active (see FREE_DATA_PARAMS below — 2y range, unlike every other daily
// strategy's 6mo), so gates on far more bars than the others.
// Tuned by backtest sweep, not intuition — see the call site's own comment.
// Exported so backtest.ts's makeRuleBasedAnalysis can apply the identical
// gate — it calls ruleBasedAnalysis() directly rather than through this
// function, so without sharing this constant the backtest would silently
// simulate a different (gate-less) strategy than the one actually live.
export const MIN_SWING_CONFIDENCE = 7;

export function ruleBasedAnalysisSignal(
  bars:       AlpacaBar[],
  inPosition: boolean,
  side?:      PositionSide,
): StrategySignal {
  if (bars.length < 210) return { action: 'HOLD', reason: `insufficient bars (${bars.length}/210) — needs ~200 for SMA200 trend filter` };

  const candles: LWCandle[] = bars.map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
  let analysis;
  try { analysis = ruleBasedAnalysis('', candles); } catch (e) {
    return { action: 'HOLD', reason: `analysis failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const swing = analysis.swing;

  if (inPosition) {
    if (side === 'long'  && swing.direction !== 'LONG')  return { action: 'CLOSE_LONG',  reason: `Thesis no longer bullish — ${swing.reasoning}` };
    if (side === 'short' && swing.direction !== 'SHORT') return { action: 'CLOSE_SHORT', reason: `Thesis no longer bearish — ${swing.reasoning}` };
    return { action: 'HOLD', reason: `${analysis.bias} bias holding — ${swing.reasoning}` };
  }

  if (swing.direction === 'LONG' || swing.direction === 'SHORT') {
    // Floor below which a "signal" is really just noise — nothing
    // previously stopped a low-conviction score from executing exactly
    // like a strong one, only from sizing slightly bigger once through
    // (see igStrategyBot.ts's loss-ceiling confidence scaling). Value
    // chosen from a real backtest sweep across the confirmed-epics universe
    // (2026-08-19), not picked on intuition — see RULE_BASED_ANALYSIS_CONFIRMED_EPICS's
    // own comment for the before/after numbers.
    if (swing.confidence < MIN_SWING_CONFIDENCE) {
      return { action: 'HOLD', reason: `${swing.direction} bias but only ${swing.confidence}/10 confidence — below the ${MIN_SWING_CONFIDENCE}/10 bar to actually trade it` };
    }
    return {
      action:           swing.direction === 'LONG' ? 'BUY' : 'SELL',
      reason:           swing.reasoning,
      stopPrice:        swing.stopLoss,
      takeProfitPrice:  swing.takeProfit1,
      orderType:        'market',
      confidence:       swing.confidence * 10, // this engine's confidence is 1-10; StrategySignal.confidence is 0-100 elsewhere (gemini_opinion)
    };
  }
  return { action: 'HOLD', reason: swing.reasoning || `${analysis.bias} bias — no clear swing setup` };
}

// ── Strategy metadata ─────────────────────────────────────────────────────────

export type StrategyName = 'rsi_mean_reversion' | 'ema_crossover' | 'orb' | 'vwap' | 'weekly_momentum' | 'options_directional' | 'donchian_breakout' | 'donchian_hourly' | 'macd_crossover' | 'pivot_points' | 'gemini_opinion' | 'rule_based_analysis';

export const STRATEGY_META: Record<StrategyName, {
  label:     string;
  timeframe: 'intraday' | 'hourly' | 'daily' | 'weekly';
  pollMs:    number;   // how often to poll for signals
  barPeriod: '5Min' | '1Min' | '30Min' | '1Hour' | '1Day' | '1Week';
  barsNeeded: number;
}> = {
  rsi_mean_reversion:  { label: 'RSI Mean Reversion',    timeframe: 'intraday', pollMs: 5 * 60_000,  barPeriod: '5Min',  barsNeeded: 60  },
  ema_crossover:       { label: 'EMA Crossover',          timeframe: 'daily',    pollMs: 60 * 60_000, barPeriod: '1Day',  barsNeeded: 60  },
  orb:                 { label: 'Opening Range Breakout', timeframe: 'intraday', pollMs: 60_000,      barPeriod: '1Min',  barsNeeded: 60  },
  vwap:                { label: 'VWAP Reversion',         timeframe: 'intraday', pollMs: 60_000,      barPeriod: '1Min',  barsNeeded: 60  },
  weekly_momentum:     { label: 'Weekly Momentum',        timeframe: 'weekly',   pollMs: 60 * 60_000, barPeriod: '1Week', barsNeeded: 20  },
  options_directional: { label: 'Options Directional',    timeframe: 'intraday', pollMs: 5 * 60_000,  barPeriod: '5Min',  barsNeeded: 60  },
  donchian_breakout:   { label: 'Donchian Breakout',       timeframe: 'daily',    pollMs: 60 * 60_000, barPeriod: '1Day',  barsNeeded: 60  },
  // Same Donchian logic, hourly bars instead of daily — holds across hours to
  // ~1-2 days instead of days-to-weeks. Uses the exact same donchianBreakoutSignal
  // function (it's bar-resolution-agnostic), just fed hourly candles with
  // shorter entry/exit windows sized in hours instead of days.
  donchian_hourly:     { label: 'Donchian Breakout (Hourly)', timeframe: 'hourly', pollMs: 15 * 60_000, barPeriod: '1Hour', barsNeeded: 40 },
  macd_crossover:      { label: 'MACD Crossover',          timeframe: 'daily',    pollMs: 60 * 60_000, barPeriod: '1Day',  barsNeeded: 60  },
  // Levels only update once/day (prior day's H/L/C), but polled every
  // 15min like donchian_hourly — the point is catching an intraday S1/R1
  // touch promptly, not re-deriving the levels themselves more often.
  pivot_points:        { label: 'Daily Pivot Points',       timeframe: 'daily',    pollMs: 15 * 60_000, barPeriod: '1Day',  barsNeeded: 30  },
  // No technical entry rule at all — Gemini decides BUY/SELL/HOLD from
  // scratch each cycle off price/RSI/MACD context plus real news, and also
  // supplies its own stop/TP distances. Deliberately experimental: NYSE-
  // hours-gated (timeframe: 'intraday') rather than given the 24h treatment
  // VWAP earned through this session's hardening, since this strategy has
  // no track record yet. Exits are handled entirely by Gemini Position
  // Watch, not a technical exit rule — there isn't one to have.
  // barsNeeded 240 (5 days of 30-min bars) — confirmed live the entry
  // decision had no way to tell a dip inside an intact uptrend apart from a
  // stock still mid-selloff (SanDisk bought on "selloff reversing" 11min
  // before a real continuation of the same post-earnings selloff cut it)
  // with only ~40h of price history to look back on. RSI/MACD/ATR all only
  // read the tail of the bars array, so the extra history is free — doesn't
  // change any existing indicator value, just adds trend context.
  // barPeriod switched 1Hour->30Min: this is leveraged spread betting, not
  // a buy-and-hold — Gemini needs to see actual recent price *shape* at
  // finer-than-hourly resolution (see the candle block added to its prompt
  // in gemini.ts), not just a single hourly-bar-derived RSI/MACD snapshot.
  // RSI/MACD/ATR/efficiency-ratio periods are doubled at every call site
  // that feeds this strategy specifically (igStrategyBot.ts's evaluateEpic,
  // igStrategyScanner.ts's scoreGeminiOpinion) so each indicator still
  // covers the same wall-clock window as before, not half of it.
  gemini_opinion:      { label: 'Gemini Opinion (Experimental)', timeframe: 'intraday', pollMs: 15 * 60_000, barPeriod: '30Min', barsNeeded: 240 },
  // Daily Brief's backtested rule engine (RSI/MACD/SMA/BB + SMA200 trend
  // filter) — see ruleBasedAnalysisSignal above. barsNeeded=250 (a year of
  // trading days) so the SMA200 trend filter is populated in practice, not
  // just technically non-crashing at the bare 200 minimum.
  rule_based_analysis: { label: 'Rule-Based Analysis (Daily Brief)', timeframe: 'daily', pollMs: 60 * 60_000, barPeriod: '1Day', barsNeeded: 250 },
};

// ── RSI(2) mean-reversion + 200-day trend filter ────────────────────────────
// Built 2026-08-28 after real evidence surfaced this exact shape (ported from
// a standalone April 2026 script, bot_ig.py, itself following the Larry
// Connors RSI(2) design) produced a genuine, concentrated run of real wins on
// Japan 225 that month (5/5 trades, +£650.19) — see that investigation for
// the full trail. This is a deliberately different philosophy from every
// other strategy in this codebase, which all chase confirmed momentum
// (buy because it's already moving). This does the opposite: it uses a
// long (200-day) trend filter to establish the *already-known* prevailing
// direction — not a prediction, just a plain average of already-happened
// prices — then times entry on a short-term (2-period RSI) pullback *within*
// that direction. The bet isn't "I predict this trend continues"; it's the
// much narrower "an established multi-month direction is more likely to
// persist through an ordinary few-day wobble than reverse outright," priced
// at a better level than chasing a fresh high/low would give.
//
// Deliberately ported faithfully from bot_ig.py's own validated math rather
// than redesigned from scratch — this is the one thing in the account's
// whole history with a real, concentrated evidence trail behind it.

export type MrBar = { time: string; open: number; high: number; low: number; close: number };

export type MrSignal =
  | {
      action: 'BUY' | 'SELL'; reason: string; stopPoints: number; tpPoints: number;
      // 0-1, real-time per-setup quality — NOT a strategy-level track-record
      // figure (that's edgeSizing's job) and NOT an AI guess. Added
      // 2026-08-31 per explicit request: "SB is not like normal stocks, one
      // trade may go well and another badly... what's correct is based on
      // the situation in realtime and how well-selected a position was."
      // Built from two numbers the signal already computes and previously
      // only used to cross a yes/no line: how extreme the RSI(2) reading is
      // (0.0 = maximally oversold/overbought, just under the RSI_BUY/SELL
      // threshold = barely qualifying) and how strong the established trend
      // is (price's real % distance from EMA200). A signal firing at
      // RSI(2)=0.0 deep in a strong trend IS mechanically a better-selected
      // setup than one that barely scrapes the threshold in a weak one —
      // real information, not invented conviction.
      conviction: number;
    }
  | { action: 'HOLD'; reason: string };

const EMA_TREND      = 200;  // major trend filter — same period as bot_ig.py/backtest_ig.py
const RSI_PERIOD_WIN = 20;   // window fed into calcRsi2 (matches bot_ig.py's closes[-20:])
const RSI_BUY        = 10;   // buy when RSI(2) drops below this (oversold dip in an uptrend)
const RSI_SELL       = 90;   // sell when RSI(2) rises above this (overbought bounce in a downtrend)
const ATR_PERIOD     = 14;
// Widened 2026-08-31 per explicit request — a 2×ATR stop sits close enough
// to entry that ordinary intraday noise (a wick, a brief dip) can touch it
// and lock in a loss on a position that would otherwise have recovered;
// this strategy already expects a real pullback right after entry (it buys
// an oversold dip), so a tight stop is fighting its own thesis. 3×ATR
// gives real room for that to happen before treating it as genuinely
// wrong. TP widened to keep the same 1:2 reward:risk ratio intact rather
// than let the win/loss math drift. Note this is NOT the fix for small
// stakes — calcStake = risk ÷ stopDist, so a WIDER stop actually shrinks
// the resulting £/pt for the same risk budget. That's a separate,
// deliberate lever: maxRiskGbp itself, raised where each bot configures it.
export const ATR_STOP_MULT = 3;
export const ATR_TP_MULT   = 6;   // 1:2 reward:risk — needs only ~33% win rate to break even
export const MAX_HOLD_DAYS = 10;  // backstop, not a target — matches backtest_ig.py
export const MIN_BARS_NEEDED = EMA_TREND + 10;

// EMA seeded with a simple average of the first `period` values, matching
// bot_ig.py's own ema() exactly (not the EMA-from-first-value seeding used
// elsewhere in this codebase, e.g. fxSwingStrategy.ts) — this is the ported
// implementation, kept faithful rather than reconciled with the other one.
function emaSmaSeeded(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const out: number[] = [seed];
  for (let i = period; i < values.length; i++) out.push(values[i] * k + out[out.length - 1] * (1 - k));
  return out;
}

// 2-period RSI — ported exactly from bot_ig.py's rsi2(): computes gain/loss
// across the WHOLE window passed in, but only averages the last 2 — matches
// the original faithfully rather than the more conventional Wilder RSI used
// elsewhere in this codebase.
export function calcRsi2(closes: number[]): number | null {
  if (closes.length < 3) return null;
  const gains: number[] = [], losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }
  const avgGain = gains.length  ? gains.slice(-2).reduce((s, v) => s + v, 0) / 2  : 0;
  const avgLoss = losses.length ? losses.slice(-2).reduce((s, v) => s + v, 0) / 2 : 0;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcAtrFromBars(bars: MrBar[], period = ATR_PERIOD): number | null {
  if (bars.length < period + 1) return null;
  const slice = bars.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const p = slice[i - 1], c = slice[i];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / period;
}

// Pure decision function — no I/O, no state. Given a full daily-bar history
// (oldest first), returns the entry signal or HOLD. Exit/hold-management
// (stop/TP already placed with the broker at entry, MAX_HOLD_DAYS backstop)
// lives in the orchestrator (meanReversionBot.ts), same split as every other
// strategy file in this codebase (fxSwingStrategy.ts, alpacaStrategies.ts).
export function getMeanReversionSignal(bars: MrBar[]): MrSignal {
  if (bars.length < MIN_BARS_NEEDED) {
    return { action: 'HOLD', reason: `Accumulating daily data (${bars.length}/${MIN_BARS_NEEDED})` };
  }
  const closes = bars.map(b => b.close);
  const emaVals = emaSmaSeeded(closes, EMA_TREND);
  if (!emaVals.length) return { action: 'HOLD', reason: 'EMA200 not ready' };
  const currentEma = emaVals[emaVals.length - 1];
  const price       = closes[closes.length - 1];
  const rsi2        = calcRsi2(closes.slice(-RSI_PERIOD_WIN));
  const atr         = calcAtrFromBars(bars);
  if (rsi2 === null || atr === null || atr <= 0) return { action: 'HOLD', reason: 'RSI(2)/ATR not ready' };

  const uptrend   = price > currentEma;
  const downtrend = price < currentEma;

  // Trend-strength component — capped at 20% distance from EMA200 as "as
  // strong as this needs to score"; further than that doesn't mean a
  // better mean-reversion setup, just a more extended one.
  const trendPct = Math.min(1, Math.abs(price - currentEma) / currentEma / 0.20);

  if (uptrend && rsi2 < RSI_BUY) {
    const rsiExtremity = (RSI_BUY - rsi2) / RSI_BUY; // 0 at the threshold, 1 at rsi2=0
    const conviction   = Math.max(0, Math.min(1, (rsiExtremity + trendPct) / 2));
    return {
      action: 'BUY',
      reason: `Uptrend (price ${price.toFixed(2)} > EMA200 ${currentEma.toFixed(2)}) + RSI(2)=${rsi2.toFixed(1)} oversold pullback`,
      stopPoints: atr * ATR_STOP_MULT, tpPoints: atr * ATR_TP_MULT, conviction,
    };
  }
  if (downtrend && rsi2 > RSI_SELL) {
    const rsiExtremity = (rsi2 - RSI_SELL) / (100 - RSI_SELL); // 0 at the threshold, 1 at rsi2=100
    const conviction   = Math.max(0, Math.min(1, (rsiExtremity + trendPct) / 2));
    return {
      action: 'SELL',
      reason: `Downtrend (price ${price.toFixed(2)} < EMA200 ${currentEma.toFixed(2)}) + RSI(2)=${rsi2.toFixed(1)} overbought bounce`,
      stopPoints: atr * ATR_STOP_MULT, tpPoints: atr * ATR_TP_MULT, conviction,
    };
  }
  return {
    action: 'HOLD',
    reason: `No signal — trend=${uptrend ? 'UP' : downtrend ? 'DOWN' : 'FLAT'} RSI(2)=${rsi2.toFixed(1)} (needs <${RSI_BUY} in an uptrend or >${RSI_SELL} in a downtrend)`,
  };
}

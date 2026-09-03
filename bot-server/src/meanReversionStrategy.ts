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

// Trend-invalidation check — added 2026-09-01 per explicit request: "a red
// candle... is more a case you need to stop a loss rather than waiting for
// something to bounce back into profit." This strategy only ever enters
// because price sits on one side of its 200-day trend average (BUY only
// when price > EMA200, SELL only when price < EMA200) — that relationship
// IS the thesis, not a footnote. If price later closes decisively on the
// WRONG side of that same average, the reason the position was opened no
// longer holds, and continuing to wait for the far-out ATR stop is waiting
// on a bounce the strategy's own logic no longer expects. Deliberately NOT
// triggered by an ordinary same-day red candle or routine noise (that
// problem was already fixed elsewhere this session) — only a genuine,
// decisive break of the SAME line the entry was conditioned on. A small
// buffer (0.5%) keeps this from firing on price sitting essentially right
// on the line. Returns null (act as "don't know", never close) when there
// isn't enough data to compute EMA200 at all.
export function trendStillIntact(bars: MrBar[], direction: 'BUY' | 'SELL'): boolean | null {
  if (bars.length < MIN_BARS_NEEDED) return null;
  const closes = bars.map(b => b.close);
  const emaVals = emaSmaSeeded(closes, EMA_TREND);
  if (!emaVals.length) return null;
  const currentEma = emaVals[emaVals.length - 1];
  const price       = closes[closes.length - 1];
  const buffer      = currentEma * 0.005;
  return direction === 'BUY' ? price > currentEma - buffer : price < currentEma + buffer;
}

// Same-day large-adverse-move exit — added 2026-09-01 per explicit request.
// The AI severe-news safety net (askMrSafety, meanReversionBot.ts) already
// covers genuinely bad NEWS days, but a stock can have a real bad day with
// no identifiable news behind it at all (broad risk-off, sector rotation,
// just a heavy tape) — confirmed live this exact gap forced a manual close
// on Intel: the AI correctly found no severe news, but the position kept
// sliding anyway. Per explicit follow-up: "news alone won't cut it...
// knowing the movement... the realtime price will be necessary" — takes
// IG's own live bid/offer as "where things actually are right now" rather
// than trusting a daily bar's own high/low field, which can lag behind the
// real market by however stale that day's Yahoo/Alpaca fetch happens to be.
// Distinct from trendStillIntact (which only fires once the SLOW 200-day
// thesis has actually broken) — this is a FAST, single-day outlier check:
// scaled to the stock's own normal daily range (ATR) rather than a flat
// percentage (the flat-0.5%-for-every-instrument approach is exactly what
// made the old weak-open guard too trigger-happy, closing for pennies on
// completely ordinary noise) — a quiet stock's routine range doesn't
// trigger this, only a genuinely outsized move relative to how that
// specific stock normally trades. Caller decides whether to also require
// the position be at a loss.
const BIG_CANDLE_ATR_MULT = 1.5; // baseline "unusually large" multiplier when a stock is trading at its own normal volatility
const SHORT_VOL_PERIOD    = 5;   // ~a trading week — "how choppy is this stock RIGHT NOW"
const VOL_RATIO_MIN       = 0.5; // clamp — a ratio outside this range is more likely noise in the estimate than a genuine regime shift
const VOL_RATIO_MAX       = 2.5;
const ADAPTIVE_MULT_MIN   = 0.75; // even at maximum "currently very choppy," don't get hair-trigger sensitive
const ADAPTIVE_MULT_MAX   = 3.0;  // even at maximum "currently very calm," still cap how much patience this earns
// Adaptive per-stock volatility scaling — added 2026-09-03 per explicit
// idea: "if ai moves we know its moving big... close, but health... is less
// volatile right now so give it more room." A flat multiplier already
// scaled to each stock's own NORMAL range (ATR), but treated every stock
// the same regardless of whether IT ITSELF is currently more or less
// volatile than its own usual self. This compares a short-term (5-day)
// ATR against the same 14-day baseline already used elsewhere: a stock
// currently trading more volatile than its own recent normal (ratio > 1)
// gets a TIGHTER trigger (a regime shift is real information, worth
// reacting to faster); one trading calmer than its own normal (ratio < 1)
// gets a more PATIENT trigger (nothing unusual is actually happening,
// don't treat routine noise as a crisis). At ratio = 1 (trading exactly at
// its own normal), this returns exactly the original flat 1.5x — no
// behavior change for a stock that isn't currently in an unusual regime
// either way.
function adaptiveBigCandleMult(bars: MrBar[]): number {
  const shortAtr = calcAtrFromBars(bars, SHORT_VOL_PERIOD);
  const longAtr  = calcAtrFromBars(bars);
  if (shortAtr === null || longAtr === null || longAtr <= 0) return BIG_CANDLE_ATR_MULT;
  const volRatio = Math.max(VOL_RATIO_MIN, Math.min(VOL_RATIO_MAX, shortAtr / longAtr));
  return Math.max(ADAPTIVE_MULT_MIN, Math.min(ADAPTIVE_MULT_MAX, BIG_CANDLE_ATR_MULT / volRatio));
}
export function hadBigAdverseCandleToday(bars: MrBar[], direction: 'BUY' | 'SELL', livePrice: number): boolean | null {
  const atr = calcAtrFromBars(bars);
  if (atr === null || atr <= 0 || bars.length < 1) return null;
  // If the freshest bar is today's own (still-forming), yesterday's close
  // is the one before it — otherwise the freshest bar already IS yesterday
  // (e.g. checked before today's fetch has updated yet), and is the right
  // reference on its own.
  const lastBar    = bars[bars.length - 1];
  const isTodayBar = lastBar.time.slice(0, 10) === new Date().toISOString().slice(0, 10);
  const yesterday   = isTodayBar ? bars[bars.length - 2] : lastBar;
  if (!yesterday) return null;
  const adverseMove = direction === 'BUY' ? yesterday.close - livePrice : livePrice - yesterday.close;
  return adverseMove >= adaptiveBigCandleMult(bars) * atr;
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

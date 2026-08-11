import { type CandleTick, calcRsi, calcMacdHist, calcAtr, isRed, isGreen } from './scalperStrategy';

// ── FX swing strategy — hourly bars, hours-scale holds ──────────────────────
// The 5-min scalper (scalperStrategy.ts, left untouched) trades against the
// spread on noise that rarely clears transaction cost. This runs on 1-hour
// candles instead: a trend (EMA20/EMA50) + momentum (MACD/RSI) entry, stops
// and targets sized off 1-hour ATR (naturally tens of points, not ~13), and
// exits driven by the position's own condition rather than a clock — the
// clock is only a last-resort backstop, not the primary exit mechanism.

export type SwingState = 'FLAT' | 'IN_POSITION' | 'COOLDOWN';
export type Trend = 'UP' | 'DOWN' | 'FLAT';

export type SwingIndicatorSnapshot = {
  rsi:     number | null;
  macd:    number | null;
  atr:     number | null;
  emaFast: number | null;
  emaSlow: number | null;
  trend:   Trend;
};

export type SwingDecision =
  | { action: 'ENTER';    direction: 'BUY' | 'SELL'; reason: string; indicators: SwingIndicatorSnapshot }
  | { action: 'EXIT';     reason: string; urgency: 'immediate' | 'on_close' }
  | { action: 'TIGHTEN';  newStopPrice: number; reason: string }
  | { action: 'HOLD';     reason: string }
  | { action: 'WAIT';     reason: string }
  | { action: 'COOLDOWN'; reason: string; untilMs: number };

export type SwingEpicState = {
  epic:                    string;
  state:                   SwingState;
  direction:               'BUY' | 'SELL';
  entryPrice:              number;
  entryTimeMs:             number;
  dealId:                  string;
  size:                    number;
  closedCandles:           CandleTick[];   // 1-hour bars
  formingCandle:           CandleTick | null;
  cooldownUntil:           number;
  dynamicStopPrice:        number;
  takeProfitPrice:         number;
  entryTrend:              Trend;          // the trend that justified entry — invalidation reference
  peakFavorableExcursion:  number;         // best price seen in the position's favor, for stall detection
  lastTightenedAtMs:       number;         // throttle — don't re-tighten every single poll once triggered
  originalStopPoints:      number;         // stop distance at entry, in points — stall detection's yardstick for "has this moved meaningfully"
};

export type SwingConfig = {
  emaFastPeriod:     number;
  emaSlowPeriod:     number;
  atrStopMult:       number;
  atrTpMult:         number;
  minConfidence:     number;
  maxHoldMs:          number;  // hard backstop — last resort, not the primary exit
  stallCheckAfterMs:  number;  // start watching for stall once a position is at least this old
  stallRetraceFrac:   number;  // fraction of peak favorable move given back before treating it as "stalling"
  // A trade that only ever wiggled a few points in profit before flattening
  // out hasn't "stalled" — it never really moved. Confirmed live this
  // mattered: EUR/USD and AUD/USD both got tightened to breakeven ~4.2h in
  // and stopped out for a near-nothing loss 15min later, on completely
  // ordinary pullbacks, well before either trade's real take-profit (2-3×
  // the stop distance away) ever got a fair chance. Stall detection now
  // only engages once the peak favorable move has reached at least this
  // fraction of the original stop distance — a real move worth protecting,
  // not noise.
  stallMinFavorableFrac: number;
  // Tightening to *dead* breakeven is, once spread is priced in, a
  // guaranteed small loss on exit — worse than doing nothing on a trade
  // that hasn't actually reversed. Lock in this fraction of the peak
  // favorable move instead (still meaningfully protective, but a real edge
  // rather than a coin-flip-to-small-loss).
  stallLockInFrac:    number;
  cooldownMs:         number;
};

export const DEFAULT_SWING_CONFIG: SwingConfig = {
  emaFastPeriod:     20,
  emaSlowPeriod:     50,
  atrStopMult:       2.5,
  atrTpMult:         4,
  minConfidence:     60,
  maxHoldMs:          11 * 60 * 60_000,  // ~11h — the outer safety net, not a target
  // Pushed 4h->5h — 4h was less than half the 11h max hold, second-guessing
  // a trade before it's had a real chance to work.
  stallCheckAfterMs:  5  * 60 * 60_000,
  // Raised 0.5->0.65 — require giving back more of the move before reacting.
  stallRetraceFrac:   0.65,
  stallMinFavorableFrac: 0.4,
  stallLockInFrac:    0.3,
  cooldownMs:         25 * 60_000,
};

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  return values.reduce((out: number[], v, i) => {
    out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k));
    return out;
  }, []);
}

function getIndicators(candles: CandleTick[], cfg: SwingConfig): SwingIndicatorSnapshot {
  const closes   = candles.map(c => c.close);
  const emaFastV = closes.length >= cfg.emaFastPeriod ? ema(closes, cfg.emaFastPeriod) : null;
  const emaSlowV = closes.length >= cfg.emaSlowPeriod ? ema(closes, cfg.emaSlowPeriod) : null;
  const emaFast  = emaFastV ? emaFastV[emaFastV.length - 1] : null;
  const emaSlow  = emaSlowV ? emaSlowV[emaSlowV.length - 1] : null;
  const trend: Trend = emaFast !== null && emaSlow !== null
    ? (emaFast > emaSlow ? 'UP' : emaFast < emaSlow ? 'DOWN' : 'FLAT')
    : 'FLAT';
  return { rsi: calcRsi(candles), macd: calcMacdHist(candles), atr: calcAtr(candles), emaFast, emaSlow, trend };
}

export function initSwingEpicState(epic: string): SwingEpicState {
  return {
    epic, state: 'FLAT', direction: 'BUY',
    entryPrice: 0, entryTimeMs: 0, dealId: '', size: 0,
    closedCandles: [], formingCandle: null,
    cooldownUntil: 0, dynamicStopPrice: 0, takeProfitPrice: 0,
    entryTrend: 'FLAT', peakFavorableExcursion: 0, lastTightenedAtMs: 0,
    originalStopPoints: 0,
  };
}

const MIN_CANDLES = 50; // covers EMA50 and MACD's own 35-candle need

export function processSwingTick(
  st:   SwingEpicState,
  tick: CandleTick,
  cfg:  SwingConfig = DEFAULT_SWING_CONFIG,
): SwingDecision {
  const now = Date.now();

  if (st.state === 'COOLDOWN') {
    if (now < st.cooldownUntil) {
      return { action: 'COOLDOWN', reason: `Cooling down — ${Math.round((st.cooldownUntil - now) / 60_000)}min`, untilMs: st.cooldownUntil };
    }
    st.state = 'FLAT';
  }

  st.formingCandle = tick;

  if (tick.candleClosed) {
    st.closedCandles = [...st.closedCandles, tick].slice(-80);

    if (st.state === 'FLAT') {
      if (st.closedCandles.length < MIN_CANDLES) {
        return { action: 'WAIT', reason: `Accumulating hourly data (${st.closedCandles.length}/${MIN_CANDLES})` };
      }

      const ind = getIndicators(st.closedCandles, cfg);
      if (ind.emaFast === null || ind.emaSlow === null) return { action: 'WAIT', reason: 'Indicators not ready' };

      if (ind.trend === 'UP' && tick.close > ind.emaFast) {
        const rsiOk  = ind.rsi === null  || ind.rsi < 70;
        const macdOk = ind.macd === null || ind.macd > 0;
        if (!rsiOk)  return { action: 'WAIT', reason: `Uptrend but RSI ${ind.rsi?.toFixed(0)} overbought. Waiting.` };
        if (!macdOk) return { action: 'WAIT', reason: `Uptrend but MACD not confirming (${ind.macd?.toFixed(4)}). Waiting.` };
        st.state = 'IN_POSITION'; st.direction = 'BUY'; st.entryTrend = 'UP';
        return {
          action: 'ENTER', direction: 'BUY',
          reason: `Uptrend (EMA${cfg.emaFastPeriod}>EMA${cfg.emaSlowPeriod}), price above EMA${cfg.emaFastPeriod}, RSI=${ind.rsi?.toFixed(0) ?? 'N/A'} MACD=${ind.macd !== null ? (ind.macd > 0 ? '+' : '') + ind.macd.toFixed(4) : 'N/A'}`,
          indicators: ind,
        };
      }

      if (ind.trend === 'DOWN' && tick.close < ind.emaFast) {
        const rsiOk  = ind.rsi === null  || ind.rsi > 30;
        const macdOk = ind.macd === null || ind.macd < 0;
        if (!rsiOk)  return { action: 'WAIT', reason: `Downtrend but RSI ${ind.rsi?.toFixed(0)} oversold. Waiting.` };
        if (!macdOk) return { action: 'WAIT', reason: `Downtrend but MACD not confirming (${ind.macd?.toFixed(4)}). Waiting.` };
        st.state = 'IN_POSITION'; st.direction = 'SELL'; st.entryTrend = 'DOWN';
        return {
          action: 'ENTER', direction: 'SELL',
          reason: `Downtrend (EMA${cfg.emaFastPeriod}<EMA${cfg.emaSlowPeriod}), price below EMA${cfg.emaFastPeriod}, RSI=${ind.rsi?.toFixed(0) ?? 'N/A'} MACD=${ind.macd !== null ? (ind.macd > 0 ? '+' : '') + ind.macd.toFixed(4) : 'N/A'}`,
          indicators: ind,
        };
      }

      return { action: 'WAIT', reason: `No trend/momentum agreement (trend=${ind.trend}). Waiting.` };
    }

    // ── IN_POSITION: signal invalidation — the thesis broke, exit regardless of P&L ──
    if (st.state === 'IN_POSITION' && st.closedCandles.length >= MIN_CANDLES) {
      const ind = getIndicators(st.closedCandles, cfg);
      const isLong = st.direction === 'BUY';
      const invalidated = isLong ? ind.trend === 'DOWN' : ind.trend === 'UP';
      if (invalidated) {
        st.state = 'COOLDOWN'; st.cooldownUntil = now + cfg.cooldownMs;
        st.entryPrice = 0; st.dynamicStopPrice = 0; st.takeProfitPrice = 0;
        return { action: 'EXIT', reason: `Trend reversed (now ${ind.trend}) — entry thesis invalidated`, urgency: 'immediate' };
      }
    }
  }

  // ── IN_POSITION: price-level checks + stall/time management — every poll, not just candle close ──
  if (st.state === 'IN_POSITION' && st.entryPrice > 0) {
    const isLong = st.direction === 'BUY';
    const price  = tick.bidClose;

    if (st.peakFavorableExcursion === 0) st.peakFavorableExcursion = st.entryPrice;
    st.peakFavorableExcursion = isLong
      ? Math.max(st.peakFavorableExcursion, price)
      : Math.min(st.peakFavorableExcursion, price);

    if (st.takeProfitPrice > 0) {
      const tpHit = isLong ? price >= st.takeProfitPrice : price <= st.takeProfitPrice;
      if (tpHit) {
        const pnl = isLong ? price - st.entryPrice : st.entryPrice - price;
        st.state = 'COOLDOWN'; st.cooldownUntil = now + cfg.cooldownMs;
        st.entryPrice = 0; st.dynamicStopPrice = 0; st.takeProfitPrice = 0;
        return { action: 'EXIT', reason: `✅ Take profit hit +${pnl.toFixed(2)} pts`, urgency: 'immediate' };
      }
    }

    if (st.dynamicStopPrice > 0) {
      const stopHit = isLong ? price <= st.dynamicStopPrice : price >= st.dynamicStopPrice;
      if (stopHit) {
        const loss = isLong ? st.entryPrice - price : price - st.entryPrice;
        st.state = 'COOLDOWN'; st.cooldownUntil = now + cfg.cooldownMs;
        st.entryPrice = 0; st.dynamicStopPrice = 0; st.takeProfitPrice = 0;
        return { action: 'EXIT', reason: `Stop hit −${loss.toFixed(2)} pts @ ${price.toFixed(2)}`, urgency: 'immediate' };
      }
    }

    const ageMs = now - st.entryTimeMs;

    // Stall detection — only once the trade's had real time to work, and only
    // acts if (a) it actually made a meaningful move worth protecting in the
    // first place, not just idle chop near entry with nothing to give back,
    // and (b) it's genuinely given back a large chunk of that move. Confirmed
    // live the old version (any peak favorable move, 50% giveback, tighten to
    // dead breakeven) reacted to completely ordinary pullbacks and converted
    // promising trades into near-guaranteed small losses once spread was
    // priced in, well before their real take-profit ever got a fair chance.
    if (ageMs >= cfg.stallCheckAfterMs && now - st.lastTightenedAtMs > 30 * 60_000) {
      const peakFavorablePts = isLong ? st.peakFavorableExcursion - st.entryPrice : st.entryPrice - st.peakFavorableExcursion;
      const currentPts       = isLong ? price - st.entryPrice : st.entryPrice - price;
      const madeARealMove    = st.originalStopPoints > 0 && peakFavorablePts >= st.originalStopPoints * cfg.stallMinFavorableFrac;
      if (madeARealMove && currentPts < peakFavorablePts * (1 - cfg.stallRetraceFrac)) {
        // Lock in a fraction of the peak favorable move rather than flat
        // breakeven — still meaningfully protective, but a real edge instead
        // of a coin-flip-to-small-loss once spread is accounted for.
        const lockInPts = peakFavorablePts * cfg.stallLockInFrac;
        const newStop   = isLong ? st.entryPrice + lockInPts : st.entryPrice - lockInPts;
        const wouldTighten = isLong ? newStop > st.dynamicStopPrice : newStop < st.dynamicStopPrice;
        if (wouldTighten) {
          st.dynamicStopPrice = newStop;
          st.lastTightenedAtMs = now;
          return {
            action: 'TIGHTEN', newStopPrice: newStop,
            reason: `Stalling after ${(ageMs / 3_600_000).toFixed(1)}h — gave back ${(cfg.stallRetraceFrac * 100).toFixed(0)}%+ of its ${peakFavorablePts.toFixed(1)}pt best move, locked in ${lockInPts.toFixed(1)}pt`,
          };
        }
      }
    }

    // Outer backstop — only fires if nothing else has resolved the trade by now.
    if (ageMs >= cfg.maxHoldMs) {
      const pnl = isLong ? price - st.entryPrice : st.entryPrice - price;
      st.state = 'COOLDOWN'; st.cooldownUntil = now + cfg.cooldownMs;
      st.entryPrice = 0; st.dynamicStopPrice = 0; st.takeProfitPrice = 0;
      return { action: 'EXIT', reason: `Max hold ${(cfg.maxHoldMs / 3_600_000).toFixed(0)}h reached (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} pts) — closing as a backstop, not a target`, urgency: 'on_close' };
    }

    const pnl = isLong ? price - st.entryPrice : st.entryPrice - price;
    return { action: 'HOLD', reason: `${isLong ? '▲ LONG' : '▼ SHORT'} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} pts, ${(ageMs / 3_600_000).toFixed(1)}h open. Holding.` };
  }

  return { action: 'HOLD', reason: 'Waiting for signal.' };
}

export function recordSwingFill(
  st:         SwingEpicState,
  fillPrice:  number,
  stopPoints: number,
  tpPoints:   number,
): void {
  st.entryPrice             = fillPrice;
  st.entryTimeMs            = Date.now();
  st.peakFavorableExcursion = fillPrice;
  st.lastTightenedAtMs      = 0;
  st.originalStopPoints     = stopPoints;
  if (st.direction === 'BUY') {
    st.dynamicStopPrice = stopPoints > 0 ? fillPrice - stopPoints : 0;
    st.takeProfitPrice  = tpPoints   > 0 ? fillPrice + tpPoints   : 0;
  } else {
    st.dynamicStopPrice = stopPoints > 0 ? fillPrice + stopPoints : 0;
    st.takeProfitPrice  = tpPoints   > 0 ? fillPrice - tpPoints   : 0;
  }
}

export { isRed, isGreen };

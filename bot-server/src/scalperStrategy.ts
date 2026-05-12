export type CandleTick = {
  epic:         string;
  time:         string;
  open:         number;
  high:         number;
  low:          number;
  close:        number;
  bidClose:     number;
  offerClose:   number;
  candleClosed: boolean;
};

export type ScalperState = 'FLAT' | 'IN_POSITION' | 'COOLDOWN';

export type IndicatorSnapshot = {
  rsi:        number | null;
  macd:       number | null;
  atr:        number | null;
  greenCount: number;
};

export type ScalperDecision =
  | { action: 'ENTER';    direction: 'BUY' | 'SELL'; reason: string; indicators: IndicatorSnapshot }
  | { action: 'EXIT';     reason: string; urgency: 'immediate' | 'on_close' }
  | { action: 'HOLD';     reason: string }
  | { action: 'WAIT';     reason: string }
  | { action: 'COOLDOWN'; reason: string; untilMs: number };

export type ScalperEpicState = {
  epic:             string;
  state:            ScalperState;
  direction:        'BUY' | 'SELL';   // current position direction
  entryPrice:       number;
  entryTime:        string;
  dealId:           string;           // IG dealId — set on entry, used to close without polling
  size:             number;           // position size — set on entry, used to close
  closedCandles:    CandleTick[];
  formingCandle:    CandleTick | null;
  cooldownUntil:    number;
  consecutiveReds:  number;
  consecutiveGreens: number;
  dynamicStopPrice: number;           // absolute stop price level (0 = use pct)
  takeProfitPrice:  number;           // absolute TP price level (0 = no TP)
};

export type ScalperConfig = {
  stopLossPct:   number;
  tinyBodyPct:   number;
  cooldownMs:    number;
  maxRsiEntry:   number;
  atrStopMult:   number;
  minConfidence: number;
};

export const DEFAULT_CONFIG: ScalperConfig = {
  stopLossPct:   1.0,           // 1% hard stop — 5-min candles have larger swings
  tinyBodyPct:   0.15,          // noise filter body threshold for 5-min candles
  cooldownMs:    30 * 60_000,   // 30-min cooldown = 6 candles before re-entry
  maxRsiEntry:   65,            // more conservative than before (was 70)
  atrStopMult:   2.0,           // 2× ATR gives more breathing room on 5-min
  minConfidence: 60,
};

// ── Indicators ────────────────────────────────────────────────────────────────

function bodyPct(c: CandleTick): number {
  if (c.open === 0) return 0;
  return Math.abs(c.close - c.open) / c.open * 100;
}
export function isRed(c: CandleTick)   { return c.close < c.open; }
export function isGreen(c: CandleTick) { return c.close >= c.open; }

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  return values.reduce((out: number[], v, i) => {
    out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k));
    return out;
  }, []);
}

export function calcRsi(candles: CandleTick[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const closes = candles.slice(-(period + 1)).map(c => c.close);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + (gain / period) / (loss / period));
}

export function calcMacdHist(candles: CandleTick[]): number | null {
  if (candles.length < 35) return null;
  const closes   = candles.map(c => c.close);
  const macdLine = ema(closes, 12).map((v, i) => v - ema(closes, 26)[i]);
  const signal   = ema(macdLine, 9);
  return macdLine[macdLine.length - 1] - signal[signal.length - 1];
}

export function calcAtr(candles: CandleTick[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const p = slice[i - 1], c = slice[i];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / period;
}

function getIndicators(candles: CandleTick[]): IndicatorSnapshot {
  return {
    rsi:        calcRsi(candles),
    macd:       calcMacdHist(candles),
    atr:        calcAtr(candles),
    greenCount: candles.slice(-5).filter(isGreen).length,
  };
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initEpicState(epic: string): ScalperEpicState {
  return {
    epic, state: 'FLAT', direction: 'BUY',
    entryPrice: 0, entryTime: '', dealId: '', size: 0,
    closedCandles: [], formingCandle: null,
    cooldownUntil: 0, consecutiveReds: 0, consecutiveGreens: 0,
    dynamicStopPrice: 0, takeProfitPrice: 0,
  };
}

// ── Main processor ────────────────────────────────────────────────────────────

export function processTick(
  st:   ScalperEpicState,
  tick: CandleTick,
  cfg:  ScalperConfig = DEFAULT_CONFIG,
): ScalperDecision {
  const now = Date.now();

  if (st.state === 'COOLDOWN') {
    if (now < st.cooldownUntil) {
      return { action: 'COOLDOWN', reason: `Cooling down — ${Math.round((st.cooldownUntil - now) / 1000)}s`, untilMs: st.cooldownUntil };
    }
    st.state = 'FLAT';
    st.consecutiveReds = 0;
    st.consecutiveGreens = 0;
  }

  st.formingCandle = tick;

  if (tick.candleClosed) {
    st.closedCandles = [...st.closedCandles, tick].slice(-40);
    if (isRed(tick))   { st.consecutiveReds++;   st.consecutiveGreens = 0; }
    else               { st.consecutiveGreens++; st.consecutiveReds   = 0; }

    // ── IN_POSITION exit logic ─────────────────────────────────────────────
    if (st.state === 'IN_POSITION') {
      const isLong = st.direction === 'BUY';

      // Three consecutive 5-min candles in wrong direction → exit (was 2 at 1-min; 5-min are less noisy)
      const wrongDir = isLong ? st.consecutiveReds >= 3 : st.consecutiveGreens >= 3;
      if (wrongDir) {
        st.state = 'FLAT'; // no cooldown — ready to enter opposite direction on next candle
        st.entryPrice = 0; st.dynamicStopPrice = 0; st.takeProfitPrice = 0;
        return {
          action: 'EXIT',
          reason: `${isLong ? st.consecutiveReds + ' reds' : st.consecutiveGreens + ' greens'} — momentum reversed, flip ready`,
          urgency: 'on_close',
        };
      }

      const wrongCandle = isLong ? isRed(tick) : isGreen(tick);
      if (wrongCandle) {
        const body = bodyPct(tick);
        const rsi  = calcRsi(st.closedCandles);
        // Noise filter
        if (body < cfg.tinyBodyPct && rsi !== null && rsi >= 35 && rsi <= 65) {
          return { action: 'HOLD', reason: `Noise candle (${body.toFixed(2)}%) RSI ${rsi.toFixed(0)} — holding.` };
        }
        st.state = 'FLAT'; st.entryPrice = 0; st.dynamicStopPrice = 0; st.takeProfitPrice = 0;
        return { action: 'EXIT', reason: `${isLong ? 'Red' : 'Green'} candle (${body.toFixed(2)}%). Exiting ${isLong ? 'LONG' : 'SHORT'}.`, urgency: 'on_close' };
      }

      const pnl = st.entryPrice > 0
        ? isLong
          ? (tick.close - st.entryPrice) / st.entryPrice * 100
          : (st.entryPrice - tick.close) / st.entryPrice * 100
        : 0;
      return { action: 'HOLD', reason: `${isLong ? '▲' : '▼'} ${isLong ? 'LONG' : 'SHORT'} P&L ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)}%. Holding.` };
    }

    // ── FLAT entry logic ───────────────────────────────────────────────────
    if (st.state === 'FLAT') {
      // Need full MACD window (26 candles = ~2h at 5-min) before trusting indicators
      if (st.closedCandles.length < 26) {
        return { action: 'WAIT', reason: `Accumulating data (${st.closedCandles.length}/26 candles)` };
      }

      const ind = getIndicators(st.closedCandles);

      // BUY: require 2+ consecutive green candles (momentum confirmed), RSI in
      // the recovery zone (not overbought, not still falling), MACD not bearish.
      if (isGreen(tick) && st.consecutiveGreens >= 2) {
        const rsiOk  = ind.rsi === null || (ind.rsi >= 38 && ind.rsi < cfg.maxRsiEntry);
        const macdOk = ind.macd === null || ind.macd > -0.0002 * tick.close;
        if (!rsiOk)  return { action: 'WAIT', reason: `${st.consecutiveGreens}× green but RSI ${ind.rsi?.toFixed(0)} outside zone (38–${cfg.maxRsiEntry}). Waiting.` };
        if (!macdOk) return { action: 'WAIT', reason: `${st.consecutiveGreens}× green but MACD bearish (${ind.macd?.toFixed(4)}). Waiting.` };
        st.state = 'IN_POSITION'; st.direction = 'BUY'; st.entryTime = tick.time;
        return { action: 'ENTER', direction: 'BUY', reason: `${st.consecutiveGreens}× green streak. RSI=${ind.rsi?.toFixed(0) ?? 'N/A'} MACD=${ind.macd !== null ? (ind.macd > 0 ? '+' : '') + ind.macd.toFixed(4) : 'N/A'}`, indicators: ind };
      }

      // SELL: require 2+ consecutive red candles, RSI in the distribution zone
      // (not oversold, not still rising), MACD not bullish.
      if (isRed(tick) && st.consecutiveReds >= 2) {
        const minRsi = 100 - cfg.maxRsiEntry;  // e.g. 35
        const rsiOk  = ind.rsi === null || (ind.rsi > minRsi && ind.rsi <= 62);
        const macdOk = ind.macd === null || ind.macd < 0.0002 * tick.close;
        if (!rsiOk)  return { action: 'WAIT', reason: `${st.consecutiveReds}× red but RSI ${ind.rsi?.toFixed(0)} outside zone (${minRsi}–62). Waiting.` };
        if (!macdOk) return { action: 'WAIT', reason: `${st.consecutiveReds}× red but MACD bullish (${ind.macd?.toFixed(4)}). Waiting.` };
        st.state = 'IN_POSITION'; st.direction = 'SELL'; st.entryTime = tick.time;
        return { action: 'ENTER', direction: 'SELL', reason: `${st.consecutiveReds}× red streak. RSI=${ind.rsi?.toFixed(0) ?? 'N/A'} MACD=${ind.macd !== null ? (ind.macd > 0 ? '+' : '') + ind.macd.toFixed(4) : 'N/A'}`, indicators: ind };
      }
    }
  }

  // ── Intrabar stops ────────────────────────────────────────────────────────
  if (st.state === 'IN_POSITION' && st.entryPrice > 0) {
    const isLong = st.direction === 'BUY';
    const price  = tick.bidClose;

    // Take profit hit
    if (st.takeProfitPrice > 0) {
      const tpHit = isLong ? price >= st.takeProfitPrice : price <= st.takeProfitPrice;
      if (tpHit) {
        const pnl = isLong ? price - st.entryPrice : st.entryPrice - price;
        st.state = 'FLAT'; st.entryPrice = 0; st.dynamicStopPrice = 0; st.takeProfitPrice = 0;
        return { action: 'EXIT', reason: `✅ Take profit hit +${pnl.toFixed(2)} pts`, urgency: 'immediate' };
      }
    }

    // Dynamic stop hit
    if (st.dynamicStopPrice > 0) {
      const stopHit = isLong ? price <= st.dynamicStopPrice : price >= st.dynamicStopPrice;
      if (stopHit) {
        const loss = isLong ? st.entryPrice - price : price - st.entryPrice;
        st.state = 'FLAT'; st.entryPrice = 0; st.dynamicStopPrice = 0; st.takeProfitPrice = 0;
        return { action: 'EXIT', reason: `Stop hit −${loss.toFixed(2)} pts @ ${price.toFixed(2)}`, urgency: 'immediate' };
      }
    }

    // Fallback pct stop
    const lossPct = isLong
      ? (st.entryPrice - price) / st.entryPrice * 100
      : (price - st.entryPrice) / st.entryPrice * 100;
    if (lossPct >= cfg.stopLossPct) {
      st.state = 'FLAT'; st.entryPrice = 0; st.dynamicStopPrice = 0; st.takeProfitPrice = 0;
      return { action: 'EXIT', reason: `Stop loss ${lossPct.toFixed(3)}% ≥ ${cfg.stopLossPct}%`, urgency: 'immediate' };
    }

    // Two-candle intrabar reversal
    const prevClosed = st.closedCandles[st.closedCandles.length - 1];
    if (prevClosed) {
      const prevWrong = isLong ? isRed(prevClosed)   : isGreen(prevClosed);
      const currWrong = isLong ? isRed(tick)          : isGreen(tick);
      if (prevWrong && currWrong && bodyPct(tick) >= cfg.tinyBodyPct) {
        st.state = 'FLAT'; st.entryPrice = 0; st.dynamicStopPrice = 0; st.takeProfitPrice = 0;
        return { action: 'EXIT', reason: `Intrabar two-candle reversal.`, urgency: 'immediate' };
      }
    }
  }

  return {
    action: 'HOLD',
    reason: st.state === 'IN_POSITION'
      ? `${st.direction === 'BUY' ? '▲ LONG' : '▼ SHORT'} — watching.`
      : `Waiting for signal.`,
  };
}

export function recordFill(
  st:         ScalperEpicState,
  fillPrice:  number,
  stopPoints: number,
  tpPoints:   number,
) {
  st.entryPrice = fillPrice;
  st.entryTime  = new Date().toISOString();
  // Set absolute stop and TP based on Gemini-supplied points
  if (st.direction === 'BUY') {
    st.dynamicStopPrice = stopPoints > 0 ? fillPrice - stopPoints : 0;
    st.takeProfitPrice  = tpPoints   > 0 ? fillPrice + tpPoints   : 0;
  } else {
    st.dynamicStopPrice = stopPoints > 0 ? fillPrice + stopPoints : 0;
    st.takeProfitPrice  = tpPoints   > 0 ? fillPrice - tpPoints   : 0;
  }
}

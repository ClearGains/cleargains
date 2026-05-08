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

export type ScalperDecision =
  | { action: 'ENTER';    reason: string }
  | { action: 'EXIT';     reason: string; urgency: 'immediate' | 'on_close' }
  | { action: 'HOLD';     reason: string }
  | { action: 'WAIT';     reason: string }
  | { action: 'COOLDOWN'; reason: string; untilMs: number };

export type ScalperEpicState = {
  epic:             string;
  state:            ScalperState;
  entryPrice:       number;
  entryTime:        string;
  closedCandles:    CandleTick[];
  formingCandle:    CandleTick | null;
  cooldownUntil:    number;
  consecutiveReds:  number;
};

export type ScalperConfig = {
  stopLossPct:  number;
  tinyBodyPct:  number;
  cooldownMs:   number;
  maxRsiEntry:  number;
};

export const DEFAULT_CONFIG: ScalperConfig = {
  stopLossPct:  0.5,
  tinyBodyPct:  0.08,
  cooldownMs:   15 * 60_000,
  maxRsiEntry:  70,
};

function bodyPct(c: CandleTick): number {
  if (c.open === 0) return 0;
  return Math.abs(c.close - c.open) / c.open * 100;
}
function isRed(c: CandleTick)   { return c.close < c.open; }
function isGreen(c: CandleTick) { return c.close >= c.open; }

function quickRsi(candles: CandleTick[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const closes = candles.slice(-(period + 1)).map(c => c.close);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = (gain / period) / (loss / period);
  return 100 - 100 / (1 + rs);
}

export function initEpicState(epic: string): ScalperEpicState {
  return {
    epic,
    state:           'FLAT',
    entryPrice:      0,
    entryTime:       '',
    closedCandles:   [],
    formingCandle:   null,
    cooldownUntil:   0,
    consecutiveReds: 0,
  };
}

export function processTick(
  st:  ScalperEpicState,
  tick: CandleTick,
  cfg: ScalperConfig = DEFAULT_CONFIG,
): ScalperDecision {
  const now = Date.now();

  if (st.state === 'COOLDOWN') {
    if (now < st.cooldownUntil) {
      const secsLeft = Math.round((st.cooldownUntil - now) / 1000);
      return { action: 'COOLDOWN', reason: `Cooling down — ${secsLeft}s remaining`, untilMs: st.cooldownUntil };
    }
    st.state = 'FLAT';
    st.consecutiveReds = 0;
  }

  st.formingCandle = tick;

  if (tick.candleClosed) {
    st.closedCandles = [...st.closedCandles, tick].slice(-10);

    if (isRed(tick)) st.consecutiveReds++;
    else             st.consecutiveReds = 0;

    if (st.state === 'IN_POSITION') {
      if (st.consecutiveReds >= 2) {
        st.state         = 'COOLDOWN';
        st.cooldownUntil = now + cfg.cooldownMs;
        st.entryPrice    = 0;
        return {
          action:  'EXIT',
          reason:  `${st.consecutiveReds} consecutive reds — entering ${cfg.cooldownMs / 60_000} min cooldown.`,
          urgency: 'on_close',
        };
      }

      if (isRed(tick)) {
        const body = bodyPct(tick);
        const rsi  = quickRsi(st.closedCandles);
        if (body < cfg.tinyBodyPct && rsi !== null && rsi >= 35 && rsi <= 60) {
          return { action: 'HOLD', reason: `Tiny red (body ${body.toFixed(2)}%) — noise. RSI ${rsi.toFixed(0)}. Holding.` };
        }
        st.state      = 'FLAT';
        st.entryPrice = 0;
        return { action: 'EXIT', reason: `Red candle (body ${body.toFixed(2)}%). Exiting.`, urgency: 'on_close' };
      }

      const pnlPct = st.entryPrice > 0 ? (tick.close - st.entryPrice) / st.entryPrice * 100 : 0;
      return { action: 'HOLD', reason: `Green candle — P&L ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(3)}%. Holding.` };
    }

    if (st.state === 'FLAT') {
      if (isGreen(tick)) {
        const rsi = quickRsi(st.closedCandles);
        if (rsi !== null && rsi >= cfg.maxRsiEntry) {
          return { action: 'WAIT', reason: `Green candle but RSI ${rsi.toFixed(0)} overbought. Waiting.` };
        }
        st.state     = 'IN_POSITION';
        st.entryTime = tick.time;
        return { action: 'ENTER', reason: `Green candle close. RSI ${rsi !== null ? rsi.toFixed(0) : 'N/A'}. Entering BUY.` };
      }
      return { action: 'WAIT', reason: `Red candle — staying flat. Consecutive reds: ${st.consecutiveReds}.` };
    }
  }

  if (st.state === 'IN_POSITION' && st.entryPrice > 0) {
    const lossFromEntry = (st.entryPrice - tick.bidClose) / st.entryPrice * 100;
    if (lossFromEntry >= cfg.stopLossPct) {
      st.state      = 'FLAT';
      st.entryPrice = 0;
      return {
        action:  'EXIT',
        reason:  `Intrabar loss ${lossFromEntry.toFixed(3)}% ≥ ${cfg.stopLossPct}% stop. Closing immediately.`,
        urgency: 'immediate',
      };
    }

    const prevClosed = st.closedCandles[st.closedCandles.length - 1];
    if (prevClosed && isRed(prevClosed) && isRed(tick) && bodyPct(tick) >= cfg.tinyBodyPct) {
      st.state      = 'FLAT';
      st.entryPrice = 0;
      return {
        action:  'EXIT',
        reason:  `Intrabar red after previous red close — two-red exit.`,
        urgency: 'immediate',
      };
    }
  }

  return {
    action: 'HOLD',
    reason: st.state === 'IN_POSITION' ? `Watching — ${isRed(tick) ? 'forming red' : 'forming green'}.` : `Waiting for green candle close.`,
  };
}

export function recordFill(st: ScalperEpicState, fillPrice: number) {
  st.entryPrice = fillPrice;
  st.entryTime  = new Date().toISOString();
}

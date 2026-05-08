'use client';

import type { CandleTick } from './useIGStream';

export type ScalperState = 'FLAT' | 'IN_POSITION' | 'COOLDOWN';

export type ScalperDecision =
  | { action: 'ENTER';   reason: string }
  | { action: 'EXIT';    reason: string; urgency: 'immediate' | 'on_close' }
  | { action: 'HOLD';    reason: string }
  | { action: 'WAIT';    reason: string }    // FLAT, waiting for entry conditions
  | { action: 'COOLDOWN'; reason: string; untilMs: number };

export type ScalperEpicState = {
  epic:          string;
  state:         ScalperState;
  entryPrice:    number;          // 0 when FLAT
  entryTime:     string;
  closedCandles: CandleTick[];    // last 5 completed candles
  formingCandle: CandleTick | null;
  cooldownUntil: number;          // epoch ms, 0 = not cooling
  consecutiveReds: number;        // reset on green
};

export type ScalperConfig = {
  stopLossPct:      number;   // default 0.5 — exit immediately if loss ≥ this %
  tinyBodyPct:      number;   // default 0.08 — ignore red candles smaller than this (noise)
  cooldownMs:       number;   // default 15 min — pause after 2 consecutive reds
  maxRsiEntry:      number;   // default 70 — don't enter if RSI ≥ this
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

// Simple RSI from last N closed candles (need ≥15 candles for RSI14)
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

/**
 * Called on every Lightstreamer tick for an epic.
 * Returns a decision + mutates state in-place.
 */
export function processTick(
  st:     ScalperEpicState,
  tick:   CandleTick,
  cfg:    ScalperConfig = DEFAULT_CONFIG,
): ScalperDecision {
  const now = Date.now();

  // ── COOLDOWN check ──────────────────────────────────────────────────────────
  if (st.state === 'COOLDOWN') {
    if (now < st.cooldownUntil) {
      const secsLeft = Math.round((st.cooldownUntil - now) / 1000);
      return { action: 'COOLDOWN', reason: `Cooling down after consecutive reds — ${secsLeft}s remaining`, untilMs: st.cooldownUntil };
    }
    // Cooldown expired → back to FLAT
    st.state = 'FLAT';
    st.consecutiveReds = 0;
  }

  // Update forming candle
  st.formingCandle = tick;

  if (tick.candleClosed) {
    // ── Candle just closed ────────────────────────────────────────────────────
    st.closedCandles = [...st.closedCandles, tick].slice(-10);  // keep last 10

    if (isRed(tick)) {
      st.consecutiveReds++;
    } else {
      st.consecutiveReds = 0;
    }

    if (st.state === 'IN_POSITION') {
      // ── Exit logic on candle close ──────────────────────────────────────────

      // Two consecutive reds → definitive reversal, enter cooldown
      if (st.consecutiveReds >= 2) {
        st.state         = 'COOLDOWN';
        st.cooldownUntil = now + cfg.cooldownMs;
        st.entryPrice    = 0;
        return {
          action:  'EXIT',
          reason:  `${st.consecutiveReds} consecutive red candles — definitive reversal. Entering ${cfg.cooldownMs / 60_000} min cooldown.`,
          urgency: 'on_close',
        };
      }

      // Single red candle
      if (isRed(tick)) {
        const body = bodyPct(tick);

        // Tiny body (noise) with neutral RSI → hold one more candle
        const rsi = quickRsi(st.closedCandles);
        if (body < cfg.tinyBodyPct && rsi !== null && rsi >= 35 && rsi <= 60) {
          return {
            action: 'HOLD',
            reason: `Tiny red candle (body ${body.toFixed(2)}%) — likely noise. RSI ${rsi.toFixed(0)} neutral. Holding.`,
          };
        }

        // Meaningful red candle → exit
        st.state      = 'FLAT';
        st.entryPrice = 0;
        return {
          action:  'EXIT',
          reason:  `Red candle closed (body ${body.toFixed(2)}%). Exiting to protect profit.`,
          urgency: 'on_close',
        };
      }

      // Green candle closed while in position → hold
      const currentPnlPct = st.entryPrice > 0
        ? (tick.close - st.entryPrice) / st.entryPrice * 100
        : 0;
      return {
        action: 'HOLD',
        reason: `Green candle — P&L ${currentPnlPct >= 0 ? '+' : ''}${currentPnlPct.toFixed(3)}%. Holding.`,
      };
    }

    if (st.state === 'FLAT') {
      // ── Entry logic on candle close ─────────────────────────────────────────
      if (isGreen(tick)) {
        const rsi = quickRsi(st.closedCandles);

        // Don't enter into overbought
        if (rsi !== null && rsi >= cfg.maxRsiEntry) {
          return {
            action: 'WAIT',
            reason: `Green candle but RSI ${rsi.toFixed(0)} overbought (≥${cfg.maxRsiEntry}). Waiting.`,
          };
        }

        // Green close, RSI acceptable → ENTER on next candle open
        // (caller should place the order; entry price will be set when order fills)
        st.state     = 'IN_POSITION';
        st.entryTime = tick.time;
        // entryPrice set by caller after order fill
        return {
          action: 'ENTER',
          reason: `Green candle close. RSI ${rsi !== null ? rsi.toFixed(0) : 'N/A'}. Entering BUY.`,
        };
      }

      // Red candle while flat → stay out
      return {
        action: 'WAIT',
        reason: `Red candle — staying flat. Consecutive reds: ${st.consecutiveReds}.`,
      };
    }
  }

  // ── Intrabar check (forming candle) ──────────────────────────────────────────
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

    // Intrabar: already red AND previous closed candle was also red
    const prevClosed = st.closedCandles[st.closedCandles.length - 1];
    if (prevClosed && isRed(prevClosed) && isRed(tick)) {
      const body = bodyPct(tick);
      if (body >= cfg.tinyBodyPct) {
        st.state      = 'FLAT';
        st.entryPrice = 0;
        return {
          action:  'EXIT',
          reason:  `Intrabar red candle after previous red close — two-red exit. Closing immediately.`,
          urgency: 'immediate',
        };
      }
    }
  }

  // No action needed on this tick
  return {
    action: 'HOLD',
    reason: st.state === 'IN_POSITION'
      ? `Watching — ${isRed(tick) ? 'forming red' : 'forming green'}.`
      : `Waiting for green candle close.`,
  };
}

// Called by the UI when an order fill comes back — records the actual fill price
export function recordFill(st: ScalperEpicState, fillPrice: number) {
  st.entryPrice = fillPrice;
  st.entryTime  = new Date().toISOString();
}

// ── Backtest engine (server copy) ────────────────────────────────────────────
// Mirrors lib/backtest.ts in the Next.js app — kept as a separate copy here
// the same way scalperStrategy.ts is duplicated, since bot-server has its own
// build/package and doesn't import from the app's lib/. Keep both in sync when
// strategy rules change.
//
// Simulation rules (deliberately conservative):
//  - One position at a time per symbol, full allocated equity per trade.
//  - Stops/take-profits are checked intrabar; if a bar touches BOTH the stop
//    and the target, the STOP is assumed to fill first (pessimistic).
//  - Slippage is charged on both entry and exit.
//  - Signals are computed on the bar CLOSE and filled at the next bar's open
//    (no look-ahead).

import { ruleBasedAnalysis } from './ruleBasedAnalysis';
import { MIN_SWING_CONFIDENCE, MIN_DAILY_EFFICIENCY_RATIO, calcEfficiencyRatio } from './alpacaStrategies';

export type BTBar = { t: string; o: number; h: number; l: number; c: number; v: number };

// ── IG universe ────────────────────────────────────────────────────────────
export type AssetClass = 'fx' | 'index' | 'commodity' | 'crypto' | 'share';

export const BT_UNIVERSE: Record<AssetClass, { label: string; symbol: string }[]> = {
  fx: [
    { label: 'GBP/USD', symbol: 'GBPUSD=X' },
    { label: 'EUR/USD', symbol: 'EURUSD=X' },
    { label: 'EUR/GBP', symbol: 'EURGBP=X' },
    { label: 'USD/JPY', symbol: 'JPY=X' },
    { label: 'AUD/USD', symbol: 'AUDUSD=X' },
  ],
  index: [
    { label: 'FTSE 100',   symbol: '^FTSE' },
    { label: 'S&P 500',    symbol: '^GSPC' },
    { label: 'NASDAQ 100', symbol: '^IXIC' },
    { label: 'Germany 40', symbol: '^GDAXI' },
    { label: 'Wall Street', symbol: '^DJI' },
    { label: 'Japan 225',  symbol: '^N225' },
  ],
  commodity: [
    { label: 'Gold',        symbol: 'GC=F' },
    { label: 'Oil (WTI)',   symbol: 'CL=F' },
    { label: 'Brent Crude', symbol: 'BZ=F' },
    { label: 'Silver',      symbol: 'SI=F' },
    { label: 'Natural Gas', symbol: 'NG=F' },
  ],
  crypto: [
    { label: 'Bitcoin',  symbol: 'BTC-USD' },
    { label: 'Ethereum', symbol: 'ETH-USD' },
  ],
  share: [
    { label: 'AAPL', symbol: 'AAPL' }, { label: 'MSFT', symbol: 'MSFT' },
    { label: 'NVDA', symbol: 'NVDA' }, { label: 'TSLA', symbol: 'TSLA' },
    { label: 'AMZN', symbol: 'AMZN' }, { label: 'META', symbol: 'META' },
    { label: 'GOOGL', symbol: 'GOOGL' }, { label: 'AMD', symbol: 'AMD' },
    { label: 'NFLX', symbol: 'NFLX' }, { label: 'PLTR', symbol: 'PLTR' },
    { label: 'COIN', symbol: 'COIN' }, { label: 'SNAP', symbol: 'SNAP' },
    { label: 'SOFI', symbol: 'SOFI' }, { label: 'RIVN', symbol: 'RIVN' },
    { label: 'F', symbol: 'F' }, { label: 'BAC', symbol: 'BAC' },
    { label: 'JPM', symbol: 'JPM' }, { label: 'XOM', symbol: 'XOM' },
    { label: 'CVX', symbol: 'CVX' }, { label: 'UBER', symbol: 'UBER' },
    { label: 'NIO', symbol: 'NIO' }, { label: 'INTC', symbol: 'INTC' },
    { label: 'T', symbol: 'T' }, { label: 'VZ', symbol: 'VZ' },
    { label: 'LLOY.L', symbol: 'LLOY.L' }, { label: 'BARC.L', symbol: 'BARC.L' },
    { label: 'VOD.L', symbol: 'VOD.L' }, { label: 'BP.L', symbol: 'BP.L' },
    { label: 'SHEL.L', symbol: 'SHEL.L' }, { label: 'AZN.L', symbol: 'AZN.L' },
    { label: 'GSK.L', symbol: 'GSK.L' }, { label: 'HSBA.L', symbol: 'HSBA.L' },
    { label: 'RR.L', symbol: 'RR.L' }, { label: 'NWG.L', symbol: 'NWG.L' },
  ],
};

/** All universe symbols flattened, deduped. */
export const BT_UNIVERSE_SYMBOLS: string[] = Array.from(
  new Set(Object.values(BT_UNIVERSE).flat().map(x => x.symbol)),
);

function assetClassOf(symbol: string): AssetClass {
  for (const [cls, list] of Object.entries(BT_UNIVERSE)) {
    if (list.some(x => x.symbol === symbol)) return cls as AssetClass;
  }
  if (symbol.endsWith('=X')) return 'fx';
  if (symbol.endsWith('-USD')) return 'crypto';
  if (symbol.endsWith('=F')) return 'commodity';
  if (symbol.startsWith('^')) return 'index';
  return 'share';
}

// Rough, illustrative per-side spread costs by asset class — NOT pulled from
// IG's live pricing. FX majors run tight; shares and crypto run wider.
export const BT_DEFAULT_SPREAD_BPS: Record<AssetClass, number> = {
  fx: 3, index: 4, commodity: 5, crypto: 15, share: 8,
};

export function defaultSpreadBpsFor(symbol: string): number {
  return BT_DEFAULT_SPREAD_BPS[assetClassOf(symbol)];
}

export type BTStrategy =
  | 'rsi_mean_reversion'
  | 'ema_crossover'
  | 'vwap'
  | 'orb'
  | 'weekly_momentum'
  | 'ratchet_streak'
  | 'donchian_breakout'
  | 'macd_crossover'
  | 'rule_based_analysis';

export const BT_STRATEGY_LABELS: Record<BTStrategy, string> = {
  rsi_mean_reversion: 'RSI Mean Reversion (5-min)',
  ema_crossover:      'EMA Crossover (daily)',
  rule_based_analysis: 'Rule-Based Analysis (Daily Brief)',
  vwap:               'VWAP Reversion (5-min)',
  orb:                'Opening Range Breakout (5-min)',
  weekly_momentum:    'Weekly Momentum (daily→weekly)',
  ratchet_streak:     'Ratchet Streak (5-min)',
  donchian_breakout:  'Donchian Breakout (daily)',
  macd_crossover:     'MACD Crossover (daily)',
};

export type BTParams = {
  // shared
  slippageBps:   number;  // per side, e.g. 2 = 0.02%
  allowShorts:   boolean;
  // Overnight financing — spread bets are leveraged, so every calendar day a
  // position stays open costs (benchmark rate + broker markup) on the full
  // notional, not just the stake at risk. Estimated annualized rate.
  financingAnnualPct: number;
  // rsi_mean_reversion
  rsiPeriod:     number;
  rsiBuy:        number;  // enter long below
  rsiSell:       number;  // enter short above
  rsiExitLong:   number;  // close long above
  rsiExitShort:  number;  // close short below
  atrStopMult:   number;
  atrTpMult:     number;
  // ema_crossover
  emaFast:       number;
  emaSlow:       number;
  // vwap
  vwapEntryPct:  number;  // % below/above session VWAP to enter
  // orb
  orbBreakoutPct: number; // % beyond range to confirm breakout
  // weekly_momentum
  trailPct:      number;  // trailing stop %
  // ratchet_streak
  ratchetTpAtrMult:      number;  // take-profit distance per leg, in ATR
  ratchetStopAtrMult:    number;  // stop distance on the first leg of a streak, in ATR
  ratchetTightenAtrMult: number;  // stop tightens by this many ATR per additional winning leg
  ratchetMinStopAtrMult: number;  // floor so the tightened stop never vanishes
  // donchian_breakout
  donchianEntryPeriod:  number;  // N-day high/low breakout to enter
  donchianExitPeriod:   number;  // N-day opposite breakout to exit (Turtle-style)
  // macd_crossover
  macdAtrStopMult:      number;  // stop distance, in ATR
  macdAtrTpMult:         number;  // take-profit distance, in ATR
};

export const BT_DEFAULT_PARAMS: BTParams = {
  slippageBps: 2, allowShorts: false, financingAnnualPct: 7.5,
  rsiPeriod: 14, rsiBuy: 30, rsiSell: 70, rsiExitLong: 60, rsiExitShort: 40,
  atrStopMult: 1.5, atrTpMult: 3,
  emaFast: 9, emaSlow: 21,
  vwapEntryPct: 0.5,
  orbBreakoutPct: 0.2,
  trailPct: 5,
  ratchetTpAtrMult: 0.5, ratchetStopAtrMult: 0.5,
  ratchetTightenAtrMult: 0.15, ratchetMinStopAtrMult: 0.15,
  donchianEntryPeriod: 20, donchianExitPeriod: 10,
  macdAtrStopMult: 2, macdAtrTpMult: 5,
};

export type BTTrade = {
  side:       'long' | 'short';
  entryTime:  string;
  exitTime:   string;
  entryPrice: number;
  exitPrice:  number;
  retPct:     number;   // net of slippage
  exitReason: string;
};

export type BTStats = {
  trades:          number;
  winRate:         number;   // %
  profitFactor:    number;   // gross wins / gross losses (Infinity-safe)
  totalReturnPct:  number;   // compounded
  maxDrawdownPct:  number;
  avgWinPct:       number;
  avgLossPct:      number;
  avgHoldBars:     number;
};

export type BTResult = {
  symbol:      string;
  strategy:    BTStrategy;
  bars:        number;
  firstBar:    string;
  lastBar:     string;
  trades:      BTTrade[];
  stats:       BTStats;
  equityCurve: { t: string; equity: number }[];  // equity multiple, starts at 1
};

// ── Indicators ────────────────────────────────────────────────────────────────

function calcRsiAt(closes: number[], i: number, period: number): number | null {
  if (i < period) return null;
  let gains = 0, losses = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const d = closes[k] - closes[k - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function calcAtrAt(bars: BTBar[], i: number, period = 14): number | null {
  if (i < period) return null;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const b = bars[k], p = bars[k - 1];
    sum += Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
  }
  return sum / period;
}

// MACD histogram series (12/26/9) — same construction as the bots
function macdHistSeries(closes: number[]): (number | null)[] {
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const macdLine: (number | null)[] = closes.map((_, i) =>
    e12[i] !== null && e26[i] !== null ? (e12[i]! - e26[i]!) : null
  );
  const firstIdx = macdLine.findIndex(v => v !== null);
  if (firstIdx === -1) return closes.map(() => null);
  const valid = macdLine.slice(firstIdx) as number[];
  const sig = emaSeries(valid, 9);
  return closes.map((_, i) => {
    const j = i - firstIdx;
    if (j < 0 || sig[j] === null) return null;
    return valid[j] - sig[j]!;
  });
}

// ── Core simulator ───────────────────────────────────────────────────────────

type OpenPos = {
  side:      'long' | 'short';
  entryIdx:  number;
  entryPrice: number;
  stop:      number | null;
  tp:        number | null;
  peak:      number;          // for trailing stops
  financingDays: number;      // calendar days held overnight — see closeAt
};

type StepSignal =
  | { action: 'enter'; side: 'long' | 'short'; stop: number | null; tp: number | null }
  | { action: 'exit'; reason: string }
  | { action: 'none' };

// What the last closed trade was and why it closed — lets a strategy tell a
// take-profit exit (continue the streak) apart from a stop-loss exit (cool
// down), which it can't infer from `pos` alone since that's only ever null
// or the CURRENT open position.
type LastExit = { side: 'long' | 'short'; reason: string } | null;

function runSim(
  bars: BTBar[],
  params: BTParams,
  signalAt: (i: number, pos: OpenPos | null, lastExit: LastExit) => StepSignal,
  opts: { forceEodExit?: boolean; trailPct?: number } = {},
): { trades: BTTrade[]; equityCurve: { t: string; equity: number }[]; holds: number[] } {
  const slip = params.slippageBps / 10_000;
  const trades: BTTrade[] = [];
  const equityCurve: { t: string; equity: number }[] = [];
  const holds: number[] = [];
  let equity = 1;
  let pos: OpenPos | null = null;
  let pendingEntry: { side: 'long' | 'short'; stop: number | null; tp: number | null } | null = null;
  let pendingExit: string | null = null;
  let lastExit: LastExit = null;

  const closeAt = (i: number, price: number, reason: string) => {
    if (!pos) return;
    const exitPx = pos.side === 'long' ? price * (1 - slip) : price * (1 + slip);
    const entryPx = pos.entryPrice;
    const rawRet = pos.side === 'long' ? exitPx / entryPx - 1 : entryPx / exitPx - 1;
    // Overnight financing — charged regardless of direction (broker markup
    // applies both ways), on every calendar day the position stayed open.
    const financingCost = (params.financingAnnualPct / 100 / 365) * pos.financingDays;
    const ret = rawRet - financingCost;
    equity *= 1 + ret;
    trades.push({
      side: pos.side, entryTime: bars[pos.entryIdx].t, exitTime: bars[i].t,
      entryPrice: entryPx, exitPrice: exitPx, retPct: ret * 100, exitReason: reason,
    });
    holds.push(i - pos.entryIdx);
    lastExit = { side: pos.side, reason };
    pos = null;
  };

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];

    // Day boundary while holding — one overnight financing charge, whether
    // the bars are 5-min (only counts once per calendar day, not per bar)
    // or daily (one charge per bar, i.e. every night held).
    if (pos && bars[i].t.slice(0, 10) !== bars[i - 1].t.slice(0, 10)) {
      pos.financingDays++;
    }

    // 1. Fill pending orders at this bar's open (signals from previous close)
    if (pendingExit && pos) { closeAt(i, b.o, pendingExit); pendingExit = null; }
    if (pendingEntry && !pos) {
      const px = pendingEntry.side === 'long' ? b.o * (1 + slip) : b.o * (1 - slip);
      pos = { side: pendingEntry.side, entryIdx: i, entryPrice: px, stop: pendingEntry.stop, tp: pendingEntry.tp, peak: b.o, financingDays: 0 };
      pendingEntry = null;
    }

    // 2. Intrabar stop / take-profit (stop first — pessimistic)
    if (pos) {
      pos.peak = pos.side === 'long' ? Math.max(pos.peak, b.h) : Math.min(pos.peak, b.l);
      const trail = opts.trailPct
        ? (pos.side === 'long' ? pos.peak * (1 - opts.trailPct / 100) : pos.peak * (1 + opts.trailPct / 100))
        : null;
      const effStop = pos.side === 'long'
        ? Math.max(pos.stop ?? -Infinity, trail ?? -Infinity)
        : Math.min(pos.stop ?? Infinity, trail ?? Infinity);

      if (pos.side === 'long') {
        if (isFinite(effStop) && b.l <= effStop) { closeAt(i, Math.min(effStop, b.o), 'stop'); }
        else if (pos.tp !== null && b.h >= pos.tp) { closeAt(i, Math.max(pos.tp, b.o), 'take-profit'); }
      } else {
        if (isFinite(effStop) && b.h >= effStop) { closeAt(i, Math.max(effStop, b.o), 'stop'); }
        else if (pos.tp !== null && b.l <= pos.tp) { closeAt(i, Math.min(pos.tp, b.o), 'take-profit'); }
      }
    }

    // 3. Strategy signal on this bar's close → fills next bar
    const sig = signalAt(i, pos, lastExit);
    lastExit = null;  // consumed — only offered for the one bar right after a close
    if (sig.action === 'exit' && pos) pendingExit = sig.reason;
    if (sig.action === 'enter' && !pos && (sig.side === 'long' || params.allowShorts)) {
      pendingEntry = { side: sig.side, stop: sig.stop, tp: sig.tp };
    }

    // 4. Force end-of-day exit for intraday strategies; also drop any entry
    //    signal generated on the last bar of the session (it belongs to today)
    if (opts.forceEodExit && i + 1 < bars.length &&
        bars[i + 1].t.slice(0, 10) !== b.t.slice(0, 10)) {
      if (pos) closeAt(i, b.c, 'end of day');
      pendingEntry = null;
      pendingExit  = null;
    }

    // Mark-to-market equity — includes financing accrued so far, not just
    // price movement, so a position still open at the end of the data (or
    // mid-simulation drawdown) doesn't understate the real holding cost.
    const mtm = pos !== null
      ? equity * (1 + ((pos as OpenPos).side === 'long'
          ? b.c / (pos as OpenPos).entryPrice - 1
          : (pos as OpenPos).entryPrice / b.c - 1)
          - (params.financingAnnualPct / 100 / 365) * (pos as OpenPos).financingDays)
      : equity;
    equityCurve.push({ t: b.t, equity: mtm });
  }

  // Liquidate any open position at the final close
  if (pos !== null) closeAt(bars.length - 1, bars[bars.length - 1].c, 'end of data');

  return { trades, equityCurve, holds };
}

// ── Strategy step functions ───────────────────────────────────────────────────

function makeRsiMeanReversion(bars: BTBar[], p: BTParams) {
  const closes = bars.map(b => b.c);
  const hist = macdHistSeries(closes);
  return (i: number, pos: OpenPos | null): StepSignal => {
    const rsi = calcRsiAt(closes, i, p.rsiPeriod);
    const atr = calcAtrAt(bars, i);
    if (rsi === null || atr === null) return { action: 'none' };
    if (pos) {
      if (pos.side === 'long' && rsi > p.rsiExitLong)  return { action: 'exit', reason: `RSI ${rsi.toFixed(0)}` };
      if (pos.side === 'short' && rsi < p.rsiExitShort) return { action: 'exit', reason: `RSI ${rsi.toFixed(0)}` };
      return { action: 'none' };
    }
    const h = hist[i], hp = hist[i - 1];
    const eps = closes[i] * 1e-9;
    const up   = h === null || hp === null || h >= hp - eps || h > 0;
    const down = h === null || hp === null || h <= hp + eps || h < 0;
    const c = closes[i];
    if (rsi < p.rsiBuy && up)
      return { action: 'enter', side: 'long', stop: c - atr * p.atrStopMult, tp: c + atr * p.atrTpMult };
    if (rsi > p.rsiSell && down)
      return { action: 'enter', side: 'short', stop: c + atr * p.atrStopMult, tp: c - atr * p.atrTpMult };
    return { action: 'none' };
  };
}

function makeEmaCrossover(bars: BTBar[], p: BTParams) {
  const closes = bars.map(b => b.c);
  const fast = emaSeries(closes, p.emaFast);
  const slow = emaSeries(closes, p.emaSlow);
  return (i: number, pos: OpenPos | null): StepSignal => {
    const f = fast[i], fp = fast[i - 1], s = slow[i], sp = slow[i - 1];
    if (f === null || fp === null || s === null || sp === null) return { action: 'none' };
    const up   = fp <= sp && f > s;
    const down = fp >= sp && f < s;
    const atr  = calcAtrAt(bars, i) ?? closes[i] * 0.01;
    if (pos) {
      if (pos.side === 'long' && down) return { action: 'exit', reason: 'bear cross' };
      if (pos.side === 'short' && up)  return { action: 'exit', reason: 'bull cross' };
      return { action: 'none' };
    }
    if (up)   return { action: 'enter', side: 'long',  stop: closes[i] - atr * 2, tp: closes[i] + atr * 5 };
    if (down) return { action: 'enter', side: 'short', stop: closes[i] + atr * 2, tp: closes[i] - atr * 5 };
    return { action: 'none' };
  };
}

function makeVwap(bars: BTBar[], p: BTParams) {
  // Session-cumulative VWAP, reset each trading day
  const vwap: number[] = new Array(bars.length);
  let day = '', cumTPV = 0, cumVol = 0;
  for (let i = 0; i < bars.length; i++) {
    const d = bars[i].t.slice(0, 10);
    if (d !== day) { day = d; cumTPV = 0; cumVol = 0; }
    const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
    cumTPV += tp * bars[i].v; cumVol += bars[i].v;
    vwap[i] = cumVol > 0 ? cumTPV / cumVol : bars[i].c;
  }
  const closes = bars.map(b => b.c);
  return (i: number, pos: OpenPos | null): StepSignal => {
    const v = vwap[i], c = closes[i];
    const rsi = calcRsiAt(closes, i, 14);
    const atr = calcAtrAt(bars, i) ?? c * 0.003;
    const pct = (c - v) / v * 100;
    if (pos) {
      if (pos.side === 'long') {
        if (c >= v)          return { action: 'exit', reason: 'reverted to VWAP' };
        if (c < v * 0.99)    return { action: 'exit', reason: 'stretched >1% below VWAP' };
      } else {
        if (c <= v)          return { action: 'exit', reason: 'reverted to VWAP' };
        if (c > v * 1.01)    return { action: 'exit', reason: 'stretched >1% above VWAP' };
      }
      return { action: 'none' };
    }
    if (pct < -p.vwapEntryPct && (rsi === null || rsi < 45))
      return { action: 'enter', side: 'long', stop: Math.min(c - atr * 1.2, v * 0.99), tp: v };
    if (pct > p.vwapEntryPct && (rsi === null || rsi > 55))
      return { action: 'enter', side: 'short', stop: Math.max(c + atr * 1.2, v * 1.01), tp: v };
    return { action: 'none' };
  };
}

function makeOrb(bars: BTBar[], p: BTParams) {
  // Opening range = first 30 minutes of each day (six 5-min bars)
  const rangeByDay = new Map<string, { high: number; low: number; readyIdx: number }>();
  let day = '', count = 0, hi = 0, lo = Infinity;
  for (let i = 0; i < bars.length; i++) {
    const d = bars[i].t.slice(0, 10);
    if (d !== day) { day = d; count = 0; hi = 0; lo = Infinity; }
    if (count < 6) {
      hi = Math.max(hi, bars[i].h); lo = Math.min(lo, bars[i].l);
      count++;
      if (count === 6) rangeByDay.set(d, { high: hi, low: lo, readyIdx: i });
    }
  }
  // One breakout trade per direction per day — otherwise the strategy
  // re-enters every bar while price sits beyond the range
  const traded = new Set<string>();
  return (i: number, pos: OpenPos | null): StepSignal => {
    const d = bars[i].t.slice(0, 10);
    const orb = rangeByDay.get(d);
    if (!orb || i <= orb.readyIdx || orb.high <= orb.low) return { action: 'none' };
    const c = bars[i].c;
    const range = orb.high - orb.low;
    const mid = orb.low + range / 2;
    if (pos) {
      if (pos.side === 'long'  && c < mid) return { action: 'exit', reason: 'below ORB midpoint' };
      if (pos.side === 'short' && c > mid) return { action: 'exit', reason: 'above ORB midpoint' };
      return { action: 'none' };
    }
    if (c > orb.high * (1 + p.orbBreakoutPct / 100) && !traded.has(`${d}:long`)) {
      traded.add(`${d}:long`);
      return { action: 'enter', side: 'long', stop: mid, tp: orb.high + range * 2 };
    }
    if (c < orb.low * (1 - p.orbBreakoutPct / 100) && !traded.has(`${d}:short`)) {
      traded.add(`${d}:short`);
      return { action: 'enter', side: 'short', stop: mid, tp: orb.low - range * 2 };
    }
    return { action: 'none' };
  };
}

// ── Ratchet Streak ──────────────────────────────────────────────────────────
// Seed a direction off an EMA9/21 cross. On a take-profit exit, immediately
// re-enter the same direction (chase the continuation) with a tighter stop
// each leg, so a reversal only gives back the most recent leg's gain rather
// than the whole streak. On a stop-loss exit, stop opening that direction
// until the seed signal flips to the opposite side.
function makeRatchetStreak(bars: BTBar[], p: BTParams) {
  const closes = bars.map(b => b.c);
  const fast = emaSeries(closes, 9);
  const slow = emaSeries(closes, 21);

  let cooldownSide: 'long' | 'short' | null = null;  // blocked direction, cleared on a flip
  let legCount = 0;                                    // consecutive wins in the current streak

  return (i: number, pos: OpenPos | null, lastExit: LastExit): StepSignal => {
    const atr = calcAtrAt(bars, i);
    if (atr === null) return { action: 'none' };
    const c = closes[i];

    if (pos) return { action: 'none' };  // exits are purely stop/tp driven, checked by the simulator

    // Just closed — decide whether to continue the streak or cool down
    if (lastExit) {
      if (lastExit.reason === 'take-profit') {
        legCount++;
        const stopMult = Math.max(p.ratchetMinStopAtrMult, p.ratchetStopAtrMult - legCount * p.ratchetTightenAtrMult);
        return lastExit.side === 'long'
          ? { action: 'enter', side: 'long',  stop: c - atr * stopMult, tp: c + atr * p.ratchetTpAtrMult }
          : { action: 'enter', side: 'short', stop: c + atr * stopMult, tp: c - atr * p.ratchetTpAtrMult };
      }
      if (lastExit.reason === 'stop') {
        cooldownSide = lastExit.side;
        legCount = 0;
      }
    }

    // Seed / re-seed direction off an EMA cross — blocked while it agrees
    // with the side that just stopped out, until it flips the other way
    const f = fast[i], fp = fast[i - 1], s = slow[i], sp = slow[i - 1];
    if (f === null || fp === null || s === null || sp === null) return { action: 'none' };
    const up   = fp <= sp && f > s;
    const down = fp >= sp && f < s;

    if (up && cooldownSide !== 'long') {
      cooldownSide = null;
      return { action: 'enter', side: 'long', stop: c - atr * p.ratchetStopAtrMult, tp: c + atr * p.ratchetTpAtrMult };
    }
    if (down && cooldownSide !== 'short') {
      cooldownSide = null;
      return { action: 'enter', side: 'short', stop: c + atr * p.ratchetStopAtrMult, tp: c - atr * p.ratchetTpAtrMult };
    }
    return { action: 'none' };
  };
}

// ── Donchian / Turtle-style Breakout (daily) ─────────────────────────────────
function makeDonchianBreakout(bars: BTBar[], p: BTParams) {
  return (i: number, pos: OpenPos | null): StepSignal => {
    const entryLook = bars.slice(Math.max(0, i - p.donchianEntryPeriod), i);
    const exitLook  = bars.slice(Math.max(0, i - p.donchianExitPeriod), i);
    if (entryLook.length < p.donchianEntryPeriod) return { action: 'none' };

    const c = bars[i].c;
    const entryHigh = Math.max(...entryLook.map(b => b.h));
    const entryLow  = Math.min(...entryLook.map(b => b.l));
    const exitHigh  = Math.max(...exitLook.map(b => b.h));
    const exitLow   = Math.min(...exitLook.map(b => b.l));
    const atr = calcAtrAt(bars, i) ?? c * 0.015;

    if (pos) {
      if (pos.side === 'long'  && c < exitLow)  return { action: 'exit', reason: `Broke below ${p.donchianExitPeriod}-day low` };
      if (pos.side === 'short' && c > exitHigh) return { action: 'exit', reason: `Broke above ${p.donchianExitPeriod}-day high` };
      return { action: 'none' };
    }

    if (c > entryHigh) {
      return { action: 'enter', side: 'long', stop: c - atr * 2, tp: null };
    }
    if (c < entryLow) {
      return { action: 'enter', side: 'short', stop: c + atr * 2, tp: null };
    }
    return { action: 'none' };
  };
}

// ── Rule-Based Analysis (Daily Brief's swing engine, ported) ────────────────
// Same engine as alpacaStrategies.ts's ruleBasedAnalysisSignal, adapted to
// this simulator's incremental (bar, position) contract instead of a fresh
// bars array per call. Recomputes the full indicator set on a growing
// slice at every bar — O(n) per bar, O(n²) total — same cost profile the
// standalone walk-forward backtest already accepted for this same engine.
function makeRuleBasedAnalysis(bars: BTBar[], p: BTParams) {
  return (i: number, pos: OpenPos | null): StepSignal => {
    if (i < 210) return { action: 'none' }; // needs ~200 bars for SMA200 to populate — see ruleBasedAnalysis's own trend filter
    const slice = bars.slice(0, i + 1).map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
    let analysis;
    try { analysis = ruleBasedAnalysis('', slice); } catch { return { action: 'none' }; }
    const swing = analysis.swing;

    if (pos) {
      if (pos.side === 'long'  && swing.direction !== 'LONG')  return { action: 'exit', reason: 'Thesis no longer bullish' };
      if (pos.side === 'short' && swing.direction !== 'SHORT') return { action: 'exit', reason: 'Thesis no longer bearish' };
      return { action: 'none' };
    }

    // Same confidence floor ruleBasedAnalysisSignal applies live — kept in
    // sync via the shared MIN_SWING_CONFIDENCE constant rather than
    // duplicated, so this simulates the actual live strategy, not a
    // gate-less version of it.
    if (swing.confidence < MIN_SWING_CONFIDENCE) return { action: 'none' };
    // Same chop gate as live — kept in sync via the shared constant, same
    // reasoning as MIN_SWING_CONFIDENCE above.
    const efficiencyRatio = calcEfficiencyRatio(bars.slice(0, i + 1), 20);
    if (efficiencyRatio !== null && efficiencyRatio < MIN_DAILY_EFFICIENCY_RATIO) return { action: 'none' };
    if (swing.direction === 'LONG')  return { action: 'enter', side: 'long',  stop: swing.stopLoss, tp: swing.takeProfit1 };
    if (swing.direction === 'SHORT') return { action: 'enter', side: 'short', stop: swing.stopLoss, tp: swing.takeProfit1 };
    return { action: 'none' };
  };
}

// ── MACD Signal-Line Crossover (daily) ───────────────────────────────────────
function makeMacdCrossover(bars: BTBar[], p: BTParams) {
  const closes = bars.map(b => b.c);
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLine: (number | null)[] = closes.map((_, idx) =>
    ema12[idx] !== null && ema26[idx] !== null ? ema12[idx]! - ema26[idx]! : null
  );
  const firstIdx = macdLine.findIndex(v => v !== null);
  const validMacd = firstIdx === -1 ? [] : (macdLine.slice(firstIdx) as number[]);
  const signalSeries = emaSeries(validMacd, 9);

  const macdAt = (idx: number): number | null => idx < firstIdx ? null : macdLine[idx];
  const signalAt = (idx: number): number | null => {
    if (firstIdx === -1) return null;
    const j = idx - firstIdx;
    return j < 0 || j >= signalSeries.length ? null : signalSeries[j];
  };

  return (i: number, pos: OpenPos | null): StepSignal => {
    const m = macdAt(i), mp = macdAt(i - 1), s = signalAt(i), sp = signalAt(i - 1);
    if (m === null || mp === null || s === null || sp === null) return { action: 'none' };
    const crossedAbove = mp <= sp && m > s;
    const crossedBelow = mp >= sp && m < s;
    const atr = calcAtrAt(bars, i) ?? closes[i] * 0.015;
    const c = closes[i];

    if (pos) {
      if (pos.side === 'long'  && crossedBelow) return { action: 'exit', reason: 'MACD crossed below signal' };
      if (pos.side === 'short' && crossedAbove) return { action: 'exit', reason: 'MACD crossed above signal' };
      return { action: 'none' };
    }

    if (crossedAbove) {
      return { action: 'enter', side: 'long', stop: c - atr * p.macdAtrStopMult, tp: c + atr * p.macdAtrTpMult };
    }
    if (crossedBelow) {
      return { action: 'enter', side: 'short', stop: c + atr * p.macdAtrStopMult, tp: c - atr * p.macdAtrTpMult };
    }
    return { action: 'none' };
  };
}

/** Resample daily bars into ISO-week bars (Mon-anchored). */
export function resampleWeekly(daily: BTBar[]): BTBar[] {
  const weeks: BTBar[] = [];
  let cur: BTBar | null = null;
  let curKey = '';
  for (const b of daily) {
    const dt = new Date(b.t);
    // ISO week key: year + week number via Thursday trick
    const th = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
    th.setUTCDate(th.getUTCDate() + 3 - ((th.getUTCDay() + 6) % 7));
    const key = `${th.getUTCFullYear()}-${Math.round((th.getTime() - Date.UTC(th.getUTCFullYear(), 0, 4)) / 604_800_000)}`;
    if (key !== curKey) {
      if (cur) weeks.push(cur);
      cur = { ...b };
      curKey = key;
    } else if (cur) {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
      cur.t = cur.t; // keep week's first bar timestamp
    }
  }
  if (cur) weeks.push(cur);
  return weeks;
}

function makeWeeklyMomentum(daily: BTBar[], p: BTParams) {
  // Precompute weekly context for each daily index
  const weekly = resampleWeekly(daily);
  const weeklyCloses = weekly.map(w => w.c);
  // Map each daily bar to the index of the last COMPLETED week (no look-ahead)
  const weekStartTimes = weekly.map(w => new Date(w.t).getTime());
  const closes = daily.map(b => b.c);
  return (i: number, pos: OpenPos | null): StepSignal => {
    const t = new Date(daily[i].t).getTime();
    // Last week whose start is before the current week's start
    let wIdx = -1;
    for (let w = weekly.length - 1; w >= 0; w--) {
      if (weekStartTimes[w] <= t) { wIdx = w - 1; break; }  // w is current (incomplete) week
    }
    if (wIdx < 12) return { action: 'none' };
    const wCloses = weeklyCloses.slice(0, wIdx + 1);
    const sma12 = wCloses.slice(-12).reduce((a, b) => a + b, 0) / 12;
    const rsi = calcRsiAt(wCloses, wCloses.length - 1, 14);
    const last = wCloses[wCloses.length - 1];
    const prev4 = wCloses[wCloses.length - 5] ?? last;
    const mom = (last - prev4) / prev4 * 100;
    if (pos) {
      if (last < sma12 * 0.97) return { action: 'exit', reason: 'below 97% of 12w SMA' };
      return { action: 'none' };  // trailing stop handled by simulator
    }
    if (last > sma12 && mom > 1 && rsi !== null && rsi >= 50 && rsi <= 70) {
      const atr = calcAtrAt(daily, i) ?? closes[i] * 0.015;
      return { action: 'enter', side: 'long', stop: closes[i] - atr * 4, tp: null };
    }
    return { action: 'none' };
  };
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function computeStats(trades: BTTrade[], equityCurve: { t: string; equity: number }[], holds: number[]): BTStats {
  const wins   = trades.filter(t => t.retPct > 0);
  const losses = trades.filter(t => t.retPct <= 0);
  const grossWin  = wins.reduce((s, t) => s + t.retPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.retPct, 0));
  let peak = 1, maxDd = 0;
  for (const pt of equityCurve) {
    peak = Math.max(peak, pt.equity);
    maxDd = Math.max(maxDd, (peak - pt.equity) / peak);
  }
  const finalEq = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : 1;
  return {
    trades:         trades.length,
    winRate:        trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor:   grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0),
    totalReturnPct: (finalEq - 1) * 100,
    maxDrawdownPct: maxDd * 100,
    avgWinPct:      wins.length ? grossWin / wins.length : 0,
    avgLossPct:     losses.length ? grossLoss / losses.length : 0,
    avgHoldBars:    holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : 0,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Which bar interval each strategy needs from the data source. */
export const BT_DATA_NEEDS: Record<BTStrategy, { interval: '5m' | '1d'; range: string }> = {
  rsi_mean_reversion: { interval: '5m', range: '60d' },
  vwap:               { interval: '5m', range: '60d' },
  orb:                { interval: '5m', range: '60d' },
  ema_crossover:      { interval: '1d', range: '2y' },
  weekly_momentum:    { interval: '1d', range: '5y' },
  ratchet_streak:     { interval: '5m', range: '60d' },
  donchian_breakout:  { interval: '1d', range: '2y' },
  macd_crossover:     { interval: '1d', range: '2y' },
  // Needs ~200+ daily bars for its SMA200 trend filter to actually be
  // populated — the plain 2y other daily strategies use is already enough.
  rule_based_analysis: { interval: '1d', range: '2y' },
};

// ── Walk-forward validation ───────────────────────────────────────────────────
// Tune parameters on the first `trainFrac` of the data, then evaluate the
// winning combination on the untouched remainder. If a parameter set only
// works on the data it was tuned on, it's curve-fit — the test split exposes
// that before real money does.

const WF_GRIDS: Record<BTStrategy, Partial<BTParams>[]> = (() => {
  const grids: Record<BTStrategy, Partial<BTParams>[]> = {
    rsi_mean_reversion: [],
    ema_crossover: [],
    vwap: [],
    orb: [],
    weekly_momentum: [],
    ratchet_streak: [],
    donchian_breakout: [],
    macd_crossover: [],
    rule_based_analysis: [], // no tunable params of its own — fixed rule, not parameterized
  };
  for (const rsiBuy of [20, 25, 30])
    for (const rsiExitLong of [55, 60, 65])
      for (const atrStopMult of [1, 1.5, 2])
        grids.rsi_mean_reversion.push({ rsiBuy, rsiSell: 100 - rsiBuy, rsiExitLong, rsiExitShort: 100 - rsiExitLong, atrStopMult });
  for (const emaFast of [5, 9, 12])
    for (const emaSlow of [21, 30, 50])
      if (emaFast < emaSlow) grids.ema_crossover.push({ emaFast, emaSlow });
  for (const vwapEntryPct of [0.3, 0.5, 0.8]) grids.vwap.push({ vwapEntryPct });
  for (const orbBreakoutPct of [0.1, 0.2, 0.3]) grids.orb.push({ orbBreakoutPct });
  for (const trailPct of [4, 5, 7, 10]) grids.weekly_momentum.push({ trailPct });
  for (const ratchetTpAtrMult of [0.3, 0.5, 0.8, 1.2, 1.6])
    for (const ratchetStopAtrMult of [0.3, 0.5, 0.8, 1.2])
      for (const ratchetTightenAtrMult of [0.05, 0.1, 0.15, 0.2])
        grids.ratchet_streak.push({ ratchetTpAtrMult, ratchetStopAtrMult, ratchetTightenAtrMult });
  for (const donchianEntryPeriod of [10, 20, 40, 55])
    for (const donchianExitPeriod of [5, 10, 20])
      if (donchianExitPeriod < donchianEntryPeriod) grids.donchian_breakout.push({ donchianEntryPeriod, donchianExitPeriod });
  for (const macdAtrStopMult of [1.5, 2, 3])
    for (const macdAtrTpMult of [3, 5, 7])
      grids.macd_crossover.push({ macdAtrStopMult, macdAtrTpMult });
  return grids;
})();

export type WalkForwardResult = {
  symbol:      string;
  strategy:    BTStrategy;
  splitAt:     string;
  combosTried: number;
  bestParams:  Partial<BTParams>;
  train:       BTStats;
  test:        BTStats;
  testResult:  BTResult;
};

export function walkForward(
  symbol:     string,
  strategy:   BTStrategy,
  bars:       BTBar[],
  baseParams: BTParams = BT_DEFAULT_PARAMS,
  trainFrac   = 0.7,
): WalkForwardResult | null {
  if (bars.length < 120) return null;
  const splitIdx = Math.floor(bars.length * trainFrac);
  const trainBars = bars.slice(0, splitIdx);
  const testBars  = bars.slice(splitIdx);

  const grid = WF_GRIDS[strategy];
  let best: { params: Partial<BTParams>; result: BTResult } | null = null;

  for (const combo of grid) {
    const r = runBacktest(symbol, strategy, trainBars, { ...baseParams, ...combo });
    if (!r) continue;
    const score = r.stats.trades >= 5 ? r.stats.totalReturnPct : -1e9 + r.stats.totalReturnPct;
    const bestScore = best
      ? (best.result.stats.trades >= 5 ? best.result.stats.totalReturnPct : -1e9 + best.result.stats.totalReturnPct)
      : -Infinity;
    if (score > bestScore) best = { params: combo, result: r };
  }
  if (!best) return null;

  const testResult = runBacktest(symbol, strategy, testBars, { ...baseParams, ...best.params });
  if (!testResult) return null;

  return {
    symbol, strategy,
    splitAt: testBars[0].t,
    combosTried: grid.length,
    bestParams: best.params,
    train: best.result.stats,
    test: testResult.stats,
    testResult,
  };
}

export function runBacktest(
  symbol:   string,
  strategy: BTStrategy,
  bars:     BTBar[],
  params:   BTParams = BT_DEFAULT_PARAMS,
): BTResult | null {
  if (bars.length < 40) return null;

  let out: { trades: BTTrade[]; equityCurve: { t: string; equity: number }[]; holds: number[] };
  switch (strategy) {
    case 'rsi_mean_reversion':
      out = runSim(bars, params, makeRsiMeanReversion(bars, params));
      break;
    case 'ema_crossover':
      out = runSim(bars, params, makeEmaCrossover(bars, params));
      break;
    case 'vwap':
      out = runSim(bars, params, makeVwap(bars, params), { forceEodExit: true });
      break;
    case 'orb':
      out = runSim(bars, params, makeOrb(bars, params), { forceEodExit: true });
      break;
    case 'weekly_momentum':
      out = runSim(bars, params, makeWeeklyMomentum(bars, params), { trailPct: params.trailPct });
      break;
    case 'ratchet_streak':
      out = runSim(bars, params, makeRatchetStreak(bars, params));
      break;
    case 'donchian_breakout':
      out = runSim(bars, params, makeDonchianBreakout(bars, params));
      break;
    case 'macd_crossover':
      out = runSim(bars, params, makeMacdCrossover(bars, params));
      break;
    case 'rule_based_analysis':
      out = runSim(bars, params, makeRuleBasedAnalysis(bars, params));
      break;
  }

  return {
    symbol, strategy,
    bars: bars.length,
    firstBar: bars[0].t,
    lastBar:  bars[bars.length - 1].t,
    trades: out.trades,
    stats: computeStats(out.trades, out.equityCurve, out.holds),
    equityCurve: out.equityCurve,
  };
}

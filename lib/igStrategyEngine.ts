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

export type Timeframe = 'hourly' | 'daily' | 'longterm' | 'rsi2';

export type MarketType = 'INDEX' | 'FOREX' | 'COMMODITY' | 'CRYPTO' | 'STOCK';

export type WatchlistMarket = {
  epic: string;
  name: string;
  enabled: boolean;
  marketType?: MarketType; // used to calibrate signal scoring and stop distances
  forceOpen?: boolean;     // trade regardless of signal strength
};

/** Classify an IG spread-bet or CFD epic by market type. */
export function getMarketType(epic: string): MarketType {
  if (epic.startsWith('IX.D.')) return 'INDEX';
  if (epic.includes('BITCOIN') || epic.includes('ETHUSD') || epic.includes('CRYPTO')) return 'CRYPTO';
  // UA.D.* are CFD stock epics (e.g. UA.D.AAPL.CASH.IP)
  if (epic.startsWith('UA.D.')) return 'STOCK';
  // Exclude known commodity epics before testing for forex currency patterns
  if (epic.includes('GOLD') || epic.includes('SILVER') || epic.includes('CRUDE') || epic.includes('NATGAS') || epic.includes('OIL')) return 'COMMODITY';
  if (epic.startsWith('CS.D.') && /USD|EUR|GBP|JPY|CHF|AUD|NZD|CAD/.test(epic)) return 'FOREX';
  return 'COMMODITY';
}

export type IGSavedStrategy = {
  id: string;
  name: string;
  // legacy single-market fields (kept for back-compat)
  epic: string;
  instrumentName: string;
  // auto-scan config
  watchlist: WatchlistMarket[];   // markets to scan; empty = use DEFAULT_WATCHLIST
  minStrength: number;            // min signal strength to open (0-100), default 60
  timeframe: Timeframe;
  size: number;
  maxPositions: number;
  accounts: ('demo' | 'live')[];
  accountId?: string;           // specific IG sub-account to trade on (accountId from IG)
  autoTrade: boolean;
  autoClose: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastRunEnv?: 'demo' | 'live';
  lastSignal?: SignalDirection;
  signalScanMs?: number;   // override interval for signal scans (ms)
  posMonitorMs?: number;   // override interval for position monitor (ms)
};

/**
 * Pre-defined spread-bet markets using the correct DFB epics.
 *
 * Epics use the .DAILY.IP / .TODAY.IP suffix — these are the Daily Funded
 * Bet (DFB/rolling) instruments for UK spread-bet accounts, sourced from
 * a verified bot_ig.py.  The older .CFD.IP epics are for CFD accounts
 * and will return INSTRUMENT_NOT_FOUND on spread-bet accounts.
 *
 * Only 3 markets enabled by default to stay within IG's 10 000
 * data-point/week historical allowance.  With RSI(2) strategy (once/day)
 * and 3 markets: 215 × 3 = 645 pts/day = 4 515 pts/week.
 */
// ── PERMISSIONS granted to the strategy engine ───────────────────────────────
// FRACTIONAL SHARE TRADING:  T212 orders use fractional quantities
//   (positionSize / currentPrice, 4 d.p., min 0.0001 shares).
//   IG orders use fractional £/pt sizes (min 0.1 £/pt).
// AUTOMATIC POSITION CLOSING: The engine may close existing positions when
//   the signal reverses (autoClose), when funds are critically low (worst
//   loser open >24h), or when a position is stale (>48h, <0.5% P&L).
// DYNAMIC SIZING: Position size is capped to calcDynamicSize() which limits
//   each order to at most 5% of available funds (min 0.1 £/pt, pause <£100).
// POSITION RECYCLING: Positions open >48h with <0.5% absolute P&L are closed
//   automatically during position monitor cycles to free capital.
// MINIMUM VIABLE SIZE: When available funds are between £100–£500 the engine
//   uses the minimum size of 0.1 £/pt rather than refusing to trade.

// ── Verified spread-bet epics for DEFAULT_WATCHLIST ───────────────────────────
// All epics use .DAILY.IP (indices) or .TODAY.IP (FX/commodities/crypto) which
// are the DFB (Daily Funded Bet) rolling instruments for UK spread-bet accounts.
// ⚠️  CFD variants (CS.D.CFDGOLD.*, CS.D.CRUDEOIL.*) are NOT valid here and
//     will cause REJECT_CFD_ORDER_ON_SPREADBET_ACCOUNT rejections.
export const DEFAULT_WATCHLIST: WatchlistMarket[] = [
  // ── Indices (Daily Funded Bets) ─────────────────────────────────────────────
  { epic: 'IX.D.FTSE.DAILY.IP',    name: 'FTSE 100',      enabled: true,  marketType: 'INDEX'     },
  { epic: 'IX.D.SPTRD.DAILY.IP',   name: 'S&P 500',       enabled: true,  marketType: 'INDEX'     },
  { epic: 'IX.D.NASDAQ.DAILY.IP',  name: 'NASDAQ 100',    enabled: false, marketType: 'INDEX'     },
  { epic: 'IX.D.DOW.DAILY.IP',     name: 'Wall Street',   enabled: false, marketType: 'INDEX'     },
  { epic: 'IX.D.DAX.DAILY.IP',     name: 'Germany 40',    enabled: false, marketType: 'INDEX'     },
  { epic: 'IX.D.NIKKEI.DAILY.IP',  name: 'Japan 225',     enabled: false, marketType: 'INDEX'     },
  { epic: 'IX.D.ASX.DAILY.IP',     name: 'Australia 200', enabled: false, marketType: 'INDEX'     },
  // ── Commodities (spread-bet TODAY instruments) ───────────────────────────────
  { epic: 'CS.D.GOLD.TODAY.IP',    name: 'Gold',          enabled: true,  marketType: 'COMMODITY' },
  { epic: 'CS.D.SILVER.TODAY.IP',  name: 'Silver',        enabled: false, marketType: 'COMMODITY' },
  { epic: 'CS.D.CRUDE.TODAY.IP',   name: 'Oil (WTI)',     enabled: false, marketType: 'COMMODITY' },
  { epic: 'CS.D.NATGAS.TODAY.IP',  name: 'Natural Gas',   enabled: false, marketType: 'COMMODITY' },
  // ── Forex ───────────────────────────────────────────────────────────────────
  { epic: 'CS.D.GBPUSD.TODAY.IP',  name: 'GBP/USD',       enabled: false, marketType: 'FOREX'     },
  { epic: 'CS.D.EURUSD.TODAY.IP',  name: 'EUR/USD',       enabled: false, marketType: 'FOREX'     },
  { epic: 'CS.D.USDJPY.TODAY.IP',  name: 'USD/JPY',       enabled: false, marketType: 'FOREX'     },
  { epic: 'CS.D.EURGBP.TODAY.IP',  name: 'EUR/GBP',       enabled: false, marketType: 'FOREX'     },
  { epic: 'CS.D.AUDUSD.TODAY.IP',  name: 'AUD/USD',       enabled: false, marketType: 'FOREX'     },
  { epic: 'CS.D.USDCHF.TODAY.IP',  name: 'USD/CHF',       enabled: false, marketType: 'FOREX'     },
  // ── Crypto ──────────────────────────────────────────────────────────────────
  // Note: Ethereum spread-bet epic is unreliable on some IG accounts — only Bitcoin used
  { epic: 'CS.D.BITCOIN.TODAY.IP', name: 'Bitcoin',       enabled: false, marketType: 'CRYPTO'    },
];

/**
 * CFD stock and index epics for IG CFD accounts.
 * Format: UA.D.<TICKER>.CASH.IP for US stocks, IX.D.*.CFD.IP for indices.
 */
export const CFD_WATCHLIST: WatchlistMarket[] = [
  // ── US Stock CFDs ────────────────────────────────────────────────────────────
  { epic: 'UA.D.AAPL.CASH.IP',   name: 'Apple',           enabled: false, marketType: 'STOCK' },
  { epic: 'UA.D.TSLA.CASH.IP',   name: 'Tesla',           enabled: false, marketType: 'STOCK' },
  { epic: 'UA.D.MSFT.CASH.IP',   name: 'Microsoft',       enabled: false, marketType: 'STOCK' },
  { epic: 'UA.D.AMZN.CASH.IP',   name: 'Amazon',          enabled: false, marketType: 'STOCK' },
  { epic: 'UA.D.NVDA.CASH.IP',   name: 'NVIDIA',          enabled: false, marketType: 'STOCK' },
  { epic: 'UA.D.META.CASH.IP',   name: 'Meta',            enabled: false, marketType: 'STOCK' },
  { epic: 'UA.D.GOOGL.CASH.IP',  name: 'Alphabet (GOOGL)',enabled: false, marketType: 'STOCK' },
  // ── Index CFDs ───────────────────────────────────────────────────────────────
  { epic: 'IX.D.FTSE.CFD.IP',    name: 'FTSE 100 CFD',    enabled: false, marketType: 'INDEX' },
  { epic: 'IX.D.SPTRD.CFD.IP',   name: 'S&P 500 CFD',     enabled: false, marketType: 'INDEX' },
  { epic: 'IX.D.NASDAQ.CFD.IP',  name: 'NASDAQ 100 CFD',  enabled: false, marketType: 'INDEX' },
];

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

// ── ATR (Average True Range) ──────────────────────────────────────────────────

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const hl  = candles[i].high  - candles[i].low;
    const hcp = Math.abs(candles[i].high  - candles[i - 1].close);
    const lcp = Math.abs(candles[i].low   - candles[i - 1].close);
    trs.push(Math.max(hl, hcp, lcp));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ── RSI(2) ────────────────────────────────────────────────────────────────────

export function rsi2(closes: number[]): number {
  if (closes.length < 3) return 50;
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const avgGain = (gains.slice(-2).reduce((a, b) => a + b, 0) / 2) || 0;
  const avgLoss = (losses.slice(-2).reduce((a, b) => a + b, 0) / 2) || 0;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * RSI(2) Mean Reversion + EMA(200) Trend Filter — ported from bot_ig.py
 *
 * Logic (matches the Python bot exactly):
 *   BUY  — price above EMA200 (uptrend) AND RSI(2) < 10 (oversold pullback)
 *   SELL — price below EMA200 (downtrend) AND RSI(2) > 90 (overbought bounce)
 *
 * Stops / targets are ATR-based (2× ATR stop, 4× ATR target → 2:1 R:R).
 * Uses daily candles — only needs to be fetched once per day, so allowance
 * usage is minimal (205 candles × N markets × 1 fetch/day).
 */
export function rsi2Signal(candles: Candle[]): StrategySignal {
  const closes = candles.map(c => c.close);
  const ema200vals = ema(closes, 200);

  if (ema200vals.length < 2 || closes.length < 210) {
    return { direction: 'HOLD', strength: 0, reason: 'Need at least 210 daily candles for RSI(2) strategy', indicators: [], stopPoints: 0, targetPoints: 0, riskReward: '2:1' };
  }

  const curClose  = closes[closes.length - 1];
  const curEma200 = ema200vals[ema200vals.length - 1];
  const curRsi2   = rsi2(closes.slice(-20));
  const curAtr    = atr(candles, 14);

  const stopPts   = Math.round(curAtr * 2);
  const targetPts = Math.round(curAtr * 4);
  const uptrend   = curClose > curEma200;
  const gap       = ((curClose - curEma200) / curEma200) * 100;

  let direction: SignalDirection = 'HOLD';
  let strength = 0;
  let reason = '';

  if (uptrend && curRsi2 < 10) {
    direction = 'BUY';
    strength  = Math.round(85 + (10 - curRsi2));   // stronger signal the lower RSI(2) goes
    reason    = `Mean reversion BUY — price ${gap.toFixed(1)}% above EMA200 (uptrend) with RSI(2) at ${curRsi2.toFixed(1)} (extreme oversold). Classic RSI(2) pullback entry.`;
  } else if (!uptrend && curRsi2 > 90) {
    direction = 'SELL';
    strength  = Math.round(85 + (curRsi2 - 90));
    reason    = `Mean reversion SELL — price ${Math.abs(gap).toFixed(1)}% below EMA200 (downtrend) with RSI(2) at ${curRsi2.toFixed(1)} (extreme overbought). Classic RSI(2) bounce entry.`;
  } else if (uptrend && curRsi2 < 30) {
    direction = 'BUY';
    strength  = 55;
    reason    = `Uptrend intact (${gap.toFixed(1)}% above EMA200). RSI(2) ${curRsi2.toFixed(1)} — pullback but not yet at extreme. Waiting for RSI(2) < 10.`;
  } else if (!uptrend && curRsi2 > 70) {
    direction = 'SELL';
    strength  = 55;
    reason    = `Downtrend intact (${Math.abs(gap).toFixed(1)}% below EMA200). RSI(2) ${curRsi2.toFixed(1)} — bouncing but not yet extreme. Waiting for RSI(2) > 90.`;
  } else {
    reason = `No signal. RSI(2) ${curRsi2.toFixed(1)} — waiting for extreme oversold (<10) or overbought (>90) reading.`;
  }

  return {
    direction,
    strength: Math.min(strength, 99),
    reason,
    indicators: [
      { label: 'RSI(2)',  value: curRsi2.toFixed(1),  status: curRsi2 < 10 ? 'bullish' : curRsi2 > 90 ? 'bearish' : 'neutral' },
      { label: 'EMA200',  value: curEma200.toFixed(2), status: uptrend ? 'bullish' : 'bearish' },
      { label: 'Price',   value: curClose.toFixed(2),  status: uptrend ? 'bullish' : 'bearish' },
      { label: 'Trend',   value: uptrend ? `↑ ${gap.toFixed(1)}% above` : `↓ ${Math.abs(gap).toFixed(1)}% below`, status: uptrend ? 'bullish' : 'bearish' },
      { label: 'ATR(14)', value: curAtr.toFixed(2),    status: 'neutral' },
      { label: 'SL dist', value: `${stopPts}pts`,      status: 'neutral' },
      { label: 'TP dist', value: `${targetPts}pts`,    status: 'neutral' },
    ],
    stopPoints:   stopPts,
    targetPoints: targetPts,
    riskReward:   '2:1',
  };
}

export function getSignal(timeframe: Timeframe, candles: Candle[]): StrategySignal {
  if (timeframe === 'hourly')   return hourlySignal(candles);
  if (timeframe === 'daily')    return dailySignal(candles);
  if (timeframe === 'rsi2')     return rsi2Signal(candles);
  return longtermSignal(candles);
}

/**
 * Candle counts are kept at the minimum the indicators need so we don't
 * burn through IG's weekly historical-data allowance (10 000 data-points).
 *
 *  hourly   : EMA21 needs 21 + RSI14 needs 15 → 30 candles is safe
 *  daily    : EMA50 needs 50 + MACD signal needs +9 → 60 candles minimum
 *  longterm : EMA200 needs 200 → 205 candles
 *
 * pollMs is aligned with the server-side cache TTL so most scan cycles
 * hit the cache rather than making a live IG API call:
 *  hourly   : poll every 15 min, MINUTE_5 cache = 5 min  → fresh data each poll
 *  daily    : poll every 4 hrs,  HOUR cache    = 4 hrs   → 1 API call per cycle
 *  longterm : poll every 12 hrs, DAY cache     = 12 hrs  → 1 API call per cycle
 *
 * Estimated weekly data-point usage (4 markets enabled):
 *  hourly   : 30 × 4 × (7*24*4) = 80 640  ← still high; use sparingly
 *  daily    : 60 × 4 × (7*6)    =  10 080 ← within allowance
 *  longterm : 205 × 4 × (7*2)   =  11 480 ← just within allowance
 */
export const TIMEFRAME_CONFIG: Record<Timeframe, { resolution: string; max: number; label: string; pollMs: number; description: string }> = {
  hourly:   { resolution: 'MINUTE_5', max: 30,  label: 'Hourly (Scalp)',      pollMs: 15 * 60_000,        description: '5-min candles · EMA9/21 + RSI · 2:1 R:R · polls every 15 min' },
  daily:    { resolution: 'HOUR',     max: 60,  label: 'Daily (Swing)',        pollMs:  4 * 60 * 60_000,   description: '1-hr candles · EMA20/50 + MACD · 3:1 R:R · polls every 4 hrs' },
  longterm: { resolution: 'DAY',      max: 205, label: 'Long-term Trend',      pollMs: 12 * 60 * 60_000,   description: 'Daily candles · Golden/Death Cross EMA50/200 · 3:1 R:R · polls every 12 hrs' },
  rsi2:     { resolution: 'DAY',      max: 215, label: 'RSI(2) Mean Reversion', pollMs: 24 * 60 * 60_000,  description: 'Daily candles · RSI(2) + EMA200 trend filter · ATR stops · polls once per day · lowest allowance usage' },
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

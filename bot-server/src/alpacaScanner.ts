import { getBars, type AccountMode, type AlpacaBar } from './alpacaApi';
import { calcRsi, calcEma, calcAtr, calcVwap, calcSma } from './alpacaStrategies';
import type { StrategyName } from './alpacaStrategies';

// ── Universe of liquid US stocks/ETFs ─────────────────────────────────────────

export const UNIVERSE: string[] = [
  // Broad market ETFs
  'SPY', 'QQQ', 'IWM', 'DIA', 'VTI',
  // Sector ETFs
  'XLK', 'XLF', 'XLE', 'XLV', 'XLI',
  // Mega-cap tech
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'AMD',
  // Finance
  'JPM', 'BAC', 'GS', 'V', 'MA',
  // Healthcare
  'UNH', 'JNJ', 'ABBV', 'PFE', 'MRK',
  // Consumer
  'WMT', 'HD', 'COST', 'NKE', 'MCD',
  // Energy
  'XOM', 'CVX', 'COP',
  // Industrials
  'CAT', 'BA', 'HON', 'GE',
  // Growth / momentum
  'NFLX', 'UBER', 'SHOP', 'COIN', 'PLTR',
  // Semiconductors
  'INTC', 'QCOM', 'MU', 'TSM',
];

// Batch size — keeps URL length safe and avoids rate limits
const BATCH = 15;

async function fetchBatched(
  symbols:   string[],
  timeframe: Parameters<typeof getBars>[1],
  limit:     number,
  mode:      AccountMode,
): Promise<Record<string, AlpacaBar[]>> {
  const result: Record<string, AlpacaBar[]> = {};
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    try {
      const bars = await getBars(batch, timeframe, limit, mode);
      Object.assign(result, bars);
    } catch {
      // skip failed batch silently — partial results are fine
    }
    // Small pause between batches to respect rate limits
    if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 300));
  }
  return result;
}

// ── Per-strategy scorers ──────────────────────────────────────────────────────

// Higher score = better candidate for the strategy
type Scored = { symbol: string; score: number };

function scoreRsiMeanReversion(barsMap: Record<string, AlpacaBar[]>): Scored[] {
  return Object.entries(barsMap).map(([symbol, bars]) => {
    if (bars.length < 20) return { symbol, score: -1 };
    const rsi = calcRsi(bars);
    if (rsi === null) return { symbol, score: -1 };
    // Best candidates: RSI far from 50 (oversold or overbought)
    const score = Math.abs(rsi - 50);
    return { symbol, score };
  });
}

function scoreEmaCrossover(barsMap: Record<string, AlpacaBar[]>): Scored[] {
  return Object.entries(barsMap).map(([symbol, bars]) => {
    if (bars.length < 25) return { symbol, score: -1 };
    const closes = bars.map(b => b.c);
    const ema9  = calcEma(closes, 9);
    const ema21 = calcEma(closes, 21);
    if (!ema9.length || !ema21.length) return { symbol, score: -1 };

    const last9  = ema9[ema9.length - 1];
    const last21 = ema21[ema21.length - 1];
    const prev9  = ema9[ema9.length - 2]  ?? last9;
    const prev21 = ema21[ema21.length - 2] ?? last21;

    // Recent crossover in last 3 bars = high score
    const crossedRecently = (last9 > last21 && prev9 <= prev21) || (last9 < last21 && prev9 >= prev21);
    const separation      = Math.abs(last9 - last21) / last21 * 100;
    const score           = (crossedRecently ? 40 : 0) + separation * 10;
    return { symbol, score };
  });
}

function scoreOrb(barsMap: Record<string, AlpacaBar[]>): Scored[] {
  return Object.entries(barsMap).map(([symbol, bars]) => {
    if (bars.length < 10) return { symbol, score: -1 };
    const recent = bars.slice(-10);
    const avgVol = bars.slice(0, -10).reduce((s, b) => s + b.v, 0) / Math.max(bars.length - 10, 1);
    const recentVol = recent.reduce((s, b) => s + b.v, 0) / recent.length;
    // High relative volume = good ORB candidate
    const relVol = avgVol > 0 ? recentVol / avgVol : 1;
    const atr    = calcAtr(bars);
    const atrPct = atr && bars[bars.length - 1].c > 0 ? (atr / bars[bars.length - 1].c) * 100 : 0;
    const score  = relVol * 20 + atrPct * 5;
    return { symbol, score };
  });
}

function scoreVwap(barsMap: Record<string, AlpacaBar[]>): Scored[] {
  return Object.entries(barsMap).map(([symbol, bars]) => {
    if (bars.length < 20) return { symbol, score: -1 };
    const vwap = calcVwap(bars);
    if (!vwap) return { symbol, score: -1 };
    const price    = bars[bars.length - 1].c;
    const devPct   = Math.abs(price - vwap) / vwap * 100;
    // Best candidates: furthest from VWAP (biggest reversion opportunity)
    const score    = devPct * 10;
    return { symbol, score };
  });
}

function scoreWeeklyMomentum(barsMap: Record<string, AlpacaBar[]>): Scored[] {
  return Object.entries(barsMap).map(([symbol, bars]) => {
    if (bars.length < 15) return { symbol, score: -1 };
    const sma12 = calcSma(bars, 12);
    if (!sma12) return { symbol, score: -1 };
    const price    = bars[bars.length - 1].c;
    // Above 12-period SMA + positive recent momentum
    if (price < sma12) return { symbol, score: 0 };
    const recentMom = (bars[bars.length - 1].c - bars[bars.length - 4].c) / bars[bars.length - 4].c * 100;
    const score     = (price / sma12 - 1) * 100 + Math.max(0, recentMom);
    return { symbol, score };
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

const TIMEFRAME: Record<StrategyName, { tf: Parameters<typeof getBars>[1]; limit: number }> = {
  rsi_mean_reversion: { tf: '5Min',  limit: 50  },
  ema_crossover:      { tf: '1Day',  limit: 30  },
  orb:                { tf: '5Min',  limit: 60  },
  vwap:               { tf: '1Min',  limit: 60  },
  weekly_momentum:    { tf: '1Week', limit: 16  },
};

/**
 * Scans UNIVERSE (minus `exclude`) and returns the top `count` symbols
 * best suited for the given strategy. Called at bot start (autoSelect)
 * and whenever a position closes (slot replacement).
 */
export async function scanForBestSymbols(
  strategy: StrategyName,
  mode:     AccountMode,
  exclude:  string[],
  count:    number,
  log:      (msg: string) => void = console.log,
): Promise<string[]> {
  const candidates = UNIVERSE.filter(s => !exclude.includes(s));
  const { tf, limit } = TIMEFRAME[strategy];

  log(`[scanner] Scanning ${candidates.length} symbols for ${strategy}…`);

  const barsMap = await fetchBatched(candidates, tf, limit, mode);

  let scored: Scored[];
  switch (strategy) {
    case 'rsi_mean_reversion': scored = scoreRsiMeanReversion(barsMap); break;
    case 'ema_crossover':      scored = scoreEmaCrossover(barsMap);     break;
    case 'orb':                scored = scoreOrb(barsMap);              break;
    case 'vwap':               scored = scoreVwap(barsMap);             break;
    case 'weekly_momentum':    scored = scoreWeeklyMomentum(barsMap);   break;
    default: return candidates.slice(0, count);
  }

  const top = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(s => s.symbol);

  log(`[scanner] Top picks: ${top.join(', ') || 'none found — using defaults'}`);
  return top.length >= count ? top : [...top, ...candidates.slice(0, count - top.length)];
}

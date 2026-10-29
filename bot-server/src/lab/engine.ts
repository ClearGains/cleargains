// ── Strategy Lab: strategies + replay engine (2026-10-29) ───────────────────
// Replays a strategy bar by bar on past prices. Decisions are made at a bar's
// close using only data up to that bar (no look-ahead); the trade enters at
// that close, then a fixed stop and target are checked on later bars (if a
// bar touches both, the stop is assumed first: the cautious choice). Every
// trade is measured in R (multiples of the amount risked) after the spread,
// and in £ at £20 risked per trade, the Momentum Testbot's size.
import { type Bar, type Series, dayKey } from './data';

export type ParamValue = number | boolean;
export type Params = Record<string, ParamValue>;
export type ParamSpec = { key: string; label: string; values: ParamValue[] };

export type Ctx = {
  bars: Bar[]; i: number;
  prevClose: number; dayOpen: number; minutesIntoDay: number;
  sma20: number | null; atrPct: number | null; rsi: number | null; rsiPrev: number | null;
  hiN: (n: number) => number | null; loN: (n: number) => number | null;
};

export type Strategy = {
  id: string; name: string; description: string;
  params: ParamSpec[];
  defaults: Params;
  signal: (c: Ctx, p: Params) => 1 | -1 | null;
  stopPct: (c: Ctx, p: Params) => number;
};

const num = (p: Params, k: string) => Number(p[k]);
const flag = (p: Params, k: string) => p[k] === true;
// Stop: a fixed % of price, or a fraction of the 14-day average daily range.
const stopFrom = (c: Ctx, p: Params) => {
  const atrFrac = num(p, 'stopAtrFrac');
  return atrFrac > 0 && c.atrPct ? Math.max(0.1, atrFrac * c.atrPct) : num(p, 'stopPct');
};
const trendOk = (c: Ctx, dir: 1 | -1) => c.sma20 === null || (dir === 1 ? c.bars[c.i].c > c.sma20 : c.bars[c.i].c < c.sma20);

export const STRATEGIES: Strategy[] = [
  {
    id: 'momentum_day',
    name: 'Day momentum (Momentum Testbot)',
    description: 'Trade in the direction of today\'s move once it passes a threshold: the Momentum Testbot\'s logic. Optional checks: still holding vs today\'s open, with the 20-day trend, skip the opening minutes.',
    params: [
      { key: 'minMovePct', label: 'Day move needed (%)', values: [0.3, 0.5, 0.75, 1.0] },
      { key: 'confirmOpen', label: 'Must hold vs today\'s open', values: [true, false] },
      { key: 'trendFilter', label: 'With the 20-day trend', values: [true, false] },
      { key: 'openingSkipMin', label: 'Skip first minutes', values: [0, 30, 60] },
      { key: 'stopPct', label: 'Stop (% of price)', values: [0.3, 0.5] },
      { key: 'stopAtrFrac', label: 'Stop as × daily range (0 = use %)', values: [0, 0.5, 0.75] },
      { key: 'targetR', label: 'Target (× stop)', values: [1.5, 2, 3] },
    ],
    defaults: { minMovePct: 0.5, confirmOpen: true, trendFilter: true, openingSkipMin: 30, stopPct: 0.3, stopAtrFrac: 0, targetR: 2 },
    signal: (c, p) => {
      const price = c.bars[c.i].c;
      const chg = (price - c.prevClose) / c.prevClose * 100;
      if (Math.abs(chg) < num(p, 'minMovePct') || c.minutesIntoDay < num(p, 'openingSkipMin')) return null;
      const dir: 1 | -1 = chg > 0 ? 1 : -1;
      if (flag(p, 'confirmOpen') && (dir === 1 ? price <= c.dayOpen : price >= c.dayOpen)) return null;
      if (flag(p, 'trendFilter') && !trendOk(c, dir)) return null;
      return dir;
    },
    stopPct: stopFrom,
  },
  {
    id: 'breakout',
    name: 'Breakout',
    description: 'Buy when price closes above the highest high of the last N bars (sell below the lowest low): the classic Donchian/Turtle entry.',
    params: [
      { key: 'lookback', label: 'Lookback (bars)', values: [12, 24, 48, 96] },
      { key: 'trendFilter', label: 'With the 20-day trend', values: [true, false] },
      { key: 'stopPct', label: 'Stop (% of price)', values: [0.3, 0.6] },
      { key: 'stopAtrFrac', label: 'Stop as × daily range (0 = use %)', values: [0, 0.5, 0.75, 1] },
      { key: 'targetR', label: 'Target (× stop)', values: [1.5, 2, 3] },
    ],
    defaults: { lookback: 24, trendFilter: true, stopPct: 0.6, stopAtrFrac: 0.5, targetR: 2 },
    signal: (c, p) => {
      const n = num(p, 'lookback');
      const hi = c.hiN(n), lo = c.loN(n);
      if (hi === null || lo === null) return null;
      const price = c.bars[c.i].c;
      const dir: 1 | -1 | null = price > hi ? 1 : price < lo ? -1 : null;
      if (!dir) return null;
      if (flag(p, 'trendFilter') && !trendOk(c, dir)) return null;
      return dir;
    },
    stopPct: stopFrom,
  },
  {
    id: 'pullback',
    name: 'Trend pullback',
    description: 'In an uptrend (price above its 20-day average), buy when RSI(14) dips below a level and turns back up; the mirror for downtrends.',
    params: [
      { key: 'rsiLevel', label: 'RSI dip level', values: [30, 35, 40] },
      { key: 'stopPct', label: 'Stop (% of price)', values: [0.3, 0.6] },
      { key: 'stopAtrFrac', label: 'Stop as × daily range (0 = use %)', values: [0, 0.5, 0.75] },
      { key: 'targetR', label: 'Target (× stop)', values: [1.5, 2, 3] },
    ],
    defaults: { rsiLevel: 35, stopPct: 0.6, stopAtrFrac: 0.5, targetR: 2 },
    signal: (c, p) => {
      if (c.rsi === null || c.rsiPrev === null || c.sma20 === null) return null;
      const lvl = num(p, 'rsiLevel');
      const price = c.bars[c.i].c;
      if (price > c.sma20 && c.rsiPrev < lvl && c.rsi >= lvl) return 1;
      if (price < c.sma20 && c.rsiPrev > 100 - lvl && c.rsi <= 100 - lvl) return -1;
      return null;
    },
    stopPct: stopFrom,
  },
  {
    id: 'mean_reversion',
    name: 'Mean reversion',
    description: 'Fade stretched moves: buy when RSI(14) is deeply oversold, sell when deeply overbought, regardless of trend.',
    params: [
      { key: 'rsiLow', label: 'Oversold below', values: [20, 25, 30] },
      { key: 'stopPct', label: 'Stop (% of price)', values: [0.3, 0.6] },
      { key: 'stopAtrFrac', label: 'Stop as × daily range (0 = use %)', values: [0, 0.5, 0.75] },
      { key: 'targetR', label: 'Target (× stop)', values: [1, 1.5, 2] },
    ],
    defaults: { rsiLow: 25, stopPct: 0.6, stopAtrFrac: 0.5, targetR: 1.5 },
    signal: (c, p) => {
      if (c.rsi === null) return null;
      const lo = num(p, 'rsiLow');
      return c.rsi < lo ? 1 : c.rsi > 100 - lo ? -1 : null;
    },
    stopPct: stopFrom,
  },
];

export type Trade = { entryT: number; exitT: number; dir: 1 | -1; entry: number; exit: number; r: number };
export type Metrics = {
  trades: number; wins: number; winRate: number; netR: number; avgR: number;
  netGbp: number; profitFactor: number | null; maxDrawdownR: number;
};
export type SimResult = { metrics: Metrics; trades: Trade[] };

// Guards shared by every strategy, matching the live Testbot's.
export type Guards = { cooldownLossMin: number; waitWinMin: number; maxLossesPerDay: number; longPauseMin: number };
export const DEFAULT_GUARDS: Guards = { cooldownLossMin: 60, waitWinMin: 45, maxLossesPerDay: 2, longPauseMin: 180 };

// Per-bar context that doesn't depend on parameters, computed once per series.
export type Prepared = {
  series: Series; spreadPct: number;
  day: string[]; prevClose: number[]; dayOpen: number[]; dayStart: number[];
  sma20: (number | null)[]; atrPct: (number | null)[]; rsi: (number | null)[];
};

export function prepare(series: Series, spreadPct: number): Prepared {
  const { bars, daily, tz } = series;
  const dIdx = new Map<string, number>();
  daily.forEach((b, i) => dIdx.set(dayKey(b.t, tz), i));
  const day: string[] = [], prevClose: number[] = [], dayOpen: number[] = [], dayStart: number[] = [];
  const sma20: (number | null)[] = [], atrPct: (number | null)[] = [];
  let curDay = '', curOpen = 0, curStart = 0;
  const daily1d = series.timeframe === '1d';
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const dk = dayKey(b.t, tz);
    if (dk !== curDay) { curDay = dk; curOpen = b.o; curStart = b.t; }
    day.push(dk); dayOpen.push(curOpen); dayStart.push(curStart);
    const di = dIdx.get(dk);
    // Daily figures from completed days before this one only.
    const before = di !== undefined ? di : daily.findIndex(d => dayKey(d.t, tz) > dk);
    const k = before === -1 ? daily.length : before;
    prevClose.push(daily1d ? (i > 0 ? bars[i - 1].c : b.o) : (k > 0 ? daily[k - 1].c : b.o));
    if (k >= 20) sma20.push(daily.slice(k - 20, k).reduce((s, d) => s + d.c, 0) / 20); else sma20.push(null);
    if (k >= 15) {
      let tr = 0;
      for (let j = k - 14; j < k; j++) tr += Math.max(daily[j].h - daily[j].l, Math.abs(daily[j].h - daily[j - 1].c), Math.abs(daily[j].l - daily[j - 1].c));
      atrPct.push(tr / 14 / daily[k - 1].c * 100);
    } else atrPct.push(null);
  }
  // Wilder RSI(14) on the series' own bars.
  const rsi: (number | null)[] = new Array(bars.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i < bars.length; i++) {
    const ch = bars[i].c - bars[i - 1].c;
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= 14) { ag += g / 14; al += l / 14; if (i === 14) rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); continue; }
    ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14;
    rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return { series, spreadPct, day, prevClose, dayOpen, dayStart, sma20, atrPct, rsi };
}

export function simulate(prep: Prepared, strat: Strategy, p: Params, from = 0, to = Infinity, guards: Guards = DEFAULT_GUARDS): SimResult {
  const bars = prep.series.bars;
  const end = Math.min(bars.length, to);
  const trades: Trade[] = [];
  let pos: { dir: 1 | -1; entry: number; stop: number; target: number; t: number; costR: number } | null = null;
  let lastLossT = 0, lastWinT = 0, lossesDay = '', lossesToday = 0;
  for (let i = Math.max(from, 1); i < end; i++) {
    const b = bars[i];
    if (pos) {
      const hitStop = pos.dir === 1 ? b.l <= pos.stop : b.h >= pos.stop;
      const hitTgt = pos.dir === 1 ? b.h >= pos.target : b.l <= pos.target;
      if (hitStop || hitTgt) {
        const exit = hitStop ? pos.stop : pos.target;
        const r = (hitStop ? -1 : (Math.abs(pos.target - pos.entry) / Math.abs(pos.entry - pos.stop))) - pos.costR;
        trades.push({ entryT: pos.t, exitT: b.t, dir: pos.dir, entry: pos.entry, exit, r });
        if (r < 0) { lastLossT = b.t; if (lossesDay !== prep.day[i]) { lossesDay = prep.day[i]; lossesToday = 0; } lossesToday++; }
        else lastWinT = b.t;
        pos = null;
      }
      continue;
    }
    // Guards (same as the live Testbot).
    const today = prep.day[i];
    const nLoss = lossesDay === today ? lossesToday : 0;
    if (nLoss >= guards.maxLossesPerDay && b.t - lastLossT < guards.longPauseMin * 60) continue;
    if (nLoss >= 1 && b.t - lastLossT < guards.cooldownLossMin * 60) continue;
    if (b.t - lastWinT < guards.waitWinMin * 60) continue;
    const ctx: Ctx = {
      bars, i, prevClose: prep.prevClose[i], dayOpen: prep.dayOpen[i], minutesIntoDay: (b.t - prep.dayStart[i]) / 60,
      sma20: prep.sma20[i], atrPct: prep.atrPct[i], rsi: prep.rsi[i], rsiPrev: prep.rsi[i - 1],
      hiN: n => { if (i < n) return null; let m = -Infinity; for (let j = i - n; j < i; j++) m = Math.max(m, bars[j].h); return m; },
      loN: n => { if (i < n) return null; let m = Infinity; for (let j = i - n; j < i; j++) m = Math.min(m, bars[j].l); return m; },
    };
    const dir = strat.signal(ctx, p);
    if (!dir) continue;
    const sp = strat.stopPct(ctx, p);
    const risk = b.c * sp / 100;
    pos = { dir, entry: b.c, stop: b.c - dir * risk, target: b.c + dir * risk * Number(p.targetR), t: b.t, costR: prep.spreadPct / sp };
  }
  if (pos) {  // still open at the end: mark at the last close
    const last = bars[end - 1];
    trades.push({ entryT: pos.t, exitT: last.t, dir: pos.dir, entry: pos.entry, exit: last.c, r: (last.c - pos.entry) * pos.dir / Math.abs(pos.entry - pos.stop) - pos.costR });
  }
  return { metrics: metricsOf(trades), trades };
}

export function metricsOf(trades: Trade[]): Metrics {
  const n = trades.length;
  const wins = trades.filter(t => t.r > 0).length;
  const netR = trades.reduce((s, t) => s + t.r, 0);
  const gross = trades.filter(t => t.r > 0).reduce((s, t) => s + t.r, 0);
  const loss = -trades.filter(t => t.r < 0).reduce((s, t) => s + t.r, 0);
  let peak = 0, eq = 0, dd = 0;
  for (const t of trades) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    trades: n, wins, winRate: n ? r2(wins / n * 100) : 0, netR: r2(netR), avgR: n ? r2(netR / n) : 0,
    netGbp: r2(netR * 20), profitFactor: loss > 0 ? r2(gross / loss) : null, maxDrawdownR: r2(dd),
  };
}

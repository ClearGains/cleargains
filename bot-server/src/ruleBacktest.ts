// ── Rule backtester for Opus ────────────────────────────────────────────────
// Added 2026-10-21, per explicit request that the AI build its own trading
// logic: Opus describes a strategy as rules, this replays them over real,
// split-adjusted daily bars from Alpaca and returns the results. All maths is
// done here in code — the model only proposes rules and reads the outcome.
//
// Simulation (deliberately conservative, no look-ahead):
//   • Signals are evaluated on a day's close; entry is the NEXT day's open.
//   • Stop-loss / take-profit are checked against each later day's low/high
//     (stop first if both are touched the same day — the pessimistic order).
//     A gap through the stop fills at the open, not the stop price.
//   • Exit conditions are checked on the close and filled at that close.
//   • max_hold_days closes at that day's close.
//   • One position per symbol at a time. No costs/slippage are modelled, so
//     real results will be somewhat worse.

import { getBars, type AlpacaBar } from './alpacaApi';

export const INDICATORS = [
  'pct_vs_sma20',      // % the close is above (+) / below (-) its 20-day average
  'pct_vs_sma50',
  'pct_vs_sma200',
  'trend_4w_pct',      // % change over 20 trading days
  'trend_12w_pct',     // % change over 60 trading days
  'rsi14',
  'day_change_pct',    // close vs previous close, %
  'close_vs_open_pct', // close vs that day's open, %
  'volume_ratio',      // that day's volume / its prior 20-day average
  'off_52w_high_pct',  // % below the 252-day high (0 = at the high)
  'atr_pct',           // 14-day ATR as % of price
] as const;
export type Indicator = typeof INDICATORS[number];
export type Condition = { indicator: Indicator; op: '>' | '<' | '>=' | '<='; value: number };

export type BacktestSpec = {
  symbols:          string[];
  direction:        'long' | 'short';
  entry_conditions: Condition[];   // all must be true on the signal day
  exit_conditions:  Condition[];   // any true at a close → exit
  stop_loss_pct:    number;        // > 0
  take_profit_pct:  number;        // 0 = none
  max_hold_days:    number;        // 1-250
  lookback_days:    number;        // history to test over, 120-750
};

type Series = Record<Indicator, Array<number | null>>;

function sma(c: number[], n: number, i: number): number | null {
  if (i + 1 < n) return null;
  let s = 0; for (let k = i - n + 1; k <= i; k++) s += c[k];
  return s / n;
}

function computeSeries(b: AlpacaBar[]): Series {
  const n = b.length, c = b.map(x => x.c);
  const out = Object.fromEntries(INDICATORS.map(k => [k, new Array<number | null>(n).fill(null)])) as Series;
  // Wilder RSI(14) and ATR(14), computed once over the whole series.
  let avgG = 0, avgL = 0, atr = 0;
  for (let i = 0; i < n; i++) {
    if (i >= 1) {
      const ch = c[i] - c[i - 1];
      const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - c[i - 1]), Math.abs(b[i].l - c[i - 1]));
      if (i <= 14) {
        avgG += Math.max(ch, 0) / 14; avgL += Math.max(-ch, 0) / 14; atr += tr / 14;
      } else {
        avgG = (avgG * 13 + Math.max(ch, 0)) / 14; avgL = (avgL * 13 + Math.max(-ch, 0)) / 14; atr = (atr * 13 + tr) / 14;
      }
      if (i >= 14) {
        out.rsi14[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
        out.atr_pct[i] = (atr / c[i]) * 100;
      }
      out.day_change_pct[i] = (ch / c[i - 1]) * 100;
    }
    for (const [k, len] of [['pct_vs_sma20', 20], ['pct_vs_sma50', 50], ['pct_vs_sma200', 200]] as const) {
      const m = sma(c, len, i); if (m) out[k][i] = ((c[i] - m) / m) * 100;
    }
    if (i >= 20) out.trend_4w_pct[i] = ((c[i] - c[i - 20]) / c[i - 20]) * 100;
    if (i >= 60) out.trend_12w_pct[i] = ((c[i] - c[i - 60]) / c[i - 60]) * 100;
    out.close_vs_open_pct[i] = ((c[i] - b[i].o) / b[i].o) * 100;
    if (i >= 20) {
      let v = 0; for (let k = i - 20; k < i; k++) v += b[k].v;
      if (v > 0) out.volume_ratio[i] = b[i].v / (v / 20);
    }
    if (i >= 251) {
      let hi = 0; for (let k = i - 251; k <= i; k++) hi = Math.max(hi, c[k]);
      out.off_52w_high_pct[i] = ((hi - c[i]) / hi) * 100;
    }
  }
  return out;
}

function holds(cond: Condition, s: Series, i: number): boolean {
  const v = s[cond.indicator][i];
  if (v === null || v === undefined) return false;
  switch (cond.op) {
    case '>':  return v > cond.value;
    case '<':  return v < cond.value;
    case '>=': return v >= cond.value;
    case '<=': return v <= cond.value;
  }
}

type Trade = { symbol: string; entryDate: string; days: number; retPct: number; exit: string };

export async function runRuleBacktest(spec: BacktestSpec): Promise<string> {
  // Validate — the model's input is untrusted.
  const symbols = [...new Set(spec.symbols.map(s => s.toUpperCase().trim()).filter(s => /^[A-Z.]{1,6}$/.test(s)))].slice(0, 15);
  if (!symbols.length) return 'ERROR: give 1-15 valid US tickers.';
  if (!spec.entry_conditions?.length) return 'ERROR: at least one entry condition is required.';
  for (const c of [...spec.entry_conditions, ...(spec.exit_conditions ?? [])]) {
    if (!INDICATORS.includes(c.indicator) || !['>', '<', '>=', '<='].includes(c.op) || !isFinite(c.value)) return `ERROR: bad condition ${JSON.stringify(c)}.`;
  }
  if (!(spec.stop_loss_pct > 0 && spec.stop_loss_pct <= 50)) return 'ERROR: stop_loss_pct must be 0-50 (exclusive of 0).';
  if (!(spec.take_profit_pct >= 0 && spec.take_profit_pct <= 500)) return 'ERROR: take_profit_pct must be 0-500.';
  const maxHold = Math.round(spec.max_hold_days);
  if (!(maxHold >= 1 && maxHold <= 250)) return 'ERROR: max_hold_days must be 1-250.';
  const lookback = Math.round(Math.min(750, Math.max(120, spec.lookback_days || 500)));
  const long = spec.direction !== 'short';

  const trades: Trade[] = [];
  const buyHold: number[] = [];
  const missing: string[] = [];
  for (const sym of symbols) {
    let bars: AlpacaBar[] | undefined;
    // Extra history so 200-day / 52-week indicators are warm at the start.
    try { bars = (await getBars([sym], '1Day', lookback + 260, 'paper'))[sym]; } catch { bars = undefined; }
    if (!bars || bars.length < 300) { missing.push(sym); continue; }
    const s = computeSeries(bars);
    const start = Math.max(260, bars.length - lookback);
    buyHold.push(((bars[bars.length - 1].c - bars[start].c) / bars[start].c) * 100);

    let i = start;
    while (i < bars.length - 1) {
      if (!spec.entry_conditions.every(c => holds(c, s, i))) { i++; continue; }
      const e = i + 1, entry = bars[e].o;
      const stop = long ? entry * (1 - spec.stop_loss_pct / 100) : entry * (1 + spec.stop_loss_pct / 100);
      const tp = spec.take_profit_pct > 0 ? (long ? entry * (1 + spec.take_profit_pct / 100) : entry * (1 - spec.take_profit_pct / 100)) : null;
      let exitPx = bars[bars.length - 1].c, exitIdx = bars.length - 1, why = 'end of data';
      for (let j = e; j < bars.length; j++) {
        const d = bars[j];
        // Gap through the stop on the open fills at the open.
        if (j > e && (long ? d.o <= stop : d.o >= stop)) { exitPx = d.o; exitIdx = j; why = 'stop (gap)'; break; }
        if (long ? d.l <= stop : d.h >= stop) { exitPx = stop; exitIdx = j; why = 'stop'; break; }
        if (tp !== null && (long ? d.h >= tp : d.l <= tp)) { exitPx = tp; exitIdx = j; why = 'take-profit'; break; }
        if (spec.exit_conditions?.length && spec.exit_conditions.some(c => holds(c, s, j))) { exitPx = d.c; exitIdx = j; why = 'exit rule'; break; }
        if (j - e + 1 >= maxHold) { exitPx = d.c; exitIdx = j; why = 'max hold'; break; }
      }
      const ret = long ? ((exitPx - entry) / entry) * 100 : ((entry - exitPx) / entry) * 100;
      trades.push({ symbol: sym, entryDate: bars[e].t.slice(0, 10), days: exitIdx - e + 1, retPct: ret, exit: why });
      i = exitIdx + 1;  // one position per symbol at a time
    }
  }

  if (!trades.length) {
    return `No trades: the entry rules never triggered on ${symbols.filter(s => !missing.includes(s)).join(', ')} over ~${lookback} trading days.${missing.length ? ` No data: ${missing.join(', ')}.` : ''}`;
  }
  const rets = trades.map(t => t.retPct).sort((a, b) => a - b);
  const wins = trades.filter(t => t.retPct > 0);
  const losses = trades.filter(t => t.retPct <= 0);
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
  const exits: Record<string, number> = {};
  for (const t of trades) exits[t.exit] = (exits[t.exit] ?? 0) + 1;
  const bySym = symbols.filter(s => !missing.includes(s)).map(sym => {
    const ts = trades.filter(t => t.symbol === sym);
    return ts.length ? `${sym} ${ts.length}t avg ${avg(ts.map(t => t.retPct)).toFixed(1)}%` : `${sym} 0t`;
  });
  const recent = trades.slice().sort((a, b) => b.entryDate.localeCompare(a.entryDate)).slice(0, 5)
    .map(t => `${t.entryDate} ${t.symbol} ${t.retPct >= 0 ? '+' : ''}${t.retPct.toFixed(1)}% in ${t.days}d (${t.exit})`);

  return [
    `Backtest over ~${lookback} trading days, ${spec.direction}, ${symbols.length - missing.length} symbols (no costs/slippage modelled):`,
    `Trades ${trades.length} | win rate ${((wins.length / trades.length) * 100).toFixed(0)}% | avg ${avg(rets).toFixed(2)}% | median ${rets[Math.floor(rets.length / 2)].toFixed(2)}%`,
    `Avg win ${avg(wins.map(t => t.retPct)).toFixed(2)}% | avg loss ${avg(losses.map(t => t.retPct)).toFixed(2)}% | worst ${rets[0].toFixed(1)}% | best ${rets[rets.length - 1].toFixed(1)}% | avg hold ${avg(trades.map(t => t.days)).toFixed(1)}d`,
    `Exits: ${Object.entries(exits).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `Buy-and-hold over the same window (avg per symbol): ${avg(buyHold).toFixed(1)}% — compare, since a rising market flatters long rules`,
    `Per symbol: ${bySym.join(' · ')}`,
    `Most recent trades: ${recent.join(' · ')}`,
    missing.length ? `No data: ${missing.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

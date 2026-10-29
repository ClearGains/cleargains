// ── Strategy Lab: stock momentum portfolio (2026-10-29) ─────────────────────
// Cross-sectional momentum (Jegadeesh & Titman 1993): each month, rank a
// universe of large US stocks by their return over the past `lookback`
// trading days (skipping the most recent `skip` days, which tend to reverse),
// hold the top `topN` equally for a month, repeat. Compared with simply
// holding the whole universe equally. Sandbox only; nothing here trades.
//
// Shown two ways: in an ISA / as shares (trading costs only), and as spread
// bets (also paying overnight funding, ~6.5% a year on longs).
// Caveat: the universe is today's large caps, so history flatters it slightly
// (companies that shrank away aren't in the list: survivorship bias).
import * as fs from 'fs';
import * as path from 'path';
import { loadSeries, type Bar } from './data';

export const MOMENTUM_UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM', 'V', 'MA', 'UNH', 'XOM', 'CVX', 'JNJ', 'LLY',
  'MRK', 'ABBV', 'PG', 'KO', 'PEP', 'COST', 'WMT', 'HD', 'MCD', 'NKE', 'DIS', 'NFLX', 'ORCL', 'CRM', 'ADBE', 'AMD',
  'INTC', 'CSCO', 'QCOM', 'TXN', 'IBM', 'CAT', 'HON', 'BAC',
];

const COST_PCT = 0.1;          // round trip per position change (spread/commission)
const FUNDING_PCT_YEAR = 6.5;  // spread-bet overnight funding on longs

export type PortfolioStats = { totalPct: number; cagrPct: number; maxDrawdownPct: number; months: number };
export type PortfolioRun = {
  id: string; createdAt: string; status: 'running' | 'done' | 'error'; error?: string;
  params: { lookback: number; skip: number; topN: number };
  from?: string; to?: string; stocksUsed?: number;
  isa?: PortfolioStats; spreadBet?: PortfolioStats; benchmark?: PortfolioStats;
  equity?: Array<{ d: string; strat: number; bench: number }>;
  holdingsNow?: Array<{ symbol: string; momentumPct: number }>;
  recentPicks?: Array<{ d: string; symbols: string[] }>;
};

const FILE = path.join(__dirname, '..', '..', 'lab-portfolio-runs.json');
let runs: PortfolioRun[] = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) as PortfolioRun[]; } catch { return []; } })();
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(runs.slice(0, 40))); } catch { /* best effort */ } };
export const listPortfolioRuns = () => runs.map(r => ({ ...r, equity: undefined }));
export const getPortfolioRun = (id: string) => runs.find(r => r.id === id);

function stats(curve: number[], months: number): PortfolioStats {
  let peak = curve[0], dd = 0;
  for (const v of curve) { peak = Math.max(peak, v); dd = Math.max(dd, 1 - v / peak); }
  const total = curve[curve.length - 1] / curve[0] - 1;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return { totalPct: r1(total * 100), cagrPct: r1((Math.pow(1 + total, 12 / Math.max(months, 1)) - 1) * 100), maxDrawdownPct: r1(dd * 100), months };
}

export function startPortfolioRun(p: { lookback?: number; skip?: number; topN?: number }): PortfolioRun {
  const params = {
    lookback: [63, 126, 252].includes(Number(p.lookback)) ? Number(p.lookback) : 252,
    skip: [0, 21].includes(Number(p.skip)) ? Number(p.skip) : 21,
    topN: [3, 5, 10].includes(Number(p.topN)) ? Number(p.topN) : 5,
  };
  const run: PortfolioRun = { id: Math.random().toString(36).slice(2, 10), createdAt: new Date().toISOString(), status: 'running', params };
  runs.unshift(run); save();
  void (async () => {
    try {
      const series = new Map<string, Bar[]>();
      for (const s of MOMENTUM_UNIVERSE) {
        try { const x = await loadSeries(s, '1d'); if (x.bars.length > 400) series.set(s, x.bars); } catch { /* skip that stock */ }
      }
      if (series.size < 15) throw new Error(`Only ${series.size} stocks loaded`);
      run.stocksUsed = series.size;
      // Common calendar: dates every stock has.
      const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
      const maps = new Map<string, Map<string, number>>();
      let common: string[] | null = null;
      for (const [s, bars] of series) {
        const m = new Map(bars.map(b => [dayOf(b.t), b.c]));
        maps.set(s, m);
        common = common ? common.filter(d => m.has(d)) : [...m.keys()];
      }
      const days = (common ?? []).sort();
      const start = params.lookback + params.skip + 1;
      if (days.length < start + 60) throw new Error('Not enough shared history');
      // Month-start rebalance points.
      const rebal: number[] = [];
      for (let i = start; i < days.length; i++) if (i === start || days[i].slice(0, 7) !== days[i - 1].slice(0, 7)) rebal.push(i);
      const px = (s: string, i: number) => maps.get(s)!.get(days[i])!;
      let isa = 1, sb = 1, bench = 1;
      const isaCurve = [1], sbCurve = [1], benchCurve = [1];
      const equity: PortfolioRun['equity'] = [{ d: days[rebal[0]], strat: 100, bench: 100 }];
      let prev = new Set<string>();
      const picks: Array<{ d: string; symbols: string[] }> = [];
      for (let k = 0; k < rebal.length - 1; k++) {
        const i = rebal[k], j = rebal[k + 1];
        const mom = [...series.keys()].map(s => ({ s, m: px(s, i - params.skip) / px(s, i - params.skip - params.lookback) - 1 }))
          .sort((a, b) => b.m - a.m);
        const top = mom.slice(0, params.topN).map(x => x.s);
        picks.push({ d: days[i], symbols: top });
        const ret = top.reduce((sum, s) => sum + px(s, j) / px(s, i) - 1, 0) / top.length;
        const changed = top.filter(s => !prev.has(s)).length / top.length;
        prev = new Set(top);
        const cost = changed * COST_PCT / 100;
        const monthDays = (Date.parse(days[j]) - Date.parse(days[i])) / 86_400_000;
        isa *= 1 + ret - cost;
        sb *= 1 + ret - cost - FUNDING_PCT_YEAR / 100 * monthDays / 365;
        const bret = [...series.keys()].reduce((sum, s) => sum + px(s, j) / px(s, i) - 1, 0) / series.size;
        bench *= 1 + bret;
        isaCurve.push(isa); sbCurve.push(sb); benchCurve.push(bench);
        equity.push({ d: days[j], strat: Math.round(isa * 1000) / 10, bench: Math.round(bench * 1000) / 10 });
      }
      const months = rebal.length - 1;
      run.isa = stats(isaCurve, months); run.spreadBet = stats(sbCurve, months); run.benchmark = stats(benchCurve, months);
      run.equity = equity; run.from = days[rebal[0]]; run.to = days[days.length - 1];
      run.recentPicks = picks.slice(-6).reverse();
      const last = days.length - 1;
      run.holdingsNow = [...series.keys()].map(s => ({ symbol: s, momentumPct: Math.round((px(s, last - params.skip) / px(s, last - params.skip - params.lookback) - 1) * 1000) / 10 }))
        .sort((a, b) => b.momentumPct - a.momentumPct).slice(0, params.topN);
      run.status = 'done';
    } catch (e) {
      run.status = 'error'; run.error = e instanceof Error ? e.message : String(e);
    }
    save();
  })();
  return run;
}

// ── Strategy Lab: test / train jobs (2026-10-29) ────────────────────────────
// Sandbox only: nothing here places trades or changes a live bot.
//  test  - replay one strategy with given settings over the whole history.
//  train - try many setting combinations on the OLDER 70% of the history,
//          then check the best few on the most recent 30%, which training
//          never saw. A setting that only shines on the training part is
//          fitted to the past, not an edge.
import * as fs from 'fs';
import * as path from 'path';
import { loadSeries, resolveMarket, type Timeframe } from './data';
import { STRATEGIES, prepare, simulate, type Params, type Metrics, type Strategy } from './engine';

export type LabRun = {
  id: string; createdAt: string; status: 'running' | 'done' | 'error'; error?: string;
  kind: 'test' | 'train'; strategy: string; market: string; marketName: string; timeframe: Timeframe;
  from?: string; to?: string; splitAt?: string; bars?: number;
  result?: {
    params?: Params; metrics?: Metrics; equity?: number[];
    baseline?: { params: Params; train: Metrics; test: Metrics };
    top?: Array<{ params: Params; train: Metrics; test: Metrics }>;
    combosTried?: number;
    buyHoldPct?: number;       // holding the market over the same stretch (test: whole; train: the unseen part)
  };
};

const FILE = path.join(__dirname, '..', '..', 'lab-runs.json');
let runs: LabRun[] = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) as LabRun[]; } catch { return []; } })();
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(runs.slice(0, 100))); } catch { /* best effort */ } };

export function listRuns(): LabRun[] { return runs; }
export function getRun(id: string): LabRun | undefined { return runs.find(r => r.id === id); }
export function strategyList() {
  return STRATEGIES.map(s => ({ id: s.id, name: s.name, description: s.description, params: s.params, defaults: s.defaults, recommended: s.recommended, trend: s.exit === 'flip' }));
}

function combos(s: Strategy, cap = 500): Params[] {
  let out: Params[] = [{}];
  for (const spec of s.params) out = out.flatMap(p => spec.values.map(v => ({ ...p, [spec.key]: v })));
  if (out.length <= cap) return out;
  // Too many: an even sample across the grid.
  const step = out.length / cap;
  return Array.from({ length: cap }, (_, i) => out[Math.floor(i * step)]);
}

const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');

export function startRun(req: { kind: 'test' | 'train'; strategy: string; market: string; timeframe: Timeframe; params?: Params }): LabRun {
  const strat = STRATEGIES.find(s => s.id === req.strategy);
  if (!strat) throw new Error(`Unknown strategy ${req.strategy}`);
  if (!['5m', '1h', '1d', '1wk'].includes(req.timeframe)) throw new Error('timeframe must be 5m, 1h, 1d or 1wk');
  const m = resolveMarket(req.market);
  const run: LabRun = {
    id: Math.random().toString(36).slice(2, 10), createdAt: new Date().toISOString(), status: 'running',
    kind: req.kind, strategy: strat.id, market: req.market.toUpperCase(), marketName: m.name, timeframe: req.timeframe,
  };
  runs.unshift(run); save();
  void (async () => {
    try {
      const series = await loadSeries(req.market, req.timeframe);
      if (series.bars.length < 200) throw new Error(`Only ${series.bars.length} bars of history; need at least 200`);
      const prep = prepare(series, m.spreadPct);
      const bars = series.bars;
      run.bars = bars.length; run.from = iso(bars[0].t); run.to = iso(bars[bars.length - 1].t);
      const minTrades = req.timeframe === '1d' ? 8 : 15;
      if (req.kind === 'test') {
        const params = { ...strat.defaults, ...(req.params ?? {}) };
        const r = simulate(prep, strat, params);
        let eq = 0;
        run.result = { params, metrics: r.metrics, equity: r.trades.map(t => Math.round((eq += t.r) * 100) / 100),
          buyHoldPct: Math.round((bars[bars.length - 1].c / bars[0].c - 1) * 1000) / 10 };
      } else {
        const split = Math.floor(bars.length * 0.7);
        run.splitAt = iso(bars[split].t);
        const all = combos(strat);
        const scored = all.map(params => ({ params, train: simulate(prep, strat, params, 0, split).metrics }))
          .filter(x => x.train.trades >= minTrades)
          .sort((a, b) => b.train.netR - a.train.netR)
          .slice(0, 8);
        const top = scored.map(x => ({ ...x, test: simulate(prep, strat, x.params, split).metrics }));
        const base = strat.defaults;
        run.result = {
          combosTried: all.length,
          buyHoldPct: Math.round((bars[bars.length - 1].c / bars[split].c - 1) * 1000) / 10,
          baseline: { params: base, train: simulate(prep, strat, base, 0, split).metrics, test: simulate(prep, strat, base, split).metrics },
          top,
        };
      }
      run.status = 'done';
    } catch (e) {
      run.status = 'error'; run.error = e instanceof Error ? e.message : String(e);
    }
    save();
  })();
  return run;
}

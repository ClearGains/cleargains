// ── Strategy Lab: "what happens next?" prediction trainer (2026-10-29) ───────
// Owner: show it past charts, cut off what happened next, over 1 min / 5 min /
// hour / day / week / month / 3 months / a year, and make it good at reading
// trends. Sandbox only; nothing here trades.
//
// For many cut-off points in the past it looks only at data up to the cut-off,
// predicts up or down for each horizon, then checks what actually happened.
// Predictors are scored against a coin flip and against "always up", on the
// most recent 30% of the history, which the learned model never trained on.
//   trend        - follow the last ~20 bars' direction
//   short_mom    - follow the last 3 bars
//   mean_revert  - bet against the last 3 bars
//   learned      - a model trained on the older 70% of cut-offs: it learns how
//                  much each chart feature (recent returns, distance from
//                  averages, RSI, range position, volatility, volume) predicted
//                  the next move, then predicts the newer 30% blind
//   ai           - optional: Claude reads the cut-off chart and predicts
//                  (costs a little per chart, so it runs on a small sample)
import * as fs from 'fs';
import * as path from 'path';
import { loadSeries, resolveMarket, type Bar, type Timeframe } from './data';

const HORIZONS: Array<{ label: string; secs: number }> = [
  { label: '5 min', secs: 300 }, { label: '15 min', secs: 900 }, { label: '1 hour', secs: 3600 },
  { label: '4 hours', secs: 14_400 }, { label: '1 day', secs: 86_400 }, { label: '1 week', secs: 7 * 86_400 },
  { label: '1 month', secs: 30 * 86_400 }, { label: '3 months', secs: 91 * 86_400 }, { label: '1 year', secs: 365 * 86_400 },
];
const BAR_SECS: Record<Timeframe, number> = { '1m': 60, '5m': 300, '1h': 3600, '1d': 86_400, '1wk': 7 * 86_400 };

export type Score = { n: number; accuracy: number; edgePct: number; z: number; confident?: { n: number; accuracy: number } };
export type PredictRun = {
  id: string; createdAt: string; status: 'running' | 'done' | 'error'; error?: string;
  market: string; marketName: string; timeframe: Timeframe; from?: string; to?: string; splitAt?: string;
  ai?: { samples: number; costUsd: number };
  horizons?: Array<{
    label: string; testSamples: number; upRate: number;
    predictors: Record<string, Score>;
    topFeatures?: Array<{ feature: string; weight: number }>;
  }>;
};

const FILE = path.join(__dirname, '..', '..', 'lab-predict-runs.json');
let runs: PredictRun[] = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) as PredictRun[]; } catch { return []; } })();
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(runs.slice(0, 60))); } catch { /* best effort */ } };
export const listPredictRuns = () => runs;
export const getPredictRun = (id: string) => runs.find(r => r.id === id);

// ── Features at a cut-off (data up to and including bar i only) ──────────────
const FEATURES = ['ret1', 'ret3', 'ret6', 'ret12', 'ret24', 'ret48', 'vsSma20', 'vsSma50', 'rsi14', 'rangePos50', 'atr14', 'volRatio'];
function features(bars: Bar[], i: number): number[] | null {
  if (i < 60) return null;
  const c = bars[i].c;
  const ret = (n: number) => (c / bars[i - n].c - 1) * 100;
  const sma = (n: number) => { let s = 0; for (let j = i - n + 1; j <= i; j++) s += bars[j].c; return s / n; };
  let g = 0, l = 0;
  for (let j = i - 13; j <= i; j++) { const ch = bars[j].c - bars[j - 1].c; if (ch > 0) g += ch; else l -= ch; }
  const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  let hi = -Infinity, lo = Infinity, tr = 0;
  for (let j = i - 49; j <= i; j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
  for (let j = i - 13; j <= i; j++) tr += Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j - 1].c), Math.abs(bars[j].l - bars[j - 1].c));
  let vAvg = 0; for (let j = i - 20; j < i; j++) vAvg += bars[j].v; vAvg /= 20;
  return [ret(1), ret(3), ret(6), ret(12), ret(24), ret(48), (c / sma(20) - 1) * 100, (c / sma(50) - 1) * 100,
    rsi, hi > lo ? (c - lo) / (hi - lo) : 0.5, tr / 14 / c * 100, vAvg > 0 ? bars[i].v / vAvg : 1];
}

// ── A small logistic-regression model (no external libraries) ───────────────
function trainLogistic(X: number[][], y: number[]): { w: number[]; b: number; mu: number[]; sd: number[] } {
  const d = X[0].length, n = X.length;
  const mu = Array.from({ length: d }, (_, k) => X.reduce((s, r) => s + r[k], 0) / n);
  const sd = Array.from({ length: d }, (_, k) => Math.sqrt(X.reduce((s, r) => s + (r[k] - mu[k]) ** 2, 0) / n) || 1);
  const Z = X.map(r => r.map((v, k) => Math.max(-5, Math.min(5, (v - mu[k]) / sd[k]))));
  const w = new Array(d).fill(0); let b = 0;
  const lr = 0.1, l2 = 0.01;
  for (let epoch = 0; epoch < 300; epoch++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      const z = Z[i].reduce((s, v, k) => s + v * w[k], b);
      const err = 1 / (1 + Math.exp(-z)) - y[i];
      for (let k = 0; k < d; k++) gw[k] += err * Z[i][k];
      gb += err;
    }
    for (let k = 0; k < d; k++) w[k] -= lr * (gw[k] / n + l2 * w[k]);
    b -= lr * gb / n;
  }
  return { w, b, mu, sd };
}
const predictProb = (m: ReturnType<typeof trainLogistic>, x: number[]) =>
  1 / (1 + Math.exp(-x.reduce((s, v, k) => s + Math.max(-5, Math.min(5, (v - m.mu[k]) / m.sd[k])) * m.w[k], m.b)));

function score(preds: Array<{ dir: 1 | -1; conf?: number }>, fwd: number[]): Score {
  let hits = 0, edge = 0, cn = 0, ch = 0;
  preds.forEach((p, k) => {
    const hit = Math.sign(fwd[k]) === p.dir; if (hit) hits++;
    edge += p.dir * fwd[k];
    if (p.conf !== undefined && p.conf >= 0.6) { cn++; if (hit) ch++; }
  });
  const n = preds.length;
  const acc = n ? hits / n : 0;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    n, accuracy: r1(acc * 100), edgePct: Math.round((n ? edge / n : 0) * 1000) / 1000, z: r1(n ? (acc - 0.5) / Math.sqrt(0.25 / n) : 0),
    ...(preds.some(p => p.conf !== undefined) ? { confident: { n: cn, accuracy: cn ? r1(ch / cn * 100) : 0 } } : {}),
  };
}

type AskFn = (prompt: string) => Promise<{ text: string; usd: number } | null>;

export function startPredictRun(req: { market: string; timeframe: Timeframe; aiSamples?: number }, ask?: AskFn): PredictRun {
  const m = resolveMarket(req.market);
  const run: PredictRun = { id: Math.random().toString(36).slice(2, 10), createdAt: new Date().toISOString(), status: 'running', market: req.market.toUpperCase(), marketName: m.name, timeframe: req.timeframe };
  runs.unshift(run); save();
  void (async () => {
    try {
      const series = await loadSeries(req.market, req.timeframe);
      const bars = series.bars;
      if (bars.length < 300) throw new Error(`Only ${bars.length} bars of history; need at least 300`);
      const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
      run.from = iso(bars[0].t); run.to = iso(bars[bars.length - 1].t);
      const span = bars[bars.length - 1].t - bars[0].t;
      const barSecs = BAR_SECS[req.timeframe];
      const hz = HORIZONS.filter(h => h.secs >= barSecs * 2 && h.secs <= span / 4 && h.secs <= barSecs * 400);
      run.horizons = [];
      let aiLeft = Math.min(Math.max(req.aiSamples ?? 0, 0), 30);
      run.ai = { samples: 0, costUsd: 0 };
      for (const h of hz) {
        // Cut-offs: every `stride` bars, so samples don't overlap too heavily.
        const hBars = Math.max(1, Math.round(h.secs / barSecs));
        const stride = Math.max(1, Math.floor(hBars / 4), Math.floor(bars.length / 4000));
        const samples: Array<{ i: number; x: number[]; fwd: number }> = [];
        for (let i = 60; i < bars.length; i += stride) {
          const x = features(bars, i);
          if (!x) continue;
          // First bar at or after cut-off + horizon (binary search).
          const target = bars[i].t + h.secs;
          let lo = i + 1, hi = bars.length;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].t < target) lo = mid + 1; else hi = mid; }
          if (lo >= bars.length) break;
          samples.push({ i, x, fwd: (bars[lo].c / bars[i].c - 1) * 100 });
        }
        if (samples.length < 40) continue;
        const split = Math.floor(samples.length * 0.7);
        const train = samples.slice(0, split), test = samples.slice(split);
        const fwd = test.map(s => s.fwd);
        const sign = (v: number): 1 | -1 => (v >= 0 ? 1 : -1);
        const model = trainLogistic(train.map(s => s.x), train.map(s => (s.fwd > 0 ? 1 : 0)));
        const predictors: Record<string, Score> = {
          always_up: score(test.map(() => ({ dir: 1 as const })), fwd),
          trend: score(test.map(s => ({ dir: sign(s.x[4]) })), fwd),
          short_mom: score(test.map(s => ({ dir: sign(s.x[1]) })), fwd),
          mean_revert: score(test.map(s => ({ dir: sign(-s.x[1]) })), fwd),
          learned: score(test.map(s => { const p = predictProb(model, s.x); return { dir: p >= 0.5 ? 1 as const : -1 as const, conf: Math.max(p, 1 - p) }; }), fwd),
        };
        // AI reads a few blind charts from the unseen part (small sample: costs money).
        if (ask && aiLeft > 0) {
          const per = Math.min(aiLeft, 10);
          const pick = Array.from({ length: per }, (_, k) => test[Math.floor((k + 0.5) * test.length / per)]);
          const preds: Array<{ dir: 1 | -1; conf: number }> = [], f2: number[] = [];
          for (const s of pick) {
            const recent = bars.slice(Math.max(0, s.i - 39), s.i + 1).map(b => `${b.o.toPrecision(6)}/${b.h.toPrecision(6)}/${b.l.toPrecision(6)}/${b.c.toPrecision(6)}`).join(' ');
            const f = FEATURES.map((k, n) => `${k} ${s.x[n].toFixed(2)}`).join(', ');
            const r = await ask(`You are reading a ${m.name} price chart that has been cut off; you cannot see what came next. Bars are ${req.timeframe}, oldest first, as open/high/low/close: ${recent}\nComputed at the cut-off: ${f} (ret = % change over N bars; vsSma = % above the N-bar average; rangePos50 = 0 at the 50-bar low, 1 at the high; atr14 = typical bar range %).\nWill the price be HIGHER or LOWER ${h.label} after the last bar? Reply only with JSON: {"direction":"up"|"down","confidence":50-100}`);
            if (!r) continue;
            run.ai.costUsd += r.usd; run.ai.samples++;
            const mm = /"direction"\s*:\s*"(up|down)".*?"confidence"\s*:\s*(\d+)/s.exec(r.text);
            if (!mm) continue;
            preds.push({ dir: mm[1] === 'up' ? 1 : -1, conf: Number(mm[2]) / 100 }); f2.push(s.fwd);
          }
          aiLeft -= per;
          if (preds.length) predictors.ai = score(preds, f2);
        }
        const topFeatures = FEATURES.map((feature, k) => ({ feature, weight: Math.round(model.w[k] * 1000) / 1000 }))
          .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 5);
        run.horizons.push({ label: h.label, testSamples: test.length, upRate: Math.round(fwd.filter(v => v > 0).length / fwd.length * 1000) / 10, predictors, topFeatures });
        if (!run.splitAt) run.splitAt = iso(bars[samples[split].i].t);
        save();
      }
      run.ai.costUsd = Math.round(run.ai.costUsd * 1000) / 1000;
      run.status = 'done';
    } catch (e) {
      run.status = 'error'; run.error = e instanceof Error ? e.message : String(e);
    }
    save();
  })();
  return run;
}

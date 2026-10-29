'use client';

// Strategy Lab (2026-10-29): a sandbox for building, training and testing
// strategies on past prices, and for training chart prediction ("cut the chart
// off, guess what happens next, check"). Nothing here trades or changes the
// live bots.
import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Play, GraduationCap, Eye, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';

type ParamValue = number | boolean;
type ParamSpec = { key: string; label: string; values: ParamValue[] };
type StrategyMeta = { id: string; name: string; description: string; params: ParamSpec[]; defaults: Record<string, ParamValue> };
type Metrics = { trades: number; wins: number; winRate: number; netR: number; avgR: number; netGbp: number; profitFactor: number | null; maxDrawdownR: number };
type LabRun = {
  id: string; createdAt: string; status: 'running' | 'done' | 'error'; error?: string;
  kind: 'test' | 'train'; strategy: string; market: string; marketName: string; timeframe: string;
  from?: string; to?: string; splitAt?: string; bars?: number;
  result?: {
    params?: Record<string, ParamValue>; metrics?: Metrics; equity?: number[];
    baseline?: { params: Record<string, ParamValue>; train: Metrics; test: Metrics };
    top?: Array<{ params: Record<string, ParamValue>; train: Metrics; test: Metrics }>;
    combosTried?: number;
  };
};
type Score = { n: number; accuracy: number; edgePct: number; z: number; confident?: { n: number; accuracy: number } };
type PredictRun = {
  id: string; createdAt: string; status: 'running' | 'done' | 'error'; error?: string;
  market: string; marketName: string; timeframe: string; from?: string; to?: string; splitAt?: string;
  ai?: { samples: number; costUsd: number };
  horizons?: Array<{ label: string; testSamples: number; upRate: number; predictors: Record<string, Score>; topFeatures?: Array<{ feature: string; weight: number }> }>;
};

const PRED_LABEL: Record<string, string> = {
  always_up: 'Always guess up', trend: 'Follow the trend', short_mom: 'Follow the last few bars',
  mean_revert: 'Bet against the last few bars', learned: 'Learned model', ai: 'Claude reading the chart',
};
const FEATURE_LABEL: Record<string, string> = {
  ret1: 'last bar move', ret3: 'last 3 bars', ret6: 'last 6 bars', ret12: 'last 12 bars', ret24: 'last 24 bars', ret48: 'last 48 bars',
  vsSma20: 'vs 20-bar average', vsSma50: 'vs 50-bar average', rsi14: 'RSI', rangePos50: 'position in 50-bar range', atr14: 'volatility', volRatio: 'volume vs normal',
};

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/lab?path=${encodeURIComponent(path)}`, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : { cache: 'no-store' });
  const d = await res.json() as T & { ok: boolean; error?: string };
  if (!d.ok) throw new Error(d.error ?? 'Request failed');
  return d;
}

const money = (n: number) => `${n < 0 ? '−' : n > 0 ? '+' : ''}£${Math.abs(n).toFixed(0)}`;
const fmtParam = (v: ParamValue) => typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);

function MetricsRow({ m, label }: { m: Metrics; label: string }) {
  return (
    <tr className="border-t border-slate-800/70">
      <td className="px-2 py-1.5 text-slate-400">{label}</td>
      <td className="px-2 py-1.5 text-right">{m.trades}</td>
      <td className="px-2 py-1.5 text-right">{m.winRate}%</td>
      <td className={clsx('px-2 py-1.5 text-right font-medium', m.netR >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{m.netR >= 0 ? '+' : ''}{m.netR}R</td>
      <td className={clsx('px-2 py-1.5 text-right', m.netGbp >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{money(m.netGbp)}</td>
      <td className="px-2 py-1.5 text-right">{m.profitFactor ?? '—'}</td>
      <td className="px-2 py-1.5 text-right text-slate-400">{m.maxDrawdownR}R</td>
    </tr>
  );
}
const MetricsHead = () => (
  <thead><tr className="text-slate-500 text-left">
    <th className="px-2 py-1.5 font-medium" /><th className="px-2 py-1.5 font-medium text-right">Trades</th><th className="px-2 py-1.5 font-medium text-right">Won</th>
    <th className="px-2 py-1.5 font-medium text-right">Net</th><th className="px-2 py-1.5 font-medium text-right">£ at £20/trade</th>
    <th className="px-2 py-1.5 font-medium text-right" title="Total won ÷ total lost; above 1 makes money">Profit factor</th><th className="px-2 py-1.5 font-medium text-right" title="Worst peak-to-trough losing run">Worst run</th>
  </tr></thead>
);

function Equity({ eq }: { eq: number[] }) {
  if (eq.length < 2) return null;
  const min = Math.min(0, ...eq), max = Math.max(0, ...eq), w = 600, h = 120;
  const x = (i: number) => (i / (eq.length - 1)) * w, y = (v: number) => h - ((v - min) / (max - min || 1)) * h;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-28 bg-slate-950/50 rounded">
      <line x1={0} x2={w} y1={y(0)} y2={y(0)} stroke="#334155" strokeDasharray="4 4" />
      <polyline fill="none" stroke={eq[eq.length - 1] >= 0 ? '#34d399' : '#fb7185'} strokeWidth={2} points={eq.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
    </svg>
  );
}

export default function StrategyLabPage() {
  const [tab, setTab] = useState<'strategy' | 'predict'>('strategy');
  const [strategies, setStrategies] = useState<StrategyMeta[]>([]);
  const [markets, setMarkets] = useState<Array<{ key: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  // Strategy tester state
  const [stratId, setStratId] = useState('momentum_day');
  const [market, setMarket] = useState('DE40');
  const [stock, setStock] = useState('');
  const [tf, setTf] = useState('5m');
  const [params, setParams] = useState<Record<string, ParamValue>>({});
  const [runs, setRuns] = useState<LabRun[]>([]);
  const [selected, setSelected] = useState<LabRun | null>(null);

  // Prediction trainer state
  const [pMarket, setPMarket] = useState('US500');
  const [pStock, setPStock] = useState('');
  const [pTf, setPTf] = useState('1h');
  const [aiSamples, setAiSamples] = useState(0);
  const [pRuns, setPRuns] = useState<PredictRun[]>([]);
  const [pSel, setPSel] = useState<PredictRun | null>(null);

  const strat = strategies.find(s => s.id === stratId);

  const refresh = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([api<{ runs: LabRun[] }>('runs'), api<{ runs: PredictRun[] }>('predict')]);
      setRuns(r.runs); setPRuns(p.runs);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => {
    void api<{ strategies: StrategyMeta[]; markets: Array<{ key: string; name: string }> }>('meta')
      .then(d => { setStrategies(d.strategies); setMarkets(d.markets); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
    void refresh();
  }, [refresh]);

  useEffect(() => { if (strat) setParams(strat.defaults); }, [strat]);

  // Poll whichever run is open while it's still running.
  useEffect(() => {
    const busy = selected?.status === 'running' || pSel?.status === 'running';
    if (!busy) return;
    const t = setInterval(async () => {
      try {
        if (selected?.status === 'running') setSelected((await api<{ run: LabRun }>(`runs/${selected.id}`)).run);
        if (pSel?.status === 'running') setPSel((await api<{ run: PredictRun }>(`predict/${pSel.id}`)).run);
        void refresh();
      } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(t);
  }, [selected, pSel, refresh]);

  const startStrategy = async (kind: 'test' | 'train') => {
    setError(null);
    try {
      const d = await api<{ run: LabRun }>('run', { kind, strategy: stratId, market: stock.trim() || market, timeframe: tf, params });
      setSelected(d.run); void refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const startPredict = async () => {
    setError(null);
    try {
      const d = await api<{ run: PredictRun }>('predict', { market: pStock.trim() || pMarket, timeframe: pTf, aiSamples });
      setPSel(d.run); void refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const openRun = async (id: string) => { try { setSelected((await api<{ run: LabRun }>(`runs/${id}`)).run); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const openPred = async (id: string) => { try { setPSel((await api<{ run: PredictRun }>(`predict/${id}`)).run); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };

  const select = 'px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-sm text-slate-200';
  const sname = (id: string) => strategies.find(s => s.id === id)?.name ?? id;

  return (
    <main className="max-w-screen-xl mx-auto px-4 py-6 space-y-5">
      <div>
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-violet-400" />
          <h1 className="text-xl font-bold text-white">Strategy Lab</h1>
        </div>
        <p className="text-xs text-slate-500 mt-1">A sandbox: build, train and test strategies and chart predictions on past prices. Nothing here trades or changes the live bots.</p>
      </div>

      <div className="flex gap-2">
        <button onClick={() => setTab('strategy')} className={clsx('px-3 py-1.5 rounded-lg text-sm', tab === 'strategy' ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-300')}>Strategy tester</button>
        <button onClick={() => setTab('predict')} className={clsx('px-3 py-1.5 rounded-lg text-sm', tab === 'predict' ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-300')}>Prediction trainer</button>
        <button onClick={() => void refresh()} className="ml-auto p-2 rounded bg-slate-800 text-slate-400" title="Refresh"><RefreshCw className="w-4 h-4" /></button>
      </div>
      {error && <div className="text-sm text-rose-400">{error}</div>}

      {tab === 'strategy' && (
        <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
          <div className="space-y-4">
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-3">
              <label className="block text-xs text-slate-400">Strategy
                <select value={stratId} onChange={e => setStratId(e.target.value)} className={clsx(select, 'w-full mt-1')}>
                  {strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              {strat && <p className="text-xs text-slate-500">{strat.description}</p>}
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs text-slate-400">Market
                  <select value={market} onChange={e => { setMarket(e.target.value); setStock(''); }} className={clsx(select, 'w-full mt-1')}>
                    {markets.map(m => <option key={m.key} value={m.key}>{m.name}</option>)}
                  </select>
                </label>
                <label className="block text-xs text-slate-400">or a US stock
                  <input value={stock} onChange={e => setStock(e.target.value.toUpperCase())} placeholder="e.g. NVDA" className={clsx(select, 'w-full mt-1')} />
                </label>
              </div>
              <label className="block text-xs text-slate-400">Bars
                <select value={tf} onChange={e => setTf(e.target.value)} className={clsx(select, 'w-full mt-1')}>
                  <option value="5m">5 minutes (last 60 days)</option>
                  <option value="1h">1 hour (last ~2 years)</option>
                  <option value="1d">1 day (last 5 years)</option>
                </select>
              </label>
              {strat && (
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-slate-300">Settings (for Test)</div>
                  {strat.params.map(p => (
                    <label key={p.key} className="flex items-center justify-between gap-2 text-xs text-slate-400">
                      {p.label}
                      <select value={String(params[p.key])} onChange={e => setParams(x => ({ ...x, [p.key]: typeof p.values[0] === 'boolean' ? e.target.value === 'true' : Number(e.target.value) }))} className={select}>
                        {p.values.map(v => <option key={String(v)} value={String(v)}>{fmtParam(v)}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <button onClick={() => void startStrategy('test')} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm text-white"><Play className="w-4 h-4" />Test these settings</button>
                <button onClick={() => void startStrategy('train')} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-sm text-white"><GraduationCap className="w-4 h-4" />Train</button>
              </div>
              <p className="text-[11px] text-slate-500"><b>Test</b> replays these settings over the whole history. <b>Train</b> tries every combination on the older 70% and checks the best on the newest 30%, which it never saw. Results include IG-style spreads; each trade risks £20 (1R).</p>
            </div>

            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
              <div className="text-xs font-semibold text-slate-300 mb-2">Past runs</div>
              <div className="space-y-1 max-h-80 overflow-y-auto">
                {runs.map(r => (
                  <button key={r.id} onClick={() => void openRun(r.id)} className={clsx('w-full text-left text-xs px-2 py-1.5 rounded hover:bg-slate-800', selected?.id === r.id && 'bg-slate-800')}>
                    <span className={clsx('font-medium', r.kind === 'train' ? 'text-violet-300' : 'text-slate-200')}>{r.kind === 'train' ? 'Train' : 'Test'}</span>{' '}
                    <span className="text-slate-300">{sname(r.strategy)}</span> · <span className="text-slate-400">{r.marketName} {r.timeframe}</span>
                    <span className={clsx('float-right', r.status === 'error' ? 'text-rose-400' : r.status === 'running' ? 'text-amber-400' : 'text-slate-500')}>{r.status === 'done' ? new Date(r.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : r.status}</span>
                  </button>
                ))}
                {!runs.length && <div className="text-xs text-slate-500">No runs yet.</div>}
              </div>
            </div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-4 min-w-0">
            {!selected && <p className="text-sm text-slate-500">Pick a strategy and market, then Test or Train. Results appear here.</p>}
            {selected && (<>
              <div>
                <div className="text-sm font-semibold text-white">{selected.kind === 'train' ? 'Training' : 'Test'}: {sname(selected.strategy)} on {selected.marketName} ({selected.timeframe})</div>
                <div className="text-xs text-slate-500">{selected.from ? `${selected.from} → ${selected.to} · ${selected.bars} bars` : ''}{selected.splitAt ? ` · trained before ${selected.splitAt}, checked after` : ''}</div>
              </div>
              {selected.status === 'running' && <div className="text-sm text-amber-300">Running… (training can take a minute)</div>}
              {selected.status === 'error' && <div className="text-sm text-rose-400">{selected.error}</div>}
              {selected.status === 'done' && selected.result?.metrics && (<>
                <div className="overflow-x-auto"><table className="w-full text-xs min-w-[520px]"><MetricsHead /><tbody><MetricsRow m={selected.result.metrics} label="Whole history" /></tbody></table></div>
                {selected.result.equity && <div><div className="text-xs text-slate-500 mb-1">Running total (R) trade by trade</div><Equity eq={selected.result.equity} /></div>}
                <div className="text-xs text-slate-500">Settings: {Object.entries(selected.result.params ?? {}).map(([k, v]) => `${strat?.params.find(p => p.key === k)?.label ?? k}: ${fmtParam(v)}`).join(' · ')}</div>
              </>)}
              {selected.status === 'done' && selected.result?.top && (<>
                <p className="text-xs text-slate-400">Tried {selected.result.combosTried} setting combinations on the older part. The real test is the <b>unseen</b> column: a setting that only shines in training is fitted to the past, not an edge.</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs min-w-[640px]">
                    <thead><tr className="text-slate-500 text-left">
                      <th className="px-2 py-1.5 font-medium">Settings</th>
                      <th className="px-2 py-1.5 font-medium text-right">Training: trades / net</th>
                      <th className="px-2 py-1.5 font-medium text-right">Unseen: trades / won / net</th>
                      <th className="px-2 py-1.5 font-medium text-right">Unseen £</th>
                    </tr></thead>
                    <tbody>
                      {selected.result.baseline && (
                        <tr className="border-t border-slate-800/70 bg-slate-800/30">
                          <td className="px-2 py-1.5 text-slate-300">Current defaults</td>
                          <td className="px-2 py-1.5 text-right">{selected.result.baseline.train.trades} / {selected.result.baseline.train.netR}R</td>
                          <td className="px-2 py-1.5 text-right">{selected.result.baseline.test.trades} / {selected.result.baseline.test.winRate}% / <span className={selected.result.baseline.test.netR >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{selected.result.baseline.test.netR}R</span></td>
                          <td className="px-2 py-1.5 text-right">{money(selected.result.baseline.test.netGbp)}</td>
                        </tr>
                      )}
                      {selected.result.top.map((t, k) => (
                        <tr key={k} className="border-t border-slate-800/70">
                          <td className="px-2 py-1.5 text-slate-400">{Object.entries(t.params).map(([key, v]) => `${strat?.params.find(p => p.key === key)?.label ?? key}: ${fmtParam(v)}`).join(' · ')}</td>
                          <td className="px-2 py-1.5 text-right">{t.train.trades} / {t.train.netR}R</td>
                          <td className="px-2 py-1.5 text-right">{t.test.trades} / {t.test.winRate}% / <span className={t.test.netR >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{t.test.netR}R</span></td>
                          <td className="px-2 py-1.5 text-right">{money(t.test.netGbp)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>)}
            </>)}
          </div>
        </div>
      )}

      {tab === 'predict' && (
        <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
          <div className="space-y-4">
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-3">
              <p className="text-xs text-slate-400">Takes many points in the past, hides everything after each one, predicts up or down for each horizon, then checks what actually happened. Scored on the most recent 30% of history, which the learned model never trained on.</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs text-slate-400">Market
                  <select value={pMarket} onChange={e => { setPMarket(e.target.value); setPStock(''); }} className={clsx(select, 'w-full mt-1')}>
                    {markets.map(m => <option key={m.key} value={m.key}>{m.name}</option>)}
                  </select>
                </label>
                <label className="block text-xs text-slate-400">or a US stock
                  <input value={pStock} onChange={e => setPStock(e.target.value.toUpperCase())} placeholder="e.g. AAPL" className={clsx(select, 'w-full mt-1')} />
                </label>
              </div>
              <label className="block text-xs text-slate-400">Chart bars (sets the horizons it can predict)
                <select value={pTf} onChange={e => setPTf(e.target.value)} className={clsx(select, 'w-full mt-1')}>
                  <option value="1m">1 minute: 5 min, 15 min, 1 hour ahead (last 7 days)</option>
                  <option value="5m">5 minutes: 15 min to 1 day ahead (last 60 days)</option>
                  <option value="1h">1 hour: 4 hours to 1 month ahead (last ~2 years)</option>
                  <option value="1d">1 day: 1 week to 1 year ahead (last 5 years)</option>
                  <option value="1wk">1 week: 1 month to 1 year ahead (last 20 years)</option>
                </select>
              </label>
              <label className="block text-xs text-slate-400">Claude reads blind charts too
                <select value={aiSamples} onChange={e => setAiSamples(Number(e.target.value))} className={clsx(select, 'w-full mt-1')}>
                  <option value={0}>No (free)</option>
                  <option value={10}>10 charts (≈ $0.05)</option>
                  <option value={20}>20 charts (≈ $0.10)</option>
                  <option value={30}>30 charts (≈ $0.15)</option>
                </select>
              </label>
              <button onClick={() => void startPredict()} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-sm text-white"><Eye className="w-4 h-4" />Run prediction test</button>
            </div>
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
              <div className="text-xs font-semibold text-slate-300 mb-2">Past runs</div>
              <div className="space-y-1 max-h-80 overflow-y-auto">
                {pRuns.map(r => (
                  <button key={r.id} onClick={() => void openPred(r.id)} className={clsx('w-full text-left text-xs px-2 py-1.5 rounded hover:bg-slate-800', pSel?.id === r.id && 'bg-slate-800')}>
                    <span className="text-slate-200">{r.marketName}</span> <span className="text-slate-400">{r.timeframe}</span>{r.ai?.samples ? <span className="text-violet-300"> + AI</span> : null}
                    <span className={clsx('float-right', r.status === 'error' ? 'text-rose-400' : r.status === 'running' ? 'text-amber-400' : 'text-slate-500')}>{r.status === 'done' ? new Date(r.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : r.status}</span>
                  </button>
                ))}
                {!pRuns.length && <div className="text-xs text-slate-500">No runs yet.</div>}
              </div>
            </div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-4 min-w-0">
            {!pSel && <p className="text-sm text-slate-500">Pick a market and bar size, then run. Results appear here.</p>}
            {pSel && (<>
              <div>
                <div className="text-sm font-semibold text-white">Predicting {pSel.marketName} from {pSel.timeframe} charts</div>
                <div className="text-xs text-slate-500">{pSel.from ? `${pSel.from} → ${pSel.to}` : ''}{pSel.splitAt ? ` · scored on cut-offs after ${pSel.splitAt}` : ''}{pSel.ai?.samples ? ` · Claude read ${pSel.ai.samples} charts ($${pSel.ai.costUsd})` : ''}</div>
              </div>
              {pSel.status === 'running' && <div className="text-sm text-amber-300">Running…</div>}
              {pSel.status === 'error' && <div className="text-sm text-rose-400">{pSel.error}</div>}
              <p className="text-[11px] text-slate-500">Accuracy = how often the direction was right. A guess only counts as better than luck when its <b>z</b> is above 2 (green). &quot;Edge&quot; = average % move captured per prediction. Compare against &quot;Always guess up&quot;: markets drift up, so beating that is the real bar.</p>
              {(pSel.horizons ?? []).map(h => (
                <div key={h.label} className="border-t border-slate-800 pt-3">
                  <div className="text-sm text-slate-200 font-semibold">{h.label} ahead <span className="text-xs font-normal text-slate-500">· {h.testSamples} blind tests · went up {h.upRate}% of the time</span></div>
                  <div className="overflow-x-auto mt-1">
                    <table className="w-full text-xs min-w-[480px]">
                      <thead><tr className="text-slate-500 text-left"><th className="px-2 py-1 font-medium">Predictor</th><th className="px-2 py-1 font-medium text-right">Tests</th><th className="px-2 py-1 font-medium text-right">Right</th><th className="px-2 py-1 font-medium text-right">z</th><th className="px-2 py-1 font-medium text-right">Edge</th><th className="px-2 py-1 font-medium text-right">When confident</th></tr></thead>
                      <tbody>
                        {Object.entries(h.predictors).map(([k, s]) => (
                          <tr key={k} className="border-t border-slate-800/60">
                            <td className="px-2 py-1 text-slate-300">{PRED_LABEL[k] ?? k}</td>
                            <td className="px-2 py-1 text-right">{s.n}</td>
                            <td className="px-2 py-1 text-right">{s.accuracy}%</td>
                            <td className={clsx('px-2 py-1 text-right', s.z >= 2 ? 'text-emerald-400 font-semibold' : 'text-slate-400')}>{s.z}</td>
                            <td className={clsx('px-2 py-1 text-right', s.edgePct >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{s.edgePct >= 0 ? '+' : ''}{s.edgePct}%</td>
                            <td className="px-2 py-1 text-right text-slate-400">{s.confident ? `${s.confident.accuracy}% of ${s.confident.n}` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {h.topFeatures && <div className="text-[11px] text-slate-500 mt-1">What the learned model leaned on most: {h.topFeatures.map(f => `${FEATURE_LABEL[f.feature] ?? f.feature} (${f.weight > 0 ? 'higher → up' : 'higher → down'})`).join(', ')}</div>}
                </div>
              ))}
            </>)}
          </div>
        </div>
      )}
    </main>
  );
}

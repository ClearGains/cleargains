'use client';

import { useState } from 'react';
import { FlaskConical, Play, AlertTriangle, TrendingUp, TrendingDown, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { fetchYahooBars } from '@/lib/yahooClient';
import {
  runBacktest,
  BT_DEFAULT_PARAMS, BT_STRATEGY_LABELS, BT_DATA_NEEDS,
  type BTStrategy, type BTParams, type BTResult, type BTBar,
} from '@/lib/backtest';

const STRATEGIES = Object.keys(BT_STRATEGY_LABELS) as BTStrategy[];

// Which parameters matter per strategy — keeps the form focused
const PARAM_FIELDS: Record<BTStrategy, { key: keyof BTParams; label: string; step?: number }[]> = {
  rsi_mean_reversion: [
    { key: 'rsiPeriod',   label: 'RSI period' },
    { key: 'rsiBuy',      label: 'Buy below RSI' },
    { key: 'rsiSell',     label: 'Short above RSI' },
    { key: 'rsiExitLong', label: 'Exit long at RSI' },
    { key: 'atrStopMult', label: 'Stop (× ATR)', step: 0.1 },
    { key: 'atrTpMult',   label: 'Target (× ATR)', step: 0.1 },
  ],
  ema_crossover: [
    { key: 'emaFast', label: 'Fast EMA' },
    { key: 'emaSlow', label: 'Slow EMA' },
  ],
  vwap: [
    { key: 'vwapEntryPct', label: 'Entry distance from VWAP (%)', step: 0.1 },
  ],
  orb: [
    { key: 'orbBreakoutPct', label: 'Breakout confirm (%)', step: 0.05 },
  ],
  weekly_momentum: [
    { key: 'trailPct', label: 'Trailing stop (%)', step: 0.5 },
  ],
};

function EquityCurve({ curve }: { curve: { t: string; equity: number }[] }) {
  if (curve.length < 2) return null;
  const W = 560, H = 120, PAD = 4;
  // Downsample to ≤400 points for a light SVG
  const step = Math.max(1, Math.floor(curve.length / 400));
  const pts = curve.filter((_, i) => i % step === 0 || i === curve.length - 1);
  const min = Math.min(...pts.map(p => p.equity));
  const max = Math.max(...pts.map(p => p.equity));
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (pts.length - 1)) * (W - 2 * PAD);
  const y = (e: number) => H - PAD - ((e - min) / span) * (H - 2 * PAD);
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ');
  const up = pts[pts.length - 1].equity >= 1;
  const yBase = Math.min(Math.max(y(1), PAD), H - PAD);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28">
      <line x1={PAD} x2={W - PAD} y1={yBase} y2={yBase} stroke="#334155" strokeDasharray="3 3" strokeWidth="1" />
      <path d={d} fill="none" stroke={up ? '#34d399' : '#fb7185'} strokeWidth="1.5" />
    </svg>
  );
}

function StatCell({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | 'muted' }) {
  return (
    <div>
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className={clsx('text-sm font-bold font-mono',
        tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-rose-400' : 'text-white')}>
        {value}
      </div>
    </div>
  );
}

function ResultCard({ result }: { result: BTResult }) {
  const [showTrades, setShowTrades] = useState(false);
  const s = result.stats;
  const profitable = s.totalReturnPct > 0;
  return (
    <Card className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-white">{result.symbol}</span>
          {profitable
            ? <TrendingUp className="h-4 w-4 text-emerald-400" />
            : <TrendingDown className="h-4 w-4 text-rose-400" />}
          <span className={clsx('text-sm font-bold font-mono', profitable ? 'text-emerald-400' : 'text-rose-400')}>
            {s.totalReturnPct >= 0 ? '+' : ''}{s.totalReturnPct.toFixed(2)}%
          </span>
        </div>
        <span className="text-[11px] text-gray-600">
          {result.firstBar.slice(0, 10)} → {result.lastBar.slice(0, 10)} · {result.bars} bars
        </span>
      </div>

      <EquityCurve curve={result.equityCurve} />

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mt-3">
        <StatCell label="Trades" value={String(s.trades)} />
        <StatCell label="Win rate" value={`${s.winRate.toFixed(0)}%`} tone={s.winRate >= 50 ? 'good' : undefined} />
        <StatCell label="Profit factor" value={s.profitFactor >= 99 ? '∞' : s.profitFactor.toFixed(2)}
          tone={s.profitFactor > 1.2 ? 'good' : s.profitFactor < 1 ? 'bad' : undefined} />
        <StatCell label="Max drawdown" value={`−${s.maxDrawdownPct.toFixed(1)}%`} tone={s.maxDrawdownPct > 20 ? 'bad' : undefined} />
        <StatCell label="Avg win" value={`+${s.avgWinPct.toFixed(2)}%`} />
        <StatCell label="Avg loss" value={`−${s.avgLossPct.toFixed(2)}%`} />
      </div>

      {result.trades.length > 0 && (
        <>
          <button
            onClick={() => setShowTrades(v => !v)}
            className="mt-3 text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"
          >
            {showTrades ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {showTrades ? 'Hide trades' : `Show trades (${result.trades.length})`}
          </button>
          {showTrades && (
            <div className="mt-2 max-h-64 overflow-y-auto text-xs font-mono">
              <table className="w-full">
                <thead className="text-gray-600 text-left sticky top-0 bg-[#111118]">
                  <tr>
                    <th className="py-1 pr-2">Side</th>
                    <th className="pr-2">Entry</th>
                    <th className="pr-2">Exit</th>
                    <th className="pr-2 text-right">Return</th>
                    <th className="pl-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.slice(-100).reverse().map((t, i) => (
                    <tr key={i} className="border-t border-gray-800/60">
                      <td className={clsx('py-1 pr-2', t.side === 'long' ? 'text-emerald-500' : 'text-rose-500')}>{t.side}</td>
                      <td className="pr-2 text-gray-400">{t.entryTime.slice(0, 16)}</td>
                      <td className="pr-2 text-gray-400">{t.exitTime.slice(0, 16)}</td>
                      <td className={clsx('pr-2 text-right', t.retPct >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                        {t.retPct >= 0 ? '+' : ''}{t.retPct.toFixed(2)}%
                      </td>
                      <td className="pl-2 text-gray-500">{t.exitReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export default function BacktestPage() {
  const [symbolsInput, setSymbolsInput] = useState('SPY, QQQ, AAPL');
  const [strategy, setStrategy] = useState<BTStrategy>('rsi_mean_reversion');
  const [params, setParams] = useState<BTParams>({ ...BT_DEFAULT_PARAMS });
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BTResult[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  const setParam = (key: keyof BTParams, value: number | boolean) =>
    setParams(p => ({ ...p, [key]: value }));

  const run = async () => {
    const symbols = symbolsInput.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 10);
    if (!symbols.length) return;
    setRunning(true);
    setResults([]);
    setErrors([]);
    const { interval, range } = BT_DATA_NEEDS[strategy];
    const out: BTResult[] = [];
    const errs: string[] = [];
    for (const sym of symbols) {
      try {
        const candles = await fetchYahooBars(sym, interval, range);
        const bars: BTBar[] = candles.map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }));
        const r = runBacktest(sym, strategy, bars, params);
        if (r) out.push(r);
        else errs.push(`${sym}: not enough data (${bars.length} bars)`);
      } catch {
        errs.push(`${sym}: data fetch failed`);
      }
    }
    setResults(out);
    setErrors(errs);
    setRunning(false);
  };

  // Aggregate stats across symbols
  const agg = results.length
    ? {
        trades: results.reduce((s, r) => s + r.stats.trades, 0),
        avgReturn: results.reduce((s, r) => s + r.stats.totalReturnPct, 0) / results.length,
        profitable: results.filter(r => r.stats.totalReturnPct > 0).length,
      }
    : null;

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <FlaskConical className="h-6 w-6 text-indigo-400" />
          Backtest Lab
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Test the bot&apos;s strategy rules on historical data before risking money — tune parameters with evidence
        </p>
      </div>

      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 mb-6 flex items-start gap-3">
        <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-yellow-400">
          <span className="font-semibold">Past performance does not predict future results.</span>{' '}
          Simulations use Yahoo Finance data, fill signals at the next bar&apos;s open, charge slippage both
          ways, and assume the stop fills first when a bar touches both stop and target (pessimistic).
          Intraday data is limited to ~60 days.
        </p>
      </div>

      {/* Config */}
      <Card className="mb-6">
        <CardHeader title="Configuration" subtitle="Strategy, symbols and parameters" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Symbols (comma-separated, max 10)</label>
            <input
              value={symbolsInput}
              onChange={e => setSymbolsInput(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono"
              placeholder="SPY, QQQ, AAPL"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Strategy</label>
            <select
              value={strategy}
              onChange={e => setStrategy(e.target.value as BTStrategy)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
            >
              {STRATEGIES.map(s => (
                <option key={s} value={s}>{BT_STRATEGY_LABELS[s]}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {PARAM_FIELDS[strategy].map(({ key, label, step }) => (
            <div key={key}>
              <label className="text-xs text-gray-500 block mb-1">{label}</label>
              <input
                type="number"
                step={step ?? 1}
                value={params[key] as number}
                onChange={e => setParam(key, parseFloat(e.target.value) || 0)}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono"
              />
            </div>
          ))}
          <div>
            <label className="text-xs text-gray-500 block mb-1">Slippage (bps/side)</label>
            <input
              type="number"
              step={1}
              value={params.slippageBps}
              onChange={e => setParam('slippageBps', parseFloat(e.target.value) || 0)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono"
            />
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={params.allowShorts}
                onChange={e => setParam('allowShorts', e.target.checked)}
                className="accent-indigo-500"
              />
              Allow shorts
            </label>
          </div>
        </div>

        <button
          onClick={() => { void run(); }}
          disabled={running}
          className={clsx(
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            running ? 'bg-gray-700 text-gray-400 cursor-wait' : 'bg-indigo-600 hover:bg-indigo-500 text-white',
          )}
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {running ? 'Running…' : 'Run Backtest'}
        </button>
      </Card>

      {/* Errors */}
      {errors.length > 0 && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl px-4 py-3 mb-4 text-xs text-rose-400">
          {errors.map(e => <div key={e}>{e}</div>)}
        </div>
      )}

      {/* Aggregate */}
      {agg && results.length > 1 && (
        <Card className="mb-4">
          <div className="grid grid-cols-3 gap-4">
            <StatCell label="Total trades" value={String(agg.trades)} />
            <StatCell label="Avg return / symbol" value={`${agg.avgReturn >= 0 ? '+' : ''}${agg.avgReturn.toFixed(2)}%`}
              tone={agg.avgReturn > 0 ? 'good' : 'bad'} />
            <StatCell label="Profitable symbols" value={`${agg.profitable}/${results.length}`}
              tone={agg.profitable > results.length / 2 ? 'good' : undefined} />
          </div>
        </Card>
      )}

      {/* Per-symbol results */}
      {results.map(r => <ResultCard key={r.symbol} result={r} />)}

      {!running && results.length === 0 && errors.length === 0 && (
        <div className="text-center text-gray-600 text-sm py-10">
          Configure a strategy and press <span className="text-gray-400">Run Backtest</span>
        </div>
      )}
    </div>
  );
}

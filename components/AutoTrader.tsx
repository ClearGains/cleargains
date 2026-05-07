'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Power, RefreshCw, Settings, TrendingUp, TrendingDown, Clock, Zap,
  ToggleLeft, ToggleRight, ChevronDown, ChevronUp, AlertTriangle,
  ArrowDown, ArrowUp, Info,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useClearGainsStore } from '@/lib/store';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

// ── Types ─────────────────────────────────────────────────────────────────────

type SignalItem = {
  symbol: string; name: string; price: number;
  dayHigh: number; dayLow: number;
  direction: 'BUY' | 'SELL'; signal: string; score: number; reasons: string[];
};

type Recommendation = {
  id: string;
  symbol: string;
  name: string;
  direction: 'BUY' | 'SELL';
  signal: string;
  score: number;
  reasons: string[];
  price: number;
  stopLevel: number;
  tpLevel: number;
  stopDist: number;
  tpDist: number;
  stopValue: number;
  tpValue: number;
  ts: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function newId() { return `at_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`; }
function nowTs() { return new Date().toISOString(); }

function relTime(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function calcLevels(price: number, dayHigh: number, dayLow: number, dir: 'BUY' | 'SELL') {
  const r = (n: number) => Math.round(n * 100) / 100;
  if (dir === 'BUY') {
    const rawStop = Math.max(dayLow * 0.99, price * 0.95);
    const risk = Math.max(price - rawStop, price * 0.01);
    return { stopDist: r(risk), tpDist: r(risk * 2) };
  } else {
    const rawStop = Math.min(dayHigh * 1.01, price * 1.05);
    const risk = Math.max(rawStop - price, price * 0.01);
    return { stopDist: r(risk), tpDist: r(risk * 2) };
  }
}

// ── Scan logic ────────────────────────────────────────────────────────────────

type ScanParams = {
  minScore: number;
  useLongs: boolean;
  useShorts: boolean;
  maxSignals: number;
  stake: number;
  onAction: (msg: string) => void;
};

async function runScan(p: ScanParams): Promise<{ recommendations: Recommendation[]; error?: string }> {
  const signals: SignalItem[] = [];

  if (p.useLongs) {
    p.onAction('Fetching long signals…');
    try {
      const r = await fetch('/api/market/predicted');
      const data = await r.json() as Array<{
        symbol: string; name: string; price: number; dayHigh?: number; dayLow?: number;
        signal: string; score: number; signalReasons?: string[];
      }>;
      if (Array.isArray(data)) {
        data
          .filter(m => (m.signal === 'STRONG_BUY' || m.signal === 'BUY') && m.score >= p.minScore)
          .forEach(m => signals.push({
            symbol: m.symbol, name: m.name, price: m.price,
            dayHigh: m.dayHigh ?? m.price * 1.02, dayLow: m.dayLow ?? m.price * 0.98,
            direction: 'BUY', signal: m.signal, score: m.score,
            reasons: m.signalReasons ?? [],
          }));
      }
    } catch { /* ignore — show whatever signals we have */ }
  }

  if (p.useShorts) {
    p.onAction('Fetching short signals…');
    try {
      const r = await fetch('/api/market/shorts');
      const data = await r.json() as {
        conviction?: Array<{
          symbol: string; name: string; price: number; dayHigh?: number; dayLow?: number;
          shortSignal: string; shortScore: number; shortReasons?: string[];
        }>;
      };
      (data.conviction ?? [])
        .filter(c => c.shortSignal === 'STRONG_SHORT' && c.shortScore >= p.minScore)
        .forEach(c => signals.push({
          symbol: c.symbol, name: c.name, price: c.price,
          dayHigh: c.dayHigh ?? c.price * 1.02, dayLow: c.dayLow ?? c.price * 0.98,
          direction: 'SELL', signal: c.shortSignal, score: c.shortScore,
          reasons: c.shortReasons ?? [],
        }));
    } catch { /* ignore */ }
  }

  signals.sort((a, b) => b.score - a.score);

  const recommendations: Recommendation[] = signals.slice(0, p.maxSignals).map(sig => {
    const { stopDist, tpDist } = calcLevels(sig.price, sig.dayHigh, sig.dayLow, sig.direction);
    const stopLevel = sig.direction === 'BUY'
      ? Math.round((sig.price - stopDist) * 100) / 100
      : Math.round((sig.price + stopDist) * 100) / 100;
    const tpLevel = sig.direction === 'BUY'
      ? Math.round((sig.price + tpDist) * 100) / 100
      : Math.round((sig.price - tpDist) * 100) / 100;
    return {
      id: newId(),
      symbol: sig.symbol, name: sig.name,
      direction: sig.direction, signal: sig.signal, score: sig.score,
      reasons: sig.reasons, price: sig.price,
      stopLevel, tpLevel, stopDist, tpDist,
      stopValue: Math.round(stopDist * p.stake * 100) / 100,
      tpValue:   Math.round(tpDist  * p.stake * 100) / 100,
      ts: nowTs(),
    };
  });

  return { recommendations };
}

// ── NumInput ──────────────────────────────────────────────────────────────────

function NumInput({
  value, onChange, min, max, step = 1, hint,
}: {
  value: number; onChange: (v: number) => void;
  min: number; max: number; step?: number; hint?: string;
}) {
  const [raw, setRaw] = useState(String(value));
  const focused = useRef(false);

  useEffect(() => { if (!focused.current) setRaw(String(value)); }, [value]);

  function commit(str: string) {
    const n = parseFloat(str);
    if (!isNaN(n) && n >= min && n <= max) { onChange(n); setRaw(String(n)); }
    else { setRaw(String(value)); }
  }

  return (
    <div>
      <input
        type="text" inputMode="decimal" value={raw}
        onFocus={() => { focused.current = true; }}
        onChange={e => setRaw(e.target.value)}
        onBlur={e => { focused.current = false; commit(e.target.value); }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500"
      />
      {hint && <p className="text-[10px] text-gray-600 mt-1">{hint}</p>}
    </div>
  );
}

// ── Recommendation card ───────────────────────────────────────────────────────

function RecommendationCard({ rec, stake }: { rec: Recommendation; stake: number }) {
  const isBuy = rec.direction === 'BUY';
  const [showReasons, setShowReasons] = useState(false);

  return (
    <div className={clsx(
      'rounded-xl border p-4 space-y-3',
      isBuy ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-red-500/25 bg-red-500/5',
    )}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {isBuy
            ? <TrendingUp className="h-4 w-4 text-emerald-400 flex-shrink-0" />
            : <TrendingDown className="h-4 w-4 text-red-400 flex-shrink-0" />}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-white">{rec.symbol}</span>
              <span className={clsx(
                'text-[9px] font-bold px-1.5 py-0.5 rounded border',
                isBuy ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                       : 'bg-red-500/20 text-red-400 border-red-500/30',
              )}>{rec.direction}</span>
              <span className="text-[9px] text-gray-500 font-mono">{rec.signal}</span>
              <span className="text-[9px] text-gray-600">score {rec.score}</span>
            </div>
            <p className="text-[11px] text-gray-500 truncate mt-0.5">{rec.name}</p>
          </div>
        </div>

        {/* Entry price */}
        <div className="text-right flex-shrink-0">
          <p className="text-[9px] text-gray-500 uppercase tracking-wider">Entry</p>
          <p className="text-base font-bold text-white tabular-nums">{rec.price.toFixed(2)}</p>
        </div>
      </div>

      {/* Stop / TP grid */}
      <div className="grid grid-cols-2 gap-2">
        {/* Stop Loss */}
        <div className="rounded-lg border border-red-500/20 bg-gray-900/60 p-3">
          <div className="flex items-center gap-1 mb-1.5">
            <ArrowDown className="h-3 w-3 text-red-400" />
            <span className="text-[9px] text-red-400 font-semibold uppercase tracking-wider">Stop Loss</span>
          </div>
          <p className="text-sm font-bold text-white tabular-nums">{rec.stopLevel.toFixed(2)}</p>
          <p className="text-[11px] text-red-400 mt-0.5">{rec.stopDist.toFixed(2)} pts</p>
          <p className="text-[10px] text-gray-500 mt-0.5">£{rec.stopValue.toFixed(2)} at £{stake}/pt</p>
        </div>

        {/* Take Profit */}
        <div className="rounded-lg border border-emerald-500/20 bg-gray-900/60 p-3">
          <div className="flex items-center gap-1 mb-1.5">
            <ArrowUp className="h-3 w-3 text-emerald-400" />
            <span className="text-[9px] text-emerald-400 font-semibold uppercase tracking-wider">Take Profit</span>
          </div>
          <p className="text-sm font-bold text-white tabular-nums">{rec.tpLevel.toFixed(2)}</p>
          <p className="text-[11px] text-emerald-400 mt-0.5">{rec.tpDist.toFixed(2)} pts</p>
          <p className="text-[10px] text-gray-500 mt-0.5">£{rec.tpValue.toFixed(2)} at £{stake}/pt</p>
        </div>
      </div>

      {/* R:R ratio + reasons toggle */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-gray-500">
          R:R <span className="text-white font-semibold">1 : {(rec.tpDist / rec.stopDist).toFixed(1)}</span>
          <span className="mx-2 text-gray-700">·</span>
          <span className="text-gray-600">{relTime(rec.ts)}</span>
        </span>
        {rec.reasons.length > 0 && (
          <button
            onClick={() => setShowReasons(v => !v)}
            className="text-[10px] text-gray-500 hover:text-gray-300 flex items-center gap-1"
          >
            Reasons {showReasons ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        )}
      </div>

      {showReasons && rec.reasons.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {rec.reasons.map((r, i) => (
            <span key={i} className="text-[9px] text-gray-500 bg-gray-800/80 border border-gray-700/50 rounded px-1.5 py-0.5">{r}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function AutoTrader() {
  const {
    autoTraderEnv, autoTraderStake, autoTraderMaxPositions,
    autoTraderMinScore, autoTraderUseLongs, autoTraderUseShorts,
    autoTraderIntervalMin, autoTraderEnabled,
    setAutoTraderEnv, setAutoTraderConfig, setAutoTraderEnabled,
  } = useClearGainsStore();

  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [scanning, setScanning]         = useState(false);
  const [currentAction, setCurrentAction] = useState('');
  const [lastScanAt, setLastScanAt]     = useState<string | null>(null);
  const [scanError, setScanError]       = useState<string | null>(null);
  const [showConfig, setShowConfig]     = useState(true);

  const storeRef   = useRef({ autoTraderEnv, autoTraderStake, autoTraderMaxPositions, autoTraderMinScore, autoTraderUseLongs, autoTraderUseShorts });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanRunning = useRef(false);

  useEffect(() => {
    storeRef.current = { autoTraderEnv, autoTraderStake, autoTraderMaxPositions, autoTraderMinScore, autoTraderUseLongs, autoTraderUseShorts };
  });

  const executeScan = useCallback(async () => {
    if (scanRunning.current) return;
    scanRunning.current = true;
    setScanning(true);
    setScanError(null);
    setCurrentAction('');

    try {
      const s = storeRef.current;
      const result = await runScan({
        minScore:   s.autoTraderMinScore,
        useLongs:   s.autoTraderUseLongs,
        useShorts:  s.autoTraderUseShorts,
        maxSignals: s.autoTraderMaxPositions,
        stake:      s.autoTraderStake,
        onAction:   setCurrentAction,
      });

      if (result.error) {
        setScanError(result.error);
      } else {
        setRecommendations(result.recommendations);
        setLastScanAt(nowTs());
      }
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    } finally {
      scanRunning.current = false;
      setScanning(false);
      setCurrentAction('');
    }
  }, []);

  // Auto-scan interval
  useEffect(() => {
    if (!autoTraderEnabled) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      return;
    }
    void executeScan();
    intervalRef.current = setInterval(() => void executeScan(), autoTraderIntervalMin * 60_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTraderEnabled, autoTraderIntervalMin]);

  return (
    <div className="space-y-4">

      {/* Demo / Live tabs */}
      <div className="flex border-b border-gray-800">
        {(['demo', 'live'] as const).map(tab => (
          <button key={tab}
            onClick={() => setAutoTraderEnv(tab)}
            className={clsx(
              'relative px-6 py-3 text-sm font-semibold transition-all',
              autoTraderEnv === tab
                ? tab === 'live'
                  ? 'text-red-300 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-red-400'
                  : 'text-orange-300 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-orange-400'
                : 'text-gray-500 hover:text-gray-300',
            )}>
            {tab === 'live' ? (
              <span className="flex items-center gap-2">
                Live
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30">REAL MONEY</span>
              </span>
            ) : 'Demo'}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          {scanning && (
            <div className="flex items-center gap-2 text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 px-3 py-1.5 rounded-lg">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              {currentAction || 'Scanning…'}
            </div>
          )}
          {!scanning && lastScanAt && (
            <span className="text-[11px] text-gray-500">Last scan {relTime(lastScanAt)}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" loading={scanning}
            onClick={() => void executeScan()} disabled={scanning}
            icon={<Zap className="h-3.5 w-3.5" />}>
            Scan Now
          </Button>
          <button
            onClick={() => setAutoTraderEnabled(!autoTraderEnabled)}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold border transition-all',
              autoTraderEnabled
                ? 'bg-red-500/20 border-red-500/40 text-red-300 hover:bg-red-500/30'
                : 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30',
            )}>
            <Power className="h-4 w-4" />
            {autoTraderEnabled ? 'Stop Auto-Scan' : 'Start Auto-Scan'}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {scanError && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span>{scanError}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Config panel */}
        <div className="lg:col-span-1">
          <Card>
            <button onClick={() => setShowConfig(v => !v)}
              className="flex items-center justify-between w-full">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <Settings className="h-4 w-4 text-gray-400" /> Scanner Settings
              </div>
              {showConfig ? <ChevronUp className="h-4 w-4 text-gray-500" /> : <ChevronDown className="h-4 w-4 text-gray-500" />}
            </button>

            {showConfig && (
              <div className="mt-4 space-y-4">

                <div>
                  <label className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5 block">
                    Stake (£/pt) — for value calculation
                  </label>
                  <NumInput value={autoTraderStake} min={0.5} max={100} step={0.5}
                    onChange={v => setAutoTraderConfig({ stake: v })}
                    hint={`At £${autoTraderStake}/pt: 10pt move = £${autoTraderStake * 10}`} />
                </div>

                <div>
                  <label className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5 block">
                    Max signals to show
                  </label>
                  <NumInput value={autoTraderMaxPositions} min={1} max={20}
                    onChange={v => setAutoTraderConfig({ maxPositions: Math.round(v) })} />
                </div>

                <div>
                  <label className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5 block">
                    Minimum signal score
                  </label>
                  <NumInput value={autoTraderMinScore} min={1} max={15}
                    onChange={v => setAutoTraderConfig({ minScore: Math.round(v) })}
                    hint="Higher = fewer but stronger signals" />
                </div>

                <div>
                  <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5">Signal directions</p>
                  <div className="space-y-2">
                    <button onClick={() => setAutoTraderConfig({ useLongs: !autoTraderUseLongs })}
                      className="flex items-center justify-between w-full px-3 py-2.5 bg-gray-800/60 border border-gray-700 rounded-lg hover:border-gray-600 transition-colors">
                      <div className="flex items-center gap-2">
                        <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
                        <span className="text-xs text-white">Long (BUY)</span>
                      </div>
                      {autoTraderUseLongs
                        ? <ToggleRight className="h-5 w-5 text-emerald-400" />
                        : <ToggleLeft className="h-5 w-5 text-gray-600" />}
                    </button>
                    <button onClick={() => setAutoTraderConfig({ useShorts: !autoTraderUseShorts })}
                      className="flex items-center justify-between w-full px-3 py-2.5 bg-gray-800/60 border border-gray-700 rounded-lg hover:border-gray-600 transition-colors">
                      <div className="flex items-center gap-2">
                        <TrendingDown className="h-3.5 w-3.5 text-red-400" />
                        <span className="text-xs text-white">Short (SELL)</span>
                      </div>
                      {autoTraderUseShorts
                        ? <ToggleRight className="h-5 w-5 text-emerald-400" />
                        : <ToggleLeft className="h-5 w-5 text-gray-600" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-1.5 block">
                    Auto-scan interval (minutes)
                  </label>
                  <NumInput value={autoTraderIntervalMin} min={1} max={60}
                    onChange={v => setAutoTraderConfig({ intervalMin: Math.round(v) })}
                    hint="How often to refresh signals automatically" />
                </div>

              </div>
            )}
          </Card>
        </div>

        {/* Recommendations panel */}
        <div className="lg:col-span-2 space-y-3">

          {recommendations.length === 0 && !scanning ? (
            <Card>
              <div className="py-12 text-center">
                <Clock className="h-8 w-8 text-gray-700 mx-auto mb-3" />
                <p className="text-sm text-gray-500">No signals yet</p>
                <p className="text-[11px] text-gray-600 mt-1">
                  Click <span className="text-orange-400">Scan Now</span> to run the strategy and see trade recommendations
                </p>
              </div>
            </Card>
          ) : (
            <>
              <div className="flex items-center justify-between px-1">
                <p className="text-xs text-gray-400 font-medium">
                  {recommendations.length} signal{recommendations.length !== 1 ? 's' : ''} · enter manually on IG
                </p>
                <span className="text-[10px] text-gray-600">
                  {autoTraderEnabled ? `Auto-refresh every ${autoTraderIntervalMin}m` : 'Auto-scan off'}
                </span>
              </div>

              {recommendations.map(rec => (
                <RecommendationCard key={rec.id} rec={rec} stake={autoTraderStake} />
              ))}
            </>
          )}

          {/* Info note */}
          <div className="flex items-start gap-3 px-4 py-3 bg-blue-500/5 border border-blue-500/15 rounded-xl text-xs text-blue-400/70">
            <Info className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <p>
              Levels use a 2:1 R:R ratio — stop is set at the day low (×0.99) or 5% below entry (whichever is closer), take profit is 2× that distance.
              Enter these manually on IG: open the deal ticket, set stop and limit to the levels shown.
              Values shown assume £{autoTraderStake}/pt stake.
            </p>
          </div>

        </div>
      </div>
    </div>
  );
}

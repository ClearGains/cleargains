'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play, Square, Save, Trash2, Plus, RefreshCw, Search,
  AlertCircle, CheckCircle2, Clock, BarChart3, Target,
  TrendingUp, TrendingDown, Minus, Wifi, WifiOff, X, Copy,
  ChevronDown, ChevronRight, Zap,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  type Timeframe, type IGSavedStrategy, type StrategySignal, type Candle,
  getSignal, loadStrategies, saveStrategy, deleteStrategy, TIMEFRAME_CONFIG,
} from '@/lib/igStrategyEngine';

// ── Types ─────────────────────────────────────────────────────────────────────

type IGSession = { cst: string; securityToken: string; accountId: string };

type IGPosition = {
  dealId: string;
  direction: string;
  size: number;
  level: number;
  upl: number;
  currency: string;
  epic: string;
  instrumentName: string;
  bid: number;
  offer: number;
};

type IGMarketResult = {
  epic: string;
  instrumentName: string;
  bid: number;
  offer: number;
  instrumentType: string;
};

type RunLog = {
  id: string;
  ts: string;
  type: 'info' | 'buy' | 'sell' | 'close' | 'error' | 'signal';
  msg: string;
};

function uid() { return Math.random().toString(36).slice(2, 9); }
function fmt(n: number) { return `£${Math.abs(n).toFixed(2)}`; }
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Session / header helpers ──────────────────────────────────────────────────

function makeHeaders(session: IGSession, apiKey: string, env: 'demo' | 'live', extra?: Record<string, string>) {
  return {
    'x-ig-cst': session.cst,
    'x-ig-security-token': session.securityToken,
    'x-ig-api-key': apiKey,
    'x-ig-env': env,
    ...extra,
  };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SignalBadge({ signal }: { signal: StrategySignal }) {
  const color =
    signal.direction === 'BUY' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
    signal.direction === 'SELL' ? 'bg-red-500/20 text-red-400 border-red-500/30' :
    'bg-gray-700 text-gray-400 border-gray-600';

  const Icon = signal.direction === 'BUY' ? TrendingUp : signal.direction === 'SELL' ? TrendingDown : Minus;

  return (
    <div className={clsx('inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-bold', color)}>
      <Icon className="h-4 w-4" />
      {signal.direction}
      <span className="text-xs font-normal opacity-70">({signal.strength}%)</span>
    </div>
  );
}

function IndicatorRow({ label, value, status }: { label: string; value: string; status: 'bullish' | 'bearish' | 'neutral' }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-gray-800 last:border-0">
      <span className="text-xs text-gray-500">{label}</span>
      <span className={clsx('text-xs font-mono font-semibold',
        status === 'bullish' ? 'text-emerald-400' : status === 'bearish' ? 'text-red-400' : 'text-gray-400'
      )}>{value}</span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function IGStrategyTrader() {
  // ── Connection state ───────────────────────────────────────────────────────
  const [igEnv, setIgEnv] = useState<'demo' | 'live'>('demo');
  const [session, setSession] = useState<IGSession | null>(null);
  const [igApiKey, setIgApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);

  // ── Positions ──────────────────────────────────────────────────────────────
  const [positions, setPositions] = useState<IGPosition[]>([]);
  const [loadingPos, setLoadingPos] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);

  // ── Market search ──────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<IGMarketResult[]>([]);
  const [searching, setSearching] = useState(false);

  // ── Strategy builder ───────────────────────────────────────────────────────
  const [strategies, setStrategies] = useState<IGSavedStrategy[]>([]);
  const [activeStratId, setActiveStratId] = useState<string | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);
  const [builderName, setBuilderName] = useState('');
  const [builderEpic, setBuilderEpic] = useState('');
  const [builderInstrName, setBuilderInstrName] = useState('');
  const [builderTimeframe, setBuilderTimeframe] = useState<Timeframe>('daily');
  const [builderSize, setBuilderSize] = useState(1);
  const [builderMaxPos, setBuilderMaxPos] = useState(2);
  const [builderAccounts, setBuilderAccounts] = useState<('demo' | 'live')[]>(['demo']);
  const [builderAutoTrade, setBuilderAutoTrade] = useState(false);

  // ── Signal / analysis ──────────────────────────────────────────────────────
  const [signal, setSignal] = useState<StrategySignal | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [runLog, setRunLog] = useState<RunLog[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Notifications ──────────────────────────────────────────────────────────
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  function showToast(ok: boolean, msg: string) {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 4000);
  }

  function log(type: RunLog['type'], msg: string) {
    setRunLog(prev => [{ id: uid(), ts: new Date().toISOString(), type, msg }, ...prev].slice(0, 100));
  }

  // ── Auto-connect on mount ──────────────────────────────────────────────────
  useEffect(() => {
    setStrategies(loadStrategies());
  }, []);

  useEffect(() => {
    const storageKey = igEnv === 'demo' ? 'ig_demo_credentials' : 'ig_live_credentials';
    try {
      const saved = localStorage.getItem(storageKey);
      if (!saved) { setSession(null); return; }
      const creds = JSON.parse(saved) as { username: string; password: string; apiKey: string; connected?: boolean };
      if (!creds.connected) { setSession(null); return; }
      setConnecting(true);
      setConnError(null);
      fetch('/api/ig/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: creds.username, password: creds.password, apiKey: creds.apiKey, env: igEnv }),
      })
        .then(r => r.json())
        .then((data: { ok: boolean; cst?: string; securityToken?: string; accountId?: string; error?: string }) => {
          if (data.ok && data.cst && data.securityToken) {
            setSession({ cst: data.cst, securityToken: data.securityToken, accountId: data.accountId ?? '' });
            setIgApiKey(creds.apiKey);
          } else {
            setConnError(data.error ?? 'Session failed');
          }
        })
        .catch((e: unknown) => setConnError(e instanceof Error ? e.message : 'Connect failed'))
        .finally(() => setConnecting(false));
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [igEnv]);

  // ── Load positions ─────────────────────────────────────────────────────────
  const loadPositions = useCallback(async () => {
    if (!session) return;
    setLoadingPos(true);
    try {
      const res = await fetch('/api/ig/positions', { headers: makeHeaders(session, igApiKey, igEnv) });
      const data = await res.json() as { ok: boolean; positions?: IGPosition[]; error?: string };
      if (data.ok) setPositions(data.positions ?? []);
    } catch {}
    finally { setLoadingPos(false); }
  }, [session, igApiKey, igEnv]);

  useEffect(() => { if (session) void loadPositions(); }, [session, loadPositions]);

  // ── Market search ──────────────────────────────────────────────────────────
  async function handleSearch() {
    if (!session || !searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/ig/markets?q=${encodeURIComponent(searchQuery)}`,
        { headers: makeHeaders(session, igApiKey, igEnv) });
      const data = await res.json() as { ok: boolean; markets?: IGMarketResult[]; error?: string };
      if (data.ok) setSearchResults(data.markets ?? []);
      else showToast(false, data.error ?? 'Search failed');
    } catch { showToast(false, 'Search failed'); }
    finally { setSearching(false); }
  }

  // ── Fetch prices + analyse ─────────────────────────────────────────────────
  const analyseStrategy = useCallback(async (strat: IGSavedStrategy, envOverride?: 'demo' | 'live'): Promise<StrategySignal | null> => {
    if (!session) return null;
    const env = envOverride ?? igEnv;
    const cfg = TIMEFRAME_CONFIG[strat.timeframe];
    try {
      const res = await fetch(
        `/api/ig/prices?epic=${encodeURIComponent(strat.epic)}&resolution=${cfg.resolution}&max=${cfg.max}`,
        { headers: makeHeaders(session, igApiKey, env) }
      );
      const data = await res.json() as { ok: boolean; candles?: Candle[]; error?: string };
      if (!data.ok) { log('error', `Price fetch failed: ${data.error ?? 'unknown'}`); return null; }
      const c = data.candles ?? [];
      setCandles(c);
      const sig = getSignal(strat.timeframe, c);
      setSignal(sig);
      return sig;
    } catch (e) {
      log('error', `Analysis error: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }, [session, igApiKey, igEnv]);

  // ── Execute signal ─────────────────────────────────────────────────────────
  async function executeSignal(strat: IGSavedStrategy, sig: StrategySignal, env: 'demo' | 'live') {
    if (sig.direction === 'HOLD') { log('signal', `HOLD — ${sig.reason}`); return; }

    // Count open positions for this epic+direction
    const existing = positions.filter(p => p.epic === strat.epic);
    if (existing.length >= strat.maxPositions) {
      log('info', `Max positions (${strat.maxPositions}) reached for ${strat.instrumentName}`);
      return;
    }

    // Don't open if already in same direction
    const sameDir = existing.some(p => p.direction === sig.direction);
    if (sameDir) { log('info', `Already ${sig.direction} ${strat.instrumentName} — skip`); return; }

    log(sig.direction === 'BUY' ? 'buy' : 'sell',
      `${sig.direction} ${strat.size} pt/pt on ${strat.instrumentName} (${env}) — ${sig.reason}`);

    const cfg = TIMEFRAME_CONFIG[strat.timeframe];
    const res = await fetch('/api/ig/order', {
      method: 'POST',
      headers: { ...makeHeaders(session!, igApiKey, env), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        epic: strat.epic,
        direction: sig.direction,
        size: strat.size,
        stopDistance: sig.stopPoints,
        profitDistance: sig.targetPoints,
        currencyCode: 'GBP',
      }),
    });
    const data = await res.json() as { ok: boolean; dealReference?: string; error?: string };
    if (data.ok) {
      log('buy', `✅ Order placed — ref: ${data.dealReference ?? 'n/a'}`);
      showToast(true, `${sig.direction} order placed on ${strat.instrumentName}`);
      await loadPositions();
    } else {
      log('error', `Order failed: ${data.error ?? 'unknown'}`);
      showToast(false, `Order failed: ${data.error ?? 'unknown'}`);
    }
    void cfg;
  }

  // ── Run strategy once ──────────────────────────────────────────────────────
  async function runStrategy(strat: IGSavedStrategy) {
    if (!session) return;
    setAnalyzing(true);
    const sig = await analyseStrategy(strat);
    if (!sig) { setAnalyzing(false); return; }

    log('signal', `Signal: ${sig.direction} (${sig.strength}%) — ${sig.reason}`);

    if (strat.autoTrade) {
      for (const env of strat.accounts) {
        await executeSignal(strat, sig, env);
      }
    }

    // Update lastRunAt
    const updated: IGSavedStrategy = { ...strat, lastRunAt: new Date().toISOString(), lastSignal: sig.direction };
    saveStrategy(updated);
    setStrategies(loadStrategies());
    setAnalyzing(false);
  }

  // ── Auto-run loop ──────────────────────────────────────────────────────────
  function startAutoRun(strat: IGSavedStrategy) {
    if (timerRef.current) clearInterval(timerRef.current);
    const cfg = TIMEFRAME_CONFIG[strat.timeframe];
    log('info', `Auto-run started — checking every ${cfg.pollMs / 60_000 < 1 ? `${cfg.pollMs / 1000}s` : `${cfg.pollMs / 60_000}min`}`);
    setIsRunning(true);
    void runStrategy(strat);
    timerRef.current = setInterval(() => void runStrategy(strat), cfg.pollMs);
  }

  function stopAutoRun() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setIsRunning(false);
    log('info', 'Auto-run stopped');
  }

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  // ── Close position ─────────────────────────────────────────────────────────
  async function handleClose(pos: IGPosition) {
    if (!session) return;
    setClosingId(pos.dealId);
    const res = await fetch('/api/ig/order', {
      method: 'DELETE',
      headers: { ...makeHeaders(session, igApiKey, igEnv), 'Content-Type': 'application/json' },
      body: JSON.stringify({ dealId: pos.dealId, direction: pos.direction === 'BUY' ? 'SELL' : 'BUY', size: pos.size }),
    });
    const data = await res.json() as { ok: boolean; error?: string };
    if (data.ok) {
      log('close', `Closed ${pos.direction} ${pos.instrumentName ?? pos.epic}`);
      showToast(true, `Position closed`);
      await loadPositions();
    } else {
      showToast(false, data.error ?? 'Close failed');
    }
    setClosingId(null);
  }

  // ── Save strategy ──────────────────────────────────────────────────────────
  function handleSaveStrategy() {
    if (!builderEpic || !builderName) { showToast(false, 'Name and epic required'); return; }
    const s: IGSavedStrategy = {
      id: uid(),
      name: builderName,
      epic: builderEpic,
      instrumentName: builderInstrName || builderEpic,
      timeframe: builderTimeframe,
      size: builderSize,
      maxPositions: builderMaxPos,
      accounts: builderAccounts,
      autoTrade: builderAutoTrade,
      createdAt: new Date().toISOString(),
    };
    saveStrategy(s);
    setStrategies(loadStrategies());
    setShowBuilder(false);
    setBuilderName(''); setBuilderEpic(''); setBuilderInstrName('');
    showToast(true, `Strategy "${s.name}" saved`);
  }

  // ── Totals ─────────────────────────────────────────────────────────────────
  const totalPnL = positions.reduce((s, p) => s + (p.upl ?? 0), 0);
  const activeSig = signal;

  // ── Not connected view ─────────────────────────────────────────────────────
  if (!session && !connecting) {
    return (
      <div className="max-w-xl space-y-4">
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-orange-500/20 flex items-center justify-center text-2xl">🏦</div>
            <div>
              <h3 className="text-sm font-semibold text-white">IG Automated Strategy Trader</h3>
              <p className="text-xs text-gray-500">Connect to start automated spread betting</p>
            </div>
          </div>
          <div className="flex gap-2 mb-4">
            {(['demo', 'live'] as const).map(e => (
              <button key={e} onClick={() => setIgEnv(e)}
                className={clsx('flex-1 py-2 rounded-lg text-sm font-medium transition-all',
                  igEnv === e ? 'bg-orange-500/20 text-orange-300 border border-orange-500/30' : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                )}>
                {e === 'demo' ? 'Demo' : '⚠️ Live'}
              </button>
            ))}
          </div>
          {connError && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400 mb-3">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" /> {connError}
            </div>
          )}
          <p className="text-xs text-gray-400 mb-3">
            Set up IG credentials in{' '}
            <a href="/settings/accounts" className="text-orange-400 hover:underline">Settings → Accounts</a> first.
          </p>
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5 text-xs text-amber-400">
            ⚠️ Spread bets and CFDs are complex instruments. 68% of retail investor accounts lose money. Only trade with money you can afford to lose. This tool does not constitute financial advice.
          </div>
        </Card>
      </div>
    );
  }

  if (connecting) {
    return (
      <div className="flex items-center gap-3 text-gray-400 py-8">
        <RefreshCw className="h-5 w-5 animate-spin" />
        Connecting to IG {igEnv} account…
      </div>
    );
  }

  // ── Connected view ─────────────────────────────────────────────────────────
  const activeStrat = strategies.find(s => s.id === activeStratId) ?? null;

  return (
    <div className="space-y-4">
      {/* Toast */}
      {toast && (
        <div className={clsx('flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium',
          toast.ok ? 'bg-emerald-500/15 border border-emerald-500/25 text-emerald-400' : 'bg-red-500/15 border border-red-500/25 text-red-400'
        )}>
          {toast.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
          {toast.msg}
        </div>
      )}

      {/* Header bar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className={clsx('flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full',
            igEnv === 'demo' ? 'bg-blue-500/20 text-blue-400' : 'bg-emerald-500/20 text-emerald-400'
          )}>
            <Wifi className="h-3 w-3" />
            IG {igEnv === 'demo' ? 'Demo' : 'Live'}
            {session?.accountId && <span className="opacity-60 ml-1">#{session.accountId}</span>}
          </div>
          <div className="flex gap-1">
            {(['demo', 'live'] as const).map(e => (
              <button key={e} onClick={() => { stopAutoRun(); setIgEnv(e); }}
                className={clsx('px-2.5 py-1 rounded-lg text-xs font-medium transition-all capitalize',
                  igEnv === e ? 'bg-orange-500/20 text-orange-300' : 'text-gray-500 hover:text-gray-300'
                )}>
                {e}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={loadPositions} loading={loadingPos}>
            Refresh
          </Button>
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setShowBuilder(v => !v)}>
            New Strategy
          </Button>
        </div>
      </div>

      {/* Risk warning */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-xs text-amber-400">
        ⚠️ Spread bets are complex instruments. 68% of retail investor accounts lose money. Only trade with money you can afford to lose. This tool does not constitute financial advice.
      </div>

      {/* ── Strategy builder ─────────────────────────────────────────────── */}
      {showBuilder && (
        <Card>
          <CardHeader title="New Strategy" subtitle="Configure and save a trading strategy" icon={<Zap className="h-4 w-4" />}
            action={<button onClick={() => setShowBuilder(false)}><X className="h-4 w-4 text-gray-500 hover:text-white" /></button>}
          />
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Strategy Name</label>
                <input value={builderName} onChange={e => setBuilderName(e.target.value)}
                  placeholder="e.g. FTSE Swing"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Timeframe</label>
                <select value={builderTimeframe} onChange={e => setBuilderTimeframe(e.target.value as Timeframe)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500">
                  <option value="hourly">Hourly (Scalp) — 2:1 R:R</option>
                  <option value="daily">Daily (Swing) — 3:1 R:R</option>
                  <option value="longterm">Long-term — 3:1 R:R</option>
                </select>
              </div>
            </div>

            <div className="bg-gray-800/40 rounded-lg px-3 py-2 text-xs text-gray-400">
              {TIMEFRAME_CONFIG[builderTimeframe].description}
            </div>

            {/* Market search for epic */}
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Market / Instrument</label>
              <div className="flex gap-2">
                <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && void handleSearch()}
                  placeholder="Search FTSE, Gold, GBP/USD…"
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
                <Button size="sm" onClick={handleSearch} loading={searching} icon={<Search className="h-3.5 w-3.5" />}>Search</Button>
              </div>
              {searchResults.length > 0 && (
                <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                  {searchResults.slice(0, 10).map(m => (
                    <button key={m.epic} onClick={() => { setBuilderEpic(m.epic); setBuilderInstrName(m.instrumentName); setSearchResults([]); }}
                      className={clsx('w-full flex items-center justify-between px-3 py-2 rounded-lg text-left text-xs transition-all',
                        builderEpic === m.epic ? 'bg-orange-500/20 border border-orange-500/30' : 'bg-gray-800/60 hover:bg-gray-700/60'
                      )}>
                      <div>
                        <p className="font-semibold text-white">{m.instrumentName}</p>
                        <p className="text-gray-500 font-mono">{m.epic}</p>
                      </div>
                      <div className="text-right text-gray-400">
                        <p>{m.bid} / {m.offer}</p>
                        <p className="text-[10px] text-gray-600">{m.instrumentType}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {builderEpic && (
                <div className="mt-2 flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2 text-xs text-orange-300">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Selected: <span className="font-semibold">{builderInstrName}</span>
                  <span className="font-mono text-orange-400/70 ml-1">{builderEpic}</span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Size (£/point)</label>
                <input type="number" min={0.5} max={100} step={0.5} value={builderSize} onChange={e => setBuilderSize(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Max open positions</label>
                <input type="number" min={1} max={10} value={builderMaxPos} onChange={e => setBuilderMaxPos(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
              </div>
            </div>

            <div>
              <label className="text-xs text-gray-400 mb-2 block">Trade on accounts</label>
              <div className="flex gap-2">
                {(['demo', 'live'] as const).map(acc => (
                  <button key={acc} onClick={() => setBuilderAccounts(prev =>
                    prev.includes(acc) ? prev.filter(a => a !== acc) : [...prev, acc]
                  )}
                    className={clsx('flex-1 py-2 rounded-lg text-sm font-medium border transition-all',
                      builderAccounts.includes(acc)
                        ? acc === 'demo' ? 'bg-blue-500/20 text-blue-300 border-blue-500/40' : 'bg-red-500/20 text-red-300 border-red-500/40'
                        : 'bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-300'
                    )}>
                    {acc === 'demo' ? 'Demo' : '⚠️ Live (real money)'}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between bg-gray-800/40 rounded-lg px-3 py-2.5">
              <div>
                <p className="text-xs font-medium text-white">Auto-trade signals</p>
                <p className="text-[11px] text-gray-500">Automatically open positions when signal fires</p>
              </div>
              <button onClick={() => setBuilderAutoTrade(v => !v)}
                className={clsx('w-11 h-6 rounded-full transition-all relative', builderAutoTrade ? 'bg-orange-500' : 'bg-gray-700')}>
                <span className={clsx('absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all', builderAutoTrade ? 'left-5' : 'left-0.5')} />
              </button>
            </div>

            {builderAutoTrade && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
                ⚠️ Auto-trade will open real positions. Ensure you understand the risks. Use Demo first.
              </div>
            )}

            <Button fullWidth icon={<Save className="h-4 w-4" />} onClick={handleSaveStrategy}
              disabled={!builderEpic || !builderName || builderAccounts.length === 0}>
              Save Strategy
            </Button>
          </div>
        </Card>
      )}

      {/* ── Saved strategies ─────────────────────────────────────────────── */}
      {strategies.length > 0 && (
        <Card>
          <CardHeader title="My Strategies" subtitle={`${strategies.length} saved`} icon={<Target className="h-4 w-4" />} />
          <div className="space-y-2">
            {strategies.map(strat => {
              const isActive = strat.id === activeStratId;
              const cfg = TIMEFRAME_CONFIG[strat.timeframe];
              return (
                <div key={strat.id}
                  className={clsx('rounded-xl border p-3 transition-all',
                    isActive ? 'border-orange-500/50 bg-orange-500/5' : 'border-gray-800 bg-gray-800/30'
                  )}>
                  <div className="flex items-start justify-between gap-2">
                    <button onClick={() => setActiveStratId(isActive ? null : strat.id)} className="flex-1 text-left">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-white">{strat.name}</p>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-300">{cfg.label}</span>
                        {strat.autoTrade && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400">Auto</span>}
                        {strat.accounts.map(a => (
                          <span key={a} className={clsx('text-[10px] px-1.5 py-0.5 rounded-full',
                            a === 'demo' ? 'bg-blue-500/20 text-blue-400' : 'bg-red-500/20 text-red-400'
                          )}>{a}</span>
                        ))}
                      </div>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        {strat.instrumentName} · £{strat.size}/pt · max {strat.maxPositions} pos
                        {strat.lastRunAt && ` · last run ${fmtTime(strat.lastRunAt)}`}
                        {strat.lastSignal && ` · ${strat.lastSignal}`}
                      </p>
                    </button>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {isActive && (
                        isRunning ? (
                          <Button size="sm" onClick={stopAutoRun}
                            className="bg-red-600 hover:bg-red-500 text-white"
                            icon={<Square className="h-3.5 w-3.5" />}>Stop</Button>
                        ) : (
                          <>
                            <Button size="sm" variant="outline" onClick={() => void runStrategy(strat)} loading={analyzing}
                              icon={<BarChart3 className="h-3.5 w-3.5" />}>Analyse</Button>
                            <Button size="sm" onClick={() => startAutoRun(strat)}
                              className="bg-orange-600 hover:bg-orange-500 text-white"
                              icon={<Play className="h-3.5 w-3.5" />}>Run</Button>
                          </>
                        )
                      )}
                      <button onClick={() => { deleteStrategy(strat.id); setStrategies(loadStrategies()); if (activeStratId === strat.id) { setActiveStratId(null); stopAutoRun(); } }}
                        className="p-1.5 text-gray-600 hover:text-red-400 transition-colors">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {strategies.length === 0 && !showBuilder && (
        <div className="text-center py-8 text-gray-500">
          <Target className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No strategies yet</p>
          <p className="text-xs mt-1">Click "New Strategy" to create your first automated strategy</p>
        </div>
      )}

      {/* ── Signal panel ─────────────────────────────────────────────────── */}
      {activeSig && activeStrat && (
        <Card>
          <div className="flex items-start justify-between mb-3">
            <div>
              <p className="text-xs text-gray-500 mb-1">{activeStrat.instrumentName} · {TIMEFRAME_CONFIG[activeStrat.timeframe].label}</p>
              <SignalBadge signal={activeSig} />
            </div>
            <div className="text-right text-xs text-gray-500">
              <p>Stop: {activeSig.stopPoints} pts</p>
              <p>Target: {activeSig.targetPoints} pts</p>
              <p className="text-orange-400 font-semibold">R:R {activeSig.riskReward}</p>
            </div>
          </div>

          <p className="text-xs text-gray-300 leading-relaxed mb-3">{activeSig.reason}</p>

          {/* Strength bar */}
          <div className="mb-4">
            <div className="flex justify-between text-xs mb-1">
              <span className="text-gray-500">Signal strength</span>
              <span className={clsx('font-semibold',
                activeSig.strength >= 70 ? 'text-emerald-400' : activeSig.strength >= 45 ? 'text-amber-400' : 'text-gray-500'
              )}>{activeSig.strength}%</span>
            </div>
            <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div className={clsx('h-full rounded-full transition-all',
                activeSig.direction === 'BUY' ? 'bg-emerald-500' : activeSig.direction === 'SELL' ? 'bg-red-500' : 'bg-gray-600'
              )} style={{ width: `${activeSig.strength}%` }} />
            </div>
          </div>

          {/* Indicators */}
          <div className="space-y-0">
            {activeSig.indicators.map(ind => (
              <IndicatorRow key={ind.label} {...ind} />
            ))}
          </div>

          {/* Candles info */}
          {candles.length > 0 && (
            <p className="text-[10px] text-gray-600 mt-3">{candles.length} candles · Latest close: {candles[candles.length - 1]?.close.toFixed(2)}</p>
          )}
        </Card>
      )}

      {/* ── Open positions ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Open Positions"
          subtitle={`${positions.length} open · P&L: ${totalPnL >= 0 ? '+' : ''}£${totalPnL.toFixed(2)}`}
          icon={<BarChart3 className="h-4 w-4" />}
        />
        {positions.length === 0 ? (
          <p className="text-sm text-gray-500 py-3 text-center">No open positions</p>
        ) : (
          <div className="space-y-2">
            {positions.map(pos => (
              <div key={pos.dealId} className="flex items-center justify-between bg-gray-800/40 rounded-lg px-3 py-2.5 gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded',
                      pos.direction === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                    )}>{pos.direction}</span>
                    <p className="text-xs font-semibold text-white truncate">{pos.instrumentName ?? pos.epic}</p>
                    <span className="text-[10px] text-emerald-400 font-medium">TAX FREE</span>
                  </div>
                  <p className="text-[10px] text-gray-500">Size: {pos.size} · Level: {pos.level} · {pos.currency}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={clsx('text-sm font-semibold font-mono',
                    (pos.upl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                  )}>
                    {(pos.upl ?? 0) >= 0 ? '+' : '-'}{fmt(pos.upl ?? 0)}
                  </span>
                  <Button size="sm" variant="outline" loading={closingId === pos.dealId}
                    onClick={() => void handleClose(pos)}
                    className="text-red-400 border-red-500/30 hover:bg-red-500/10">
                    Close
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── Run log ───────────────────────────────────────────────────────── */}
      {runLog.length > 0 && (
        <Card>
          <CardHeader title="Strategy Log" subtitle={`${runLog.length} entries`} icon={<Clock className="h-4 w-4" />}
            action={<button onClick={() => setRunLog([])} className="text-xs text-gray-500 hover:text-white">Clear</button>}
          />
          <div className="space-y-1 max-h-64 overflow-y-auto font-mono">
            {runLog.map(entry => (
              <div key={entry.id} className="flex gap-2 text-[11px]">
                <span className="text-gray-600 flex-shrink-0">{fmtTime(entry.ts)}</span>
                <span className={clsx('flex-1',
                  entry.type === 'buy' ? 'text-emerald-400' :
                  entry.type === 'sell' ? 'text-red-400' :
                  entry.type === 'close' ? 'text-blue-400' :
                  entry.type === 'error' ? 'text-red-500' :
                  entry.type === 'signal' ? 'text-amber-400' :
                  'text-gray-400'
                )}>{entry.msg}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Footer note */}
      <p className="text-[10px] text-gray-600 text-center">
        Spread betting profits are exempt from UK CGT and Income Tax · Losses cannot be offset against gains
      </p>
    </div>
  );
}

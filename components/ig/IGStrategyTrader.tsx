'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play, Square, Save, Trash2, Plus, RefreshCw, Search,
  AlertCircle, CheckCircle2, Clock, BarChart3, Target,
  TrendingUp, TrendingDown, Minus, Wifi, X, Zap,
  ChevronDown, ChevronUp, Edit2, ArrowUpDown,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  type Timeframe, type IGSavedStrategy, type StrategySignal, type Candle,
  getSignal, loadStrategies, saveStrategy, deleteStrategy, TIMEFRAME_CONFIG,
} from '@/lib/igStrategyEngine';

// ── Types ─────────────────────────────────────────────────────────────────────

type IGSession = { cst: string; securityToken: string; accountId: string; apiKey: string };

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

type PositionMap = Record<'demo' | 'live', IGPosition[]>;

function uid() { return Math.random().toString(36).slice(2, 9); }
function fmt(n: number) { return `£${Math.abs(n).toFixed(2)}`; }
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Session helpers ───────────────────────────────────────────────────────────

function makeHeaders(session: IGSession, env: 'demo' | 'live', extra?: Record<string, string>) {
  return {
    'x-ig-cst': session.cst,
    'x-ig-security-token': session.securityToken,
    'x-ig-api-key': session.apiKey,
    'x-ig-env': env,
    ...extra,
  };
}

async function connectIG(env: 'demo' | 'live'): Promise<IGSession | null> {
  const storageKey = env === 'demo' ? 'ig_demo_credentials' : 'ig_live_credentials';
  try {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return null;
    const creds = JSON.parse(saved) as { username: string; password: string; apiKey: string; connected?: boolean };
    if (!creds.connected) return null;
    const res = await fetch('/api/ig/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: creds.username, password: creds.password, apiKey: creds.apiKey, env }),
    });
    const data = await res.json() as { ok: boolean; cst?: string; securityToken?: string; accountId?: string };
    if (data.ok && data.cst && data.securityToken) {
      return { cst: data.cst, securityToken: data.securityToken, accountId: data.accountId ?? '', apiKey: creds.apiKey };
    }
  } catch {}
  return null;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SignalBadge({ signal }: { signal: StrategySignal }) {
  const color =
    signal.direction === 'BUY'  ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
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

function MarketSearch({
  session, env, onSelect, placeholder = 'Search market…',
}: {
  session: IGSession;
  env: 'demo' | 'live';
  onSelect: (m: IGMarketResult) => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<IGMarketResult[]>([]);
  const [searching, setSearching] = useState(false);

  async function search() {
    if (!q.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/ig/markets?q=${encodeURIComponent(q)}`, { headers: makeHeaders(session, env) });
      const data = await res.json() as { ok: boolean; markets?: IGMarketResult[] };
      if (data.ok) setResults(data.markets ?? []);
    } catch {}
    setSearching(false);
  }

  return (
    <div>
      <div className="flex gap-2">
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && void search()}
          placeholder={placeholder}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
        <Button size="sm" onClick={search} loading={searching} icon={<Search className="h-3.5 w-3.5" />}>Search</Button>
      </div>
      {results.length > 0 && (
        <div className="mt-2 space-y-1 max-h-44 overflow-y-auto border border-gray-700 rounded-lg divide-y divide-gray-800">
          {results.slice(0, 8).map(m => (
            <button key={m.epic} onClick={() => { onSelect(m); setResults([]); setQ(''); }}
              className="w-full flex items-center justify-between px-3 py-2 text-left text-xs hover:bg-gray-800/80 transition-colors">
              <div>
                <p className="font-semibold text-white">{m.instrumentName}</p>
                <p className="text-gray-500 font-mono text-[10px]">{m.epic} · {m.instrumentType}</p>
              </div>
              <p className="text-gray-400 font-mono">{m.bid} / {m.offer}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function IGStrategyTrader() {
  // ── Sessions (demo + live independently) ──────────────────────────────────
  const [sessions, setSessions] = useState<Partial<Record<'demo' | 'live', IGSession>>>({});
  const [connecting, setConnecting] = useState<Partial<Record<'demo' | 'live', boolean>>>({});
  const [activeEnv, setActiveEnv] = useState<'demo' | 'live'>('demo');

  // ── Positions per env ──────────────────────────────────────────────────────
  const [positions, setPositions] = useState<PositionMap>({ demo: [], live: [] });
  const [loadingPos, setLoadingPos] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);

  // ── Strategies ─────────────────────────────────────────────────────────────
  const [strategies, setStrategies] = useState<IGSavedStrategy[]>([]);
  const [activeStratId, setActiveStratId] = useState<string | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);
  const [editingStratId, setEditingStratId] = useState<string | null>(null);

  // ── Builder form ───────────────────────────────────────────────────────────
  const [bName, setBName] = useState('');
  const [bEpic, setBEpic] = useState('');
  const [bInstrName, setBInstrName] = useState('');
  const [bTimeframe, setBTimeframe] = useState<Timeframe>('daily');
  const [bSize, setBSize] = useState(1);
  const [bMaxPos, setBMaxPos] = useState(2);
  const [bAccounts, setBAccounts] = useState<('demo' | 'live')[]>(['demo']);
  const [bAutoTrade, setBAutoTrade] = useState(false);
  const [bAutoClose, setBAutoClose] = useState(true);

  // ── Manual trade ───────────────────────────────────────────────────────────
  const [showManual, setShowManual] = useState(false);
  const [manualEpic, setManualEpic] = useState('');
  const [manualInstrName, setManualInstrName] = useState('');
  const [manualDir, setManualDir] = useState<'BUY' | 'SELL'>('BUY');
  const [manualSize, setManualSize] = useState(1);
  const [manualStop, setManualStop] = useState<number | ''>('');
  const [manualLimit, setManualLimit] = useState<number | ''>('');
  const [manualEnv, setManualEnv] = useState<'demo' | 'live'>('demo');
  const [placingManual, setPlacingManual] = useState(false);

  // ── Signal / analysis ──────────────────────────────────────────────────────
  const [signal, setSignal] = useState<StrategySignal | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [runLog, setRunLog] = useState<RunLog[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Toast ──────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  function showToast(ok: boolean, msg: string) { setToast({ ok, msg }); setTimeout(() => setToast(null), 4000); }
  function log(type: RunLog['type'], msg: string) {
    setRunLog(prev => [{ id: uid(), ts: new Date().toISOString(), type, msg }, ...prev].slice(0, 150));
  }

  // ── Connect both envs on mount ─────────────────────────────────────────────
  useEffect(() => {
    setStrategies(loadStrategies());
    (['demo', 'live'] as const).forEach(env => {
      setConnecting(c => ({ ...c, [env]: true }));
      connectIG(env).then(sess => {
        if (sess) setSessions(s => ({ ...s, [env]: sess }));
        setConnecting(c => ({ ...c, [env]: false }));
      });
    });
  }, []);

  // ── Load positions for a given env ────────────────────────────────────────
  const loadPositions = useCallback(async (env?: 'demo' | 'live') => {
    const envs: ('demo' | 'live')[] = env ? [env] : ['demo', 'live'];
    setLoadingPos(true);
    for (const e of envs) {
      const sess = sessions[e];
      if (!sess) continue;
      try {
        const res = await fetch('/api/ig/positions', { headers: makeHeaders(sess, e) });
        const data = await res.json() as { ok: boolean; positions?: IGPosition[] };
        if (data.ok) setPositions(prev => ({ ...prev, [e]: data.positions ?? [] }));
      } catch {}
    }
    setLoadingPos(false);
  }, [sessions]);

  useEffect(() => {
    const hasSessions = Object.keys(sessions).length > 0;
    if (hasSessions) void loadPositions();
  }, [sessions, loadPositions]);

  // ── Place order ─────────────────────────────────────────────────────────────
  async function placeOrder(
    env: 'demo' | 'live',
    epic: string,
    direction: 'BUY' | 'SELL',
    size: number,
    stopDistance?: number,
    limitDistance?: number,
  ): Promise<{ ok: boolean; dealReference?: string; error?: string }> {
    const sess = sessions[env];
    if (!sess) return { ok: false, error: `No ${env} session` };
    const res = await fetch('/api/ig/order', {
      method: 'POST',
      headers: { ...makeHeaders(sess, env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ epic, direction, size, stopDistance, profitDistance: limitDistance, currencyCode: 'GBP' }),
    });
    return res.json() as Promise<{ ok: boolean; dealReference?: string; error?: string }>;
  }

  async function closePosition(env: 'demo' | 'live', pos: IGPosition): Promise<{ ok: boolean; error?: string }> {
    const sess = sessions[env];
    if (!sess) return { ok: false, error: `No ${env} session` };
    const res = await fetch('/api/ig/order', {
      method: 'DELETE',
      headers: { ...makeHeaders(sess, env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ dealId: pos.dealId, direction: pos.direction === 'BUY' ? 'SELL' : 'BUY', size: pos.size }),
    });
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  }

  // ── Manual close button ─────────────────────────────────────────────────────
  async function handleClose(env: 'demo' | 'live', pos: IGPosition) {
    setClosingId(pos.dealId);
    const result = await closePosition(env, pos);
    if (result.ok) {
      log('close', `[${env.toUpperCase()}] Closed ${pos.direction} ${pos.instrumentName ?? pos.epic}`);
      showToast(true, 'Position closed');
      await loadPositions(env);
    } else {
      showToast(false, result.error ?? 'Close failed');
    }
    setClosingId(null);
  }

  // ── Manual open ─────────────────────────────────────────────────────────────
  async function handleManualOpen() {
    if (!manualEpic) { showToast(false, 'Select a market first'); return; }
    const sess = sessions[manualEnv];
    if (!sess) { showToast(false, `Not connected to ${manualEnv}`); return; }
    setPlacingManual(true);
    const result = await placeOrder(
      manualEnv, manualEpic, manualDir, manualSize,
      manualStop !== '' ? Number(manualStop) : undefined,
      manualLimit !== '' ? Number(manualLimit) : undefined,
    );
    if (result.ok) {
      log(manualDir === 'BUY' ? 'buy' : 'sell',
        `[${manualEnv.toUpperCase()}] Manual ${manualDir} ${manualSize}pt/pt on ${manualInstrName || manualEpic} — ref: ${result.dealReference ?? 'n/a'}`);
      showToast(true, `${manualDir} order placed on ${manualInstrName || manualEpic}`);
      await loadPositions(manualEnv);
    } else {
      log('error', `[${manualEnv.toUpperCase()}] Manual order failed: ${result.error ?? 'unknown'}`);
      showToast(false, result.error ?? 'Order failed');
    }
    setPlacingManual(false);
  }

  // ── Fetch candles + run signal ──────────────────────────────────────────────
  const analyseStrategy = useCallback(async (strat: IGSavedStrategy, env: 'demo' | 'live'): Promise<StrategySignal | null> => {
    const sess = sessions[env] ?? sessions['demo'] ?? sessions['live'];
    if (!sess) return null;
    const cfg = TIMEFRAME_CONFIG[strat.timeframe];
    try {
      const res = await fetch(
        `/api/ig/prices?epic=${encodeURIComponent(strat.epic)}&resolution=${cfg.resolution}&max=${cfg.max}`,
        { headers: makeHeaders(sess, env) }
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
  }, [sessions]);

  // ── Execute signal with auto-close logic ────────────────────────────────────
  async function executeSignal(strat: IGSavedStrategy, sig: StrategySignal, env: 'demo' | 'live') {
    if (sig.direction === 'HOLD') { log('signal', `[${env.toUpperCase()}] HOLD — ${sig.reason}`); return; }

    const envPositions = positions[env];
    const epicPositions = envPositions.filter(p => p.epic === strat.epic);

    // Auto-close opposite direction positions
    if (strat.autoTrade && (strat as IGSavedStrategy & { autoClose?: boolean }).autoClose !== false) {
      const opposite = sig.direction === 'BUY' ? 'SELL' : 'BUY';
      const toClose = epicPositions.filter(p => p.direction === opposite);
      for (const pos of toClose) {
        log('close', `[${env.toUpperCase()}] Auto-closing ${pos.direction} ${pos.instrumentName ?? pos.epic} (signal reversed)`);
        const result = await closePosition(env, pos);
        if (result.ok) {
          log('close', `[${env.toUpperCase()}] ✅ Closed — ref: ${result.error ?? 'ok'}`);
        } else {
          log('error', `[${env.toUpperCase()}] Close failed: ${result.error ?? 'unknown'}`);
        }
      }
      await loadPositions(env);
    }

    // Refresh positions after closing
    const currentEnvPos = positions[env].filter(p => p.epic === strat.epic);
    const alreadySameDir = currentEnvPos.some(p => p.direction === sig.direction);
    if (alreadySameDir) { log('info', `[${env.toUpperCase()}] Already ${sig.direction} ${strat.instrumentName} — skip`); return; }

    const openCount = currentEnvPos.length;
    if (openCount >= strat.maxPositions) {
      log('info', `[${env.toUpperCase()}] Max positions (${strat.maxPositions}) reached for ${strat.instrumentName}`);
      return;
    }

    log(sig.direction === 'BUY' ? 'buy' : 'sell',
      `[${env.toUpperCase()}] ${sig.direction} ${strat.size}pt on ${strat.instrumentName} — ${sig.reason}`);

    const result = await placeOrder(env, strat.epic, sig.direction, strat.size, sig.stopPoints, sig.targetPoints);
    if (result.ok) {
      log('buy', `[${env.toUpperCase()}] ✅ Order placed — ref: ${result.dealReference ?? 'n/a'}`);
      showToast(true, `[${env}] ${sig.direction} on ${strat.instrumentName}`);
      await loadPositions(env);
    } else {
      log('error', `[${env.toUpperCase()}] Order failed: ${result.error ?? 'unknown'}`);
      showToast(false, `[${env}] Order failed: ${result.error ?? 'unknown'}`);
    }
  }

  // ── Run strategy once ───────────────────────────────────────────────────────
  async function runStrategy(strat: IGSavedStrategy) {
    const envList = strat.accounts.filter(e => sessions[e]);
    if (envList.length === 0) { log('error', 'No connected session for this strategy\'s accounts'); return; }

    setAnalyzing(true);
    // Use the first available session env to fetch prices
    const primaryEnv = envList[0];
    const sig = await analyseStrategy(strat, primaryEnv);
    if (!sig) { setAnalyzing(false); return; }

    log('signal', `Signal: ${sig.direction} (${sig.strength}%) — ${sig.reason}`);

    if (strat.autoTrade) {
      for (const env of envList) {
        await executeSignal(strat, sig, env);
      }
    }

    const updated: IGSavedStrategy = { ...strat, lastRunAt: new Date().toISOString(), lastSignal: sig.direction };
    saveStrategy(updated);
    setStrategies(loadStrategies());
    setAnalyzing(false);
  }

  // ── Auto-run loop ───────────────────────────────────────────────────────────
  function startAutoRun(strat: IGSavedStrategy) {
    if (timerRef.current) clearInterval(timerRef.current);
    const cfg = TIMEFRAME_CONFIG[strat.timeframe];
    const intervalLabel = cfg.pollMs >= 3_600_000 ? `${cfg.pollMs / 3_600_000}hr`
      : cfg.pollMs >= 60_000 ? `${cfg.pollMs / 60_000}min`
      : `${cfg.pollMs / 1000}s`;
    log('info', `Auto-run started for "${strat.name}" — polling every ${intervalLabel}`);
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

  // ── Builder open/reset ──────────────────────────────────────────────────────
  function openBuilder(existing?: IGSavedStrategy) {
    if (existing) {
      setEditingStratId(existing.id);
      setBName(existing.name);
      setBEpic(existing.epic);
      setBInstrName(existing.instrumentName);
      setBTimeframe(existing.timeframe);
      setBSize(existing.size);
      setBMaxPos(existing.maxPositions);
      setBAccounts(existing.accounts);
      setBAutoTrade(existing.autoTrade);
      setBAutoClose((existing as IGSavedStrategy & { autoClose?: boolean }).autoClose !== false);
    } else {
      setEditingStratId(null);
      setBName(''); setBEpic(''); setBInstrName('');
      setBTimeframe('daily'); setBSize(1); setBMaxPos(2);
      setBAccounts(['demo']); setBAutoTrade(false); setBAutoClose(true);
    }
    setShowBuilder(true);
  }

  function handleSaveStrategy() {
    if (!bEpic.trim() || !bName.trim()) { showToast(false, 'Strategy name and market are required'); return; }
    if (bAccounts.length === 0) { showToast(false, 'Select at least one account'); return; }

    const s: IGSavedStrategy & { autoClose: boolean } = {
      id: editingStratId ?? uid(),
      name: bName.trim(),
      epic: bEpic.trim(),
      instrumentName: bInstrName || bEpic.trim(),
      timeframe: bTimeframe,
      size: bSize,
      maxPositions: bMaxPos,
      accounts: bAccounts,
      autoTrade: bAutoTrade,
      autoClose: bAutoClose,
      createdAt: new Date().toISOString(),
    };
    saveStrategy(s);
    setStrategies(loadStrategies());
    setShowBuilder(false);
    showToast(true, `Strategy "${s.name}" ${editingStratId ? 'updated' : 'saved'}`);
  }

  // ── Derived ─────────────────────────────────────────────────────────────────
  const activeStrat = strategies.find(s => s.id === activeStratId) ?? null;
  const anyConnected = Object.values(sessions).some(Boolean);
  const isConnecting = Object.values(connecting).some(Boolean);
  const allPositions = [...positions.demo, ...positions.live];
  const totalPnL = allPositions.reduce((s, p) => s + (p.upl ?? 0), 0);
  const demoPositions = positions.demo;
  const livePositions = positions.live;

  // ── Not connected view ──────────────────────────────────────────────────────
  if (!anyConnected && !isConnecting) {
    return (
      <div className="max-w-xl space-y-4">
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-orange-500/20 flex items-center justify-center text-2xl">🏦</div>
            <div>
              <h3 className="text-sm font-semibold text-white">IG Automated Strategy Trader</h3>
              <p className="text-xs text-gray-500">Connect your IG account to start automated spread betting</p>
            </div>
          </div>
          <p className="text-xs text-gray-400 mb-4">
            Set up your IG credentials in{' '}
            <a href="/settings/accounts" className="text-orange-400 hover:underline">Settings → Accounts</a>{' '}
            first, then come back here to trade.
          </p>
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5 text-xs text-amber-400">
            ⚠️ Spread bets and CFDs are complex instruments. 68% of retail investor accounts lose money. Only trade with money you can afford to lose.
          </div>
        </Card>
      </div>
    );
  }

  if (isConnecting && !anyConnected) {
    return (
      <div className="flex items-center gap-3 text-gray-400 py-8">
        <RefreshCw className="h-5 w-5 animate-spin" />
        Connecting to IG accounts…
      </div>
    );
  }

  // ── Connected view ──────────────────────────────────────────────────────────
  const builderSession = sessions['demo'] ?? sessions['live'];

  return (
    <div className="space-y-4 max-w-2xl">

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
        <div className="flex items-center gap-2 flex-wrap">
          {(['demo', 'live'] as const).map(env => (
            <div key={env} className={clsx(
              'flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full',
              sessions[env]
                ? env === 'demo' ? 'bg-blue-500/20 text-blue-400' : 'bg-emerald-500/20 text-emerald-400'
                : 'bg-gray-800 text-gray-500'
            )}>
              <Wifi className="h-3 w-3" />
              IG {env === 'demo' ? 'Demo' : 'Live'}
              {sessions[env]?.accountId && <span className="opacity-60">#{sessions[env]!.accountId}</span>}
              {connecting[env] && <RefreshCw className="h-2.5 w-2.5 animate-spin" />}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void loadPositions()} loading={loadingPos}>
            Refresh
          </Button>
          <Button size="sm" variant="outline" icon={<ArrowUpDown className="h-3.5 w-3.5" />} onClick={() => { setShowManual(v => !v); setShowBuilder(false); }}>
            Manual Trade
          </Button>
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => { openBuilder(); setShowManual(false); }}>
            New Strategy
          </Button>
        </div>
      </div>

      {/* Risk warning */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-xs text-amber-400">
        ⚠️ Spread bets are complex. 68% of retail accounts lose money. Use Demo first. Not financial advice.
      </div>

      {/* ── Manual Trade Panel ────────────────────────────────────────────── */}
      {showManual && (
        <Card>
          <CardHeader title="Manual Trade" subtitle="Open a position manually on demo or live"
            icon={<ArrowUpDown className="h-4 w-4" />}
            action={<button onClick={() => setShowManual(false)}><X className="h-4 w-4 text-gray-500 hover:text-white" /></button>}
          />
          <div className="space-y-3">
            {/* Account selector */}
            <div className="flex gap-2">
              {(['demo', 'live'] as const).map(env => (
                <button key={env} onClick={() => setManualEnv(env)} disabled={!sessions[env]}
                  className={clsx('flex-1 py-2 rounded-lg text-sm font-medium border transition-all',
                    !sessions[env] ? 'opacity-30 cursor-not-allowed bg-gray-800 text-gray-600 border-gray-700' :
                    manualEnv === env
                      ? env === 'demo' ? 'bg-blue-500/20 text-blue-300 border-blue-500/40' : 'bg-red-500/20 text-red-300 border-red-500/40'
                      : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-gray-200'
                  )}>
                  {env === 'demo' ? 'Demo' : '⚠️ Live'}
                </button>
              ))}
            </div>

            {/* Market search */}
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Market</label>
              {builderSession ? (
                <MarketSearch session={builderSession} env={manualEnv}
                  onSelect={m => { setManualEpic(m.epic); setManualInstrName(m.instrumentName); }}
                  placeholder="Search FTSE, Gold, GBP/USD…"
                />
              ) : (
                <p className="text-xs text-gray-500">No session available</p>
              )}
              {manualEpic && (
                <div className="mt-2 flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-1.5 text-xs text-orange-300">
                  <CheckCircle2 className="h-3 w-3" />
                  <span className="font-semibold">{manualInstrName}</span>
                  <span className="font-mono opacity-60">{manualEpic}</span>
                  <button onClick={() => { setManualEpic(''); setManualInstrName(''); }} className="ml-auto text-gray-500 hover:text-white">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>

            {/* Direction + Size */}
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-1">
                <label className="text-xs text-gray-400 mb-1.5 block">Direction</label>
                <div className="flex gap-1">
                  <button onClick={() => setManualDir('BUY')} className={clsx(
                    'flex-1 py-2 rounded-lg text-sm font-bold border transition-all',
                    manualDir === 'BUY' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' : 'bg-gray-800 text-gray-500 border-gray-700'
                  )}>BUY</button>
                  <button onClick={() => setManualDir('SELL')} className={clsx(
                    'flex-1 py-2 rounded-lg text-sm font-bold border transition-all',
                    manualDir === 'SELL' ? 'bg-red-500/20 text-red-300 border-red-500/40' : 'bg-gray-800 text-gray-500 border-gray-700'
                  )}>SELL</button>
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Size (£/pt)</label>
                <input type="number" min={0.5} step={0.5} value={manualSize} onChange={e => setManualSize(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Stop (pts)</label>
                <input type="number" min={1} value={manualStop} onChange={e => setManualStop(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="optional"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Limit / Take Profit (pts, optional)</label>
              <input type="number" min={1} value={manualLimit} onChange={e => setManualLimit(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="Leave blank for no limit order"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
            </div>

            {manualEnv === 'live' && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
                ⚠️ This will open a REAL position on your live IG account using real money.
              </div>
            )}

            <Button fullWidth loading={placingManual}
              className={manualDir === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-red-600 hover:bg-red-500 text-white'}
              icon={manualDir === 'BUY' ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              onClick={handleManualOpen}
              disabled={!manualEpic}>
              {manualDir} {manualSize}pt/pt{manualInstrName ? ` — ${manualInstrName}` : ''} ({manualEnv})
            </Button>
          </div>
        </Card>
      )}

      {/* ── Strategy builder ──────────────────────────────────────────────── */}
      {showBuilder && (
        <Card>
          <CardHeader
            title={editingStratId ? 'Edit Strategy' : 'New Strategy'}
            subtitle="Configure automated trading parameters"
            icon={<Zap className="h-4 w-4" />}
            action={<button onClick={() => setShowBuilder(false)}><X className="h-4 w-4 text-gray-500 hover:text-white" /></button>}
          />
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Strategy Name *</label>
                <input value={bName} onChange={e => setBName(e.target.value)} placeholder="e.g. FTSE Daily Swing"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Timeframe</label>
                <select value={bTimeframe} onChange={e => setBTimeframe(e.target.value as Timeframe)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500">
                  <option value="hourly">Hourly Scalp — EMA9/21 + RSI · 2:1</option>
                  <option value="daily">Daily Swing — EMA20/50 + MACD · 3:1</option>
                  <option value="longterm">Long-term — Golden/Death Cross · 3:1</option>
                </select>
              </div>
            </div>

            <div className="bg-gray-800/40 rounded-lg px-3 py-2 text-xs text-gray-400">
              {TIMEFRAME_CONFIG[bTimeframe].description}
            </div>

            {/* Market */}
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Market / Instrument *</label>
              {builderSession ? (
                <MarketSearch session={builderSession} env={bAccounts.includes('live') ? 'live' : 'demo'}
                  onSelect={m => { setBEpic(m.epic); setBInstrName(m.instrumentName); }}
                  placeholder="Search FTSE, Gold, GBP/USD…"
                />
              ) : (
                <p className="text-xs text-gray-500">No IG session — connect in Settings → Accounts</p>
              )}
              {/* Also allow manual epic entry */}
              <div className="mt-2 flex gap-2 items-center">
                <span className="text-[10px] text-gray-600">Or enter epic directly:</span>
                <input value={bEpic} onChange={e => { setBEpic(e.target.value); if (!bInstrName) setBInstrName(e.target.value); }}
                  placeholder="e.g. IX.D.FTSE.CFD.IP"
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-orange-500 font-mono" />
              </div>
              {bEpic && (
                <div className="mt-1.5 flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-1.5 text-xs text-orange-300">
                  <CheckCircle2 className="h-3 w-3 flex-shrink-0" />
                  <span className="font-semibold">{bInstrName}</span>
                  <span className="font-mono text-orange-400/60">{bEpic}</span>
                  <button onClick={() => { setBEpic(''); setBInstrName(''); }} className="ml-auto text-gray-500 hover:text-white"><X className="h-3 w-3" /></button>
                </div>
              )}
            </div>

            {/* Size + max pos */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Size (£/point)</label>
                <input type="number" min={0.5} max={100} step={0.5} value={bSize} onChange={e => setBSize(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Max open positions</label>
                <input type="number" min={1} max={10} value={bMaxPos} onChange={e => setBMaxPos(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
              </div>
            </div>

            {/* Accounts */}
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Trade on accounts</label>
              <div className="flex gap-2">
                {(['demo', 'live'] as const).map(acc => (
                  <button key={acc}
                    disabled={!sessions[acc]}
                    onClick={() => setBAccounts(prev => prev.includes(acc) ? prev.filter(a => a !== acc) : [...prev, acc])}
                    className={clsx('flex-1 py-2 rounded-lg text-sm font-medium border transition-all',
                      !sessions[acc] ? 'opacity-30 cursor-not-allowed bg-gray-800 text-gray-600 border-gray-700' :
                      bAccounts.includes(acc)
                        ? acc === 'demo' ? 'bg-blue-500/20 text-blue-300 border-blue-500/40' : 'bg-red-500/20 text-red-300 border-red-500/40'
                        : 'bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-300'
                    )}>
                    {acc === 'demo' ? 'Demo' : '⚠️ Live (real money)'}
                    {!sessions[acc] && <span className="text-[10px] block opacity-50">not connected</span>}
                  </button>
                ))}
              </div>
            </div>

            {/* Toggles */}
            <div className="space-y-2">
              {[
                { label: 'Auto-trade signals', sub: 'Automatically open positions when signal fires', val: bAutoTrade, set: setBAutoTrade },
                { label: 'Auto-close on reversal', sub: 'Close opposing positions when signal reverses', val: bAutoClose, set: setBAutoClose },
              ].map(({ label, sub, val, set }) => (
                <div key={label} className="flex items-center justify-between bg-gray-800/40 rounded-lg px-3 py-2.5">
                  <div>
                    <p className="text-xs font-medium text-white">{label}</p>
                    <p className="text-[11px] text-gray-500">{sub}</p>
                  </div>
                  <button onClick={() => set(v => !v)}
                    className={clsx('w-11 h-6 rounded-full transition-all relative flex-shrink-0', val ? 'bg-orange-500' : 'bg-gray-700')}>
                    <span className={clsx('absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all', val ? 'left-5' : 'left-0.5')} />
                  </button>
                </div>
              ))}
            </div>

            {bAutoTrade && bAccounts.includes('live') && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
                ⚠️ Auto-trade on LIVE will open real positions with real money. Use demo first.
              </div>
            )}

            <Button fullWidth icon={<Save className="h-4 w-4" />} onClick={handleSaveStrategy}>
              {editingStratId ? 'Update Strategy' : 'Save Strategy'}
            </Button>
          </div>
        </Card>
      )}

      {/* ── Saved strategies ──────────────────────────────────────────────── */}
      {strategies.length === 0 && !showBuilder && !showManual ? (
        <div className="text-center py-8 text-gray-500">
          <Target className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No strategies yet</p>
          <p className="text-xs mt-1">Click "New Strategy" to create an automated strategy, or "Manual Trade" to place a quick order</p>
        </div>
      ) : strategies.length > 0 && (
        <Card>
          <CardHeader title="My Strategies" subtitle={`${strategies.length} saved`} icon={<Target className="h-4 w-4" />} />
          <div className="space-y-2">
            {strategies.map(strat => {
              const isActive = strat.id === activeStratId;
              const cfg = TIMEFRAME_CONFIG[strat.timeframe];
              const s = strat as IGSavedStrategy & { autoClose?: boolean };
              return (
                <div key={strat.id} className={clsx('rounded-xl border p-3 transition-all',
                  isActive ? 'border-orange-500/50 bg-orange-500/5' : 'border-gray-800 bg-gray-800/30'
                )}>
                  <div className="flex items-start justify-between gap-2">
                    <button onClick={() => setActiveStratId(isActive ? null : strat.id)} className="flex-1 text-left min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="text-sm font-semibold text-white">{strat.name}</p>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-300">{cfg.label}</span>
                        {strat.autoTrade && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400">Auto</span>}
                        {s.autoClose && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-400">AutoClose</span>}
                        {strat.accounts.map(a => (
                          <span key={a} className={clsx('text-[10px] px-1.5 py-0.5 rounded-full',
                            a === 'demo' ? 'bg-blue-500/20 text-blue-400' : 'bg-red-500/20 text-red-400'
                          )}>{a}</span>
                        ))}
                        {strat.lastSignal && (
                          <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full font-bold',
                            strat.lastSignal === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' :
                            strat.lastSignal === 'SELL' ? 'bg-red-500/20 text-red-400' : 'bg-gray-700 text-gray-400'
                          )}>{strat.lastSignal}</span>
                        )}
                      </div>
                      <p className="text-[11px] text-gray-500 mt-0.5 truncate">
                        {strat.instrumentName} · £{strat.size}/pt · max {strat.maxPositions}
                        {strat.lastRunAt && ` · ${fmtTime(strat.lastRunAt)}`}
                      </p>
                    </button>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {isActive && (
                        isRunning ? (
                          <Button size="sm" className="bg-red-600 hover:bg-red-500 text-white" icon={<Square className="h-3.5 w-3.5" />} onClick={stopAutoRun}>Stop</Button>
                        ) : (
                          <>
                            <Button size="sm" variant="outline" loading={analyzing} icon={<BarChart3 className="h-3.5 w-3.5" />}
                              onClick={() => void runStrategy(strat)}>Analyse</Button>
                            <Button size="sm" className="bg-orange-600 hover:bg-orange-500 text-white" icon={<Play className="h-3.5 w-3.5" />}
                              onClick={() => startAutoRun(strat)}>Run</Button>
                          </>
                        )
                      )}
                      <button onClick={() => openBuilder(strat)} className="p-1.5 text-gray-600 hover:text-orange-400 transition-colors" title="Edit">
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => { deleteStrategy(strat.id); setStrategies(loadStrategies()); if (activeStratId === strat.id) { setActiveStratId(null); stopAutoRun(); } }}
                        className="p-1.5 text-gray-600 hover:text-red-400 transition-colors" title="Delete">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Expanded: signal panel */}
                  {isActive && signal && (
                    <div className="mt-3 pt-3 border-t border-gray-700/50 space-y-3">
                      <div className="flex items-start justify-between">
                        <SignalBadge signal={signal} />
                        <div className="text-right text-xs text-gray-500">
                          <p>Stop {signal.stopPoints} pts · Target {signal.targetPoints} pts</p>
                          <p className="text-orange-400 font-semibold">R:R {signal.riskReward}</p>
                        </div>
                      </div>
                      <p className="text-xs text-gray-300 leading-relaxed">{signal.reason}</p>
                      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div className={clsx('h-full rounded-full transition-all',
                          signal.direction === 'BUY' ? 'bg-emerald-500' : signal.direction === 'SELL' ? 'bg-red-500' : 'bg-gray-600'
                        )} style={{ width: `${signal.strength}%` }} />
                      </div>
                      <div className="space-y-0">
                        {signal.indicators.map(ind => (
                          <div key={ind.label} className="flex items-center justify-between py-1 border-b border-gray-800 last:border-0">
                            <span className="text-xs text-gray-500">{ind.label}</span>
                            <span className={clsx('text-xs font-mono font-semibold',
                              ind.status === 'bullish' ? 'text-emerald-400' : ind.status === 'bearish' ? 'text-red-400' : 'text-gray-400'
                            )}>{ind.value}</span>
                          </div>
                        ))}
                      </div>
                      {candles.length > 0 && (
                        <p className="text-[10px] text-gray-600">{candles.length} candles · close: {candles[candles.length - 1]?.close.toFixed(2)}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* ── Open Positions ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Open Positions"
          subtitle={`${allPositions.length} open · P&L: ${totalPnL >= 0 ? '+' : ''}£${totalPnL.toFixed(2)}`}
          icon={<BarChart3 className="h-4 w-4" />}
        />

        {allPositions.length === 0 ? (
          <p className="text-sm text-gray-500 py-3 text-center">No open positions</p>
        ) : (
          <div className="space-y-3">
            {/* Demo positions */}
            {demoPositions.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider mb-1.5">Demo</p>
                <div className="space-y-1.5">
                  {demoPositions.map(pos => (
                    <PositionRow key={pos.dealId} pos={pos} env="demo" closingId={closingId} onClose={handleClose} />
                  ))}
                </div>
              </div>
            )}
            {/* Live positions */}
            {livePositions.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold text-red-400 uppercase tracking-wider mb-1.5">Live</p>
                <div className="space-y-1.5">
                  {livePositions.map(pos => (
                    <PositionRow key={pos.dealId} pos={pos} env="live" closingId={closingId} onClose={handleClose} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ── Run log ────────────────────────────────────────────────────────── */}
      {runLog.length > 0 && (
        <Card>
          <CardHeader title="Activity Log" subtitle={`${runLog.length} entries`} icon={<Clock className="h-4 w-4" />}
            action={<button onClick={() => setRunLog([])} className="text-xs text-gray-500 hover:text-white">Clear</button>}
          />
          <div className="space-y-1 max-h-64 overflow-y-auto font-mono">
            {runLog.map(entry => (
              <div key={entry.id} className="flex gap-2 text-[11px]">
                <span className="text-gray-600 flex-shrink-0">{fmtTime(entry.ts)}</span>
                <span className={clsx('flex-1 break-all',
                  entry.type === 'buy'    ? 'text-emerald-400' :
                  entry.type === 'sell'   ? 'text-red-400' :
                  entry.type === 'close'  ? 'text-blue-400' :
                  entry.type === 'error'  ? 'text-red-500' :
                  entry.type === 'signal' ? 'text-amber-400' :
                  'text-gray-400'
                )}>{entry.msg}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <p className="text-[10px] text-gray-600 text-center">
        Spread betting profits are exempt from UK CGT and Income Tax · Losses cannot be offset against gains
      </p>
    </div>
  );
}

// ── Position row sub-component ────────────────────────────────────────────────

function PositionRow({ pos, env, closingId, onClose }: {
  pos: IGPosition;
  env: 'demo' | 'live';
  closingId: string | null;
  onClose: (env: 'demo' | 'live', pos: IGPosition) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-gray-800/40 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2.5 gap-3">
        <button className="flex-1 min-w-0 text-left flex items-center gap-2" onClick={() => setExpanded(v => !v)}>
          <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0',
            pos.direction === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
          )}>{pos.direction}</span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-white truncate">{pos.instrumentName ?? pos.epic}</p>
            <p className="text-[10px] text-gray-500">£{pos.size}/pt · entry {pos.level}</p>
          </div>
          {expanded ? <ChevronUp className="h-3 w-3 text-gray-600 flex-shrink-0" /> : <ChevronDown className="h-3 w-3 text-gray-600 flex-shrink-0" />}
        </button>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={clsx('text-sm font-semibold font-mono',
            (pos.upl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
          )}>
            {(pos.upl ?? 0) >= 0 ? '+' : '-'}{fmt(pos.upl ?? 0)}
          </span>
          <Button size="sm" variant="outline" loading={closingId === pos.dealId}
            onClick={() => onClose(env, pos)}
            className="text-red-400 border-red-500/30 hover:bg-red-500/10">
            Close
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="px-3 pb-2.5 grid grid-cols-3 gap-2 text-[11px] border-t border-gray-700/40 pt-2">
          <div><p className="text-gray-600">Bid</p><p className="text-white font-mono">{pos.bid}</p></div>
          <div><p className="text-gray-600">Offer</p><p className="text-white font-mono">{pos.offer}</p></div>
          <div><p className="text-gray-600">Currency</p><p className="text-white">{pos.currency} <span className="text-emerald-400 text-[9px]">TAX FREE</span></p></div>
          <div className="col-span-3"><p className="text-gray-600">Deal ID</p><p className="text-gray-400 font-mono text-[10px] break-all">{pos.dealId}</p></div>
        </div>
      )}
    </div>
  );
}

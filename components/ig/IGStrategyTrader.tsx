'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play, Square, Save, Trash2, Plus, RefreshCw, Search,
  AlertCircle, CheckCircle2, Clock, BarChart3, Target,
  TrendingUp, TrendingDown, Minus, Wifi, X, Zap,
  ArrowUpDown, Settings, Activity, ChevronDown, ChevronUp, Edit2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  type Timeframe, type IGSavedStrategy, type StrategySignal, type Candle,
  type WatchlistMarket,
  getSignal, loadStrategies, saveStrategy, deleteStrategy,
  TIMEFRAME_CONFIG, DEFAULT_WATCHLIST,
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

type MarketScan = {
  epic: string;
  name: string;
  signal: StrategySignal | null;
  scanning: boolean;
  error?: string;
  lastScanned?: string;
  allowanceLeft?: number;
};

type RunLog = { id: string; ts: string; type: 'info'|'buy'|'sell'|'close'|'error'|'signal'; msg: string };
type PositionMap = Record<'demo'|'live', IGPosition[]>;

function uid() { return Math.random().toString(36).slice(2, 9); }
function fmt(n: number) { return `£${Math.abs(n).toFixed(2)}`; }
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── API helpers ───────────────────────────────────────────────────────────────

function makeHeaders(s: IGSession, env: 'demo'|'live', extra?: Record<string,string>) {
  return { 'x-ig-cst': s.cst, 'x-ig-security-token': s.securityToken, 'x-ig-api-key': s.apiKey, 'x-ig-env': env, ...extra };
}

async function connectIG(env: 'demo'|'live'): Promise<IGSession|null> {
  const key = env === 'demo' ? 'ig_demo_credentials' : 'ig_live_credentials';
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const c = JSON.parse(raw) as { username:string; password:string; apiKey:string; connected?:boolean };
    if (!c.connected) return null;
    const r = await fetch('/api/ig/session', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ username:c.username, password:c.password, apiKey:c.apiKey, env }) });
    const d = await r.json() as { ok:boolean; cst?:string; securityToken?:string; accountId?:string };
    if (d.ok && d.cst && d.securityToken)
      return { cst:d.cst, securityToken:d.securityToken, accountId:d.accountId??'', apiKey:c.apiKey };
  } catch {}
  return null;
}

// ── Small UI pieces ───────────────────────────────────────────────────────────

function DirectionBadge({ dir, size='sm' }: { dir: string; size?: 'sm'|'xs' }) {
  const base = size === 'xs' ? 'text-[9px] px-1 py-0' : 'text-[10px] px-1.5 py-0.5';
  return (
    <span className={clsx('font-bold rounded', base,
      dir === 'BUY'  ? 'bg-emerald-500/20 text-emerald-400' :
      dir === 'SELL' ? 'bg-red-500/20 text-red-400' :
      'bg-gray-700 text-gray-400'
    )}>{dir}</span>
  );
}

function StrengthBar({ strength, dir }: { strength: number; dir: string }) {
  return (
    <div className="h-1 bg-gray-800 rounded-full overflow-hidden w-16 flex-shrink-0">
      <div className={clsx('h-full rounded-full transition-all',
        dir === 'BUY' ? 'bg-emerald-500' : dir === 'SELL' ? 'bg-red-500' : 'bg-gray-600'
      )} style={{ width: `${strength}%` }} />
    </div>
  );
}

function MarketSearch({ session, env, onSelect }: {
  session: IGSession; env: 'demo'|'live'; onSelect: (m:{epic:string;instrumentName:string}) => void;
}) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{epic:string;instrumentName:string;bid:number;offer:number}[]>([]);
  const [busy, setBusy] = useState(false);
  async function go() {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/ig/markets?q=${encodeURIComponent(q)}`, { headers: makeHeaders(session, env) });
      const d = await r.json() as { ok:boolean; markets?: typeof res };
      if (d.ok) setRes(d.markets ?? []);
    } catch {}
    setBusy(false);
  }
  return (
    <div>
      <div className="flex gap-2">
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key==='Enter' && void go()}
          placeholder="Search market…"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
        <Button size="sm" onClick={go} loading={busy} icon={<Search className="h-3.5 w-3.5" />}>Find</Button>
      </div>
      {res.length > 0 && (
        <div className="mt-1.5 border border-gray-700 rounded-lg divide-y divide-gray-800 max-h-40 overflow-y-auto">
          {res.slice(0,8).map(m => (
            <button key={m.epic} onClick={() => { onSelect(m); setRes([]); setQ(''); }}
              className="w-full flex items-center justify-between px-3 py-2 text-left text-xs hover:bg-gray-800/80">
              <div>
                <p className="font-semibold text-white">{m.instrumentName}</p>
                <p className="text-gray-500 font-mono text-[10px]">{m.epic}</p>
              </div>
              <p className="text-gray-400 font-mono">{m.bid}/{m.offer}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function IGStrategyTrader() {

  // ── Sessions ───────────────────────────────────────────────────────────────
  const [sessions, setSessions]     = useState<Partial<Record<'demo'|'live', IGSession>>>({});
  const [connecting, setConnecting] = useState<Partial<Record<'demo'|'live', boolean>>>({});

  // ── Positions ──────────────────────────────────────────────────────────────
  const [positions, setPositions] = useState<PositionMap>({ demo:[], live:[] });
  const [loadingPos, setLoadingPos] = useState(false);
  const [closingId, setClosingId]   = useState<string|null>(null);

  // ── Strategies ─────────────────────────────────────────────────────────────
  const [strategies, setStrategies]     = useState<IGSavedStrategy[]>([]);
  const [activeStratId, setActiveStratId] = useState<string|null>(null);
  const [isRunning, setIsRunning]       = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const runningRef = useRef(false);

  // ── Market scanner state ───────────────────────────────────────────────────
  const [scans, setScans] = useState<Record<string, MarketScan>>({});
  const [scanProgress, setScanProgress] = useState<string>('');
  const [allowance, setAllowance] = useState<number|null>(null);

  // ── Builder ────────────────────────────────────────────────────────────────
  const [showBuilder, setShowBuilder]   = useState(false);
  const [editId, setEditId]             = useState<string|null>(null);
  const [bName, setBName]               = useState('');
  const [bTimeframe, setBTimeframe]     = useState<Timeframe>('daily');
  const [bSize, setBSize]               = useState(1);
  const [bMaxPos, setBMaxPos]           = useState(3);
  const [bMinStrength, setBMinStrength] = useState(60);
  const [bAccounts, setBAccounts]       = useState<('demo'|'live')[]>(['demo']);
  const [bAutoClose, setBAutoClose]     = useState(true);
  const [bWatchlist, setBWatchlist]     = useState<WatchlistMarket[]>([...DEFAULT_WATCHLIST]);

  // ── Manual trade ───────────────────────────────────────────────────────────
  const [showManual, setShowManual]     = useState(false);
  const [manualEpic, setManualEpic]     = useState('');
  const [manualName, setManualName]     = useState('');
  const [manualDir, setManualDir]       = useState<'BUY'|'SELL'>('BUY');
  const [manualSize, setManualSize]     = useState(1);
  const [manualStop, setManualStop]     = useState<number|''>('');
  const [manualLimit, setManualLimit]   = useState<number|''>('');
  const [manualEnv, setManualEnv]       = useState<'demo'|'live'>('demo');
  const [placingManual, setPlacingManual] = useState(false);

  // ── Log ────────────────────────────────────────────────────────────────────
  const [runLog, setRunLog] = useState<RunLog[]>([]);

  // ── Toast ──────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<{ok:boolean;msg:string}|null>(null);
  function showToast(ok:boolean, msg:string) { setToast({ok,msg}); setTimeout(() => setToast(null), 4000); }
  function log(type: RunLog['type'], msg: string) {
    setRunLog(p => [{ id:uid(), ts:new Date().toISOString(), type, msg }, ...p].slice(0,200));
  }

  // ── Connect on mount ───────────────────────────────────────────────────────
  useEffect(() => {
    setStrategies(loadStrategies());
    (['demo','live'] as const).forEach(env => {
      setConnecting(c => ({...c,[env]:true}));
      connectIG(env).then(sess => {
        if (sess) setSessions(s => ({...s,[env]:sess}));
        setConnecting(c => ({...c,[env]:false}));
      });
    });
  }, []);

  // ── Load positions ─────────────────────────────────────────────────────────
  const loadPositions = useCallback(async (envFilter?: 'demo'|'live') => {
    const envs: ('demo'|'live')[] = envFilter ? [envFilter] : ['demo','live'];
    setLoadingPos(true);
    for (const env of envs) {
      const sess = sessions[env];
      if (!sess) continue;
      try {
        const r = await fetch('/api/ig/positions', { headers: makeHeaders(sess, env) });
        const d = await r.json() as { ok:boolean; positions?: IGPosition[] };
        if (d.ok) setPositions(p => ({...p, [env]: d.positions ?? []}));
      } catch {}
    }
    setLoadingPos(false);
  }, [sessions]);

  useEffect(() => {
    if (Object.values(sessions).some(Boolean)) void loadPositions();
  }, [sessions, loadPositions]);

  // ── Place / close ──────────────────────────────────────────────────────────
  async function placeOrder(env: 'demo'|'live', epic:string, direction:'BUY'|'SELL', size:number, stopDist?:number, limitDist?:number) {
    const sess = sessions[env];
    if (!sess) return { ok:false, error:`No ${env} session` };
    const r = await fetch('/api/ig/order', {
      method:'POST',
      headers: { ...makeHeaders(sess, env), 'Content-Type':'application/json' },
      body: JSON.stringify({ epic, direction, size, stopDistance: stopDist, profitDistance: limitDist, currencyCode:'GBP' }),
    });
    return r.json() as Promise<{ok:boolean;dealReference?:string;error?:string}>;
  }

  async function closePos(env: 'demo'|'live', pos: IGPosition) {
    const sess = sessions[env];
    if (!sess) return { ok:false, error:`No ${env} session` };
    const r = await fetch('/api/ig/order', {
      method:'DELETE',
      headers: { ...makeHeaders(sess, env), 'Content-Type':'application/json' },
      body: JSON.stringify({ dealId:pos.dealId, direction: pos.direction==='BUY'?'SELL':'BUY', size:pos.size }),
    });
    return r.json() as Promise<{ok:boolean;error?:string}>;
  }

  // ── Fetch candles for one market ───────────────────────────────────────────
  async function fetchCandles(env: 'demo'|'live', epic:string, timeframe: Timeframe): Promise<{candles:Candle[];allowanceLeft?:number}|null> {
    const sess = sessions[env] ?? Object.values(sessions).find(Boolean);
    if (!sess) return null;
    const cfg = TIMEFRAME_CONFIG[timeframe];
    try {
      const r = await fetch(
        `/api/ig/prices?epic=${encodeURIComponent(epic)}&resolution=${cfg.resolution}&max=${cfg.max}`,
        { headers: makeHeaders(sess, env) }
      );
      const d = await r.json() as { ok:boolean; candles?:Candle[]; allowance?:{remainingAllowance:number}; error?:string };
      if (!d.ok) return null;
      if (d.allowance) setAllowance(d.allowance.remainingAllowance);
      return { candles: d.candles ?? [], allowanceLeft: d.allowance?.remainingAllowance };
    } catch { return null; }
  }

  // ── Scan one market + execute ──────────────────────────────────────────────
  async function scanMarket(strat: IGSavedStrategy, market: WatchlistMarket): Promise<StrategySignal|null> {
    setScans(p => ({ ...p, [market.epic]: { epic:market.epic, name:market.name, signal:null, scanning:true } }));
    const envs = strat.accounts.filter(e => sessions[e]);
    const primaryEnv = envs[0] ?? 'demo';

    const result = await fetchCandles(primaryEnv, market.epic, strat.timeframe);
    if (!result || result.candles.length < 10) {
      setScans(p => ({ ...p, [market.epic]: { epic:market.epic, name:market.name, signal:null, scanning:false, error:'No data' } }));
      return null;
    }

    const sig = getSignal(strat.timeframe, result.candles);
    setScans(p => ({
      ...p,
      [market.epic]: { epic:market.epic, name:market.name, signal:sig, scanning:false, lastScanned:new Date().toISOString(), allowanceLeft:result.allowanceLeft },
    }));

    // Execute on each account if autoTrade and signal is strong enough
    if (strat.autoTrade && sig.direction !== 'HOLD' && sig.strength >= strat.minStrength) {
      for (const env of envs) {
        const envPos = positions[env];
        const existing = envPos.filter(p => p.epic === market.epic);
        const opposite = sig.direction === 'BUY' ? 'SELL' : 'BUY';

        // Auto-close opposing positions
        if (strat.autoClose) {
          for (const opp of existing.filter(p => p.direction === opposite)) {
            log('close', `[${env.toUpperCase()}] Auto-closing ${opp.direction} ${market.name} — signal reversed`);
            const cr = await closePos(env, opp);
            if (cr.ok) log('close', `[${env.toUpperCase()}] ✅ Closed ${market.name}`);
            else log('error', `[${env.toUpperCase()}] Close failed: ${cr.error ?? 'unknown'}`);
          }
          await loadPositions(env);
        }

        // Don't exceed max positions
        const openCount = positions[env].filter(p => p.epic !== market.epic).length;
        if (openCount >= strat.maxPositions) {
          log('info', `[${env.toUpperCase()}] Max ${strat.maxPositions} positions reached — skip ${market.name}`);
          continue;
        }

        // Don't open if already same direction
        const alreadyOpen = positions[env].some(p => p.epic === market.epic && p.direction === sig.direction);
        if (alreadyOpen) continue;

        // Open position with stop + take profit
        log(sig.direction === 'BUY' ? 'buy' : 'sell',
          `[${env.toUpperCase()}] ${sig.direction} £${strat.size}/pt ${market.name} — SL ${sig.stopPoints}pt / TP ${sig.targetPoints}pt (${sig.strength}%)`);
        const or = await placeOrder(env, market.epic, sig.direction, strat.size, sig.stopPoints, sig.targetPoints);
        if (or.ok) {
          log('buy', `[${env.toUpperCase()}] ✅ Filled — ref ${or.dealReference ?? 'n/a'}`);
          showToast(true, `[${env}] ${sig.direction} ${market.name}`);
          await loadPositions(env);
        } else {
          log('error', `[${env.toUpperCase()}] ❌ ${market.name}: ${or.error ?? 'unknown'}`);
        }
      }
    } else if (sig.direction !== 'HOLD') {
      log('signal', `${market.name} → ${sig.direction} ${sig.strength}% (below ${strat.minStrength}% threshold — no trade)`);
    }

    return sig;
  }

  // ── Full scan cycle ────────────────────────────────────────────────────────
  const runCycle = useCallback(async (strat: IGSavedStrategy) => {
    if (!runningRef.current) return;
    const markets = (strat.watchlist?.length ? strat.watchlist : DEFAULT_WATCHLIST).filter(m => m.enabled);
    log('info', `Scanning ${markets.length} markets…`);

    for (let i = 0; i < markets.length; i++) {
      if (!runningRef.current) break;
      const m = markets[i];
      setScanProgress(`${m.name} (${i+1}/${markets.length})`);
      await scanMarket(strat, m);
      // Wait between requests to respect IG rate limits
      if (i < markets.length - 1) await sleep(800);
    }

    setScanProgress('');
    const updated: IGSavedStrategy = { ...strat, lastRunAt: new Date().toISOString() };
    saveStrategy(updated);
    setStrategies(loadStrategies());
    log('info', `Cycle complete — next in ${TIMEFRAME_CONFIG[strat.timeframe].pollMs / 60_000}min`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, positions]);

  // ── Start / stop auto-run ──────────────────────────────────────────────────
  function startAutoRun(strat: IGSavedStrategy) {
    if (timerRef.current) clearInterval(timerRef.current);
    runningRef.current = true;
    setIsRunning(true);
    const cfg = TIMEFRAME_CONFIG[strat.timeframe];
    const label = cfg.pollMs >= 3_600_000 ? `${cfg.pollMs/3_600_000}hr` : cfg.pollMs >= 60_000 ? `${cfg.pollMs/60_000}min` : `${cfg.pollMs/1000}s`;
    log('info', `▶ Auto-trader started — "${strat.name}" · ${strat.timeframe} · scanning every ${label}`);
    void runCycle(strat);
    timerRef.current = setInterval(() => void runCycle(strat), cfg.pollMs);
  }

  function stopAutoRun() {
    runningRef.current = false;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setIsRunning(false);
    setScanProgress('');
    log('info', '⏹ Auto-trader stopped');
  }

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  // ── Manual close ───────────────────────────────────────────────────────────
  async function handleClose(env:'demo'|'live', pos: IGPosition) {
    setClosingId(pos.dealId);
    const r = await closePos(env, pos);
    if (r.ok) {
      log('close', `[${env.toUpperCase()}] Closed ${pos.direction} ${pos.instrumentName ?? pos.epic}`);
      showToast(true, 'Position closed');
      await loadPositions(env);
    } else showToast(false, r.error ?? 'Close failed');
    setClosingId(null);
  }

  // ── Manual open ────────────────────────────────────────────────────────────
  async function handleManualOpen() {
    if (!manualEpic) { showToast(false, 'Select a market first'); return; }
    if (!sessions[manualEnv]) { showToast(false, `Not connected to ${manualEnv}`); return; }
    setPlacingManual(true);
    const r = await placeOrder(manualEnv, manualEpic, manualDir, manualSize,
      manualStop !== '' ? Number(manualStop) : undefined,
      manualLimit !== '' ? Number(manualLimit) : undefined);
    if (r.ok) {
      log(manualDir === 'BUY' ? 'buy' : 'sell', `[${manualEnv.toUpperCase()}] Manual ${manualDir} £${manualSize}/pt ${manualName || manualEpic}`);
      showToast(true, `${manualDir} placed on ${manualName || manualEpic}`);
      await loadPositions(manualEnv);
    } else {
      log('error', `[${manualEnv.toUpperCase()}] Manual order failed: ${r.error ?? 'unknown'}`);
      showToast(false, r.error ?? 'Order failed');
    }
    setPlacingManual(false);
  }

  // ── Builder helpers ────────────────────────────────────────────────────────
  function openBuilder(existing?: IGSavedStrategy) {
    if (existing) {
      setEditId(existing.id); setBName(existing.name); setBTimeframe(existing.timeframe);
      setBSize(existing.size); setBMaxPos(existing.maxPositions);
      setBMinStrength(existing.minStrength ?? 60);
      setBAccounts(existing.accounts); setBAutoClose(existing.autoClose ?? true);
      setBWatchlist(existing.watchlist?.length ? existing.watchlist : [...DEFAULT_WATCHLIST]);
    } else {
      setEditId(null); setBName(''); setBTimeframe('daily'); setBSize(1); setBMaxPos(3);
      setBMinStrength(60); setBAccounts(['demo']); setBAutoClose(true);
      setBWatchlist([...DEFAULT_WATCHLIST]);
    }
    setShowBuilder(true);
    setShowManual(false);
  }

  function handleSave() {
    if (!bName.trim()) { showToast(false, 'Strategy name is required'); return; }
    if (bAccounts.length === 0) { showToast(false, 'Select at least one account'); return; }
    const s: IGSavedStrategy = {
      id: editId ?? uid(),
      name: bName.trim(),
      epic: '', instrumentName: '', // legacy fields, unused in auto mode
      watchlist: bWatchlist,
      minStrength: bMinStrength,
      timeframe: bTimeframe,
      size: bSize,
      maxPositions: bMaxPos,
      accounts: bAccounts,
      autoTrade: true,
      autoClose: bAutoClose,
      createdAt: new Date().toISOString(),
    };
    saveStrategy(s);
    setStrategies(loadStrategies());
    setShowBuilder(false);
    showToast(true, `Strategy "${s.name}" ${editId ? 'updated' : 'saved'}`);
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const anyConnected  = Object.values(sessions).some(Boolean);
  const isConnecting  = Object.values(connecting).some(Boolean);
  const activeStrat   = strategies.find(s => s.id === activeStratId) ?? null;
  const allPositions  = [...positions.demo, ...positions.live];
  const totalPnL      = allPositions.reduce((acc, p) => acc + (p.upl ?? 0), 0);
  const scanEntries   = Object.values(scans);
  const builderSession = sessions['demo'] ?? sessions['live'];

  // ── Not connected ──────────────────────────────────────────────────────────
  if (!anyConnected && !isConnecting) {
    return (
      <div className="max-w-xl space-y-4">
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-orange-500/20 flex items-center justify-center text-2xl">🤖</div>
            <div>
              <h3 className="text-sm font-semibold text-white">IG Auto-Trader</h3>
              <p className="text-xs text-gray-500">Fully automated spread-bet strategy engine</p>
            </div>
          </div>
          <p className="text-xs text-gray-400 mb-4">
            Connect your IG account in{' '}
            <a href="/settings/accounts" className="text-orange-400 hover:underline">Settings → Accounts</a>{' '}
            to start automated trading across FTSE, S&P 500, Gold, FX and more.
          </p>
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5 text-xs text-amber-400">
            ⚠️ Spread bets are complex instruments. 68% of retail accounts lose money. Only trade with money you can afford to lose.
          </div>
        </Card>
      </div>
    );
  }

  if (isConnecting && !anyConnected) {
    return <div className="flex items-center gap-3 text-gray-400 py-8"><RefreshCw className="h-5 w-5 animate-spin" /> Connecting to IG accounts…</div>;
  }

  // ── Connected view ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 max-w-3xl">

      {/* Toast */}
      {toast && (
        <div className={clsx('flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium',
          toast.ok ? 'bg-emerald-500/15 border border-emerald-500/25 text-emerald-400' : 'bg-red-500/15 border border-red-500/25 text-red-400'
        )}>
          {toast.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
          {toast.msg}
        </div>
      )}

      {/* ── Connection status bar ───────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          {(['demo','live'] as const).map(env => (
            <div key={env} className={clsx('flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full',
              sessions[env] ? (env==='demo' ? 'bg-blue-500/20 text-blue-400' : 'bg-emerald-500/20 text-emerald-400') : 'bg-gray-800 text-gray-500'
            )}>
              <Wifi className="h-3 w-3" />
              IG {env==='demo' ? 'Demo' : 'Live'}
              {sessions[env]?.accountId && <span className="opacity-60">#{sessions[env]!.accountId}</span>}
              {connecting[env] && <RefreshCw className="h-2.5 w-2.5 animate-spin" />}
            </div>
          ))}
          {allowance !== null && (
            <span className="text-[10px] text-gray-600 px-2 py-1 bg-gray-800/50 rounded-full">
              API allowance: {allowance.toLocaleString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void loadPositions()} loading={loadingPos}>Refresh</Button>
          <Button size="sm" variant="outline" icon={<ArrowUpDown className="h-3.5 w-3.5" />} onClick={() => { setShowManual(v => !v); setShowBuilder(false); }}>Manual</Button>
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => { openBuilder(); }}>New Strategy</Button>
        </div>
      </div>

      {/* Risk warning */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-xs text-amber-400">
        ⚠️ Spread bets are complex. 68% of retail accounts lose money. Use Demo first. Not financial advice.
      </div>

      {/* ── Manual trade panel ─────────────────────────────────────────── */}
      {showManual && (
        <Card>
          <CardHeader title="Manual Trade" subtitle="Open a position directly on any market"
            icon={<ArrowUpDown className="h-4 w-4" />}
            action={<button onClick={() => setShowManual(false)}><X className="h-4 w-4 text-gray-500 hover:text-white" /></button>}
          />
          <div className="space-y-3">
            <div className="flex gap-2">
              {(['demo','live'] as const).map(env => (
                <button key={env} disabled={!sessions[env]} onClick={() => setManualEnv(env)}
                  className={clsx('flex-1 py-2 rounded-lg text-sm font-medium border transition-all',
                    !sessions[env] ? 'opacity-30 cursor-not-allowed bg-gray-800 text-gray-600 border-gray-700' :
                    manualEnv === env
                      ? env==='demo' ? 'bg-blue-500/20 text-blue-300 border-blue-500/40' : 'bg-red-500/20 text-red-300 border-red-500/40'
                      : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-gray-200'
                  )}>{env==='demo' ? 'Demo' : '⚠️ Live'}</button>
              ))}
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Market</label>
              {builderSession
                ? <MarketSearch session={builderSession} env={manualEnv} onSelect={m => { setManualEpic(m.epic); setManualName(m.instrumentName); }} />
                : <p className="text-xs text-gray-500">No session</p>}
              {manualEpic && (
                <div className="mt-1.5 flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-1.5 text-xs text-orange-300">
                  <CheckCircle2 className="h-3 w-3" /><span className="font-semibold">{manualName}</span>
                  <span className="font-mono opacity-60 text-[10px]">{manualEpic}</span>
                  <button onClick={() => { setManualEpic(''); setManualName(''); }} className="ml-auto text-gray-500 hover:text-white"><X className="h-3 w-3" /></button>
                </div>
              )}
            </div>
            <div className="grid grid-cols-4 gap-2">
              <div className="col-span-2">
                <label className="text-xs text-gray-400 mb-1.5 block">Direction</label>
                <div className="flex gap-1">
                  {(['BUY','SELL'] as const).map(d => (
                    <button key={d} onClick={() => setManualDir(d)} className={clsx('flex-1 py-2 rounded-lg text-sm font-bold border transition-all',
                      manualDir === d ? d==='BUY' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' : 'bg-red-500/20 text-red-300 border-red-500/40'
                      : 'bg-gray-800 text-gray-500 border-gray-700')}>{d}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">£/pt</label>
                <input type="number" min={0.5} step={0.5} value={manualSize} onChange={e => setManualSize(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Stop (pt)</label>
                <input type="number" value={manualStop} onChange={e => setManualStop(e.target.value===''?'':Number(e.target.value))}
                  placeholder="opt"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Take Profit (pts, optional)</label>
              <input type="number" value={manualLimit} onChange={e => setManualLimit(e.target.value===''?'':Number(e.target.value))} placeholder="Leave blank for no limit"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
            </div>
            {manualEnv === 'live' && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
                ⚠️ This opens a REAL position on your live IG account.
              </div>
            )}
            <Button fullWidth loading={placingManual} disabled={!manualEpic}
              className={manualDir==='BUY' ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-red-600 hover:bg-red-500 text-white'}
              icon={manualDir==='BUY' ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              onClick={handleManualOpen}>
              {manualDir} £{manualSize}/pt {manualName || (manualEpic ? `(${manualEpic})` : '— pick market')} ({manualEnv})
            </Button>
          </div>
        </Card>
      )}

      {/* ── Strategy builder ───────────────────────────────────────────── */}
      {showBuilder && (
        <Card>
          <CardHeader title={editId ? 'Edit Strategy' : 'New Auto-Strategy'}
            subtitle="The strategy scans all enabled markets and trades the best signals automatically"
            icon={<Zap className="h-4 w-4" />}
            action={<button onClick={() => setShowBuilder(false)}><X className="h-4 w-4 text-gray-500 hover:text-white" /></button>}
          />
          <div className="space-y-4">

            {/* Name + timeframe */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Strategy Name *</label>
                <input value={bName} onChange={e => setBName(e.target.value)} placeholder="e.g. Daily Swing Bot"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Timeframe</label>
                <select value={bTimeframe} onChange={e => setBTimeframe(e.target.value as Timeframe)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500">
                  <option value="hourly">Hourly Scalp — EMA9/21 + RSI · scans every 5min</option>
                  <option value="daily">Daily Swing — EMA20/50 + MACD · scans every 1hr</option>
                  <option value="longterm">Long-term — Golden/Death Cross · scans every 24hr</option>
                </select>
              </div>
            </div>

            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-xs text-blue-300">
              {TIMEFRAME_CONFIG[bTimeframe].description} — Stop loss and take profit are set automatically from the signal.
            </div>

            {/* Risk per trade + max positions */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Size £/point</label>
                <input type="number" min={0.5} step={0.5} value={bSize} onChange={e => setBSize(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Max positions</label>
                <input type="number" min={1} max={20} value={bMaxPos} onChange={e => setBMaxPos(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Min signal strength</label>
                <div className="flex items-center gap-2">
                  <input type="range" min={40} max={95} step={5} value={bMinStrength} onChange={e => setBMinStrength(Number(e.target.value))}
                    className="flex-1 accent-orange-500" />
                  <span className="text-sm font-mono text-orange-400 w-8">{bMinStrength}%</span>
                </div>
              </div>
            </div>

            {/* Accounts */}
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Trade on accounts</label>
              <div className="flex gap-2">
                {(['demo','live'] as const).map(acc => (
                  <button key={acc} disabled={!sessions[acc]}
                    onClick={() => setBAccounts(p => p.includes(acc) ? p.filter(a=>a!==acc) : [...p,acc])}
                    className={clsx('flex-1 py-2 rounded-lg text-sm font-medium border transition-all',
                      !sessions[acc] ? 'opacity-30 cursor-not-allowed bg-gray-800 text-gray-600 border-gray-700' :
                      bAccounts.includes(acc)
                        ? acc==='demo' ? 'bg-blue-500/20 text-blue-300 border-blue-500/40' : 'bg-red-500/20 text-red-300 border-red-500/40'
                        : 'bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-300'
                    )}>
                    {acc==='demo' ? 'Demo' : '⚠️ Live (real money)'}
                    {!sessions[acc] && <span className="block text-[10px] opacity-50">not connected</span>}
                  </button>
                ))}
              </div>
            </div>

            {/* Auto-close toggle */}
            <div className="flex items-center justify-between bg-gray-800/40 rounded-lg px-3 py-2.5">
              <div>
                <p className="text-xs font-medium text-white">Auto-close on reversal</p>
                <p className="text-[11px] text-gray-500">Close opposing positions automatically when signal flips</p>
              </div>
              <button onClick={() => setBAutoClose(v => !v)}
                className={clsx('w-11 h-6 rounded-full transition-all relative flex-shrink-0', bAutoClose ? 'bg-orange-500' : 'bg-gray-700')}>
                <span className={clsx('absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all', bAutoClose ? 'left-5' : 'left-0.5')} />
              </button>
            </div>

            {/* Watchlist */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-gray-400">Markets to scan</label>
                <span className="text-[10px] text-gray-600">{bWatchlist.filter(m=>m.enabled).length} enabled</span>
              </div>
              <div className="space-y-1 max-h-56 overflow-y-auto border border-gray-800 rounded-lg divide-y divide-gray-800/50">
                {bWatchlist.map((m, i) => (
                  <div key={m.epic} className="flex items-center justify-between px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <button onClick={() => setBWatchlist(p => p.map((x,xi) => xi===i ? {...x,enabled:!x.enabled} : x))}
                        className={clsx('w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-all',
                          m.enabled ? 'bg-orange-500' : 'bg-gray-700 border border-gray-600')}>
                        {m.enabled && <span className="text-white text-[8px] font-bold">✓</span>}
                      </button>
                      <div className="min-w-0">
                        <p className="text-xs text-white font-medium">{m.name}</p>
                        <p className="text-[10px] text-gray-500 font-mono truncate">{m.epic}</p>
                      </div>
                    </div>
                    <button onClick={() => setBWatchlist(p => p.filter((_,xi) => xi!==i))}
                      className="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0 ml-2">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
              {/* Add custom market */}
              {builderSession && (
                <div className="mt-2">
                  <p className="text-[10px] text-gray-500 mb-1.5">Add a market to the watchlist:</p>
                  <MarketSearch session={builderSession} env={bAccounts.includes('live') ? 'live' : 'demo'}
                    onSelect={m => {
                      if (!bWatchlist.some(x => x.epic === m.epic))
                        setBWatchlist(p => [...p, { epic: m.epic, name: m.instrumentName, enabled: true }]);
                    }}
                  />
                </div>
              )}
            </div>

            {bAccounts.includes('live') && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
                ⚠️ Auto-trading on LIVE will open real positions with real money. Always test on Demo first.
              </div>
            )}

            <Button fullWidth icon={<Save className="h-4 w-4" />} onClick={handleSave}>
              {editId ? 'Update Strategy' : 'Save Strategy'}
            </Button>
          </div>
        </Card>
      )}

      {/* ── Strategies + run controls ───────────────────────────────────── */}
      {strategies.length === 0 && !showBuilder ? (
        <div className="text-center py-10 text-gray-500 border border-dashed border-gray-800 rounded-xl">
          <Target className="h-12 w-12 mx-auto mb-3 opacity-20" />
          <p className="text-sm font-medium">No strategies yet</p>
          <p className="text-xs mt-1 mb-4">Create a strategy and the bot will scan markets and trade automatically</p>
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => openBuilder()}>Create First Strategy</Button>
        </div>
      ) : (
        <div className="space-y-2">
          {strategies.map(strat => {
            const isActive = strat.id === activeStratId;
            const enabledMarkets = (strat.watchlist?.length ? strat.watchlist : DEFAULT_WATCHLIST).filter(m => m.enabled);
            const cfg = TIMEFRAME_CONFIG[strat.timeframe];
            return (
              <Card key={strat.id} className={clsx(isActive && 'border-orange-500/40 bg-orange-500/[0.03]')}>
                <div className="flex items-start justify-between gap-3">
                  {/* Strategy info */}
                  <button className="flex-1 text-left min-w-0" onClick={() => setActiveStratId(isActive ? null : strat.id)}>
                    <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                      <p className="text-sm font-bold text-white">{strat.name}</p>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-300">{cfg.label}</span>
                      {strat.accounts.map(a => (
                        <span key={a} className={clsx('text-[10px] px-1.5 py-0.5 rounded-full',
                          a==='demo' ? 'bg-blue-500/20 text-blue-400' : 'bg-red-500/20 text-red-400')}>{a}</span>
                      ))}
                      {strat.autoClose && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-400">AutoClose</span>}
                    </div>
                    <p className="text-[11px] text-gray-500">
                      {enabledMarkets.length} markets · £{strat.size}/pt · max {strat.maxPositions} pos · min {strat.minStrength ?? 60}% signal
                      {strat.lastRunAt && ` · last ${fmtTime(strat.lastRunAt)}`}
                    </p>
                  </button>

                  {/* Controls */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {isActive && isRunning ? (
                      <Button size="sm" className="bg-red-600 hover:bg-red-500 text-white" icon={<Square className="h-3.5 w-3.5" />} onClick={stopAutoRun}>
                        Stop
                      </Button>
                    ) : (
                      <Button size="sm" className="bg-orange-600 hover:bg-orange-500 text-white" icon={<Play className="h-3.5 w-3.5" />}
                        onClick={() => { setActiveStratId(strat.id); startAutoRun(strat); }}>
                        {isActive ? 'Start' : 'Run'}
                      </Button>
                    )}
                    <button onClick={() => openBuilder(strat)} className="p-1.5 text-gray-600 hover:text-orange-400 transition-colors"><Edit2 className="h-3.5 w-3.5" /></button>
                    <button onClick={() => { deleteStrategy(strat.id); setStrategies(loadStrategies()); if (activeStratId===strat.id) stopAutoRun(); }}
                      className="p-1.5 text-gray-600 hover:text-red-400 transition-colors"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </div>

                {/* Running status */}
                {isActive && isRunning && (
                  <div className="mt-2 flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2">
                    <Activity className="h-3.5 w-3.5 text-orange-400 animate-pulse flex-shrink-0" />
                    <span className="text-xs text-orange-300 font-medium">
                      {scanProgress ? `Scanning: ${scanProgress}` : `Running — next scan in ${cfg.label ?? cfg.pollMs/60_000+'min'}`}
                    </span>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Market Scanner Grid ─────────────────────────────────────────── */}
      {scanEntries.length > 0 && (
        <Card>
          <CardHeader title="Market Scanner" subtitle={`${scanEntries.length} markets · last run ${fmtTime(scanEntries[0]?.lastScanned ?? new Date().toISOString())}`}
            icon={<Settings className="h-4 w-4" />}
          />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {scanEntries.map(scan => (
              <div key={scan.epic} className={clsx('rounded-lg border p-2.5 transition-all',
                scan.scanning ? 'border-orange-500/30 bg-orange-500/5' :
                scan.signal?.direction === 'BUY'  ? 'border-emerald-500/30 bg-emerald-500/5' :
                scan.signal?.direction === 'SELL' ? 'border-red-500/30 bg-red-500/5' :
                'border-gray-800 bg-gray-800/20'
              )}>
                <div className="flex items-start justify-between gap-1 mb-1">
                  <p className="text-xs font-semibold text-white leading-tight">{scan.name}</p>
                  {scan.scanning
                    ? <RefreshCw className="h-3 w-3 text-orange-400 animate-spin flex-shrink-0 mt-0.5" />
                    : scan.error
                      ? <AlertCircle className="h-3 w-3 text-red-500 flex-shrink-0 mt-0.5" />
                      : scan.signal && <DirectionBadge dir={scan.signal.direction} size="xs" />
                  }
                </div>
                {scan.signal && !scan.scanning && (
                  <div className="space-y-1">
                    <StrengthBar strength={scan.signal.strength} dir={scan.signal.direction} />
                    <p className="text-[10px] text-gray-500">{scan.signal.strength}% · SL {scan.signal.stopPoints}pt</p>
                  </div>
                )}
                {scan.error && <p className="text-[10px] text-red-500 mt-0.5">{scan.error}</p>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Open Positions ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Open Positions"
          subtitle={`${allPositions.length} open · P&L: ${totalPnL>=0?'+':''}£${totalPnL.toFixed(2)}`}
          icon={<BarChart3 className="h-4 w-4" />}
        />
        {allPositions.length === 0 ? (
          <p className="text-sm text-gray-500 py-3 text-center">No open positions</p>
        ) : (
          <div className="space-y-3">
            {(['demo','live'] as const).map(env => positions[env].length > 0 && (
              <div key={env}>
                <p className={clsx('text-[10px] font-bold uppercase tracking-wider mb-1.5',
                  env==='demo' ? 'text-blue-400' : 'text-red-400')}>{env}</p>
                <div className="space-y-1.5">
                  {positions[env].map(pos => <PositionCard key={pos.dealId} pos={pos} env={env} closingId={closingId} onClose={handleClose} />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── Activity Log ────────────────────────────────────────────────── */}
      {runLog.length > 0 && (
        <Card>
          <CardHeader title="Activity Log" subtitle={`${runLog.length} entries`} icon={<Clock className="h-4 w-4" />}
            action={<button onClick={() => setRunLog([])} className="text-xs text-gray-500 hover:text-white">Clear</button>}
          />
          <div className="space-y-0.5 max-h-64 overflow-y-auto font-mono">
            {runLog.map(e => (
              <div key={e.id} className="flex gap-2 text-[11px] py-0.5">
                <span className="text-gray-600 flex-shrink-0 tabular-nums">{fmtTime(e.ts)}</span>
                <span className={clsx('flex-1 break-all leading-relaxed',
                  e.type==='buy'    ? 'text-emerald-400' :
                  e.type==='sell'   ? 'text-red-400' :
                  e.type==='close'  ? 'text-blue-400' :
                  e.type==='error'  ? 'text-red-500' :
                  e.type==='signal' ? 'text-amber-400' : 'text-gray-400'
                )}>{e.msg}</span>
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

// ── Position card ─────────────────────────────────────────────────────────────

function PositionCard({ pos, env, closingId, onClose }: {
  pos: IGPosition; env: 'demo'|'live'; closingId: string|null;
  onClose: (env:'demo'|'live', pos:IGPosition) => void;
}) {
  const [exp, setExp] = useState(false);
  return (
    <div className="bg-gray-800/40 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2.5 gap-3">
        <button className="flex-1 min-w-0 text-left flex items-center gap-2" onClick={() => setExp(v=>!v)}>
          <DirectionBadge dir={pos.direction} />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-white truncate">{pos.instrumentName ?? pos.epic}</p>
            <p className="text-[10px] text-gray-500">£{pos.size}/pt · entry {pos.level}</p>
          </div>
          {exp ? <ChevronUp className="h-3 w-3 text-gray-600 flex-shrink-0" /> : <ChevronDown className="h-3 w-3 text-gray-600 flex-shrink-0" />}
        </button>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={clsx('text-sm font-bold font-mono', (pos.upl??0)>=0 ? 'text-emerald-400' : 'text-red-400')}>
            {(pos.upl??0)>=0?'+':'-'}{'£'+Math.abs(pos.upl??0).toFixed(2)}
          </span>
          <Button size="sm" variant="outline" loading={closingId===pos.dealId}
            onClick={() => onClose(env, pos)} className="text-red-400 border-red-500/30 hover:bg-red-500/10">
            Close
          </Button>
        </div>
      </div>
      {exp && (
        <div className="px-3 pb-2.5 pt-2 grid grid-cols-3 gap-2 text-[11px] border-t border-gray-700/30">
          <div><p className="text-gray-600">Bid</p><p className="text-white font-mono">{pos.bid}</p></div>
          <div><p className="text-gray-600">Offer</p><p className="text-white font-mono">{pos.offer}</p></div>
          <div><p className="text-gray-600">Currency</p><p className="text-white">{pos.currency} <span className="text-emerald-400 text-[9px]">TAX FREE</span></p></div>
          <div className="col-span-3"><p className="text-gray-600">Deal ID</p><p className="text-gray-400 font-mono text-[10px] break-all">{pos.dealId}</p></div>
        </div>
      )}
    </div>
  );
}

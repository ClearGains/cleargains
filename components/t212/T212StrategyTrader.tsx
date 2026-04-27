'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play, Square, Pause, Plus, RefreshCw,
  AlertCircle, CheckCircle2, Clock, Target,
  TrendingUp, TrendingDown, Activity, X, Settings,
  DollarSign,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useClearGainsStore } from '@/lib/store';
import { T212ManualTrading } from './T212ManualTrading';

// ── Types ─────────────────────────────────────────────────────────────────────

type RunState = 'RUNNING' | 'PAUSED' | 'STOPPED';

type CapitalSettings = {
  totalBudget: number;      // total budget for this strategy
  maxPerTradePct: number;   // max % per single trade (default 10, max 25)
  reservePct: number;       // always keep X% in cash (default 20)
};

type SignalItem = {
  symbol: string;
  name: string;
  t212Ticker: string;
  sector: string;
  score: number;
  currentPrice: number;
  changePercent: number;
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  confidence: number;
  reasoning: string;
};

type AllocatedPosition = {
  id: string;
  ticker: string;
  t212Ticker: string;
  companyName: string;
  quantity: number;
  entryPrice: number;
  allocationAmount: number;
  confidence: number;
  openedAt: string;
};

type ActivityEntry = {
  id: string;
  ts: string;
  type: 'info' | 'buy' | 'close' | 'error' | 'signal' | 'capital';
  msg: string;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const CAPITAL_SETTINGS_KEY = 't212_strategy_capital_settings';
const AVAILABLE_CAPITAL_KEY = 't212_strategy_available_capital';
const ALLOCATED_POSITIONS_KEY = 't212_strategy_allocated_positions';
const STRATEGY_RUNNING_KEY = 'strategy_running_t212';

const DEFAULT_SETTINGS: CapitalSettings = {
  totalBudget: 500,
  maxPerTradePct: 10,
  reservePct: 20,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9); }
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function getDeployable(settings: CapitalSettings): number {
  return settings.totalBudget * (1 - settings.reservePct / 100);
}

function getAllocationAmount(
  confidence: number,
  available: number,
  maxPerTradePct: number,
): number {
  // Tier-based allocation: high/medium/low confidence
  let tierPct: number;
  if (confidence > 80) tierPct = 10;
  else if (confidence >= 65) tierPct = 5;
  else tierPct = 2;

  // Cap at user's maxPerTradePct setting
  tierPct = Math.min(tierPct, maxPerTradePct);

  let amount = available * (tierPct / 100);

  // Never allocate more than available
  if (amount > available) amount = available * 0.5;

  return amount;
}

function getAllocationLabel(confidence: number): string {
  if (confidence > 80) return 'High confidence (10%)';
  if (confidence >= 65) return 'Medium confidence (5%)';
  return 'Lower confidence (2%)';
}

function loadSettings(): CapitalSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(CAPITAL_SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) as CapitalSettings } : DEFAULT_SETTINGS;
  } catch { return DEFAULT_SETTINGS; }
}

function saveSettings(s: CapitalSettings) {
  try { localStorage.setItem(CAPITAL_SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

function loadAvailableCapital(deployable: number): number {
  try {
    const raw = localStorage.getItem(AVAILABLE_CAPITAL_KEY);
    return raw ? parseFloat(raw) : deployable;
  } catch { return deployable; }
}

function saveAvailableCapital(v: number) {
  try { localStorage.setItem(AVAILABLE_CAPITAL_KEY, String(v)); } catch {}
}

function loadAllocatedPositions(): AllocatedPosition[] {
  try {
    const raw = localStorage.getItem(ALLOCATED_POSITIONS_KEY);
    return raw ? JSON.parse(raw) as AllocatedPosition[] : [];
  } catch { return []; }
}

function saveAllocatedPositions(pos: AllocatedPosition[]) {
  try { localStorage.setItem(ALLOCATED_POSITIONS_KEY, JSON.stringify(pos)); } catch {}
}

// ── Main Component ────────────────────────────────────────────────────────────

export function T212StrategyTrader() {
  const { t212ApiKey, t212ApiSecret, t212Connected, t212AccountType } = useClearGainsStore();

  // ── Capital state ──────────────────────────────────────────────────────────
  const [settings, setSettingsState]               = useState<CapitalSettings>(DEFAULT_SETTINGS);
  const [availableCapital, setAvailableCapitalState] = useState(0);
  const [allocatedPositions, setAllocatedPositions] = useState<AllocatedPosition[]>([]);

  // Helpers that also persist to localStorage
  function updateSettings(s: CapitalSettings) {
    setSettingsState(s);
    saveSettings(s);
    const deployable = getDeployable(s);
    // Recalculate available = deployable - sum of open allocations
    const deployed = allocatedPositions.reduce((sum, p) => sum + p.allocationAmount, 0);
    const avail = Math.max(0, deployable - deployed);
    setAvailableCapitalState(avail);
    saveAvailableCapital(avail);
  }

  function adjustAvailableCapital(delta: number) {
    setAvailableCapitalState(prev => {
      const next = Math.max(0, prev + delta);
      saveAvailableCapital(next);
      return next;
    });
  }

  // ── Run state ──────────────────────────────────────────────────────────────
  const [runState, setRunState]                     = useState<RunState>('STOPPED');
  const runStateRef                                  = useRef<RunState>('STOPPED');
  const runningRef                                   = useRef(false);
  const runtimeStartRef                              = useRef<number|null>(null);
  const [runtimeDisplay, setRuntimeDisplay]         = useState('');
  const completedTradesRef                           = useRef(0);
  const [completedTrades, setCompletedTrades]       = useState(0);
  const todayPnLRef                                  = useRef(0);
  const [todayPnL, setTodayPnL]                     = useState(0);

  // ── Timers ─────────────────────────────────────────────────────────────────
  const signalTimerRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const monitorTimerRef = useRef<ReturnType<typeof setInterval>|null>(null);

  // ── Activity feed ──────────────────────────────────────────────────────────
  const [activityLog, setActivityLog]               = useState<ActivityEntry[]>([]);
  const [toast, setToast]                           = useState<{ok:boolean;msg:string}|null>(null);

  // ── Settings editing ───────────────────────────────────────────────────────
  const [showSettings, setShowSettings]             = useState(false);
  const [sBudget, setSBudget]                       = useState('500');
  const [sMaxPct, setSMaxPct]                       = useState(10);
  const [sReservePct, setSReservePct]               = useState(20);

  // ── Last signals scan ──────────────────────────────────────────────────────
  const [lastScanTime, setLastScanTime]             = useState<string|null>(null);
  const [scanProgress, setScanProgress]             = useState('');
  const [signalCountdown, setSignalCountdown]       = useState('');
  const signalStartRef                               = useRef<number|null>(null);
  const SIGNAL_SCAN_MS = 5 * 60_000;
  const MONITOR_MS     = 60_000;

  // ── On mount: load persisted state ────────────────────────────────────────
  useEffect(() => {
    const s = loadSettings();
    setSettingsState(s);
    setSBudget(String(s.totalBudget));
    setSMaxPct(s.maxPerTradePct);
    setSReservePct(s.reservePct);
    const pos = loadAllocatedPositions();
    setAllocatedPositions(pos);
    const deployed = pos.reduce((sum, p) => sum + p.allocationAmount, 0);
    const deployable = getDeployable(s);
    const avail = loadAvailableCapital(deployable - deployed);
    setAvailableCapitalState(avail);

    // Auto-restart check
    if (localStorage.getItem(STRATEGY_RUNNING_KEY) === 'true') {
      if (t212Connected) {
        log('info', '♻️ Strategy resumed — was running before page reload');
        startStrategy();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Runtime ticker ─────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => {
      if (runtimeStartRef.current === null) return;
      const ms = Date.now() - runtimeStartRef.current;
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      setRuntimeDisplay(`${h}h ${m}m`);
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  // ── Signal countdown ───────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => {
      if (runState === 'STOPPED' || !signalStartRef.current) { setSignalCountdown(''); return; }
      const rem = SIGNAL_SCAN_MS - (Date.now() - signalStartRef.current);
      const s = Math.max(0, Math.ceil(rem / 1000));
      setSignalCountdown(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    }, 1000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runState]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => () => {
    if (signalTimerRef.current)  clearInterval(signalTimerRef.current);
    if (monitorTimerRef.current) clearInterval(monitorTimerRef.current);
  }, []);

  // ── Helpers ────────────────────────────────────────────────────────────────
  function log(type: ActivityEntry['type'], msg: string) {
    setActivityLog(p => [{ id: uid(), ts: new Date().toISOString(), type, msg }, ...p].slice(0, 100));
  }

  function showToast(ok: boolean, msg: string) {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 4000);
  }

  function getAuth() {
    if (!t212ApiKey || !t212ApiSecret) return null;
    return btoa(t212ApiKey + ':' + t212ApiSecret);
  }

  function getEnv(): 'demo' | 'live' {
    return t212AccountType === 'LIVE' ? 'live' : 'demo';
  }

  // ── Fetch scanner signals ──────────────────────────────────────────────────
  async function fetchSignals(): Promise<SignalItem[]> {
    try {
      const r = await fetch('/api/demo-trader/signals?strategy=smart-money&num=15');
      if (!r.ok) return [];
      const d = await r.json() as { signals?: SignalItem[]; results?: SignalItem[] };
      return (d.signals ?? d.results ?? []) as SignalItem[];
    } catch { return []; }
  }

  // ── Fetch current T212 positions ───────────────────────────────────────────
  async function fetchT212Positions(): Promise<Record<string, number>> {
    const encoded = getAuth();
    if (!encoded) return {};
    try {
      const env = getEnv();
      const r = await fetch(`/api/t212/positions?env=${env}`, {
        headers: { 'x-t212-auth': encoded },
      });
      if (!r.ok) return {};
      const data = await r.json() as Array<{ ticker: string; quantity: number }>;
      const map: Record<string, number> = {};
      if (Array.isArray(data)) {
        data.forEach(p => { if (p.ticker) map[p.ticker] = p.quantity; });
      }
      return map;
    } catch { return {}; }
  }

  // ── Monitor open positions: detect closes ─────────────────────────────────
  const monitorPositions = useCallback(async () => {
    if (!runningRef.current) return;
    const current = loadAllocatedPositions();
    if (current.length === 0) return;

    const t212Pos = await fetchT212Positions();

    const stillOpen: AllocatedPosition[] = [];
    for (const pos of current) {
      const t212Qty = t212Pos[pos.t212Ticker] ?? 0;
      if (t212Qty > 0) {
        stillOpen.push(pos);
      } else {
        // Position was closed (SL or TP hit)
        const exitValue = pos.allocationAmount; // approximate — actual P&L unknown without T212 history
        adjustAvailableCapital(exitValue);
        completedTradesRef.current += 1;
        setCompletedTrades(completedTradesRef.current);
        log('close', `${pos.ticker} closed — returning £${exitValue.toFixed(2)} to available pool · redeploying into next signal`);
        log('capital', `Available: £${(availableCapital + exitValue).toFixed(2)}`);
      }
    }

    if (stillOpen.length !== current.length) {
      setAllocatedPositions(stillOpen);
      saveAllocatedPositions(stillOpen);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableCapital]);

  // ── Signal scan: fetch signals and trade ──────────────────────────────────
  const runSignalScan = useCallback(async () => {
    if (!runningRef.current) return;
    const encoded = getAuth();
    if (!encoded) return;

    const currentSettings = loadSettings();
    const deployable = getDeployable(currentSettings);
    const currentAvail = loadAvailableCapital(deployable);

    log('info', `📡 Signal scan — available: £${currentAvail.toFixed(2)} of £${deployable.toFixed(2)} deployable`);
    setScanProgress('Fetching signals…');

    const signals = await fetchSignals();
    const buySignals = signals.filter(s => s.signal === 'BUY');

    if (buySignals.length === 0) {
      log('signal', 'No BUY signals this scan');
      setScanProgress('');
      setLastScanTime(new Date().toISOString());
      return;
    }

    log('signal', `${buySignals.length} BUY signals found`);

    const currentPositions = loadAllocatedPositions();
    const openTickers = new Set(currentPositions.map(p => p.ticker));

    for (const sig of buySignals) {
      if (!runningRef.current) break;
      if (runStateRef.current === 'PAUSED') {
        log('signal', `[PAUSED] ${sig.symbol} → BUY — no new entries while paused`);
        continue;
      }

      // Skip if already have an open position in this stock
      if (openTickers.has(sig.symbol)) continue;

      // Fetch fresh available capital
      const freshAvail = loadAvailableCapital(deployable);
      if (freshAvail < 1) {
        log('info', 'No available capital — waiting for positions to close');
        break;
      }

      setScanProgress(`Placing order: ${sig.symbol}…`);

      const allocationAmount = getAllocationAmount(sig.confidence, freshAvail, currentSettings.maxPerTradePct);
      if (allocationAmount < 0.50) continue; // too small to trade

      const quantity = Math.round((allocationAmount / sig.currentPrice) * 10000) / 10000;
      const allocationPct = freshAvail > 0 ? (allocationAmount / freshAvail * 100).toFixed(0) : '0';

      log('buy', `${sig.symbol} @ £${sig.currentPrice.toFixed(2)} — allocating £${allocationAmount.toFixed(2)} (${allocationPct}% of available) · ${quantity} shares · ${getAllocationLabel(sig.confidence)}`);

      // Place T212 order
      const env = getEnv();
      try {
        const body = {
          ticker: sig.t212Ticker ?? sig.symbol,
          quantity,
          env,
        };
        const r = await fetch('/api/t212/live-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-t212-auth': encoded },
          body: JSON.stringify(body),
        });
        const d = await r.json() as { ok: boolean; fillPrice?: number; quantity?: number; error?: string };

        if (d.ok) {
          const filledQty = d.quantity ?? quantity;
          const entryPrice = d.fillPrice ?? sig.currentPrice;
          const actualCost = filledQty * entryPrice;

          // Deduct from available capital
          adjustAvailableCapital(-actualCost);

          const newPos: AllocatedPosition = {
            id: uid(),
            ticker: sig.symbol,
            t212Ticker: sig.t212Ticker ?? sig.symbol + '_US_EQ',
            companyName: sig.name,
            quantity: filledQty,
            entryPrice,
            allocationAmount: actualCost,
            confidence: sig.confidence,
            openedAt: new Date().toISOString(),
          };
          const updatedPositions = [...loadAllocatedPositions(), newPos];
          setAllocatedPositions(updatedPositions);
          saveAllocatedPositions(updatedPositions);
          openTickers.add(sig.symbol);

          log('buy', `✅ Opened: ${sig.symbol} · ${filledQty} shares @ £${entryPrice.toFixed(2)} · allocated £${actualCost.toFixed(2)} (${allocationPct}% of available)`);
          log('capital', `Available: £${(loadAvailableCapital(deployable) - actualCost).toFixed(2)} of £${deployable.toFixed(2)} deployable`);
          showToast(true, `BUY ${sig.symbol}: ${filledQty} shares`);
        } else {
          log('error', `${sig.symbol} order failed: ${d.error ?? 'unknown'}`);
        }
      } catch (e) {
        log('error', `${sig.symbol} exception: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (buySignals.indexOf(sig) < buySignals.length - 1) await sleep(500);
    }

    setScanProgress('');
    setLastScanTime(new Date().toISOString());
    log('info', `Scan complete — next in ${Math.round(SIGNAL_SCAN_MS / 60_000)} min`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Start / Pause / Stop ──────────────────────────────────────────────────
  function startStrategy() {
    if (!t212Connected) { showToast(false, 'Connect T212 in Settings first'); return; }
    if (signalTimerRef.current)  clearInterval(signalTimerRef.current);
    if (monitorTimerRef.current) clearInterval(monitorTimerRef.current);

    runningRef.current = true;
    runStateRef.current = 'RUNNING';
    setRunState('RUNNING');
    runtimeStartRef.current = Date.now();
    completedTradesRef.current = 0;
    setCompletedTrades(0);
    todayPnLRef.current = 0;
    setTodayPnL(0);
    setRuntimeDisplay('0h 0m');
    localStorage.setItem(STRATEGY_RUNNING_KEY, 'true');

    const currentSettings = loadSettings();
    const deployable = getDeployable(currentSettings);
    log('info', `▶ T212 Strategy started · ${t212AccountType} · deployable: £${deployable.toFixed(2)} · reserve: ${currentSettings.reservePct}%`);

    signalStartRef.current = Date.now();
    void runSignalScan();
    void monitorPositions();

    signalTimerRef.current = setInterval(() => {
      signalStartRef.current = Date.now();
      void runSignalScan();
    }, SIGNAL_SCAN_MS);

    monitorTimerRef.current = setInterval(() => {
      void monitorPositions();
    }, MONITOR_MS);
  }

  function pauseStrategy() {
    runStateRef.current = 'PAUSED';
    setRunState('PAUSED');
    log('info', '⏸ Strategy PAUSED — monitoring positions, no new entries until resumed');
  }

  function stopStrategy() {
    runningRef.current = false;
    runStateRef.current = 'STOPPED';
    setRunState('STOPPED');
    if (signalTimerRef.current)  { clearInterval(signalTimerRef.current);  signalTimerRef.current  = null; }
    if (monitorTimerRef.current) { clearInterval(monitorTimerRef.current); monitorTimerRef.current = null; }
    runtimeStartRef.current = null;
    setRuntimeDisplay('');
    setScanProgress('');
    setSignalCountdown('');
    localStorage.removeItem(STRATEGY_RUNNING_KEY);
    log('info', `⏹ Strategy stopped · ${completedTradesRef.current} trades completed · Today P&L: ${todayPnLRef.current >= 0 ? '+' : ''}£${Math.abs(todayPnLRef.current).toFixed(2)}`);
  }

  function saveCapitalSettings() {
    const budget = parseFloat(sBudget);
    if (isNaN(budget) || budget <= 0) { showToast(false, 'Enter a valid budget'); return; }
    const s: CapitalSettings = { totalBudget: budget, maxPerTradePct: sMaxPct, reservePct: sReservePct };
    updateSettings(s);
    setShowSettings(false);
    showToast(true, 'Capital settings saved');
  }

  // ── Derived values ─────────────────────────────────────────────────────────
  const isRunning = runState !== 'STOPPED';
  const deployable = getDeployable(settings);
  const deployed   = allocatedPositions.reduce((s, p) => s + p.allocationAmount, 0);

  if (!t212Connected) {
    return (
      <div className="max-w-xl space-y-4">
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center text-2xl">📈</div>
            <div>
              <h3 className="text-sm font-semibold text-white">T212 Auto-Strategy</h3>
              <p className="text-xs text-gray-500">Automated stock trading with percentage-based capital allocation</p>
            </div>
          </div>
          <p className="text-xs text-gray-400 mb-4">
            Connect your Trading 212 account in{' '}
            <a href="/settings/accounts" className="text-blue-400 hover:underline">Settings → Accounts</a>{' '}
            to start automated trading.
          </p>
        </Card>
      </div>
    );
  }

  // Default amount for manual trades: high-confidence tier of available capital
  const manualDefaultAmount = Math.max(1, availableCapital * Math.min(10, settings.maxPerTradePct) / 100);

  return (
    <div className="space-y-4 max-w-3xl">

      {/* ── Manual Trade Opportunities + Managed Positions ──────────────────── */}
      <T212ManualTrading defaultTradeAmount={manualDefaultAmount} />

      {/* Toast */}
      {toast && (
        <div className={clsx('flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium',
          toast.ok ? 'bg-emerald-500/15 border border-emerald-500/25 text-emerald-400' : 'bg-red-500/15 border border-red-500/25 text-red-400'
        )}>
          {toast.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
          {toast.msg}
        </div>
      )}

      {/* Account badge */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={clsx('text-[10px] px-2 py-0.5 rounded-full',
          t212AccountType === 'LIVE' ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'
        )}>
          T212 {t212AccountType === 'LIVE' ? '⚠️ LIVE' : 'Demo'}
        </span>
        <span className="text-[10px] text-gray-500 px-2 py-0.5 bg-gray-800/50 rounded-full">
          Signals: Smart-Money Scanner · Execution: T212
        </span>
        {lastScanTime && (
          <span className="text-[10px] text-gray-600 ml-auto">Last scan: {fmtTime(lastScanTime)}</span>
        )}
      </div>

      {t212AccountType === 'LIVE' && (
        <div className="bg-amber-500/15 border border-amber-500/40 rounded-lg px-3 py-2.5 text-xs text-amber-400 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          LIVE MODE — Trades will use real money on your T212 Live account
        </div>
      )}

      {/* ── Capital Allocation Summary ──────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Capital Allocation"
          subtitle="Percentage-based sizing — no fixed quantities"
          icon={<DollarSign className="h-4 w-4" />}
          action={
            <button onClick={() => setShowSettings(v => !v)}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-white transition-colors">
              <Settings className="h-3.5 w-3.5" />
              Settings
            </button>
          }
        />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
          {[
            { label: 'Total Budget',    value: `£${settings.totalBudget.toFixed(0)}`,    color: 'text-white' },
            { label: 'Deployable',      value: `£${deployable.toFixed(0)}`,              color: 'text-white', sub: `${100-settings.reservePct}% of budget` },
            { label: 'Available',       value: `£${availableCapital.toFixed(2)}`,         color: availableCapital > 5 ? 'text-emerald-400' : 'text-gray-500' },
            { label: 'Deployed',        value: `£${deployed.toFixed(2)}`,                color: deployed > 0 ? 'text-amber-400' : 'text-gray-500' },
          ].map(r => (
            <div key={r.label} className="bg-gray-800/40 rounded-lg px-2.5 py-2">
              <p className="text-[9px] text-gray-500 uppercase tracking-wider">{r.label}</p>
              <p className={clsx('text-sm font-bold tabular-nums', r.color)}>{r.value}</p>
              {r.sub && <p className="text-[9px] text-gray-600">{r.sub}</p>}
            </div>
          ))}
        </div>

        {/* Capital bar */}
        <div className="h-2 bg-gray-800 rounded-full overflow-hidden mb-1">
          <div className="h-full bg-amber-500/70 rounded-full transition-all"
            style={{ width: `${deployable > 0 ? Math.min(100, deployed / deployable * 100) : 0}%` }} />
        </div>
        <p className="text-[10px] text-gray-600">
          Available: £{availableCapital.toFixed(2)} of £{deployable.toFixed(0)} deployable · Reserve: £{(settings.totalBudget * settings.reservePct / 100).toFixed(0)} ({settings.reservePct}%)
        </p>

        {/* Confidence tiers */}
        <div className="mt-3 grid grid-cols-3 gap-2 text-[10px]">
          {[
            { label: 'High confidence >80%', pct: Math.min(10, settings.maxPerTradePct), color: 'text-emerald-400' },
            { label: 'Medium 65-80%',         pct: Math.min(5, settings.maxPerTradePct),  color: 'text-blue-400' },
            { label: 'Lower 50-65%',          pct: Math.min(2, settings.maxPerTradePct),  color: 'text-gray-400' },
          ].map(t => (
            <div key={t.label} className="bg-gray-800/30 rounded-lg px-2 py-1.5">
              <p className={clsx('font-semibold', t.color)}>{t.pct}% of available</p>
              <p className="text-gray-600 mt-0.5">{t.label}</p>
              <p className="text-gray-500 mt-0.5">≈ £{(availableCapital * t.pct / 100).toFixed(2)}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* ── Settings panel ──────────────────────────────────────────────── */}
      {showSettings && (
        <Card>
          <CardHeader title="Capital Allocation Settings" icon={<Settings className="h-4 w-4" />}
            action={<button onClick={() => setShowSettings(false)}><X className="h-4 w-4 text-gray-500 hover:text-white" /></button>}
          />
          <div className="space-y-4">
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Total Budget (£)</label>
              <input type="number" min={1} value={sBudget} onChange={e => setSBudget(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
              <p className="text-[10px] text-gray-500 mt-1">Total funds to deploy with this strategy</p>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Max per trade: <span className="text-blue-400 font-mono">{sMaxPct}%</span></label>
              <input type="range" min={1} max={25} step={1} value={sMaxPct} onChange={e => setSMaxPct(Number(e.target.value))}
                className="w-full accent-blue-500" />
              <p className="text-[10px] text-gray-500 mt-1">Maximum % of available capital per single trade (default 10%, max 25%)</p>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1.5 block">Reserve: <span className="text-amber-400 font-mono">{sReservePct}%</span></label>
              <input type="range" min={5} max={50} step={5} value={sReservePct} onChange={e => setSReservePct(Number(e.target.value))}
                className="w-full accent-amber-500" />
              <p className="text-[10px] text-gray-500 mt-1">
                Always keep {sReservePct}% in cash = £{(parseFloat(sBudget||'0') * sReservePct / 100).toFixed(0)} reserved
                · Deployable: £{(parseFloat(sBudget||'0') * (1 - sReservePct/100)).toFixed(0)}
              </p>
            </div>
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-[11px] text-blue-300 space-y-1">
              <p>With £{parseFloat(sBudget)||0} budget, {sReservePct}% reserve = £{((parseFloat(sBudget)||0) * (1-sReservePct/100)).toFixed(0)} deployable</p>
              <p>High confidence trade = {Math.min(10, sMaxPct)}% of available = £{((parseFloat(sBudget)||0) * (1-sReservePct/100) * Math.min(10, sMaxPct) / 100).toFixed(2)} per trade</p>
            </div>
            <Button fullWidth onClick={saveCapitalSettings}>Save Settings</Button>
          </div>
        </Card>
      )}

      {/* ── Strategy Controls ───────────────────────────────────────────── */}
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-white">Smart-Money Auto Strategy</p>
            <p className="text-[11px] text-gray-500">
              Scans every 5 min · monitors every 60s · {allocatedPositions.length} open positions
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap">
            {isRunning ? (
              <>
                {runState === 'PAUSED' ? (
                  <Button size="sm" variant="outline" className="text-amber-400 border-amber-500/40"
                    icon={<Play className="h-3.5 w-3.5" />}
                    onClick={() => { runStateRef.current = 'RUNNING'; setRunState('RUNNING'); log('info', '▶ Resumed — scanning for new entries'); }}>
                    Resume
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" icon={<Pause className="h-3.5 w-3.5" />} onClick={pauseStrategy}>
                    Pause
                  </Button>
                )}
                <Button size="sm" className="bg-red-600 hover:bg-red-500 text-white"
                  icon={<Square className="h-3.5 w-3.5" />} onClick={stopStrategy}>
                  Stop
                </Button>
              </>
            ) : (
              <Button size="sm" className="bg-blue-600 hover:bg-blue-500 text-white"
                icon={<Play className="h-3.5 w-3.5" />} onClick={startStrategy}>
                {t212AccountType === 'LIVE' ? '⚠️ Run Live' : 'Run Strategy'}
              </Button>
            )}
          </div>
        </div>

        {/* Running status */}
        {isRunning && (
          <div className={clsx('mt-3 rounded-lg px-3 py-2 space-y-1 border',
            runState === 'PAUSED' ? 'bg-amber-500/10 border-amber-500/20' : 'bg-blue-500/10 border-blue-500/20'
          )}>
            <div className="flex items-center gap-2 flex-wrap">
              <Activity className={clsx('h-3.5 w-3.5 flex-shrink-0', runState === 'PAUSED' ? 'text-amber-400' : 'text-blue-400 animate-pulse')} />
              <span className={clsx('text-xs font-medium', runState === 'PAUSED' ? 'text-amber-300' : 'text-blue-300')}>
                {runState === 'PAUSED' ? '⏸ PAUSED — monitoring positions, no new entries' : scanProgress || 'RUNNING'}
              </span>
              {runtimeDisplay && <span className="text-[10px] text-gray-500 ml-auto">Running {runtimeDisplay}</span>}
            </div>
            <div className="flex items-center gap-4 text-[11px] text-gray-500 flex-wrap">
              <span>Trades: <span className="text-white font-semibold">{completedTrades}</span></span>
              <span>Capital deployed: <span className="text-amber-400 font-semibold">£{deployed.toFixed(2)}</span> / £{deployable.toFixed(0)}</span>
              <span>Today P&L: <span className={clsx('font-semibold', todayPnL >= 0 ? 'text-emerald-400' : 'text-red-400')}>{todayPnL >= 0 ? '+' : ''}£{Math.abs(todayPnL).toFixed(2)}</span></span>
              {runState === 'RUNNING' && signalCountdown && <span>Next scan: <span className="text-blue-400 font-mono">{signalCountdown}</span></span>}
            </div>
          </div>
        )}
      </Card>

      {/* ── Open Allocated Positions ────────────────────────────────────── */}
      {allocatedPositions.length > 0 && (
        <Card>
          <CardHeader
            title="Open Positions"
            subtitle={`${allocatedPositions.length} positions · £${deployed.toFixed(2)} deployed`}
            icon={<Target className="h-4 w-4" />}
            action={
              <button
                onClick={() => {
                  if (confirm('Clear all tracked allocations? (does NOT sell positions in T212)')) {
                    setAllocatedPositions([]);
                    saveAllocatedPositions([]);
                    const d = getDeployable(settings);
                    setAvailableCapitalState(d);
                    saveAvailableCapital(d);
                  }
                }}
                className="text-[10px] text-gray-600 hover:text-red-400 transition-colors"
              >
                Clear
              </button>
            }
          />
          <div className="space-y-2">
            {allocatedPositions.map(pos => {
              const allocationPct = deployable > 0 ? (pos.allocationAmount / deployable * 100).toFixed(1) : '0';
              return (
                <div key={pos.id} className="bg-gray-800/40 rounded-lg px-3 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-xs font-bold text-white">{pos.ticker}</span>
                        <TrendingUp className="h-3 w-3 text-emerald-400" />
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">BUY</span>
                      </div>
                      <p className="text-[10px] text-gray-400 truncate">{pos.companyName}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-xs font-semibold text-amber-400">£{pos.allocationAmount.toFixed(2)}</p>
                      <p className="text-[9px] text-gray-500">{allocationPct}% of deployable</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-[10px] text-gray-500 flex-wrap">
                    <span>Allocated: <span className="text-white font-semibold">£{pos.allocationAmount.toFixed(2)} ({allocationPct}% of available)</span></span>
                    <span>Quantity: <span className="text-white font-mono">{pos.quantity} shares</span></span>
                    <span>Entry: <span className="text-white font-mono">£{pos.entryPrice.toFixed(2)}/share</span></span>
                  </div>
                  <p className="text-[9px] text-gray-600 mt-1">Opened {fmtTime(pos.openedAt)}</p>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* ── Live Activity Feed ──────────────────────────────────────────── */}
      {activityLog.length > 0 && (
        <Card>
          <CardHeader
            title="Live Activity Feed"
            subtitle={`${activityLog.length} entries · last 100`}
            icon={<Activity className="h-4 w-4" />}
            action={<button onClick={() => setActivityLog([])} className="text-xs text-gray-500 hover:text-white">Clear</button>}
          />
          <div className="space-y-0.5 max-h-72 overflow-y-auto font-mono">
            {activityLog.map(e => (
              <div key={e.id} className="flex gap-2 text-[11px] py-0.5">
                <span className="text-gray-600 flex-shrink-0 tabular-nums">{fmtTime(e.ts)}</span>
                <span className={clsx('flex-1 break-all leading-relaxed',
                  e.type === 'buy'     ? 'text-emerald-400' :
                  e.type === 'close'   ? 'text-blue-400' :
                  e.type === 'error'   ? 'text-red-500' :
                  e.type === 'signal'  ? 'text-amber-400' :
                  e.type === 'capital' ? 'text-cyan-400' :
                  'text-gray-400'
                )}>{e.msg}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Empty state */}
      {activityLog.length === 0 && !isRunning && (
        <div className="text-center py-10 border border-dashed border-gray-800 rounded-xl">
          <Plus className="h-10 w-10 mx-auto mb-3 text-gray-700" />
          <p className="text-sm font-medium text-gray-500">Strategy not running</p>
          <p className="text-xs text-gray-600 mt-1 mb-4">Click Run Strategy to start automated T212 trading</p>
        </div>
      )}

    </div>
  );
}

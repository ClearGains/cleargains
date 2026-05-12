'use client';

import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';

// ── Types (mirror bot-server/src/stockBot.ts) ─────────────────────────────────

export type StockSignal = {
  ticker: string; price: number; rsi: number | null; macdHist: number | null;
  macdCross: 'bullish'|'bearish'|'none'; sma20: number | null;
  direction: 'BUY'|'SELL'|'NEUTRAL'; strength: number; reason: string;
  marketOpen: boolean; blackout: boolean; scanning: boolean;
  lastScanned: string; error?: string;
};

export type StockPosition = {
  dealId: string; ticker: string; epic: string; instrumentName: string;
  direction: string; size: number; level: number; upl: number; currency: string;
  bid: number; offer: number; stopLevel?: number; limitLevel?: number;
};

export type BotSettings = {
  riskPerTrade: number; maxPositions: number; stopAtrMult: number;
  targetRR: number; minStrength: number; scanIntervalMins: number;
  earningsBlackout: boolean;
};

export type LogEntry = { id: string; ts: string; type: 'info'|'buy'|'sell'|'close'|'error'|'warn'; msg: string };

export type BotStatus = 'stopped' | 'running' | 'paused';

export const DEFAULT_SETTINGS: BotSettings = {
  riskPerTrade: 50, maxPositions: 3, stopAtrMult: 2.0, targetRR: 2.5,
  minStrength: 70, scanIntervalMins: 15, earningsBlackout: true,
};

// High-volatility names only — blue chips move too slowly to justify minimum 1pt bet
const DEFAULT_ENABLED  = ['NVDA', 'TSLA', 'AMD', 'META', 'NFLX'];
const STORAGE_KEY      = 'ig_stock_auto_trader_v1';
const POLL_INTERVAL_MS = 8_000;

// ── Server status shape ───────────────────────────────────────────────────────

type ServerStatus = {
  running: boolean; paused: boolean;
  settings: BotSettings | null; tickers: string[];
  signals: Record<string, StockSignal>; positions: StockPosition[];
  logs: LogEntry[]; available: number | null; balance: number | null;
  lastScanAt: string | null; nextScanAt: string | null; sessionOk: boolean;
};

// ── Context shape ─────────────────────────────────────────────────────────────

export type IGStockBotContextValue = {
  status:     BotStatus;
  env:        'demo' | 'live';
  connected:  boolean;
  positions:  StockPosition[];
  signals:    Record<string, StockSignal>;
  logs:       LogEntry[];
  settings:   BotSettings;
  enabled:    Set<string>;
  available:  number | null;
  balance:    number | null;
  lastScanAt: string | null;
  nextScanAt: string | null;
  serverReachable: boolean;
  connecting: boolean;
  connErr:    string;
  setEnv:      (e: 'demo'|'live') => void;
  setSettings: (s: BotSettings) => void;
  toggleTicker: (t: string) => void;
  start:   () => Promise<void>;
  stop:    () => Promise<void>;
  pause:   () => Promise<void>;
  resume:  () => Promise<void>;
  refresh: () => Promise<void>;
};

const IGStockBotContext = createContext<IGStockBotContextValue | null>(null);

export function useIGStockBot(): IGStockBotContextValue {
  const ctx = useContext(IGStockBotContext);
  if (!ctx) throw new Error('useIGStockBot must be used inside IGStockBotProvider');
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function IGStockBotProvider({ children }: { children: ReactNode }) {
  const [env,       setEnvState]  = useState<'demo'|'live'>('demo');
  const [settings,  setSettings]  = useState<BotSettings>(DEFAULT_SETTINGS);
  const [enabled,   setEnabled]   = useState<Set<string>>(() => new Set(DEFAULT_ENABLED));
  const [connecting, setConnecting] = useState(false);
  const [connErr,   setConnErr]   = useState('');

  // Derived from server polling
  const [status,     setStatus]     = useState<BotStatus>('stopped');
  const [connected,  setConnected]  = useState(false);
  const [positions,  setPositions]  = useState<StockPosition[]>([]);
  const [signals,    setSignals]    = useState<Record<string, StockSignal>>({});
  const [logs,       setLogs]       = useState<LogEntry[]>([]);
  const [available,  setAvailable]  = useState<number | null>(null);
  const [balance,    setBalance]    = useState<number | null>(null);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);
  const [nextScanAt, setNextScanAt] = useState<string | null>(null);
  const [serverReachable, setServerReachable] = useState(false);

  const envRef      = useRef(env);
  const pollTimer   = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusRef   = useRef(status);

  useEffect(() => { envRef.current = env; }, [env]);
  useEffect(() => { statusRef.current = status; }, [status]);

  // Persist settings + enabled
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, enabled: [...enabled] })); } catch {}
  }, [settings, enabled]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as { settings?: BotSettings; enabled?: string[] };
      if (d.settings) setSettings(d.settings);
      if (d.enabled)  setEnabled(new Set(d.enabled));
    } catch {}
  }, []);

  function setEnv(e: 'demo'|'live') { setEnvState(e); }

  function toggleTicker(t: string) {
    setEnabled(p => { const n = new Set(p); n.has(t) ? n.delete(t) : n.add(t); return n; });
  }

  // ── Server polling ────────────────────────────────────────────────────────

  const applyServerStatus = useCallback((s: ServerStatus) => {
    setStatus(s.running ? (s.paused ? 'paused' : 'running') : 'stopped');
    setConnected(s.sessionOk);
    setPositions(s.positions ?? []);
    setSignals(s.signals ?? {});
    setLogs(s.logs ?? []);
    setAvailable(s.available ?? null);
    setBalance(s.balance ?? null);
    setLastScanAt(s.lastScanAt ?? null);
    setNextScanAt(s.nextScanAt ?? null);
    setServerReachable(true);
  }, []);

  const pollStatus = useCallback(async () => {
    try {
      const r = await fetch(`/api/ig/bot?action=stock-status&account=${envRef.current}`);
      if (!r.ok) { setServerReachable(false); return; }
      const d = await r.json() as ServerStatus;
      applyServerStatus(d);
    } catch {
      setServerReachable(false);
    }
  }, [applyServerStatus]);

  // Poll on mount to pick up any already-running bot
  useEffect(() => { void pollStatus(); }, [pollStatus]);

  // Poll every 8s when running/paused (server is doing the work, we just display)
  useEffect(() => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    if (status !== 'stopped') {
      pollTimer.current = setInterval(() => void pollStatus(), POLL_INTERVAL_MS);
    }
    return () => { if (pollTimer.current) clearInterval(pollTimer.current); };
  }, [status, pollStatus]);

  // ── Actions ───────────────────────────────────────────────────────────────

  async function callServer(action: string, body?: unknown): Promise<boolean> {
    setConnecting(true);
    setConnErr('');
    try {
      const r = await fetch(`/api/ig/bot?action=${action}&account=${envRef.current}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const d = await r.json() as { ok?: boolean; error?: string };
      if (d.ok === false) { setConnErr(d.error ?? 'Server error'); return false; }
      setServerReachable(true);
      return true;
    } catch (e) {
      setConnErr(e instanceof Error ? e.message : 'Bot server unreachable — is it running?');
      setServerReachable(false);
      return false;
    } finally {
      setConnecting(false);
    }
  }

  async function start() {
    const ok = await callServer('stock-start', {
      tickers:  [...enabled],
      settings,
    });
    if (ok) {
      setStatus('running');
      await pollStatus();
      // Start polling immediately
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = setInterval(() => void pollStatus(), POLL_INTERVAL_MS);
    }
  }

  async function stop() {
    await callServer('stock-stop');
    setStatus('stopped');
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    await pollStatus();
  }

  async function pause() {
    await callServer('stock-pause');
    await pollStatus();
  }

  async function resume() {
    await callServer('stock-resume');
    await pollStatus();
  }

  async function refresh() { await pollStatus(); }

  const value: IGStockBotContextValue = {
    status, env, connected, positions, signals, logs, settings, enabled,
    available, balance, lastScanAt, nextScanAt, serverReachable,
    connecting, connErr,
    setEnv, setSettings, toggleTicker,
    start, stop, pause, resume, refresh,
  };

  return (
    <IGStockBotContext.Provider value={value}>
      {children}
    </IGStockBotContext.Provider>
  );
}

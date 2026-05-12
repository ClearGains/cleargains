'use client';

import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { IG_STOCK_EPICS } from '@/lib/ig-stock-epics';
import { calcRSI, calcMACD, calcSMA, type LWCandle } from '@/lib/chartIndicators';

// ── Types ─────────────────────────────────────────────────────────────────────

export type IGSession = { cst: string; securityToken: string; accountId: string; apiKey: string };

export type IGPosition = {
  dealId: string; direction: string; size: number; level: number;
  upl: number; currency: string; epic: string; instrumentName: string;
  bid: number; offer: number; stopLevel?: number; limitLevel?: number;
};

export type StockSignal = {
  ticker: string; price: number; changeHour: number;
  rsi: number | null; macdHist: number | null; macdCross: 'bullish' | 'bearish' | 'none';
  sma20: number | null; direction: 'BUY' | 'SELL' | 'NEUTRAL'; strength: number;
  reason: string; marketOpen: boolean; blackout: boolean; scanning: boolean;
  lastScanned: string; error?: string;
};

export type BotSettings = {
  riskPerTrade: number; maxPositions: number; stopAtrMult: number;
  targetRR: number; minStrength: number; scanIntervalMins: number; earningsBlackout: boolean;
};

export type LogEntry = { id: string; ts: string; type: 'info'|'buy'|'sell'|'close'|'error'|'warn'; msg: string };

export type BotStatus = 'stopped' | 'running' | 'paused';

// ── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY     = 'ig_stock_auto_trader_v1';
const DEFAULT_ENABLED = ['NVDA', 'AAPL', 'TSLA', 'MSFT', 'BARC', 'LLOY'];

export const DEFAULT_SETTINGS: BotSettings = {
  riskPerTrade: 50, maxPositions: 3, stopAtrMult: 2.0, targetRR: 2.5,
  minStrength: 65, scanIntervalMins: 15, earningsBlackout: true,
};

const EARNINGS_DATES: Record<string, string> = {
  'NVDA': '2026-08-27', 'AAPL': '2026-07-31', 'MSFT': '2026-07-29',
  'GOOGL': '2026-07-28', 'AMZN': '2026-07-30', 'META': '2026-07-29',
  'TSLA': '2026-07-22', 'AMD': '2026-07-28', 'NFLX': '2026-07-15',
};

const LSE_TICKERS = new Set(['VOD', 'BP', 'SHEL', 'BARC', 'LLOY', 'AZN', 'GSK', 'HSBA']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9); }
function yahooTicker(t: string) { return LSE_TICKERS.has(t) ? `${t}.L` : t; }

function isEarningsBlackout(ticker: string, enabled: boolean): boolean {
  if (!enabled) return false;
  const d = EARNINGS_DATES[ticker];
  if (!d) return false;
  const daysUntil = (new Date(d).getTime() - Date.now()) / 86_400_000;
  return daysUntil >= 0 && daysUntil <= 3;
}

function isMarketOpen(exchange: string): boolean {
  const now  = new Date();
  const day  = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 0 || day === 6) return false;
  if (exchange === 'LSE') return mins >= 7 * 60 && mins < 15 * 60 + 30;
  return mins >= 13 * 60 + 30 && mins < 20 * 60;
}

function calcATR(candles: LWCandle[], period = 14): number {
  const s = candles.slice(-(period + 1));
  if (s.length < 2) return Number(candles[candles.length - 1]?.close ?? 1) * 0.02;
  let sum = 0;
  for (let i = 1; i < s.length; i++) {
    const c = s[i], p = s[i - 1];
    sum += Math.max(
      Number(c.high) - Number(c.low),
      Math.abs(Number(c.high) - Number(p.close)),
      Math.abs(Number(c.low)  - Number(p.close)),
    );
  }
  return sum / (s.length - 1);
}

export function makeHeaders(s: IGSession, env: 'demo'|'live') {
  return { 'x-ig-cst': s.cst, 'x-ig-security-token': s.securityToken, 'x-ig-api-key': s.apiKey, 'x-ig-env': env };
}

export async function connectIG(env: 'demo'|'live'): Promise<IGSession|null> {
  const credKey = env === 'demo' ? 'ig_demo_credentials' : 'ig_live_credentials';
  const sessKey = `ig_session_${env}`;
  try {
    const raw = localStorage.getItem(credKey);
    if (!raw) return null;
    const c = JSON.parse(raw) as { username: string; password: string; apiKey: string; connected?: boolean };
    if (!c.connected) return null;
    const cached = localStorage.getItem(sessKey);
    if (cached) {
      const s = JSON.parse(cached) as { cst: string; securityToken: string; accountId: string; apiKey: string; authenticatedAt: number };
      if (s.cst && (Date.now() - s.authenticatedAt) < 5 * 3_600_000)
        return { cst: s.cst, securityToken: s.securityToken, accountId: s.accountId, apiKey: s.apiKey };
    }
    const r = await fetch('/api/ig/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: c.username, password: c.password, apiKey: c.apiKey, env }),
    });
    const d = await r.json() as { ok: boolean; cst?: string; securityToken?: string; accountId?: string };
    if (d.ok && d.cst && d.securityToken) {
      const sess = { cst: d.cst, securityToken: d.securityToken, accountId: d.accountId ?? '', apiKey: c.apiKey };
      localStorage.setItem(sessKey, JSON.stringify({ ...sess, authenticatedAt: Date.now() }));
      return sess;
    }
  } catch {}
  return null;
}

async function computeSignal(ticker: string, earningsBlackout: boolean): Promise<Omit<StockSignal,'scanning'>> {
  const info     = IG_STOCK_EPICS[ticker];
  const exchange = info?.exchange ?? 'NASDAQ';
  const base = {
    ticker, price: 0, changeHour: 0, rsi: null, macdHist: null, macdCross: 'none' as const,
    sma20: null, direction: 'NEUTRAL' as const, strength: 0, reason: 'No data',
    marketOpen: isMarketOpen(exchange), blackout: isEarningsBlackout(ticker, earningsBlackout),
    lastScanned: new Date().toISOString(),
  };
  try {
    const sym = yahooTicker(ticker);
    const res = await fetch(`/api/chart/history?symbol=${encodeURIComponent(sym)}&resolution=10DH`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { candles?: LWCandle[]; error?: string };
    if (data.error) throw new Error(data.error);
    const candles = data.candles ?? [];
    if (candles.length < 20) throw new Error('Not enough candles');

    const last     = candles[candles.length - 1];
    const prev     = candles[candles.length - 2];
    const price    = Number(last.close);
    const prevClose = Number(prev?.close ?? price);
    const changeHour = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

    const rsiPts = calcRSI(candles, 14);
    const rsi    = rsiPts.length > 0 ? Number(rsiPts[rsiPts.length - 1].value) : null;

    const macdOut = calcMACD(candles, 12, 26, 9);
    const hist    = macdOut.hist;
    const lastH   = hist.length > 0 ? Number(hist[hist.length - 1].value) : 0;
    const prevH   = hist.length > 1 ? Number(hist[hist.length - 2].value) : 0;
    const macdCross: 'bullish'|'bearish'|'none' =
      prevH < 0 && lastH > 0 ? 'bullish' : prevH > 0 && lastH < 0 ? 'bearish' : 'none';

    const smaPts = calcSMA(candles, 20);
    const sma20  = smaPts.length > 0 ? Number(smaPts[smaPts.length - 1].value) : null;

    let bull = 0, bear = 0;
    const reasons: string[] = [];
    if (rsi !== null) {
      if (rsi < 25)      { bull += 40; reasons.push(`RSI ${rsi.toFixed(0)} deeply oversold`); }
      else if (rsi < 35) { bull += 22; reasons.push(`RSI ${rsi.toFixed(0)} oversold`); }
      else if (rsi > 75) { bear += 40; reasons.push(`RSI ${rsi.toFixed(0)} deeply overbought`); }
      else if (rsi > 65) { bear += 22; reasons.push(`RSI ${rsi.toFixed(0)} overbought`); }
    }
    if (macdCross === 'bullish') { bull += 35; reasons.push('MACD bullish cross'); }
    else if (macdCross === 'bearish') { bear += 35; reasons.push('MACD bearish cross'); }
    else if (lastH > 0) bull += 15;
    else if (lastH < 0) bear += 15;
    if (sma20 !== null) { if (price > sma20) bull += 10; else bear += 10; }

    const total     = bull + bear;
    const strength  = total > 0 ? Math.round((Math.max(bull, bear) / total) * 100) : 0;
    const direction: 'BUY'|'SELL'|'NEUTRAL' =
      bull > bear + 20 && strength >= 60 ? 'BUY'  :
      bear > bull + 20 && strength >= 60 ? 'SELL' : 'NEUTRAL';

    return {
      ...base, price, changeHour, rsi, macdHist: lastH, macdCross, sma20, direction, strength,
      reason: reasons.length ? reasons.join(' · ') : 'No strong signal',
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : 'Scan failed' };
  }
}

// ── Context shape ─────────────────────────────────────────────────────────────

export type IGStockBotContextValue = {
  status:     BotStatus;
  env:        'demo' | 'live';
  session:    IGSession | null;
  positions:  IGPosition[];
  signals:    Record<string, StockSignal>;
  logs:       LogEntry[];
  settings:   BotSettings;
  enabled:    Set<string>;
  available:  number | null;
  balance:    number | null;
  connecting: boolean;
  connErr:    string;
  startingBalance: number | null;
  setEnv:      (e: 'demo' | 'live') => void;
  setSettings: (s: BotSettings) => void;
  toggleTicker: (ticker: string) => void;
  start:       () => Promise<void>;
  stop:        () => void;
  pause:       () => void;
  resume:      () => Promise<void>;
  connect:     () => Promise<void>;
  fetchPositions: () => Promise<void>;
  fetchFunds:     () => Promise<void>;
  addLog:      (type: LogEntry['type'], msg: string) => void;
};

const IGStockBotContext = createContext<IGStockBotContextValue | null>(null);

export function useIGStockBot(): IGStockBotContextValue {
  const ctx = useContext(IGStockBotContext);
  if (!ctx) throw new Error('useIGStockBot must be used inside IGStockBotProvider');
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function IGStockBotProvider({ children }: { children: ReactNode }) {
  const [status,     setStatus]     = useState<BotStatus>('stopped');
  const [env,        setEnvState]   = useState<'demo'|'live'>('demo');
  const [session,    setSession]    = useState<IGSession|null>(null);
  const [positions,  setPositions]  = useState<IGPosition[]>([]);
  const [signals,    setSignals]    = useState<Record<string, StockSignal>>({});
  const [logs,       setLogs]       = useState<LogEntry[]>([]);
  const [settings,   setSettings]   = useState<BotSettings>(DEFAULT_SETTINGS);
  const [enabled,    setEnabled]    = useState<Set<string>>(() => new Set(DEFAULT_ENABLED));
  const [available,  setAvailable]  = useState<number | null>(null);
  const [balance,    setBalance]    = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connErr,    setConnErr]    = useState('');
  const [startingBalance, setStartingBalance] = useState<number | null>(null);

  const statusRef          = useRef(status);
  const sessionRef         = useRef(session);
  const settingsRef        = useRef(settings);
  const enabledRef         = useRef(enabled);
  const envRef             = useRef(env);
  const positionsRef       = useRef<IGPosition[]>([]);
  const peakProfitRef      = useRef<Map<string, number>>(new Map());
  const startingBalanceRef = useRef<number | null>(null);
  const availableRef       = useRef<number | null>(null);
  const workerRef          = useRef<Worker | null>(null);
  const wakeLockRef        = useRef<{ release: () => Promise<void> } | null>(null);
  const scanningRef        = useRef(false);
  const lastScanRef        = useRef(0);

  useEffect(() => { statusRef.current   = status;   }, [status]);
  useEffect(() => { sessionRef.current  = session;  }, [session]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { enabledRef.current  = enabled;  }, [enabled]);
  useEffect(() => { envRef.current      = env;      }, [env]);
  useEffect(() => { availableRef.current = available; }, [available]);

  // Persist settings + enabled list
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, enabled: [...enabled] })); } catch {}
  }, [settings, enabled]);

  // Load persisted settings on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as { settings?: BotSettings; enabled?: string[] };
      if (d.settings) setSettings(d.settings);
      if (d.enabled)  setEnabled(new Set(d.enabled));
    } catch {}
  }, []);

  function addLog(type: LogEntry['type'], msg: string) {
    setLogs(p => [{ id: uid(), ts: new Date().toISOString(), type, msg }, ...p.slice(0, 149)]);
  }

  function setEnv(e: 'demo'|'live') {
    setEnvState(e);
    setSession(null);
    setAvailable(null);
    setBalance(null);
    setStartingBalance(null);
    startingBalanceRef.current = null;
  }

  function toggleTicker(ticker: string) {
    setEnabled(p => { const n = new Set(p); n.has(ticker) ? n.delete(ticker) : n.add(ticker); return n; });
  }

  // ── Fetch positions ─────────────────────────────────────────────────────────

  const fetchPositions = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      const r = await fetch('/api/ig/positions', { headers: makeHeaders(sess, envRef.current) });
      const d = await r.json() as { ok: boolean; positions?: IGPosition[] };
      if (d.ok) { const p = d.positions ?? []; setPositions(p); positionsRef.current = p; }
    } catch {}
  }, []);

  // ── Fetch funds ─────────────────────────────────────────────────────────────

  const fetchFunds = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      const r = await fetch('/api/ig/account', { headers: makeHeaders(sess, envRef.current) });
      const d = await r.json() as { ok: boolean; available?: number; balance?: number };
      if (d.ok) {
        const avail = d.available ?? 0;
        setAvailable(avail);
        setBalance(d.balance ?? 0);
        availableRef.current = avail;
        if (startingBalanceRef.current === null) {
          const bal = d.balance ?? 0;
          startingBalanceRef.current = bal;
          setStartingBalance(bal);
        }
      }
    } catch {}
  }, []);

  // ── Trailing stop management ────────────────────────────────────────────────

  const manageTrailingStops = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    const stockPositions = positionsRef.current.filter(p => p.epic.startsWith('UC.D.'));
    if (!stockPositions.length) return;

    for (const pos of stockPositions) {
      if (!pos.stopLevel) continue;
      const isLong   = pos.direction === 'BUY';
      const entry    = pos.level;
      const stopDist = Math.abs(entry - pos.stopLevel);
      const currentPx = isLong ? pos.bid : pos.offer;
      const uplPts    = isLong ? currentPx - entry : entry - currentPx;
      const peak      = Math.max(peakProfitRef.current.get(pos.dealId) ?? 0, uplPts);
      peakProfitRef.current.set(pos.dealId, peak);

      let newStop: number | null = null;
      if (peak >= stopDist && uplPts >= 0) {
        const breakeven  = isLong ? entry + 0.1 : entry - 0.1;
        const currentStop = pos.stopLevel ?? 0;
        const betterStop  = isLong ? breakeven > currentStop : breakeven < currentStop;
        if (betterStop) newStop = Math.round(breakeven * 10) / 10;
      }
      if (peak >= stopDist * 2) {
        const trailStop  = isLong ? entry + peak * 0.60 : entry - peak * 0.60;
        const rounded    = Math.round(trailStop * 10) / 10;
        const currentStop = pos.stopLevel ?? 0;
        const betterStop  = isLong ? rounded > currentStop : rounded < currentStop;
        if (betterStop) newStop = rounded;
      }

      if (newStop !== null) {
        try {
          const r = await fetch('/api/ig/positions/update', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...makeHeaders(sess, envRef.current) },
            body: JSON.stringify({ dealId: pos.dealId, stopLevel: newStop, limitLevel: pos.limitLevel }),
          });
          const d = await r.json() as { ok: boolean };
          if (d.ok) {
            const label = newStop === Math.round((entry + (isLong ? 0.1 : -0.1)) * 10) / 10
              ? 'moved to breakeven' : `trailed to ${newStop.toFixed(2)}`;
            addLog('info', `${pos.instrumentName} stop ${label} (peak: +${peak.toFixed(1)}pts)`);
          }
        } catch { /* non-critical */ }
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }, []);

  // ── Fund cap ────────────────────────────────────────────────────────────────

  function fundCapSize(requestedSize: number): { size: number; blocked: boolean; reason?: string } {
    const avail = availableRef.current;
    const start = startingBalanceRef.current;
    if (avail === null) return { size: requestedSize, blocked: false };
    if (avail < 100)                             return { size: 0, blocked: true, reason: `Available critically low (£${avail.toFixed(0)})` };
    if (start !== null && avail < start * 0.15)  return { size: 0, blocked: true, reason: `Below 15% of starting balance` };
    const pctCap = Math.floor((avail * 0.05) * 10) / 10;
    const capped = Math.max(1, Math.min(requestedSize, pctCap));
    return { size: capped, blocked: false };
  }

  // ── Order placement ─────────────────────────────────────────────────────────

  async function placeOrder(ticker: string, sig: StockSignal, direction: 'BUY'|'SELL'): Promise<boolean> {
    const sess = sessionRef.current;
    const cfg  = settingsRef.current;
    if (!sess || !sig.price) return false;
    const info = IG_STOCK_EPICS[ticker];
    if (!info) return false;

    const atr       = sig.price * 0.02;
    const stopDist  = Math.max(1, Math.round(atr * cfg.stopAtrMult * 10) / 10);
    const limitDist = Math.max(1, Math.round(stopDist * cfg.targetRR * 10) / 10);
    const minSize   = info.minSize ?? 1;
    const rawSize   = Math.max(minSize, Math.round((cfg.riskPerTrade / stopDist) * 10) / 10);

    const { size, blocked, reason } = fundCapSize(rawSize);
    if (blocked) { addLog('warn', `Skipping ${ticker} — ${reason}`); return false; }

    const marginPct = 0.20;
    const estMargin = size * sig.price * marginPct;
    const avail     = availableRef.current ?? Infinity;
    if (estMargin > avail * 0.5) {
      addLog('warn', `Skipping ${ticker} — margin ~£${estMargin.toFixed(0)} > 50% available`);
      return false;
    }

    const price      = sig.price;
    const stopLevel  = direction === 'BUY'  ? price - stopDist  : price + stopDist;
    const limitLevel = direction === 'BUY'  ? price + limitDist : price - limitDist;
    const sizeNote   = size < rawSize ? ` (capped — funds: £${avail.toFixed(0)})` : '';

    try {
      const r = await fetch('/api/ig/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...makeHeaders(sess, envRef.current) },
        body: JSON.stringify({
          epic: info.epic, direction, size,
          stopDistance:   Math.round(stopDist  * 10) / 10,
          profitDistance: Math.round(limitDist * 10) / 10,
          currencyCode:  info.currency,
        }),
      });
      const d = await r.json() as { ok: boolean; dealId?: string; error?: string };
      if (d.ok) {
        addLog(direction === 'BUY' ? 'buy' : 'sell',
          `${direction} ${info.name} £${size}/pt @ ${price.toFixed(2)} · stop ${stopLevel.toFixed(2)} · target ${limitLevel.toFixed(2)} · margin ~£${estMargin.toFixed(0)}${sizeNote}`);
        void fetchPositions();
        void fetchFunds();
        return true;
      }
      addLog('error', `Order rejected: ${d.error ?? 'unknown'}`);
    } catch (e) {
      addLog('error', `Order error: ${e instanceof Error ? e.message : String(e)}`);
    }
    return false;
  }

  // ── Scan loop ───────────────────────────────────────────────────────────────

  const runScan = useCallback(async () => {
    if (statusRef.current !== 'running') return;
    if (scanningRef.current) return;
    scanningRef.current = true;
    const cfg     = settingsRef.current;
    const sess    = sessionRef.current;
    const tickers = [...enabledRef.current];

    if (sess) await Promise.all([fetchFunds(), fetchPositions()]);

    const avail = availableRef.current;
    if (avail !== null && avail < 100) {
      addLog('warn', `Scan skipped — available funds £${avail.toFixed(0)} too low`);
      scanningRef.current = false;
      return;
    }

    addLog('info', `Scanning ${tickers.length} stocks… (available: ${avail !== null ? `£${avail.toFixed(0)}` : 'unknown'})`);

    setSignals(p => {
      const next = { ...p };
      for (const t of tickers) next[t] = { ...(next[t] ?? { ticker: t } as StockSignal), scanning: true };
      return next;
    });

    const heldEpics = new Set(positionsRef.current.map(p => p.epic));
    let newTrades = 0;

    for (const ticker of tickers) {
      if (statusRef.current !== 'running') break;
      const sig  = await computeSignal(ticker, cfg.earningsBlackout);
      const full: StockSignal = { ...sig, scanning: false };
      setSignals(p => ({ ...p, [ticker]: full }));

      if (!sess) continue;
      if (full.blackout)  { addLog('warn', `${ticker} — earnings blackout`); continue; }
      if (!full.marketOpen) continue;
      if (full.direction === 'NEUTRAL') continue;
      if (full.strength < cfg.minStrength) continue;
      if (newTrades + positionsRef.current.length >= cfg.maxPositions) {
        addLog('warn', `Max positions (${cfg.maxPositions}) reached`);
        break;
      }
      const info = IG_STOCK_EPICS[ticker];
      if (info && heldEpics.has(info.epic)) continue;
      const placed = await placeOrder(ticker, full, full.direction as 'BUY'|'SELL');
      if (placed) { newTrades++; heldEpics.add(info?.epic ?? ''); }
      await new Promise(r => setTimeout(r, 300));
    }

    addLog('info', `Scan complete — ${newTrades} new order(s) placed`);
    lastScanRef.current = Date.now();
    scanningRef.current = false;
  }, [fetchFunds, fetchPositions]);

  // ── Wake lock helpers ───────────────────────────────────────────────────────

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLockRef.current = await (navigator as unknown as { wakeLock: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock.request('screen');
    } catch { /* non-critical */ }
  }
  function releaseWakeLock() {
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  }

  // ── Status controls ─────────────────────────────────────────────────────────

  async function connect() {
    setConnecting(true);
    setConnErr('');
    const sess = await connectIG(env);
    if (sess) {
      setSession(sess);
      sessionRef.current = sess;
      startingBalanceRef.current = null;
      setStartingBalance(null);
      addLog('info', `Connected to IG ${env.toUpperCase()}`);
      try {
        const r = await fetch('/api/ig/account', { headers: makeHeaders(sess, env) });
        const d = await r.json() as { ok: boolean; available?: number; balance?: number };
        if (d.ok) {
          const avail = d.available ?? 0;
          const bal   = d.balance ?? 0;
          setAvailable(avail);
          setBalance(bal);
          setStartingBalance(bal);
          startingBalanceRef.current = bal;
          availableRef.current = avail;
          addLog('info', `Balance: £${bal.toFixed(2)} · Available: £${avail.toFixed(2)}`);
        }
      } catch {}
    } else {
      setConnErr(`No ${env} credentials — add them in Settings → Accounts.`);
    }
    setConnecting(false);
  }

  async function start() {
    if (!sessionRef.current) await connect();
    setStatus('running');
    statusRef.current = 'running';
    const cfg = settingsRef.current;
    addLog('info', `Bot started on ${envRef.current.toUpperCase()} · risk £${cfg.riskPerTrade}/trade · max ${cfg.maxPositions} positions`);
    workerRef.current?.postMessage({ type: 'start', intervalMs: cfg.scanIntervalMins * 60_000 });
    await acquireWakeLock();
    try { localStorage.setItem('ig_stock_bot_status', 'running'); } catch {}
    setTimeout(() => void runScan(), 500);
  }

  async function resume() {
    setStatus('running');
    statusRef.current = 'running';
    workerRef.current?.postMessage({ type: 'start', intervalMs: settingsRef.current.scanIntervalMins * 60_000 });
    await acquireWakeLock();
    try { localStorage.setItem('ig_stock_bot_status', 'running'); } catch {}
    setTimeout(() => void runScan(), 500);
    addLog('info', 'Bot resumed');
  }

  function pause() {
    setStatus('paused');
    workerRef.current?.postMessage({ type: 'stop' });
    releaseWakeLock();
    try { localStorage.setItem('ig_stock_bot_status', 'paused'); } catch {}
    addLog('info', 'Bot paused — existing positions unaffected');
  }

  function stop() {
    setStatus('stopped');
    workerRef.current?.postMessage({ type: 'stop' });
    releaseWakeLock();
    setSession(null);
    peakProfitRef.current.clear();
    try { localStorage.setItem('ig_stock_bot_status', 'stopped'); } catch {}
    addLog('info', 'Bot stopped');
  }

  // ── Web Worker (tab-throttle-resistant timer) ───────────────────────────────

  useEffect(() => {
    const code = `
      var timer = null;
      self.onmessage = function(e) {
        if (e.data.type === 'start') {
          clearInterval(timer);
          timer = setInterval(function() { self.postMessage('tick'); }, e.data.intervalMs);
        } else if (e.data.type === 'stop') {
          clearInterval(timer);
          timer = null;
        }
      };
    `;
    const blob = new Blob([code], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    const w    = new Worker(url);
    w.onmessage = () => {
      if (statusRef.current === 'running' && !scanningRef.current) void runScan();
    };
    workerRef.current = w;
    return () => { w.terminate(); URL.revokeObjectURL(url); };
  }, [runScan]);

  // Update worker interval when scanIntervalMins changes while running
  useEffect(() => {
    if (status === 'running') {
      workerRef.current?.postMessage({ type: 'start', intervalMs: settings.scanIntervalMins * 60_000 });
    }
  }, [settings.scanIntervalMins, status]);

  // Re-acquire wake lock + catch up on overdue scan when tab becomes visible
  useEffect(() => {
    async function onVisible() {
      if (document.visibilityState !== 'visible') return;
      if (statusRef.current === 'running') {
        await acquireWakeLock();
        const intervalMs = settingsRef.current.scanIntervalMins * 60_000;
        if (!scanningRef.current && Date.now() - lastScanRef.current > intervalMs) {
          addLog('info', 'Tab re-focused — running overdue scan');
          void runScan();
        }
      }
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [runScan]);

  // Refresh positions + funds every 60s when running or paused, manage trailing stops
  useEffect(() => {
    if (status === 'stopped') return;
    const iv = setInterval(async () => {
      await fetchPositions();
      void fetchFunds();
      if (status === 'running') void manageTrailingStops();
    }, 60_000);
    return () => clearInterval(iv);
  }, [status, fetchPositions, fetchFunds, manageTrailingStops]);

  // Cleanup on app unload only
  useEffect(() => () => {
    workerRef.current?.postMessage({ type: 'stop' });
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  }, []);

  // ── Context value ───────────────────────────────────────────────────────────

  const value: IGStockBotContextValue = {
    status, env, session, positions, signals, logs, settings, enabled,
    available, balance, connecting, connErr, startingBalance,
    setEnv, setSettings, toggleTicker,
    start, stop, pause, resume, connect,
    fetchPositions, fetchFunds, addLog,
  };

  return (
    <IGStockBotContext.Provider value={value}>
      {children}
    </IGStockBotContext.Provider>
  );
}

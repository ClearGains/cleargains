'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play, Square, Pause, Settings, AlertCircle, TrendingUp, TrendingDown,
  Minus, Zap, AlertTriangle, ChevronDown, ChevronUp, RefreshCw, ToggleLeft, ToggleRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import { IG_STOCK_EPICS, exchangeFlag } from '@/lib/ig-stock-epics';
import { calcRSI, calcMACD, calcSMA, type LWCandle } from '@/lib/chartIndicators';

// ── Types ─────────────────────────────────────────────────────────────────────

type IGSession = { cst: string; securityToken: string; accountId: string; apiKey: string };

type IGPosition = {
  dealId: string; direction: string; size: number; level: number;
  upl: number; currency: string; epic: string; instrumentName: string;
  bid: number; offer: number; stopLevel?: number; limitLevel?: number;
};

type StockSignal = {
  ticker:      string;
  price:       number;
  changeHour:  number;
  rsi:         number | null;
  macdHist:    number | null;
  macdCross:   'bullish' | 'bearish' | 'none';
  sma20:       number | null;
  direction:   'BUY' | 'SELL' | 'NEUTRAL';
  strength:    number;   // 0–100
  reason:      string;
  marketOpen:  boolean;
  blackout:    boolean;
  scanning:    boolean;
  lastScanned: string;
  error?:      string;
};

type BotSettings = {
  riskPerTrade:     number;
  maxPositions:     number;
  stopAtrMult:      number;   // stop = N × ATR below/above entry
  targetRR:         number;   // target = stopDist × R:R
  minStrength:      number;   // 0–100, min signal strength to trade
  scanIntervalMins: number;
  earningsBlackout: boolean;
};

type LogEntry = { id: string; ts: string; type: 'info'|'buy'|'sell'|'close'|'error'|'warn'; msg: string };

// ── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY     = 'ig_stock_auto_trader_v1';
const DEFAULT_ENABLED = ['NVDA', 'AAPL', 'TSLA', 'MSFT', 'BARC', 'LLOY'];

const DEFAULT_SETTINGS: BotSettings = {
  riskPerTrade:     50,
  maxPositions:     3,
  stopAtrMult:      2.0,
  targetRR:         2.5,
  minStrength:      65,
  scanIntervalMins: 15,
  earningsBlackout: true,
};

// Earnings blackout — update each quarter. Skip trading 3 days before & on date.
const EARNINGS_DATES: Record<string, string> = {
  'NVDA':  '2026-08-27',
  'AAPL':  '2026-07-31',
  'MSFT':  '2026-07-29',
  'GOOGL': '2026-07-28',
  'AMZN':  '2026-07-30',
  'META':  '2026-07-29',
  'TSLA':  '2026-07-22',
  'AMD':   '2026-07-28',
  'NFLX':  '2026-07-15',
};

// LSE tickers need .L suffix for Yahoo Finance
const LSE_TICKERS = new Set(['VOD', 'BP', 'SHEL', 'BARC', 'LLOY', 'AZN', 'GSK', 'HSBA']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9); }

function yahooTicker(ticker: string): string {
  return LSE_TICKERS.has(ticker) ? `${ticker}.L` : ticker;
}

function isEarningsBlackout(ticker: string, enabled: boolean): boolean {
  if (!enabled) return false;
  const d = EARNINGS_DATES[ticker];
  if (!d) return false;
  const daysUntil = (new Date(d).getTime() - Date.now()) / 86_400_000;
  return daysUntil >= 0 && daysUntil <= 3;
}

function isMarketOpen(exchange: string): boolean {
  const now   = new Date();
  const day   = now.getUTCDay();
  const mins  = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 0 || day === 6) return false;
  if (exchange === 'LSE')    return mins >= 7 * 60 && mins < 15 * 60 + 30;  // 08:00–16:30 London ≈ 07–15:30 UTC
  return mins >= 13 * 60 + 30 && mins < 20 * 60;  // NYSE/NASDAQ 09:30–16:00 NY ≈ 13:30–20:00 UTC
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

function makeHeaders(s: IGSession, env: 'demo'|'live') {
  return { 'x-ig-cst': s.cst, 'x-ig-security-token': s.securityToken, 'x-ig-api-key': s.apiKey, 'x-ig-env': env };
}

async function connectIG(env: 'demo'|'live'): Promise<IGSession|null> {
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

// ── Signal engine ─────────────────────────────────────────────────────────────

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

    const last   = candles[candles.length - 1];
    const prev   = candles[candles.length - 2];
    const price  = Number(last.close);
    const prevClose = Number(prev?.close ?? price);
    const changeHour = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

    const rsiPts  = calcRSI(candles, 14);
    const rsi     = rsiPts.length > 0 ? Number(rsiPts[rsiPts.length - 1].value) : null;

    const macdOut = calcMACD(candles, 12, 26, 9);
    const hist    = macdOut.hist;
    const lastH   = hist.length > 0 ? Number(hist[hist.length - 1].value) : 0;
    const prevH   = hist.length > 1 ? Number(hist[hist.length - 2].value) : 0;
    const macdCross: 'bullish'|'bearish'|'none' =
      prevH < 0 && lastH > 0 ? 'bullish' : prevH > 0 && lastH < 0 ? 'bearish' : 'none';

    const smaPts = calcSMA(candles, 20);
    const sma20  = smaPts.length > 0 ? Number(smaPts[smaPts.length - 1].value) : null;

    // Score
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

    if (sma20 !== null) {
      if (price > sma20) bull += 10;
      else               bear += 10;
    }

    const total    = bull + bear;
    const strength = total > 0 ? Math.round((Math.max(bull, bear) / total) * 100) : 0;
    const direction: 'BUY'|'SELL'|'NEUTRAL' =
      bull > bear + 20 && strength >= 60 ? 'BUY'  :
      bear > bull + 20 && strength >= 60 ? 'SELL' : 'NEUTRAL';

    return {
      ...base, price, changeHour, rsi, macdHist: lastH, macdCross, sma20,
      direction, strength,
      reason: reasons.length ? reasons.join(' · ') : 'No strong signal',
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : 'Scan failed' };
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SignalBadge({ dir }: { dir: string }) {
  return (
    <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded',
      dir === 'BUY'  ? 'bg-emerald-500/20 text-emerald-400' :
      dir === 'SELL' ? 'bg-red-500/20 text-red-400'         :
                       'bg-gray-700/60 text-gray-500'
    )}>{dir}</span>
  );
}

function StrengthBar({ strength, dir }: { strength: number; dir: string }) {
  return (
    <div className="h-1 bg-gray-800 rounded-full overflow-hidden w-14 flex-shrink-0">
      <div className={clsx('h-full rounded-full',
        dir === 'BUY' ? 'bg-emerald-500' : dir === 'SELL' ? 'bg-red-500' : 'bg-gray-600'
      )} style={{ width: `${strength}%` }} />
    </div>
  );
}

function LogBadge({ type }: { type: LogEntry['type'] }) {
  const cls =
    type === 'buy'   ? 'text-emerald-400 bg-emerald-500/10' :
    type === 'sell'  ? 'text-red-400     bg-red-500/10'     :
    type === 'close' ? 'text-blue-400    bg-blue-500/10'    :
    type === 'error' ? 'text-red-400     bg-red-500/10'     :
    type === 'warn'  ? 'text-amber-400   bg-amber-500/10'   :
                       'text-gray-400    bg-gray-700/40';
  return <span className={clsx('text-[9px] font-bold px-1 py-0.5 rounded uppercase', cls)}>{type}</span>;
}

// ── Settings panel ────────────────────────────────────────────────────────────

function SettingsPanel({ settings, onChange }: { settings: BotSettings; onChange: (s: BotSettings) => void }) {
  function field(label: string, key: keyof BotSettings, opts: { min?: number; max?: number; step?: number; suffix?: string }) {
    const val = settings[key];
    if (typeof val === 'boolean') {
      return (
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">{label}</span>
          <button onClick={() => onChange({ ...settings, [key]: !val })} className="text-gray-400 hover:text-white">
            {val ? <ToggleRight className="h-5 w-5 text-emerald-400" /> : <ToggleLeft className="h-5 w-5" />}
          </button>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-gray-400 shrink-0">{label}</span>
        <div className="flex items-center gap-1">
          <input
            type="number" min={opts.min} max={opts.max} step={opts.step ?? 1}
            value={val as number}
            onChange={e => onChange({ ...settings, [key]: Number(e.target.value) })}
            className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white font-mono text-right focus:outline-none focus:border-orange-500"
          />
          {opts.suffix && <span className="text-xs text-gray-500">{opts.suffix}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 space-y-3">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Bot Settings</div>
      {field('Risk per trade',      'riskPerTrade',     { min: 10,  max: 1000, step: 10,  suffix: '£' })}
      {field('Max open positions',  'maxPositions',     { min: 1,   max: 10,   step: 1  })}
      {field('Stop loss (ATR ×)',   'stopAtrMult',      { min: 0.5, max: 5,    step: 0.5 })}
      {field('Target R:R',          'targetRR',         { min: 1,   max: 5,    step: 0.5, suffix: ':1' })}
      {field('Min signal strength', 'minStrength',      { min: 50,  max: 95,   step: 5,   suffix: '%' })}
      {field('Scan every',          'scanIntervalMins', { min: 5,   max: 60,   step: 5,   suffix: 'min' })}
      {field('Earnings blackout',   'earningsBlackout', {})}
      <p className="text-[10px] text-gray-600 pt-1">Earnings dates are hardcoded — update quarterly in IGStockAutoTrader.tsx.</p>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function IGStockAutoTrader() {
  const [status,     setStatus]     = useState<'stopped'|'running'|'paused'>('stopped');
  const [env,        setEnv]        = useState<'demo'|'live'>('demo');
  const [session,    setSession]    = useState<IGSession|null>(null);
  const [positions,  setPositions]  = useState<IGPosition[]>([]);
  const [signals,    setSignals]    = useState<Record<string, StockSignal>>({});
  const [logs,       setLogs]       = useState<LogEntry[]>([]);
  const [settings,   setSettings]   = useState<BotSettings>(DEFAULT_SETTINGS);
  const [enabled,    setEnabled]    = useState<Set<string>>(() => new Set(DEFAULT_ENABLED));
  const [showSettings, setShowSettings] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connErr,    setConnErr]    = useState('');
  const [available,  setAvailable]  = useState<number | null>(null);
  const [balance,    setBalance]    = useState<number | null>(null);

  const startingBalanceRef = useRef<number | null>(null);
  const availableRef       = useRef<number | null>(null);
  const positionsRef       = useRef<IGPosition[]>([]);
  const peakProfitRef      = useRef<Map<string, number>>(new Map()); // dealId → peak UPL

  const statusRef   = useRef(status);
  const sessionRef  = useRef(session);
  const settingsRef = useRef(settings);
  const enabledRef  = useRef(enabled);
  const envRef      = useRef(env);
  const scanTimer   = useRef<ReturnType<typeof setTimeout>|null>(null);

  useEffect(() => { statusRef.current    = status;    }, [status]);
  useEffect(() => { sessionRef.current   = session;   }, [session]);
  useEffect(() => { settingsRef.current  = settings;  }, [settings]);
  useEffect(() => { enabledRef.current   = enabled;   }, [enabled]);
  useEffect(() => { envRef.current       = env;       }, [env]);
  useEffect(() => { availableRef.current = available; }, [available]);

  // Persist settings + enabled list
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

  function addLog(type: LogEntry['type'], msg: string) {
    setLogs(p => [{ id: uid(), ts: new Date().toISOString(), type, msg }, ...p.slice(0, 149)]);
  }

  // ── Connect / disconnect ──────────────────────────────────────────────────

  async function connect() {
    setConnecting(true);
    setConnErr('');
    const sess = await connectIG(env);
    if (sess) {
      setSession(sess);
      sessionRef.current = sess;
      startingBalanceRef.current = null; // reset so next fetchFunds records new starting balance
      addLog('info', `Connected to IG ${env.toUpperCase()}`);
      // Fetch balance immediately after connecting
      try {
        const r = await fetch('/api/ig/account', { headers: makeHeaders(sess, env) });
        const d = await r.json() as { ok: boolean; available?: number; balance?: number };
        if (d.ok) {
          const avail = d.available ?? 0;
          setAvailable(avail);
          setBalance(d.balance ?? 0);
          startingBalanceRef.current = d.balance ?? 0;
          availableRef.current = avail;
          addLog('info', `Balance: £${(d.balance ?? 0).toFixed(2)} · Available: £${avail.toFixed(2)}`);
        }
      } catch {}
    } else {
      setConnErr(`No ${env} credentials — add them in Settings → Accounts.`);
    }
    setConnecting(false);
  }

  useEffect(() => { setSession(null); setAvailable(null); setBalance(null); startingBalanceRef.current = null; }, [env]);

  // ── Fetch open positions ──────────────────────────────────────────────────

  const fetchPositions = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      const r = await fetch('/api/ig/positions', { headers: makeHeaders(sess, envRef.current) });
      const d = await r.json() as { ok: boolean; positions?: IGPosition[] };
      if (d.ok) { const p = d.positions ?? []; setPositions(p); positionsRef.current = p; }
    } catch {}
  }, []);

  // ── Fetch account funds ───────────────────────────────────────────────────

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
        // Record starting balance once per session (first fetch after connect)
        if (startingBalanceRef.current === null) startingBalanceRef.current = d.balance ?? 0;
      }
    } catch {}
  }, []);

  // ── Trailing stop management ──────────────────────────────────────────────

  const manageTrailingStops = useCallback(async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    const currentPositions = positionsRef.current.filter(p => p.epic.startsWith('CS.D.'));
    if (!currentPositions.length) return;

    for (const pos of currentPositions) {
      if (!pos.stopLevel) continue;
      const isLong     = pos.direction === 'BUY';
      const entry      = pos.level;
      const stopDist   = Math.abs(entry - pos.stopLevel);
      const currentPx  = isLong ? pos.bid : pos.offer;
      const uplPts     = isLong ? currentPx - entry : entry - currentPx;
      const peak       = Math.max(peakProfitRef.current.get(pos.dealId) ?? 0, uplPts);
      peakProfitRef.current.set(pos.dealId, peak);

      let newStop: number | null = null;

      // Breakeven: once price moves 1× stop distance in profit, move stop to entry
      if (peak >= stopDist && uplPts >= 0) {
        const breakeven = isLong ? entry + 0.1 : entry - 0.1;
        const currentStop = pos.stopLevel ?? 0;
        const betterStop  = isLong ? breakeven > currentStop : breakeven < currentStop;
        if (betterStop) newStop = Math.round(breakeven * 10) / 10;
      }

      // Trail: once peak >= 2× stop distance, trail stop at 60% of peak
      if (peak >= stopDist * 2) {
        const trailStop = isLong
          ? entry + peak * 0.60
          : entry - peak * 0.60;
        const rounded = Math.round(trailStop * 10) / 10;
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
          const d = await r.json() as { ok: boolean; error?: string };
          if (d.ok) {
            const label = newStop === Math.round((entry + (isLong ? 0.1 : -0.1)) * 10) / 10
              ? 'moved to breakeven'
              : `trailed to ${newStop.toFixed(2)}`;
            addLog('info', `${pos.instrumentName} stop ${label} (peak: +${peak.toFixed(1)}pts)`);
          }
        } catch { /* non-critical — next cycle will retry */ }
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }, []);

  // Cap size to what funds can support — mirrors calcDynamicSize in IGStrategyTrader
  function fundCapSize(requestedSize: number): { size: number; blocked: boolean; reason?: string } {
    const avail   = availableRef.current;
    const start   = startingBalanceRef.current;
    if (avail === null) return { size: requestedSize, blocked: false }; // unknown — allow
    if (avail < 100)                              return { size: 0, blocked: true, reason: `Available funds critically low (£${avail.toFixed(0)})` };
    if (start !== null && avail < start * 0.15)  return { size: 0, blocked: true, reason: `Available below 15% of starting balance (£${avail.toFixed(0)} / £${start.toFixed(0)})` };
    const pctCap  = Math.floor((avail * 0.05) * 10) / 10; // cap at 5% of available per trade
    const capped  = Math.max(0.1, Math.min(requestedSize, pctCap));
    return { size: capped, blocked: false };
  }

  // ── Order placement ───────────────────────────────────────────────────────

  async function placeOrder(
    ticker: string,
    sig: StockSignal,
    direction: 'BUY'|'SELL',
  ): Promise<boolean> {
    const sess = sessionRef.current;
    const cfg  = settingsRef.current;
    if (!sess || !sig.price) return false;

    const info = IG_STOCK_EPICS[ticker];
    if (!info) return false;

    const atr       = sig.price * 0.02; // ~2% of price as ATR fallback for sizing
    const stopDist  = Math.max(1, Math.round(atr * cfg.stopAtrMult * 10) / 10);
    const limitDist = Math.max(1, Math.round(stopDist * cfg.targetRR * 10) / 10);
    const rawSize   = Math.max(0.1, Math.round((cfg.riskPerTrade / stopDist) * 10) / 10);

    // Apply fund cap before placing
    const { size, blocked, reason } = fundCapSize(rawSize);
    if (blocked) {
      addLog('warn', `Skipping ${ticker} — ${reason}`);
      return false;
    }

    // Estimate margin and check it fits within available funds
    const marginPct  = info.exchange === 'LSE' ? 0.20 : 0.20; // 20% for shares on IG
    const estMargin  = size * sig.price * marginPct;
    const avail      = availableRef.current ?? Infinity;
    if (estMargin > avail * 0.5) {
      addLog('warn', `Skipping ${ticker} — estimated margin £${estMargin.toFixed(0)} is >50% of available £${avail.toFixed(0)}`);
      return false;
    }

    const price      = sig.price;
    const stopLevel  = direction === 'BUY'  ? price - stopDist  : price + stopDist;
    const limitLevel = direction === 'BUY'  ? price + limitDist : price - limitDist;

    const sizeNote = size < rawSize ? ` (capped from £${rawSize.toFixed(1)}/pt — funds: £${avail.toFixed(0)})` : '';

    try {
      const r = await fetch('/api/ig/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...makeHeaders(sess, envRef.current) },
        body: JSON.stringify({
          epic: info.epic, direction, size,
          stopLevel:  Math.round(stopLevel  * 10) / 10,
          limitLevel: Math.round(limitLevel * 10) / 10,
          currency: info.currency,
        }),
      });
      const d = await r.json() as { ok: boolean; dealId?: string; error?: string };
      if (d.ok) {
        addLog(direction === 'BUY' ? 'buy' : 'sell',
          `${direction} ${info.name} £${size}/pt @ ${price.toFixed(2)} · stop ${stopLevel.toFixed(2)} · target ${limitLevel.toFixed(2)} · margin ~£${estMargin.toFixed(0)}${sizeNote}`);
        void fetchPositions();
        void fetchFunds(); // refresh balance after order
        return true;
      } else {
        addLog('error', `Order rejected: ${d.error ?? 'unknown'}`);
      }
    } catch (e) {
      addLog('error', `Order error: ${e instanceof Error ? e.message : String(e)}`);
    }
    return false;
  }

  // ── Scan loop ─────────────────────────────────────────────────────────────

  const runScan = useCallback(async () => {
    if (statusRef.current !== 'running') return;
    const cfg     = settingsRef.current;
    const sess    = sessionRef.current;
    const tickers = [...enabledRef.current];

    // Refresh funds + positions before each scan so sizing is always current
    if (sess) {
      await Promise.all([fetchFunds(), fetchPositions()]);
    }

    const avail = availableRef.current;
    if (avail !== null && avail < 100) {
      addLog('warn', `Scan skipped — available funds £${avail.toFixed(0)} too low to trade`);
      if (statusRef.current === 'running') {
        scanTimer.current = setTimeout(() => void runScan(), settingsRef.current.scanIntervalMins * 60_000);
      }
      return;
    }

    addLog('info', `Scanning ${tickers.length} stocks… (available: ${avail !== null ? `£${avail.toFixed(0)}` : 'unknown'})`);

    // Mark all as scanning
    setSignals(p => {
      const next = { ...p };
      for (const t of tickers) next[t] = { ...(next[t] ?? { ticker: t } as StockSignal), scanning: true };
      return next;
    });

    const heldEpics = new Set(positionsRef.current.map(p => p.epic));

    let newTrades = 0;

    for (const ticker of tickers) {
      if (statusRef.current !== 'running') break;

      const sig = await computeSignal(ticker, cfg.earningsBlackout);
      const full: StockSignal = { ...sig, scanning: false };
      setSignals(p => ({ ...p, [ticker]: full }));

      if (!sess) continue;
      if (full.blackout)                                    { addLog('warn',  `${ticker} — earnings blackout, skipping`); continue; }
      if (!full.marketOpen)                                 continue;
      if (full.direction === 'NEUTRAL')                     continue;
      if (full.strength < cfg.minStrength)                  continue;
      if (newTrades + positions.length >= cfg.maxPositions) { addLog('warn', `Max positions (${cfg.maxPositions}) reached`); break; }

      const info = IG_STOCK_EPICS[ticker];
      if (info && heldEpics.has(info.epic))                 continue; // already in this stock

      const placed = await placeOrder(ticker, full, full.direction as 'BUY'|'SELL');
      if (placed) {
        newTrades++;
        heldEpics.add(info?.epic ?? '');
      }

      await new Promise(r => setTimeout(r, 300)); // throttle
    }

    addLog('info', `Scan complete — ${newTrades} new order(s) placed`);

    // Schedule next scan
    if (statusRef.current === 'running') {
      scanTimer.current = setTimeout(() => void runScan(), cfg.scanIntervalMins * 60_000);
    }
  }, [fetchPositions, positions]);

  // ── Status controls ───────────────────────────────────────────────────────

  async function start() {
    if (!session) { await connect(); }
    setStatus('running');
    addLog('info', `Bot started on ${env.toUpperCase()} · risk £${settings.riskPerTrade}/trade · max ${settings.maxPositions} positions`);
    scanTimer.current = setTimeout(() => void runScan(), 500);
  }

  function pause() {
    setStatus('paused');
    if (scanTimer.current) clearTimeout(scanTimer.current);
    addLog('info', 'Bot paused — existing positions unaffected');
  }

  function stop() {
    setStatus('stopped');
    if (scanTimer.current) clearTimeout(scanTimer.current);
    setSession(null);
    peakProfitRef.current.clear();
    addLog('info', 'Bot stopped');
  }

  useEffect(() => {
    if (status === 'running' && !scanTimer.current) {
      scanTimer.current = setTimeout(() => void runScan(), 500);
    }
  }, [status, runScan]);

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

  // Cleanup on unmount
  useEffect(() => () => { if (scanTimer.current) clearTimeout(scanTimer.current); }, []);

  // ── Derived state ─────────────────────────────────────────────────────────

  const allTickers   = Object.keys(IG_STOCK_EPICS);
  const stockPositions = positions.filter(p => p.epic.startsWith('CS.D.'));
  const totalUPL       = stockPositions.reduce((s, p) => s + p.upl, 0);

  // ── Render ────────────────────────────────────────────────────────────────

  const statusColor =
    status === 'running' ? 'text-emerald-400' :
    status === 'paused'  ? 'text-amber-400'   : 'text-gray-500';

  return (
    <div className="space-y-4">

      {/* ── Header bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Status indicator */}
          <div className="flex items-center gap-2">
            <div className={clsx('h-2 w-2 rounded-full', status === 'running' ? 'bg-emerald-400 animate-pulse' : status === 'paused' ? 'bg-amber-400' : 'bg-gray-600')} />
            <span className={clsx('text-xs font-semibold capitalize', statusColor)}>{status}</span>
          </div>

          {/* Environment toggle */}
          {status === 'stopped' && (
            <div className="flex bg-gray-800 rounded-lg p-0.5 text-xs">
              {(['demo', 'live'] as const).map(e => (
                <button key={e} onClick={() => setEnv(e)}
                  className={clsx('px-3 py-1 rounded-md font-semibold capitalize transition-all',
                    env === e ? (e === 'live' ? 'bg-orange-600 text-white' : 'bg-emerald-700 text-white') : 'text-gray-400 hover:text-white'
                  )}>{e}</button>
              ))}
            </div>
          )}
          {status !== 'stopped' && (
            <span className={clsx('text-xs font-semibold px-2 py-0.5 rounded border capitalize',
              env === 'live' ? 'border-orange-600/40 text-orange-400' : 'border-emerald-700/40 text-emerald-400'
            )}>{env}</span>
          )}

          {/* Session state */}
          {session
            ? <span className="text-xs text-emerald-400">● Connected</span>
            : <span className="text-xs text-gray-500">○ Not connected</span>
          }
          {connErr && <span className="text-xs text-red-400">{connErr}</span>}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2">
          <button onClick={() => setShowSettings(v => !v)}
            className="p-2 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 transition-all">
            <Settings className="h-4 w-4" />
          </button>

          {status === 'stopped' && (
            <button onClick={start} disabled={connecting}
              className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm font-semibold text-white transition-all">
              <Play className="h-3.5 w-3.5" /> Start
            </button>
          )}
          {status === 'running' && (
            <>
              <button onClick={pause}
                className="flex items-center gap-1.5 px-3 py-2 bg-amber-600 hover:bg-amber-500 rounded-lg text-sm font-semibold text-white transition-all">
                <Pause className="h-3.5 w-3.5" /> Pause
              </button>
              <button onClick={stop}
                className="flex items-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-semibold text-white transition-all">
                <Square className="h-3.5 w-3.5" /> Stop
              </button>
            </>
          )}
          {status === 'paused' && (
            <>
              <button onClick={() => { setStatus('running'); scanTimer.current = setTimeout(() => void runScan(), 500); }}
                className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-semibold text-white transition-all">
                <Play className="h-3.5 w-3.5" /> Resume
              </button>
              <button onClick={stop}
                className="flex items-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-semibold text-white transition-all">
                <Square className="h-3.5 w-3.5" /> Stop
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Settings panel ─────────────────────────────────────────────────── */}
      {showSettings && (
        <SettingsPanel settings={settings} onChange={setSettings} />
      )}

      {/* ── Stats row ──────────────────────────────────────────────────────── */}
      {session && (
        <div className="flex flex-wrap gap-4 items-center text-sm">
          {balance !== null && (
            <div><span className="text-gray-500 text-xs">Balance </span><span className="font-semibold text-white">£{balance.toFixed(2)}</span></div>
          )}
          {available !== null && (
            <div>
              <span className="text-gray-500 text-xs">Available </span>
              <span className={clsx('font-semibold',
                available < 100 ? 'text-red-400' : available < 500 ? 'text-amber-400' : 'text-emerald-400'
              )}>£{available.toFixed(2)}</span>
            </div>
          )}
          {startingBalanceRef.current !== null && balance !== null && (
            <div>
              <span className="text-gray-500 text-xs">P&L </span>
              <span className={clsx('font-semibold', balance >= startingBalanceRef.current ? 'text-emerald-400' : 'text-red-400')}>
                {balance >= startingBalanceRef.current ? '+' : ''}£{(balance - startingBalanceRef.current).toFixed(2)}
              </span>
            </div>
          )}
          {stockPositions.length > 0 && (
            <>
              <div><span className="text-gray-500 text-xs">Open </span><span className="font-semibold text-white">{stockPositions.length}</span></div>
              <div>
                <span className="text-gray-500 text-xs">UPL </span>
                <span className={clsx('font-semibold', totalUPL >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                  {totalUPL >= 0 ? '+' : ''}£{totalUPL.toFixed(2)}
                </span>
              </div>
            </>
          )}
          {available !== null && available < 100 && (
            <span className="text-xs text-red-400 flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" /> Funds too low — bot will not trade
            </span>
          )}
          <button onClick={() => { void fetchPositions(); void fetchFunds(); }} className="text-gray-500 hover:text-white ml-auto">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Stock watchlist grid ────────────────────────────────────────────── */}
      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Watchlist — toggle to enable/disable
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-2">
          {allTickers.map(ticker => {
            const info  = IG_STOCK_EPICS[ticker];
            const sig   = signals[ticker];
            const on    = enabled.has(ticker);
            const pos   = stockPositions.find(p => p.epic === info.epic);
            return (
              <button key={ticker}
                onClick={() => setEnabled(p => { const n = new Set(p); n.has(ticker) ? n.delete(ticker) : n.add(ticker); return n; })}
                className={clsx(
                  'relative text-left p-3 rounded-xl border transition-all',
                  on ? 'border-gray-700 bg-gray-900 hover:border-gray-600' : 'border-gray-800 bg-gray-900/30 opacity-50'
                )}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px]">{exchangeFlag(info.exchange)}</span>
                  {sig?.scanning
                    ? <Zap className="h-3 w-3 text-amber-400 animate-pulse" />
                    : sig?.direction === 'BUY'  ? <TrendingUp  className="h-3 w-3 text-emerald-400" />
                    : sig?.direction === 'SELL' ? <TrendingDown className="h-3 w-3 text-red-400"     />
                    : <Minus className="h-3 w-3 text-gray-600" />
                  }
                </div>
                <div className="text-xs font-bold text-white">{ticker}</div>
                <div className="text-[10px] text-gray-500 truncate">{info.name}</div>

                {sig && !sig.scanning && (
                  <div className="mt-1.5 space-y-1">
                    {sig.price > 0 && (
                      <div className="text-[10px] font-mono text-gray-300">
                        {info.currency === 'GBP' ? '£' : '$'}{sig.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </div>
                    )}
                    <div className="flex items-center gap-1">
                      <SignalBadge dir={sig.direction} />
                      <StrengthBar strength={sig.strength} dir={sig.direction} />
                    </div>
                    {sig.rsi !== null && (
                      <div className={clsx('text-[9px] font-mono',
                        sig.rsi < 35 ? 'text-emerald-500' : sig.rsi > 65 ? 'text-red-500' : 'text-gray-600'
                      )}>RSI {sig.rsi.toFixed(0)}</div>
                    )}
                    {sig.blackout && (
                      <div className="text-[9px] text-amber-400 flex items-center gap-0.5">
                        <AlertTriangle className="h-2.5 w-2.5" /> Earnings soon
                      </div>
                    )}
                    {sig.error && <div className="text-[9px] text-red-500 truncate">{sig.error}</div>}
                  </div>
                )}

                {/* Position badge */}
                {pos && (
                  <div className={clsx('absolute top-2 right-2 text-[8px] font-bold px-1 py-0.5 rounded',
                    pos.upl >= 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                  )}>
                    {pos.upl >= 0 ? '+' : ''}£{pos.upl.toFixed(0)}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Open positions ──────────────────────────────────────────────────── */}
      {stockPositions.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Open Stock Positions</div>
          <div className="space-y-2">
            {stockPositions.map(pos => {
              const isProfit = pos.upl >= 0;
              const info = Object.values(IG_STOCK_EPICS).find(i => i.epic === pos.epic);
              return (
                <div key={pos.dealId} className={clsx('bg-gray-900 border rounded-xl p-3 flex items-center justify-between gap-4',
                  isProfit ? 'border-emerald-600/25' : 'border-red-600/20'
                )}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px]">{info ? exchangeFlag(info.exchange) : ''}</span>
                      <span className="text-sm font-bold text-white">{pos.instrumentName}</span>
                      <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded',
                        pos.direction === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                      )}>{pos.direction}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      £{pos.size}/pt · entry {pos.level.toFixed(2)}
                      {pos.stopLevel  && <span className="text-red-500"> · stop {pos.stopLevel.toFixed(2)}</span>}
                      {pos.limitLevel && <span className="text-emerald-500"> · target {pos.limitLevel.toFixed(2)}</span>}
                    </div>
                  </div>
                  <div className={clsx('text-lg font-bold shrink-0', isProfit ? 'text-emerald-400' : 'text-red-400')}>
                    {isProfit ? '+' : ''}£{pos.upl.toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Activity log ───────────────────────────────────────────────────── */}
      {logs.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Activity Log</div>
          <div className="bg-gray-950 border border-gray-800 rounded-xl divide-y divide-gray-800/50 max-h-56 overflow-y-auto">
            {logs.map(l => (
              <div key={l.id} className="flex items-start gap-2 px-3 py-2">
                <LogBadge type={l.type} />
                <span className="text-[10px] text-gray-600 shrink-0 font-mono">
                  {new Date(l.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className="text-[11px] text-gray-300">{l.msg}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[10px] text-gray-600">
        Stock spread bets via IG · signals from Yahoo Finance hourly candles · not financial advice · capital at risk
      </p>
    </div>
  );
}

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FlaskConical, Play, RefreshCw, X,
  CheckCircle2, AlertCircle, ArrowRight,
  Target, BarChart3, Trophy, Copy, Info, RotateCcw, Wallet, Clock,
} from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { DemoPosition, DemoTrade, FxPosition, FxTrade } from '@/lib/types';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { TickerTooltip } from '@/components/ui/TickerTooltip';
import { MarketStatusBadge } from '@/components/ui/MarketStatusBadge';
import { clsx } from 'clsx';
import { sendPush } from '@/lib/pushNotifications';

const SECTORS = ['All', 'Technology', 'Healthcare', 'Energy', 'Finance', 'Consumer'] as const;
type Sector = typeof SECTORS[number];

function fmtGBP(n: number) {
  return n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 2 });
}
function fmtUSD(n: number) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(n: number) { return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function uid() { return Math.random().toString(36).slice(2, 10); }
function hoursAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m ago` : `${m}m ago`;
}

type Signal = {
  symbol: string;
  name: string;
  t212Ticker: string;
  sector: string;
  isUK: boolean;
  score: number;          // profitScore 0-100
  currentPrice: number;
  changePercent: number;
  volume: number;
  volRatio: number;
  newsCount: number;
  recentNewsCount: number;
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  badges: string[];
  reason: string;
};

// ─── COPY TO LIVE MODAL ──────────────────────────────────────────────────────
function CopyToLiveModal({
  trade,
  liveEncoded,
  positionSize,
  onClose,
  onDone,
}: {
  trade: DemoTrade;
  liveEncoded: string;
  positionSize: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [resolving, setResolving] = useState(false);
  const [t212Ticker, setT212Ticker] = useState<string | null>(trade.t212Ticker || null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);

  // Step 1: resolve T212 ticker and current price
  useEffect(() => {
    async function resolve() {
      setResolving(true);
      try {
        // Fetch current live price
        const priceRes = await fetch('/api/demo-trader/prices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbols: [trade.ticker] }),
        });
        const priceData = await priceRes.json() as { prices: Record<string, number> };
        const price = priceData.prices?.[trade.ticker];
        if (price) setLivePrice(price);

        // Resolve T212 ticker if not already known
        if (!t212Ticker) {
          const instrRes = await fetch('/api/t212/instruments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-t212-auth': liveEncoded },
            body: JSON.stringify({ symbol: trade.ticker }),
          });
          const instrData = await instrRes.json() as { ticker: string | null; found: boolean; error?: string };
          if (instrData.error) {
            setResolveError(instrData.error);
          } else if (instrData.found && instrData.ticker) {
            setT212Ticker(instrData.ticker);
          } else {
            setResolveError(`Could not find T212 instrument for ${trade.ticker}. It may not be tradeable on your account.`);
          }
        }
      } catch (err) {
        setResolveError(`Lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setResolving(false);
      }
    }
    resolve();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentPrice = livePrice ?? trade.exitPrice;
  const quantity = Math.max(1, Math.floor(positionSize / currentPrice));
  const estimatedValue = quantity * currentPrice;

  async function handleCopy() {
    if (!t212Ticker) return;
    setConfirming(true);
    try {
      const res = await fetch('/api/t212/live-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-t212-auth': liveEncoded },
        body: JSON.stringify({ ticker: t212Ticker, quantity }),
      });
      const data = await res.json();
      if (data.ok) {
        setResult({ ok: true, message: `Live order placed. Order ID: ${data.orderId ?? 'pending'}` });
        setTimeout(onDone, 2500);
      } else {
        setResult({ ok: false, message: data.error ?? 'Order failed.' });
      }
    } catch (err) {
      setResult({ ok: false, message: `Request failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md shadow-2xl p-6">
        <button onClick={onClose} className="absolute right-4 top-4 text-gray-500 hover:text-gray-300">
          <X className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-2 mb-4">
          <Copy className="h-5 w-5 text-emerald-400" />
          <h2 className="text-lg font-semibold text-white">Copy Trade to Live Account</h2>
        </div>

        <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3 mb-4 text-xs text-amber-300">
          <strong className="block mb-1">⚠ YOU are making this decision.</strong>
          This places a real market order with real money on your live Trading 212 account. Past paper trading performance does not guarantee live results. This is not financial advice.
        </div>

        {resolving && (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Looking up live price and T212 instrument…
          </div>
        )}

        {resolveError && (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 text-xs text-red-400 mb-4">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            {resolveError}
          </div>
        )}

        {!resolving && !resolveError && (
          <div className="bg-gray-800/50 rounded-lg p-4 mb-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-400">Stock</span>
              <span className="text-white font-semibold">{trade.ticker} · {trade.companyName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">T212 instrument</span>
              <span className="text-white font-mono text-xs">{t212Ticker ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Order type</span>
              <span className="text-white">Market BUY</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Live price</span>
              <span className="text-gray-300 font-mono">{fmtUSD(currentPrice)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Quantity</span>
              <span className="text-white font-mono">{quantity} shares</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Estimated value</span>
              <span className="text-white font-mono">{fmtUSD(estimatedValue)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Paper P&L</span>
              <span className={clsx('font-semibold font-mono', trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                {trade.pnl >= 0 ? '+' : ''}{fmtGBP(trade.pnl)} ({fmtPct(trade.pnlPct)})
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Account</span>
              <span className="text-emerald-400 font-semibold">🟢 LIVE T212</span>
            </div>
          </div>
        )}

        {result ? (
          <div className={clsx('flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs', result.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/30 text-red-400')}>
            {result.ok ? <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /> : <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />}
            {result.message}
          </div>
        ) : (
          <Button
            onClick={handleCopy}
            loading={confirming || resolving}
            disabled={!t212Ticker || !!resolveError || resolving}
            fullWidth
            icon={<Copy className="h-4 w-4" />}
          >
            Confirm — Place Live Market Order
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── FOREX TRADER ─────────────────────────────────────────────────────────────
const FX_PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF',
  'AUD/USD', 'USD/CAD', 'NZD/USD', 'GBP/EUR',
  'EUR/JPY', 'GBP/JPY',
] as const;
type FxPair = typeof FX_PAIRS[number];

// ── FX constants ─────────────────────────────────────────────────────────────
const PAIR_FLAGS: Record<FxPair, string> = {
  'EUR/USD': '🇪🇺🇺🇸', 'GBP/USD': '🇬🇧🇺🇸', 'USD/JPY': '🇺🇸🇯🇵',
  'USD/CHF': '🇺🇸🇨🇭', 'AUD/USD': '🇦🇺🇺🇸', 'USD/CAD': '🇺🇸🇨🇦',
  'NZD/USD': '🇳🇿🇺🇸', 'GBP/EUR': '🇬🇧🇪🇺', 'EUR/JPY': '🇪🇺🇯🇵', 'GBP/JPY': '🇬🇧🇯🇵',
};

const FX_PAIR_SESSIONS: Record<FxPair, string[]> = {
  'EUR/USD': ['London', 'New York'], 'GBP/USD': ['London', 'New York'],
  'USD/JPY': ['Tokyo', 'New York'], 'USD/CHF': ['London'],
  'AUD/USD': ['Sydney', 'Tokyo'],   'USD/CAD': ['New York'],
  'NZD/USD': ['Sydney'],            'GBP/EUR': ['London'],
  'EUR/JPY': ['Tokyo', 'London'],   'GBP/JPY': ['Tokyo', 'London'],
};

const CORRELATED_GROUPS: string[][] = [
  ['EUR/USD', 'GBP/USD'],
  ['EUR/USD', 'EUR/JPY'],
  ['GBP/USD', 'GBP/EUR', 'GBP/JPY'],
  ['USD/JPY', 'EUR/JPY', 'GBP/JPY'],
];

const FX_SL_PIPS = 15;
const FX_TP_PIPS = 30;
const FX_TRAIL_TRIGGER = 20; // activate trailing at +20 pips
const FX_MAX_POSITIONS = 3;
const FX_SCAN_MS = 5 * 60_000;
const FX_MOMENTUM_PCT = 0.002; // 0.2% threshold
const FX_MIN_CONFIDENCE = 60;
const FX_TRADE_UNITS = 1_000;
const FX_DEFAULT_BUDGET = 1_000;
const LS_FX_HISTORY = 'fx_rate_history';
const LS_FX_LAST_SCAN = 'fx_last_scan';
const LS_FX_AUTO = 'fx_auto_pairs';
const LS_FX_BUDGET = 'fx_budget';

type FxRateSnapshot = { ts: number; rates: Record<string, number> };
type FxSignalResult = {
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  confidence: number;
  change1hPips: number;
  change1hPct: number;
};

// ── Pure helpers ──────────────────────────────────────────────────────────────
function isJpyPair(pair: string) { return pair.includes('JPY'); }
function pipSize(pair: string)   { return isJpyPair(pair) ? 0.01 : 0.0001; }
function pipValuePerUnit(pair: string) { return isJpyPair(pair) ? 0.093 / 1000 : 0.10 / 1000; }

function derivePairRate(pair: string, rates: Record<string, number>): number {
  const r = rates;
  switch (pair) {
    case 'EUR/USD': return r.EUR ? 1 / r.EUR : 1.087;
    case 'GBP/USD': return r.GBP ? 1 / r.GBP : 1.265;
    case 'USD/JPY': return r.JPY ?? 149.5;
    case 'USD/CHF': return r.CHF ?? 0.9;
    case 'AUD/USD': return r.AUD ? 1 / r.AUD : 0.65;
    case 'USD/CAD': return r.CAD ?? 1.36;
    case 'NZD/USD': return r.NZD ? 1 / r.NZD : 0.61;
    case 'GBP/EUR': return (r.EUR && r.GBP) ? r.EUR / r.GBP : 1.165;
    case 'EUR/JPY': return (r.EUR && r.JPY) ? r.JPY / r.EUR : 162.5;
    case 'GBP/JPY': return (r.GBP && r.JPY) ? r.JPY / r.GBP : 189.0;
    default: return 1;
  }
}

function fmtRate(rate: number, pair: string) {
  return isJpyPair(pair) ? rate.toFixed(3) : rate.toFixed(5);
}

function getActiveSessionsNow(): string[] {
  const now = new Date();
  const t = now.getUTCHours() + now.getUTCMinutes() / 60;
  const s: string[] = [];
  if (t >= 22 || t < 7)   s.push('Sydney');
  if (t >= 0  && t < 9)   s.push('Tokyo');
  if (t >= 8  && t < 17)  s.push('London');
  if (t >= 13 && t < 22)  s.push('New York');
  if (t >= 13 && t < 17)  s.push('London/NY');
  return s;
}

function computeFxSignals(
  currentRates: Record<string, number>,
  history: FxRateSnapshot[]
): Record<string, FxSignalResult> {
  const now = Date.now();
  const result: Record<string, FxSignalResult> = {};

  for (const pair of FX_PAIRS) {
    const currentRate = derivePairRate(pair, currentRates);
    const pip = pipSize(pair);

    // Find snapshot closest to 1h ago (within 90 min window)
    const t1h = now - 60 * 60_000;
    const snap1h = history.length > 0
      ? history.reduce((b, s) => Math.abs(s.ts - t1h) < Math.abs(b.ts - t1h) ? s : b)
      : null;

    if (!snap1h || Math.abs(snap1h.ts - t1h) > 90 * 60_000) {
      result[pair] = { direction: 'NEUTRAL', confidence: 0, change1hPips: 0, change1hPct: 0 };
      continue;
    }

    const rate1h = derivePairRate(pair, snap1h.rates);
    const change1hPct = ((currentRate - rate1h) / rate1h) * 100;
    const change1hPips = (currentRate - rate1h) / pip;

    // 4h snapshot for acceleration check
    const t4h = now - 4 * 60 * 60_000;
    const snap4h = history.length > 0
      ? history.reduce((b, s) => Math.abs(s.ts - t4h) < Math.abs(b.ts - t4h) ? s : b)
      : null;
    const change4hPct = snap4h && Math.abs(snap4h.ts - t4h) < 5 * 60 * 60_000
      ? ((currentRate - derivePairRate(pair, snap4h.rates)) / derivePairRate(pair, snap4h.rates)) * 100
      : 0;

    let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
    let confidence = 0;

    if (change1hPct >= FX_MOMENTUM_PCT) {
      direction = 'LONG';
      const accel = change4hPct >= 0;
      confidence = Math.min(95, Math.round(40 + Math.abs(change1hPct) * 5000 + (accel ? 20 : 0)));
    } else if (change1hPct <= -FX_MOMENTUM_PCT) {
      direction = 'SHORT';
      const accel = change4hPct <= 0;
      confidence = Math.min(95, Math.round(40 + Math.abs(change1hPct) * 5000 + (accel ? 20 : 0)));
    }

    result[pair] = { direction, confidence, change1hPips, change1hPct };
  }
  return result;
}

function hasCorrelationConflict(
  pair: string,
  direction: 'long' | 'short',
  openPositions: FxPosition[]
): boolean {
  for (const group of CORRELATED_GROUPS) {
    if (!group.includes(pair)) continue;
    for (const other of group) {
      if (other === pair) continue;
      if (openPositions.some(p => p.pair === other && p.direction === direction)) return true;
    }
  }
  return false;
}

// ── Component ─────────────────────────────────────────────────────────────────
function ForexTrader() {
  const { fxPositions, fxTrades, addFxPosition, removeFxPosition, updateFxPosition, addFxTrade, fxRates: gbpRates } = useClearGainsStore();

  const [rates, setRates] = useState<Record<string, number>>({});
  const [rateHistory, setRateHistory] = useState<FxRateSnapshot[]>([]);
  const [fxSignals, setFxSignals] = useState<Record<string, FxSignalResult>>({});
  const [autoEnabled, setAutoEnabled] = useState<Record<string, boolean>>({});
  const [flashPairs, setFlashPairs] = useState<Record<string, 'up' | 'down'>>({});
  const [fxBudget, setFxBudgetState] = useState(FX_DEFAULT_BUDGET);
  const [autoLog, setAutoLog] = useState<string[]>([]);
  const [activeSessions, setActiveSessions] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);

  // Refs to avoid stale closures in intervals
  const rateHistoryRef = useRef<FxRateSnapshot[]>([]);
  const autoEnabledRef = useRef<Record<string, boolean>>({});
  const fxPositionsRef = useRef<FxPosition[]>([]);
  const prevRatesRef = useRef<Record<string, number>>({});

  useEffect(() => { rateHistoryRef.current = rateHistory; }, [rateHistory]);
  useEffect(() => { autoEnabledRef.current = autoEnabled; }, [autoEnabled]);
  useEffect(() => { fxPositionsRef.current = fxPositions; }, [fxPositions]);

  const gbpUsd = gbpRates['USD'] ? 1 / gbpRates['USD'] : (rates.GBP ? 1 / rates.GBP : 1.265);
  const gbpUsdRef = useRef(gbpUsd);
  useEffect(() => { gbpUsdRef.current = gbpUsd; }, [gbpUsd]);

  // ── Account stats ──────────────────────────────────────────────────────────
  const fxTradeSize = fxBudget * 0.01; // 1% per trade
  const fxInvested  = fxPositions.length * fxTradeSize;
  const fxAvailable = Math.max(0, fxBudget - fxInvested);
  const fxOpenPnL   = fxPositions.reduce((s, p) => s + p.pnlGbp, 0);
  const fxClosedPnL = fxTrades.reduce((s, t) => s + t.pnlGbp, 0);
  const fxTotalPnL  = fxOpenPnL + fxClosedPnL;
  const fxWins      = fxTrades.filter(t => t.pnlGbp > 0).length;
  const fxWinRate   = fxTrades.length > 0 ? Math.round((fxWins / fxTrades.length) * 100) : 0;

  // ── Load localStorage on mount ─────────────────────────────────────────────
  useEffect(() => {
    try {
      const h = localStorage.getItem(LS_FX_HISTORY);
      if (h) { const parsed = JSON.parse(h) as FxRateSnapshot[]; setRateHistory(parsed); rateHistoryRef.current = parsed; }
    } catch {}
    try {
      const b = localStorage.getItem(LS_FX_BUDGET);
      if (b) setFxBudgetState(Number(JSON.parse(b)));
    } catch {}
    try {
      const a = localStorage.getItem(LS_FX_AUTO);
      if (a) { const parsed = JSON.parse(a) as Record<string, boolean>; setAutoEnabled(parsed); autoEnabledRef.current = parsed; }
    } catch {}
    setActiveSessions(getActiveSessionsNow());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Session ticker (updates every 60s)
  useEffect(() => {
    const id = setInterval(() => setActiveSessions(getActiveSessionsNow()), 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Fetch rates ────────────────────────────────────────────────────────────
  const fetchRates = useCallback(async (runScan = false) => {
    try {
      const res = await fetch('/api/forex/rates');
      if (!res.ok) return;
      const data = await res.json() as { rates: Record<string, number> };
      const newRates = data.rates;

      // Flash animation
      const flashes: Record<string, 'up' | 'down'> = {};
      if (Object.keys(prevRatesRef.current).length > 0) {
        for (const pair of FX_PAIRS) {
          const prev = derivePairRate(pair, prevRatesRef.current);
          const curr = derivePairRate(pair, newRates);
          if (Math.abs(curr - prev) > pipSize(pair) * 0.5) {
            flashes[pair] = curr > prev ? 'up' : 'down';
          }
        }
      }
      if (Object.keys(flashes).length > 0) {
        setFlashPairs(flashes);
        setTimeout(() => setFlashPairs({}), 900);
      }
      prevRatesRef.current = newRates;
      setRates(newRates);

      // Store snapshot
      const snap: FxRateSnapshot = { ts: Date.now(), rates: newRates };
      setRateHistory(prev => {
        const updated = [...prev, snap].slice(-200);
        rateHistoryRef.current = updated;
        try { localStorage.setItem(LS_FX_HISTORY, JSON.stringify(updated)); } catch {}
        return updated;
      });

      if (runScan) runAutoScan(newRates, fxPositionsRef.current);
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every 60s fetch; on mount check background scan
  useEffect(() => {
    fetchRates();
    const id = setInterval(() => fetchRates(), 60_000);

    // Background scan: if 5+ min since last scan, run immediately
    const last = localStorage.getItem(LS_FX_LAST_SCAN);
    if (last && Date.now() - Number(last) >= FX_SCAN_MS) {
      setTimeout(() => fetchRates(true), 3000);
    }

    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scan every 5 min
  useEffect(() => {
    const id = setInterval(() => fetchRates(true), FX_SCAN_MS);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recompute signals when rates/history change
  useEffect(() => {
    if (Object.keys(rates).length === 0) return;
    setFxSignals(computeFxSignals(rates, rateHistory));
  }, [rates, rateHistory]);

  // ── Position management: SL / TP / trailing stop ───────────────────────────
  useEffect(() => {
    if (Object.keys(rates).length === 0) return;
    // Process one position at a time to avoid double-closing
    for (const pos of fxPositions) {
      const currentRate = derivePairRate(pos.pair, rates);
      const pip = pipSize(pos.pair);
      const pipsRaw = pos.direction === 'long'
        ? (currentRate - pos.entryRate) / pip
        : (pos.entryRate - currentRate) / pip;
      const pnlGbp = (pipsRaw * pipValuePerUnit(pos.pair) * pos.units) / gbpUsd;

      // Trailing: activate at +20 pips, SL moves to breakeven
      const trailingActive = !!(pos.trailingActive || pipsRaw >= FX_TRAIL_TRIGGER);
      const effectiveSL = trailingActive ? 0 : -FX_SL_PIPS;

      if (pipsRaw <= effectiveSL) {
        const exitRate = pos.direction === 'long'
          ? pos.entryRate + effectiveSL * pip
          : pos.entryRate - effectiveSL * pip;
        closeFxPositionInternal(pos, exitRate, trailingActive ? 'trailing-stop' : 'stop-loss');
        return; // re-run on next rates update
      }
      if (pipsRaw >= FX_TP_PIPS) {
        const exitRate = pos.direction === 'long'
          ? pos.entryRate + FX_TP_PIPS * pip
          : pos.entryRate - FX_TP_PIPS * pip;
        closeFxPositionInternal(pos, exitRate, 'take-profit');
        return;
      }
      updateFxPosition(pos.id, { currentRate, pnlPips: pipsRaw, pnlGbp, trailingActive });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rates]);

  function closeFxPositionInternal(pos: FxPosition, exitRate: number, reason: FxTrade['closeReason']) {
    const pip = pipSize(pos.pair);
    const pipsRaw = pos.direction === 'long'
      ? (exitRate - pos.entryRate) / pip
      : (pos.entryRate - exitRate) / pip;
    const pnlGbp = (pipsRaw * pipValuePerUnit(pos.pair) * pos.units) / gbpUsdRef.current;
    addFxTrade({ id: uid(), pair: pos.pair, direction: pos.direction, units: pos.units, entryRate: pos.entryRate, exitRate, pnlPips: pipsRaw, pnlGbp, openedAt: pos.openedAt, closedAt: new Date().toISOString(), closeReason: reason });
    removeFxPosition(pos.id);
  }

  function openFxPositionManual(pair: string, direction: 'long' | 'short') {
    if (!rates || Object.keys(rates).length === 0) return;
    const entryRate = derivePairRate(pair, rates);
    addFxPosition({ id: uid(), pair, direction, units: FX_TRADE_UNITS, entryRate, currentRate: entryRate, stopLossPips: FX_SL_PIPS, takeProfitPips: FX_TP_PIPS, pnlPips: 0, pnlGbp: 0, openedAt: new Date().toISOString(), trailingActive: false, autoManaged: false });
  }

  function runAutoScan(currentRates: Record<string, number>, openPositions: FxPosition[]) {
    if (scanning) return;
    setScanning(true);
    localStorage.setItem(LS_FX_LAST_SCAN, String(Date.now()));

    const signals = computeFxSignals(currentRates, rateHistoryRef.current);
    const enabled = autoEnabledRef.current;
    const log: string[] = [`[${new Date().toLocaleTimeString('en-GB')}] Auto-scan`];
    let opened = 0;

    for (const pair of FX_PAIRS) {
      if (!enabled[pair]) continue;
      const sig = signals[pair];
      if (!sig || sig.direction === 'NEUTRAL' || sig.confidence < FX_MIN_CONFIDENCE) continue;

      if (openPositions.length + opened >= FX_MAX_POSITIONS) {
        log.push(`  ⛔ Max ${FX_MAX_POSITIONS} positions — stopped`);
        break;
      }
      if (openPositions.some(p => p.pair === pair)) {
        log.push(`  ↩ ${pair}: already open`);
        continue;
      }
      const dir = sig.direction === 'LONG' ? 'long' : 'short';
      if (hasCorrelationConflict(pair, dir, openPositions)) {
        log.push(`  ⚠ ${pair}: correlation conflict`);
        continue;
      }
      const entryRate = derivePairRate(pair, currentRates);
      addFxPosition({ id: uid(), pair, direction: dir, units: FX_TRADE_UNITS, entryRate, currentRate: entryRate, stopLossPips: FX_SL_PIPS, takeProfitPips: FX_TP_PIPS, pnlPips: 0, pnlGbp: 0, openedAt: new Date().toISOString(), trailingActive: false, autoManaged: true });
      openPositions = [...openPositions, { id: 'tmp', pair, direction: dir, units: FX_TRADE_UNITS, entryRate, currentRate: entryRate, stopLossPips: FX_SL_PIPS, takeProfitPips: FX_TP_PIPS, pnlPips: 0, pnlGbp: 0, openedAt: '' }];
      opened++;
      log.push(`  ✓ ${dir.toUpperCase()} ${pair} @ ${fmtRate(entryRate, pair)} (${sig.confidence}% conf)`);
    }

    if (opened === 0) log.push('  — No new positions opened');
    log.push(`  Done — ${opened} opened`);
    setAutoLog(prev => [...log, '', ...prev].slice(0, 60));
    setScanning(false);
  }

  function toggleAutoEnabled(pair: string) {
    setAutoEnabled(prev => {
      const updated = { ...prev, [pair]: !prev[pair] };
      autoEnabledRef.current = updated;
      try { localStorage.setItem(LS_FX_AUTO, JSON.stringify(updated)); } catch {}
      return updated;
    });
  }

  function handleSetFxBudget(n: number) {
    setFxBudgetState(n);
    try { localStorage.setItem(LS_FX_BUDGET, JSON.stringify(n)); } catch {}
  }

  const SESSION_DEFS = [
    { name: 'Sydney',    hours: '22:00–07:00 UTC', color: 'text-blue-400',   bg: 'bg-blue-500/10 border-blue-500/30' },
    { name: 'Tokyo',     hours: '00:00–09:00 UTC', color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/30' },
    { name: 'London',    hours: '08:00–17:00 UTC', color: 'text-emerald-400',bg: 'bg-emerald-500/10 border-emerald-500/30' },
    { name: 'New York',  hours: '13:00–22:00 UTC', color: 'text-amber-400',  bg: 'bg-amber-500/10 border-amber-500/30' },
  ];

  return (
    <div className="space-y-4">

      {/* ── Session header ──────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white mb-2">Forex Sessions</h2>
          <div className="flex flex-wrap gap-2">
            {SESSION_DEFS.map(s => {
              const active = activeSessions.includes(s.name);
              return (
                <div key={s.name} className={clsx('px-3 py-1.5 rounded-lg text-xs border', active ? `${s.bg} ${s.color}` : 'bg-gray-800/50 border-gray-700 text-gray-600')}>
                  <span className="font-semibold">{s.name}</span>
                  <span className="ml-1 text-[10px] opacity-70">{s.hours}</span>
                </div>
              );
            })}
            {activeSessions.includes('London/NY') && (
              <div className="px-3 py-1.5 rounded-lg text-xs border bg-red-500/10 border-red-500/30 text-red-400 font-semibold animate-pulse">
                ⚡ London/NY Overlap — peak volatility
              </div>
            )}
          </div>
        </div>
        <button
          onClick={() => { if (Object.keys(rates).length > 0) runAutoScan(rates, fxPositionsRef.current); }}
          disabled={scanning || Object.keys(rates).length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={clsx('h-3 w-3', scanning && 'animate-spin')} />
          {scanning ? 'Scanning…' : 'Scan Now'}
        </button>
      </div>

      {/* ── FX Account ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="FX Paper Account" subtitle="Separate from stock budget · £10/trade (1%)" icon={<Wallet className="h-4 w-4" />} />
        <div className="grid grid-cols-3 gap-2 mb-3">
          {[
            { label: 'FX Budget',  value: fmtGBP(fxBudget),   color: 'text-white' },
            { label: 'Invested',   value: fmtGBP(fxInvested),  color: 'text-amber-400' },
            { label: 'Available',  value: fmtGBP(fxAvailable), color: 'text-emerald-400' },
            { label: 'Open P&L',   value: `${fxOpenPnL >= 0 ? '+' : ''}${fmtGBP(fxOpenPnL)}`,   color: fxOpenPnL >= 0 ? 'text-emerald-400' : 'text-red-400' },
            { label: 'Total P&L',  value: `${fxTotalPnL >= 0 ? '+' : ''}${fmtGBP(fxTotalPnL)}`, color: fxTotalPnL >= 0 ? 'text-emerald-400' : 'text-red-400' },
            { label: 'Win Rate',   value: fxTrades.length > 0 ? `${fxWinRate}%` : '—',           color: fxWinRate >= 50 ? 'text-emerald-400' : fxTrades.length > 0 ? 'text-red-400' : 'text-gray-500' },
          ].map(row => (
            <div key={row.label} className="bg-gray-800/50 rounded-lg px-3 py-2">
              <p className="text-[10px] text-gray-500 mb-0.5">{row.label}</p>
              <p className={clsx('text-sm font-semibold font-mono', row.color)}>{row.value}</p>
            </div>
          ))}
        </div>
        <div className="border-t border-gray-800 pt-3">
          <label className="text-xs text-gray-400 mb-1.5 block">FX Budget</label>
          <div className="flex gap-2">
            {[500, 1000, 2000, 5000].map(v => (
              <button key={v} onClick={() => handleSetFxBudget(v)} className={clsx('flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors', fxBudget === v ? 'bg-amber-500/20 border-amber-500/30 text-amber-300' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200')}>
                £{v.toLocaleString()}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* ── Pairs table ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Live Forex Pairs"
          subtitle={`${FX_PAIRS.length} pairs · auto-scan every 5 min · SL ${FX_SL_PIPS}p / TP ${FX_TP_PIPS}p`}
          icon={<BarChart3 className="h-4 w-4" />}
          action={
            rateHistory.length > 0
              ? <span className="text-[10px] text-gray-600">{rateHistory.length} snapshots</span>
              : undefined
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-2 pr-2">Pair</th>
                <th className="text-right py-2 pr-2">Rate</th>
                <th className="text-right py-2 pr-2">1h Change</th>
                <th className="text-left py-2 pr-2">Session</th>
                <th className="text-center py-2 pr-2">Signal</th>
                <th className="text-center py-2 pr-2">Position</th>
                <th className="text-center py-2 pr-2">Auto</th>
                <th className="text-right py-2">Trade</th>
              </tr>
            </thead>
            <tbody>
              {FX_PAIRS.map(pair => {
                const rate      = Object.keys(rates).length > 0 ? derivePairRate(pair, rates) : null;
                const sig       = fxSignals[pair];
                const openPos   = fxPositions.find(p => p.pair === pair);
                const sessActive = FX_PAIR_SESSIONS[pair].some(s => activeSessions.includes(s));
                const flash     = flashPairs[pair];

                return (
                  <tr key={pair} className={clsx('border-b border-gray-800/50 transition-colors', flash === 'up' ? 'price-flash-up' : flash === 'down' ? 'price-flash-down' : '')}>

                    {/* Pair */}
                    <td className="py-2 pr-2">
                      <div className="flex items-center gap-1.5">
                        <span>{PAIR_FLAGS[pair]}</span>
                        <span className="font-semibold text-white">{pair}</span>
                      </div>
                    </td>

                    {/* Rate */}
                    <td className="py-2 pr-2 text-right font-mono text-gray-300">
                      {rate !== null ? fmtRate(rate, pair) : '—'}
                    </td>

                    {/* 1h change */}
                    <td className={clsx('py-2 pr-2 text-right font-mono text-[11px]', !sig || sig.change1hPips === 0 ? 'text-gray-700' : sig.change1hPct > 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {sig && sig.change1hPips !== 0 ? (
                        <span>{sig.change1hPips >= 0 ? '+' : ''}{sig.change1hPips.toFixed(1)}p <span className="text-gray-600">({sig.change1hPct >= 0 ? '+' : ''}{sig.change1hPct.toFixed(3)}%)</span></span>
                      ) : '—'}
                    </td>

                    {/* Session */}
                    <td className="py-2 pr-2">
                      <span className={clsx('text-[10px]', sessActive ? 'text-emerald-400' : 'text-gray-600')}>
                        {sessActive ? '● ' : '○ '}{FX_PAIR_SESSIONS[pair][0]}
                      </span>
                    </td>

                    {/* Signal */}
                    <td className="py-2 pr-2 text-center">
                      {sig && sig.direction !== 'NEUTRAL' ? (
                        <div>
                          <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold', sig.direction === 'LONG' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400')}>
                            {sig.direction}
                          </span>
                          <div className="text-[10px] text-gray-600">{sig.confidence}%</div>
                        </div>
                      ) : <span className="text-[10px] text-gray-700">—</span>}
                    </td>

                    {/* Open position */}
                    <td className="py-2 pr-2 text-center">
                      {openPos ? (
                        <div>
                          <span className={clsx('text-[10px] font-bold', openPos.direction === 'long' ? 'text-emerald-400' : 'text-red-400')}>
                            {openPos.direction.toUpperCase()}
                          </span>
                          <div className={clsx('text-[10px] font-mono', openPos.pnlGbp >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                            {openPos.pnlGbp >= 0 ? '+' : ''}£{openPos.pnlGbp.toFixed(2)}
                          </div>
                          {openPos.trailingActive && <div className="text-[10px] text-amber-400">trailing</div>}
                        </div>
                      ) : <span className="text-[10px] text-gray-700">—</span>}
                    </td>

                    {/* Auto toggle */}
                    <td className="py-2 pr-2 text-center">
                      <button
                        onClick={() => toggleAutoEnabled(pair)}
                        title={autoEnabled[pair] ? 'Auto ON — click to disable' : 'Auto OFF — click to enable'}
                        className={clsx('w-8 h-4 rounded-full transition-colors relative', autoEnabled[pair] ? 'bg-amber-500/60' : 'bg-gray-700')}
                      >
                        <span className={clsx('absolute top-0.5 w-3 h-3 rounded-full transition-transform', autoEnabled[pair] ? 'translate-x-4 bg-amber-300' : 'translate-x-0.5 bg-gray-500')} />
                      </button>
                    </td>

                    {/* Trade buttons */}
                    <td className="py-2 text-right">
                      {rate !== null && !openPos && (
                        <div className="flex gap-1 justify-end">
                          <button onClick={() => openFxPositionManual(pair, 'long')} className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors">LONG</button>
                          <button onClick={() => openFxPositionManual(pair, 'short')} className="px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors">SHORT</button>
                        </div>
                      )}
                      {openPos && (
                        <button onClick={() => closeFxPositionInternal(openPos, derivePairRate(pair, rates), 'manual')} className="px-2 py-0.5 rounded text-[10px] font-bold bg-gray-700 text-gray-400 hover:bg-gray-600 transition-colors">CLOSE</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[10px] text-gray-700 px-1">
          Toggle <span className="text-amber-500/70">Auto</span> on pairs to enable automated position entry. Max {FX_MAX_POSITIONS} positions simultaneously. Correlated pairs are never opened in the same direction.
        </p>
      </Card>

      {/* ── Open positions ─────────────────────────────────────────────────── */}
      {fxPositions.length > 0 && (
        <Card>
          <CardHeader title="Open FX Positions" subtitle={`${fxPositions.length}/${FX_MAX_POSITIONS} max · trailing stop at +${FX_TRAIL_TRIGGER} pips`} icon={<Target className="h-4 w-4" />} />
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left py-2 pr-3">Pair</th>
                  <th className="text-left py-2 pr-3">Dir</th>
                  <th className="text-right py-2 pr-3">Entry</th>
                  <th className="text-right py-2 pr-3">Current</th>
                  <th className="text-right py-2 pr-3">SL</th>
                  <th className="text-right py-2 pr-3">TP</th>
                  <th className="text-right py-2 pr-3">Pips</th>
                  <th className="text-right py-2 pr-3">P&L</th>
                  <th className="text-right py-2">×</th>
                </tr>
              </thead>
              <tbody>
                {fxPositions.map(pos => {
                  const pip = pipSize(pos.pair);
                  const slRate = pos.trailingActive
                    ? pos.entryRate
                    : (pos.direction === 'long' ? pos.entryRate - FX_SL_PIPS * pip : pos.entryRate + FX_SL_PIPS * pip);
                  const tpRate = pos.direction === 'long'
                    ? pos.entryRate + FX_TP_PIPS * pip
                    : pos.entryRate - FX_TP_PIPS * pip;
                  return (
                    <tr key={pos.id} className="border-b border-gray-800/50">
                      <td className="py-1.5 pr-3">
                        <div className="flex items-center gap-1">
                          <span>{PAIR_FLAGS[pos.pair as FxPair] ?? ''}</span>
                          <span className="font-semibold text-white">{pos.pair}</span>
                        </div>
                        {pos.autoManaged && <div className="text-[10px] text-amber-500/60">auto</div>}
                        {pos.trailingActive && <div className="text-[10px] text-amber-400">trailing</div>}
                      </td>
                      <td className="py-1.5 pr-3">
                        <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold', pos.direction === 'long' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400')}>
                          {pos.direction.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono text-gray-400">{fmtRate(pos.entryRate, pos.pair)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono text-gray-300">{fmtRate(pos.currentRate, pos.pair)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono text-red-400/60">
                        {fmtRate(slRate, pos.pair)}
                        {pos.trailingActive && <div className="text-[9px] text-amber-400/70">BE</div>}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono text-emerald-400/60">{fmtRate(tpRate, pos.pair)}</td>
                      <td className={clsx('py-1.5 pr-3 text-right font-mono', pos.pnlPips >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {pos.pnlPips >= 0 ? '+' : ''}{pos.pnlPips.toFixed(1)}p
                      </td>
                      <td className={clsx('py-1.5 pr-3 text-right font-mono font-semibold', pos.pnlGbp >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {pos.pnlGbp >= 0 ? '+' : ''}£{pos.pnlGbp.toFixed(2)}
                      </td>
                      <td className="py-1.5 text-right">
                        <button onClick={() => closeFxPositionInternal(pos, pos.currentRate, 'manual')} className="text-gray-600 hover:text-red-400 transition-colors">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ── Auto-trade log ─────────────────────────────────────────────────── */}
      {autoLog.length > 0 && (
        <Card>
          <CardHeader title="Auto-Trade Log" subtitle="Last scan results" icon={<Info className="h-4 w-4" />} />
          <div className="font-mono text-[11px] text-gray-400 space-y-0.5 max-h-28 overflow-y-auto">
            {autoLog.map((line, i) => <p key={i} className={line.startsWith('  ✓') ? 'text-emerald-400' : line.startsWith('  ⛔') || line.startsWith('  ⚠') ? 'text-amber-400' : ''}>{line}</p>)}
          </div>
        </Card>
      )}

      {/* ── FX Trade History ───────────────────────────────────────────────── */}
      {fxTrades.length > 0 && (
        <Card>
          <CardHeader title="FX Trade History" subtitle={`${fxTrades.length} closed · ${fxWinRate}% win rate`} icon={<Trophy className="h-4 w-4" />} />
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left py-2 pr-3">Pair</th>
                  <th className="text-left py-2 pr-3">Dir</th>
                  <th className="text-right py-2 pr-3">Entry</th>
                  <th className="text-right py-2 pr-3">Exit</th>
                  <th className="text-right py-2 pr-3">Pips</th>
                  <th className="text-right py-2 pr-3">P&L £</th>
                  <th className="text-center py-2 pr-3">Reason</th>
                  <th className="text-right py-2">Date</th>
                </tr>
              </thead>
              <tbody>
                {fxTrades.slice(0, 20).map(trade => (
                  <tr key={trade.id} className="border-b border-gray-800/50">
                    <td className="py-1.5 pr-3">
                      <div className="flex items-center gap-1">
                        <span>{PAIR_FLAGS[trade.pair as FxPair] ?? ''}</span>
                        <span className="font-semibold text-white">{trade.pair}</span>
                      </div>
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold', trade.direction === 'long' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400')}>
                        {trade.direction.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono text-gray-400">{fmtRate(trade.entryRate, trade.pair)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono text-gray-400">{fmtRate(trade.exitRate, trade.pair)}</td>
                    <td className={clsx('py-1.5 pr-3 text-right font-mono', trade.pnlPips >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {trade.pnlPips >= 0 ? '+' : ''}{trade.pnlPips.toFixed(1)}
                    </td>
                    <td className={clsx('py-1.5 pr-3 text-right font-mono font-semibold', trade.pnlGbp >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {trade.pnlGbp >= 0 ? '+' : ''}£{trade.pnlGbp.toFixed(2)}
                    </td>
                    <td className="py-1.5 pr-3 text-center">
                      <span className={clsx('px-1.5 py-0.5 rounded text-[10px]',
                        trade.closeReason === 'take-profit'  ? 'bg-emerald-500/20 text-emerald-400' :
                        trade.closeReason === 'trailing-stop' ? 'bg-amber-500/20 text-amber-400' :
                        trade.closeReason === 'stop-loss'    ? 'bg-red-500/20 text-red-400' :
                        'bg-gray-700 text-gray-400')}>
                        {trade.closeReason}
                      </span>
                    </td>
                    <td className="py-1.5 text-right text-gray-600">
                      {new Date(trade.closedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 pt-3 border-t border-gray-800 flex items-start justify-between text-xs">
            <div className="text-gray-600">
              <strong className="text-gray-500">Tax note:</strong> FX gains are subject to CGT in the UK (income tax if frequent trading).
            </div>
            <div className={clsx('font-mono font-semibold flex-shrink-0 ml-4', fxClosedPnL >= 0 ? 'text-emerald-400' : 'text-red-400')}>
              {fxClosedPnL >= 0 ? '+' : ''}{fmtGBP(fxClosedPnL)} realised
            </div>
          </div>
        </Card>
      )}

    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
export default function DemoTraderPage() {
  const {
    t212ApiKey, t212ApiSecret,
    demoPositions, demoTrades,
    paperBudget, setPaperBudget, resetPaperAccount,
    addDemoPosition, removeDemoPosition, updateDemoPosition, addDemoTrade,
    setPaperPositions, setPaperTrades, setPendingSignalCount,
  } = useClearGainsStore();

  const SIZE_PRESETS = [10, 50, 100, 250] as const;
  type SizePreset = typeof SIZE_PRESETS[number] | 'custom';

  const [traderTab, setTraderTab] = useState<'stocks' | 'forex'>('stocks');
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [budgetStr, setBudgetStr] = useState(String(paperBudget));
  const [sizePreset, setSizePreset] = useState<SizePreset>(100);
  const [customSizeStr, setCustomSizeStr] = useState('');
  const [slPctStr, setSlPctStr] = useState('2');
  const [tpPctStr, setTpPctStr] = useState('4');
  const [sectors, setSectors] = useState<Sector[]>(['Technology']);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [runLog, setRunLog] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [copyTrade, setCopyTrade] = useState<DemoTrade | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [priceFlash, setPriceFlash] = useState<Record<string, 'up' | 'down' | null>>({});
  const [lastRefreshed, setLastRefreshed] = useState<number>(0);
  const [tick, setTick] = useState(0);
  const [apiCalls, setApiCalls] = useState(0);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevPricesRef = useRef<Record<string, number>>({});

  // ── Restore paper state from dedicated localStorage keys on mount ──────────
  useEffect(() => {
    try {
      const rawPos = localStorage.getItem('paper_positions');
      const rawTrades = localStorage.getItem('paper_trades');
      const rawBudget = localStorage.getItem('paper_budget');
      if (rawPos) {
        const positions = JSON.parse(rawPos) as DemoPosition[];
        if (Array.isArray(positions) && positions.length > 0) setPaperPositions(positions);
      }
      if (rawTrades) {
        const trades = JSON.parse(rawTrades) as DemoTrade[];
        if (Array.isArray(trades) && trades.length > 0) setPaperTrades(trades);
      }
      if (rawBudget) {
        const budget = Number(JSON.parse(rawBudget));
        if (budget > 0) { setPaperBudget(budget); setBudgetStr(String(budget)); }
      }
    } catch { /* ignore parse errors */ }
    // Clear pending signal badge when page mounts
    setPendingSignalCount(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-run strategy if 10+ minutes have passed since last run
  useEffect(() => {
    const lastRun = localStorage.getItem('last_signal_run');
    if (lastRun) {
      const minsAgo = (Date.now() - Number(lastRun)) / 60_000;
      if (minsAgo >= 10 && !scanning) {
        const t = setTimeout(() => runStrategy(), 1500);
        return () => clearTimeout(t);
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const liveEncoded = t212ApiKey && t212ApiSecret
    ? btoa(t212ApiKey + ':' + t212ApiSecret)
    : '';

  // ── Account calculations ───────────────────────────────────────────────────
  const currentlyInvested = demoPositions.reduce((s, p) => s + p.entryPrice * p.quantity, 0);
  const availableBalance = Math.max(0, paperBudget - currentlyInvested);
  const totalOpenPnL = demoPositions.reduce((s, p) => s + p.pnl, 0);
  const totalClosedPnL = demoTrades.reduce((s, t) => s + t.pnl, 0);
  const totalPaperPnL = totalOpenPnL + totalClosedPnL;

  // Manual mode: fixed trade size from preset buttons
  const manualTradeSize = sizePreset === 'custom'
    ? (parseInt(customSizeStr.replace(/[^0-9]/g, ''), 10) || 0)
    : sizePreset;

  // Auto mode: size based on signal confidence (score is 0–100)
  function autoTradeSize(score: number): number {
    if (score > 80) return availableBalance * 0.05;   // High: 5%
    if (score > 70) return availableBalance * 0.03;   // Medium: 3%
    return availableBalance * 0.01;                   // Lower: 1%
  }

  const slPct = parseFloat(slPctStr) || 2;
  const tpPct = parseFloat(tpPctStr) || 4;

  function commitBudget() {
    const raw = budgetStr.replace(/[^0-9]/g, '');
    const val = raw === '' ? 0 : parseInt(raw, 10);
    if (val > 0) setPaperBudget(val);
    else setBudgetStr(String(paperBudget));
  }

  function handleReset() {
    resetPaperAccount();
    setPaperBudget(1000);
    setBudgetStr('1000');
    setConfirmReset(false);
  }

  // ── Refresh prices for open positions ──────────────────────────────────────
  const refreshPrices = useCallback(async (silent = false) => {
    if (demoPositions.length === 0) return;
    if (!silent) setRefreshing(true);

    try {
      const symbols = [...new Set(demoPositions.map(p => p.ticker))];
      const res = await fetch('/api/demo-trader/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols }),
      });
      if (!res.ok) return;
      const data = await res.json() as { prices: Record<string, number> };

      // Compute flash states before updating
      const newFlash: Record<string, 'up' | 'down' | null> = {};

      for (const pos of demoPositions) {
        const currentPrice = data.prices[pos.ticker];
        if (!currentPrice || currentPrice <= 0) continue;

        const prevPrice = prevPricesRef.current[pos.ticker];
        if (prevPrice && prevPrice > 0) {
          newFlash[pos.ticker] = currentPrice > prevPrice ? 'up' : currentPrice < prevPrice ? 'down' : null;
        }
        prevPricesRef.current[pos.ticker] = currentPrice;

        const pnl = (currentPrice - pos.entryPrice) * pos.quantity;
        const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        updateDemoPosition(pos.id, { currentPrice, pnl, pnlPct });

        // Check SL/TP
        if (currentPrice <= pos.stopLoss || currentPrice >= pos.takeProfit) {
          const closeReason: DemoTrade['closeReason'] =
            currentPrice <= pos.stopLoss ? 'stop-loss' : 'take-profit';
          addDemoTrade({
            id: uid(),
            ticker: pos.ticker,
            t212Ticker: pos.t212Ticker,
            companyName: pos.companyName,
            sector: pos.sector,
            quantity: pos.quantity,
            entryPrice: pos.entryPrice,
            exitPrice: currentPrice,
            pnl,
            pnlPct,
            openedAt: pos.openedAt,
            closedAt: new Date().toISOString(),
            closeReason,
          });
          removeDemoPosition(pos.id);

          // Push notification for SL/TP hit
          const isTP = closeReason === 'take-profit';
          sendPush(
            isTP ? `Take-Profit Hit — ${pos.ticker}` : `Stop-Loss Hit — ${pos.ticker}`,
            `${pos.companyName} · ${fmtPct(pnlPct)} · Entry ${fmtUSD(pos.entryPrice)} → Exit ${fmtUSD(currentPrice)}`,
            '/demo-trader'
          );
        }
      }

      // Apply flashes, then clear after 900ms
      if (Object.keys(newFlash).length > 0) {
        setPriceFlash(newFlash);
        setTimeout(() => setPriceFlash({}), 900);
      }
      setLastRefreshed(Date.now());
    } catch {
      // Ignore refresh errors silently
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, [demoPositions, updateDemoPosition, addDemoTrade, removeDemoPosition]);

  // 60-second background price refresh
  useEffect(() => {
    intervalRef.current = setInterval(() => refreshPrices(true), 60_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [refreshPrices]);

  // 1-second tick for countdown display
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const secondsAgo = lastRefreshed > 0 ? Math.floor((Date.now() - lastRefreshed) / 1000) : null;
  void tick; // used only to trigger re-render for countdown

  // ── Run strategy ───────────────────────────────────────────────────────────
  async function runStrategy() {
    setScanning(true);
    setScanError(null);
    setRunLog([]);

    try {
      const selectedSectors = sectors.includes('All') ? ['All'] : sectors;
      setRunLog(l => [...l, `📡 Scanning ${selectedSectors.join(', ')} via Finnhub…`]);

      const sigRes = await fetch('/api/demo-trader/signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectors: selectedSectors }),
      });
      const sigData = await sigRes.json() as {
        signals?: Signal[]; error?: string;
        scannedCount?: number; candidateCount?: number; apiCallsUsed?: number;
      };

      if (sigData.error) { setScanError(sigData.error); return; }

      const allSignals = sigData.signals ?? [];
      setSignals(allSignals);
      setApiCalls(sigData.apiCallsUsed ?? 0);
      setRunLog(l => [...l, `✓ Scanned ${sigData.scannedCount ?? 0} stocks (${sigData.candidateCount ?? 0} momentum candidates) — ${allSignals.filter(s => s.signal === 'BUY').length} BUY · ${allSignals.filter(s => s.signal === 'SELL').length} SELL signals. ${sigData.apiCallsUsed ?? 0} API calls used.`]);

      // Push notifications for strong signals (score > 70)
      for (const sig of allSignals) {
        if (sig.score > 70) {
          sendPush(
            `${sig.signal} Signal — ${sig.symbol}`,
            `${sig.name} · Strength ${sig.score}% · $${sig.currentPrice.toFixed(2)} (${sig.changePercent >= 0 ? '+' : ''}${sig.changePercent.toFixed(2)}%)`,
            '/demo-trader'
          );
        }
      }

      const buys = allSignals.filter(s => s.signal === 'BUY').slice(0, 3);
      if (buys.length === 0) {
        setRunLog(l => [...l, 'ℹ No strong BUY signals — strategy not executed.']);
        return;
      }

      if (mode === 'manual' && manualTradeSize <= 0) {
        setRunLog(l => [...l, '⚠ Trade size is £0 — set a position size first.']);
        return;
      }

      setRunLog(l => [...l, `📋 Opening ${buys.length} paper position(s) in ${mode} mode…`]);

      for (const signal of buys) {
        const entryPrice = signal.currentPrice;
        const size = mode === 'auto' ? autoTradeSize(signal.score) : manualTradeSize;
        const quantity = Math.max(1, Math.floor(size / entryPrice));
        const sl = entryPrice * (1 - slPct / 100);
        const tp = entryPrice * (1 + tpPct / 100);

        const position: DemoPosition = {
          id: uid(),
          ticker: signal.symbol,
          t212Ticker: signal.t212Ticker,
          companyName: signal.name,
          sector: signal.sector,
          quantity,
          entryPrice,
          currentPrice: entryPrice,
          stopLoss: sl,
          takeProfit: tp,
          pnl: 0,
          pnlPct: 0,
          openedAt: new Date().toISOString(),
          signal: signal.reason,
        };

        addDemoPosition(position);
        const sizeLabel = mode === 'auto' ? `auto ${fmtGBP(size)} (${signal.score}% conf)` : fmtGBP(size);
        setRunLog(l => [
          ...l,
          `  → PAPER BUY ${quantity}× ${signal.symbol} @ ${fmtUSD(entryPrice)} [${sizeLabel}] SL ${fmtUSD(sl)} TP ${fmtUSD(tp)}`,
        ]);
      }

      setRunLog(l => [...l, '✅ Strategy complete — positions tracked in paper engine.']);
      localStorage.setItem('last_signal_run', Date.now().toString());
      // Update pending signal count for sidebar badge
      const buyCount = allSignals.filter(s => s.signal === 'BUY').length;
      if (buyCount > 0) setPendingSignalCount(buyCount);
    } catch (err) {
      setScanError(`Strategy failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScanning(false);
    }
  }

  // ── Manual close ───────────────────────────────────────────────────────────
  function closePosition(pos: DemoPosition) {
    addDemoTrade({
      id: uid(),
      ticker: pos.ticker,
      t212Ticker: pos.t212Ticker,
      companyName: pos.companyName,
      sector: pos.sector,
      quantity: pos.quantity,
      entryPrice: pos.entryPrice,
      exitPrice: pos.currentPrice,
      pnl: pos.pnl,
      pnlPct: pos.pnlPct,
      openedAt: pos.openedAt,
      closedAt: new Date().toISOString(),
      closeReason: 'manual',
    });
    removeDemoPosition(pos.id);
  }

  function toggleSector(s: Sector) {
    if (s === 'All') { setSectors(['All']); return; }
    setSectors(prev => {
      const without = prev.filter(x => x !== 'All');
      return without.includes(s)
        ? (without.filter(x => x !== s).length ? without.filter(x => x !== s) : ['Technology'])
        : [...without, s];
    });
  }

  // ── Performance stats ──────────────────────────────────────────────────────
  const wins = demoTrades.filter(t => t.pnl > 0);
  const winRate = demoTrades.length > 0 ? (wins.length / demoTrades.length) * 100 : 0;
  const bestTrade = demoTrades.reduce<DemoTrade | null>((b, t) => (!b || t.pnl > b.pnl ? t : b), null);
  const worstTrade = demoTrades.reduce<DemoTrade | null>((w, t) => (!w || t.pnl < w.pnl ? t : w), null);

  const sevenDaysAgo = Date.now() - 7 * 86_400_000;
  const profitableTrades = demoTrades.filter(
    t => t.pnl > 0 && new Date(t.closedAt).getTime() > sevenDaysAgo
  );

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {copyTrade && (
        <CopyToLiveModal
          trade={copyTrade}
          liveEncoded={liveEncoded}
          positionSize={manualTradeSize}
          onClose={() => setCopyTrade(null)}
          onDone={() => setCopyTrade(null)}
        />
      )}

      {/* Confirm reset dialog */}
      {confirmReset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={() => setConfirmReset(false)} />
          <div className="relative bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-sm shadow-2xl p-6">
            <h2 className="text-base font-semibold text-white mb-2">Reset Paper Account?</h2>
            <p className="text-sm text-gray-400 mb-5">
              This will permanently clear all open positions and trade history. Your paper budget will remain at {fmtGBP(paperBudget)}.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" fullWidth onClick={() => setConfirmReset(false)}>Cancel</Button>
              <Button fullWidth onClick={handleReset} icon={<RotateCcw className="h-4 w-4" />}>
                Reset Account
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <FlaskConical className="h-6 w-6 text-amber-400" />
          Demo Auto-Trader
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Automated paper trading · signals from Finnhub · no real money involved
        </p>
      </div>

      {/* Paper trading banner */}
      <div className="mb-6 flex items-start gap-2 bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3">
        <Info className="h-4 w-4 text-blue-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-blue-200/80">
          <strong className="text-blue-300">Paper trading — simulated positions using real live prices. No real money involved.</strong>{' '}
          Positions are tracked internally using live Finnhub prices. T212 DEMO API does not support order placement, so all trades are simulated here. Use <em>Copy to Live</em> to place real orders on your live T212 account.
        </p>
      </div>

      {/* Tab toggle */}
      <div className="flex gap-1 mb-4 bg-gray-800/60 rounded-xl p-1 w-fit">
        {(['stocks', 'forex'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setTraderTab(tab)}
            className={clsx(
              'px-4 py-1.5 rounded-lg text-sm font-medium transition-all capitalize',
              traderTab === tab
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                : 'text-gray-500 hover:text-gray-300'
            )}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {traderTab === 'forex' ? (
        <ForexTrader />
      ) : (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: controls */}
        <div className="space-y-4">

          {/* Paper Balance */}
          <Card>
            <CardHeader title="Paper Balance" subtitle="Simulated account" icon={<Wallet className="h-4 w-4" />} />
            <div className="space-y-2 mb-4">
              {[
                { label: 'Total Budget', value: fmtGBP(paperBudget), color: 'text-white' },
                { label: 'Available', value: fmtGBP(availableBalance), color: availableBalance > 0 ? 'text-emerald-400' : 'text-gray-500' },
                { label: 'Invested', value: fmtGBP(currentlyInvested), color: 'text-amber-400' },
                { label: 'Open Positions', value: String(demoPositions.length), color: demoPositions.length > 0 ? 'text-white' : 'text-gray-500' },
                { label: 'Total P&L', value: `${totalPaperPnL >= 0 ? '+' : ''}${fmtGBP(totalPaperPnL)}`, color: totalPaperPnL > 0 ? 'text-emerald-400' : totalPaperPnL < 0 ? 'text-red-400' : 'text-gray-500' },
              ].map(row => (
                <div key={row.label} className="flex justify-between items-center">
                  <span className="text-xs text-gray-500">{row.label}</span>
                  <span className={clsx('text-sm font-semibold font-mono', row.color)}>{row.value}</span>
                </div>
              ))}
            </div>
            <div className="border-t border-gray-800 pt-3 space-y-3">
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block">Paper Budget</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">£</span>
                    <input
                      type="text" inputMode="numeric"
                      value={budgetStr}
                      onChange={e => setBudgetStr(e.target.value.replace(/[^0-9]/g, ''))}
                      onBlur={commitBudget}
                      onKeyDown={e => e.key === 'Enter' && commitBudget()}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
                      placeholder="1000"
                    />
                  </div>
                  <Button size="sm" variant="outline" onClick={commitBudget}>Set</Button>
                </div>
              </div>
              <button
                onClick={() => setConfirmReset(true)}
                className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-red-400 transition-colors"
              >
                <RotateCcw className="h-3 w-3" />
                Reset Paper Account
              </button>
            </div>
          </Card>

          {/* Strategy Settings */}
          <Card>
            <CardHeader title="Strategy Settings" subtitle="Mode, position size and sectors" icon={<Target className="h-4 w-4" />} />
            <div className="space-y-4">

              {/* Mode toggle */}
              <div>
                <label className="text-xs text-gray-400 mb-2 block">Trading Mode</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {(['auto', 'manual'] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className={clsx(
                        'py-2.5 rounded-xl text-sm font-semibold transition-all border',
                        mode === m
                          ? 'bg-amber-500/25 text-amber-300 border-amber-500/50'
                          : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-gray-200 hover:border-gray-600'
                      )}
                    >
                      {m === 'auto' ? '⚡ Automatic' : '🎛 Manual'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Auto mode explanation */}
              {mode === 'auto' && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 text-xs text-amber-200/80 space-y-1.5">
                  <p className="font-semibold text-amber-300">System auto-sizes positions by confidence:</p>
                  <div className="space-y-1 text-amber-200/70">
                    <div className="flex justify-between"><span>High confidence (&gt;80%)</span><span className="font-mono">5% of available</span></div>
                    <div className="flex justify-between"><span>Medium confidence (70–80%)</span><span className="font-mono">3% of available</span></div>
                    <div className="flex justify-between"><span>Lower confidence (60–70%)</span><span className="font-mono">1% of available</span></div>
                  </div>
                  <p className="text-amber-200/50 text-[11px]">Stop-loss −2% · Take-profit +4% (fixed)</p>
                </div>
              )}

              {/* Manual mode controls */}
              {mode === 'manual' && (
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-gray-400 mb-2 block">Position Size Per Trade</label>
                    <div className="grid grid-cols-5 gap-1.5 mb-2">
                      {SIZE_PRESETS.map(amt => (
                        <button
                          key={amt}
                          onClick={() => setSizePreset(amt)}
                          className={clsx(
                            'py-2.5 rounded-xl text-sm font-bold transition-all border',
                            sizePreset === amt
                              ? 'bg-amber-500/25 text-amber-300 border-amber-500/50'
                              : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-gray-200 hover:border-gray-600'
                          )}
                        >
                          £{amt}
                        </button>
                      ))}
                      <button
                        onClick={() => setSizePreset('custom')}
                        className={clsx(
                          'py-2.5 rounded-xl text-sm font-bold transition-all border',
                          sizePreset === 'custom'
                            ? 'bg-amber-500/25 text-amber-300 border-amber-500/50'
                            : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-gray-200 hover:border-gray-600'
                        )}
                      >
                        Custom
                      </button>
                    </div>
                    {sizePreset === 'custom' && (
                      <div className="relative mb-2">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">£</span>
                        <input
                          type="text" inputMode="numeric" autoFocus
                          value={customSizeStr}
                          onChange={e => setCustomSizeStr(e.target.value.replace(/[^0-9]/g, ''))}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
                          placeholder="Enter amount"
                        />
                      </div>
                    )}
                    <p className="text-xs text-gray-500">
                      Each trade will use <span className="text-amber-400 font-semibold">{fmtGBP(manualTradeSize)}</span> of your <span className="text-white font-semibold">{fmtGBP(paperBudget)}</span> budget
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-gray-400 mb-1.5 block">Stop-loss %</label>
                      <div className="relative">
                        <input
                          type="text" inputMode="decimal"
                          value={slPctStr}
                          onChange={e => setSlPctStr(e.target.value.replace(/[^0-9.]/g, ''))}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-3 pr-7 py-2 text-sm text-white focus:outline-none focus:border-red-500"
                          placeholder="2"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">%</span>
                      </div>
                      <p className="text-[11px] text-gray-600 mt-1">−{slPct}% from entry</p>
                    </div>
                    <div>
                      <label className="text-xs text-gray-400 mb-1.5 block">Take-profit %</label>
                      <div className="relative">
                        <input
                          type="text" inputMode="decimal"
                          value={tpPctStr}
                          onChange={e => setTpPctStr(e.target.value.replace(/[^0-9.]/g, ''))}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-3 pr-7 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                          placeholder="4"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">%</span>
                      </div>
                      <p className="text-[11px] text-gray-600 mt-1">+{tpPct}% from entry</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Sectors */}
              <div>
                <label className="text-xs text-gray-400 mb-2 block">Sectors</label>
                <div className="flex flex-wrap gap-1.5">
                  {SECTORS.map(s => (
                    <button
                      key={s} onClick={() => toggleSector(s)}
                      className={clsx(
                        'px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
                        sectors.includes(s)
                          ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                          : 'bg-gray-800 text-gray-500 border border-gray-700 hover:text-gray-300'
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-gray-800/50 rounded-lg px-3 py-2 text-xs text-gray-500 space-y-0.5">
                {mode === 'auto' ? (
                  <>
                    <div className="flex justify-between"><span>Stop-loss</span><span className="text-red-400">−2% (auto)</span></div>
                    <div className="flex justify-between"><span>Take-profit</span><span className="text-emerald-400">+4% (auto)</span></div>
                  </>
                ) : (
                  <>
                    <div className="flex justify-between"><span>Stop-loss</span><span className="text-red-400">−{slPct}%</span></div>
                    <div className="flex justify-between"><span>Take-profit</span><span className="text-emerald-400">+{tpPct}%</span></div>
                  </>
                )}
                <div className="flex justify-between"><span>Max positions / run</span><span>3 (top BUY signals)</span></div>
                <div className="flex justify-between"><span>Price refresh</span><span>every 60s</span></div>
              </div>
            </div>
          </Card>

          <Button
            onClick={runStrategy}
            loading={scanning}
            fullWidth
            icon={scanning ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          >
            {scanning ? 'Scanning & opening positions…' : 'Run Strategy'}
          </Button>

          {scanError && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              {scanError}
            </div>
          )}

          {runLog.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 font-mono text-[11px] text-gray-400 space-y-0.5 max-h-48 overflow-y-auto">
              {runLog.map((line, i) => <p key={i}>{line}</p>)}
            </div>
          )}
        </div>

        {/* Right: signals + positions */}
        <div className="lg:col-span-2 space-y-4">

          {/* Signals */}
          {signals.length > 0 && (
            <Card>
              <CardHeader
                title="Latest Signals"
                subtitle={`${signals.length} stocks · sorted by profit potential`}
                icon={<BarChart3 className="h-4 w-4" />}
                action={
                  apiCalls > 0 ? (
                    <span className="text-[10px] text-gray-600 bg-gray-800 px-2 py-0.5 rounded-full">
                      {apiCalls} API calls
                    </span>
                  ) : undefined
                }
              />
              <p className="px-4 pb-2 text-[10px] text-gray-600">
                Selected based on momentum, volume surge, and news catalysts — not company size
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="text-left py-2 pr-3">Stock</th>
                      <th className="text-right py-2 pr-3">Price</th>
                      <th className="text-right py-2 pr-3">Change</th>
                      <th className="text-center py-2 pr-3">Signal</th>
                      <th className="text-right py-2 pr-3">Profit Score</th>
                      <th className="text-left py-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {signals.slice(0, 8).map(s => (
                      <tr key={s.symbol} className="border-b border-gray-800/50">
                        <td className="py-1.5 pr-3">
                          <div className="flex items-center gap-1">
                            {s.isUK && <span title="London Stock Exchange">🇬🇧</span>}
                            <TickerTooltip symbol={s.symbol}>
                              <p className="font-semibold text-white">{s.symbol.replace('.L', '')}</p>
                            </TickerTooltip>
                          </div>
                          <p className="text-gray-600">{s.sector}</p>
                          {s.badges.length > 0 && (
                            <p className="text-[10px] text-gray-500 mt-0.5 space-x-1">{s.badges.join(' ')}</p>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono text-gray-300">
                          {s.isUK ? fmtGBP(s.currentPrice) : fmtUSD(s.currentPrice)}
                        </td>
                        <td className={clsx('py-1.5 pr-3 text-right font-mono', s.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {fmtPct(s.changePercent)}
                        </td>
                        <td className="py-1.5 pr-3 text-center">
                          <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold', s.signal === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : s.signal === 'SELL' ? 'bg-red-500/20 text-red-400' : 'bg-gray-700 text-gray-400')}>
                            {s.signal}
                          </span>
                        </td>
                        <td className={clsx('py-1.5 pr-3 text-right font-mono', s.score >= 70 ? 'text-amber-400' : s.score >= 50 ? 'text-gray-300' : 'text-gray-500')}>
                          {s.score}/100
                        </td>
                        <td className="py-1.5 text-gray-500 truncate max-w-[180px]">{s.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Open paper positions */}
          <Card>
            <CardHeader
              title="Open Paper Positions"
              subtitle={`${demoPositions.length} positions · simulated at real prices`}
              icon={<FlaskConical className="h-4 w-4" />}
              action={
                demoPositions.length > 0 ? (
                  <div className="flex items-center gap-2">
                    {secondsAgo !== null && (
                      <span className="text-[10px] text-gray-600 flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {secondsAgo < 5 ? 'Just updated' : `${secondsAgo}s ago`}
                      </span>
                    )}
                    <button
                      onClick={() => refreshPrices(false)}
                      disabled={refreshing}
                      className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"
                    >
                      <RefreshCw className={clsx('h-3 w-3', refreshing && 'animate-spin')} />
                      Refresh
                    </button>
                  </div>
                ) : undefined
              }
            />
            {demoPositions.length === 0 ? (
              <p className="text-sm text-gray-600 text-center py-6">
                No open paper positions. Run the strategy to open trades.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="text-left py-2 pr-3">Stock</th>
                      <th className="text-right py-2 pr-3">Qty</th>
                      <th className="text-right py-2 pr-3">Entry $</th>
                      <th className="text-right py-2 pr-3">Current $</th>
                      <th className="text-right py-2 pr-3">SL $</th>
                      <th className="text-right py-2 pr-3">TP $</th>
                      <th className="text-right py-2 pr-3">P&L £</th>
                      <th className="text-right py-2">×</th>
                    </tr>
                  </thead>
                  <tbody>
                    {demoPositions.map(pos => (
                      <tr key={pos.id} className="border-b border-gray-800/50">
                        <td className="py-1.5 pr-3">
                          <TickerTooltip symbol={pos.ticker}>
                            <p className="font-semibold text-white">{pos.ticker}</p>
                          </TickerTooltip>
                          <p className="text-gray-600">{hoursAgo(pos.openedAt)}</p>
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono text-gray-300">{pos.quantity}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-gray-300">{fmtUSD(pos.entryPrice)}</td>
                        <td className={clsx('py-1.5 pr-3 text-right font-mono text-gray-300 rounded',
                          priceFlash[pos.ticker] === 'up' ? 'price-flash-up' :
                          priceFlash[pos.ticker] === 'down' ? 'price-flash-down' : ''
                        )}>{fmtUSD(pos.currentPrice)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-red-400">{fmtUSD(pos.stopLoss)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-emerald-400">{fmtUSD(pos.takeProfit)}</td>
                        <td className={clsx('py-1.5 pr-3 text-right font-mono font-semibold', pos.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {pos.pnl >= 0 ? '+' : ''}{fmtGBP(pos.pnl)}
                        </td>
                        <td className="py-1.5 text-right">
                          <button onClick={() => closePosition(pos)} className="text-gray-600 hover:text-red-400 transition-colors">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Performance summary */}
          {demoTrades.length > 0 && (
            <Card>
              <CardHeader title="Performance Summary" subtitle={`${demoTrades.length} closed trades`} icon={<Trophy className="h-4 w-4" />} />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                {[
                  { label: 'Closed P&L', value: `${totalClosedPnL >= 0 ? '+' : ''}${fmtGBP(totalClosedPnL)}`, color: totalClosedPnL >= 0 ? 'text-emerald-400' : 'text-red-400' },
                  { label: 'Win Rate', value: `${winRate.toFixed(0)}%`, color: winRate >= 50 ? 'text-emerald-400' : 'text-red-400' },
                  { label: 'Best Trade', value: bestTrade ? `+${fmtGBP(bestTrade.pnl)} (${bestTrade.ticker})` : '—', color: 'text-emerald-400' },
                  { label: 'Worst Trade', value: worstTrade ? `${fmtGBP(worstTrade.pnl)} (${worstTrade.ticker})` : '—', color: 'text-red-400' },
                ].map(stat => (
                  <div key={stat.label} className="bg-gray-800/50 rounded-lg px-3 py-2.5">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">{stat.label}</p>
                    <p className={clsx('text-sm font-semibold font-mono', stat.color)}>{stat.value}</p>
                  </div>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="text-left py-2 pr-3">Stock</th>
                      <th className="text-right py-2 pr-3">Entry $</th>
                      <th className="text-right py-2 pr-3">Exit $</th>
                      <th className="text-right py-2 pr-3">P&L £</th>
                      <th className="text-center py-2 pr-3">Close</th>
                      <th className="text-right py-2">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {demoTrades.slice(0, 15).map(trade => (
                      <tr key={trade.id} className="border-b border-gray-800/50">
                        <td className="py-1.5 pr-3 font-semibold text-white">{trade.ticker}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-gray-300">{fmtUSD(trade.entryPrice)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-gray-300">{fmtUSD(trade.exitPrice)}</td>
                        <td className={clsx('py-1.5 pr-3 text-right font-mono font-semibold', trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {trade.pnl >= 0 ? '+' : ''}{fmtGBP(trade.pnl)} ({fmtPct(trade.pnlPct)})
                        </td>
                        <td className="py-1.5 pr-3 text-center">
                          <span className={clsx('px-1.5 py-0.5 rounded text-[10px]',
                            trade.closeReason === 'take-profit' ? 'bg-emerald-500/20 text-emerald-400' :
                            trade.closeReason === 'stop-loss' ? 'bg-red-500/20 text-red-400' :
                            'bg-gray-700 text-gray-400'
                          )}>
                            {trade.closeReason}
                          </span>
                        </td>
                        <td className="py-1.5 text-right text-gray-500">{hoursAgo(trade.closedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Copy to Live */}
          {profitableTrades.length > 0 && (
            <Card>
              <CardHeader
                title="Copy to Live Account"
                subtitle="Profitable paper trades from last 7 days"
                icon={<Copy className="h-4 w-4" />}
              />
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-3 text-xs text-amber-300">
                <strong>⚠ YOU are making this decision.</strong> Copying places a real market order on your live T212 account with real money. This is not financial advice.
              </div>
              {!liveEncoded && (
                <p className="text-xs text-gray-500 mb-3">Connect your live T212 account in Settings to enable copy trading.</p>
              )}
              <div className="space-y-2">
                {profitableTrades.map(trade => (
                  <div key={trade.id} className="flex items-center justify-between bg-gray-800/40 rounded-lg px-3 py-2.5 gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-white truncate">
                        {trade.ticker} <span className="text-xs text-gray-500 font-normal">{trade.companyName}</span>
                      </p>
                      <p className="text-xs text-gray-500">
                        Entry {fmtUSD(trade.entryPrice)} → Exit {fmtUSD(trade.exitPrice)} · {hoursAgo(trade.closedAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <div className="text-right">
                        <p className="text-sm font-semibold text-emerald-400 font-mono">+{fmtGBP(trade.pnl)}</p>
                        <p className="text-xs text-emerald-400/70">{fmtPct(trade.pnlPct)}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        icon={<ArrowRight className="h-3.5 w-3.5" />}
                        onClick={() => setCopyTrade(trade)}
                        disabled={!liveEncoded}
                      >
                        Copy
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

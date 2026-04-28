'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  TrendingUp, TrendingDown, RefreshCw, ChevronDown, ChevronUp,
  CheckCircle2, AlertCircle, Target, Zap, Info,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { IG_STOCK_EPICS, exchangeFlag } from '@/lib/ig-stock-epics';
import {
  calculateStockRisk, volatilityLabel, volatilityColor,
  type StockRiskProfile,
} from '@/lib/stock-risk-calculator';

// ── Types ──────────────────────────────────────────────────────────────────────

type IGSession = { cst: string; securityToken: string; accountId: string; apiKey: string };

type RawSignal = {
  symbol:     string;
  name:       string;
  score:      number;
  currentPrice: number;
  signal:     'BUY' | 'SELL' | 'NEUTRAL';
  confidence: number;
  reasoning:  string;
};

type StockOpportunity = {
  id:           string;
  ticker:       string;
  epic:         string;
  name:         string;
  exchange:     string;
  currency:     string;
  direction:    'LONG' | 'SHORT';
  conviction:   number;
  reasoning:    string;
  currentPrice: number;
  riskProfile:  StockRiskProfile;
  generatedAt:  string;
};

type OrderResult = {
  ok:          boolean;
  dealReference?: string;
  dealId?:       string;
  dealStatus?:   string;
  level?:        number;
  error?:        string;
};

// ── Constants ──────────────────────────────────────────────────────────────────

const OPPS_KEY   = 'ig_stock_opportunities';
const REFRESH_MS = 15 * 60_000;

// ── Helpers ────────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9); }

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}

function save(key: string, val: unknown) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function minutesAgo(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
}

function rrLabel(rr: number): { text: string; color: string } {
  if (rr >= 2.0) return { text: 'Good risk/reward',   color: 'text-emerald-400' };
  if (rr >= 1.5) return { text: 'Acceptable',          color: 'text-amber-400'   };
  return              { text: 'Poor risk/reward',    color: 'text-red-400'     };
}

function makeHeaders(s: IGSession, env: 'demo' | 'live') {
  return {
    'x-ig-cst':            s.cst,
    'x-ig-security-token': s.securityToken,
    'x-ig-api-key':        s.apiKey,
    'x-ig-env':            env,
  };
}

// ── StockOpportunityCard ───────────────────────────────────────────────────────

interface CardProps {
  opp:            StockOpportunity;
  session:        IGSession | null | undefined;
  env:            'demo' | 'live';
  onSkip:         (id: string) => void;
  onApprove:      (id: string, stopPct: number, targetPct: number, size: number) => Promise<void>;
}

function StockOpportunityCard({ opp, session, env, onSkip, onApprove }: CardProps) {
  const rp = opp.riskProfile;

  const [stopPct,    setStopPct]    = useState(rp.suggestedStopPct);
  const [targetPct,  setTargetPct]  = useState(rp.suggestedTargetPct);
  const [size,       setSize]       = useState(rp.sizePerPoint);
  const [editMode,   setEditMode]   = useState(false);
  const [specifics,  setSpecifics]  = useState(false);
  const [placing,    setPlacing]    = useState(false);

  const price      = opp.currentPrice;
  const stopDist   = Math.max(1, Math.round(price * stopPct   / 100));
  const targetDist = Math.max(1, Math.round(price * targetPct / 100));
  const stopPrice  = opp.direction === 'LONG' ? price - stopDist  : price + stopDist;
  const tpPrice    = opp.direction === 'LONG' ? price + targetDist : price - targetDist;
  const maxRisk    = size * stopDist;
  const tpReward   = size * targetDist;
  const rr         = stopDist > 0 ? targetDist / stopDist : 0;
  const { text: rrText, color: rrColor } = rrLabel(rr);

  const betterEntry = opp.direction === 'LONG'
    ? price * 0.99
    : price * 1.01;

  const age     = minutesAgo(opp.generatedAt);
  const isStale = age > 60;

  async function handleApprove() {
    setPlacing(true);
    await onApprove(opp.id, stopPct, targetPct, size);
    setPlacing(false);
  }

  const vcBadge = volatilityColor(rp.volatilityClass);
  const vcLabel = volatilityLabel(rp.volatilityClass);

  return (
    <div className={clsx(
      'rounded-xl border bg-gray-900/80 p-4 space-y-3',
      isStale ? 'border-amber-500/30' : 'border-gray-700/60'
    )}>
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px]">{exchangeFlag(opp.exchange)}</span>
            <span className="text-sm font-bold text-white">{opp.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400 font-mono">{opp.ticker}</span>
            <span className={clsx('text-[10px] px-2 py-0.5 rounded-full font-semibold',
              opp.direction === 'LONG'
                ? 'bg-emerald-500/20 text-emerald-400'
                : 'bg-red-500/20 text-red-400'
            )}>
              {opp.direction === 'LONG' ? '▲ LONG' : '▼ SHORT'}
            </span>
            <span className={clsx('text-[10px] px-2 py-0.5 rounded-full', vcBadge)}>{vcLabel}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-800 text-gray-500">{rp.sector}</span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-400 flex-wrap">
            <span>{opp.currency === 'GBP' ? '🇬🇧 ' : '🇺🇸 '}{opp.currency === 'GBP' ? `${price.toFixed(0)}p` : `$${price.toFixed(2)}`}</span>
            <span className="text-blue-400">Conviction: {opp.conviction}%</span>
            <span>β={rp.beta} · ATR {rp.atr}%/day</span>
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <p className={clsx('text-[10px]', isStale ? 'text-amber-400' : 'text-gray-500')}>
            {isStale ? `⚠ ${age}m ago — may be stale` : `${age}m ago`}
          </p>
        </div>
      </div>

      {/* ── Conviction bar ──────────────────────────────────────────────────── */}
      <div>
        <div className="flex justify-between text-[10px] text-gray-500 mb-1">
          <span>AI Conviction</span>
          <span className={clsx('font-semibold',
            opp.conviction >= 80 ? 'text-emerald-400' :
            opp.conviction >= 65 ? 'text-blue-400' : 'text-amber-400'
          )}>{opp.conviction}%</span>
        </div>
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div className={clsx('h-full rounded-full',
            opp.conviction >= 80 ? 'bg-emerald-500' :
            opp.conviction >= 65 ? 'bg-blue-500' : 'bg-amber-500'
          )} style={{ width: `${opp.conviction}%` }} />
        </div>
      </div>

      {/* ── Risk profile row ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
        <div className="bg-gray-800/40 rounded-lg px-2.5 py-2">
          <p className="text-[9px] text-gray-500 uppercase mb-0.5">Stop Distance</p>
          <p className="text-white font-bold">{stopDist} pts ({stopPct}%)</p>
          <p className="text-red-400 text-[9px]">£{maxRisk.toFixed(0)} max loss</p>
        </div>
        <div className="bg-gray-800/40 rounded-lg px-2.5 py-2">
          <p className="text-[9px] text-gray-500 uppercase mb-0.5">Target Distance</p>
          <p className="text-white font-bold">{targetDist} pts ({targetPct}%)</p>
          <p className="text-emerald-400 text-[9px]">£{tpReward.toFixed(0)} target</p>
        </div>
        <div className="bg-gray-800/40 rounded-lg px-2.5 py-2">
          <p className="text-[9px] text-gray-500 uppercase mb-0.5">Size</p>
          <p className="text-white font-bold">£{size}/pt</p>
          <p className="text-gray-500 text-[9px]">spread bet size</p>
        </div>
        <div className="bg-gray-800/40 rounded-lg px-2.5 py-2">
          <p className="text-[9px] text-gray-500 uppercase mb-0.5">Risk/Reward</p>
          <p className={clsx('font-bold', rrColor)}>1:{rr.toFixed(1)}</p>
          <p className={clsx('text-[9px]', rrColor)}>{rrText}</p>
        </div>
      </div>

      {/* ── Customise controls ───────────────────────────────────────────────── */}
      {editMode && (
        <div className="bg-gray-800/40 rounded-xl p-3 space-y-3">
          <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Customise Levels</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] text-gray-500 mb-1 block">Stop Loss %</label>
              <input
                type="number"
                value={stopPct}
                onChange={e => setStopPct(Math.max(0.1, Number(e.target.value)))}
                step={0.1}
                min={0.1}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-red-500"
              />
              <p className="text-[9px] text-red-400 mt-0.5">
                Stop at {opp.currency === 'GBP' ? `${stopPrice.toFixed(0)}p` : `$${stopPrice.toFixed(2)}`}
              </p>
            </div>
            <div>
              <label className="text-[10px] text-gray-500 mb-1 block">Take Profit %</label>
              <input
                type="number"
                value={targetPct}
                onChange={e => setTargetPct(Math.max(0.1, Number(e.target.value)))}
                step={0.1}
                min={0.1}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500"
              />
              <p className="text-[9px] text-emerald-400 mt-0.5">
                Target {opp.currency === 'GBP' ? `${tpPrice.toFixed(0)}p` : `$${tpPrice.toFixed(2)}`}
              </p>
            </div>
            <div>
              <label className="text-[10px] text-gray-500 mb-1 block">Size (£/pt)</label>
              <input
                type="number"
                value={size}
                onChange={e => setSize(Math.max(0.1, Number(e.target.value)))}
                step={0.1}
                min={0.1}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
              />
              <p className="text-[9px] text-gray-500 mt-0.5">
                Max risk: £{maxRisk.toFixed(0)} · Target: £{tpReward.toFixed(0)}
              </p>
            </div>
          </div>
          <p className="text-[10px] text-gray-600">{rp.reasoning}</p>
        </div>
      )}

      {/* ── Trade Specifics panel ────────────────────────────────────────────── */}
      {specifics && (
        <div className="bg-gray-800/30 rounded-xl border border-gray-700/50 divide-y divide-gray-700/50 text-xs">
          {/* Header */}
          <div className="px-3 py-2 bg-gray-800/60 rounded-t-xl">
            <p className="text-[11px] font-bold text-white uppercase tracking-wider">
              Trade Specifics — {opp.name} ({opp.ticker})
            </p>
          </div>
          {/* Entry guidance */}
          <div className="px-3 py-2.5 space-y-1">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Entry Guidance</p>
            <p className="text-gray-300">
              Suggested entry:{' '}
              <span className="text-white font-mono">
                {opp.currency === 'GBP' ? `${price.toFixed(0)}p` : `$${price.toFixed(2)}`}
              </span>{' '}
              (current market price)
            </p>
            <p className="text-gray-400">
              Better entry if {opp.direction === 'LONG' ? 'dips' : 'rises'} to:{' '}
              <span className="text-blue-400 font-mono">
                {opp.currency === 'GBP' ? `${betterEntry.toFixed(0)}p` : `$${betterEntry.toFixed(2)}`}
              </span>{' '}
              (~1% {opp.direction === 'LONG' ? 'below' : 'above'} current)
            </p>
            <p className="text-gray-500 text-[10px]">Entry window: within the next 4 hours (signal valid ~1h)</p>
          </div>
          {/* Exit guidance */}
          <div className="px-3 py-2.5 space-y-1.5">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Exit Guidance</p>
            <div>
              <p className="text-emerald-400 font-semibold">
                Take Profit:{' '}
                {opp.currency === 'GBP' ? `${tpPrice.toFixed(0)}p` : `$${tpPrice.toFixed(2)}`}
                {' '}(+{targetPct}%)
              </p>
              <p className="text-gray-500 text-[10px]">
                Why: Typical move for {rp.volatilityClass.toLowerCase().replace('_', ' ')} volatility stock.
                Target profit: £{tpReward.toFixed(0)}
              </p>
            </div>
            <div>
              <p className="text-red-400 font-semibold">
                Stop Loss:{' '}
                {opp.currency === 'GBP' ? `${stopPrice.toFixed(0)}p` : `$${stopPrice.toFixed(2)}`}
                {' '}(-{stopPct}%)
              </p>
              <p className="text-gray-500 text-[10px]">
                Why: Accounts for normal {opp.ticker} daily fluctuation (ATR {rp.atr}%). Widened
                {rp.beta >= 1.5 ? ' for high beta stock.' : rp.beta < 0.8 ? ' — tighter stop acceptable for low beta.' : ' for typical market sensitivity.'}
                Max loss: £{maxRisk.toFixed(0)}
              </p>
            </div>
          </div>
          {/* Volatility context */}
          <div className="px-3 py-2.5">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold mb-1">Risk Context</p>
            <p className="text-gray-400 leading-relaxed">{rp.reasoning}</p>
          </div>
          {/* AI reasoning */}
          <div className="px-3 py-2.5">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold mb-1">AI Analysis</p>
            <p className="text-gray-300 leading-relaxed">{opp.reasoning}</p>
          </div>
        </div>
      )}

      {/* ── Action bar ───────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 flex-wrap pt-2 border-t border-gray-800">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSpecifics(v => !v)}
            className="flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 transition-colors"
          >
            <Info className="h-3 w-3" />
            {specifics ? 'Hide Specifics' : 'View Specifics'}
          </button>
          <button
            onClick={() => setEditMode(v => !v)}
            className="text-[11px] px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 transition-colors"
          >
            {editMode ? 'Done' : 'Customise Levels'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onSkip(opp.id)}
            disabled={placing}
            className="text-[11px] px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 transition-colors disabled:opacity-40"
          >
            Skip
          </button>
          <button
            onClick={() => void handleApprove()}
            disabled={placing || !session}
            className="flex items-center gap-1.5 text-[11px] px-4 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-semibold transition-colors disabled:opacity-40"
          >
            {placing
              ? <RefreshCw className="h-3 w-3 animate-spin" />
              : <Zap className="h-3 w-3" />}
            {placing ? 'Placing…' : 'Approve Spread Bet'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

interface IGStockOpportunitiesProps {
  session:          IGSession | null | undefined;
  env:              'demo' | 'live';
  availableCapital: number;
}

export function IGStockOpportunities({ session, env, availableCapital }: IGStockOpportunitiesProps) {
  const [opportunities, setOpportunities] = useState<StockOpportunity[]>([]);
  const [loading,       setLoading]       = useState(false);
  const [lastFetch,     setLastFetch]     = useState<string | null>(null);
  const [toast,         setToast]         = useState<{ ok: boolean; msg: string } | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load persisted opportunities ───────────────────────────────────────────
  useEffect(() => {
    setOpportunities(load<StockOpportunity[]>(OPPS_KEY, []));
  }, []);

  function showToast(ok: boolean, msg: string) {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 5000);
  }

  // ── Fetch opportunities from signals API ───────────────────────────────────
  const fetchOpportunities = useCallback(async (notify: boolean) => {
    setLoading(true);
    try {
      const r = await fetch('/api/demo-trader/signals?strategy=smart-money&num=20');
      if (!r.ok) { setLoading(false); return; }

      const d = await r.json() as { signals?: RawSignal[]; results?: RawSignal[] };
      const signals = (d.signals ?? d.results ?? []) as RawSignal[];

      // Only stocks we have an IG epic for, with a clear direction
      const eligible = signals.filter(s =>
        (s.signal === 'BUY' || s.signal === 'SELL') &&
        s.confidence >= 50 &&
        s.currentPrice > 0 &&
        IG_STOCK_EPICS[s.symbol.toUpperCase()]
      );

      setOpportunities(prev => {
        const existingTickers = new Set(prev.map(o => o.ticker));

        const newOnes: StockOpportunity[] = eligible
          .filter(s => !existingTickers.has(s.symbol.toUpperCase()))
          .map(s => {
            const ticker    = s.symbol.toUpperCase();
            const info      = IG_STOCK_EPICS[ticker];
            const direction: 'LONG' | 'SHORT' = s.signal === 'BUY' ? 'LONG' : 'SHORT';
            const capital   = Math.max(availableCapital, 500); // minimum for sizing calc
            const riskProfile = calculateStockRisk(ticker, s.currentPrice, direction, s.reasoning, capital);
            return {
              id:           uid(),
              ticker,
              epic:         info.epic,
              name:         info.name,
              exchange:     info.exchange,
              currency:     info.currency,
              direction,
              conviction:   s.confidence,
              reasoning:    s.reasoning,
              currentPrice: s.currentPrice,
              riskProfile,
              generatedAt:  new Date().toISOString(),
            };
          });

        if (newOnes.length === 0) return prev;

        const updated = [...prev, ...newOnes];
        save(OPPS_KEY, updated);

        if (notify && newOnes.length > 0 && typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
          const tickers = newOnes.map(o => o.ticker).join(', ');
          new Notification(
            `ClearGains: ${newOnes.length} new stock spread bet ${newOnes.length === 1 ? 'opportunity' : 'opportunities'}`,
            { body: tickers, icon: '/favicon.ico' }
          );
        }

        return updated;
      });

      setLastFetch(new Date().toISOString());
    } catch { /* ignore */ }
    setLoading(false);
  }, [availableCapital]);

  useEffect(() => {
    void fetchOpportunities(false);
    timerRef.current = setInterval(() => void fetchOpportunities(true), REFRESH_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchOpportunities]);

  // ── Skip ───────────────────────────────────────────────────────────────────
  function skip(id: string) {
    setOpportunities(prev => {
      const updated = prev.filter(o => o.id !== id);
      save(OPPS_KEY, updated);
      return updated;
    });
  }

  // ── Approve: place IG spread bet ───────────────────────────────────────────
  async function approveTrade(id: string, stopPct: number, targetPct: number, sizePerPoint: number) {
    const opp = opportunities.find(o => o.id === id);
    if (!opp || !session) return;

    const stopDistance   = Math.max(1, Math.round(opp.currentPrice * stopPct   / 100));
    const targetDistance = Math.max(1, Math.round(opp.currentPrice * targetPct / 100));

    try {
      const r = await fetch('/api/ig/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...makeHeaders(session, env) },
        body: JSON.stringify({
          epic:          opp.epic,
          direction:     opp.direction === 'LONG' ? 'BUY' : 'SELL',
          size:          sizePerPoint,
          orderType:     'MARKET',
          expiry:        'DFB',
          guaranteedStop: false,
          trailingStop:   false,
          forceOpen:      true,
          currencyCode:  'GBP',
          stopDistance,
          profitDistance: targetDistance,
        }),
      });
      const d = await r.json() as OrderResult;

      if (!d.ok) {
        showToast(false, `Order rejected: ${d.error ?? d.dealStatus ?? 'unknown'}`);
        return;
      }

      skip(id);

      const stopPrice   = opp.direction === 'LONG'
        ? (d.level ?? opp.currentPrice) - stopDistance
        : (d.level ?? opp.currentPrice) + stopDistance;
      const targetPrice = opp.direction === 'LONG'
        ? (d.level ?? opp.currentPrice) + targetDistance
        : (d.level ?? opp.currentPrice) - targetDistance;

      showToast(true,
        `Spread bet placed — ${opp.ticker} ${opp.direction} £${sizePerPoint}/pt` +
        ` · TP: ${targetPrice.toFixed(2)} | SL: ${stopPrice.toFixed(2)}`
      );
    } catch (e) {
      showToast(false, `Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const staleCount = opportunities.filter(o => minutesAgo(o.generatedAt) > 60).length;

  return (
    <div className="space-y-4">
      {/* Toast */}
      {toast && (
        <div className={clsx(
          'flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium',
          toast.ok
            ? 'bg-emerald-500/15 border border-emerald-500/25 text-emerald-400'
            : 'bg-red-500/15 border border-red-500/25 text-red-400'
        )}>
          {toast.ok
            ? <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
            : <AlertCircle  className="h-3.5 w-3.5 flex-shrink-0" />}
          {toast.msg}
        </div>
      )}

      <Card>
        <CardHeader
          title="Stock Spread Bet Opportunities"
          subtitle={
            opportunities.length > 0
              ? `${opportunities.length} stock${opportunities.length > 1 ? 's' : ''} with AI signals — intelligent TP/SL per stock volatility`
              : 'AI-predicted stock moves with volatility-calibrated stop and target levels'
          }
          icon={<Target className="h-4 w-4" />}
          action={
            <div className="flex items-center gap-2">
              {lastFetch && (
                <span className="text-[10px] text-gray-600">
                  {new Date(lastFetch).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
              <button
                onClick={() => void fetchOpportunities(false)}
                disabled={loading}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-white transition-colors disabled:opacity-40"
              >
                <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
                Refresh
              </button>
            </div>
          }
        />

        {!session && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-xs text-amber-400 mb-3 flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            Connect your IG account to approve and place spread bets on these stocks.
          </div>
        )}

        {opportunities.length > 0 && (
          <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2 text-xs text-orange-300 mb-3 flex items-start gap-2">
            <TrendingUp className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <span>
              AI found {opportunities.length} stock {opportunities.length === 1 ? 'opportunity' : 'opportunities'} with
              volatility-calibrated levels. Stops and targets are sized per each stock's beta and ATR.
              {staleCount > 0 && <span className="text-amber-400 ml-1">· {staleCount} may be stale (&gt;1h old)</span>}
            </span>
          </div>
        )}

        {opportunities.length === 0 ? (
          <div className="text-center py-8">
            <TrendingDown className="h-8 w-8 mx-auto mb-2 text-gray-700" />
            <p className="text-sm text-gray-500">No stock opportunities right now</p>
            <p className="text-xs text-gray-600 mt-1">Auto-refreshes every 15 minutes · or click Refresh</p>
          </div>
        ) : (
          <div className="space-y-3">
            {opportunities.map(opp => (
              <StockOpportunityCard
                key={opp.id}
                opp={opp}
                session={session}
                env={env}
                onSkip={skip}
                onApprove={approveTrade}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

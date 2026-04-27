'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  TrendingUp, Bell, RefreshCw, ChevronDown, ChevronUp,
  CheckCircle2, AlertCircle, Target, Zap, X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { useClearGainsStore } from '@/lib/store';

// ── Types ──────────────────────────────────────────────────────────────────────

type TimeHorizon = '1H' | '4H' | '1D' | '2D';

type TradeGuidance = {
  id: string;
  ticker: string;
  companyName: string;
  t212Ticker: string;
  currentPrice: number;
  direction: 'LONG' | 'SHORT';
  conviction: number;
  reasoning: string;
  keyDrivers: string[];
  suggestedTP: number;
  suggestedSL: number;
  suggestedAmount: number;
  timeHorizon: TimeHorizon;
  expectedMovePercent: number;
  generatedAt: string;
};

type ManagedPosition = {
  id: string;
  ticker: string;
  t212Ticker: string;
  companyName: string;
  quantity: number;
  entryPrice: number;
  amount: number;
  takeProfit: number;
  stopLoss: number;
  tpOrderId?: string;
  slOrderId?: string;
  openedAt: string;
  direction: 'LONG' | 'SHORT';
};

type LiveData = { currentPrice: number; ppl: number };

type RawSignal = {
  symbol: string;
  name: string;
  t212Ticker: string;
  score: number;
  currentPrice: number;
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  confidence: number;
  reasoning: string;
};

type OrderResult = {
  ok: boolean;
  fillPrice?: number;
  quantity?: number;
  orderId?: string | number;
  error?: string;
  orders?: Array<Record<string, unknown>>;
};

// ── Constants ──────────────────────────────────────────────────────────────────

const OPPORTUNITIES_KEY    = 't212_opportunities';
const MANAGED_KEY          = 't212_managed_positions';
const REFRESH_MS           = 15 * 60_000;

const PRESETS: Record<TimeHorizon, { tpPct: number; slPct: number }> = {
  '1H': { tpPct: 1.5,  slPct: 0.75  },
  '4H': { tpPct: 2.5,  slPct: 1.25  },
  '1D': { tpPct: 4.0,  slPct: 2.0   },
  '2D': { tpPct: 6.0,  slPct: 3.0   },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9); }

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}

function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function minutesAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
}

function rrRating(rr: number): { label: string; color: string } {
  if (rr >= 2.0) return { label: 'Good risk/reward', color: 'text-emerald-400' };
  if (rr >= 1.5) return { label: 'Acceptable',       color: 'text-amber-400'   };
  return              { label: 'Poor risk/reward',   color: 'text-red-400'     };
}

function signalToGuidance(sig: RawSignal, defaultAmount: number): TradeGuidance {
  const horizon: TimeHorizon = sig.score >= 80 ? '1D' : sig.score >= 65 ? '4H' : '1H';
  const { tpPct, slPct }     = PRESETS[horizon];
  const direction: 'LONG' | 'SHORT' = sig.signal === 'SELL' ? 'SHORT' : 'LONG';

  const tp = direction === 'LONG'
    ? sig.currentPrice * (1 + tpPct / 100)
    : sig.currentPrice * (1 - tpPct / 100);
  const sl = direction === 'LONG'
    ? sig.currentPrice * (1 - slPct / 100)
    : sig.currentPrice * (1 + slPct / 100);

  // Split reasoning into up-to-3 key drivers
  const sentences = sig.reasoning.match(/[^.!?]+[.!?]+/g) ?? [];
  const keyDrivers = sentences.slice(0, 3).map(s => s.trim()).filter(Boolean);

  return {
    id: uid(),
    ticker: sig.symbol,
    companyName: sig.name,
    t212Ticker: sig.t212Ticker,
    currentPrice: sig.currentPrice,
    direction,
    conviction: sig.confidence,
    reasoning: sig.reasoning,
    keyDrivers,
    suggestedTP: Math.round(tp * 100) / 100,
    suggestedSL: Math.round(sl * 100) / 100,
    suggestedAmount: defaultAmount,
    timeHorizon: horizon,
    expectedMovePercent: tpPct,
    generatedAt: new Date().toISOString(),
  };
}

// ── TradeGuidanceCard ──────────────────────────────────────────────────────────

interface CardProps {
  guidance: TradeGuidance;
  defaultAmount: number;
  onSkip: (id: string) => void;
  onApprove: (id: string, amount: number, tp: number, sl: number) => Promise<void>;
}

function TradeGuidanceCard({ guidance, defaultAmount, onSkip, onApprove }: CardProps) {
  const [amount, setAmount]         = useState(guidance.suggestedAmount || defaultAmount);
  const [takeProfit, setTakeProfit] = useState(guidance.suggestedTP);
  const [stopLoss, setStopLoss]     = useState(guidance.suggestedSL);
  const [placing, setPlacing]       = useState(false);
  const [expanded, setExpanded]     = useState(false);

  const { tpPct, slPct } = PRESETS[guidance.timeHorizon];
  const price  = guidance.currentPrice;
  const qty    = price > 0 ? amount / price : 0;
  const tpMove = ((takeProfit - price) / price) * 100;
  const slMove = ((stopLoss  - price) / price) * 100;
  const tpProfit = (takeProfit - price) * qty;
  const slLoss   = Math.abs((stopLoss - price) * qty);
  const rr       = slLoss > 0 ? Math.abs(tpProfit) / slLoss : 0;
  const { label: rrLabel, color: rrColor } = rrRating(rr);
  const age     = minutesAgo(guidance.generatedAt);
  const isStale = age > 60;

  async function handleApprove() {
    setPlacing(true);
    await onApprove(guidance.id, amount, takeProfit, stopLoss);
    setPlacing(false);
  }

  return (
    <div className={clsx(
      'rounded-xl border bg-gray-900/80 p-4 space-y-3',
      isStale ? 'border-amber-500/30' : 'border-gray-700/60'
    )}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white">{guidance.companyName}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400 font-mono">
              {guidance.ticker}
            </span>
            <span className={clsx(
              'text-[10px] px-2 py-0.5 rounded-full font-semibold',
              guidance.direction === 'LONG'
                ? 'bg-emerald-500/20 text-emerald-400'
                : 'bg-red-500/20 text-red-400'
            )}>
              {guidance.direction === 'LONG' ? '▲ LONG' : '▼ SHORT'}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">
              {guidance.timeHorizon} horizon
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-400 flex-wrap">
            <span>£{price.toFixed(2)}</span>
            <span className="text-blue-400">Conviction: {guidance.conviction}%</span>
            <span>Expected: +{guidance.expectedMovePercent}%</span>
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <p className={clsx('text-[10px]', isStale ? 'text-amber-400' : 'text-gray-500')}>
            {isStale
              ? `⚠ ${age}m ago — may be stale, prices have changed`
              : `Generated ${age}m ago — still valid`}
          </p>
          <button
            onClick={() => setExpanded(v => !v)}
            className="text-[10px] text-gray-600 hover:text-gray-400 mt-0.5 flex items-center gap-0.5 ml-auto"
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {expanded ? 'Less' : 'AI analysis'}
          </button>
        </div>
      </div>

      {/* AI Analysis (expanded) */}
      {expanded && (
        <div className="bg-gray-800/50 rounded-lg p-3 space-y-2 text-xs">
          <p className="text-gray-300 leading-relaxed">{guidance.reasoning}</p>
          {guidance.keyDrivers.length > 0 && (
            <div className="space-y-1 pt-1 border-t border-gray-700/50">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Key Drivers</p>
              {guidance.keyDrivers.map((d, i) => (
                <p key={i} className="text-gray-400 text-[11px]">• {d}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Conviction bar */}
      <div>
        <div className="flex justify-between text-[10px] text-gray-500 mb-1">
          <span>AI Conviction</span>
          <span className={clsx('font-semibold',
            guidance.conviction >= 80 ? 'text-emerald-400' :
            guidance.conviction >= 65 ? 'text-blue-400' : 'text-amber-400'
          )}>
            {guidance.conviction}%
          </span>
        </div>
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={clsx('h-full rounded-full',
              guidance.conviction >= 80 ? 'bg-emerald-500' :
              guidance.conviction >= 65 ? 'bg-blue-500' : 'bg-amber-500'
            )}
            style={{ width: `${guidance.conviction}%` }}
          />
        </div>
      </div>

      {/* User guidance inputs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {/* Investment amount */}
        <div>
          <label className="text-[10px] text-gray-500 mb-1 block">Investment Amount (£)</label>
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(Math.max(0.01, Number(e.target.value)))}
            min={1}
            step={0.01}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
          />
          <p className="text-[9px] text-gray-600 mt-0.5">
            = {qty.toFixed(4)} shares at £{price.toFixed(2)}
          </p>
        </div>

        {/* Take Profit */}
        <div>
          <label className="text-[10px] text-gray-500 mb-1 block">
            Take Profit Price (£)
            <span className="text-[9px] text-gray-600 ml-1">
              AI suggests £{guidance.suggestedTP.toFixed(2)} (+{tpPct}%) — you can adjust this
            </span>
          </label>
          <input
            type="number"
            value={takeProfit}
            onChange={e => setTakeProfit(Number(e.target.value))}
            step={0.01}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500"
          />
          <p className={clsx('text-[9px] mt-0.5', tpMove >= 0 ? 'text-emerald-400' : 'text-red-400')}>
            {tpMove >= 0 ? '+' : ''}{tpMove.toFixed(2)}%
            {' = '}
            {tpProfit >= 0 ? '+' : ''}£{tpProfit.toFixed(2)} profit
          </p>
        </div>

        {/* Stop Loss */}
        <div>
          <label className="text-[10px] text-gray-500 mb-1 block">
            Stop Loss Price (£)
            <span className="text-[9px] text-gray-600 ml-1">
              AI suggests £{guidance.suggestedSL.toFixed(2)} (-{slPct}%) — you can adjust this
            </span>
          </label>
          <input
            type="number"
            value={stopLoss}
            onChange={e => setStopLoss(Number(e.target.value))}
            step={0.01}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-red-500"
          />
          <p className={clsx('text-[9px] mt-0.5', slMove <= 0 ? 'text-red-400' : 'text-emerald-400')}>
            {slMove >= 0 ? '+' : ''}{slMove.toFixed(2)}%
            {' = '}
            -£{slLoss.toFixed(2)} max loss
          </p>
        </div>
      </div>

      {/* Risk/reward + actions */}
      <div className="flex items-center justify-between gap-3 flex-wrap pt-2 border-t border-gray-800">
        <p className={clsx('text-xs font-semibold', rrColor)}>
          Risk/Reward: 1:{rr.toFixed(1)} — {rrLabel}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onSkip(guidance.id)}
            disabled={placing}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 transition-colors disabled:opacity-40"
          >
            Skip this opportunity
          </button>
          <button
            onClick={() => void handleApprove()}
            disabled={placing || amount < 0.01}
            className="text-xs px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-colors disabled:opacity-40 flex items-center gap-1.5"
          >
            {placing
              ? <RefreshCw className="h-3 w-3 animate-spin" />
              : <Zap className="h-3 w-3" />}
            {placing ? 'Placing…' : 'Approve and Place Trade'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ManagedPositionCard ────────────────────────────────────────────────────────

interface ManagedCardProps {
  pos: ManagedPosition;
  liveData: LiveData | null;
  onAdjustTP: (posId: string, newPrice: number) => Promise<void>;
  onAdjustSL: (posId: string, newPrice: number) => Promise<void>;
  onClose:    (posId: string) => Promise<void>;
}

function ManagedPositionCard({ pos, liveData, onAdjustTP, onAdjustSL, onClose }: ManagedCardProps) {
  const [closing,     setClosing]     = useState(false);
  const [adjTP,       setAdjTP]       = useState(false);
  const [adjSL,       setAdjSL]       = useState(false);
  const [newTPVal,    setNewTPVal]    = useState(String(pos.takeProfit));
  const [newSLVal,    setNewSLVal]    = useState(String(pos.stopLoss));
  const [savingTP,    setSavingTP]    = useState(false);
  const [savingSL,    setSavingSL]    = useState(false);

  const currentPrice = liveData?.currentPrice ?? pos.entryPrice;
  const pnl    = liveData?.ppl ?? (currentPrice - pos.entryPrice) * pos.quantity;
  const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

  const tpRange = Math.abs(pos.takeProfit - pos.entryPrice);
  const slRange = Math.abs(pos.stopLoss   - pos.entryPrice);
  const move    = currentPrice - pos.entryPrice;

  let progressToTP = 0, progressToSL = 0;
  if (move > 0 && tpRange > 0) progressToTP = Math.min(100, (move / tpRange) * 50);
  if (move < 0 && slRange > 0) progressToSL = Math.min(100, (Math.abs(move) / slRange) * 50);

  const heldMs = Date.now() - new Date(pos.openedAt).getTime();
  const heldH  = Math.floor(heldMs / 3_600_000);
  const heldM  = Math.floor((heldMs % 3_600_000) / 60_000);

  async function handleAdjustTP() {
    const p = parseFloat(newTPVal);
    if (isNaN(p) || p <= 0) return;
    setSavingTP(true);
    await onAdjustTP(pos.id, p);
    setSavingTP(false);
    setAdjTP(false);
  }

  async function handleAdjustSL() {
    const p = parseFloat(newSLVal);
    if (isNaN(p) || p <= 0) return;
    setSavingSL(true);
    await onAdjustSL(pos.id, p);
    setSavingSL(false);
    setAdjSL(false);
  }

  return (
    <div className="rounded-xl border border-gray-700/60 bg-gray-900/80 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white">{pos.ticker}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">{pos.companyName}</span>
            <span className={clsx(
              'text-[10px] px-2 py-0.5 rounded-full font-semibold',
              pos.direction === 'LONG'
                ? 'bg-emerald-500/20 text-emerald-400'
                : 'bg-red-500/20 text-red-400'
            )}>
              {pos.direction}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-400 flex-wrap">
            <span>Entry: £{pos.entryPrice.toFixed(2)}</span>
            <span>Now: £{currentPrice.toFixed(2)}</span>
            <span className={clsx('font-semibold', pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
              {pnl >= 0 ? '+' : ''}£{pnl.toFixed(2)} ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
            </span>
          </div>
        </div>
        <div className="text-right text-[10px] text-gray-500 flex-shrink-0">
          <p>{pos.quantity.toFixed(4)} shares</p>
          <p>Held {heldH}h {heldM}m</p>
        </div>
      </div>

      {/* TP / SL summary */}
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-2.5 py-2">
          <p className="text-[9px] text-emerald-600 uppercase tracking-wider">Take Profit</p>
          <p className="text-emerald-400 font-bold">£{pos.takeProfit.toFixed(2)}</p>
          <p className="text-[9px] text-emerald-600">
            +{(((pos.takeProfit - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2)}%
            {pos.tpOrderId ? ' · order active' : ' · no order'}
          </p>
        </div>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-2.5 py-2">
          <p className="text-[9px] text-red-600 uppercase tracking-wider">Stop Loss</p>
          <p className="text-red-400 font-bold">£{pos.stopLoss.toFixed(2)}</p>
          <p className="text-[9px] text-red-600">
            {(((pos.stopLoss - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2)}%
            {pos.slOrderId ? ' · order active' : ' · no order'}
          </p>
        </div>
      </div>

      {/* Progress bar: SL ←———entry———→ TP */}
      <div>
        <div className="flex justify-between text-[9px] text-gray-600 mb-1">
          <span>SL £{pos.stopLoss.toFixed(2)}</span>
          <span>Entry £{pos.entryPrice.toFixed(2)}</span>
          <span>TP £{pos.takeProfit.toFixed(2)}</span>
        </div>
        <div className="h-2 bg-gray-800 rounded-full overflow-hidden relative">
          <div className="absolute left-1/2 top-0 w-px h-full bg-gray-600" />
          {progressToTP > 0 && (
            <div
              className="absolute left-1/2 top-0 h-full bg-emerald-500 rounded-r-full"
              style={{ width: `${progressToTP}%` }}
            />
          )}
          {progressToSL > 0 && (
            <div
              className="absolute right-1/2 top-0 h-full bg-red-500 rounded-l-full"
              style={{ width: `${progressToSL}%` }}
            />
          )}
        </div>
      </div>

      {/* Adjust TP inline */}
      {adjTP && (
        <div className="bg-gray-800/60 rounded-lg px-3 py-2 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-400">New TP (£):</span>
          <input
            type="number"
            value={newTPVal}
            onChange={e => setNewTPVal(e.target.value)}
            step={0.01}
            placeholder="0.00"
            className="bg-gray-700 border border-emerald-500/40 rounded px-2 py-1 text-xs text-white w-24 focus:outline-none focus:border-emerald-500"
          />
          <button
            onClick={() => void handleAdjustTP()}
            disabled={savingTP}
            className="text-xs px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 flex items-center gap-1"
          >
            {savingTP && <RefreshCw className="h-3 w-3 animate-spin" />}
            Confirm
          </button>
          <button
            onClick={() => { setAdjTP(false); setNewTPVal(String(pos.takeProfit)); }}
            className="text-xs px-2.5 py-1 rounded border border-gray-600 text-gray-400 hover:text-white"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Adjust SL inline */}
      {adjSL && (
        <div className="bg-gray-800/60 rounded-lg px-3 py-2 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-400">New SL (£):</span>
          <input
            type="number"
            value={newSLVal}
            onChange={e => setNewSLVal(e.target.value)}
            step={0.01}
            placeholder="0.00"
            className="bg-gray-700 border border-red-500/40 rounded px-2 py-1 text-xs text-white w-24 focus:outline-none focus:border-red-500"
          />
          <button
            onClick={() => void handleAdjustSL()}
            disabled={savingSL}
            className="text-xs px-2.5 py-1 rounded bg-red-600 hover:bg-red-500 text-white disabled:opacity-40 flex items-center gap-1"
          >
            {savingSL && <RefreshCw className="h-3 w-3 animate-spin" />}
            Confirm
          </button>
          <button
            onClick={() => { setAdjSL(false); setNewSLVal(String(pos.stopLoss)); }}
            className="text-xs px-2.5 py-1 rounded border border-gray-600 text-gray-400 hover:text-white"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-gray-800">
        <button
          onClick={() => { setAdjTP(true); setAdjSL(false); }}
          className="text-[11px] px-2.5 py-1.5 rounded-lg border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 transition-colors"
        >
          Adjust TP
        </button>
        <button
          onClick={() => { setAdjSL(true); setAdjTP(false); }}
          className="text-[11px] px-2.5 py-1.5 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
        >
          Adjust SL
        </button>
        <button
          onClick={async () => { setClosing(true); await onClose(pos.id); setClosing(false); }}
          disabled={closing}
          className="text-[11px] px-2.5 py-1.5 rounded-lg border border-gray-600 text-gray-400 hover:text-white hover:border-gray-500 transition-colors ml-auto disabled:opacity-40 flex items-center gap-1"
        >
          {closing && <RefreshCw className="h-3 w-3 animate-spin" />}
          Close Now
        </button>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

interface T212ManualTradingProps {
  defaultTradeAmount?: number;
}

export function T212ManualTrading({ defaultTradeAmount = 50 }: T212ManualTradingProps) {
  const { t212ApiKey, t212ApiSecret, t212Connected, t212AccountType } = useClearGainsStore();

  const [opportunities,    setOpportunities]    = useState<TradeGuidance[]>([]);
  const [managedPositions, setManagedPositions] = useState<ManagedPosition[]>([]);
  const [liveData,         setLiveData]         = useState<Record<string, LiveData>>({});
  const [loading,          setLoading]          = useState(false);
  const [lastFetch,        setLastFetch]        = useState<string | null>(null);
  const [toast,            setToast]            = useState<{ ok: boolean; msg: string } | null>(null);

  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load persisted state ───────────────────────────────────────────────────
  useEffect(() => {
    setOpportunities(load<TradeGuidance[]>(OPPORTUNITIES_KEY, []));
    setManagedPositions(load<ManagedPosition[]>(MANAGED_KEY, []));
  }, []);

  // ── Auth helpers ───────────────────────────────────────────────────────────
  function getAuth(): string | null {
    if (!t212ApiKey || !t212ApiSecret) return null;
    return btoa(t212ApiKey + ':' + t212ApiSecret);
  }
  function getEnv(): 'demo' | 'live' { return t212AccountType === 'LIVE' ? 'live' : 'demo'; }

  function showToast(ok: boolean, msg: string) {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 5000);
  }

  // ── Fetch live T212 position data (price + ppl) ────────────────────────────
  const fetchLiveData = useCallback(async () => {
    const encoded = getAuth();
    if (!encoded) return;
    try {
      const env = getEnv();
      const r = await fetch(`/api/t212/positions?env=${env}`, {
        headers: { 'x-t212-auth': encoded },
      });
      if (!r.ok) return;
      const data = await r.json() as Array<{ ticker: string; currentPrice: number; ppl: number }>;
      if (!Array.isArray(data)) return;
      const map: Record<string, LiveData> = {};
      data.forEach(p => {
        if (p.ticker) map[p.ticker] = { currentPrice: p.currentPrice, ppl: p.ppl };
      });
      setLiveData(map);
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t212ApiKey, t212ApiSecret, t212AccountType]);

  useEffect(() => {
    void fetchLiveData();
    const t = setInterval(() => void fetchLiveData(), 30_000);
    return () => clearInterval(t);
  }, [fetchLiveData]);

  // ── Fetch opportunities from signals API ───────────────────────────────────
  const fetchOpportunities = useCallback(async (notify: boolean) => {
    setLoading(true);
    try {
      const r = await fetch('/api/demo-trader/signals?strategy=smart-money&num=15');
      if (!r.ok) { setLoading(false); return; }
      const d = await r.json() as { signals?: RawSignal[]; results?: RawSignal[] };
      const signals = (d.signals ?? d.results ?? []) as RawSignal[];
      const eligible = signals.filter(s => (s.signal === 'BUY' || s.signal === 'SELL') && s.confidence >= 50 && s.currentPrice > 0);

      setOpportunities(prev => {
        const existingTickers = new Set(prev.map(o => o.ticker));
        const managed         = load<ManagedPosition[]>(MANAGED_KEY, []);
        const managedTickers  = new Set(managed.map(p => p.ticker));

        const newOnes = eligible
          .filter(s => !existingTickers.has(s.symbol) && !managedTickers.has(s.symbol))
          .map(s => signalToGuidance(s, defaultTradeAmount));

        if (newOnes.length === 0) return prev;

        const updated = [...prev, ...newOnes];
        save(OPPORTUNITIES_KEY, updated);

        if (notify && newOnes.length > 0 && typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
          const tickers = newOnes.map(o => o.ticker).join(', ');
          new Notification(
            `ClearGains: ${newOnes.length} new trade ${newOnes.length === 1 ? 'opportunity' : 'opportunities'}`,
            { body: tickers, icon: '/favicon.ico' }
          );
        }

        return updated;
      });

      setLastFetch(new Date().toISOString());
    } catch { /* ignore */ }
    setLoading(false);
  }, [defaultTradeAmount]);

  // Auto-refresh every 15 minutes
  useEffect(() => {
    void fetchOpportunities(false);
    refreshTimerRef.current = setInterval(() => void fetchOpportunities(true), REFRESH_MS);
    return () => { if (refreshTimerRef.current) clearInterval(refreshTimerRef.current); };
  }, [fetchOpportunities]);

  // Request notification permission on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }, []);

  // ── Skip opportunity ───────────────────────────────────────────────────────
  function skipOpportunity(id: string) {
    setOpportunities(prev => {
      const updated = prev.filter(o => o.id !== id);
      save(OPPORTUNITIES_KEY, updated);
      return updated;
    });
  }

  // ── Approve and place trade ────────────────────────────────────────────────
  async function approveTrade(id: string, amount: number, takeProfit: number, stopLoss: number) {
    const guidance = opportunities.find(o => o.id === id);
    if (!guidance) return;
    const encoded = getAuth();
    if (!encoded) { showToast(false, 'T212 not connected'); return; }

    const env      = getEnv();
    const quantity = Math.round((amount / guidance.currentPrice) * 10000) / 10000;

    try {
      const r = await fetch('/api/t212/live-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-t212-auth': encoded },
        body: JSON.stringify({
          ticker:         guidance.t212Ticker,
          quantity,
          env,
          stopLossPrice:  stopLoss,
          takeProfitPrice: takeProfit,
        }),
      });
      const d = await r.json() as OrderResult;

      if (!d.ok) {
        showToast(false, `Order failed: ${d.error ?? 'unknown error'}`);
        return;
      }

      const filledQty  = d.quantity    ?? quantity;
      const entryPrice = d.fillPrice   ?? guidance.currentPrice;
      const orders     = d.orders      ?? [];

      const slObj = orders.find(o => (o as { type?: string }).type === 'STOP_LOSS');
      const tpObj = orders.find(o => (o as { type?: string }).type === 'TAKE_PROFIT');
      const slOrderId = slObj ? String((slObj as { id?: unknown }).id ?? '') : undefined;
      const tpOrderId = tpObj ? String((tpObj as { id?: unknown }).id ?? '') : undefined;

      const newPos: ManagedPosition = {
        id:          uid(),
        ticker:      guidance.ticker,
        t212Ticker:  guidance.t212Ticker,
        companyName: guidance.companyName,
        quantity:    filledQty,
        entryPrice,
        amount,
        takeProfit,
        stopLoss,
        tpOrderId:   tpOrderId || undefined,
        slOrderId:   slOrderId || undefined,
        openedAt:    new Date().toISOString(),
        direction:   guidance.direction,
      };

      setManagedPositions(prev => {
        const updated = [...prev, newPos];
        save(MANAGED_KEY, updated);
        return updated;
      });

      skipOpportunity(id);

      showToast(true,
        `Trade placed — ${guidance.ticker} ${filledQty.toFixed(4)} shares` +
        ` · TP: £${takeProfit.toFixed(2)} | SL: £${stopLoss.toFixed(2)}`
      );
    } catch (e) {
      showToast(false, `Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Adjust TP ─────────────────────────────────────────────────────────────
  async function adjustTP(posId: string, newPrice: number) {
    const pos     = managedPositions.find(p => p.id === posId);
    if (!pos) return;
    const encoded = getAuth();
    if (!encoded) { showToast(false, 'Not connected'); return; }
    const env = getEnv();

    if (pos.tpOrderId) {
      await fetch(`/api/t212/cancel-order?orderId=${pos.tpOrderId}&env=${env}`, {
        method: 'DELETE', headers: { 'x-t212-auth': encoded },
      });
    }

    const r = await fetch('/api/t212/live-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-t212-auth': encoded },
      body: JSON.stringify({
        ticker:     pos.t212Ticker,
        quantity:   -pos.quantity,
        orderType:  'LIMIT',
        limitPrice: newPrice,
        env,
      }),
    });
    const d = await r.json() as OrderResult;

    if (!d.ok) { showToast(false, `TP update failed: ${d.error ?? ''}`); return; }

    const newOrderId = d.orderId ? String(d.orderId) : undefined;
    setManagedPositions(prev => {
      const updated = prev.map(p =>
        p.id === posId ? { ...p, takeProfit: newPrice, tpOrderId: newOrderId } : p
      );
      save(MANAGED_KEY, updated);
      return updated;
    });
    showToast(true, `Take profit updated to £${newPrice.toFixed(2)}`);
  }

  // ── Adjust SL ─────────────────────────────────────────────────────────────
  async function adjustSL(posId: string, newPrice: number) {
    const pos     = managedPositions.find(p => p.id === posId);
    if (!pos) return;
    const encoded = getAuth();
    if (!encoded) { showToast(false, 'Not connected'); return; }
    const env = getEnv();

    if (pos.slOrderId) {
      await fetch(`/api/t212/cancel-order?orderId=${pos.slOrderId}&env=${env}`, {
        method: 'DELETE', headers: { 'x-t212-auth': encoded },
      });
    }

    const r = await fetch('/api/t212/live-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-t212-auth': encoded },
      body: JSON.stringify({
        ticker:    pos.t212Ticker,
        quantity:  -pos.quantity,
        orderType: 'STOP',
        stopPrice: newPrice,
        env,
      }),
    });
    const d = await r.json() as OrderResult;

    if (!d.ok) { showToast(false, `SL update failed: ${d.error ?? ''}`); return; }

    const newOrderId = d.orderId ? String(d.orderId) : undefined;
    setManagedPositions(prev => {
      const updated = prev.map(p =>
        p.id === posId ? { ...p, stopLoss: newPrice, slOrderId: newOrderId } : p
      );
      save(MANAGED_KEY, updated);
      return updated;
    });
    showToast(true, `Stop loss updated to £${newPrice.toFixed(2)}`);
  }

  // ── Close position ─────────────────────────────────────────────────────────
  async function closePosition(posId: string) {
    const pos     = managedPositions.find(p => p.id === posId);
    if (!pos) return;
    const encoded = getAuth();
    if (!encoded) { showToast(false, 'Not connected'); return; }
    const env = getEnv();

    // Cancel pending TP and SL orders
    await Promise.all(
      [pos.tpOrderId, pos.slOrderId]
        .filter((id): id is string => Boolean(id))
        .map(id => fetch(`/api/t212/cancel-order?orderId=${id}&env=${env}`, {
          method: 'DELETE', headers: { 'x-t212-auth': encoded },
        }))
    );

    // Market sell
    const r = await fetch('/api/t212/live-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-t212-auth': encoded },
      body: JSON.stringify({ ticker: pos.t212Ticker, quantity: -pos.quantity, env }),
    });
    const d = await r.json() as OrderResult;

    if (!d.ok) { showToast(false, `Close failed: ${d.error ?? ''}`); return; }

    const fillPrice = d.fillPrice ?? liveData[pos.t212Ticker]?.currentPrice ?? pos.entryPrice;
    const pnl       = (fillPrice - pos.entryPrice) * pos.quantity;

    setManagedPositions(prev => {
      const updated = prev.filter(p => p.id !== posId);
      save(MANAGED_KEY, updated);
      return updated;
    });

    showToast(
      pnl >= 0,
      `Closed ${pos.ticker} — ${pnl >= 0 ? 'Profit' : 'Loss'}: ${pnl >= 0 ? '+' : ''}£${pnl.toFixed(2)}`
    );
  }

  if (!t212Connected) return null;

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

      {/* ── Trade Opportunities ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Trade Opportunities"
          subtitle={
            opportunities.length > 0
              ? `${opportunities.length} opportunit${opportunities.length === 1 ? 'y' : 'ies'} · review and approve to place trades`
              : 'AI-predicted moves — review and approve to place trades'
          }
          icon={<Target className="h-4 w-4" />}
          action={
            <div className="flex items-center gap-2">
              {lastFetch && (
                <span className="text-[10px] text-gray-600">
                  Last analysis: {new Date(lastFetch).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
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

        {/* Summary banner */}
        {opportunities.length > 0 && (
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-xs text-blue-300 mb-3 flex items-start gap-2">
            <Bell className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <span>
              AI found {opportunities.length} opportunit{opportunities.length === 1 ? 'y' : 'ies'} based on current news and macro data
              {staleCount > 0 && (
                <span className="text-amber-400 ml-1">
                  · {staleCount} may be stale (older than 1 hour)
                </span>
              )}
            </span>
          </div>
        )}

        {opportunities.length === 0 ? (
          <div className="text-center py-8">
            <Target className="h-8 w-8 mx-auto mb-2 text-gray-700" />
            <p className="text-sm text-gray-500">No opportunities right now</p>
            <p className="text-xs text-gray-600 mt-1">Auto-refreshes every 15 minutes · or click Refresh above</p>
          </div>
        ) : (
          <div className="space-y-3">
            {opportunities.map(opp => (
              <TradeGuidanceCard
                key={opp.id}
                guidance={opp}
                defaultAmount={defaultTradeAmount}
                onSkip={skipOpportunity}
                onApprove={approveTrade}
              />
            ))}
          </div>
        )}
      </Card>

      {/* ── Active Managed Positions ─────────────────────────────────────────── */}
      {managedPositions.length > 0 && (
        <Card>
          <CardHeader
            title="Active Positions"
            subtitle={`${managedPositions.length} position${managedPositions.length === 1 ? '' : 's'} with manual TP/SL guidance`}
            icon={<TrendingUp className="h-4 w-4" />}
            action={
              <button
                onClick={() => {
                  if (confirm('Clear all managed positions? (does NOT close them in T212)')) {
                    setManagedPositions([]);
                    save(MANAGED_KEY, []);
                  }
                }}
                className="flex items-center gap-1 text-[10px] text-gray-600 hover:text-red-400 transition-colors"
              >
                <X className="h-3 w-3" />
                Clear all
              </button>
            }
          />
          <div className="space-y-3">
            {managedPositions.map(pos => (
              <ManagedPositionCard
                key={pos.id}
                pos={pos}
                liveData={liveData[pos.t212Ticker] ?? null}
                onAdjustTP={adjustTP}
                onAdjustSL={adjustSL}
                onClose={closePosition}
              />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

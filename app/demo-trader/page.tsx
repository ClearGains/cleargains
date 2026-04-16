'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FlaskConical, Play, RefreshCw, X,
  CheckCircle2, AlertCircle, ArrowRight,
  Target, BarChart3, Trophy, Copy, Info, RotateCcw, Wallet, Clock,
  Zap, Moon, Sun, Pause, TrendingUp, Download,
  Search, Plus, Trash2, AlertTriangle, Wifi,
} from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { getMarketStatus } from '@/lib/marketHours';
import { DemoPosition, DemoTrade, FxPosition, FxTrade } from '@/lib/types';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { TickerTooltip } from '@/components/ui/TickerTooltip';
import { MarketStatusBadge } from '@/components/ui/MarketStatusBadge';
import { clsx } from 'clsx';
import { sendPush } from '@/lib/pushNotifications';
import Modal from '@/components/ui/Modal';
import { IGStrategyTrader } from '@/components/ig/IGStrategyTrader';
import { LoadPortfolioButton } from '@/components/portfolio/LoadPortfolioModal';

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

type StrategyLogEntry = {
  id: string;
  ts: string;
  type: 'buy' | 'sell' | 'adjust' | 'pause' | 'info' | 'error';
  ticker?: string;
  action: string;
  reason: string;
  price?: number;
  pnl?: number;
  pnlPct?: number;
  positionValue?: number;
  strategy?: string;
};

// ─── PORTFOLIO TYPES ──────────────────────────────────────────────────────────
type PortfolioStrategy = 'momentum' | 'value' | 'news-catalyst' | 'fx-only' | 'mixed' | 'custom' | 'smart-money';
type PortfolioRiskMode = 'conservative' | 'balanced' | 'aggressive';
type PortfolioStatus = 'active' | 'paused' | 'completed';

type ExecutionAccount = 'paper' | 'practice' | 'invest' | 'isa';

type PortfolioMeta = {
  id: string;
  name: string;
  strategy: PortfolioStrategy;
  riskMode: PortfolioRiskMode;
  sectorFocus: string;
  autoTrade: boolean;
  status: PortfolioStatus;
  createdAt: string;
  lastActiveAt: string;
  paperBudget: number;
  executionAccount: ExecutionAccount;
  lastRunAt?: string;
};

const EXECUTION_ACCOUNT_LABELS: Record<ExecutionAccount, string> = {
  paper: '📝 Paper Only',
  practice: '🎮 Practice (T212 Demo)',
  invest: '📊 Invest (Live)',
  isa: '📈 Stocks ISA (Live)',
};

const PORTFOLIO_LIST_KEY = 'demo_portfolios';
const ACTIVE_PORTFOLIO_KEY = 'active_portfolio_id';
const MAX_PORTFOLIOS = 10;

function portfolioKey(id: string, suffix: string) { return `portfolio_${id}_${suffix}`; }

function loadPortfolioIds(): string[] {
  try { return JSON.parse(localStorage.getItem(PORTFOLIO_LIST_KEY) ?? '[]') as string[]; } catch { return []; }
}
function savePortfolioIds(ids: string[]) {
  try { localStorage.setItem(PORTFOLIO_LIST_KEY, JSON.stringify(ids)); } catch {}
}
function loadPortfolioMeta(id: string): PortfolioMeta | null {
  try { return JSON.parse(localStorage.getItem(portfolioKey(id, 'meta')) ?? 'null') as PortfolioMeta | null; } catch { return null; }
}
function savePortfolioMeta(meta: PortfolioMeta) {
  try { localStorage.setItem(portfolioKey(meta.id, 'meta'), JSON.stringify(meta)); } catch {}
}
function loadPortfolioPositions(id: string): DemoPosition[] {
  try { return JSON.parse(localStorage.getItem(portfolioKey(id, 'positions')) ?? '[]') as DemoPosition[]; } catch { return []; }
}
function loadPortfolioTrades(id: string): DemoTrade[] {
  try { return JSON.parse(localStorage.getItem(portfolioKey(id, 'trades')) ?? '[]') as DemoTrade[]; } catch { return []; }
}
function loadPortfolioBudget(id: string): number | null {
  try { const v = localStorage.getItem(portfolioKey(id, 'budget')); return v ? Number(JSON.parse(v)) : null; } catch { return null; }
}


const STRATEGY_LABELS: Record<PortfolioStrategy, string> = {
  'smart-money': '🧠 Smart Money Swing',
  momentum: '📈 Momentum', value: '💎 Value', 'news-catalyst': '📰 News Catalyst',
  'fx-only': '💱 FX Only', mixed: '🔀 Mixed', custom: '⚙️ Custom',
};

// Smart-Money strategy parameters (2:1 R:R, 1% portfolio risk per trade)
const SMART_MONEY_SL_PCT  = 1.5;
const SMART_MONEY_TP_PCT  = 3.0;
const SMART_MONEY_RISK_PCT = 1.0;  // risk this % of portfolio per position
const SMART_MONEY_MAX_POS  = 4;

// ── T212 fee constants ────────────────────────────────────────────────────────
const FX_FEE_PCT   = 0.15;                       // T212 GBP→USD conversion fee
const SPREAD_PCT   = 0.20;                       // typical bid/ask spread
const US_TOTAL_FEE = FX_FEE_PCT + SPREAD_PCT;   // 0.35% for US stocks
const UK_TOTAL_FEE = 0.15;                       // ~0.15% for UK (no FX)

// ── Pending order type (T212 orders queued while market is closed) ────────────
type PendingOrder = {
  id: string;
  symbol: string;
  name: string;
  t212Ticker: string;
  quantity: number;
  entryPrice: number;
  size: number;
  sl: number;
  tp: number;
  breakeven: number;
  feePct: number;
  feeAmount: number;
  netProfitPct: number;
  orderAuth: string;
  orderEnv: 'live' | 'demo';
  accountLabel: string;
  isUK: boolean;
  queuedAt: string;
};

// ── Manual added stock type ───────────────────────────────────────────────────
type ManualStock = {
  symbol: string;
  name: string;
  t212Ticker: string;
  isUK: boolean;
};

const RISK_LABELS: Record<PortfolioRiskMode, string> = {
  conservative: '🛡 Conservative (1%)', balanced: '⚖️ Balanced (3%)', aggressive: '🔥 Aggressive (5%)',
};

// ─── PORTFOLIO COMPONENTS ──────────────────────────────────────────────────────
function PortfolioCard({
  meta, positions, trades, budget, isActive,
  onSelect, onDelete, onDuplicate, onToggleStatus,
}: {
  meta: PortfolioMeta;
  positions: DemoPosition[];
  trades: DemoTrade[];
  budget: number;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onToggleStatus: () => void;
}) {
  const totalPnL = trades.reduce((s, t) => s + t.pnl, 0) + positions.reduce((s, p) => s + p.pnl, 0);
  const invested = positions.reduce((s, p) => s + p.entryPrice * p.quantity, 0);
  const available = Math.max(0, budget - invested);
  const wins = trades.filter(t => t.pnl > 0).length;
  const winRate = trades.length > 0 ? Math.round(wins / trades.length * 100) : 0;

  return (
    <div
      onClick={onSelect}
      className={clsx(
        'relative flex-shrink-0 w-52 bg-gray-900 rounded-xl border p-3 cursor-pointer transition-all hover:border-amber-500/40',
        isActive ? 'border-emerald-500/60 shadow-emerald-500/10 shadow-lg' : 'border-gray-800'
      )}
    >
      {isActive && <div className="absolute -top-1.5 left-3 px-2 py-0.5 rounded-full bg-emerald-500 text-[9px] font-bold text-white">ACTIVE</div>}
      <div className="flex items-start justify-between mb-1">
        <p className="text-xs font-semibold text-white truncate flex-1 pr-1">{meta.name}</p>
        <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0',
          meta.status === 'active' ? 'bg-emerald-500/20 text-emerald-400' :
          meta.status === 'paused' ? 'bg-amber-500/20 text-amber-400' :
          'bg-gray-700 text-gray-500'
        )}>
          {meta.status}
        </span>
      </div>
      <p className="text-[10px] text-gray-500">{STRATEGY_LABELS[meta.strategy]}</p>
      <p className="text-[10px] text-gray-600 mb-2">{EXECUTION_ACCOUNT_LABELS[meta.executionAccount ?? 'paper']}</p>
      <div className="space-y-1">
        <div className="flex justify-between text-[10px]">
          <span className="text-gray-600">Budget</span>
          <span className="text-gray-300 font-mono">£{budget.toLocaleString()}</span>
        </div>
        <div className="flex justify-between text-[10px]">
          <span className="text-gray-600">Available</span>
          <span className="text-gray-300 font-mono">£{available.toLocaleString('en-GB', { maximumFractionDigits: 0 })}</span>
        </div>
        <div className="flex justify-between text-[10px]">
          <span className="text-gray-600">Total P&L</span>
          <span className={clsx('font-mono font-semibold', totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400')}>
            {totalPnL >= 0 ? '+' : ''}£{totalPnL.toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between text-[10px]">
          <span className="text-gray-600">Positions / Win%</span>
          <span className="text-gray-400">{positions.length} open · {winRate}% wins</span>
        </div>
      </div>
      <div className="flex gap-1 mt-3 pt-2 border-t border-gray-800" onClick={e => e.stopPropagation()}>
        <button onClick={onToggleStatus} className="flex-1 text-[10px] py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 transition-colors">
          {meta.status === 'active' ? '⏸' : '▶'}
        </button>
        <button onClick={onDuplicate} className="flex-1 text-[10px] py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 transition-colors" title="Duplicate">📋</button>
        <button onClick={onDelete} className="flex-1 text-[10px] py-1 rounded bg-gray-800 hover:bg-red-900/40 text-gray-400 hover:text-red-400 transition-colors" title="Delete">🗑</button>
      </div>
    </div>
  );
}

function CreatePortfolioModal({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (meta: Omit<PortfolioMeta, 'id' | 'createdAt' | 'lastActiveAt'>) => void;
}) {
  const {
    t212Connected, t212IsaConnected, t212DemoConnected,
  } = useClearGainsStore();

  const [name, setName] = useState('');
  const [strategy, setStrategy] = useState<PortfolioStrategy>('momentum');
  const [riskMode, setRiskMode] = useState<PortfolioRiskMode>('balanced');
  const [sectorFocus, setSectorFocus] = useState('All');
  const [budget, setBudget] = useState(1000);
  const [autoTrade, setAutoTrade] = useState(true);
  const [executionAccount, setExecutionAccount] = useState<ExecutionAccount>('paper');
  const [understood, setUnderstood] = useState(false);

  const isRealMoney = executionAccount === 'invest' || executionAccount === 'isa';
  const accountAvailable = (acc: ExecutionAccount) => {
    if (acc === 'paper') return true;
    if (acc === 'practice') return t212DemoConnected;
    if (acc === 'invest') return t212Connected;
    if (acc === 'isa') return t212IsaConnected;
    return false;
  };

  function handleCreate() {
    if (!name.trim()) return;
    if (isRealMoney && !understood) return;
    onCreate({ name: name.trim(), strategy, riskMode, sectorFocus, autoTrade, status: 'active', paperBudget: budget, executionAccount });
    onClose();
  }

  return (
    <Modal isOpen onClose={onClose} maxWidth="max-w-md">
      <div className="space-y-4">
        <h2 className="text-base font-semibold text-white">New Demo Portfolio</h2>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Portfolio Name</label>
          <input
            autoFocus
            value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            placeholder="e.g. Momentum Strategy"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Strategy</label>
            <select value={strategy} onChange={e => setStrategy(e.target.value as PortfolioStrategy)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
              {(Object.keys(STRATEGY_LABELS) as PortfolioStrategy[]).map(s => (
                <option key={s} value={s}>{STRATEGY_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Sector Focus</label>
            <select value={sectorFocus} onChange={e => setSectorFocus(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
              {['All','Technology','Energy','Healthcare','Finance','UK Stocks','US Stocks'].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Risk Mode</label>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(RISK_LABELS) as PortfolioRiskMode[]).map(r => (
              <button key={r} onClick={() => setRiskMode(r)}
                className={clsx('py-2 rounded-lg text-[11px] font-medium border transition-colors text-center',
                  riskMode === r ? 'bg-amber-500/20 border-amber-500/30 text-amber-300' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200')}>
                {RISK_LABELS[r]}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Starting Budget</label>
            <div className="flex gap-1">
              {[500, 1000, 2000, 5000].map(v => (
                <button key={v} onClick={() => setBudget(v)}
                  className={clsx('flex-1 py-1.5 rounded text-[11px] border transition-colors',
                    budget === v ? 'bg-amber-500/20 border-amber-500/30 text-amber-300' : 'bg-gray-800 border-gray-700 text-gray-400')}>
                  £{v >= 1000 ? `${v/1000}k` : v}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Auto-Trade</label>
            <button onClick={() => setAutoTrade(a => !a)}
              className={clsx('w-full py-2 rounded-lg border text-xs font-medium transition-colors',
                autoTrade ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300' : 'bg-gray-800 border-gray-700 text-gray-400')}>
              {autoTrade ? '✅ Auto-Trade ON' : '⏸ Auto-Trade OFF'}
            </button>
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1.5 block">Execution Account</label>
          <div className="grid grid-cols-2 gap-2">
            {(['paper', 'practice', 'invest', 'isa'] as ExecutionAccount[]).map(acc => {
              const available = accountAvailable(acc);
              const isSelected = executionAccount === acc;
              const isLive = acc === 'invest' || acc === 'isa';
              return (
                <button
                  key={acc}
                  onClick={() => { if (available) { setExecutionAccount(acc); setUnderstood(false); } }}
                  disabled={!available}
                  className={clsx('py-2 px-3 rounded-lg border text-[11px] font-medium transition-colors text-left',
                    !available ? 'opacity-40 cursor-not-allowed bg-gray-800 border-gray-800 text-gray-600' :
                    isSelected && isLive ? 'bg-amber-500/20 border-amber-500/30 text-amber-300' :
                    isSelected ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300' :
                    'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
                  )}
                >
                  <div>{EXECUTION_ACCOUNT_LABELS[acc]}</div>
                  {!available && <div className="text-[10px] text-gray-600 mt-0.5">Not connected</div>}
                </button>
              );
            })}
          </div>
          {isRealMoney && (
            <div className="mt-2 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5">
              <p className="text-xs text-amber-400 font-semibold mb-1">⚠ Real money account selected</p>
              <p className="text-xs text-amber-300/80">
                This strategy will place real orders on your {executionAccount === 'isa' ? 'Stocks ISA' : 'Invest'} account.
                ClearGains will confirm each order before placing.
              </p>
              <label className="flex items-start gap-2 mt-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={understood}
                  onChange={e => setUnderstood(e.target.checked)}
                  className="mt-0.5 accent-amber-500"
                />
                <span className="text-xs text-amber-300">I understand this uses real money and I am responsible for all trading decisions</span>
              </label>
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg border border-gray-700 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || (isRealMoney && !understood)}
            className="flex-1 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Create Portfolio
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PortfolioCompare({ portfolios }: { portfolios: PortfolioMeta[] }) {
  const rows = portfolios.map(meta => {
    const positions = loadPortfolioPositions(meta.id);
    const trades = loadPortfolioTrades(meta.id);
    const budget = loadPortfolioBudget(meta.id) ?? meta.paperBudget;
    const openPnL = positions.reduce((s, p) => s + p.pnl, 0);
    const closedPnL = trades.reduce((s, t) => s + t.pnl, 0);
    const totalPnL = openPnL + closedPnL;
    const pnlPct = budget > 0 ? (totalPnL / budget) * 100 : 0;
    const wins = trades.filter(t => t.pnl > 0).length;
    const winRate = trades.length > 0 ? Math.round(wins / trades.length * 100) : 0;
    const currentValue = budget + totalPnL;
    return { meta, budget, currentValue, totalPnL, pnlPct, winRate, trades: trades.length, positions: positions.length };
  }).sort((a, b) => b.pnlPct - a.pnlPct);

  const maxPnL = Math.max(...rows.map(r => Math.abs(r.totalPnL)), 1);

  return (
    <div className="space-y-4">
      {/* Bar chart */}
      <Card>
        <CardHeader title="P&L Comparison" subtitle="All portfolios sorted by performance" icon={<BarChart3 className="h-4 w-4" />} />
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={row.meta.id} className="flex items-center gap-3 text-xs">
              <div className="w-32 text-gray-400 truncate">{i === 0 && '🥇 '}{row.meta.name}</div>
              <div className="flex-1 bg-gray-800 rounded-full h-4 relative overflow-hidden">
                <div
                  className={clsx('absolute inset-y-0 left-0 rounded-full transition-all', row.totalPnL >= 0 ? 'bg-emerald-500/60' : 'bg-red-500/60')}
                  style={{ width: `${Math.abs(row.totalPnL) / maxPnL * 100}%` }}
                />
              </div>
              <div className={clsx('w-16 text-right font-mono font-semibold', row.totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                {row.totalPnL >= 0 ? '+' : ''}£{row.totalPnL.toFixed(2)}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Comparison table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-2 pr-3">Portfolio</th>
                <th className="text-right py-2 pr-3">Budget</th>
                <th className="text-right py-2 pr-3">Value</th>
                <th className="text-right py-2 pr-3">P&L</th>
                <th className="text-right py-2 pr-3">P&L %</th>
                <th className="text-right py-2 pr-3">Win Rate</th>
                <th className="text-right py-2 pr-3">Trades</th>
                <th className="text-right py-2">Open</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.meta.id} className={clsx('border-b border-gray-800/50', i === 0 && 'bg-emerald-500/5')}>
                  <td className="py-2 pr-3">
                    <p className="font-semibold text-white">{i === 0 && '🥇 '}{row.meta.name}</p>
                    <p className="text-gray-600">{STRATEGY_LABELS[row.meta.strategy]}</p>
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-gray-400">£{row.budget.toLocaleString()}</td>
                  <td className="py-2 pr-3 text-right font-mono text-gray-300">£{row.currentValue.toFixed(0)}</td>
                  <td className={clsx('py-2 pr-3 text-right font-mono font-semibold', row.totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                    {row.totalPnL >= 0 ? '+' : ''}£{row.totalPnL.toFixed(2)}
                  </td>
                  <td className={clsx('py-2 pr-3 text-right font-mono', row.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                    {row.pnlPct >= 0 ? '+' : ''}{row.pnlPct.toFixed(2)}%
                  </td>
                  <td className="py-2 pr-3 text-right text-gray-400">{row.winRate}%</td>
                  <td className="py-2 pr-3 text-right text-gray-400">{row.trades}</td>
                  <td className="py-2 text-right text-gray-400">{row.positions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

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
    <Modal isOpen onClose={onClose} maxWidth="max-w-md">
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
    </Modal>
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
const FX_MOMENTUM_PCT = 0.001; // 0.1% threshold (lowered from 0.2%)
const FX_MIN_CONFIDENCE = 30;  // lowered from 45
const FX_TRADE_UNITS = 1_000;
const FX_DEFAULT_BUDGET = 1_000;
const LS_FX_HISTORY = 'fx_rate_history';
const LS_FX_LAST_SCAN = 'fx_last_scan';
const LS_FX_AUTO = 'fx_auto_pairs';
const LS_FX_BUDGET = 'fx_budget';
const LS_FX_GLOBAL_AUTO = 'fx_global_auto';

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

  // Accept any snapshot older than 2 minutes
  const usable = history.filter(s => now - s.ts > 2 * 60_000);

  for (const pair of FX_PAIRS) {
    const currentRate = derivePairRate(pair, currentRates);
    const pip = pipSize(pair);

    if (usable.length === 0) {
      result[pair] = { direction: 'NEUTRAL', confidence: 0, change1hPips: 0, change1hPct: 0 };
      continue;
    }

    // Use the oldest available snapshot (or the one closest to 1h ago)
    const t1h = now - 60 * 60_000;
    const snap1h = usable.reduce((b, s) => Math.abs(s.ts - t1h) < Math.abs(b.ts - t1h) ? s : b);
    const ageMs = now - snap1h.ts;
    const ageHours = ageMs / 3_600_000;

    const rate1h = derivePairRate(pair, snap1h.rates);
    const change1hPct = ((currentRate - rate1h) / rate1h) * 100;
    const change1hPips = (currentRate - rate1h) / pip;

    // Scale threshold: lower when we have short history (allows signals sooner)
    const dynamicThreshold = Math.max(0.0005, FX_MOMENTUM_PCT * Math.min(1, ageHours));
    // Confidence penalty: less confident with shorter windows
    const ageFactor = Math.min(1, ageHours / 0.5); // full confidence after 30 min

    // 4h snapshot for acceleration
    const t4h = now - 4 * 60 * 60_000;
    const snap4h = usable.reduce((b, s) => Math.abs(s.ts - t4h) < Math.abs(b.ts - t4h) ? s : b);
    const change4hPct = ((currentRate - derivePairRate(pair, snap4h.rates)) / derivePairRate(pair, snap4h.rates)) * 100;

    let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
    let confidence = 0;

    if (change1hPct >= dynamicThreshold) {
      direction = 'LONG';
      const accel = change4hPct >= 0;
      confidence = Math.min(90, Math.round((35 + Math.abs(change1hPct) * 4000 + (accel ? 15 : 0)) * ageFactor));
    } else if (change1hPct <= -dynamicThreshold) {
      direction = 'SHORT';
      const accel = change4hPct <= 0;
      confidence = Math.min(90, Math.round((35 + Math.abs(change1hPct) * 4000 + (accel ? 15 : 0)) * ageFactor));
    }

    result[pair] = { direction, confidence, change1hPips, change1hPct };
  }
  return result;
}

function seedSyntheticHistory(currentRates: Record<string, number>): FxRateSnapshot[] {
  // Generate 24 synthetic snapshots (2h of history at 5-min intervals)
  // Uses deterministic noise so each session looks different but consistent
  const now = Date.now();
  const snapshots: FxRateSnapshot[] = [];
  let seed = Object.values(currentRates).reduce((s, r) => s + Math.round(r * 100), 0);
  const lcg = () => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; };

  for (let i = 24; i >= 1; i--) {
    const ts = now - i * 5 * 60_000;
    const syntheticRates: Record<string, number> = {};
    for (const [key, rate] of Object.entries(currentRates)) {
      const drift = (lcg() - 0.5) * 0.004 * (i / 12); // up to ±0.2% drift
      syntheticRates[key] = rate * (1 + drift);
    }
    snapshots.push({ ts, rates: syntheticRates });
  }
  return snapshots;
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

// ── IG Strategy Trader (full implementation in components/ig/IGStrategyTrader.tsx)
function IGTrader() {
  return <IGStrategyTrader />;
}


// ── Component ─────────────────────────────────────────────────────────────────
function ForexTrader() {
  const { fxPositions, fxTrades, addFxPosition, removeFxPosition, updateFxPosition, addFxTrade, fxRates: gbpRates } = useClearGainsStore();

  const [rates, setRates] = useState<Record<string, number>>({});
  const [rateHistory, setRateHistory] = useState<FxRateSnapshot[]>([]);
  const [fxSignals, setFxSignals] = useState<Record<string, FxSignalResult>>({});
  const [autoEnabled, setAutoEnabled] = useState<Record<string, boolean>>({});
  const [globalFxAutoEnabled, setGlobalFxAutoEnabled] = useState(false);
  const [flashPairs, setFlashPairs] = useState<Record<string, 'up' | 'down'>>({});
  const [fxBudget, setFxBudgetState] = useState(FX_DEFAULT_BUDGET);
  const [autoLog, setAutoLog] = useState<string[]>([]);
  const [activeSessions, setActiveSessions] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);

  // Refs to avoid stale closures in intervals
  const rateHistoryRef = useRef<FxRateSnapshot[]>([]);
  const autoEnabledRef = useRef<Record<string, boolean>>({});
  const globalFxAutoEnabledRef = useRef(false);
  const fxPositionsRef = useRef<FxPosition[]>([]);
  const prevRatesRef = useRef<Record<string, number>>({});

  useEffect(() => { rateHistoryRef.current = rateHistory; }, [rateHistory]);
  useEffect(() => { autoEnabledRef.current = autoEnabled; }, [autoEnabled]);
  useEffect(() => { globalFxAutoEnabledRef.current = globalFxAutoEnabled; }, [globalFxAutoEnabled]);
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
    let loadedHistory: FxRateSnapshot[] = [];
    try {
      const h = localStorage.getItem(LS_FX_HISTORY);
      if (h) { loadedHistory = JSON.parse(h) as FxRateSnapshot[]; setRateHistory(loadedHistory); rateHistoryRef.current = loadedHistory; }
    } catch {}
    try {
      const b = localStorage.getItem(LS_FX_BUDGET);
      if (b) setFxBudgetState(Number(JSON.parse(b)));
    } catch {}
    try {
      const a = localStorage.getItem(LS_FX_AUTO);
      if (a) { const parsed = JSON.parse(a) as Record<string, boolean>; setAutoEnabled(parsed); autoEnabledRef.current = parsed; }
    } catch {}
    try {
      const g = localStorage.getItem(LS_FX_GLOBAL_AUTO);
      if (g === 'true') { setGlobalFxAutoEnabled(true); globalFxAutoEnabledRef.current = true; }
    } catch {}
    setActiveSessions(getActiveSessionsNow());

    // If no history, seed with synthetic data once rates are available
    if (loadedHistory.length < 3) {
      const t = setTimeout(() => {
        if (Object.keys(prevRatesRef.current).length > 0 && rateHistoryRef.current.length < 3) {
          const synthetic = seedSyntheticHistory(prevRatesRef.current);
          setRateHistory(synthetic);
          rateHistoryRef.current = synthetic;
        }
      }, 3000);
      return () => clearTimeout(t);
    }
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
    const needsScan = !last || Date.now() - Number(last) >= FX_SCAN_MS;
    if (needsScan) {
      // Run scan after rates + history are loaded (wait 4s)
      setTimeout(() => fetchRates(true), 4000);
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
    const globalAuto = globalFxAutoEnabledRef.current;
    const log: string[] = [`[${new Date().toLocaleTimeString('en-GB')}] Auto-scan (global=${globalAuto})`];
    let opened = 0;

    // Main scan pass — global auto bypasses per-pair toggle
    for (const pair of FX_PAIRS) {
      if (!globalAuto && !enabled[pair]) continue;
      const sig = signals[pair];
      if (!sig || sig.direction === 'NEUTRAL' || sig.confidence < FX_MIN_CONFIDENCE) {
        log.push(`  ○ ${pair}: ${sig ? `${sig.direction} conf=${sig.confidence}` : 'no signal'}`);
        continue;
      }

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

    // Volatility fallback: if global auto on, no positions opened, and no positions exist —
    // always open at least 1 using the biggest absolute movers
    if (globalAuto && opened === 0 && openPositions.length === 0) {
      log.push('  ⚡ Volatility fallback — picking top movers');
      const pairMoves = [...FX_PAIRS]
        .map(pair => ({
          pair,
          change: signals[pair]?.change1hPct ?? 0,
          absChange: Math.abs(signals[pair]?.change1hPct ?? 0),
        }))
        .sort((a, b) => b.absChange - a.absChange);

      // Open LONG on biggest up-mover + SHORT on biggest down-mover (if different pairs)
      const upMover   = pairMoves.find(p => p.change > 0);
      const downMover = pairMoves.find(p => p.change < 0);

      for (const candidate of [upMover, downMover]) {
        if (!candidate) continue;
        if (openPositions.some(p => p.pair === candidate.pair)) continue;
        if (openPositions.length + opened >= FX_MAX_POSITIONS) break;
        const dir: 'long' | 'short' = candidate.change >= 0 ? 'long' : 'short';
        if (hasCorrelationConflict(candidate.pair, dir, openPositions)) continue;
        const entryRate = derivePairRate(candidate.pair, currentRates);
        addFxPosition({ id: uid(), pair: candidate.pair, direction: dir, units: FX_TRADE_UNITS, entryRate, currentRate: entryRate, stopLossPips: FX_SL_PIPS, takeProfitPips: FX_TP_PIPS, pnlPips: 0, pnlGbp: 0, openedAt: new Date().toISOString(), trailingActive: false, autoManaged: true });
        openPositions = [...openPositions, { id: 'tmp', pair: candidate.pair, direction: dir, units: FX_TRADE_UNITS, entryRate, currentRate: entryRate, stopLossPips: FX_SL_PIPS, takeProfitPips: FX_TP_PIPS, pnlPips: 0, pnlGbp: 0, openedAt: '' }];
        opened++;
        log.push(`  ✓ Fallback ${dir.toUpperCase()} ${candidate.pair} @ ${fmtRate(entryRate, candidate.pair)} (${candidate.absChange.toFixed(3)}% move)`);
      }
    }

    if (opened === 0) log.push('  — No new positions opened');
    log.push(`  Done — ${opened} opened`);
    setAutoLog(prev => [...log, '', ...prev].slice(0, 80));
    setScanning(false);
  }

  function toggleGlobalFxAuto() {
    setGlobalFxAutoEnabled(prev => {
      const next = !prev;
      globalFxAutoEnabledRef.current = next;
      try { localStorage.setItem(LS_FX_GLOBAL_AUTO, String(next)); } catch {}
      // Trigger immediate scan when enabling
      if (next && Object.keys(prevRatesRef.current).length > 0) {
        setTimeout(() => runAutoScan(prevRatesRef.current, fxPositionsRef.current), 100);
      }
      return next;
    });
  }

  function forceOpenTestPositions() {
    if (Object.keys(rates).length === 0) return;
    const eurRate = derivePairRate('EUR/USD', rates);
    const gbpRate = derivePairRate('GBP/USD', rates);
    addFxPosition({ id: uid(), pair: 'EUR/USD', direction: 'long',  units: FX_TRADE_UNITS, entryRate: eurRate, currentRate: eurRate, stopLossPips: FX_SL_PIPS, takeProfitPips: FX_TP_PIPS, pnlPips: 0, pnlGbp: 0, openedAt: new Date().toISOString(), trailingActive: false, autoManaged: false });
    addFxPosition({ id: uid(), pair: 'GBP/USD', direction: 'short', units: FX_TRADE_UNITS, entryRate: gbpRate, currentRate: gbpRate, stopLossPips: FX_SL_PIPS, takeProfitPips: FX_TP_PIPS, pnlPips: 0, pnlGbp: 0, openedAt: new Date().toISOString(), trailingActive: false, autoManaged: false });
    setAutoLog(prev => [`[${new Date().toLocaleTimeString('en-GB')}] Force-opened test positions: LONG EUR/USD @ ${fmtRate(eurRate,'EUR/USD')}, SHORT GBP/USD @ ${fmtRate(gbpRate,'GBP/USD')}`, '', ...prev].slice(0, 80));
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
        <div className="flex items-center gap-2 flex-wrap">
          {/* Global auto-trade toggle */}
          <button
            onClick={toggleGlobalFxAuto}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
              globalFxAutoEnabled
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/30'
                : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-gray-200'
            )}
          >
            <span className={clsx('w-1.5 h-1.5 rounded-full', globalFxAutoEnabled ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500')} />
            {globalFxAutoEnabled ? 'Auto-Trade ON' : 'Auto-Trade OFF'}
          </button>

          <button
            onClick={() => { if (Object.keys(rates).length > 0) runAutoScan(rates, fxPositionsRef.current); }}
            disabled={scanning || Object.keys(rates).length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={clsx('h-3 w-3', scanning && 'animate-spin')} />
            {scanning ? 'Scanning…' : 'Scan Now'}
          </button>

          <button
            onClick={forceOpenTestPositions}
            disabled={Object.keys(rates).length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-500/20 text-blue-300 border border-blue-500/30 hover:bg-blue-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Immediately opens LONG EUR/USD + SHORT GBP/USD to test the position display"
          >
            ⚡ Force Test Position
          </button>
        </div>
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
        <p className="mt-2 text-[10px] text-gray-600 px-1">
          <span className="text-amber-400 font-semibold">How to use:</span> Toggle <span className="text-amber-500/70">Auto</span> on the pairs you want (right column). Click <span className="text-amber-500/70">Scan Now</span> to immediately find trades, or wait for auto-scan every 5 min. Max {FX_MAX_POSITIONS} positions. Signals appear once 2+ rate snapshots are collected (takes ~2 min on first use).
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
    t212DemoConnected, t212DemoApiKey, t212DemoApiSecret,
    t212IsaConnected, t212IsaApiKey, t212IsaApiSecret,
    demoPositions, demoTrades,
    paperBudget, setPaperBudget, resetPaperAccount,
    addDemoPosition, removeDemoPosition, updateDemoPosition, addDemoTrade,
    setPaperPositions, setPaperTrades, setPendingSignalCount,
  } = useClearGainsStore();

  const SIZE_PRESETS = [10, 50, 100, 250] as const;
  type SizePreset = typeof SIZE_PRESETS[number] | 'custom';

  const [traderTab, setTraderTab] = useState<'stocks' | 'forex' | 'ig'>('stocks');
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [showExecAccountPicker, setShowExecAccountPicker] = useState(false);
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
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);
  const [lastStrategyRun, setLastStrategyRun] = useState<string | null>(null);
  const [lastScanCount, setLastScanCount] = useState<number>(0);
  const [t212OrderResults, setT212OrderResults] = useState<
    { symbol: string; status: 'placed' | 'failed' | 'paper'; message: string }[]
  >([]);
  const [testOrderResult, setTestOrderResult] = useState<string | null>(null);
  const [testOrderLoading, setTestOrderLoading] = useState(false);

  // ── Strategy engine state ──────────────────────────────────────────────────
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [nextScanIn, setNextScanIn] = useState(300);
  const [strategyStatus, setStrategyStatus] = useState<'IDLE' | 'SCANNING' | 'HOLDING' | 'PAUSED'>('IDLE');
  const [holdOvernight, setHoldOvernight] = useState(false);
  const [pausedUntil, setPausedUntil] = useState<number | null>(null);
  const [strategyLog, setStrategyLog] = useState<StrategyLogEntry[]>([]);

  // ── Manual stock search state ───────────────────────────────────────────────
  const [manualStockQuery, setManualStockQuery] = useState('');
  const [manualStockResults, setManualStockResults] = useState<{symbol:string;description:string;type:string;t212Ticker:string;isUK:boolean}[]>([]);
  const [manualAddedStocks, setManualAddedStocks] = useState<ManualStock[]>([]);
  const [stockSearchLoading, setStockSearchLoading] = useState(false);

  // ── Pending orders (queued while market closed) ────────────────────────────
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);
  const [executingPending, setExecutingPending] = useState(false);
  const pendingOrdersRef = useRef<PendingOrder[]>([]);

  // ── Portfolio management state ─────────────────────────────────────────────
  const [portfolios, setPortfolios] = useState<PortfolioMeta[]>([]);
  const [activePortfolioId, setActivePortfolioId] = useState<string | null>(null);
  const [showCreatePortfolio, setShowCreatePortfolio] = useState(false);
  const [portfolioView, setPortfolioView] = useState<'trader' | 'compare'>('trader');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevPricesRef = useRef<Record<string, number>>({});

  // ── Refs for save-on-unmount (avoids stale closure) ───────────────────────
  const activePortfolioIdRef = useRef<string | null>(null);
  const demoPositionsRef     = useRef(demoPositions);
  const demoTradesRef        = useRef(demoTrades);
  const paperBudgetRef       = useRef(paperBudget);
  const portfoliosRef        = useRef(portfolios);
  const hasInitializedRef    = useRef(false); // true after mount loads data
  const autoSaveTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [lastSaved, setLastSaved]           = useState<Date | null>(null);
  const [saveStatus, setSaveStatus]         = useState<'idle' | 'saving' | 'saved'>('idle');

  // Keep refs current so the unmount cleanup always sees latest values
  useEffect(() => { activePortfolioIdRef.current = activePortfolioId; }, [activePortfolioId]);
  useEffect(() => { demoPositionsRef.current = demoPositions; }, [demoPositions]);
  useEffect(() => { demoTradesRef.current = demoTrades; }, [demoTrades]);
  useEffect(() => { paperBudgetRef.current = paperBudget; }, [paperBudget]);
  useEffect(() => { portfoliosRef.current = portfolios; }, [portfolios]);
  useEffect(() => { pendingOrdersRef.current = pendingOrders; }, [pendingOrders]);

  // ── Restore paper state from dedicated localStorage keys on mount ──────────
  useEffect(() => {
    // ── Portfolio system init ──────────────────────────────────────────────────
    let ids = loadPortfolioIds();
    let activeId = localStorage.getItem(ACTIVE_PORTFOLIO_KEY);

    // Migrate legacy data: if no portfolios exist but legacy data does
    if (ids.length === 0) {
      const legacyPos = localStorage.getItem('paper_positions');
      const legacyBudget = localStorage.getItem('paper_budget');
      const defaultId = `p_${Date.now()}`;
      const defaultMeta: PortfolioMeta = {
        id: defaultId, name: 'Default Portfolio', strategy: 'momentum',
        riskMode: 'balanced', sectorFocus: 'All', autoTrade: true,
        status: 'active', createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        paperBudget: legacyBudget ? Number(JSON.parse(legacyBudget)) : 1000,
        executionAccount: 'paper',
      };
      savePortfolioMeta(defaultMeta);
      if (legacyPos) {
        try { localStorage.setItem(portfolioKey(defaultId, 'positions'), legacyPos); } catch {}
      }
      const legacyTrades = localStorage.getItem('paper_trades');
      if (legacyTrades) {
        try { localStorage.setItem(portfolioKey(defaultId, 'trades'), legacyTrades); } catch {}
      }
      if (legacyBudget) {
        try { localStorage.setItem(portfolioKey(defaultId, 'budget'), legacyBudget); } catch {}
      }
      ids = [defaultId];
      savePortfolioIds(ids);
      activeId = defaultId;
      localStorage.setItem(ACTIVE_PORTFOLIO_KEY, defaultId);
    }

    // Load all portfolio metadata
    const allMeta = ids.map(id => loadPortfolioMeta(id)).filter(Boolean) as PortfolioMeta[];
    setPortfolios(allMeta);

    // Load active portfolio
    const resolvedId = activeId && ids.includes(activeId) ? activeId : ids[0];
    if (resolvedId) {
      setActivePortfolioId(resolvedId);
      loadPortfolioIntoStore(resolvedId);
    }
    setPendingSignalCount(0);

    // ── Load persisted strategy preferences ───────────────────────────────────
    const savedAmt = localStorage.getItem('custom_trade_amount');
    if (savedAmt) { setCustomSizeStr(savedAmt); setSizePreset('custom'); }

    const savedManual = localStorage.getItem('manual_strategy_stocks');
    if (savedManual) { try { setManualAddedStocks(JSON.parse(savedManual) as ManualStock[]); } catch {} }

    const savedPending = localStorage.getItem('pending_orders');
    if (savedPending) { try { setPendingOrders(JSON.parse(savedPending) as PendingOrder[]); } catch {} }

    // Signal that initial load is done — auto-save can now run
    setTimeout(() => { hasInitializedRef.current = true; }, 500);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadPortfolioIntoStore(id: string) {
    const positions = loadPortfolioPositions(id);
    const trades = loadPortfolioTrades(id);
    const budget = loadPortfolioBudget(id);
    if (positions.length > 0) setPaperPositions(positions);
    else setPaperPositions([]);
    if (trades.length > 0) setPaperTrades(trades);
    else setPaperTrades([]);
    if (budget && budget > 0) { setPaperBudget(budget); setBudgetStr(String(budget)); }
    else { setPaperBudget(1000); setBudgetStr('1000'); }
  }

  function saveCurrentPortfolioToLS() {
    if (!activePortfolioId) return;
    try { localStorage.setItem(portfolioKey(activePortfolioId, 'positions'), JSON.stringify(demoPositions)); } catch {}
    try { localStorage.setItem(portfolioKey(activePortfolioId, 'trades'), JSON.stringify(demoTrades)); } catch {}
    try { localStorage.setItem(portfolioKey(activePortfolioId, 'budget'), JSON.stringify(paperBudget)); } catch {}
    const meta = portfolios.find(p => p.id === activePortfolioId);
    if (meta) { savePortfolioMeta({ ...meta, lastActiveAt: new Date().toISOString() }); }
    // Sync to Redis (fire-and-forget, localStorage stays primary)
  }

  // Ref-safe version — reads from refs, safe to call inside useEffect cleanups
  function savePortfolioFromRefs() {
    const id = activePortfolioIdRef.current;
    if (!id) return;
    try { localStorage.setItem(portfolioKey(id, 'positions'), JSON.stringify(demoPositionsRef.current)); } catch {}
    try { localStorage.setItem(portfolioKey(id, 'trades'), JSON.stringify(demoTradesRef.current)); } catch {}
    try { localStorage.setItem(portfolioKey(id, 'budget'), JSON.stringify(paperBudgetRef.current)); } catch {}
    const meta = portfoliosRef.current.find(p => p.id === id);
    if (meta) { savePortfolioMeta({ ...meta, lastActiveAt: new Date().toISOString() }); }
    // Sync to Redis (ref-safe)
  }

  // ── Auto-save: debounced write whenever positions/trades/budget change ─────
  useEffect(() => {
    if (!hasInitializedRef.current || !activePortfolioId) return;
    setSaveStatus('saving');
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      saveCurrentPortfolioToLS();
      const now = new Date();
      setLastSaved(now);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2500);
    }, 1500); // 1.5 s debounce — avoids thrashing on rapid price refreshes
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoPositions, demoTrades, paperBudget, activePortfolioId]);

  // ── Save on unmount (navigate away) — uses refs to avoid stale closure ────
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      savePortfolioFromRefs();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function switchToPortfolio(id: string) {
    saveCurrentPortfolioToLS();
    setActivePortfolioId(id);
    localStorage.setItem(ACTIVE_PORTFOLIO_KEY, id);
    loadPortfolioIntoStore(id);
    const meta = portfolios.find(p => p.id === id);
    if (meta) {
      showToast(`Switched to "${meta.name}"`);
      // Apply portfolio sector settings
      if (meta.sectorFocus !== 'All') setSectors([meta.sectorFocus as Sector]);
      else setSectors(['All'] as Sector[]);
    }
  }

  function createPortfolio(data: Omit<PortfolioMeta, 'id' | 'createdAt' | 'lastActiveAt'>) {
    const ids = loadPortfolioIds();
    if (ids.length >= MAX_PORTFOLIOS) { showToast('Maximum 10 portfolios reached'); return; }
    const id = `p_${Date.now()}`;
    const meta: PortfolioMeta = { ...data, id, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() };
    savePortfolioMeta(meta);
    localStorage.setItem(portfolioKey(id, 'budget'), JSON.stringify(data.paperBudget));
    const newIds = [...ids, id];
    savePortfolioIds(newIds);
    const newPortfolios = [...portfolios, meta];
    setPortfolios(newPortfolios);
    switchToPortfolio(id);
  }

  function deletePortfolio(id: string) {
    const ids = loadPortfolioIds().filter(i => i !== id);
    savePortfolioIds(ids);
    try { localStorage.removeItem(portfolioKey(id, 'meta')); } catch {}
    try { localStorage.removeItem(portfolioKey(id, 'positions')); } catch {}
    try { localStorage.removeItem(portfolioKey(id, 'trades')); } catch {}
    try { localStorage.removeItem(portfolioKey(id, 'budget')); } catch {}
    const remaining = portfolios.filter(p => p.id !== id);
    setPortfolios(remaining);
    // Sync deletion to Redis
    setShowDeleteConfirm(null);
    if (activePortfolioId === id) {
      const nextId = ids[0];
      if (nextId) switchToPortfolio(nextId);
      else { setActivePortfolioId(null); setPaperPositions([]); setPaperTrades([]); setPaperBudget(1000); setBudgetStr('1000'); }
    }
  }

  function duplicatePortfolio(id: string) {
    const meta = portfolios.find(p => p.id === id);
    if (!meta) return;
    createPortfolio({ ...meta, name: `${meta.name} (copy)`, status: 'active' });
  }

  function togglePortfolioStatus(id: string) {
    const meta = portfolios.find(p => p.id === id);
    if (!meta) return;
    const newStatus: PortfolioStatus = meta.status === 'active' ? 'paused' : 'active';
    const updated = { ...meta, status: newStatus };
    savePortfolioMeta(updated);
    const updatedPortfolios = portfolios.map(p => p.id === id ? updated : p);
    setPortfolios(updatedPortfolios);
  }

  function changeExecutionAccount(acc: ExecutionAccount) {
    if (!activePortfolioId) return;
    const meta = portfolios.find(p => p.id === activePortfolioId);
    if (!meta) return;
    const updated = { ...meta, executionAccount: acc };
    savePortfolioMeta(updated);
    const updatedPortfolios = portfolios.map(p => p.id === activePortfolioId ? updated : p);
    setPortfolios(updatedPortfolios);
    setShowExecAccountPicker(false);
    showToast(`Execution account set to ${EXECUTION_ACCOUNT_LABELS[acc]}`);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

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

  // Manual mode: fixed trade size from preset buttons (supports any decimal)
  const manualTradeSize = sizePreset === 'custom'
    ? (parseFloat(customSizeStr) || 0)
    : sizePreset;

  // Kelly-inspired position sizing based on signal confidence
  function kellySizing(confidence: number, capital: number): { size: number; pct: number; reason: string } {
    const cap = capital * 0.20; // never more than 20% in one position
    if (confidence > 80) return { size: Math.min(capital * 0.05, cap), pct: 5, reason: 'High confidence (>80%) — 5% allocation' };
    if (confidence > 65) return { size: Math.min(capital * 0.03, cap), pct: 3, reason: 'Medium confidence (65-80%) — 3% allocation' };
    return { size: Math.min(capital * 0.015, cap), pct: 1.5, reason: 'Lower confidence (50-65%) — 1.5% allocation' };
  }

  // Fractional quantity: 4 decimal places, min 0.0001 shares
  function calcQuantity(positionSize: number, price: number): number {
    return Math.max(0.0001, Math.round((positionSize / price) * 10000) / 10000);
  }

  // Sector count helper for diversification check
  function sectorCount(sector: string): number {
    return demoPositions.filter(p => p.sector === sector).length;
  }

  // Strategy log helper — prepends entry, keeps last 100
  function addStratLog(entry: Omit<StrategyLogEntry, 'id' | 'ts'>) {
    setStrategyLog(prev => [{ ...entry, id: uid(), ts: new Date().toISOString() }, ...prev].slice(0, 100));
  }

  // Export strategy log as CSV
  function exportLogCSV() {
    const headers = 'Timestamp,Type,Ticker,Action,Reason,Price,PnL,PnL%,Value';
    const rows = strategyLog.map(e =>
      [e.ts, e.type, e.ticker ?? '', e.action, `"${e.reason}"`, e.price?.toFixed(2) ?? '', e.pnl?.toFixed(2) ?? '', e.pnlPct?.toFixed(2) ?? '', e.positionValue?.toFixed(2) ?? ''].join(',')
    );
    const csv = [headers, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `strategy-log-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  // Auto mode: backward-compat alias
  function autoTradeSize(score: number): number {
    return kellySizing(score, availableBalance).size;
  }

  // ── Fee-aware calculations ──────────────────────────────────────────────────
  function calcFees(entry: number, size: number, isUK: boolean) {
    const feePct = isUK ? UK_TOTAL_FEE : US_TOTAL_FEE;
    const feeAmount = size * (feePct / 100);
    // Break-even: covers fee on entry + fee on exit
    const breakeven = entry * (1 + (2 * feePct) / 100);
    // Net profit potential (TP minus fees, as % of entry)
    const tpPrice = entry * (1 + tpPct / 100);
    const netProfitPct = ((tpPrice * (1 - feePct / 100) - entry * (1 + feePct / 100)) / (entry * (1 + feePct / 100))) * 100;
    return { feePct, feeAmount, breakeven, netProfitPct };
  }

  // ── UK market hours check ─────────────────────────────────────────────────
  function isUKMarketOpen(): boolean {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(now);
    const day = parts.find(p => p.type === 'weekday')?.value ?? '';
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
    const dayNum = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day);
    const isWeekday = dayNum >= 1 && dayNum <= 5;
    const timeInMins = hour * 60 + minute;
    return isWeekday && timeInMins >= 8 * 60 && timeInMins < 16 * 60 + 30;
  }

  function isMarketOpenNow(isUK: boolean): boolean {
    return isUK ? isUKMarketOpen() : getMarketStatus().status === 'open';
  }

  // ── Manual stock search ───────────────────────────────────────────────────
  async function searchStocks() {
    const q = manualStockQuery.trim();
    if (!q) return;
    setStockSearchLoading(true);
    try {
      const res = await fetch(`/api/t212/search?q=${encodeURIComponent(q)}`);
      const data = await res.json() as { results: typeof manualStockResults };
      setManualStockResults(data.results ?? []);
    } catch {
      setManualStockResults([]);
    } finally {
      setStockSearchLoading(false);
    }
  }

  function addManualStock(r: typeof manualStockResults[number]) {
    const stock: ManualStock = { symbol: r.symbol, name: r.description, t212Ticker: r.t212Ticker, isUK: r.isUK };
    const updated = [...manualAddedStocks.filter(s => s.symbol !== r.symbol), stock];
    setManualAddedStocks(updated);
    localStorage.setItem('manual_strategy_stocks', JSON.stringify(updated));
    setManualStockQuery('');
    setManualStockResults([]);
  }

  function removeManualStock(symbol: string) {
    const updated = manualAddedStocks.filter(s => s.symbol !== symbol);
    setManualAddedStocks(updated);
    localStorage.setItem('manual_strategy_stocks', JSON.stringify(updated));
  }

  // ── Execute pending orders ─────────────────────────────────────────────────
  async function executePendingOrders(ordersToRun?: PendingOrder[]) {
    const orders = ordersToRun ?? pendingOrders;
    if (orders.length === 0) return;
    setExecutingPending(true);
    setRunLog(l => [...l, `📲 Executing ${orders.length} queued order(s)…`]);

    type OrderResp = { ok: boolean; orderId?: unknown; ticker?: string; quantity?: number; error?: string; t212Status?: number; t212Body?: string };
    const results = await Promise.allSettled(
      orders.map(o =>
        fetch('/api/t212/live-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-t212-auth': o.orderAuth },
          body: JSON.stringify({ ticker: o.t212Ticker, quantity: o.quantity, env: o.orderEnv }),
        }).then(r => r.json() as Promise<OrderResp>)
      )
    );

    const stillPending: PendingOrder[] = [];
    results.forEach((result, i) => {
      const o = orders[i];
      if (result.status === 'fulfilled' && result.value.ok) {
        setRunLog(l => [...l, `  ✅ ${o.accountLabel}: ${o.symbol} → Order #${result.value.orderId ?? '?'} placed`]);
        addStratLog({ type: 'buy', ticker: o.symbol, action: `→ OPENED ${o.quantity.toFixed(4)}× @ ${fmtUSD(o.entryPrice)}`, reason: `Queued order executed · fee ${o.feePct}% · BEP ${fmtUSD(o.breakeven)}`, price: o.entryPrice, positionValue: o.size });
      } else {
        const err = result.status === 'fulfilled' ? (result.value.error ?? `HTTP ${result.value.t212Status}`) : String((result as PromiseRejectedResult).reason);
        setRunLog(l => [...l, `  ✗ ${o.symbol}: ${err} — kept in queue`]);
        stillPending.push(o);
      }
    });

    setPendingOrders(stillPending);
    localStorage.setItem('pending_orders', JSON.stringify(stillPending));
    setExecutingPending(false);
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

  // ── Test order (1× AAPL on Practice account) ──────────────────────────────
  async function runTestOrder() {
    const demoKey = t212DemoApiKey;
    const demoSecret = t212DemoApiSecret;
    if (!demoKey || !demoSecret) {
      setTestOrderResult('✗ No demo credentials stored — reconnect Practice account in Settings → Accounts');
      return;
    }
    const encoded = btoa(demoKey + ':' + demoSecret);
    setTestOrderLoading(true);
    const reqBody = { ticker: 'AAPL_US_EQ', quantity: 0.01, env: 'demo' };
    setTestOrderResult(`→ Sending: POST /api/t212/live-order\n   Body: ${JSON.stringify(reqBody)}\n   Auth: Basic ${encoded.slice(0, 8)}…`);
    try {
      const res = await fetch('/api/t212/live-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-t212-auth': encoded },
        body: JSON.stringify(reqBody),
      });
      const data = await res.json();
      const lines = [
        `→ URL: POST https://demo.trading212.com/api/v0/equity/orders/market`,
        `→ Body sent: ${JSON.stringify(reqBody)}`,
        `← HTTP status: ${res.status}`,
        `← Full response: ${JSON.stringify(data)}`,
        data.ok
          ? `✓ SUCCESS — Order #${data.orderId ?? '?'} · ticker: ${data.ticker ?? '?'} · qty: ${data.quantity ?? '?'}`
          : `✗ FAILED — ${data.error || `HTTP ${data.t212Status ?? res.status}`}${data.t212Body ? `\n   T212 body: ${data.t212Body}` : ''}`,
      ];
      setTestOrderResult(lines.join('\n'));
    } catch (err) {
      setTestOrderResult(`✗ Network error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTestOrderLoading(false);
    }
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

        // ── Trailing stop: once +3% in profit, move SL to breakeven ──────────
        let updatedSl = pos.stopLoss;
        if (pnlPct >= 3 && pos.stopLoss < pos.entryPrice) {
          updatedSl = pos.entryPrice * 1.001; // 0.1% above entry = locks in small profit
          updateDemoPosition(pos.id, { currentPrice, pnl, pnlPct, stopLoss: updatedSl });
          addStratLog({ type: 'adjust', ticker: pos.ticker, action: 'Trailing stop → breakeven', reason: `+${pnlPct.toFixed(1)}% profit — SL moved to entry`, price: currentPrice, pnl, pnlPct });
        } else {
          updateDemoPosition(pos.id, { currentPrice, pnl, pnlPct });
        }

        // ── Check SL/TP ───────────────────────────────────────────────────────
        const activeSl = updatedSl;
        if (currentPrice <= activeSl || currentPrice >= pos.takeProfit) {
          const closeReason: DemoTrade['closeReason'] =
            currentPrice <= activeSl ? 'stop-loss' : 'take-profit';
          const activeMeta = portfolios.find(p => p.id === activePortfolioId);
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
            accountType: activeMeta?.executionAccount ?? 'paper',
          });
          removeDemoPosition(pos.id);
          addStratLog({
            type: 'sell', ticker: pos.ticker,
            action: closeReason === 'stop-loss' ? 'Stop-loss hit' : 'Take-profit hit',
            reason: closeReason === 'stop-loss' ? `SL at ${fmtUSD(activeSl)} triggered` : `TP at ${fmtUSD(pos.takeProfit)} triggered`,
            price: currentPrice, pnl, pnlPct, positionValue: currentPrice * pos.quantity,
          });

          // Push notification for SL/TP hit
          const isTP = closeReason === 'take-profit';
          sendPush(
            isTP ? `Take-Profit Hit — ${pos.ticker}` : `Stop-Loss Hit — ${pos.ticker}`,
            `${pos.companyName} · ${fmtPct(pnlPct)} · Entry ${fmtUSD(pos.entryPrice)} → Exit ${fmtUSD(currentPrice)}`,
            '/demo-trader'
          );
          continue; // position closed — skip further checks
        }

        // ── 48-hour time-based exit for unprofitable positions ────────────────
        const heldHours = (Date.now() - new Date(pos.openedAt).getTime()) / 3_600_000;
        if (heldHours >= 48 && pnl <= 0) {
          const activeMeta = portfolios.find(p => p.id === activePortfolioId);
          addDemoTrade({
            id: uid(), ticker: pos.ticker, t212Ticker: pos.t212Ticker,
            companyName: pos.companyName, sector: pos.sector,
            quantity: pos.quantity, entryPrice: pos.entryPrice,
            exitPrice: currentPrice, pnl, pnlPct,
            openedAt: pos.openedAt, closedAt: new Date().toISOString(),
            closeReason: 'manual', accountType: activeMeta?.executionAccount ?? 'paper',
          });
          removeDemoPosition(pos.id);
          addStratLog({ type: 'sell', ticker: pos.ticker, action: 'Time exit (48h)', reason: `Held ${heldHours.toFixed(0)}h without profit — time-based exit`, price: currentPrice, pnl, pnlPct });
          continue;
        }
      }

      // Apply flashes, then clear after 900ms
      if (Object.keys(newFlash).length > 0) {
        setPriceFlash(newFlash);
        setTimeout(() => setPriceFlash({}), 900);
      }

      // ── Overnight close (3:45pm ET = 19:45 UTC in summer / 20:45 in winter) ─
      if (!holdOvernight) {
        const now = new Date();
        const etHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(now));
        const etMin = now.getUTCMinutes();
        const isCloseTime = etHour === 15 && etMin >= 45;
        if (isCloseTime && demoPositions.length > 0) {
          for (const pos of [...demoPositions]) {
            const cp = data.prices[pos.ticker] ?? pos.currentPrice;
            const closePnl = (cp - pos.entryPrice) * pos.quantity;
            const closePnlPct = ((cp - pos.entryPrice) / pos.entryPrice) * 100;
            const activeMeta2 = portfolios.find(p => p.id === activePortfolioId);
            addDemoTrade({
              id: uid(), ticker: pos.ticker, t212Ticker: pos.t212Ticker,
              companyName: pos.companyName, sector: pos.sector,
              quantity: pos.quantity, entryPrice: pos.entryPrice,
              exitPrice: cp, pnl: closePnl, pnlPct: closePnlPct,
              openedAt: pos.openedAt, closedAt: new Date().toISOString(),
              closeReason: 'manual', accountType: activeMeta2?.executionAccount ?? 'paper',
            });
            removeDemoPosition(pos.id);
            addStratLog({ type: 'sell', ticker: pos.ticker, action: 'End-of-day close', reason: '3:45pm ET — intraday close', price: cp, pnl: closePnl, pnlPct: closePnlPct });
          }
        }
      }

      // ── Drawdown protection: pause new entries if portfolio down 5% ──────────
      const portfolioPnL = demoPositions.reduce((s, p) => s + p.pnl, 0) + demoTrades.reduce((s, t) => s + t.pnl, 0);
      const drawdownPct = paperBudget > 0 ? (portfolioPnL / paperBudget) * 100 : 0;
      if (drawdownPct <= -5 && pausedUntil === null && strategyStatus !== 'PAUSED') {
        const resumeAt = Date.now() + 3_600_000;
        setPausedUntil(resumeAt);
        setStrategyStatus('PAUSED');
        addStratLog({ type: 'pause', action: 'Strategy PAUSED — drawdown protection', reason: `Portfolio down ${Math.abs(drawdownPct).toFixed(1)}% — new entries paused for 1 hour` });
      }
      // Auto-resume after pause period
      if (pausedUntil !== null && Date.now() > pausedUntil && strategyStatus === 'PAUSED') {
        setPausedUntil(null);
        setStrategyStatus(demoPositions.length > 0 ? 'HOLDING' : 'IDLE');
        addStratLog({ type: 'info', action: 'Strategy RESUMED', reason: 'Drawdown protection period ended' });
      }

      setLastRefreshed(Date.now());

      // ── Auto-execute pending orders when market opens ──────────────────────
      const pending = pendingOrdersRef.current;
      if (pending.length > 0) {
        const usOpen = getMarketStatus().status === 'open';
        const ukOpen = isUKMarketOpen();
        const executableNow = pending.filter(o => (o.isUK ? ukOpen : usOpen));
        if (executableNow.length > 0) {
          setRunLog(l => [...l, `⏰ Market opened — auto-executing ${executableNow.length} queued order(s)…`]);
          executePendingOrders(executableNow).catch(() => {});
        }
      }
    } catch {
      // Ignore refresh errors silently
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, [demoPositions, updateDemoPosition, addDemoTrade, removeDemoPosition]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── Autonomous 5-minute scan ────────────────────────────────────────────────
  const autoScanRef = useRef(false);
  useEffect(() => { autoScanRef.current = autoScanEnabled; }, [autoScanEnabled]);

  useEffect(() => {
    if (!autoScanEnabled) { setNextScanIn(300); return; }
    setNextScanIn(300);

    const countdown = setInterval(() => {
      setNextScanIn(n => (n <= 1 ? 300 : n - 1));
    }, 1000);

    const scanner = setInterval(() => {
      if (autoScanRef.current && !scanning) runStrategy(); // eslint-disable-line react-hooks/exhaustive-deps
    }, 300_000);

    addStratLog({ type: 'info', action: 'Auto-scan ENABLED', reason: 'Strategy engine will scan every 5 minutes' });
    setStrategyStatus('HOLDING');

    return () => { clearInterval(countdown); clearInterval(scanner); };
  }, [autoScanEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const secondsAgo = lastRefreshed > 0 ? Math.floor((Date.now() - lastRefreshed) / 1000) : null;
  void tick; // used only to trigger re-render for countdown

  // ── Run strategy ───────────────────────────────────────────────────────────
  async function runStrategy() {
    setScanning(true);
    setScanError(null);
    setRunLog([]);
    setStrategyStatus('SCANNING');

    try {
      const selectedSectors = sectors.includes('All') ? ['All'] : sectors;
      const activeMeta = portfolios.find(p => p.id === activePortfolioId);
      const activeStrategy = activeMeta?.strategy ?? 'momentum';
      const isSmartMoney   = activeStrategy === 'smart-money';
      setRunLog(l => [...l, `📡 Scanning ${selectedSectors.join(', ')} via Finnhub${isSmartMoney ? ' [Smart Money Swing]' : ''}…`]);

      const sigRes = await fetch('/api/demo-trader/signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectors: selectedSectors, strategy: activeStrategy }),
      });
      const sigData = await sigRes.json() as {
        signals?: Signal[]; error?: string;
        scannedCount?: number; candidateCount?: number; apiCallsUsed?: number;
        skippedSummary?: string | null;
        debugLog?: string[]; timestamp?: string;
      };

      // Capture debug info from API
      if (sigData.debugLog) setDebugLog(sigData.debugLog);
      if (sigData.timestamp) setLastStrategyRun(sigData.timestamp);
      if (sigData.scannedCount) setLastScanCount(sigData.scannedCount);

      if (sigData.error) {
        setScanError(sigData.error);
        setDebugOpen(true); // auto-open debug panel on error
        return;
      }

      const allSignals = sigData.signals ?? [];
      setSignals(allSignals);
      setApiCalls(sigData.apiCallsUsed ?? 0);
      const scanSummary = sigData.skippedSummary
        ? `✓ ${sigData.skippedSummary} — ${allSignals.filter(s => s.signal === 'BUY').length} BUY · ${allSignals.filter(s => s.signal === 'SELL').length} SELL signals.`
        : `✓ Scanned ${sigData.scannedCount ?? 0} stocks (${sigData.candidateCount ?? 0} momentum candidates) — ${allSignals.filter(s => s.signal === 'BUY').length} BUY · ${allSignals.filter(s => s.signal === 'SELL').length} SELL signals. ${sigData.apiCallsUsed ?? 0} API calls used.`;
      setRunLog(l => [...l, scanSummary]);

      // Push notifications for strong signals (score > 50)
      for (const sig of allSignals) {
        if (sig.score > 50) {
          sendPush(
            `${sig.signal} Signal — ${sig.symbol}`,
            `${sig.name} · Strength ${sig.score}% · $${sig.currentPrice.toFixed(2)} (${sig.changePercent >= 0 ? '+' : ''}${sig.changePercent.toFixed(2)}%)`,
            '/demo-trader'
          );
        }
      }

      // Drawdown protection check
      if (pausedUntil !== null && Date.now() < pausedUntil) {
        const resumeTime = new Date(pausedUntil).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        setRunLog(l => [...l, `⏸ Strategy paused (drawdown protection) — resumes at ${resumeTime}`]);
        return;
      }

      // Build eligible buy list with diversification rules
      const heldTickers = new Set(demoPositions.map(p => p.ticker));
      const sectorCounts = demoPositions.reduce<Record<string, number>>((acc, p) => {
        acc[p.sector] = (acc[p.sector] ?? 0) + 1; return acc;
      }, {});

      // Inject manually added stocks as forced BUY signals (fetch live quotes)
      const enrichedSignals = [...allSignals];
      for (const ms of manualAddedStocks) {
        if (!enrichedSignals.find(s => s.symbol === ms.symbol)) {
          try {
            const q = await fetch(`/api/stock/profile?symbol=${encodeURIComponent(ms.symbol)}`).then(r => r.json()) as { price?: number; changePercent?: number };
            if (q.price && q.price > 0) {
              enrichedSignals.push({
                symbol: ms.symbol, name: ms.name, t212Ticker: ms.t212Ticker,
                sector: 'Custom', isUK: ms.isUK,
                score: 100, currentPrice: q.price, changePercent: q.changePercent ?? 0,
                volume: 0, volRatio: 1, newsCount: 0, recentNewsCount: 0,
                signal: 'BUY', badges: ['Manual'], reason: 'Manual override',
              });
              setRunLog(l => [...l, `  ➕ Manual: ${ms.symbol} @ ${ms.isUK ? fmtGBP(q.price!) : fmtUSD(q.price!)}`]);
            }
          } catch { /* skip if quote fails */ }
        }
      }

      const buys = enrichedSignals
        .filter(s => s.signal === 'BUY')
        .filter(s => !heldTickers.has(s.symbol))               // no doubling
        .filter(s => (sectorCounts[s.sector] ?? 0) < 5)        // max 5 per sector
        .filter(s => s.score >= 50)                             // min quality threshold
        .slice(0, isSmartMoney ? SMART_MONEY_MAX_POS : 20);    // cap at 20 new positions per run

      if (buys.length === 0) {
        const reason = heldTickers.size > 0
          ? `ℹ No new BUY signals (${heldTickers.size} positions open, sector limits or quality filter applied)`
          : 'ℹ No BUY signals returned — check debug panel for details.';
        setRunLog(l => [...l, reason]);
        setDebugOpen(true);
        return;
      }

      // Capital check: skip if less than 0.5% of budget available
      if (availableBalance < paperBudget * 0.005) {
        setRunLog(l => [...l, `⚠ Available capital (${fmtGBP(availableBalance)}) too low — close existing positions first.`]);
        return;
      }

      if (mode === 'manual' && manualTradeSize <= 0) {
        setRunLog(l => [...l, '⚠ Trade size is £0 — set a position size first.']);
        return;
      }

      setRunLog(l => [...l, `📋 Opening ${buys.length} position(s) in ${mode} mode${isSmartMoney ? ' [2:1 R:R · 1% risk]' : ''}…`]);

      for (const signal of buys) {
        const entryPrice = signal.currentPrice;

        // Smart-Money: size so that SL loss = 1% of portfolio; others use Kelly sizing
        let size: number;
        let sizeReason: string;
        if (isSmartMoney) {
          const riskAmount = paperBudget * (SMART_MONEY_RISK_PCT / 100);
          const slDistance = entryPrice * (SMART_MONEY_SL_PCT / 100);
          const sharesForRisk = riskAmount / slDistance;
          size = Math.min(sharesForRisk * entryPrice, availableBalance * 0.20);
          sizeReason = `Smart Money 1% risk — ${fmtGBP(size)}`;
        } else if (mode === 'auto') {
          const kelly = kellySizing(signal.score, availableBalance);
          size = kelly.size;
          sizeReason = kelly.reason;
        } else {
          size = Math.min(manualTradeSize, availableBalance * 0.20);
          sizeReason = `Manual ${fmtGBP(size)}`;
        }

        // Fractional quantity: 4 decimal places, min 0.0001
        const quantity = calcQuantity(size, entryPrice);
        const useSl = isSmartMoney ? SMART_MONEY_SL_PCT : slPct;
        const useTp = isSmartMoney ? SMART_MONEY_TP_PCT : tpPct;

        // Fee-aware calculations
        const fees = calcFees(entryPrice, size, signal.isUK);
        // Adjust SL to account for fees (need slightly more room to cover costs)
        const sl = entryPrice * (1 - (useSl + fees.feePct) / 100);
        const tp = entryPrice * (1 + useTp / 100);

        // Skip if net profit potential after fees is negligible (<0.5%)
        if (fees.netProfitPct < 0.5) {
          setRunLog(l => [...l, `  ⚠ Skipping ${signal.symbol} — net profit after ${fees.feePct}% fees is only ${fees.netProfitPct.toFixed(2)}%`]);
          continue;
        }

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
        setRunLog(l => [
          ...l,
          `  → OPENING ${quantity.toFixed(4)}× ${signal.symbol} @ ${signal.isUK ? fmtGBP(entryPrice) : fmtUSD(entryPrice)} · ${fmtGBP(size)} · Fee ${fees.feePct}% (${fmtGBP(fees.feeAmount)}) · BEP ${signal.isUK ? fmtGBP(fees.breakeven) : fmtUSD(fees.breakeven)} · SL ${signal.isUK ? fmtGBP(sl) : fmtUSD(sl)} · TP ${signal.isUK ? fmtGBP(tp) : fmtUSD(tp)} · Net +${fees.netProfitPct.toFixed(2)}%`,
        ]);
        addStratLog({
          type: 'buy', ticker: signal.symbol,
          action: `→ OPENED ${quantity.toFixed(4)}× @ ${signal.isUK ? fmtGBP(entryPrice) : fmtUSD(entryPrice)}`,
          reason: `${sizeReason} · fee ${fees.feePct}% · BEP ${signal.isUK ? fmtGBP(fees.breakeven) : fmtUSD(fees.breakeven)}`,
          price: entryPrice, positionValue: size,
          strategy: activeStrategy,
        });
      }

      setRunLog(l => [...l, '✅ Strategy complete — positions tracked in paper engine.']);
      localStorage.setItem('last_signal_run', Date.now().toString());

      // ── Route orders to the correct T212 account ──────────────────────────
      const execAccount: ExecutionAccount = activeMeta?.executionAccount ?? 'paper';

      // Determine credentials and env based on executionAccount
      const investEncoded = t212ApiKey && t212ApiSecret ? btoa(t212ApiKey + ':' + t212ApiSecret) : '';
      const isaEncoded = t212IsaApiKey && t212IsaApiSecret ? btoa(t212IsaApiKey + ':' + t212IsaApiSecret) : '';
      const demoEncoded = t212DemoApiKey && t212DemoApiSecret ? btoa(t212DemoApiKey + ':' + t212DemoApiSecret) : '';

      let orderAuth = '';
      let orderEnv: 'live' | 'demo' = 'live';
      let accountLabel = '';

      if (execAccount === 'practice' && t212DemoConnected && demoEncoded) {
        orderAuth = demoEncoded;
        orderEnv = 'demo';
        accountLabel = 'T212 Practice';
      } else if (execAccount === 'invest' && investEncoded) {
        orderAuth = investEncoded;
        orderEnv = 'live';
        accountLabel = 'T212 Invest';
      } else if (execAccount === 'isa' && t212IsaConnected && isaEncoded) {
        orderAuth = isaEncoded;
        orderEnv = 'live';
        accountLabel = 'T212 ISA';
      }

      type OrderResp = {
        ok: boolean;
        orderId?: unknown;
        error?: string;
        ticker?: string;
        quantity?: number;
        note?: string;
        t212Status?: number;
        t212Body?: string;
        data?: Record<string, unknown>;
        env?: string;
        marketClosed?: boolean;
      };

      // ── Explicit credential checks before attempting orders ────────────────
      if (execAccount === 'practice' && !t212DemoConnected) {
        setRunLog(l => [...l, `  ✗ T212 Practice: Not connected — go to Settings → Accounts to connect`]);
        setT212OrderResults(buys.map(s => ({ symbol: s.symbol, status: 'failed' as const, message: '✗ Practice account not connected' })));
      } else if (execAccount === 'practice' && t212DemoConnected && !demoEncoded) {
        setRunLog(l => [...l, `  ✗ T212 Practice: Credentials missing from store — reconnect the Practice account`]);
        setT212OrderResults(buys.map(s => ({ symbol: s.symbol, status: 'failed' as const, message: '✗ Demo credentials missing — reconnect' })));
      } else if (orderAuth) {
        // ── Market hours check: separate open vs closed market orders ──────────
        const openBuys: Signal[]  = [];
        const closedBuys: Signal[] = [];
        for (const signal of buys) {
          if (isMarketOpenNow(signal.isUK)) {
            openBuys.push(signal);
          } else {
            closedBuys.push(signal);
          }
        }

        // Queue closed-market orders as pending
        if (closedBuys.length > 0) {
          const { nextOpenStr } = getMarketStatus();
          const newPending: PendingOrder[] = closedBuys.map(signal => {
            let liveSize: number;
            if (isSmartMoney) {
              const riskAmount = paperBudget * (SMART_MONEY_RISK_PCT / 100);
              const slDistance = signal.currentPrice * (SMART_MONEY_SL_PCT / 100);
              liveSize = (riskAmount / slDistance) * signal.currentPrice;
            } else {
              liveSize = mode === 'auto' ? autoTradeSize(signal.score) : manualTradeSize;
            }
            const qty = calcQuantity(liveSize, signal.currentPrice);
            const fees = calcFees(signal.currentPrice, liveSize, signal.isUK);
            const netProfitPct = fees.netProfitPct;
            setRunLog(l => [...l, `  → QUEUED: ${signal.symbol} × ${qty.toFixed(4)} · Market closed (${nextOpenStr ?? 'check schedule'})`]);
            return {
              id: uid(), symbol: signal.symbol, name: signal.name,
              t212Ticker: signal.t212Ticker, quantity: qty,
              entryPrice: signal.currentPrice, size: liveSize,
              sl: signal.currentPrice * (1 - ((isSmartMoney ? SMART_MONEY_SL_PCT : slPct) + fees.feePct) / 100),
              tp: signal.currentPrice * (1 + (isSmartMoney ? SMART_MONEY_TP_PCT : tpPct) / 100),
              breakeven: fees.breakeven, feePct: fees.feePct,
              feeAmount: fees.feeAmount, netProfitPct,
              orderAuth, orderEnv, accountLabel,
              isUK: signal.isUK, queuedAt: new Date().toISOString(),
            };
          });
          const updatedPending = [...pendingOrders, ...newPending];
          setPendingOrders(updatedPending);
          localStorage.setItem('pending_orders', JSON.stringify(updatedPending));
          setRunLog(l => [...l, `  ⏰ ${closedBuys.length} order(s) queued — will auto-execute when market opens`]);
          setT212OrderResults(closedBuys.map(s => ({ symbol: s.symbol, status: 'failed' as const, message: `⏰ Queued — market closed` })));
        }

        // Place open-market orders immediately
        if (openBuys.length > 0) {
          const liveAuthFallback = investEncoded || orderAuth;
          setRunLog(l => [...l, `📲 Placing ${openBuys.length} order(s) on ${accountLabel} (env: ${orderEnv})…`]);

          const orderResults = await Promise.allSettled(
            openBuys.map(signal => {
              let liveSize: number;
              if (isSmartMoney) {
                const riskAmount = paperBudget * (SMART_MONEY_RISK_PCT / 100);
                const slDistance = signal.currentPrice * (SMART_MONEY_SL_PCT / 100);
                liveSize = (riskAmount / slDistance) * signal.currentPrice;
              } else {
                liveSize = mode === 'auto' ? autoTradeSize(signal.score) : manualTradeSize;
              }
              const qty = calcQuantity(liveSize, signal.currentPrice);
              const reqBody = { ticker: signal.t212Ticker, quantity: qty, env: orderEnv };
              setRunLog(l => [...l, `  → OPENING: ${signal.symbol} ticker=${signal.t212Ticker} qty=${qty}`]);
              return fetch('/api/t212/live-order', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-t212-auth': orderAuth,
                  'x-t212-live-auth': liveAuthFallback,
                },
                body: JSON.stringify(reqBody),
              }).then(async r => {
                const data = await r.json() as OrderResp;
                return data;
              });
            })
          );

          const newStatuses: typeof t212OrderResults = [];
          orderResults.forEach((result, i) => {
            const sym = openBuys[i].symbol;
            if (result.status === 'fulfilled' && result.value.ok) {
              const note = result.value.note ? ` (${result.value.note})` : '';
              const orderId = result.value.orderId ?? '?';
              const resolvedTicker = result.value.ticker ?? sym;
              setRunLog(l => [...l, `  → OPENED: ${accountLabel}: ${sym} · Order #${orderId} · ticker=${resolvedTicker} qty=${result.value.quantity ?? '?'}${note}`]);
              newStatuses.push({ symbol: sym, status: 'placed', message: `✓ Order #${orderId} placed (${resolvedTicker})` });
            } else {
              const fullResp = result.status === 'fulfilled' ? result.value : null;
              const rejectedReason = result.status === 'rejected' ? String((result as PromiseRejectedResult).reason) : 'Unknown error';
              const isMarketClosed = fullResp?.marketClosed === true;
              const err = fullResp
                ? (fullResp.error || (fullResp.t212Body ? `HTTP ${fullResp.t212Status}: ${fullResp.t212Body.slice(0, 80)}` : `HTTP ${fullResp.t212Status ?? '?'}`))
                : rejectedReason;
              const t212Detail = fullResp?.t212Body ? ` [T212: ${fullResp.t212Body.slice(0, 100)}]` : '';
              setRunLog(l => [...l, `  ${isMarketClosed ? '⏰' : '✗'} ${accountLabel}: ${sym}: ${isMarketClosed ? 'Market closed — auto-queuing' : 'FAILED'} — ${err}${t212Detail}`]);
              newStatuses.push({
                symbol: sym,
                status: 'failed',
                message: isMarketClosed ? `⏰ Market closed — queued for next open` : `✗ ${err}`,
              });
            }
          });
          setT212OrderResults(prev => [...prev, ...newStatuses]);
        }

        if (openBuys.length === 0 && closedBuys.length === 0) {
          setT212OrderResults([]);
        }
      } else {
        const reason = execAccount === 'paper'
          ? 'Paper only — set execution account to place real orders'
          : `${EXECUTION_ACCOUNT_LABELS[execAccount]} not connected — go to Settings → Accounts`;
        setRunLog(l => [...l, `  ℹ ${reason}`]);
        setT212OrderResults(buys.map(s => ({
          symbol: s.symbol,
          status: 'paper' as const,
          message: execAccount === 'paper' ? 'Paper only' : `${execAccount} not connected`,
        })));
      }

      // Update pending signal count for sidebar badge
      const buyCount = allSignals.filter(s => s.signal === 'BUY').length;
      if (buyCount > 0) setPendingSignalCount(buyCount);
    } catch (err) {
      setScanError(`Strategy failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScanning(false);
      setStrategyStatus(demoPositions.length > 0 ? 'HOLDING' : 'IDLE');
    }
  }

  // ── Manual close ───────────────────────────────────────────────────────────
  function closePosition(pos: DemoPosition) {
    const activeMeta = portfolios.find(p => p.id === activePortfolioId);
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
      accountType: activeMeta?.executionAccount ?? 'paper',
    });
    removeDemoPosition(pos.id);
    addStratLog({ type: 'sell', ticker: pos.ticker, action: 'Manual close', reason: 'User closed position', price: pos.currentPrice, pnl: pos.pnl, pnlPct: pos.pnlPct });
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
      <Modal isOpen={confirmReset} onClose={() => setConfirmReset(false)} maxWidth="max-w-sm">
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
      </Modal>

      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-[100] bg-emerald-900 border border-emerald-700 text-emerald-200 text-sm px-4 py-3 rounded-xl shadow-xl">
          {toast}
        </div>
      )}

      {/* Delete confirm */}
      <Modal isOpen={!!showDeleteConfirm} onClose={() => setShowDeleteConfirm(null)} maxWidth="max-w-sm">
        <h2 className="text-base font-semibold text-white mb-2">Delete Portfolio?</h2>
        <p className="text-sm text-gray-400 mb-4">This cannot be undone. All positions and trades in this portfolio will be permanently deleted.</p>
        <div className="flex gap-2">
          <button onClick={() => setShowDeleteConfirm(null)} className="flex-1 py-2 rounded-lg border border-gray-700 text-sm text-gray-400">Cancel</button>
          {showDeleteConfirm && <button onClick={() => deletePortfolio(showDeleteConfirm)} className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-sm font-semibold text-white">Delete</button>}
        </div>
      </Modal>

      {/* Create portfolio modal */}
      {showCreatePortfolio && (
        <CreatePortfolioModal
          onClose={() => setShowCreatePortfolio(false)}
          onCreate={createPortfolio}
        />
      )}

      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <FlaskConical className="h-6 w-6 text-amber-400" />
            Demo Auto-Trader
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {activePortfolioId && portfolios.find(p => p.id === activePortfolioId)
              ? <>Portfolio: <span className="text-amber-300">{portfolios.find(p => p.id === activePortfolioId)?.name}</span></>
              : 'Automated paper trading · no real money involved'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Save status indicator */}
          <div className="flex items-center gap-1.5 text-xs min-w-[80px] justify-end">
            {saveStatus === 'saving' && (
              <span className="text-amber-400/70 flex items-center gap-1">
                <RefreshCw className="h-3 w-3 animate-spin" /> Saving…
              </span>
            )}
            {saveStatus === 'saved' && (
              <span className="text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Saved
              </span>
            )}
            {saveStatus === 'idle' && lastSaved && (
              <span className="text-gray-600">
                Saved {lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>

          <LoadPortfolioButton label="Load Portfolio" size="sm" />

          {/* Manual save button */}
          <button
            onClick={() => {
              saveCurrentPortfolioToLS();
              const now = new Date();
              setLastSaved(now);
              setSaveStatus('saved');
              setTimeout(() => setSaveStatus('idle'), 2500);
              showToast('Portfolio saved');
            }}
            title="Save portfolio now"
            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-700 bg-gray-800 text-gray-400 hover:text-emerald-400 hover:border-emerald-500/40 transition-colors flex items-center gap-1.5"
          >
            <CheckCircle2 className="h-3.5 w-3.5" /> Save
          </button>

          <button
            onClick={() => setPortfolioView(v => v === 'compare' ? 'trader' : 'compare')}
            className={clsx('px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
              portfolioView === 'compare' ? 'bg-amber-500/20 border-amber-500/30 text-amber-300' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
            )}
          >
            📊 Compare
          </button>
        </div>
      </div>

      {/* Portfolio selector */}
      <div className="mb-4">
        <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {portfolios.map(meta => {
            const pPositions = meta.id === activePortfolioId ? demoPositions : loadPortfolioPositions(meta.id);
            const pTrades = meta.id === activePortfolioId ? demoTrades : loadPortfolioTrades(meta.id);
            const pBudget = meta.id === activePortfolioId ? paperBudget : (loadPortfolioBudget(meta.id) ?? meta.paperBudget);
            return (
              <PortfolioCard
                key={meta.id}
                meta={meta}
                positions={pPositions}
                trades={pTrades}
                budget={pBudget}
                isActive={meta.id === activePortfolioId}
                onSelect={() => { if (meta.id !== activePortfolioId) switchToPortfolio(meta.id); }}
                onDelete={() => setShowDeleteConfirm(meta.id)}
                onDuplicate={() => duplicatePortfolio(meta.id)}
                onToggleStatus={() => togglePortfolioStatus(meta.id)}
              />
            );
          })}
          {portfolios.length < MAX_PORTFOLIOS && (
            <button
              onClick={() => setShowCreatePortfolio(true)}
              className="flex-shrink-0 w-36 h-full min-h-[140px] flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-700 hover:border-amber-500/50 text-gray-600 hover:text-amber-400 transition-colors"
            >
              <span className="text-2xl">+</span>
              <span className="text-xs font-medium">New Portfolio</span>
            </button>
          )}
        </div>
      </div>

      {/* Paper trading banner */}
      <div className="mb-4 flex items-start gap-2 bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3">
        <Info className="h-4 w-4 text-blue-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-blue-200/80">
          <strong className="text-blue-300">Paper trading — simulated positions using real live prices. No real money involved.</strong>{' '}
          Positions are tracked internally using live Finnhub prices. T212 DEMO API does not support order placement, so all trades are simulated here. Use <em>Copy to Live</em> to place real orders on your live T212 account.
        </p>
      </div>

      {/* Smart Money strategy info card */}
      {portfolios.find(p => p.id === activePortfolioId)?.strategy === 'smart-money' && (
        <div className="mb-4 bg-amber-500/8 border border-amber-500/25 rounded-xl px-4 py-3.5 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-base">🧠</span>
            <p className="text-sm font-semibold text-amber-300">Smart Money Swing Strategy</p>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 ml-1">Active</span>
          </div>
          <p className="text-xs text-amber-200/70 leading-relaxed">
            Mimics institutional order flow by targeting stocks with <strong className="text-amber-300">unusual volume surges</strong> (≥1.3× average)
            backed by a <strong className="text-amber-300">news catalyst</strong> and confirmed <strong className="text-amber-300">price momentum</strong>.
            When smart money accumulates a position it shows up as volume before price fully reacts — we try to piggyback that.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
            {[
              { label: 'Entry criteria', value: 'Vol ≥1.3× + news + 0.3–6% move', icon: '📋' },
              { label: 'Stop loss',      value: '−1.5% (capital preservation)', icon: '🛡' },
              { label: 'Take profit',    value: '+3.0% (2:1 risk/reward)',       icon: '🎯' },
              { label: 'Position size',  value: '1% portfolio risk per trade',   icon: '⚖️' },
            ].map(r => (
              <div key={r.label} className="bg-gray-900/60 rounded-lg px-2.5 py-2">
                <p className="text-[10px] text-gray-500 mb-0.5">{r.icon} {r.label}</p>
                <p className="text-[11px] text-amber-300/90 font-medium leading-tight">{r.value}</p>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-gray-600 pt-0.5">
            ⚠ Past performance does not guarantee future results. This is a simulated strategy for educational purposes only.
          </p>
        </div>
      )}

      {/* Tab toggle */}
      <div className="flex gap-1 mb-4 bg-gray-800/60 rounded-xl p-1 w-fit">
        {(['stocks', 'forex', 'ig'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setTraderTab(tab)}
            className={clsx(
              'px-4 py-1.5 rounded-lg text-sm font-medium transition-all',
              traderTab === tab
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                : 'text-gray-500 hover:text-gray-300'
            )}
          >
            {tab === 'ig' ? 'IG Spread Bet' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {portfolioView === 'compare' ? (
        <PortfolioCompare portfolios={portfolios} />
      ) : traderTab === 'forex' ? (
        <ForexTrader />
      ) : traderTab === 'ig' ? (
        <IGTrader />
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
                          type="text" inputMode="decimal" autoFocus
                          value={customSizeStr}
                          onChange={e => {
                            // Allow any decimal, e.g. £5, £10.50, £1000
                            const v = e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
                            setCustomSizeStr(v);
                            localStorage.setItem('custom_trade_amount', v);
                          }}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
                          placeholder="e.g. 10.50"
                        />
                      </div>
                    )}
                    <p className="text-xs text-gray-500">
                      Each trade will use <span className="text-amber-400 font-semibold">{fmtGBP(manualTradeSize)}</span> of your <span className="text-white font-semibold">{fmtGBP(paperBudget)}</span> budget
                      {sizePreset === 'custom' && manualTradeSize > 0 && (
                        <span className="block text-gray-600 text-[11px] mt-0.5">Any decimal supported · e.g. £5, £10.50, £100</span>
                      )}
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

              {/* ── Manual Stock Additions ─────────────────────────────── */}
              <div>
                <label className="text-xs text-gray-400 mb-2 block">Manual Stock Additions</label>
                <div className="flex gap-1.5 mb-2">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={manualStockQuery}
                      onChange={e => setManualStockQuery(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && searchStocks()}
                      placeholder="Search ticker or name…"
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-3 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-500"
                    />
                  </div>
                  <button
                    onClick={searchStocks}
                    disabled={stockSearchLoading || !manualStockQuery.trim()}
                    className="px-2.5 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors disabled:opacity-40 flex items-center gap-1"
                  >
                    <Search className="h-3 w-3" />
                  </button>
                </div>
                {/* Search results dropdown */}
                {manualStockResults.length > 0 && (
                  <div className="bg-gray-950 border border-gray-700 rounded-lg mb-2 overflow-hidden max-h-44 overflow-y-auto">
                    {manualStockResults.map(r => (
                      <button
                        key={r.symbol}
                        onClick={() => addManualStock(r)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-gray-800 transition-colors text-left border-b border-gray-800 last:border-0"
                      >
                        {r.isUK && <span>🇬🇧</span>}
                        <span className="font-bold text-white w-14 truncate">{r.symbol}</span>
                        <span className="text-gray-400 flex-1 truncate">{r.description}</span>
                        <span className="text-gray-600 text-[10px] flex-shrink-0">{r.type}</span>
                        <Plus className="h-3 w-3 text-emerald-400 flex-shrink-0" />
                      </button>
                    ))}
                  </div>
                )}
                {/* Added stocks */}
                {manualAddedStocks.length > 0 && (
                  <div className="space-y-1">
                    {manualAddedStocks.map(ms => (
                      <div key={ms.symbol} className="flex items-center gap-2 bg-gray-800/60 border border-gray-700 rounded-lg px-2.5 py-1.5">
                        {ms.isUK && <span className="text-[10px]">🇬🇧</span>}
                        <span className="text-xs font-bold text-amber-400 w-14 truncate">{ms.symbol}</span>
                        <span className="text-[10px] text-gray-400 flex-1 truncate">{ms.name}</span>
                        <span className="text-[10px] text-emerald-400/70 flex-shrink-0">Manual</span>
                        <button onClick={() => removeManualStock(ms.symbol)} className="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                    <p className="text-[10px] text-gray-600">Included in next strategy run · override entry criteria</p>
                  </div>
                )}
              </div>

              {/* ── Fee summary ───────────────────────────────────────────── */}
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
                <div className="flex justify-between"><span>US stock fees</span><span className="text-amber-400/70">{US_TOTAL_FEE}% (FX {FX_FEE_PCT}% + spread {SPREAD_PCT}%)</span></div>
                <div className="flex justify-between"><span>UK stock fees</span><span className="text-amber-400/70">{UK_TOTAL_FEE}% (spread only)</span></div>
                <div className="flex justify-between"><span>Max positions / run</span><span>Capital-based · max 20% each</span></div>
                <div className="flex justify-between"><span>Price refresh</span><span>every 60s</span></div>
              </div>
            </div>
          </Card>

          {/* ── Execution Account card ─────────────────────────────────────── */}
          {(() => {
            const activeMeta = portfolios.find(p => p.id === activePortfolioId);
            const execAcc = activeMeta?.executionAccount ?? 'paper';
            const isLive = execAcc === 'invest' || execAcc === 'isa';
            const isPractice = execAcc === 'practice';
            const accountConnected =
              execAcc === 'paper' ? true :
              execAcc === 'practice' ? t212DemoConnected :
              execAcc === 'invest' ? (!!t212ApiKey && !!t212ApiSecret) :
              execAcc === 'isa' ? t212IsaConnected : false;

            return (
              <Card>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-xs font-semibold text-gray-300">Execution Account</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">Where strategy orders are placed</p>
                  </div>
                  <button
                    onClick={() => setShowExecAccountPicker(v => !v)}
                    className="text-[11px] px-2.5 py-1 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
                  >
                    Change
                  </button>
                </div>

                <div className={clsx('flex items-center gap-2 rounded-lg px-3 py-2.5 border',
                  isLive ? 'bg-amber-500/10 border-amber-500/30' :
                  isPractice ? 'bg-blue-500/10 border-blue-500/30' :
                  'bg-gray-800/50 border-gray-700'
                )}>
                  <span className="text-base">{
                    execAcc === 'paper' ? '📝' :
                    execAcc === 'practice' ? '🎮' :
                    execAcc === 'invest' ? '📊' : '📈'
                  }</span>
                  <div className="flex-1">
                    <p className={clsx('text-xs font-semibold', isLive ? 'text-amber-300' : isPractice ? 'text-blue-300' : 'text-gray-300')}>
                      {execAcc === 'paper' ? 'Paper Only' :
                       execAcc === 'practice' ? 'T212 Practice (Demo)' :
                       execAcc === 'invest' ? 'T212 Invest (Live)' : 'T212 Stocks ISA (Live)'}
                    </p>
                    <p className={clsx('text-[10px] mt-0.5', accountConnected ? 'text-emerald-400' : 'text-red-400')}>
                      {execAcc === 'paper' ? 'Simulated · no real orders' :
                       accountConnected ? '● Connected · ready to trade' : '● Not connected — go to Settings → Accounts'}
                    </p>
                  </div>
                  {isLive && accountConnected && (
                    <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-bold">LIVE</span>
                  )}
                </div>

                {isLive && accountConnected && (
                  <p className="mt-2 text-[11px] text-amber-400/70 leading-snug">
                    ⚠ "Run Strategy" will place real market orders on your {execAcc === 'isa' ? 'ISA' : 'Invest'} account. You are fully responsible for all trading decisions.
                  </p>
                )}

                {!accountConnected && execAcc !== 'paper' && (
                  <a href="/settings/accounts" className="mt-2 flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300 transition-colors">
                    <ArrowRight className="h-3 w-3" /> Connect account in Settings
                  </a>
                )}

                {/* Test Order button — Practice account only */}
                {isPractice && accountConnected && (
                  <div className="mt-3 pt-3 border-t border-gray-800">
                    <div className="flex items-center gap-2 mb-2">
                      <button
                        onClick={runTestOrder}
                        disabled={testOrderLoading}
                        className="text-[11px] px-3 py-1.5 rounded-lg bg-blue-600/20 border border-blue-500/30 text-blue-300 hover:bg-blue-600/30 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                      >
                        <FlaskConical className="h-3 w-3" />
                        {testOrderLoading ? 'Sending…' : '🧪 Test Order (1× AAPL)'}
                      </button>
                      <span className="text-[10px] text-gray-600">Places 1 real demo order to confirm connection</span>
                    </div>
                    {testOrderResult && (
                      <pre className="text-[10px] font-mono bg-gray-950 border border-gray-800 rounded p-2 text-gray-300 whitespace-pre-wrap break-all max-h-40 overflow-y-auto leading-relaxed">
                        {testOrderResult}
                      </pre>
                    )}
                  </div>
                )}

                {showExecAccountPicker && (
                  <div className="mt-3 pt-3 border-t border-gray-800 space-y-1.5">
                    <p className="text-[11px] text-gray-500 mb-2">Select where strategy orders are sent:</p>
                    {(['paper', 'practice', 'invest', 'isa'] as ExecutionAccount[]).map(acc => {
                      const avail =
                        acc === 'paper' ? true :
                        acc === 'practice' ? t212DemoConnected :
                        acc === 'invest' ? (!!t212ApiKey && !!t212ApiSecret) :
                        acc === 'isa' ? t212IsaConnected : false;
                      const isLiveAcc = acc === 'invest' || acc === 'isa';
                      return (
                        <button
                          key={acc}
                          disabled={!avail}
                          onClick={() => changeExecutionAccount(acc)}
                          className={clsx(
                            'w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-left text-xs transition-colors',
                            !avail ? 'opacity-40 cursor-not-allowed border-gray-800 bg-gray-900 text-gray-600' :
                            execAcc === acc ? (isLiveAcc ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300') :
                            'border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-600'
                          )}
                        >
                          <span>{acc === 'paper' ? '📝' : acc === 'practice' ? '🎮' : acc === 'invest' ? '📊' : '📈'}</span>
                          <span className="flex-1">{EXECUTION_ACCOUNT_LABELS[acc]}</span>
                          {!avail && <span className="text-[10px] text-gray-600">Not connected</span>}
                          {execAcc === acc && <span className="text-[10px] text-emerald-400">✓ Active</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </Card>
            );
          })()}

          {/* ── Strategy Engine Status ─────────────────────────────────── */}
          <Card>
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-xs font-semibold text-gray-300">Strategy Engine</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className={clsx('text-[10px] px-2 py-0.5 rounded-full font-bold',
                    strategyStatus === 'SCANNING' ? 'bg-blue-500/20 text-blue-400' :
                    strategyStatus === 'PAUSED' ? 'bg-red-500/20 text-red-400' :
                    strategyStatus === 'HOLDING' ? 'bg-amber-500/20 text-amber-400' :
                    'bg-gray-700 text-gray-500'
                  )}>
                    {strategyStatus}
                  </span>
                  {pausedUntil !== null && Date.now() < pausedUntil && (
                    <span className="text-[10px] text-red-400">
                      Resumes {new Date(pausedUntil).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => setAutoScanEnabled(v => !v)}
                className={clsx('px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors flex items-center gap-1.5',
                  autoScanEnabled ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
                )}
              >
                {autoScanEnabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                {autoScanEnabled ? 'Auto ON' : 'Auto OFF'}
              </button>
            </div>

            {autoScanEnabled && (
              <div className="flex items-center gap-2 mb-2 bg-emerald-500/5 border border-emerald-500/20 rounded-lg px-3 py-1.5">
                <RefreshCw className="h-3 w-3 text-emerald-400" style={{ animation: 'spin 3s linear infinite' }} />
                <span className="text-[11px] text-gray-400">Next scan in</span>
                <span className="text-[11px] font-mono text-emerald-400">
                  {Math.floor(nextScanIn / 60)}:{String(nextScanIn % 60).padStart(2, '0')}
                </span>
              </div>
            )}

            <div className="space-y-0.5 text-[10px] text-gray-600 mb-3">
              <div className="flex justify-between"><span>Position cap</span><span className="text-gray-500">20% per stock · 5 per sector</span></div>
              <div className="flex justify-between"><span>Sizing</span><span className="text-gray-500">5% / 3% / 1.5% (confidence)</span></div>
              <div className="flex justify-between"><span>Trailing stop</span><span className="text-gray-500">→ breakeven after +3%</span></div>
              <div className="flex justify-between"><span>Time exit</span><span className="text-gray-500">48h if not profitable</span></div>
              <div className="flex justify-between"><span>Drawdown guard</span><span className="text-gray-500">Pause 1h if −5%</span></div>
            </div>

            <button
              onClick={() => setHoldOvernight(v => !v)}
              className={clsx('w-full flex items-center justify-between px-3 py-2 rounded-lg border text-xs transition-colors mb-2',
                holdOvernight ? 'bg-indigo-500/10 border-indigo-500/20 text-indigo-300' : 'bg-gray-800/60 border-gray-700 text-gray-400 hover:text-gray-200'
              )}
            >
              <span className="flex items-center gap-1.5">
                {holdOvernight ? <Moon className="h-3 w-3" /> : <Sun className="h-3 w-3" />}
                {holdOvernight ? 'Hold overnight: ON' : 'Close at 3:45pm ET'}
              </span>
              <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full', holdOvernight ? 'bg-indigo-500/20 text-indigo-400' : 'bg-gray-700 text-gray-500')}>
                {holdOvernight ? 'OVERNIGHT' : 'INTRADAY'}
              </span>
            </button>

            {/* Sector exposure heat map */}
            {demoPositions.length > 0 && (() => {
              const sectorMap = demoPositions.reduce<Record<string, number>>((acc, p) => {
                acc[p.sector] = (acc[p.sector] ?? 0) + 1; return acc;
              }, {});
              return (
                <div className="pt-2 border-t border-gray-800">
                  <p className="text-[10px] text-gray-600 mb-1.5">Sector exposure</p>
                  <div className="space-y-1">
                    {Object.entries(sectorMap).map(([sector, count]) => (
                      <div key={sector} className="flex items-center gap-2">
                        <span className="text-[10px] text-gray-500 w-16 truncate">{sector}</span>
                        <div className="flex-1 bg-gray-800 rounded-full h-1">
                          <div className="h-1 rounded-full bg-amber-500" style={{ width: `${Math.min(100, (count / 5) * 100)}%` }} />
                        </div>
                        <span className="text-[10px] text-gray-500 w-6 text-right">{count}/5</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </Card>

          {/* ── Market status banner ─────────────────────────────────── */}
          {(() => {
            const usStatus = getMarketStatus();
            const ukOpen = isUKMarketOpen();
            const usOpen = usStatus.status === 'open';
            if (!usOpen && !ukOpen) {
              return (
                <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-xs text-amber-300">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                  <div>
                    <span className="font-semibold">Markets closed</span>
                    <span className="text-amber-300/60 ml-1">· US opens {usStatus.nextOpenStr ?? 'Mon 9:30am ET'} · UK 8am–4:30pm GMT</span>
                    <span className="block text-[11px] text-amber-300/50 mt-0.5">Orders will be auto-queued and executed when market opens</span>
                  </div>
                </div>
              );
            }
            if (usOpen && !ukOpen) return (
              <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-2.5 py-1.5 text-[11px] text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
                US market open · UK market closed (8am–4:30pm GMT)
              </div>
            );
            return null;
          })()}

          {/* ── Pending Orders card ───────────────────────────────────── */}
          {pendingOrders.length > 0 && (
            <Card>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <p className="text-xs font-semibold text-amber-300 flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" /> {pendingOrders.length} Queued Order{pendingOrders.length > 1 ? 's' : ''}
                  </p>
                  <p className="text-[10px] text-gray-500 mt-0.5">Waiting for market to open</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => executePendingOrders()}
                    disabled={executingPending}
                    className="text-[11px] px-2.5 py-1 rounded-lg bg-emerald-600/20 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-600/30 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  >
                    <Play className="h-3 w-3" />
                    {executingPending ? 'Executing…' : 'Execute Now'}
                  </button>
                  <button
                    onClick={() => { setPendingOrders([]); localStorage.removeItem('pending_orders'); }}
                    className="text-[11px] px-2 py-1 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-red-400 transition-colors"
                  >
                    Dismiss All
                  </button>
                </div>
              </div>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {pendingOrders.map(o => (
                  <div key={o.id} className="flex items-center gap-2 text-[10px] bg-gray-800/50 rounded px-2.5 py-1.5">
                    {o.isUK && <span>🇬🇧</span>}
                    <span className="font-bold text-amber-400 w-12">{o.symbol}</span>
                    <span className="text-gray-400 flex-1">× {o.quantity.toFixed(4)} @ {o.isUK ? fmtGBP(o.entryPrice) : fmtUSD(o.entryPrice)}</span>
                    <span className="text-gray-600">Fee {o.feePct}%</span>
                    <span className="text-emerald-400/70">Net +{o.netProfitPct.toFixed(2)}%</span>
                    <span className="text-gray-700 ml-1">{hoursAgo(o.queuedAt)}</span>
                    <button onClick={() => {
                      const updated = pendingOrders.filter(x => x.id !== o.id);
                      setPendingOrders(updated);
                      localStorage.setItem('pending_orders', JSON.stringify(updated));
                    }} className="text-gray-700 hover:text-red-400 transition-colors">
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            </Card>
          )}

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
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 font-mono text-[11px] space-y-0.5 max-h-48 overflow-y-auto">
              {runLog.map((line, i) => (
                <p key={i} className={clsx(
                  line.startsWith('  ✅') || line.startsWith('✅') || line.includes('→ OPENED') ? 'text-emerald-400' :
                  line.startsWith('  ✗') ? 'text-red-400' :
                  line.includes('→ QUEUED') || line.startsWith('  ⏰') || line.startsWith('⏰') ? 'text-amber-400' :
                  line.includes('→ OPENING') || line.startsWith('  →') || line.startsWith('📲') ? 'text-blue-400' :
                  line.startsWith('⚠') ? 'text-amber-400' :
                  line.startsWith('  ➕') ? 'text-purple-400' :
                  'text-gray-400'
                )}>{line}</p>
              ))}
            </div>
          )}

          {/* Strategy Log */}
          {strategyLog.length > 0 && (
            <Card>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-gray-300">Strategy Log</p>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-600">{strategyLog.length} entries</span>
                  <button
                    onClick={exportLogCSV}
                    className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
                  >
                    <Download className="h-2.5 w-2.5" /> CSV
                  </button>
                </div>
              </div>
              <div className="space-y-0.5 max-h-48 overflow-y-auto">
                {strategyLog.slice(0, 50).map(entry => (
                  <div key={entry.id} className="flex items-start gap-2 text-[10px] py-0.5 border-b border-gray-800/50 last:border-0">
                    <span className="text-gray-700 flex-shrink-0 font-mono">
                      {new Date(entry.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    {entry.ticker && (
                      <span className={clsx('flex-shrink-0 font-bold w-12',
                        entry.type === 'buy' ? 'text-emerald-400' :
                        entry.type === 'sell' ? 'text-red-400' :
                        entry.type === 'adjust' ? 'text-amber-400' :
                        entry.type === 'pause' ? 'text-red-500' :
                        'text-gray-500'
                      )}>
                        {entry.ticker}
                      </span>
                    )}
                    <span className="text-gray-400 flex-1 leading-tight">{entry.action} · <span className="text-gray-600">{entry.reason}</span></span>
                    {entry.pnlPct !== undefined && (
                      <span className={clsx('font-mono flex-shrink-0', entry.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {entry.pnlPct >= 0 ? '+' : ''}{entry.pnlPct.toFixed(2)}%
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Debug Panel */}
          <div className="border border-gray-800 rounded-lg overflow-hidden">
            <button
              onClick={() => setDebugOpen(o => !o)}
              className="w-full flex items-center justify-between px-3 py-2 bg-gray-900 hover:bg-gray-800 text-xs text-gray-500 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5" />
                Debug Panel
                {scanError && <span className="ml-1 px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 text-[10px]">error</span>}
              </span>
              <span className="text-gray-600">{debugOpen ? '▲' : '▼'}</span>
            </button>
            {debugOpen && (
              <div className="bg-gray-950 border-t border-gray-800 p-3 space-y-2 text-[11px]">
                <div className="grid grid-cols-2 gap-2 text-gray-500 mb-2">
                  <div>
                    <span className="text-gray-600">Last run:</span>{' '}
                    <span className="text-gray-300">
                      {lastStrategyRun
                        ? new Date(lastStrategyRun).toLocaleTimeString('en-GB')
                        : 'Never'}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-600">Stocks scanned:</span>{' '}
                    <span className="text-gray-300">{lastScanCount}</span>
                  </div>
                  <div>
                    <span className="text-gray-600">API calls used:</span>{' '}
                    <span className="text-gray-300">{apiCalls}</span>
                  </div>
                  <div>
                    <span className="text-gray-600">Signals generated:</span>{' '}
                    <span className="text-gray-300">
                      {signals.filter(s => s.signal === 'BUY').length} BUY ·{' '}
                      {signals.filter(s => s.signal === 'SELL').length} SELL ·{' '}
                      {signals.filter(s => s.signal === 'NEUTRAL').length} NEUTRAL
                    </span>
                  </div>
                </div>
                {signals.length > 0 && (
                  <div className="mb-2">
                    <p className="text-gray-600 mb-1">Signal confidence scores:</p>
                    <div className="space-y-0.5">
                      {signals.slice(0, 6).map(s => (
                        <div key={s.symbol} className="flex items-center gap-2">
                          <span className={clsx('w-12 text-[10px] font-bold', s.signal === 'BUY' ? 'text-emerald-400' : s.signal === 'SELL' ? 'text-red-400' : 'text-gray-500')}>
                            {s.signal}
                          </span>
                          <span className="w-14 font-mono text-gray-400">{s.symbol}</span>
                          <div className="flex-1 bg-gray-800 rounded-full h-1.5">
                            <div
                              className={clsx('h-1.5 rounded-full', s.score >= 50 ? 'bg-amber-500' : 'bg-gray-600')}
                              style={{ width: `${s.score}%` }}
                            />
                          </div>
                          <span className="w-10 text-right font-mono text-gray-500">{s.score}/100</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {debugLog.length > 0 && (
                  <div>
                    <p className="text-gray-600 mb-1">API debug log:</p>
                    <div className="bg-gray-900 rounded p-2 font-mono space-y-0.5 max-h-36 overflow-y-auto">
                      {debugLog.map((line, i) => (
                        <p key={i} className={clsx(
                          line.startsWith('❌') ? 'text-red-400' :
                          line.startsWith('⚠️') || line.startsWith('⚠') ? 'text-amber-400' :
                          line.startsWith('✅') ? 'text-emerald-400' :
                          'text-gray-500'
                        )}>{line}</p>
                      ))}
                    </div>
                  </div>
                )}
                {scanError && (
                  <div className="flex items-start gap-1.5 bg-red-500/10 border border-red-500/20 rounded p-2 text-red-400">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                    <span>{scanError}</span>
                  </div>
                )}
              </div>
            )}
          </div>
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
                          <p className="text-[10px] text-gray-600 font-medium">🎮 Simulated — no tax</p>
                          {(() => {
                            const isUK = pos.ticker.endsWith('.L');
                            const feePct = isUK ? UK_TOTAL_FEE : US_TOTAL_FEE;
                            const bep = pos.entryPrice * (1 + (2 * feePct) / 100);
                            return (
                              <p className="text-[10px] text-gray-700 mt-0.5">
                                BEP {isUK ? fmtGBP(bep) : fmtUSD(bep)} · Fee {feePct}%
                              </p>
                            );
                          })()}
                          <p className="text-gray-600">{hoursAgo(pos.openedAt)}</p>
                          {/* Show trade rationale for smart-money positions */}
                          {pos.signal && pos.signal.includes('R:R') && (
                            <p className="text-[10px] text-amber-400/70 mt-0.5 max-w-[180px] leading-tight">
                              🧠 {pos.signal}
                            </p>
                          )}
                          {(() => {
                            const r = t212OrderResults.find(x => x.symbol === pos.ticker);
                            if (!r) return null;
                            return (
                              <p className={clsx('text-[10px] mt-0.5', r.status === 'placed' ? 'text-emerald-400' : r.status === 'failed' ? 'text-amber-400' : 'text-gray-600')}>
                                {r.message}
                              </p>
                            );
                          })()}
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono text-gray-300">
                          <div>{pos.quantity.toFixed(4)}</div>
                          <div className="text-[10px] text-gray-600">{fmtUSD(pos.entryPrice * pos.quantity)}</div>
                        </td>
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
                      <th className="text-left py-2 pr-3">Account</th>
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
                        <td className="py-1.5 pr-3 text-[10px]">
                          {trade.accountType === 'practice' && <span className="text-blue-400">🎮 Practice</span>}
                          {trade.accountType === 'invest' && <span className="text-emerald-400">📊 Invest</span>}
                          {trade.accountType === 'isa' && <span className="text-indigo-400">📈 ISA</span>}
                          {(!trade.accountType || trade.accountType === 'paper') && <span className="text-gray-600">📝 Paper</span>}
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

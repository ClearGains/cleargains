'use client';

import { TrendingUp, TrendingDown, Minus, Eye, AlertTriangle } from 'lucide-react';
import { clsx } from 'clsx';
import type { AISignal } from '@/lib/claudeSignal';

interface Props {
  signal:       AISignal;
  instrumentName: string;
  epic:         string;
  onOpenTrade?: (signal: AISignal) => void;
}

const SIGNAL_CONFIG = {
  BUY:   { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400', icon: TrendingUp },
  SELL:  { bg: 'bg-red-500/10',     border: 'border-red-500/30',     text: 'text-red-400',     icon: TrendingDown },
  HOLD:  { bg: 'bg-amber-500/10',   border: 'border-amber-500/30',   text: 'text-amber-400',   icon: Minus },
  WATCH: { bg: 'bg-blue-500/10',    border: 'border-blue-500/30',    text: 'text-blue-400',    icon: Eye },
};

const RISK_COLOR = {
  LOW:    'text-emerald-400',
  MEDIUM: 'text-amber-400',
  HIGH:   'text-red-400',
};

export default function SignalCard({ signal, instrumentName, epic, onOpenTrade }: Props) {
  const cfg = SIGNAL_CONFIG[signal.signal];
  const Icon = cfg.icon;

  return (
    <div className={clsx('rounded-xl border p-4', cfg.bg, cfg.border)}>
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Icon className={clsx('h-5 w-5', cfg.text)} />
            <span className={clsx('text-xl font-bold', cfg.text)}>{signal.signal}</span>
            <span className="text-xs text-gray-500 font-mono">{epic}</span>
          </div>
          <p className="text-sm text-gray-300">{instrumentName}</p>
          <p className="text-xs text-gray-500 mt-0.5">{signal.timeframe}</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-white tabular-nums">{signal.confidence}<span className="text-sm text-gray-500">/10</span></div>
          <div className="text-xs text-gray-500">confidence</div>
          <div className={clsx('text-xs font-semibold mt-1', RISK_COLOR[signal.risk_level])}>
            {signal.risk_level} RISK
          </div>
        </div>
      </div>

      {/* Price levels */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="bg-gray-800/60 rounded-lg p-2.5 text-center">
          <div className="text-xs text-gray-500 mb-1">Entry</div>
          <div className="text-sm font-mono font-semibold text-white">{signal.entry_point.toFixed(4)}</div>
        </div>
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2.5 text-center">
          <div className="text-xs text-gray-500 mb-1">Take Profit</div>
          <div className="text-sm font-mono font-semibold text-emerald-400">{signal.take_profit.toFixed(4)}</div>
        </div>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5 text-center">
          <div className="text-xs text-gray-500 mb-1">Stop Loss</div>
          <div className="text-sm font-mono font-semibold text-red-400">{signal.stop_loss.toFixed(4)}</div>
        </div>
      </div>

      {/* RR ratio */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs text-gray-500">Risk / Reward</span>
        <span className="text-sm font-semibold text-white">1 : {signal.risk_reward_ratio.toFixed(2)}</span>
      </div>

      {/* Reasoning */}
      <div className="bg-gray-800/40 rounded-lg p-3 mb-4">
        <p className="text-xs text-gray-300 leading-relaxed">{signal.reasoning}</p>
      </div>

      {/* Disclaimer + action */}
      <div className="flex items-start gap-2 text-xs text-yellow-500/70 mb-4">
        <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
        <span>AI-generated analysis only. Not financial advice. Always manage your own risk.</span>
      </div>

      {onOpenTrade && (
        <button
          onClick={() => onOpenTrade(signal)}
          className={clsx(
            'w-full py-2.5 rounded-lg text-sm font-semibold transition-colors',
            signal.signal === 'BUY'  ? 'bg-emerald-600 hover:bg-emerald-500 text-white' :
            signal.signal === 'SELL' ? 'bg-red-600 hover:bg-red-500 text-white' :
            'bg-gray-700 hover:bg-gray-600 text-gray-200'
          )}
        >
          Open Trade from Signal
        </button>
      )}
    </div>
  );
}

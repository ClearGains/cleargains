'use client';
import type { TradeRec } from '@/app/api/analyse/chart/route';

type Props = { trade: TradeRec; price: number };

const DIR_STYLE = {
  LONG:  { badge: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30', label: 'LONG ↑' },
  SHORT: { badge: 'bg-red-500/20 text-red-400 border border-red-500/30',             label: 'SHORT ↓' },
  FLAT:  { badge: 'bg-gray-500/20 text-gray-400 border border-gray-500/30',          label: 'FLAT —'  },
};

export function TradeCard({ trade, price }: Props) {
  const dir = DIR_STYLE[trade.direction];
  const rr  = trade.riskReward.toFixed(2);

  function fmt(n: number) {
    if (n === 0) return '—';
    if (Math.abs(n) < 0.01) return n.toPrecision(4);
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  function pctDiff(target: number) {
    if (!price || !target) return '';
    const d = ((target - price) / price) * 100;
    return `${d >= 0 ? '+' : ''}${d.toFixed(2)}%`;
  }

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full uppercase tracking-wide ${dir.badge}`}>
            {dir.label}
          </span>
          <span className="text-xs text-gray-500 capitalize">{trade.timeframe}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Confidence</span>
          <div className="flex gap-0.5">
            {Array.from({ length: 10 }).map((_, i) => (
              <div
                key={i}
                className={`h-2 w-1.5 rounded-sm ${
                  i < trade.confidence
                    ? trade.confidence >= 7 ? 'bg-emerald-500' : trade.confidence >= 4 ? 'bg-amber-500' : 'bg-red-500'
                    : 'bg-gray-700'
                }`}
              />
            ))}
          </div>
          <span className="text-xs text-gray-400 font-mono">{trade.confidence}/10</span>
        </div>
      </div>

      {/* Price levels */}
      <div className="grid grid-cols-2 gap-2 text-xs font-mono">
        <div className="bg-gray-800/60 rounded-lg p-2.5 space-y-1">
          <div className="text-gray-500">Entry</div>
          <div className="text-white font-semibold">{fmt(trade.entry)}</div>
          <div className="text-gray-600 text-[10px]">{pctDiff(trade.entry)}</div>
        </div>
        <div className="bg-red-950/30 rounded-lg p-2.5 space-y-1 border border-red-900/30">
          <div className="text-red-400">Stop Loss</div>
          <div className="text-red-300 font-semibold">{fmt(trade.stopLoss)}</div>
          <div className="text-red-600 text-[10px]">{pctDiff(trade.stopLoss)}</div>
        </div>
        <div className="bg-emerald-950/30 rounded-lg p-2.5 space-y-1 border border-emerald-900/30">
          <div className="text-emerald-400">TP1</div>
          <div className="text-emerald-300 font-semibold">{fmt(trade.takeProfit1)}</div>
          <div className="text-emerald-600 text-[10px]">{pctDiff(trade.takeProfit1)}</div>
        </div>
        <div className="bg-emerald-950/20 rounded-lg p-2.5 space-y-1 border border-emerald-900/20">
          <div className="text-emerald-500">TP2</div>
          <div className="text-emerald-400 font-semibold">{fmt(trade.takeProfit2)}</div>
          <div className="text-emerald-700 text-[10px]">{pctDiff(trade.takeProfit2)}</div>
        </div>
      </div>

      {/* R:R */}
      <div className="flex items-center gap-2 bg-gray-800/40 rounded-lg px-3 py-2">
        <span className="text-xs text-gray-500">Risk : Reward</span>
        <span className={`text-sm font-bold ml-auto ${Number(rr) >= 2 ? 'text-emerald-400' : Number(rr) >= 1.5 ? 'text-amber-400' : 'text-red-400'}`}>
          1 : {rr}
        </span>
      </div>

      {/* Reasoning */}
      <p className="text-xs text-gray-300 leading-relaxed">{trade.reasoning}</p>

      {/* Invalidation */}
      <div className="border-t border-gray-800 pt-3">
        <span className="text-xs text-gray-600 font-semibold uppercase tracking-wide">Invalidation</span>
        <p className="text-xs text-gray-500 mt-1">{trade.invalidation}</p>
      </div>
    </div>
  );
}

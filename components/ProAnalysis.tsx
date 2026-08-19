'use client';
import type { AnalysisResult } from '@/lib/ruleBasedAnalysis';

type Props = { analysis: AnalysisResult };

const BIAS_STYLE = {
  BULLISH: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  BEARISH: 'bg-red-500/15 text-red-400 border-red-500/30',
  NEUTRAL: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
};

export function ProAnalysis({ analysis }: Props) {
  return (
    <div className="space-y-4">
      {/* Bias + price */}
      <div className="flex items-center gap-3">
        <span className={`px-3 py-1 rounded-full text-xs font-bold border tracking-widest uppercase ${BIAS_STYLE[analysis.bias]}`}>
          {analysis.bias}
        </span>
        <span className="font-mono text-sm text-gray-400">
          {analysis.ticker} @ {Number(analysis.price).toLocaleString(undefined, { maximumFractionDigits: 4 })}
        </span>
      </div>

      {/* Summary */}
      <p className="text-sm text-gray-300 leading-relaxed border-l-2 border-gray-700 pl-3">
        {analysis.summary}
      </p>

      {/* Key levels */}
      {analysis.keyLevels?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Key Levels</h4>
          <div className="space-y-1">
            {analysis.keyLevels.map((lvl, i) => (
              <div key={i} className="flex items-center justify-between text-xs font-mono bg-gray-800/40 rounded px-3 py-1.5">
                <span className="text-gray-400">{lvl.label}</span>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${lvl.type === 'support' ? 'bg-emerald-900/40 text-emerald-500' : 'bg-red-900/40 text-red-500'}`}>
                    {lvl.type}
                  </span>
                  <span className="text-white">{Number(lvl.price).toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Catalysts */}
      {analysis.catalysts?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-emerald-600 uppercase tracking-wide mb-2">Catalysts</h4>
          <ul className="space-y-1">
            {analysis.catalysts.map((c, i) => (
              <li key={i} className="flex gap-2 text-xs text-gray-400">
                <span className="text-emerald-600 mt-0.5">▲</span>
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Risks */}
      {analysis.risks?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-2">Risks</h4>
          <ul className="space-y-1">
            {analysis.risks.map((r, i) => (
              <li key={i} className="flex gap-2 text-xs text-gray-400">
                <span className="text-red-600 mt-0.5">▼</span>
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

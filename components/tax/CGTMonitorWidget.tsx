'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { ShieldCheck, AlertTriangle, AlertCircle, ArrowRight, Receipt } from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { computeTaxYearSummary, getTaxYear } from '@/lib/taxMonitor';
import { clsx } from 'clsx';

const CGT_AEA = 3_000;

function fmt(n: number) {
  return n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
}

export function CGTMonitorWidget() {
  const { taxTrades, carriedForwardLosses } = useClearGainsStore();

  const summary = useMemo(
    () => computeTaxYearSummary(taxTrades, carriedForwardLosses),
    [taxTrades, carriedForwardLosses]
  );

  const taxYear = getTaxYear(new Date());
  const aeaPct = Math.min(100, (summary.aeaUsed / CGT_AEA) * 100);
  const aeaExceeded = summary.netGain > CGT_AEA;
  const aeaNear = !aeaExceeded && summary.aeaRemaining < 500;

  return (
    <div className={clsx(
      'bg-gray-900 border rounded-xl p-4',
      aeaExceeded ? 'border-red-500/40' : aeaNear ? 'border-amber-500/30' : 'border-gray-800'
    )}>
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <Receipt className={clsx(
            'h-4 w-4',
            aeaExceeded ? 'text-red-400' : aeaNear ? 'text-amber-400' : 'text-emerald-400'
          )} />
          <div>
            <h3 className="text-sm font-semibold text-gray-200">CGT Monitor</h3>
            <p className="text-xs text-gray-500">Tax Year {taxYear.label}</p>
          </div>
        </div>
        {/* Status badge */}
        <div className={clsx(
          'flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border',
          aeaExceeded
            ? 'bg-red-500/10 border-red-500/30 text-red-400'
            : aeaNear
              ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
        )}>
          {aeaExceeded ? (
            <><AlertCircle className="h-3 w-3" /> AEA Exceeded</>
          ) : aeaNear ? (
            <><AlertTriangle className="h-3 w-3" /> Near Limit</>
          ) : (
            <><ShieldCheck className="h-3 w-3" /> Within AEA</>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="bg-gray-800/50 rounded-lg p-2">
          <p className="text-xs text-gray-500">Net Gains</p>
          <p className={clsx('text-sm font-mono font-bold mt-0.5', summary.netGain > 0 ? 'text-emerald-400' : 'text-white')}>
            {fmt(summary.netGain)}
          </p>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-2">
          <p className="text-xs text-gray-500">AEA Left</p>
          <p className={clsx('text-sm font-mono font-bold mt-0.5',
            aeaExceeded ? 'text-red-400' : aeaNear ? 'text-amber-400' : 'text-emerald-400'
          )}>
            {fmt(summary.aeaRemaining)}
          </p>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-2">
          <p className="text-xs text-gray-500">Est. CGT</p>
          <p className={clsx('text-sm font-mono font-bold mt-0.5', summary.estimatedCGT > 0 ? 'text-red-400' : 'text-white')}>
            {fmt(summary.estimatedCGT)}
          </p>
        </div>
      </div>

      {/* AEA Progress bar */}
      <div className="mb-3">
        <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
          <span>AEA Used</span>
          <span>{aeaPct.toFixed(0)}%</span>
        </div>
        <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={clsx(
              'h-full rounded-full transition-all duration-500',
              aeaExceeded ? 'bg-red-500' : aeaNear ? 'bg-amber-500' : 'bg-emerald-500'
            )}
            style={{ width: `${aeaPct}%` }}
          />
        </div>
      </div>

      {/* Disposal count + link */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-600">
          {summary.disposalCount} disposal{summary.disposalCount !== 1 ? 's' : ''} this year
        </p>
        <Link
          href="/tax-monitor"
          className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 font-medium transition-colors"
        >
          View Tax Monitor <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

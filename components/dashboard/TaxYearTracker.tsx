'use client';

import { useMemo, useEffect, useRef } from 'react';
import { AlertTriangle, AlertCircle, CheckCircle2, Calendar, RefreshCw } from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { calculateSection104 } from '@/lib/cgt';
import { Trade } from '@/lib/types';
import { clsx } from 'clsx';
import { sendPush } from '@/lib/pushNotifications';

const CGT_AEA = 3_000;
const WARN_THRESHOLD = 500; // amber when < £500 remaining

function getTaxYear(date: Date): { start: Date; end: Date; label: string } {
  const y = date.getFullYear();
  const aprSix = new Date(y, 3, 6); // April 6 of current year
  if (date >= aprSix) {
    return { start: aprSix, end: new Date(y + 1, 3, 5, 23, 59, 59), label: `${y}/${String(y + 1).slice(2)}` };
  }
  return { start: new Date(y - 1, 3, 6), end: new Date(y, 3, 5, 23, 59, 59), label: `${y - 1}/${String(y).slice(2)}` };
}

function daysRemaining(end: Date): number {
  return Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86_400_000));
}

function fmt(n: number) {
  return n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
}

// Detect bed & breakfast: sell in current year, repurchase within 30 days
function detectBedAndBreakfast(trades: Trade[], taxYearStart: Date, taxYearEnd: Date) {
  const warns: { ticker: string; sellDate: string; buyDate: string; daysDiff: number }[] = [];
  const sells = trades.filter(
    t => t.type === 'SELL' && !t.isISA &&
    new Date(t.date) >= taxYearStart && new Date(t.date) <= taxYearEnd
  );
  for (const sell of sells) {
    const sellDate = new Date(sell.date);
    const repurchases = trades.filter(t => {
      if (t.type !== 'BUY' || t.ticker !== sell.ticker || t.isISA) return false;
      const buyDate = new Date(t.date);
      const diff = (buyDate.getTime() - sellDate.getTime()) / 86_400_000;
      return diff > 0 && diff <= 30;
    });
    for (const rep of repurchases) {
      const diff = Math.ceil((new Date(rep.date).getTime() - sellDate.getTime()) / 86_400_000);
      warns.push({ ticker: sell.ticker, sellDate: sell.date.slice(0, 10), buyDate: rep.date.slice(0, 10), daysDiff: diff });
    }
  }
  return warns;
}

// Detect same-day rule: sell and buy same ticker same day
function detectSameDay(trades: Trade[], taxYearStart: Date, taxYearEnd: Date) {
  const warns: { ticker: string; date: string }[] = [];
  const sells = trades.filter(
    t => t.type === 'SELL' && !t.isISA &&
    new Date(t.date) >= taxYearStart && new Date(t.date) <= taxYearEnd
  );
  for (const sell of sells) {
    const hasSameDayBuy = trades.some(
      t => t.type === 'BUY' && t.ticker === sell.ticker && t.date.slice(0, 10) === sell.date.slice(0, 10) && !t.isISA
    );
    if (hasSameDayBuy) warns.push({ ticker: sell.ticker, date: sell.date.slice(0, 10) });
  }
  return warns;
}

export function TaxYearTracker() {
  const { trades } = useClearGainsStore();

  const analysis = useMemo(() => {
    const now = new Date();
    const taxYear = getTaxYear(now);
    const days = daysRemaining(taxYear.end);

    // Run full CGT calculation on all non-ISA trades
    const nonIsaTrades = trades.filter(t => !t.isISA);
    const calculations = calculateSection104(nonIsaTrades);

    // Filter to current tax year disposals only
    const inYear = calculations.filter(c => {
      const d = new Date(c.date);
      return d >= taxYear.start && d <= taxYear.end;
    });

    const totalGains = inYear.reduce((s, c) => s + c.gain, 0);
    const totalLosses = inYear.reduce((s, c) => s + c.loss, 0);
    const netGain = Math.max(0, totalGains - totalLosses);
    const aeaUsed = Math.min(netGain, CGT_AEA);
    const aeaRemaining = Math.max(0, CGT_AEA - netGain);
    const taxableGain = Math.max(0, netGain - CGT_AEA);
    const estimatedCGT = taxableGain * 0.24; // worst-case higher rate

    const bbWarnings = detectBedAndBreakfast(trades, taxYear.start, taxYear.end);
    const sameDayWarnings = detectSameDay(trades, taxYear.start, taxYear.end);

    return {
      taxYear, days, totalGains, totalLosses, netGain,
      aeaUsed, aeaRemaining, taxableGain, estimatedCGT,
      bbWarnings, sameDayWarnings,
      disposalCount: inYear.length,
    };
  }, [trades]);

  const { taxYear, days, netGain, aeaUsed, aeaRemaining, taxableGain, estimatedCGT, bbWarnings, sameDayWarnings } = analysis;

  const exceeded = netGain > CGT_AEA;
  const nearLimit = !exceeded && aeaRemaining < WARN_THRESHOLD;
  const status = exceeded ? 'red' : nearLimit ? 'amber' : 'green';

  // Fire push notification once when CGT AEA drops within £500
  const notifiedRef = useRef(false);
  useEffect(() => {
    if (nearLimit && !notifiedRef.current && analysis.disposalCount > 0) {
      notifiedRef.current = true;
      sendPush(
        'CGT Warning — Near Annual Limit',
        `Only £${aeaRemaining.toFixed(0)} remaining of your £3,000 CGT exemption for ${taxYear.label}. Consider deferring disposals.`,
        '/cgt'
      );
    }
    if (!nearLimit) notifiedRef.current = false;
  }, [nearLimit, aeaRemaining, taxYear.label, analysis.disposalCount]);

  const aeaPct = Math.min(100, (aeaUsed / CGT_AEA) * 100);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-emerald-400" />
          <div>
            <p className="text-sm font-semibold text-gray-200">Tax Year {taxYear.label}</p>
            <p className="text-xs text-gray-500">{days} days remaining · 5 April {taxYear.end.getFullYear()}</p>
          </div>
        </div>
        <div className={clsx(
          'flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg font-medium',
          status === 'green' && 'bg-emerald-500/10 text-emerald-400',
          status === 'amber' && 'bg-amber-500/10 text-amber-400',
          status === 'red' && 'bg-red-500/10 text-red-400',
        )}>
          {status === 'green' && <CheckCircle2 className="h-3.5 w-3.5" />}
          {status === 'amber' && <AlertTriangle className="h-3.5 w-3.5" />}
          {status === 'red' && <AlertCircle className="h-3.5 w-3.5" />}
          {status === 'green' ? 'Within AEA' : status === 'amber' ? 'Near limit' : 'AEA exceeded'}
        </div>
      </div>

      {/* CGT AEA progress bar */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>CGT Annual Exempt Amount used</span>
          <span className={clsx(exceeded ? 'text-red-400' : nearLimit ? 'text-amber-400' : 'text-emerald-400')}>
            {fmt(aeaUsed)} / {fmt(CGT_AEA)}
          </span>
        </div>
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={clsx(
              'h-full rounded-full transition-all',
              status === 'green' && 'bg-emerald-500',
              status === 'amber' && 'bg-amber-500',
              status === 'red' && 'bg-red-500',
            )}
            style={{ width: `${aeaPct}%` }}
          />
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        {[
          { label: 'Net Gain', value: fmt(netGain), color: netGain > 0 ? 'text-white' : 'text-gray-500' },
          { label: 'AEA Remaining', value: fmt(aeaRemaining), color: exceeded ? 'text-red-400' : nearLimit ? 'text-amber-400' : 'text-emerald-400' },
          { label: 'Taxable Gain', value: taxableGain > 0 ? fmt(taxableGain) : '£0', color: taxableGain > 0 ? 'text-red-400' : 'text-gray-500' },
          { label: 'Est. CGT Due', value: estimatedCGT > 0 ? fmt(estimatedCGT) : '£0', color: estimatedCGT > 0 ? 'text-red-400' : 'text-gray-500' },
        ].map(item => (
          <div key={item.label} className="bg-gray-800/50 rounded-lg px-2.5 py-2">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">{item.label}</p>
            <p className={clsx('text-sm font-semibold font-mono', item.color)}>{item.value}</p>
          </div>
        ))}
      </div>

      {/* Warnings */}
      {exceeded && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-2 text-xs text-red-300">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span>
            Your net gains <strong>{fmt(netGain)}</strong> exceed the £3,000 AEA. Estimated CGT: <strong>{fmt(estimatedCGT)}</strong> at 24% (higher rate). Consult a tax adviser.
          </span>
        </div>
      )}
      {nearLimit && (
        <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-2 text-xs text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span>Only <strong>{fmt(aeaRemaining)}</strong> remaining before CGT is due. Consider deferring disposals to the next tax year.</span>
        </div>
      )}

      {/* Bed & Breakfast warnings */}
      {bbWarnings.length > 0 && (
        <div className="flex items-start gap-2 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 mb-2 text-xs text-blue-300">
          <RefreshCw className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span>
            <strong>30-day rule triggered:</strong>{' '}
            {bbWarnings.map(w => `${w.ticker} (sold ${w.sellDate}, repurchased ${w.buyDate} — ${w.daysDiff}d)`).join('; ')}.
            These disposals use repurchase price, not pool price, for CGT.
          </span>
        </div>
      )}

      {/* Same-day warnings */}
      {sameDayWarnings.length > 0 && (
        <div className="flex items-start gap-2 bg-purple-500/10 border border-purple-500/20 rounded-lg px-3 py-2 text-xs text-purple-300">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span>
            <strong>Same-day rule:</strong>{' '}
            {sameDayWarnings.map(w => `${w.ticker} on ${w.date}`).join('; ')}.
            Same-day buys matched against same-day sells — not the pool price.
          </span>
        </div>
      )}

      {analysis.disposalCount === 0 && (
        <p className="text-xs text-gray-600 text-center py-1">No disposals in {taxYear.label} — add trades in the Trade Ledger.</p>
      )}
    </div>
  );
}

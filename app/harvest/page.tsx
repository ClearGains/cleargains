'use client';

import { useMemo, useState } from 'react';
import { Scissors, AlertTriangle, Info, CheckSquare, Square } from 'lucide-react';
import { clsx } from 'clsx';
import { useClearGainsStore } from '@/lib/store';
import { calculateSection104 } from '@/lib/cgt';
import { Card, CardHeader } from '@/components/ui/Card';

const AEA = 3_000;          // annual exempt amount 2024/25+
const BASIC_RATE = 0.18;
const HIGHER_RATE = 0.24;

function fmtGBP(v: number) {
  return v.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
}

/** Start of the current UK tax year (6 April). */
function taxYearStart(now = new Date()): Date {
  const y = now.getMonth() > 3 || (now.getMonth() === 3 && now.getDate() >= 6)
    ? now.getFullYear()
    : now.getFullYear() - 1;
  return new Date(y, 3, 6);
}

export default function HarvestPage() {
  const { t212Positions, section104Pools, trades } = useClearGainsStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Realized gains so far this UK tax year (from the ledger, matched per HMRC rules)
  const realizedThisYear = useMemo(() => {
    const start = taxYearStart();
    const calcs = calculateSection104(trades).filter(c => new Date(c.date) >= start);
    const gains  = calcs.reduce((s, c) => s + c.gain, 0);
    const losses = calcs.reduce((s, c) => s + c.loss, 0);
    return { gains, losses, net: gains - losses };
  }, [trades]);

  // What-if rows: unrealized gain/loss per non-ISA position at pool average cost
  const rows = useMemo(() => {
    return t212Positions
      .filter(p => !p.isISA && p.quantity > 0)
      .map(p => {
        const pool = section104Pools[p.ticker];
        const costPerShare = pool && pool.totalShares > 0 ? pool.averageCost : p.averagePrice;
        const costSource = pool && pool.totalShares > 0 ? 's104 pool' : 'avg price';
        const value = p.currentPrice * p.quantity;
        const gain  = (p.currentPrice - costPerShare) * p.quantity;
        return { ticker: p.ticker, quantity: p.quantity, value, costPerShare, gain, costSource };
      })
      .sort((a, b) => b.gain - a.gain);
  }, [t212Positions, section104Pools]);

  const toggle = (ticker: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker); else next.add(ticker);
      return next;
    });

  // Simulation: realized-so-far + selected disposals
  const sim = useMemo(() => {
    const selRows = rows.filter(r => selected.has(r.ticker));
    const selGains  = selRows.filter(r => r.gain > 0).reduce((s, r) => s + r.gain, 0);
    const selLosses = selRows.filter(r => r.gain < 0).reduce((s, r) => s - r.gain, 0);
    const totalGains  = realizedThisYear.gains + selGains;
    const totalLosses = realizedThisYear.losses + selLosses;
    const netGain     = Math.max(0, totalGains - totalLosses);
    const taxable     = Math.max(0, netGain - AEA);
    const allowanceUsed = Math.min(netGain, AEA);
    return {
      selGains, selLosses,
      netGain, taxable, allowanceUsed,
      allowanceLeft: Math.max(0, AEA - netGain),
      taxBasic:  taxable * BASIC_RATE,
      taxHigher: taxable * HIGHER_RATE,
    };
  }, [rows, selected, realizedThisYear]);

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Scissors className="h-6 w-6 text-emerald-400" />
          Tax Harvesting
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          What-if disposal planner — use your £{AEA.toLocaleString()} CGT allowance before 5 April instead of losing it
        </p>
      </div>

      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 mb-6 flex items-start gap-3">
        <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-yellow-400">
          <span className="font-semibold">Educational estimate only, not tax advice.</span>{' '}
          Estimates use Section 104 average cost and ignore fees on the simulated sale. If you rebuy the
          same share within 30 days, the bed &amp; breakfast rule re-matches your disposal against the
          rebuy — the harvest won&apos;t count. Verify with a qualified adviser before acting.
        </p>
      </div>

      {rows.length === 0 ? (
        <Card>
          <div className="text-center text-gray-500 text-sm py-10">
            No non-ISA positions found — sync Trading 212 on the Dashboard and add your trade history in
            the Ledger to plan disposals.
          </div>
        </Card>
      ) : (
        <>
          {/* Simulation summary */}
          <Card className="mb-6">
            <CardHeader
              title="This Tax Year"
              subtitle={`Realized so far: ${fmtGBP(realizedThisYear.gains)} gains − ${fmtGBP(realizedThisYear.losses)} losses · simulating ${selected.size} disposal(s)`}
            />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Net gain (after sales)</div>
                <div className="text-base font-bold text-white font-mono">{fmtGBP(sim.netGain)}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Allowance used</div>
                <div className={clsx('text-base font-bold font-mono',
                  sim.allowanceLeft === 0 ? 'text-yellow-400' : 'text-emerald-400')}>
                  {fmtGBP(sim.allowanceUsed)} / {fmtGBP(AEA)}
                </div>
                <div className="mt-1 w-full bg-gray-800 rounded-full h-1.5">
                  <div
                    className={clsx('h-1.5 rounded-full', sim.allowanceLeft === 0 ? 'bg-yellow-500' : 'bg-emerald-500')}
                    style={{ width: `${Math.min(100, (sim.allowanceUsed / AEA) * 100)}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Taxable gain</div>
                <div className={clsx('text-base font-bold font-mono', sim.taxable > 0 ? 'text-rose-400' : 'text-emerald-400')}>
                  {fmtGBP(sim.taxable)}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Est. tax (18% / 24%)</div>
                <div className="text-base font-bold text-white font-mono">
                  {fmtGBP(sim.taxBasic)} / {fmtGBP(sim.taxHigher)}
                </div>
              </div>
            </div>
            {sim.allowanceLeft > 0 && sim.selGains > 0 && (
              <p className="text-xs text-emerald-400 mt-3 flex items-start gap-2">
                <Info className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                {fmtGBP(sim.allowanceLeft)} of allowance still unused — you could realize that much more
                gain this year completely tax-free.
              </p>
            )}
          </Card>

          {/* Position picker */}
          <Card>
            <CardHeader
              title="Simulate Selling"
              subtitle="Tick positions to see the CGT impact of selling them today (non-ISA only)"
            />
            <div className="space-y-1.5">
              {rows.map(r => {
                const isSel = selected.has(r.ticker);
                return (
                  <button
                    key={r.ticker}
                    onClick={() => toggle(r.ticker)}
                    className={clsx(
                      'w-full flex items-center gap-3 p-2.5 rounded-lg border text-left transition-colors',
                      isSel
                        ? 'bg-indigo-500/10 border-indigo-500/40'
                        : 'bg-gray-900/40 border-gray-800 hover:border-gray-700',
                    )}
                  >
                    {isSel
                      ? <CheckSquare className="h-4 w-4 text-indigo-400 flex-shrink-0" />
                      : <Square className="h-4 w-4 text-gray-600 flex-shrink-0" />}
                    <span className="w-20 font-mono font-semibold text-white text-sm flex-shrink-0 truncate">
                      {r.ticker.split('_')[0]}
                    </span>
                    <span className="text-xs text-gray-500 flex-1">
                      {r.quantity.toLocaleString('en-GB', { maximumFractionDigits: 4 })} sh ·{' '}
                      cost {r.costPerShare.toFixed(2)} <span className="text-gray-700">({r.costSource})</span>
                    </span>
                    <span className="text-xs text-gray-400 font-mono">{fmtGBP(r.value)}</span>
                    <span className={clsx('w-24 text-right text-sm font-mono font-bold',
                      r.gain >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                      {r.gain >= 0 ? '+' : ''}{fmtGBP(r.gain)}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-gray-600 mt-4">
              Tip: realizing losses offsets gains pound-for-pound before the allowance is applied —
              pairing a loser with a winner can zero out the taxable amount.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

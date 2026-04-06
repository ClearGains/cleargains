'use client';

import { useMemo, useState } from 'react';
import {
  Calculator,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  FileText,
} from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import {
  calculateSection104,
  generateSA108Preview,
  buildSection104Pools,
} from '@/lib/cgt';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { clsx } from 'clsx';

function formatGBP(v: number) {
  return v.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
}

// UK tax year: Apr 6 – Apr 5
function getTaxYears() {
  const now = new Date();
  const curYear = now.getFullYear();
  const years = [];
  for (let y = curYear; y >= curYear - 5; y--) {
    years.push(`${y - 1}/${y}`);
  }
  return years;
}

function filterTradesByTaxYear(trades: ReturnType<typeof useClearGainsStore>['trades'], taxYear: string) {
  const [startY, endY] = taxYear.split('/').map(Number);
  const start = new Date(`${startY}-04-06`);
  const end = new Date(`${endY}-04-05T23:59:59`);
  return trades.filter((t) => {
    const d = new Date(t.date);
    return d >= start && d <= end;
  });
}

export default function CGTPage() {
  const { trades, selectedCountry, section104Pools } = useClearGainsStore();

  const taxYears = getTaxYears();
  const [taxYear, setTaxYear] = useState(taxYears[0]);
  const [incomeBand, setIncomeBand] = useState<'basic' | 'higher'>('basic');
  const [showCalculations, setShowCalculations] = useState(false);

  const { sa108, pools } = useMemo(() => {
    const yearTrades = filterTradesByTaxYear(trades, taxYear);
    const calculations = calculateSection104(yearTrades);
    const sa108 = generateSA108Preview(calculations, selectedCountry.aea);
    const pools = buildSection104Pools(yearTrades);
    return { sa108, pools };
  }, [trades, taxYear, selectedCountry.aea]);

  // Re-compute tax based on income band selection (UK: basic=18%, higher=24%)
  const basicRate = 0.18;
  const higherRate = 0.24;
  const taxableGain = sa108.taxableGain;
  const estimatedTax =
    incomeBand === 'basic'
      ? taxableGain * basicRate
      : taxableGain * higherRate;

  const hasGains = sa108.totalGains > 0;
  const hasTrades = trades.length > 0;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Calculator className="h-6 w-6 text-emerald-400" />
          CGT Calculator
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          UK Section 104 share pooling — same-day, 30-day bed &amp; breakfast, and pool rules
        </p>
      </div>

      {/* Disclaimer */}
      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 mb-6 flex items-start gap-3">
        <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-yellow-400">
          <span className="font-semibold">Estimates only.</span> Always verify with HMRC guidance
          and consult a qualified tax adviser for your Self Assessment (SA108). ISA holdings are
          excluded automatically.
        </p>
      </div>

      {!hasTrades && (
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl px-4 py-6 mb-6 text-center">
          <Calculator className="h-10 w-10 text-blue-400 mx-auto mb-3" />
          <p className="text-sm text-gray-300 font-medium">No trades in ledger</p>
          <p className="text-xs text-gray-500 mt-1">
            Go to the Trade Ledger to add trades or import from Trading 212
          </p>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Tax Year</label>
          <select
            value={taxYear}
            onChange={(e) => setTaxYear(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
          >
            {taxYears.map((y) => (
              <option key={y} value={y}>
                {y} (6 Apr {y.split('/')[0]} – 5 Apr {y.split('/')[1]})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Income Tax Band</label>
          <div className="flex bg-gray-800 border border-gray-700 rounded-lg p-0.5">
            {(['basic', 'higher'] as const).map((band) => (
              <button
                key={band}
                onClick={() => setIncomeBand(band)}
                className={clsx(
                  'px-3 py-1 rounded-md text-xs font-medium transition-colors',
                  incomeBand === band
                    ? 'bg-emerald-600 text-white'
                    : 'text-gray-400 hover:text-gray-200'
                )}
              >
                {band === 'basic' ? 'Basic (18%)' : 'Higher (24%)'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* SA108 Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {[
          {
            label: 'Total Proceeds',
            value: formatGBP(sa108.totalProceeds),
            color: 'text-white',
          },
          {
            label: 'Allowable Costs',
            value: formatGBP(sa108.totalAllowableCosts),
            color: 'text-white',
          },
          {
            label: 'Total Gains',
            value: formatGBP(sa108.totalGains),
            color: 'text-emerald-400',
          },
          {
            label: 'Total Losses',
            value: formatGBP(sa108.totalLosses),
            color: 'text-red-400',
          },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1">{label}</div>
            <div className={clsx('text-xl font-bold font-mono', color)}>{value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* CGT Summary */}
        <Card>
          <CardHeader
            title={`SA108 Summary — ${taxYear}`}
            subtitle="Capital Gains Tax computation"
            icon={<FileText className="h-4 w-4" />}
          />
          <div className="space-y-2.5">
            {[
              { label: 'Net Gain', value: formatGBP(sa108.netGain) },
              { label: `Annual Exempt Amount (${selectedCountry.currencySymbol}${selectedCountry.aea.toLocaleString()})`, value: `− ${formatGBP(Math.min(sa108.netGain, selectedCountry.aea))}`, muted: true },
              { label: 'Taxable Gain', value: formatGBP(taxableGain), bold: true },
              {
                label: `Estimated Tax (${incomeBand === 'basic' ? '18%' : '24%'})`,
                value: formatGBP(estimatedTax),
                highlight: true,
              },
            ].map(({ label, value, muted, bold, highlight }) => (
              <div
                key={label}
                className={clsx(
                  'flex items-center justify-between py-2',
                  highlight
                    ? 'bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3'
                    : 'border-b border-gray-800/50'
                )}
              >
                <span className={clsx('text-sm', muted ? 'text-gray-500' : 'text-gray-300')}>
                  {label}
                </span>
                <span
                  className={clsx(
                    'text-sm font-mono',
                    highlight ? 'text-emerald-400 font-bold' : bold ? 'text-white font-semibold' : 'text-gray-200'
                  )}
                >
                  {value}
                </span>
              </div>
            ))}
          </div>

          {taxableGain <= 0 && hasTrades && (
            <div className="mt-4 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2 flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-400 flex-shrink-0" />
              <span className="text-xs text-emerald-400">
                Gains are within the annual exempt amount — no CGT due for {taxYear}
              </span>
            </div>
          )}
        </Card>

        {/* Section 104 Pools */}
        <Card>
          <CardHeader
            title="Section 104 Share Pools"
            subtitle="Current pool balances"
            icon={<Info className="h-4 w-4" />}
          />
          {Object.keys(pools).length === 0 ? (
            <div className="py-6 text-center text-sm text-gray-600">
              No pools — add buy trades to build pools
            </div>
          ) : (
            <div className="space-y-2">
              {Object.values(pools).map((pool) => (
                <div
                  key={pool.ticker}
                  className="flex items-center justify-between py-2 border-b border-gray-800/50"
                >
                  <div>
                    <div className="font-mono font-semibold text-white text-sm">{pool.ticker}</div>
                    <div className="text-xs text-gray-500">
                      {pool.totalShares.toFixed(4)} shares · avg {formatGBP(pool.averageCost)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-mono text-gray-200">
                      {formatGBP(pool.totalCost)}
                    </div>
                    <div className="text-xs text-gray-500">total cost</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Detailed calculations */}
      {sa108.calculations.length > 0 && (
        <Card>
          <button
            className="w-full flex items-center justify-between"
            onClick={() => setShowCalculations(!showCalculations)}
          >
            <CardHeader
              title={`Disposal Calculations (${sa108.calculations.length})`}
              subtitle="Click to expand individual disposals"
              icon={<Calculator className="h-4 w-4" />}
            />
            {showCalculations ? (
              <ChevronUp className="h-4 w-4 text-gray-500" />
            ) : (
              <ChevronDown className="h-4 w-4 text-gray-500" />
            )}
          </button>

          {showCalculations && (
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-800">
                    <th className="text-left py-2 pr-3">Date</th>
                    <th className="text-left py-2 pr-3">Ticker</th>
                    <th className="text-center py-2 pr-3">Rule</th>
                    <th className="text-right py-2 pr-3">Qty</th>
                    <th className="text-right py-2 pr-3">Proceeds</th>
                    <th className="text-right py-2 pr-3">Cost</th>
                    <th className="text-right py-2 pr-3">Gain</th>
                    <th className="text-right py-2">Loss</th>
                  </tr>
                </thead>
                <tbody>
                  {sa108.calculations.map((calc, i) => (
                    <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                      <td className="py-2 pr-3 text-gray-500">
                        {new Date(calc.date).toLocaleDateString('en-GB')}
                      </td>
                      <td className="py-2 pr-3 font-mono font-semibold text-white">
                        {calc.ticker}
                      </td>
                      <td className="py-2 pr-3 text-center">
                        <Badge
                          variant={
                            calc.rule === 'same-day'
                              ? 'buy'
                              : calc.rule === 'bed-and-breakfast'
                              ? 'warn'
                              : 'default'
                          }
                        >
                          {calc.rule === 'same-day'
                            ? 'Same Day'
                            : calc.rule === 'bed-and-breakfast'
                            ? 'B&B 30d'
                            : 'Pool'}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-gray-300">
                        {calc.quantity.toFixed(4)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-gray-200">
                        {formatGBP(calc.disposal)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-gray-200">
                        {formatGBP(calc.allowableCost)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-emerald-400">
                        {calc.gain > 0 ? formatGBP(calc.gain) : '—'}
                      </td>
                      <td className="py-2 text-right font-mono text-red-400">
                        {calc.loss > 0 ? formatGBP(calc.loss) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* HMRC matching rules explainer */}
      <Card className="mt-4">
        <CardHeader
          title="UK CGT Matching Rules"
          subtitle="How HMRC requires share disposals to be matched"
          icon={<Info className="h-4 w-4" />}
        />
        <div className="space-y-3 text-xs text-gray-400">
          {[
            {
              rule: '1. Same-Day Rule',
              color: 'bg-emerald-500',
              desc: 'Shares sold on the same day as shares bought are matched first. This prevents artificial tax reduction through same-day round trips.',
            },
            {
              rule: '2. Bed & Breakfast (30-Day Rule)',
              color: 'bg-yellow-500',
              desc: 'Shares sold are matched against acquisitions in the 30 days following the disposal. Prevents "bed & breakfast" schemes where investors sell and re-buy to crystallise losses.',
            },
            {
              rule: '3. Section 104 Pool',
              color: 'bg-gray-500',
              desc: 'Remaining shares are matched against the Section 104 pool — a weighted average cost pool of all shares acquired and not yet disposed of.',
            },
          ].map(({ rule, color, desc }) => (
            <div key={rule} className="flex gap-3">
              <div className={clsx('w-2 h-2 rounded-full flex-shrink-0 mt-1', color)} />
              <div>
                <div className="font-semibold text-gray-300">{rule}</div>
                <div className="mt-0.5">{desc}</div>
              </div>
            </div>
          ))}
          <div className="mt-2 pt-2 border-t border-gray-800">
            <span className="text-gray-500">Annual Exempt Amount 2024/25: </span>
            <span className="text-white font-medium">£3,000</span>
            <span className="text-gray-500"> · Basic rate CGT on shares: </span>
            <span className="text-white font-medium">18%</span>
            <span className="text-gray-500"> · Higher rate: </span>
            <span className="text-white font-medium">24%</span>
          </div>
        </div>
      </Card>
    </div>
  );
}

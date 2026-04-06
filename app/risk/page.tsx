'use client';

import { useMemo } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Info,
} from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { computePortfolioRisk } from '@/lib/risk';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { clsx } from 'clsx';

function formatGBP(v: number) {
  return v.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
}

function StatusIcon({ status }: { status: 'pass' | 'warn' | 'fail' | 'pending' }) {
  if (status === 'pass') return <ShieldCheck className="h-4 w-4 text-emerald-400" />;
  if (status === 'warn') return <ShieldAlert className="h-4 w-4 text-yellow-400" />;
  if (status === 'fail') return <ShieldX className="h-4 w-4 text-red-400" />;
  return <Info className="h-4 w-4 text-gray-500" />;
}

function RiskGauge({ score, label }: { score: number; label: string }) {
  const color =
    score >= 70 ? 'text-red-400' : score >= 45 ? 'text-yellow-400' : score >= 20 ? 'text-blue-400' : 'text-emerald-400';
  const barColor =
    score >= 70 ? 'bg-red-500' : score >= 45 ? 'bg-yellow-500' : score >= 20 ? 'bg-blue-500' : 'bg-emerald-500';

  return (
    <div className="text-center">
      <div className={clsx('text-5xl font-bold font-mono', color)}>{score}</div>
      <div className="text-xs text-gray-500 mt-1">/ 100</div>
      <div className={clsx('text-sm font-semibold mt-2', color)}>{label}</div>
      <div className="mt-3 w-full bg-gray-800 rounded-full h-2">
        <div
          className={clsx('h-2 rounded-full transition-all', barColor)}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  );
}

export default function RiskPage() {
  const { t212Positions, section104Pools, t212Connected } = useClearGainsStore();

  const report = useMemo(
    () => computePortfolioRisk(t212Positions, section104Pools),
    [t212Positions, section104Pools]
  );

  const sortedPositions = [...t212Positions].sort(
    (a, b) => b.currentPrice * b.quantity - a.currentPrice * a.quantity
  );

  const totalValue = report.totalValue;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-emerald-400" />
          Risk Engine
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Portfolio concentration, VaR estimates, and UK compliance checks
        </p>
      </div>

      {/* Disclaimer */}
      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 mb-6 flex items-start gap-3">
        <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-yellow-400">
          <span className="font-semibold">Educational tool only.</span> Risk metrics are simplified
          estimates. VaR assumes 2% average daily volatility — actual volatility will differ.
          This is not regulated financial advice.
        </p>
      </div>

      {!t212Connected && t212Positions.length === 0 && (
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl px-4 py-6 mb-6 text-center">
          <ShieldCheck className="h-10 w-10 text-blue-400 mx-auto mb-3" />
          <p className="text-sm text-gray-300 font-medium">No portfolio data</p>
          <p className="text-xs text-gray-500 mt-1">
            Sync your Trading 212 account on the Dashboard to see risk analysis
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Risk score */}
        <Card>
          <CardHeader title="Overall Risk Score" subtitle="Based on concentration & checks" icon={<ShieldCheck className="h-4 w-4" />} />
          <RiskGauge score={report.riskScore} label={report.riskLabel} />
        </Card>

        {/* Key metrics */}
        <Card className="lg:col-span-2">
          <CardHeader title="Portfolio Metrics" subtitle="Key risk indicators" />
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {[
              { label: 'Total Value', value: formatGBP(totalValue) },
              { label: 'Positions', value: report.positionCount.toString() },
              { label: '1-Day VaR (95%)', value: formatGBP(report.estimatedVaR95), sub: 'at 2% daily vol' },
              { label: 'Non-ISA Value', value: formatGBP(report.nonIsaValue) },
              { label: 'ISA Value', value: formatGBP(report.isaValue) },
              {
                label: 'HHI Index',
                value: report.concentration.herfindahlIndex.toFixed(3),
                sub: '0=diverse, 1=one position',
              },
            ].map(({ label, value, sub }) => (
              <div key={label}>
                <div className="text-xs text-gray-500 mb-0.5">{label}</div>
                <div className="text-base font-bold text-white font-mono">{value}</div>
                {sub && <div className="text-xs text-gray-600">{sub}</div>}
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Risk checks */}
      {report.checks.length > 0 && (
        <Card className="mb-6">
          <CardHeader
            title="Risk Checks"
            subtitle={`${report.checks.filter(c => c.status === 'pass').length}/${report.checks.length} checks passed`}
            icon={<ShieldCheck className="h-4 w-4" />}
          />
          <div className="space-y-3">
            {report.checks.map((check) => (
              <div
                key={check.id}
                className={clsx(
                  'flex items-start gap-3 p-3 rounded-lg border',
                  check.status === 'pass'
                    ? 'bg-emerald-500/5 border-emerald-500/20'
                    : check.status === 'warn'
                    ? 'bg-yellow-500/5 border-yellow-500/20'
                    : 'bg-red-500/5 border-red-500/20'
                )}
              >
                <StatusIcon status={check.status} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-gray-200">{check.label}</span>
                    <Badge
                      variant={
                        check.status === 'pass'
                          ? 'pass'
                          : check.status === 'warn'
                          ? 'warn'
                          : 'fail'
                      }
                    >
                      {check.status.toUpperCase()}
                    </Badge>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">{check.assessment}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Concentration */}
      {sortedPositions.length > 0 && (
        <Card className="mb-6">
          <CardHeader
            title="Position Concentration"
            subtitle="Portfolio weight by position"
            icon={<Info className="h-4 w-4" />}
          />
          <div className="space-y-2">
            {sortedPositions.map((pos) => {
              const value = pos.currentPrice * pos.quantity;
              const weight = totalValue > 0 ? (value / totalValue) * 100 : 0;
              const isHigh = weight > 25;
              const isVeryHigh = weight > 40;

              return (
                <div key={pos.ticker} className="flex items-center gap-3">
                  <div className="w-16 font-mono font-semibold text-white text-sm flex-shrink-0">
                    {pos.ticker}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs text-gray-500">{formatGBP(value)}</span>
                      <span
                        className={clsx(
                          'text-xs font-medium',
                          isVeryHigh
                            ? 'text-red-400'
                            : isHigh
                            ? 'text-yellow-400'
                            : 'text-gray-300'
                        )}
                      >
                        {weight.toFixed(1)}%
                      </span>
                    </div>
                    <div className="w-full bg-gray-800 rounded-full h-1.5">
                      <div
                        className={clsx(
                          'h-1.5 rounded-full',
                          isVeryHigh ? 'bg-red-500' : isHigh ? 'bg-yellow-500' : 'bg-emerald-500'
                        )}
                        style={{ width: `${Math.min(100, weight)}%` }}
                      />
                    </div>
                  </div>
                  <div className="w-20 text-right">
                    <div
                      className={clsx(
                        'text-xs font-mono',
                        pos.ppl >= 0 ? 'text-emerald-400' : 'text-red-400'
                      )}
                    >
                      {pos.ppl >= 0 ? '+' : ''}{formatGBP(pos.ppl)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Top concentration summary */}
          <div className="mt-4 pt-4 border-t border-gray-800 grid grid-cols-3 gap-3 text-center">
            {[
              { label: 'Top 1', value: report.concentration.top1Pct },
              { label: 'Top 3', value: report.concentration.top3Pct },
              { label: 'Top 5', value: report.concentration.top5Pct },
            ].map(({ label, value }) => (
              <div key={label}>
                <div className="text-xs text-gray-500">{label}</div>
                <div
                  className={clsx(
                    'text-lg font-bold font-mono',
                    value > 75
                      ? 'text-red-400'
                      : value > 50
                      ? 'text-yellow-400'
                      : 'text-emerald-400'
                  )}
                >
                  {value.toFixed(1)}%
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Risk tips */}
      <Card>
        <CardHeader
          title="Risk Management Tips"
          subtitle="UK investor best practices"
          icon={<Info className="h-4 w-4" />}
        />
        <div className="space-y-3 text-xs text-gray-400">
          {[
            {
              icon: <ShieldCheck className="h-4 w-4 text-blue-400 flex-shrink-0" />,
              title: 'Use Your ISA Allowance',
              desc: 'The £20,000 annual ISA allowance shelters all gains from CGT. Prioritise holding assets likely to appreciate inside your ISA.',
            },
            {
              icon: <TrendingUp className="h-4 w-4 text-emerald-400 flex-shrink-0" />,
              title: 'Diversify Across Sectors',
              desc: 'No single position should exceed 20% of your portfolio. Diversify across sectors, geographies, and asset classes to reduce idiosyncratic risk.',
            },
            {
              icon: <TrendingDown className="h-4 w-4 text-yellow-400 flex-shrink-0" />,
              title: 'Harvest Losses Before 5 April',
              desc: 'Realise losses before the end of the UK tax year (5 April) to offset gains. Watch out for the 30-day bed & breakfast rule.',
            },
            {
              icon: <AlertTriangle className="h-4 w-4 text-orange-400 flex-shrink-0" />,
              title: 'Annual Exempt Amount',
              desc: 'The CGT annual exempt amount is £3,000 for 2024/25. Consider spreading disposals across tax years to maximise use of this allowance.',
            },
          ].map(({ icon, title, desc }) => (
            <div key={title} className="flex items-start gap-3">
              {icon}
              <div>
                <div className="font-medium text-gray-300 mb-0.5">{title}</div>
                <div>{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

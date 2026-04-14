'use client';

import { useMemo, useState } from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  X,
  Download,
  Clock,
  Wifi,
  WifiOff,
  TrendingUp,
  TrendingDown,
  Info,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useClearGainsStore } from '@/lib/store';
import { computeTaxYearSummary, filterCurrentTaxYear, getTaxYear } from '@/lib/taxMonitor';
import { buildSection104Pools, calculateSection104, generateSA108Preview } from '@/lib/cgt';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { TaxTrade, CGTAlert, S104PoolEnriched } from '@/lib/types';

const CGT_AEA = 3_000;

function fmt(n: number) {
  return n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
}

function fmtDate(iso: string) {
  try { return new Date(iso).toLocaleDateString('en-GB'); } catch { return iso; }
}

function RuleBadge({ rule }: { rule: TaxTrade['rule'] }) {
  if (rule === 'same-day') return <Badge variant="info">Same-Day</Badge>;
  if (rule === 'bed-and-breakfast') return <Badge variant="warn">B&B</Badge>;
  return <Badge variant="default">S104</Badge>;
}

function AlertTypeIcon({ type }: { type: CGTAlert['type'] }) {
  if (type === 'gain') return <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />;
  if (type === 'loss') return <TrendingDown className="h-3.5 w-3.5 text-red-400" />;
  if (type === 'isa') return <ShieldCheck className="h-3.5 w-3.5 text-blue-400" />;
  if (type === 'aea-warning') return <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />;
  if (type === 'aea-exceeded') return <AlertCircle className="h-3.5 w-3.5 text-red-400" />;
  if (type === 'bb-rule') return <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />;
  return <Info className="h-3.5 w-3.5 text-gray-400" />;
}

export default function TaxMonitorPage() {
  const {
    taxTrades,
    cgtAlerts,
    carriedForwardLosses,
    taxMonitorLastPoll,
    taxMonitorLivePositions,
    t212Connected,
    t212IsaConnected,
    t212Positions,
    trades,
    dismissCGTAlert,
    setCarriedForwardLosses,
  } = useClearGainsStore();

  const [lossInput, setLossInput] = useState(String(carriedForwardLosses));

  const summary = useMemo(() =>
    computeTaxYearSummary(taxTrades, carriedForwardLosses),
    [taxTrades, carriedForwardLosses]
  );

  const yearTrades = useMemo(() => filterCurrentTaxYear(taxTrades), [taxTrades]);
  const nonIsaYearTrades = yearTrades.filter(t => !t.isISA);
  const isaYearTrades = yearTrades.filter(t => t.isISA);

  const taxYear = getTaxYear(new Date());

  // Section 104 pools enriched with live prices
  const s104Pools = useMemo(() => {
    const pools = buildSection104Pools(trades);
    const enriched: S104PoolEnriched[] = Object.values(pools).map(pool => {
      const livePos = t212Positions.find(p => p.ticker === pool.ticker || p.ticker.startsWith(pool.ticker));
      const currentPrice = livePos?.currentPrice;
      const currentValueGBP = currentPrice != null ? pool.totalShares * currentPrice : undefined;
      const unrealisedGainGBP = currentValueGBP != null ? currentValueGBP - pool.totalCost : undefined;
      const estimatedCGT = unrealisedGainGBP != null && unrealisedGainGBP > 0 ? unrealisedGainGBP * 0.24 : undefined;
      return { ...pool, currentPrice, currentValueGBP, unrealisedGainGBP, estimatedCGT };
    });
    return enriched.filter(p => p.totalShares > 0);
  }, [trades, t212Positions]);

  // SA108 from cgt.ts engine (trade-ledger based)
  const sa108 = useMemo(() => {
    const { start, end } = taxYear;
    const yearStoreTrades = trades.filter(t => {
      const d = new Date(t.date);
      return d >= start && d <= end;
    });
    const calcs = calculateSection104(yearStoreTrades);
    return generateSA108Preview(calcs, CGT_AEA);
  }, [trades, taxYear]);

  const aeaPct = Math.min(100, (summary.aeaUsed / CGT_AEA) * 100);
  const aeaExceeded = summary.netGain > CGT_AEA;
  const aeaNear = !aeaExceeded && summary.aeaRemaining < 500;

  function exportCSV() {
    const header = 'Date,Ticker,Account,Qty,Proceeds,Cost,Gain,Loss,Rule,Tax Due,Notes';
    const rows = yearTrades.map(t =>
      [
        fmtDate(t.disposalDate),
        t.ticker,
        t.accountType,
        t.quantity.toFixed(4),
        t.proceedsGBP.toFixed(2),
        t.allowableCostGBP.toFixed(2),
        t.gainGBP.toFixed(2),
        t.lossGBP.toFixed(2),
        t.rule,
        t.taxDueGBP.toFixed(2),
        t.notes ?? '',
      ].join(',')
    );
    const csv = [header, ...rows].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `cgt-disposals-${taxYear.label.replace('/', '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleLossBlur() {
    const n = parseFloat(lossInput);
    if (!isNaN(n) && n >= 0) setCarriedForwardLosses(n);
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
            <ShieldCheck className="h-6 w-6 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Live Account CGT Tracker</h1>
            <p className="text-sm text-gray-500">Tax Year {taxYear.label} · Tracking real disposals on your Live Invest account only</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {yearTrades.length > 0 && (
            <Button variant="outline" size="sm" onClick={exportCSV} icon={<Download className="h-3.5 w-3.5" />}>
              Export CSV
            </Button>
          )}
        </div>
      </div>

      {/* Account scope banner */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-emerald-500/8 border border-emerald-500/20">
          <span className="text-xl">💰</span>
          <div>
            <p className="text-xs font-semibold text-emerald-400">Live Invest Account</p>
            <p className="text-xs text-gray-500">Full CGT tracking — same-day, B&B, Section 104</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-blue-500/8 border border-blue-500/20">
          <span className="text-xl">📈</span>
          <div>
            <p className="text-xs font-semibold text-blue-400">ISA Account</p>
            <p className="text-xs text-gray-500">Tax Free — not included in CGT calculations</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-gray-800/50 border border-gray-700">
          <span className="text-xl">🎮</span>
          <div>
            <p className="text-xs font-semibold text-gray-400">Demo / Paper Positions</p>
            <p className="text-xs text-gray-600">Simulated — no tax implications whatsoever</p>
          </div>
        </div>
      </div>

      {/* Tax Year Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">Total Gains</p>
          <p className={clsx('text-2xl font-bold font-mono', summary.totalGains > 0 ? 'text-emerald-400' : 'text-white')}>
            {fmt(summary.totalGains)}
          </p>
          <p className="text-xs text-gray-600 mt-1">{nonIsaYearTrades.filter(t => t.gainGBP > 0).length} disposals</p>
        </Card>
        <Card>
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">Total Losses</p>
          <p className={clsx('text-2xl font-bold font-mono', summary.totalLosses > 0 ? 'text-red-400' : 'text-white')}>
            {fmt(summary.totalLosses)}
          </p>
          <p className="text-xs text-gray-600 mt-1">Available to offset gains</p>
        </Card>
        <Card>
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">AEA Remaining</p>
          <p className={clsx('text-2xl font-bold font-mono',
            aeaExceeded ? 'text-red-400' : aeaNear ? 'text-amber-400' : 'text-emerald-400'
          )}>
            {fmt(summary.aeaRemaining)}
          </p>
          <p className="text-xs text-gray-600 mt-1">of £3,000 annual exemption</p>
        </Card>
        <Card>
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-1">Est. CGT Due</p>
          <p className={clsx('text-2xl font-bold font-mono', summary.estimatedCGT > 0 ? 'text-red-400' : 'text-white')}>
            {fmt(summary.estimatedCGT)}
          </p>
          <p className="text-xs text-gray-600 mt-1">@ 24% higher rate</p>
        </Card>
      </div>

      {/* AEA Progress Bar */}
      <Card>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-gray-300">Annual Exempt Amount (AEA) Used</span>
          <span className="text-sm font-mono text-gray-400">{fmt(summary.aeaUsed)} / £3,000</span>
        </div>
        <div className="h-3 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={clsx(
              'h-full rounded-full transition-all duration-500',
              aeaExceeded ? 'bg-red-500' : aeaNear ? 'bg-amber-500' : 'bg-emerald-500'
            )}
            style={{ width: `${aeaPct}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-2 text-xs text-gray-600">
          <span>£0</span>
          <span className="text-gray-500">{aeaPct.toFixed(1)}% used</span>
          <span>£3,000</span>
        </div>

        {/* Status banner */}
        <div className={clsx(
          'mt-3 flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium',
          aeaExceeded
            ? 'bg-red-500/10 border border-red-500/20 text-red-400'
            : aeaNear
              ? 'bg-amber-500/10 border border-amber-500/20 text-amber-400'
              : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
        )}>
          {aeaExceeded ? (
            <><AlertCircle className="h-4 w-4 flex-shrink-0" /> AEA Exceeded — gains now taxable at 24%</>
          ) : aeaNear ? (
            <><AlertTriangle className="h-4 w-4 flex-shrink-0" /> Approaching AEA limit — {fmt(summary.aeaRemaining)} remaining</>
          ) : (
            <><CheckCircle2 className="h-4 w-4 flex-shrink-0" /> Within AEA — no CGT due on current gains</>
          )}
        </div>
      </Card>

      {/* Section 104 Pool Tracker */}
      {s104Pools.length > 0 && (
        <Card>
          <CardHeader
            title="Section 104 Pool Tracker"
            subtitle="Live cost-basis pools with estimated CGT if sold today"
            icon={<TrendingUp className="h-4 w-4" />}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left py-2 pr-3">Ticker</th>
                  <th className="text-right py-2 pr-3">Shares</th>
                  <th className="text-right py-2 pr-3">Avg Cost</th>
                  <th className="text-right py-2 pr-3">Pool Cost</th>
                  <th className="text-right py-2 pr-3">Curr. Price</th>
                  <th className="text-right py-2 pr-3">Curr. Value</th>
                  <th className="text-right py-2 pr-3">Unrealised</th>
                  <th className="text-right py-2">Est. CGT</th>
                </tr>
              </thead>
              <tbody>
                {s104Pools.map(pool => (
                  <tr key={pool.ticker} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="py-2 pr-3 font-semibold text-white">{pool.ticker}</td>
                    <td className="py-2 pr-3 text-right text-gray-300 font-mono">{pool.totalShares.toFixed(4)}</td>
                    <td className="py-2 pr-3 text-right text-gray-300 font-mono">{fmt(pool.averageCost)}</td>
                    <td className="py-2 pr-3 text-right text-gray-300 font-mono">{fmt(pool.totalCost)}</td>
                    <td className="py-2 pr-3 text-right text-gray-400 font-mono">
                      {pool.currentPrice != null ? fmt(pool.currentPrice) : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="py-2 pr-3 text-right text-gray-300 font-mono">
                      {pool.currentValueGBP != null ? fmt(pool.currentValueGBP) : <span className="text-gray-600">—</span>}
                    </td>
                    <td className={clsx('py-2 pr-3 text-right font-mono font-semibold',
                      pool.unrealisedGainGBP == null ? 'text-gray-600'
                        : pool.unrealisedGainGBP >= 0 ? 'text-emerald-400' : 'text-red-400'
                    )}>
                      {pool.unrealisedGainGBP != null ? fmt(pool.unrealisedGainGBP) : '—'}
                    </td>
                    <td className={clsx('py-2 text-right font-mono',
                      pool.estimatedCGT != null && pool.estimatedCGT > 0 ? 'text-red-400' : 'text-gray-600'
                    )}>
                      {pool.estimatedCGT != null && pool.estimatedCGT > 0 ? fmt(pool.estimatedCGT) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Trade History with Tax Column */}
      <Card>
        <CardHeader
          title={`Disposal History — Tax Year ${taxYear.label}`}
          subtitle={`${nonIsaYearTrades.length} Live Invest disposals · ${isaYearTrades.length} ISA (tax free) · Demo/paper excluded`}
          icon={<Clock className="h-4 w-4" />}
          action={
            yearTrades.length > 0 ? (
              <Button variant="ghost" size="sm" onClick={exportCSV} icon={<Download className="h-3.5 w-3.5" />}>
                CSV
              </Button>
            ) : undefined
          }
        />
        {yearTrades.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-gray-600 text-sm">No disposals recorded this tax year.</p>
            <p className="text-gray-700 text-xs mt-1">Disposals are detected automatically when your Live Invest account positions close.</p>
            <p className="text-gray-700 text-xs mt-0.5">Demo, paper, and ISA positions are excluded from CGT calculations.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left py-2 pr-3">Date</th>
                  <th className="text-left py-2 pr-3">Ticker</th>
                  <th className="text-left py-2 pr-3">Account</th>
                  <th className="text-right py-2 pr-3">Qty</th>
                  <th className="text-right py-2 pr-3">Proceeds</th>
                  <th className="text-right py-2 pr-3">Cost</th>
                  <th className="text-right py-2 pr-3">Gain/Loss</th>
                  <th className="text-center py-2 pr-3">Rule</th>
                  <th className="text-right py-2 pr-3">Tax Due</th>
                  <th className="text-left py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {yearTrades.map(t => (
                  <tr
                    key={t.id}
                    className={clsx(
                      'border-b border-gray-800/50 hover:bg-gray-800/20',
                      t.isISA ? 'opacity-60' : ''
                    )}
                  >
                    <td className="py-2 pr-3 text-gray-400">{fmtDate(t.disposalDate)}</td>
                    <td className="py-2 pr-3 font-semibold text-white">{t.ticker}</td>
                    <td className="py-2 pr-3">
                      {t.isISA || t.accountType === 'isa' ? (
                        <span className="text-blue-400 text-[10px] font-medium">📈 ISA — Tax Free</span>
                      ) : t.accountType === 'invest' ? (
                        <span className="text-emerald-400 text-[10px] font-medium">💰 Live — CGT tracked</span>
                      ) : (
                        <span className="text-gray-500 text-[10px]">💰 Live</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right text-gray-300 font-mono">{t.quantity.toFixed(4)}</td>
                    <td className="py-2 pr-3 text-right text-gray-300 font-mono">{fmt(t.proceedsGBP)}</td>
                    <td className="py-2 pr-3 text-right text-gray-400 font-mono">{fmt(t.allowableCostGBP)}</td>
                    <td className={clsx('py-2 pr-3 text-right font-mono font-semibold',
                      t.isISA ? 'text-blue-400' : t.gainGBP > 0 ? 'text-emerald-400' : 'text-red-400'
                    )}>
                      {t.isISA ? 'Tax Free' : t.gainGBP > 0 ? `+${fmt(t.gainGBP)}` : `-${fmt(t.lossGBP)}`}
                    </td>
                    <td className="py-2 pr-3 text-center">
                      {t.isISA ? <Badge variant="isa">ISA</Badge> : <RuleBadge rule={t.rule} />}
                    </td>
                    <td className={clsx('py-2 pr-3 text-right font-mono',
                      t.taxDueGBP > 0 ? 'text-red-400 font-semibold' : 'text-gray-600'
                    )}>
                      {t.isISA ? '—' : t.taxDueGBP > 0 ? fmt(t.taxDueGBP) : '£0.00'}
                    </td>
                    <td className="py-2 text-gray-500 max-w-[200px] truncate">
                      {t.notes ?? ''}
                      {t.bbWarning && !t.isISA && (
                        <span className="ml-1 text-amber-400 font-medium">B&B</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* SA108 Preview */}
      <Card>
        <CardHeader
          title="SA108 Preview"
          subtitle="Self Assessment Capital Gains supplementary pages — estimates only"
          icon={<ShieldCheck className="h-4 w-4" />}
        />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { box: 'Box 1', label: 'Number of disposals', value: String(sa108.calculations.length) },
            { box: 'Box 2', label: 'Disposal proceeds', value: fmt(sa108.totalProceeds) },
            { box: 'Box 3', label: 'Allowable costs', value: fmt(sa108.totalAllowableCosts) },
            { box: 'Box 4', label: 'Total gains', value: fmt(sa108.totalGains) },
            { box: 'Box 5', label: 'Total losses', value: fmt(sa108.totalLosses) },
            { box: 'Box 7', label: 'AEA used', value: fmt(Math.min(sa108.netGain, CGT_AEA)) },
            { box: 'Box 8', label: 'Net chargeable gains', value: fmt(sa108.taxableGain) },
            { box: 'Total Tax', label: 'Estimated tax due', value: fmt(sa108.totalTax) },
          ].map(({ box, label, value }) => (
            <div key={box} className="bg-gray-800/50 border border-gray-700 rounded-lg p-3">
              <p className="text-xs text-gray-500 font-medium">{box}</p>
              <p className="text-xs text-gray-400 mt-0.5">{label}</p>
              <p className="text-sm font-mono font-semibold text-white mt-1">{value}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-amber-400/70 mt-3 flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          Estimates only based on trade ledger data. Verify with HMRC guidance and consult a qualified tax adviser before filing.
        </p>
      </Card>

      {/* Loss Tracking */}
      <Card>
        <CardHeader
          title="Loss Tracking"
          subtitle="Current year losses offset gains; prior year losses carried forward"
          icon={<TrendingDown className="h-4 w-4" />}
        />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3">
            <p className="text-xs text-gray-500">Current Year Losses</p>
            <p className="text-lg font-mono font-bold text-red-400 mt-1">{fmt(summary.totalLosses)}</p>
            <p className="text-xs text-gray-600 mt-0.5">Automatically offset against gains</p>
          </div>
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3">
            <p className="text-xs text-gray-500 mb-1">Carried Forward Losses</p>
            <div className="flex items-center gap-2">
              <span className="text-gray-400 text-sm">£</span>
              <input
                type="number"
                min="0"
                step="1"
                value={lossInput}
                onChange={e => setLossInput(e.target.value)}
                onBlur={handleLossBlur}
                className="bg-gray-900 border border-gray-600 rounded-md px-2 py-1 text-sm font-mono text-white w-full focus:outline-none focus:border-emerald-500"
              />
            </div>
            <p className="text-xs text-gray-600 mt-1">From prior tax years</p>
          </div>
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3">
            <p className="text-xs text-gray-500">Total Losses Available</p>
            <p className="text-lg font-mono font-bold text-amber-400 mt-1">
              {fmt(summary.totalLosses + carriedForwardLosses)}
            </p>
            <p className="text-xs text-gray-600 mt-0.5">Current + carried forward</p>
          </div>
        </div>
      </Card>

      {/* ISA Disposals */}
      {isaYearTrades.length > 0 && (
        <Card>
          <CardHeader
            title="ISA Disposals — Tax Free"
            subtitle="These disposals incur no CGT liability"
            icon={<ShieldCheck className="h-4 w-4" />}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left py-2 pr-3">Date</th>
                  <th className="text-left py-2 pr-3">Ticker</th>
                  <th className="text-right py-2 pr-3">Qty</th>
                  <th className="text-right py-2 pr-3">Proceeds</th>
                  <th className="text-right py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {isaYearTrades.map(t => (
                  <tr key={t.id} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                    <td className="py-2 pr-3 text-gray-400">{fmtDate(t.disposalDate)}</td>
                    <td className="py-2 pr-3 font-semibold text-white">{t.ticker}</td>
                    <td className="py-2 pr-3 text-right text-gray-300 font-mono">{t.quantity.toFixed(4)}</td>
                    <td className="py-2 pr-3 text-right text-gray-300 font-mono">{fmt(t.proceedsGBP)}</td>
                    <td className="py-2 text-right">
                      <Badge variant="isa">Tax Free</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* CGT Alerts Log */}
      <Card>
        <CardHeader
          title="CGT Alerts Log"
          subtitle="Real-time disposal and tax events"
          icon={<AlertCircle className="h-4 w-4" />}
        />
        {cgtAlerts.length === 0 ? (
          <p className="text-sm text-gray-600 py-4 text-center">No alerts yet. Alerts appear when T212 positions close.</p>
        ) : (
          <div className="space-y-2">
            {cgtAlerts.map(alert => (
              <div
                key={alert.id}
                className={clsx(
                  'flex items-start gap-3 px-3 py-2 rounded-lg border text-xs',
                  alert.type === 'gain' ? 'bg-emerald-500/5 border-emerald-500/20' :
                    alert.type === 'loss' ? 'bg-red-500/5 border-red-500/20' :
                      alert.type === 'isa' ? 'bg-blue-500/5 border-blue-500/20' :
                        alert.type === 'aea-exceeded' ? 'bg-red-500/10 border-red-500/30' :
                          'bg-amber-500/5 border-amber-500/20'
                )}
              >
                <div className="mt-0.5 flex-shrink-0">
                  <AlertTypeIcon type={alert.type} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-gray-200 font-medium">{alert.message}</p>
                  {alert.detail && <p className="text-gray-500 mt-0.5">{alert.detail}</p>}
                  <p className="text-gray-600 mt-0.5">{fmtDate(alert.ts)}</p>
                </div>
                <button
                  onClick={() => dismissCGTAlert(alert.id)}
                  className="text-gray-600 hover:text-gray-400 flex-shrink-0 mt-0.5"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Real-time Monitor Status */}
      <Card>
        <p className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wide">Monitor Status — polls every 60 seconds</p>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            {t212Connected ? (
              <Wifi className="h-4 w-4 text-emerald-400" />
            ) : (
              <WifiOff className="h-4 w-4 text-gray-600" />
            )}
            <span className="text-sm text-gray-400">
              💰 Live Invest:{' '}
              {t212Connected
                ? <span className="text-emerald-400 font-medium">Connected — CGT tracked</span>
                : <span className="text-gray-600">Not connected</span>}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {t212IsaConnected ? (
              <Wifi className="h-4 w-4 text-blue-400" />
            ) : (
              <WifiOff className="h-4 w-4 text-gray-600" />
            )}
            <span className="text-sm text-gray-400">
              📈 ISA:{' '}
              {t212IsaConnected
                ? <span className="text-blue-400 font-medium">Connected — Tax Free (not in CGT calc)</span>
                : <span className="text-gray-600">Not connected</span>}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <WifiOff className="h-4 w-4 text-gray-700" />
            <span className="text-sm text-gray-600">
              🎮 Demo / Paper: <span className="text-gray-700">Never tracked — no tax implications</span>
            </span>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Clock className="h-3.5 w-3.5 text-gray-600" />
            <span className="text-xs text-gray-600">
              Last poll: {taxMonitorLastPoll ? new Date(taxMonitorLastPoll).toLocaleTimeString('en-GB') : 'Never'}
            </span>
          </div>
          <div className="text-xs text-gray-600">
            {taxMonitorLivePositions.filter(p => !p.isISA).length} invest position{taxMonitorLivePositions.filter(p => !p.isISA).length !== 1 ? 's' : ''} tracked
          </div>
        </div>
      </Card>

      {/* Disclaimer */}
      <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl px-4 py-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-400/80">
            <span className="font-semibold">Educational estimates only.</span> These figures are estimates for educational purposes.
            They do not account for all HMRC matching rules, foreign currency gains, or complex scenarios.
            Verify with HMRC guidance and consult a qualified tax adviser before filing your Self Assessment.
          </p>
        </div>
      </div>
    </div>
  );
}

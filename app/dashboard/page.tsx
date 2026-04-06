'use client';

import { useState } from 'react';
import {
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Wifi,
  WifiOff,
  ToggleLeft,
  ToggleRight,
  ArrowRight,
  Clock,
  Zap,
  ShieldCheck,
  AlertCircle,
  FlaskConical,
  Key,
  LogOut,
} from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { buildSection104Pools } from '@/lib/cgt';
import { Trade } from '@/lib/types';
import { t212Sync } from '@/lib/t212-browser';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConnectModal } from '@/components/t212/ConnectModal';
import { clsx } from 'clsx';
import Link from 'next/link';

function formatGBP(value: number) {
  return value.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
}

function StatCard({
  label,
  value,
  subtext,
  positive,
  simulated = false,
}: {
  label: string;
  value: string;
  subtext?: string;
  positive?: boolean;
  simulated?: boolean;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between mb-1">
        <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">{label}</span>
        {simulated && (
          <span className="text-xs text-yellow-600 bg-yellow-600/10 px-1.5 py-0.5 rounded text-[10px]">
            SIMULATED
          </span>
        )}
      </div>
      <div
        className={clsx(
          'text-2xl font-bold mt-1',
          positive === true ? 'text-emerald-400' : positive === false ? 'text-red-400' : 'text-white'
        )}
      >
        {value}
      </div>
      {subtext && <p className="text-xs text-gray-500 mt-1">{subtext}</p>}
    </Card>
  );
}

export default function DashboardPage() {
  const {
    t212Positions,
    t212Connected,
    t212AccountType,
    t212AccountInfo,
    t212LastSync,
    t212ApiKey,
    t212ApiSecret,
    autoReinvest,
    setAutoReinvest,
    setT212AccountType,
    setT212Connected,
    setT212LastSync,
    setT212Positions,
    clearT212Credentials,
    signals,
    trades,
    selectedCountry,
    setTrades,
    updateSection104Pools,
  } = useClearGainsStore();

  const [showConnectModal, setShowConnectModal] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncDetail, setSyncDetail] = useState<string | null>(null);

  const portfolioValue = t212Positions.reduce(
    (sum, pos) => sum + pos.currentPrice * pos.quantity,
    0
  );
  const totalPnL = t212Positions.reduce((sum, pos) => sum + pos.ppl, 0);
  const unrealisedGain = totalPnL;

  const nonIsaGain = t212Positions
    .filter((p) => !p.isISA && p.ppl > 0)
    .reduce((sum, p) => sum + p.ppl, 0);
  const cgtEstimate = Math.max(0, nonIsaGain - selectedCountry.aea) * (selectedCountry.cgRates.higher / 100);

  const hasCredentials = !!t212ApiKey && !!t212ApiSecret;

  async function handleSync() {
    if (!hasCredentials) {
      setShowConnectModal(true);
      return;
    }
    setSyncing(true);
    setSyncError(null);
    setSyncDetail(null);
    try {
      const data = await t212Sync(t212ApiKey, t212ApiSecret);
      if (!data.ok) {
        setSyncError(data.error ?? 'Sync failed');
      } else {
        setT212Positions(data.positions ?? []);
        setT212LastSync(new Date().toISOString());
        setT212Connected(true);
        if (Array.isArray(data.trades) && data.trades.length > 0) {
          const { trades: existing } = useClearGainsStore.getState();
          const existingIds = new Set(existing.map((t: Trade) => t.id));
          const newTrades = (data.trades as Trade[]).filter((t) => !existingIds.has(t.id));
          if (newTrades.length > 0) {
            const merged = [...existing, ...newTrades];
            setTrades(merged);
            updateSection104Pools(buildSection104Pools(merged));
          }
        }
      }
    } catch (err) {
      setSyncError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncing(false);
    }
  }

  function handleDisconnect() {
    clearT212Credentials();
    setSyncError(null);
    setSyncDetail(null);
  }

  const recentSignals = signals.slice(0, 3);
  const topHoldings = [...t212Positions]
    .sort((a, b) => b.currentPrice * b.quantity - a.currentPrice * a.quantity)
    .slice(0, 5);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {showConnectModal && (
        <ConnectModal
          onClose={() => setShowConnectModal(false)}
          onConnected={() => {
            setShowConnectModal(false);
            handleSync();
          }}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-sm text-gray-500">
            {selectedCountry.flag} {selectedCountry.name} · {selectedCountry.currency}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {t212Connected ? (
            <Badge variant={t212AccountType === 'LIVE' ? 'live' : 'demo'}>
              <Wifi className="h-3 w-3 mr-1" />
              {t212AccountType === 'LIVE' ? 'Live Account' : 'Practice Account'}
            </Badge>
          ) : (
            <Badge variant="default">
              <WifiOff className="h-3 w-3 mr-1" /> Not Synced
            </Badge>
          )}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Portfolio Value"
          value={t212Connected ? formatGBP(portfolioValue) : '£0.00'}
          subtext={t212Connected ? `${t212Positions.length} positions` : 'Connect T212 to view'}
          simulated={!t212Connected}
        />
        <StatCard
          label="Total P&L"
          value={t212Connected ? formatGBP(totalPnL) : '—'}
          subtext="Unrealised gain/loss"
          positive={t212Connected ? totalPnL >= 0 : undefined}
          simulated={!t212Connected}
        />
        <StatCard
          label="Unrealised Gain"
          value={t212Connected ? formatGBP(unrealisedGain) : '—'}
          subtext="Open positions"
          positive={t212Connected ? unrealisedGain >= 0 : undefined}
          simulated={!t212Connected}
        />
        <StatCard
          label="CGT Estimate"
          value={t212Connected ? formatGBP(cgtEstimate) : '—'}
          subtext={`After ${selectedCountry.currencySymbol}${selectedCountry.aea.toLocaleString()} AEA`}
          positive={false}
          simulated={!t212Connected}
        />
      </div>

      {/* Live ticker strip */}
      {topHoldings.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl mb-6 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800">
            <Zap className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Live Positions</span>
          </div>
          <div className="flex gap-6 px-4 py-3 overflow-x-auto">
            {topHoldings.map((pos) => (
              <div key={pos.ticker} className="flex-shrink-0 flex items-center gap-3">
                <div>
                  <div className="text-sm font-bold text-white">{pos.ticker}</div>
                  <div className="text-xs text-gray-500">{pos.quantity.toFixed(4)} shares</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-mono text-white">
                    {formatGBP(pos.currentPrice)}
                  </div>
                  <div
                    className={clsx(
                      'text-xs font-medium flex items-center gap-0.5',
                      pos.ppl >= 0 ? 'text-emerald-400' : 'text-red-400'
                    )}
                  >
                    {pos.ppl >= 0 ? (
                      <TrendingUp className="h-3 w-3" />
                    ) : (
                      <TrendingDown className="h-3 w-3" />
                    )}
                    {formatGBP(pos.ppl)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* T212 Sync panel */}
        <Card className="lg:col-span-1">
          <CardHeader
            title="Trading 212 Sync"
            subtitle="Connect your T212 account"
            icon={<Wifi className="h-4 w-4" />}
          />

          {/* Not connected state */}
          {!hasCredentials ? (
            <div className="py-4">
              <p className="text-xs text-gray-500 mb-3">
                Enter your T212 API key and secret to sync your portfolio. Your credentials are stored locally and never sent to our servers.
              </p>
              <Button
                onClick={() => setShowConnectModal(true)}
                fullWidth
                icon={<Key className="h-4 w-4" />}
              >
                Connect Trading 212
              </Button>
            </div>
          ) : (
            <>
              {/* Connected account info */}
              <div className="flex items-center justify-between mb-3 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                <div>
                  <p className="text-xs font-semibold text-emerald-400">
                    {t212AccountType} account connected
                  </p>
                  {t212AccountInfo && (
                    <p className="text-xs text-emerald-400/70 mt-0.5">
                      ID: {t212AccountInfo.id} · {t212AccountInfo.currency}
                    </p>
                  )}
                </div>
                <ShieldCheck className="h-4 w-4 text-emerald-400 flex-shrink-0" />
              </div>

              {/* Account type toggle */}
              <div className="flex bg-gray-800 rounded-lg p-1 mb-3">
                {(['DEMO', 'LIVE'] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => {
                      setT212AccountType(type);
                      setSyncError(null);
                      setSyncDetail(null);
                    }}
                    className={clsx(
                      'flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors',
                      t212AccountType === type
                        ? type === 'LIVE'
                          ? 'bg-emerald-600 text-white'
                          : 'bg-amber-600 text-white'
                        : 'text-gray-500 hover:text-gray-300'
                    )}
                  >
                    {type === 'LIVE' ? '🟢 LIVE' : '🟡 DEMO'}
                  </button>
                ))}
              </div>

              {/* Mode description */}
              <div className={clsx(
                'flex items-start gap-2 px-3 py-2 rounded-lg text-xs mb-3',
                t212AccountType === 'LIVE'
                  ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                  : 'bg-amber-500/10 border border-amber-500/20 text-amber-400'
              )}>
                {t212AccountType === 'LIVE'
                  ? <><ShieldCheck className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /><span>Connected to live account — real Invest &amp; ISA positions</span></>
                  : <><FlaskConical className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /><span>Practice account — simulated data only</span></>
                }
              </div>

              {/* Sync error */}
              {syncError && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs text-red-400 mb-3">
                  <div className="flex items-start gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                    <span>{syncError}</span>
                  </div>
                  {syncDetail && (
                    <div className="mt-1.5 font-mono text-[10px] text-red-500/80 break-all">
                      T212: {syncDetail}
                    </div>
                  )}
                </div>
              )}

              {/* Last synced */}
              {t212Connected && t212LastSync && (
                <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-3">
                  <Clock className="h-3 w-3" />
                  Last synced: {new Date(t212LastSync).toLocaleString('en-GB')}
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  onClick={handleDisconnect}
                  variant="outline"
                  size="sm"
                  icon={<LogOut className="h-3.5 w-3.5" />}
                >
                  Disconnect
                </Button>
                <Button
                  onClick={handleSync}
                  loading={syncing}
                  variant="secondary"
                  fullWidth
                  icon={<RefreshCw className="h-4 w-4" />}
                >
                  {t212Connected ? 'Re-sync' : 'Sync Account'}
                </Button>
              </div>
            </>
          )}
        </Card>

        {/* Auto-reinvest toggle */}
        <Card className="lg:col-span-1">
          <CardHeader
            title="Auto-Reinvestment Engine"
            subtitle="Simulate dividend reinvestment"
            icon={<RefreshCw className="h-4 w-4" />}
          />
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm text-gray-300">Auto-Reinvest Dividends</p>
              <p className="text-xs text-gray-600 mt-0.5">
                Automatically reinvest dividends into the same position
              </p>
            </div>
            <button
              onClick={() => setAutoReinvest(!autoReinvest)}
              className={clsx(
                'flex-shrink-0 transition-colors',
                autoReinvest ? 'text-emerald-400' : 'text-gray-600'
              )}
            >
              {autoReinvest ? (
                <ToggleRight className="h-8 w-8" />
              ) : (
                <ToggleLeft className="h-8 w-8" />
              )}
            </button>
          </div>
          <div
            className={clsx(
              'mt-3 px-3 py-2 rounded-lg text-xs',
              autoReinvest
                ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                : 'bg-gray-800 text-gray-500'
            )}
          >
            {autoReinvest
              ? 'Auto-reinvestment is ACTIVE. Dividends will be added to your positions.'
              : 'Auto-reinvestment is OFF. Dividends will accumulate as cash.'}
          </div>
          <p className="text-xs text-yellow-600/70 mt-2">
            ⚠ Simulation only — not connected to live trading
          </p>
        </Card>

        {/* Recent signals */}
        <Card className="lg:col-span-1">
          <CardHeader
            title="Recent AI Signals"
            subtitle="Latest scanner results"
            icon={<Zap className="h-4 w-4" />}
            action={
              <Link href="/scanner" className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
                View all <ArrowRight className="h-3 w-3" />
              </Link>
            }
          />
          {recentSignals.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-gray-600">No signals yet.</p>
              <Link href="/scanner" className="text-xs text-blue-400 hover:text-blue-300 mt-1 inline-block">
                Run AI Scanner →
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {recentSignals.map((signal, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
                  <div>
                    <div className="font-semibold text-white text-sm">{signal.ticker}</div>
                    <div className="text-xs text-gray-500">
                      Risk: {signal.riskScore}/100 · {signal.confidence}% confidence
                    </div>
                  </div>
                  <Badge variant={signal.signal.toLowerCase() as 'buy' | 'sell' | 'hold'}>
                    {signal.signal}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Portfolio holdings table */}
      {t212Positions.length > 0 && (
        <Card className="mt-4">
          <CardHeader
            title="Portfolio Holdings"
            subtitle={`${t212Positions.length} positions · ${t212AccountType} account`}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-800">
                  <th className="text-left py-2 pr-4">Ticker</th>
                  <th className="text-right py-2 pr-4">Qty</th>
                  <th className="text-right py-2 pr-4">Avg Price</th>
                  <th className="text-right py-2 pr-4">Current</th>
                  <th className="text-right py-2 pr-4">P&L</th>
                  <th className="text-right py-2">ISA</th>
                </tr>
              </thead>
              <tbody>
                {t212Positions.map((pos) => (
                  <tr key={pos.ticker} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="py-2 pr-4 font-semibold text-white">{pos.ticker}</td>
                    <td className="py-2 pr-4 text-right text-gray-300 font-mono text-xs">
                      {pos.quantity.toFixed(4)}
                    </td>
                    <td className="py-2 pr-4 text-right text-gray-300 font-mono text-xs">
                      {formatGBP(pos.averagePrice)}
                    </td>
                    <td className="py-2 pr-4 text-right text-gray-300 font-mono text-xs">
                      {formatGBP(pos.currentPrice)}
                    </td>
                    <td className={clsx('py-2 pr-4 text-right font-mono text-xs', pos.ppl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {formatGBP(pos.ppl)}
                    </td>
                    <td className="py-2 text-right">
                      {pos.isISA && <Badge variant="isa">ISA</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Quick actions */}
      {!t212Connected && trades.length === 0 && (
        <Card className="mt-4">
          <div className="text-center py-6">
            <TrendingUp className="h-10 w-10 text-emerald-600 mx-auto mb-3" />
            <h3 className="text-lg font-semibold text-white mb-2">Get Started with ClearGains</h3>
            <p className="text-sm text-gray-400 mb-4 max-w-md mx-auto">
              Connect your Trading 212 account or add trades manually to track your portfolio,
              calculate CGT, and get AI-powered signals.
            </p>
            <div className="flex flex-wrap gap-3 justify-center">
              <Button onClick={() => setShowConnectModal(true)} icon={<Key className="h-4 w-4" />}>
                Connect T212
              </Button>
              <Link href="/ledger">
                <Button variant="secondary">Add Manual Trade</Button>
              </Link>
              <Link href="/scanner">
                <Button variant="outline">Run AI Scanner</Button>
              </Link>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

'use client';

import { useState } from 'react';
import {
  FileText, TrendingUp, TrendingDown, CheckCircle2, XCircle,
  AlertTriangle, Minus, RefreshCw, Trash2, Download,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useClearGainsStore } from '@/lib/store';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import type { TradeLogEntry } from '@/lib/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtPrice(n?: number) {
  if (n == null) return '—';
  return n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function fmtPnL(n?: number) {
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}£${Math.abs(n).toFixed(2)}`;
}

const ACTION_CONFIG: Record<string, { label: string; color: string; icon: React.ComponentType<{ className?: string }> }> = {
  OPEN_LONG:       { label: 'Long',    color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', icon: TrendingUp },
  OPEN_SHORT:      { label: 'Short',   color: 'bg-red-500/20 text-red-400 border-red-500/30',             icon: TrendingDown },
  CLOSE:           { label: 'Close',   color: 'bg-blue-500/20 text-blue-400 border-blue-500/30',          icon: CheckCircle2 },
  SKIP:            { label: 'Skip',    color: 'bg-gray-700/60 text-gray-400 border-gray-600',             icon: Minus },
  CIRCUIT_BREAKER: { label: 'CB',      color: 'bg-amber-500/20 text-amber-400 border-amber-500/30',       icon: AlertTriangle },
  ERROR:           { label: 'Error',   color: 'bg-red-500/20 text-red-400 border-red-500/30',             icon: XCircle },
  SESSION:         { label: 'System',  color: 'bg-gray-700/60 text-gray-500 border-gray-600',             icon: RefreshCw },
};

function ActionCell({ action }: { action: TradeLogEntry['action'] }) {
  const cfg = ACTION_CONFIG[action] ?? ACTION_CONFIG.SESSION;
  const Icon = cfg.icon;
  return (
    <span className={clsx('inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border', cfg.color)}>
      <Icon className="h-2.5 w-2.5" />
      {cfg.label}
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TradeLogPage() {
  const {
    autoTraderLog, autoTraderDailyPnL, autoTraderTotalPnL,
    autoTraderWins, autoTraderLosses, autoTraderEnv,
    clearAutoTradeLog,
  } = useClearGainsStore();

  const [filterAction, setFilterAction] = useState<string>('ALL');
  const [filterEnv, setFilterEnv] = useState<string>('ALL');
  const [filterSymbol, setFilterSymbol] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  const totalTrades = autoTraderWins + autoTraderLosses;
  const winRate = totalTrades > 0 ? Math.round((autoTraderWins / totalTrades) * 100) : null;

  const filtered = autoTraderLog.filter(e => {
    if (filterAction !== 'ALL' && e.action !== filterAction) return false;
    if (filterEnv !== 'ALL' && e.env !== filterEnv) return false;
    if (filterSymbol && !e.symbol.toLowerCase().includes(filterSymbol.toLowerCase())) return false;
    return true;
  });

  function exportCSV() {
    const rows = [
      ['Time', 'Action', 'Symbol', 'Instrument', 'Dir', 'Size', 'Entry', 'Stop', 'TP', 'P&L', 'Signal', 'Score', 'Env', 'DealId', 'Reason'],
      ...filtered.map(e => [
        fmtTime(e.ts), e.action, e.symbol, e.instrumentName ?? '',
        e.direction ?? '', e.size?.toString() ?? '',
        e.entryPrice?.toFixed(4) ?? '', e.stopLevel?.toFixed(4) ?? '', e.limitLevel?.toFixed(4) ?? '',
        e.closePnL?.toFixed(2) ?? '', e.signal ?? '', e.score?.toString() ?? '',
        e.env, e.dealId ?? '', e.reason,
      ]),
    ];
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trade-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="max-w-screen-2xl mx-auto px-4 py-6 space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-baseline gap-3">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-orange-400" />
            <h1 className="text-xl font-bold text-white">Trade Log</h1>
          </div>
          <span className="text-xs text-gray-500">All auto-trader decisions — {autoTraderLog.length} entries</span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" icon={<Download className="h-3.5 w-3.5" />} onClick={exportCSV}
            disabled={filtered.length === 0}>
            Export CSV
          </Button>
          {!confirmClear ? (
            <Button size="sm" variant="outline" icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => setConfirmClear(true)} disabled={autoTraderLog.length === 0}
              className="border-red-500/30 text-red-400 hover:border-red-500/60">
              Clear Log
            </Button>
          ) : (
            <div className="flex items-center gap-1">
              <Button size="sm" onClick={() => { clearAutoTradeLog(); setConfirmClear(false); }}
                className="bg-red-600 text-white border-red-500 hover:bg-red-500">
                Confirm Clear
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmClear(false)}>Cancel</Button>
            </div>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: 'Daily P&L',  value: fmtPnL(autoTraderDailyPnL),  hl: autoTraderDailyPnL > 0 ? 'pos' : autoTraderDailyPnL < 0 ? 'neg' : 'neu' },
          { label: 'Total P&L',  value: fmtPnL(autoTraderTotalPnL),  hl: autoTraderTotalPnL > 0 ? 'pos' : autoTraderTotalPnL < 0 ? 'neg' : 'neu' },
          { label: 'Win Rate',   value: winRate !== null ? `${winRate}%` : '—', hl: winRate !== null && winRate >= 50 ? 'pos' : 'neu' },
          { label: 'Wins',       value: autoTraderWins.toString(),    hl: 'pos' },
          { label: 'Losses',     value: autoTraderLosses.toString(),  hl: autoTraderLosses > 0 ? 'neg' : 'neu' },
          { label: 'Total Log',  value: autoTraderLog.length.toString(), hl: 'neu' },
        ].map(s => (
          <Card key={s.label} className="p-3">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-1">{s.label}</p>
            <p className={clsx('text-lg font-bold tabular-nums',
              s.hl === 'pos' ? 'text-emerald-400' : s.hl === 'neg' ? 'text-red-400' : 'text-white'
            )}>{s.value}</p>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          placeholder="Filter by symbol…"
          value={filterSymbol}
          onChange={e => setFilterSymbol(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-orange-500 w-36"
        />

        <div className="flex items-center gap-1 bg-gray-800/50 rounded-lg p-0.5">
          {['ALL', 'OPEN_LONG', 'OPEN_SHORT', 'CLOSE', 'SKIP', 'ERROR', 'CIRCUIT_BREAKER'].map(a => (
            <button key={a}
              onClick={() => setFilterAction(a)}
              className={clsx('px-2.5 py-1 rounded-md text-[10px] font-medium transition-all',
                filterAction === a ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
              )}>
              {a === 'ALL' ? 'All' : a === 'OPEN_LONG' ? 'Long' : a === 'OPEN_SHORT' ? 'Short'
                : a === 'CIRCUIT_BREAKER' ? 'CB' : a.charAt(0) + a.slice(1).toLowerCase()}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 bg-gray-800/50 rounded-lg p-0.5">
          {['ALL', 'demo', 'live'].map(e => (
            <button key={e}
              onClick={() => setFilterEnv(e)}
              className={clsx('px-2.5 py-1 rounded-md text-[10px] font-medium transition-all',
                filterEnv === e ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
              )}>
              {e === 'ALL' ? 'All Envs' : e.toUpperCase()}
            </button>
          ))}
        </div>

        <span className="text-[10px] text-gray-600 ml-auto">{filtered.length} entries shown</span>
      </div>

      {/* Table */}
      <Card className="overflow-hidden p-0">
        {filtered.length === 0 ? (
          <div className="py-16 text-center space-y-2">
            <FileText className="h-8 w-8 text-gray-700 mx-auto" />
            <p className="text-sm text-gray-500">No log entries{filterAction !== 'ALL' || filterSymbol ? ' matching filters' : ''}</p>
            <p className="text-xs text-gray-600">Start the engine on the Auto Trader page to generate entries</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/50">
                  {['Time', 'Action', 'Symbol', 'Dir', 'Size', 'Entry', 'Stop', 'TP', 'P&L', 'Signal', 'Score', 'Env', 'Reason'].map(h => (
                    <th key={h} className="px-3 py-2 text-[10px] text-gray-500 font-medium uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(e => (
                  <tr key={e.id} className={clsx('border-t border-gray-800/60 hover:bg-gray-800/20 transition-colors text-xs',
                    e.action === 'OPEN_LONG' && 'bg-emerald-500/2',
                    e.action === 'OPEN_SHORT' && 'bg-red-500/2',
                    e.action === 'CIRCUIT_BREAKER' && 'bg-amber-500/5',
                    e.action === 'ERROR' && 'bg-red-500/5',
                  )}>
                    <td className="px-3 py-2 text-[10px] text-gray-500 whitespace-nowrap">{fmtTime(e.ts)}</td>
                    <td className="px-3 py-2"><ActionCell action={e.action} /></td>
                    <td className="px-3 py-2">
                      <p className="font-semibold text-white">{e.symbol === '-' ? '—' : e.symbol}</p>
                      {e.instrumentName && <p className="text-[9px] text-gray-600 truncate max-w-[120px]">{e.instrumentName}</p>}
                    </td>
                    <td className="px-3 py-2">
                      {e.direction && (
                        <span className={clsx('text-[9px] font-bold px-1 py-0.5 rounded',
                          e.direction === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                        )}>{e.direction}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-gray-300">{e.size != null ? `£${e.size}/pt` : '—'}</td>
                    <td className="px-3 py-2 tabular-nums text-gray-300">{fmtPrice(e.entryPrice)}</td>
                    <td className="px-3 py-2 tabular-nums text-red-400/80">{fmtPrice(e.stopLevel)}</td>
                    <td className="px-3 py-2 tabular-nums text-emerald-400/80">{fmtPrice(e.limitLevel)}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {e.closePnL != null ? (
                        <span className={clsx('font-semibold', e.closePnL >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {fmtPnL(e.closePnL)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 text-[9px] font-mono text-gray-500">{e.signal ?? '—'}</td>
                    <td className="px-3 py-2 tabular-nums text-gray-500">{e.score ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span className={clsx('text-[9px] font-bold px-1 py-0.5 rounded border',
                        e.env === 'live'
                          ? 'bg-red-500/15 text-red-400 border-red-500/20'
                          : 'bg-orange-500/15 text-orange-400 border-orange-500/20'
                      )}>{e.env.toUpperCase()}</span>
                    </td>
                    <td className="px-3 py-2 text-[10px] text-gray-500 max-w-[200px]">
                      <span className="truncate block" title={e.reason}>{e.reason}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-[10px] text-gray-700 text-center">
        Trade log is stored locally in your browser. Export CSV to keep a permanent record.
        P&L figures for closed trades require manual reconciliation with IG account history.
      </p>
    </div>
  );
}

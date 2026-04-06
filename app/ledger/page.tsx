'use client';

import { useState } from 'react';
import {
  BookOpen,
  Plus,
  Trash2,
  RefreshCw,
  Download,
  Upload,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { buildSection104Pools } from '@/lib/cgt';
import { Trade } from '@/lib/types';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { clsx } from 'clsx';

function generateId() {
  return `trade-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function formatGBP(v: number) {
  return v.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
}

const EMPTY_FORM = {
  ticker: '',
  type: 'BUY' as 'BUY' | 'SELL',
  quantity: '',
  price: '',
  date: new Date().toISOString().slice(0, 10),
  fees: '0',
  currency: 'GBP',
  isISA: false,
};

export default function LedgerPage() {
  const { trades, addTrade, removeTrade, setTrades, updateSection104Pools, t212ApiKey, t212ApiSecret } =
    useClearGainsStore();

  const [form, setForm] = useState(EMPTY_FORM);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importCount, setImportCount] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  function handleAdd() {
    setFormError(null);
    if (!form.ticker.trim()) return setFormError('Ticker is required');
    if (!form.quantity || parseFloat(form.quantity) <= 0)
      return setFormError('Quantity must be positive');
    if (!form.price || parseFloat(form.price) <= 0)
      return setFormError('Price must be positive');
    if (!form.date) return setFormError('Date is required');

    const qty = parseFloat(form.quantity);
    const price = parseFloat(form.price);
    const fees = parseFloat(form.fees) || 0;

    const trade: Trade = {
      id: generateId(),
      ticker: form.ticker.toUpperCase().trim(),
      type: form.type,
      quantity: qty,
      price,
      currency: form.currency,
      gbpValue: qty * price,
      date: new Date(form.date).toISOString(),
      fees,
      isISA: form.isISA,
      source: 'manual',
    };

    addTrade(trade);
    const allTrades = [...trades, trade];
    updateSection104Pools(buildSection104Pools(allTrades));
    setForm(EMPTY_FORM);
  }

  async function handleImportFromT212() {
    setImporting(true);
    setImportError(null);
    setImportCount(null);

    try {
      const res = await fetch('/api/t212/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: t212ApiKey, apiSecret: t212ApiSecret, limit: 200 }),
      });
      const data = await res.json();
      if (data.error) {
        setImportError(data.error);
        return;
      }
      const imported: Trade[] = data.trades ?? [];
      // Merge — skip duplicates by id
      const existingIds = new Set(trades.map((t) => t.id));
      const newTrades = imported.filter((t) => !existingIds.has(t.id));
      const merged = [...trades, ...newTrades];
      setTrades(merged);
      updateSection104Pools(buildSection104Pools(merged));
      setImportCount(newTrades.length);
    } catch (err) {
      setImportError(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
    }
  }

  function handleRemove(id: string) {
    const updated = trades.filter((t) => t.id !== id);
    setTrades(updated);
    updateSection104Pools(buildSection104Pools(updated));
  }

  const sortedTrades = [...trades].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  const totalBuys = trades.filter((t) => t.type === 'BUY').reduce((s, t) => s + t.gbpValue, 0);
  const totalSells = trades.filter((t) => t.type === 'SELL').reduce((s, t) => s + t.gbpValue, 0);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <BookOpen className="h-6 w-6 text-emerald-400" />
            Trade Ledger
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Record your trades to enable CGT calculations
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<Upload className="h-3.5 w-3.5" />}
            onClick={handleImportFromT212}
            loading={importing}
          >
            Import T212
          </Button>
        </div>
      </div>

      {importError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-4 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {importError}
        </div>
      )}
      {importCount !== null && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3 mb-4 text-sm text-emerald-400">
          {importCount === 0
            ? 'No new trades found — ledger is already up to date'
            : `Successfully imported ${importCount} new trade${importCount !== 1 ? 's' : ''} from Trading 212`}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Total Trades', value: trades.length.toString() },
          { label: 'Total Bought', value: formatGBP(totalBuys) },
          { label: 'Total Sold', value: formatGBP(totalSells) },
          { label: 'Net Deployed', value: formatGBP(totalBuys - totalSells) },
        ].map(({ label, value }) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl p-3">
            <div className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1">{label}</div>
            <div className="text-lg font-bold text-white font-mono">{value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Add trade form */}
        <Card className="lg:col-span-1">
          <CardHeader
            title="Add Trade"
            subtitle="Manually record a transaction"
            icon={<Plus className="h-4 w-4" />}
          />

          {formError && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400 mb-3">
              {formError}
            </div>
          )}

          <div className="space-y-3">
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">Ticker</label>
                <input
                  type="text"
                  value={form.ticker}
                  onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })}
                  placeholder="e.g. AAPL"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>
              <div className="w-24">
                <label className="block text-xs text-gray-500 mb-1">Type</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as 'BUY' | 'SELL' })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                >
                  <option value="BUY">BUY</option>
                  <option value="SELL">SELL</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Quantity</label>
                <input
                  type="number"
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                  placeholder="0.00"
                  min="0"
                  step="any"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Price (GBP)</label>
                <input
                  type="number"
                  value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                  placeholder="0.00"
                  min="0"
                  step="any"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Date</label>
                <input
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Fees (£)</label>
                <input
                  type="number"
                  value={form.fees}
                  onChange={(e) => setForm({ ...form, fees: e.target.value })}
                  placeholder="0.00"
                  min="0"
                  step="any"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>
            </div>

            {/* ISA toggle */}
            <div className="flex items-center justify-between bg-gray-800/50 rounded-lg px-3 py-2">
              <div>
                <div className="text-sm text-gray-300">ISA Wrapper</div>
                <div className="text-xs text-gray-600">Exempt from CGT</div>
              </div>
              <button
                onClick={() => setForm({ ...form, isISA: !form.isISA })}
                className={clsx(
                  'w-10 h-5 rounded-full transition-colors relative',
                  form.isISA ? 'bg-blue-500' : 'bg-gray-600'
                )}
              >
                <div
                  className={clsx(
                    'absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow',
                    form.isISA ? 'translate-x-5' : 'translate-x-0.5'
                  )}
                />
              </button>
            </div>

            {/* Preview */}
            {form.quantity && form.price && (
              <div className="text-xs text-gray-500 bg-gray-800 rounded-lg px-3 py-2">
                GBP value: <span className="text-white font-mono">
                  {formatGBP(parseFloat(form.quantity) * parseFloat(form.price))}
                </span>
              </div>
            )}

            <Button onClick={handleAdd} fullWidth icon={<Plus className="h-4 w-4" />}>
              Add Trade
            </Button>
          </div>
        </Card>

        {/* Trade list */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Trade History"
            subtitle={`${trades.length} transactions`}
            icon={<Download className="h-4 w-4" />}
          />

          {sortedTrades.length === 0 ? (
            <div className="py-12 text-center">
              <BookOpen className="h-10 w-10 text-gray-700 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No trades yet</p>
              <p className="text-xs text-gray-600 mt-1">
                Add manually or import from Trading 212
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 border-b border-gray-800">
                    <th className="text-left py-2 pr-3">Date</th>
                    <th className="text-left py-2 pr-3">Ticker</th>
                    <th className="text-center py-2 pr-3">Type</th>
                    <th className="text-right py-2 pr-3">Qty</th>
                    <th className="text-right py-2 pr-3">Price</th>
                    <th className="text-right py-2 pr-3">Value</th>
                    <th className="text-center py-2 pr-3">ISA</th>
                    <th className="text-center py-2 pr-3">Src</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTrades.map((trade) => (
                    <tr
                      key={trade.id}
                      className="border-b border-gray-800/50 hover:bg-gray-800/20 text-xs"
                    >
                      <td className="py-2 pr-3 text-gray-500">
                        {new Date(trade.date).toLocaleDateString('en-GB')}
                      </td>
                      <td className="py-2 pr-3 font-semibold text-white font-mono">
                        {trade.ticker}
                      </td>
                      <td className="py-2 pr-3 text-center">
                        <Badge variant={trade.type === 'BUY' ? 'buy' : 'sell'}>
                          {trade.type}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-gray-300">
                        {trade.quantity.toFixed(4)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-gray-300">
                        {formatGBP(trade.price)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-gray-300">
                        {formatGBP(trade.gbpValue)}
                      </td>
                      <td className="py-2 pr-3 text-center">
                        {trade.isISA && (
                          <ShieldCheck className="h-3.5 w-3.5 text-blue-400 mx-auto" />
                        )}
                      </td>
                      <td className="py-2 pr-3 text-center">
                        <Badge variant={trade.source === 't212' ? 't212' : 'manual'}>
                          {trade.source}
                        </Badge>
                      </td>
                      <td className="py-2">
                        <button
                          onClick={() => handleRemove(trade.id)}
                          className="p-1 text-gray-600 hover:text-red-400 transition-colors rounded"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

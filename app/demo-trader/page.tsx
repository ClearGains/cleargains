'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FlaskConical, Play, RefreshCw, AlertTriangle, TrendingUp, TrendingDown,
  X, CheckCircle2, AlertCircle, Eye, EyeOff, ArrowRight, Clock,
  Target, Shield, BarChart3, Trophy, Copy,
} from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { DemoPosition, DemoTrade } from '@/lib/types';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { clsx } from 'clsx';

const SECTORS = ['All', 'Technology', 'Healthcare', 'Energy', 'Finance', 'Consumer'] as const;
type Sector = typeof SECTORS[number];

function fmt(n: number) {
  return n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 2 });
}
function fmtPct(n: number) { return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function uid() { return Math.random().toString(36).slice(2, 10); }
function hoursAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m ago` : `${m}m ago`;
}

// ─── SIGNAL TYPE ─────────────────────────────────────────────────────────────
type Signal = {
  symbol: string;
  name: string;
  t212Ticker: string;
  sector: string;
  score: number;
  currentPrice: number;
  changePercent: number;
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  reason: string;
};

// ─── COPY TO LIVE MODAL ───────────────────────────────────────────────────────
function CopyToLiveModal({
  trade,
  liveEncoded,
  onClose,
  onDone,
}: {
  trade: DemoTrade;
  liveEncoded: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const quantity = Math.max(1, Math.round(trade.quantity));

  async function handleCopy() {
    setConfirming(true);
    try {
      const res = await fetch('/api/t212/live-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-t212-auth': liveEncoded },
        body: JSON.stringify({ ticker: trade.t212Ticker, quantity }),
      });
      const data = await res.json();
      if (data.ok) {
        setResult({ ok: true, message: `Live order placed! Order ID: ${data.orderId ?? 'pending'}` });
        setTimeout(onDone, 2000);
      } else {
        setResult({ ok: false, message: data.error ?? 'Order failed.' });
      }
    } catch (err) {
      setResult({ ok: false, message: `Request failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md shadow-2xl p-6">
        <button onClick={onClose} className="absolute right-4 top-4 text-gray-500 hover:text-gray-300"><X className="h-5 w-5" /></button>

        <div className="flex items-center gap-2 mb-4">
          <Copy className="h-5 w-5 text-emerald-400" />
          <h2 className="text-lg font-semibold text-white">Copy Trade to Live Account</h2>
        </div>

        <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3 mb-4 text-xs text-amber-300">
          <strong className="block mb-1">⚠ YOU are making this decision.</strong>
          This is not automated financial advice. Past demo performance does not guarantee live results. Market orders execute at the current live price, which may differ from the demo exit price.
        </div>

        <div className="bg-gray-800/50 rounded-lg p-4 mb-4 space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-gray-400">Stock</span><span className="text-white font-semibold">{trade.ticker} · {trade.companyName}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Order type</span><span className="text-white">Market BUY</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Quantity</span><span className="text-white font-mono">{quantity} shares</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Demo entry</span><span className="text-gray-300 font-mono">{fmt(trade.entryPrice)}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Demo P&L</span><span className={clsx('font-semibold font-mono', trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>{fmt(trade.pnl)} ({fmtPct(trade.pnlPct)})</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Account</span><span className="text-emerald-400 font-semibold">🟢 LIVE T212 account</span></div>
        </div>

        {result ? (
          <div className={clsx('flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs mb-3', result.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/30 text-red-400')}>
            {result.ok ? <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /> : <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />}
            {result.message}
          </div>
        ) : (
          <Button onClick={handleCopy} loading={confirming} fullWidth icon={<Copy className="h-4 w-4" />}>
            Confirm — Place Live Market Order
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
export default function DemoTraderPage() {
  const {
    t212DemoApiKey, t212DemoApiSecret,
    t212ApiKey, t212ApiSecret,
    setT212DemoCredentials,
    demoPositions, demoTrades,
    addDemoPosition, removeDemoPosition, updateDemoPosition, addDemoTrade,
  } = useClearGainsStore();

  const [demoKey, setDemoKey] = useState(t212DemoApiKey);
  const [demoSecret, setDemoSecret] = useState(t212DemoApiSecret);
  const [showKey, setShowKey] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [credsSaved, setCredsSaved] = useState(!!t212DemoApiKey);

  const [maxRisk, setMaxRisk] = useState(500);
  const [sectors, setSectors] = useState<Sector[]>(['Technology']);

  const [signals, setSignals] = useState<Signal[]>([]);
  const [scanning, setScanning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [runLog, setRunLog] = useState<string[]>([]);

  const [copyTrade, setCopyTrade] = useState<DemoTrade | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Save demo credentials ──
  function saveCredentials() {
    const k = demoKey.replace(/[\s\n\r\t]/g, '');
    const s = demoSecret.replace(/[\s\n\r\t]/g, '');
    if (!k || !s) return;
    setT212DemoCredentials(k, s);
    setCredsSaved(true);
  }

  // ── Background price check (every 5 min) ──
  const checkPositions = useCallback(async () => {
    if (demoPositions.length === 0) return;
    const apiKey = process.env.NEXT_PUBLIC_FINNHUB_API_KEY ?? '';
    if (!apiKey) return;

    for (const pos of demoPositions) {
      try {
        const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${pos.ticker}&token=${apiKey}`);
        if (!res.ok) continue;
        const quote = await res.json() as { c: number };
        const currentPrice = quote.c;
        if (!currentPrice || currentPrice <= 0) continue;

        const pnl = (currentPrice - pos.entryPrice) * pos.quantity;
        const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

        updateDemoPosition(pos.id, { currentPrice, pnl, pnlPct });

        // Check stop-loss and take-profit
        if (currentPrice <= pos.stopLoss || currentPrice >= pos.takeProfit) {
          const reason: DemoTrade['closeReason'] = currentPrice <= pos.stopLoss ? 'stop-loss' : 'take-profit';
          const closedTrade: DemoTrade = {
            id: uid(),
            ticker: pos.ticker,
            t212Ticker: pos.t212Ticker,
            companyName: pos.companyName,
            sector: pos.sector,
            quantity: pos.quantity,
            entryPrice: pos.entryPrice,
            exitPrice: currentPrice,
            pnl,
            pnlPct,
            openedAt: pos.openedAt,
            closedAt: new Date().toISOString(),
            closeReason: reason,
          };
          removeDemoPosition(pos.id);
          addDemoTrade(closedTrade);
        }
      } catch {
        // Ignore price check errors
      }
    }
  }, [demoPositions, updateDemoPosition, removeDemoPosition, addDemoTrade]);

  useEffect(() => {
    intervalRef.current = setInterval(checkPositions, 5 * 60 * 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [checkPositions]);

  // ── Run strategy ──
  async function runStrategy() {
    if (!credsSaved) { setScanError('Save demo credentials first.'); return; }
    setScanning(true);
    setScanError(null);
    setRunLog([]);

    try {
      const selectedSectors = sectors.includes('All') ? ['All'] : sectors;
      setRunLog(l => [...l, `Scanning ${selectedSectors.join(', ')} sectors via Finnhub...`]);

      const sigRes = await fetch('/api/demo-trader/signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectors: selectedSectors }),
      });
      const sigData = await sigRes.json() as { signals?: Signal[]; error?: string; scannedCount?: number };

      if (sigData.error) { setScanError(sigData.error); return; }

      const allSignals = sigData.signals ?? [];
      setSignals(allSignals);
      setRunLog(l => [...l, `Scanned ${sigData.scannedCount ?? 0} stocks. Found ${allSignals.length} signals.`]);

      // Top 3 BUY signals
      const buys = allSignals.filter(s => s.signal === 'BUY').slice(0, 3);
      if (buys.length === 0) {
        setRunLog(l => [...l, 'No strong BUY signals found. Strategy not executed.']);
        return;
      }

      setExecuting(true);
      setRunLog(l => [...l, `Executing ${buys.length} trade(s) on T212 DEMO account...`]);

      const demoEncoded = btoa(t212DemoApiKey + ':' + t212DemoApiSecret);

      for (const signal of buys) {
        const quantity = Math.max(1, Math.floor(maxRisk / signal.currentPrice));
        setRunLog(l => [...l, `→ Buying ${quantity}× ${signal.symbol} @ ~$${signal.currentPrice.toFixed(2)}`]);

        try {
          const orderRes = await fetch('/api/t212/demo-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-t212-auth': demoEncoded },
            body: JSON.stringify({ ticker: signal.t212Ticker, quantity }),
          });
          const orderData = await orderRes.json();

          const fillPrice = orderData.fillPrice ?? signal.currentPrice;

          const position: DemoPosition = {
            id: uid(),
            ticker: signal.symbol,
            t212Ticker: signal.t212Ticker,
            companyName: signal.name,
            sector: signal.sector,
            quantity,
            entryPrice: fillPrice,
            currentPrice: fillPrice,
            stopLoss: fillPrice * 0.98,
            takeProfit: fillPrice * 1.04,
            pnl: 0,
            pnlPct: 0,
            openedAt: new Date().toISOString(),
            signal: signal.reason,
          };

          addDemoPosition(position);

          if (orderData.ok) {
            setRunLog(l => [...l, `  ✓ Order placed for ${signal.symbol}. SL: $${(fillPrice * 0.98).toFixed(2)} TP: $${(fillPrice * 1.04).toFixed(2)}`]);
          } else {
            setRunLog(l => [...l, `  ⚠ T212 order failed (${orderData.error}) — position tracked locally only`]);
          }
        } catch (err) {
          setRunLog(l => [...l, `  ✗ Failed to execute ${signal.symbol}: ${err instanceof Error ? err.message : String(err)}`]);
        }
      }

      setRunLog(l => [...l, 'Strategy run complete.']);
    } finally {
      setScanning(false);
      setExecuting(false);
    }
  }

  // ── Manual close ──
  function closePosition(pos: DemoPosition) {
    const closedTrade: DemoTrade = {
      id: uid(),
      ticker: pos.ticker,
      t212Ticker: pos.t212Ticker,
      companyName: pos.companyName,
      sector: pos.sector,
      quantity: pos.quantity,
      entryPrice: pos.entryPrice,
      exitPrice: pos.currentPrice,
      pnl: pos.pnl,
      pnlPct: pos.pnlPct,
      openedAt: pos.openedAt,
      closedAt: new Date().toISOString(),
      closeReason: 'manual',
    };
    removeDemoPosition(pos.id);
    addDemoTrade(closedTrade);
  }

  // ── Performance stats ──
  const closedTrades = demoTrades;
  const totalPnL = closedTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = closedTrades.filter(t => t.pnl > 0);
  const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;
  const bestTrade = closedTrades.reduce((best, t) => t.pnl > (best?.pnl ?? -Infinity) ? t : best, null as DemoTrade | null);
  const worstTrade = closedTrades.reduce((worst, t) => t.pnl < (worst?.pnl ?? Infinity) ? t : worst, null as DemoTrade | null);

  // ── Copy-to-live: profitable closed trades from last 7 days ──
  const sevenDaysAgo = Date.now() - 7 * 86_400_000;
  const profitableTrades = closedTrades.filter(t => t.pnl > 0 && new Date(t.closedAt).getTime() > sevenDaysAgo);

  const liveEncoded = t212ApiKey && t212ApiSecret ? btoa(t212ApiKey + ':' + t212ApiSecret) : '';

  function toggleSector(s: Sector) {
    if (s === 'All') { setSectors(['All']); return; }
    setSectors(prev => {
      const without = prev.filter(x => x !== 'All');
      return without.includes(s) ? without.filter(x => x !== s) || ['Technology'] : [...without.filter(x => x !== s), s];
    });
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {copyTrade && liveEncoded && (
        <CopyToLiveModal
          trade={copyTrade}
          liveEncoded={liveEncoded}
          onClose={() => setCopyTrade(null)}
          onDone={() => setCopyTrade(null)}
        />
      )}

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <FlaskConical className="h-6 w-6 text-amber-400" />
          Demo Auto-Trader
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Automated strategy on your T212 DEMO account only · Educational simulation · Not financial advice
        </p>
      </div>

      {/* Disclaimer */}
      <div className="mb-6 flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
        <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-amber-200/80">
          <strong className="text-amber-300">Demo account only.</strong> This tool only executes trades on your T212 DEMO (practice) account. It never touches your live account unless you explicitly use the "Copy to Live" feature and manually confirm each trade. Past simulated performance does not indicate future real results.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: controls */}
        <div className="space-y-4">
          {/* Demo credentials */}
          <Card>
            <CardHeader title="Demo API Credentials" subtitle="T212 demo account key" icon={<Shield className="h-4 w-4" />} />
            {credsSaved ? (
              <div className="flex items-center justify-between px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg mb-3">
                <span className="text-xs text-amber-400 font-semibold">🟡 Demo credentials saved</span>
                <button onClick={() => setCredsSaved(false)} className="text-xs text-gray-500 hover:text-gray-300">Edit</button>
              </div>
            ) : (
              <div className="space-y-3 mb-3">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Demo API Key</label>
                  <div className="relative">
                    <input type={showKey ? 'text' : 'password'} value={demoKey} onChange={e => setDemoKey(e.target.value)}
                      placeholder="Demo API key" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500 pr-10" />
                    <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Demo API Secret</label>
                  <div className="relative">
                    <input type={showSecret ? 'text' : 'password'} value={demoSecret} onChange={e => setDemoSecret(e.target.value)}
                      placeholder="Demo API secret" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-amber-500 pr-10" />
                    <button type="button" onClick={() => setShowSecret(!showSecret)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                      {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <Button onClick={saveCredentials} size="sm" fullWidth>Save Demo Credentials</Button>
                <p className="text-[11px] text-gray-600">Generate a separate demo API key in T212 Demo account → Settings → API</p>
              </div>
            )}
          </Card>

          {/* Strategy config */}
          <Card>
            <CardHeader title="Strategy Settings" subtitle="Configure risk and sectors" icon={<Target className="h-4 w-4" />} />
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Max Risk Per Trade</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">£</span>
                  <input type="number" min={10} max={10000} value={maxRisk} onChange={e => setMaxRisk(Number(e.target.value))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500" />
                </div>
                <p className="text-[11px] text-gray-600 mt-1">Quantity = floor(£{maxRisk} ÷ current price)</p>
              </div>

              <div>
                <label className="text-xs text-gray-400 mb-2 block">Sectors</label>
                <div className="flex flex-wrap gap-1.5">
                  {SECTORS.map(s => (
                    <button key={s} onClick={() => toggleSector(s)}
                      className={clsx('px-2.5 py-1 rounded-lg text-xs font-medium transition-colors', sectors.includes(s) ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-gray-800 text-gray-500 border border-gray-700 hover:text-gray-300')}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-gray-800/50 rounded-lg px-3 py-2 text-xs text-gray-500 space-y-0.5">
                <div className="flex justify-between"><span>Stop-loss</span><span className="text-red-400">−2% from entry</span></div>
                <div className="flex justify-between"><span>Take-profit</span><span className="text-emerald-400">+4% from entry</span></div>
                <div className="flex justify-between"><span>Max trades per run</span><span>3 (top BUY signals)</span></div>
                <div className="flex justify-between"><span>Background check</span><span>every 5 minutes</span></div>
              </div>
            </div>
          </Card>

          {/* Run button */}
          <Button
            onClick={runStrategy}
            loading={scanning || executing}
            fullWidth
            icon={scanning || executing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          >
            {scanning ? 'Scanning signals...' : executing ? 'Executing trades...' : 'Run Strategy'}
          </Button>

          {scanError && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              {scanError}
            </div>
          )}

          {/* Run log */}
          {runLog.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 font-mono text-[11px] text-gray-400 space-y-0.5 max-h-40 overflow-y-auto">
              {runLog.map((line, i) => <p key={i}>{line}</p>)}
            </div>
          )}
        </div>

        {/* Right columns: signals + positions */}
        <div className="lg:col-span-2 space-y-4">

          {/* Latest signals */}
          {signals.length > 0 && (
            <Card>
              <CardHeader title="Latest Signals" subtitle={`${signals.length} stocks scanned`} icon={<BarChart3 className="h-4 w-4" />} />
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="text-left py-2 pr-3">Stock</th>
                      <th className="text-right py-2 pr-3">Price</th>
                      <th className="text-right py-2 pr-3">Change</th>
                      <th className="text-center py-2 pr-3">Signal</th>
                      <th className="text-left py-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {signals.slice(0, 8).map(s => (
                      <tr key={s.symbol} className="border-b border-gray-800/50">
                        <td className="py-1.5 pr-3">
                          <p className="font-semibold text-white">{s.symbol}</p>
                          <p className="text-gray-600">{s.sector}</p>
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono text-gray-300">${s.currentPrice.toFixed(2)}</td>
                        <td className={clsx('py-1.5 pr-3 text-right font-mono', s.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {fmtPct(s.changePercent)}
                        </td>
                        <td className="py-1.5 pr-3 text-center">
                          <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold', s.signal === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : s.signal === 'SELL' ? 'bg-red-500/20 text-red-400' : 'bg-gray-700 text-gray-400')}>{s.signal}</span>
                        </td>
                        <td className="py-1.5 text-gray-500 truncate max-w-[180px]">{s.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Open positions */}
          <Card>
            <CardHeader title="Open Demo Positions" subtitle={`${demoPositions.length} positions · auto-checked every 5 min`} icon={<FlaskConical className="h-4 w-4" />} />
            {demoPositions.length === 0 ? (
              <p className="text-sm text-gray-600 text-center py-6">No open demo positions. Run the strategy to open trades.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="text-left py-2 pr-3">Stock</th>
                      <th className="text-right py-2 pr-3">Qty</th>
                      <th className="text-right py-2 pr-3">Entry</th>
                      <th className="text-right py-2 pr-3">Current</th>
                      <th className="text-right py-2 pr-3">SL</th>
                      <th className="text-right py-2 pr-3">TP</th>
                      <th className="text-right py-2 pr-3">P&L</th>
                      <th className="text-right py-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {demoPositions.map(pos => (
                      <tr key={pos.id} className="border-b border-gray-800/50">
                        <td className="py-1.5 pr-3">
                          <p className="font-semibold text-white">{pos.ticker}</p>
                          <p className="text-gray-600">{hoursAgo(pos.openedAt)}</p>
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono text-gray-300">{pos.quantity}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-gray-300">${pos.entryPrice.toFixed(2)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-gray-300">${pos.currentPrice.toFixed(2)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-red-400">${pos.stopLoss.toFixed(2)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-emerald-400">${pos.takeProfit.toFixed(2)}</td>
                        <td className={clsx('py-1.5 pr-3 text-right font-mono font-semibold', pos.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {pos.pnl >= 0 ? '+' : ''}{fmt(pos.pnl)}
                        </td>
                        <td className="py-1.5 text-right">
                          <button onClick={() => closePosition(pos)} className="text-gray-500 hover:text-red-400 transition-colors" title="Close position">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Performance summary */}
          {closedTrades.length > 0 && (
            <Card>
              <CardHeader title="Performance Summary" subtitle={`${closedTrades.length} closed trades`} icon={<Trophy className="h-4 w-4" />} />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                {[
                  { label: 'Total P&L', value: fmt(totalPnL), color: totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400' },
                  { label: 'Win Rate', value: `${winRate.toFixed(0)}%`, color: winRate >= 50 ? 'text-emerald-400' : 'text-red-400' },
                  { label: 'Best Trade', value: bestTrade ? `${fmt(bestTrade.pnl)} (${bestTrade.ticker})` : '—', color: 'text-emerald-400' },
                  { label: 'Worst Trade', value: worstTrade ? `${fmt(worstTrade.pnl)} (${worstTrade.ticker})` : '—', color: 'text-red-400' },
                ].map(stat => (
                  <div key={stat.label} className="bg-gray-800/50 rounded-lg px-3 py-2.5">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">{stat.label}</p>
                    <p className={clsx('text-sm font-semibold font-mono', stat.color)}>{stat.value}</p>
                  </div>
                ))}
              </div>

              {/* Closed trades table */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="text-left py-2 pr-3">Stock</th>
                      <th className="text-right py-2 pr-3">Entry</th>
                      <th className="text-right py-2 pr-3">Exit</th>
                      <th className="text-right py-2 pr-3">P&L</th>
                      <th className="text-center py-2 pr-3">Reason</th>
                      <th className="text-right py-2">Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closedTrades.slice(0, 10).map(trade => (
                      <tr key={trade.id} className="border-b border-gray-800/50">
                        <td className="py-1.5 pr-3 font-semibold text-white">{trade.ticker}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-gray-300">${trade.entryPrice.toFixed(2)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono text-gray-300">${trade.exitPrice.toFixed(2)}</td>
                        <td className={clsx('py-1.5 pr-3 text-right font-mono font-semibold', trade.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {trade.pnl >= 0 ? '+' : ''}{fmt(trade.pnl)} ({fmtPct(trade.pnlPct)})
                        </td>
                        <td className="py-1.5 pr-3 text-center">
                          <span className={clsx('px-1.5 py-0.5 rounded text-[10px]', trade.closeReason === 'take-profit' ? 'bg-emerald-500/20 text-emerald-400' : trade.closeReason === 'stop-loss' ? 'bg-red-500/20 text-red-400' : 'bg-gray-700 text-gray-400')}>
                            {trade.closeReason}
                          </span>
                        </td>
                        <td className="py-1.5 text-right text-gray-500">{hoursAgo(trade.closedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Copy to Live */}
          {profitableTrades.length > 0 && (
            <Card>
              <CardHeader
                title="Copy to Live Account"
                subtitle="Profitable demo trades from the last 7 days"
                icon={<Copy className="h-4 w-4" />}
              />
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-3 text-xs text-amber-300">
                <strong>⚠ YOU are making this decision.</strong> Copying a trade to your live account places a real market order with real money. Past demo performance does not guarantee live results. This is not automated financial advice.
              </div>
              {!liveEncoded && (
                <p className="text-xs text-gray-500 mb-3">Connect your live T212 account in Settings to enable copy trading.</p>
              )}
              <div className="space-y-2">
                {profitableTrades.map(trade => (
                  <div key={trade.id} className="flex items-center justify-between bg-gray-800/40 rounded-lg px-3 py-2.5">
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="text-sm font-semibold text-white">{trade.ticker} <span className="text-xs text-gray-500 font-normal">{trade.companyName}</span></p>
                        <p className="text-xs text-gray-500">Entry ${trade.entryPrice.toFixed(2)} → Exit ${trade.exitPrice.toFixed(2)} · {hoursAgo(trade.closedAt)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <p className="text-sm font-semibold text-emerald-400 font-mono">+{fmt(trade.pnl)}</p>
                        <p className="text-xs text-emerald-400/70">{fmtPct(trade.pnlPct)}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        icon={<ArrowRight className="h-3.5 w-3.5" />}
                        onClick={() => setCopyTrade(trade)}
                        disabled={!liveEncoded}
                      >
                        Copy
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

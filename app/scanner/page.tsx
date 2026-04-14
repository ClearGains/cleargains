'use client';

import { useState } from 'react';
import {
  Search, Newspaper, AlertTriangle, TrendingUp, TrendingDown, Minus,
  Clock, RefreshCw, BookmarkPlus, BookmarkCheck, Trash2, ChevronRight,
  ShieldCheck, ShieldAlert, ShieldX, Zap, ExternalLink, FlaskConical,
  CheckCircle2, AlertCircle, X,
} from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { ScanResult } from '@/lib/types';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { TickerTooltip } from '@/components/ui/TickerTooltip';
import { clsx } from 'clsx';

const QUICK_TICKERS = [
  { symbol: 'AAPL', label: 'Apple' },
  { symbol: 'NVDA', label: 'Nvidia' },
  { symbol: 'TSLA', label: 'Tesla' },
  { symbol: 'MSFT', label: 'Microsoft' },
  { symbol: 'AMZN', label: 'Amazon' },
  { symbol: 'GOOGL', label: 'Alphabet' },
  { symbol: 'VOD.L', label: 'Vodafone' },
  { symbol: 'LLOY.L', label: 'Lloyds' },
  { symbol: 'BARC.L', label: 'Barclays' },
  { symbol: 'BP.L', label: 'BP' },
];

function SignalBadge({ signal }: { signal: 'BUY' | 'SELL' | 'HOLD' }) {
  const icon =
    signal === 'BUY' ? <TrendingUp className="h-3.5 w-3.5" /> :
    signal === 'SELL' ? <TrendingDown className="h-3.5 w-3.5" /> :
    <Minus className="h-3.5 w-3.5" />;
  return (
    <Badge variant={signal.toLowerCase() as 'buy' | 'sell' | 'hold'}>
      {icon}<span className="ml-1">{signal}</span>
    </Badge>
  );
}

function VerdictBadge({ verdict }: { verdict: 'PROCEED' | 'CAUTION' | 'REJECT' }) {
  if (verdict === 'PROCEED') return (
    <div className="flex items-center gap-1.5 text-emerald-400 text-sm font-semibold">
      <ShieldCheck className="h-4 w-4" /> Proceed
    </div>
  );
  if (verdict === 'REJECT') return (
    <div className="flex items-center gap-1.5 text-red-400 text-sm font-semibold">
      <ShieldX className="h-4 w-4" /> Reject
    </div>
  );
  return (
    <div className="flex items-center gap-1.5 text-yellow-400 text-sm font-semibold">
      <ShieldAlert className="h-4 w-4" /> Caution
    </div>
  );
}

function RiskBar({ score }: { score: number }) {
  const color = score >= 70 ? 'bg-red-500' : score >= 45 ? 'bg-yellow-500' : 'bg-emerald-500';
  return (
    <div className="w-full bg-gray-800 rounded-full h-1.5 mt-1">
      <div className={clsx('h-1.5 rounded-full transition-all', color)} style={{ width: `${score}%` }} />
    </div>
  );
}

function ConfidenceRing({ score }: { score: number }) {
  const color = score >= 70 ? 'text-emerald-400' : score >= 45 ? 'text-yellow-400' : 'text-red-400';
  return (
    <div className="flex flex-col items-center">
      <div className={clsx('text-3xl font-bold tabular-nums', color)}>{score}</div>
      <div className="text-xs text-gray-500">confidence</div>
    </div>
  );
}

type PaperBuyState = {
  ticker: string;
  companyName: string;
  t212Ticker: string;
  sector: string;
} | null;

function uid() { return Math.random().toString(36).slice(2, 10); }

function PaperBuyModal({
  stock,
  onClose,
}: {
  stock: NonNullable<PaperBuyState>;
  onClose: () => void;
}) {
  const { paperBudget, demoPositions, addDemoPosition } = useClearGainsStore();
  const [loading, setLoading] = useState(true);
  const [price, setPrice] = useState<number | null>(null);
  const [sizeStr, setSizeStr] = useState('100');
  const [done, setDone] = useState<{ ok: boolean; message: string } | null>(null);

  // Fetch price on mount
  useState(() => {
    fetch('/api/demo-trader/prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: [stock.ticker] }),
    })
      .then(r => r.json())
      .then((d: { prices: Record<string, number> }) => {
        setPrice(d.prices[stock.ticker] ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  });

  const size = parseInt(sizeStr.replace(/[^0-9]/g, ''), 10) || 100;
  const invested = demoPositions.reduce((s, p) => s + p.entryPrice * p.quantity, 0);
  const available = Math.max(0, paperBudget - invested);
  const quantity = price && price > 0 ? Math.max(1, Math.floor(size / price)) : 0;
  const estimatedCost = quantity * (price ?? 0);
  const sl = price ? price * 0.98 : 0;
  const tp = price ? price * 1.04 : 0;

  function handleBuy() {
    if (!price || quantity < 1) return;
    addDemoPosition({
      id: uid(),
      ticker: stock.ticker,
      t212Ticker: stock.t212Ticker,
      companyName: stock.companyName,
      sector: stock.sector,
      quantity,
      entryPrice: price,
      currentPrice: price,
      stopLoss: sl,
      takeProfit: tp,
      pnl: 0,
      pnlPct: 0,
      openedAt: new Date().toISOString(),
      signal: 'Manual buy from scanner',
    });
    setDone({ ok: true, message: `Opened paper position: ${quantity}× ${stock.ticker} @ $${price.toFixed(2)}` });
    setTimeout(onClose, 2000);
  }

  return (
    <div className="fixed inset-0 z-[9999] overflow-y-auto bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="flex min-h-full items-center justify-center p-4">
      <div className="relative w-full max-w-sm bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-6" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute right-4 top-4 p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors z-10">
          <X className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2 mb-4">
          <FlaskConical className="h-5 w-5 text-amber-400" />
          <h2 className="text-base font-semibold text-white">Paper Trade</h2>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Fetching live price…
          </div>
        ) : price == null ? (
          <div className="text-sm text-red-400 py-4">Could not fetch price for {stock.ticker}. Market may be closed.</div>
        ) : (
          <>
            <div className="bg-gray-800/50 rounded-lg p-4 mb-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Stock</span>
                <span className="text-white font-semibold">{stock.ticker} · {stock.companyName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Live price</span>
                <span className="text-white font-mono">${price.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Available budget</span>
                <span className={clsx('font-mono', available > 0 ? 'text-emerald-400' : 'text-red-400')}>
                  £{available.toFixed(0)}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-400">Position size</span>
                <div className="relative">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500 text-xs">£</span>
                  <input
                    type="text" inputMode="numeric"
                    value={sizeStr}
                    onChange={e => setSizeStr(e.target.value.replace(/[^0-9]/g, ''))}
                    className="w-20 pl-5 pr-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white text-right focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Quantity</span>
                <span className="text-white font-mono">{quantity} shares</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Est. cost</span>
                <span className="text-white font-mono">${estimatedCost.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Stop-loss −2%</span>
                <span className="text-red-400 font-mono">${sl.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Take-profit +4%</span>
                <span className="text-emerald-400 font-mono">${tp.toFixed(2)}</span>
              </div>
            </div>

            {estimatedCost > available && (
              <div className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 mb-3">
                Position size exceeds available budget. Reduce size.
              </div>
            )}

            {done ? (
              <div className={clsx('flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs', done.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/30 text-red-400')}>
                {done.ok ? <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /> : <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />}
                {done.message}
              </div>
            ) : (
              <Button
                onClick={handleBuy}
                fullWidth
                disabled={quantity < 1 || estimatedCost > available}
                icon={<FlaskConical className="h-4 w-4" />}
              >
                Open Paper Position
              </Button>
            )}
          </>
        )}
      </div>
      </div>
    </div>
  );
}

export default function ScannerPage() {
  const {
    signals, addSignal,
    watchlist, addToWatchlist, removeFromWatchlist,
    scanHistory, addScanResult,
    t212Positions,
  } = useClearGainsStore();

  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [paperBuyStock, setPaperBuyStock] = useState<PaperBuyState>(null);

  async function runScan(q?: string) {
    const target = (q ?? query).trim();
    if (!target) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/ai-scanner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: target }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? 'Scan failed');
      } else {
        setResult(data);
        addScanResult(data);
        // Also push to legacy signals for dashboard widget
        addSignal({
          ticker: data.ticker,
          signal: data.signal,
          riskScore: data.riskScore,
          confidence: data.confidence,
          reasoning: data.reasoning,
          sources: data.articles?.map((a: { source: string }) => a.source) ?? [],
          timestamp: data.timestamp,
        });
        setQuery('');
      }
    } catch {
      setError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  }

  const portfolioTickers = t212Positions.map((p) => p.ticker).slice(0, 6);
  const isWatched = result ? watchlist.includes(result.ticker) : false;

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      {paperBuyStock && (
        <PaperBuyModal stock={paperBuyStock} onClose={() => setPaperBuyStock(null)} />
      )}

      {/* Header */}
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Zap className="h-6 w-6 text-emerald-400" />
          News Scanner
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Search any stock or company — live news fetched and analysed in real time
        </p>
      </div>

      {/* Disclaimer */}
      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 mb-5 flex items-start gap-3">
        <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-yellow-400">
          <span className="font-semibold">Educational only.</span> Signals are based on news
          sentiment and are not financial advice. Always do your own research.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left col — search + results */}
        <div className="lg:col-span-2 space-y-4">

          {/* Search */}
          <Card>
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runScan()}
                placeholder="Search ticker or company — e.g. AAPL, Tesla, VOD.L, Barclays…"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500"
              />
              <Button onClick={() => runScan()} loading={loading} icon={<Search className="h-4 w-4" />}>
                Scan
              </Button>
            </div>

            {/* Quick tickers */}
            <div className="mb-3">
              <p className="text-xs text-gray-600 mb-2">Quick scan:</p>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_TICKERS.map(({ symbol, label }) => (
                  <button
                    key={symbol}
                    onClick={() => runScan(symbol)}
                    disabled={loading}
                    className="px-2.5 py-1 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-emerald-500 text-gray-400 hover:text-emerald-400 rounded-md transition-colors disabled:opacity-50"
                  >
                    <span className="font-mono">{symbol}</span>
                    <span className="text-gray-600 ml-1 hidden sm:inline">{label}</span>
                  </button>
                ))}
              </div>
            </div>

            {portfolioTickers.length > 0 && (
              <div>
                <p className="text-xs text-gray-600 mb-2">Your portfolio:</p>
                <div className="flex flex-wrap gap-1.5">
                  {portfolioTickers.map((t) => (
                    <button
                      key={t}
                      onClick={() => runScan(t)}
                      disabled={loading}
                      className="px-2.5 py-1 text-xs font-mono bg-emerald-600/10 hover:bg-emerald-600/20 border border-emerald-600/20 text-emerald-400 rounded-md transition-colors disabled:opacity-50"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {loading && (
            <Card>
              <div className="flex items-center gap-3 py-6 justify-center">
                <RefreshCw className="h-5 w-5 text-emerald-400 animate-spin" />
                <span className="text-gray-400 text-sm">Searching live news and generating signal…</span>
              </div>
            </Card>
          )}

          {/* Signal card */}
          {result && !loading && (
            <>
              <Card className="border-emerald-500/20">
                {/* Header row */}
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <TickerTooltip symbol={result.ticker}>
                        <span className="text-2xl font-bold text-white font-mono">{result.ticker}</span>
                      </TickerTooltip>
                      <SignalBadge signal={result.signal} />
                      <span className={clsx(
                        'text-xs px-2 py-0.5 rounded border font-medium',
                        result.market === 'UK'
                          ? 'text-blue-400 border-blue-500/30 bg-blue-500/10'
                          : result.market === 'US'
                          ? 'text-purple-400 border-purple-500/30 bg-purple-500/10'
                          : 'text-gray-400 border-gray-600 bg-gray-800'
                      )}>
                        {result.market}
                      </span>
                    </div>
                    <p className="text-sm text-gray-400 mt-0.5">{result.companyName}</p>
                    <p className="text-xs text-gray-600 mt-1 flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(result.timestamp).toLocaleString('en-GB')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {result.signal === 'BUY' && (
                      <button
                        onClick={() => setPaperBuyStock({
                          ticker: result.ticker,
                          companyName: result.companyName,
                          t212Ticker: result.ticker + '_US_EQ',
                          sector: result.market === 'UK' ? 'UK' : 'US',
                        })}
                        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors text-amber-300 border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20"
                      >
                        <FlaskConical className="h-3.5 w-3.5" />
                        Paper BUY
                      </button>
                    )}
                    <button
                      onClick={() => isWatched ? removeFromWatchlist(result.ticker) : addToWatchlist(result.ticker)}
                      className={clsx(
                        'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors',
                        isWatched
                          ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
                          : 'text-gray-500 border-gray-700 hover:text-emerald-400 hover:border-emerald-500/30'
                      )}
                    >
                      {isWatched ? <BookmarkCheck className="h-3.5 w-3.5" /> : <BookmarkPlus className="h-3.5 w-3.5" />}
                      {isWatched ? 'Watching' : 'Watchlist'}
                    </button>
                  </div>
                </div>

                {/* Metrics row */}
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div className="bg-gray-800/60 rounded-xl p-3 text-center">
                    <ConfidenceRing score={result.confidence} />
                  </div>
                  <div className="bg-gray-800/60 rounded-xl p-3">
                    <div className="text-xs text-gray-500 mb-1">Risk Score</div>
                    <div className="text-2xl font-bold text-white tabular-nums">{result.riskScore}</div>
                    <RiskBar score={result.riskScore} />
                  </div>
                  <div className="bg-gray-800/60 rounded-xl p-3 flex items-center justify-center">
                    <VerdictBadge verdict={result.verdict} />
                  </div>
                </div>

                {/* Reasoning */}
                <div className="bg-gray-800/40 border border-gray-700/50 rounded-xl p-3">
                  <div className="text-xs text-gray-500 mb-1.5 font-medium uppercase tracking-wide">Signal Reasoning</div>
                  <p className="text-sm text-gray-300 leading-relaxed">{result.reasoning}</p>
                </div>
              </Card>

              {/* News feed */}
              {result.articles?.length > 0 && (
                <Card>
                  <CardHeader
                    title="Latest News"
                    subtitle={`${result.articles.length} articles informing this signal`}
                    icon={<Newspaper className="h-4 w-4" />}
                  />
                  {result.noRecentNews && (
                    <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-400">
                      <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                      No recent news found — showing most relevant available articles
                    </div>
                  )}
                  <div className="divide-y divide-gray-800">
                    {result.articles.map((article, i) => (
                      <div key={i} className="py-3 first:pt-0">
                        {article.link ? (
                          <a
                            href={article.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group"
                          >
                            <p className="text-sm text-gray-200 font-medium leading-snug mb-1 group-hover:text-emerald-300 transition-colors flex items-start gap-1.5">
                              <span className="flex-1">{article.headline}</span>
                              <ExternalLink className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-emerald-400" />
                            </p>
                          </a>
                        ) : (
                          <p className="text-sm text-gray-200 font-medium leading-snug mb-1">
                            {article.headline}
                          </p>
                        )}
                        <div className="flex items-center gap-2 text-xs text-gray-600">
                          {article.source && <span className="text-gray-500 font-medium">{article.source}</span>}
                          {article.source && article.date && <span>·</span>}
                          {article.date && <span>{article.date}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </>
          )}

          {/* Scan history */}
          {scanHistory.length > 0 && !loading && (
            <Card>
              <CardHeader
                title="Scan History"
                subtitle={`${scanHistory.length} previous scans`}
                icon={<Clock className="h-4 w-4" />}
              />
              <div className="space-y-1.5">
                {scanHistory.map((scan, i) => (
                  <button
                    key={i}
                    onClick={() => runScan(scan.ticker)}
                    disabled={loading}
                    className="w-full flex items-center justify-between py-2 px-3 bg-gray-800/50 hover:bg-gray-800 rounded-lg border border-gray-700/50 transition-colors disabled:opacity-50"
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-mono font-semibold text-white text-sm w-20 text-left">{scan.ticker}</span>
                      <span className="text-xs text-gray-500 hidden sm:block">{scan.companyName}</span>
                      <SignalBadge signal={scan.signal} />
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-600">
                      <span className="hidden sm:block">{new Date(scan.timestamp).toLocaleDateString('en-GB')}</span>
                      <ChevronRight className="h-3.5 w-3.5" />
                    </div>
                  </button>
                ))}
              </div>
            </Card>
          )}

          {!result && !loading && scanHistory.length === 0 && (
            <div className="text-center py-16">
              <Zap className="h-12 w-12 text-gray-700 mx-auto mb-4" />
              <p className="text-gray-500 text-sm">Search a stock above to get a live news signal</p>
              <p className="text-gray-600 text-xs mt-1">Works for US stocks (AAPL) and UK stocks (VOD.L, Barclays)</p>
            </div>
          )}
        </div>

        {/* Right col — watchlist */}
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Watchlist"
              subtitle={watchlist.length > 0 ? `${watchlist.length} stocks` : 'No stocks added yet'}
              icon={<BookmarkCheck className="h-4 w-4" />}
            />

            {watchlist.length === 0 ? (
              <div className="py-4 text-center">
                <p className="text-xs text-gray-600">
                  Scan a stock and click <span className="text-emerald-400">+ Watchlist</span> to save it here
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {watchlist.map((ticker) => {
                  const lastScan = scanHistory.find((s) => s.ticker === ticker);
                  return (
                    <div key={ticker} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-gray-800/50 group">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-white">{ticker}</span>
                          {lastScan && <SignalBadge signal={lastScan.signal} />}
                        </div>
                        {lastScan && (
                          <p className="text-xs text-gray-600 mt-0.5">
                            {new Date(lastScan.timestamp).toLocaleDateString('en-GB')}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => runScan(ticker)}
                          disabled={loading}
                          className="p-1.5 text-gray-500 hover:text-emerald-400 transition-colors"
                          title="Re-scan"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => removeFromWatchlist(ticker)}
                          className="p-1.5 text-gray-500 hover:text-red-400 transition-colors"
                          title="Remove"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Signals from dashboard (legacy) */}
          {signals.length > 0 && (
            <Card>
              <CardHeader
                title="Recent Signals"
                subtitle="From this session"
                icon={<Zap className="h-4 w-4" />}
              />
              <div className="space-y-1.5">
                {signals.slice(0, 5).map((signal, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-white w-16">{signal.ticker}</span>
                      <SignalBadge signal={signal.signal} />
                    </div>
                    <span className="text-xs text-gray-600 tabular-nums">{signal.confidence}%</span>
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

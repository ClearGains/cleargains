'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Bookmark, RefreshCw, Trash2, TrendingUp, TrendingDown, Minus,
  FlaskConical, CheckCircle2, AlertCircle, X, Clock,
} from 'lucide-react';
import { useClearGainsStore } from '@/lib/store';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { TickerTooltip } from '@/components/ui/TickerTooltip';
import { clsx } from 'clsx';

type QuoteData = {
  price: number;
  changePercent: number;
  flash: 'up' | 'down' | null;
};

function uid() { return Math.random().toString(36).slice(2, 10); }
function fmtPrice(n: number) { return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtPct(n: number) { return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }

function PaperBuyModal({
  ticker,
  companyName,
  currentPrice,
  onClose,
}: {
  ticker: string;
  companyName?: string;
  currentPrice: number;
  onClose: () => void;
}) {
  const { paperBudget, demoPositions, addDemoPosition } = useClearGainsStore();
  const [sizeStr, setSizeStr] = useState('100');
  const [done, setDone] = useState<{ ok: boolean; message: string } | null>(null);

  const size = parseInt(sizeStr.replace(/[^0-9]/g, ''), 10) || 100;
  const invested = demoPositions.reduce((s, p) => s + p.entryPrice * p.quantity, 0);
  const available = Math.max(0, paperBudget - invested);
  const quantity = Math.max(1, Math.floor(size / currentPrice));
  const estimatedCost = quantity * currentPrice;
  const sl = currentPrice * 0.98;
  const tp = currentPrice * 1.04;

  function handleBuy() {
    addDemoPosition({
      id: uid(),
      ticker,
      t212Ticker: ticker + '_US_EQ',
      companyName: companyName ?? ticker,
      sector: 'Watchlist',
      quantity,
      entryPrice: currentPrice,
      currentPrice,
      stopLoss: sl,
      takeProfit: tp,
      pnl: 0,
      pnlPct: 0,
      openedAt: new Date().toISOString(),
      signal: 'Manual buy from watchlist',
    });
    setDone({ ok: true, message: `Opened: ${quantity}× ${ticker} @ ${fmtPrice(currentPrice)}` });
    setTimeout(onClose, 2000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-sm shadow-2xl p-6">
        <button onClick={onClose} className="absolute right-4 top-4 text-gray-500 hover:text-gray-300">
          <X className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2 mb-4">
          <FlaskConical className="h-5 w-5 text-amber-400" />
          <h2 className="text-base font-semibold text-white">Paper Trade — {ticker}</h2>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-4 mb-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">Live price</span>
            <span className="text-white font-mono">{fmtPrice(currentPrice)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Available budget</span>
            <span className={clsx('font-mono', available > 0 ? 'text-emerald-400' : 'text-red-400')}>£{available.toFixed(0)}</span>
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
            <span className="text-white font-mono">{quantity} shares (${estimatedCost.toFixed(2)})</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Stop-loss −2%</span>
            <span className="text-red-400 font-mono">{fmtPrice(sl)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Take-profit +4%</span>
            <span className="text-emerald-400 font-mono">{fmtPrice(tp)}</span>
          </div>
        </div>
        {estimatedCost > available && (
          <div className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 mb-3">
            Exceeds available paper budget. Reduce size.
          </div>
        )}
        {done ? (
          <div className={clsx('flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs', done.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border border-red-500/30 text-red-400')}>
            {done.ok ? <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /> : <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />}
            {done.message}
          </div>
        ) : (
          <Button onClick={handleBuy} fullWidth disabled={quantity < 1 || estimatedCost > available} icon={<FlaskConical className="h-4 w-4" />}>
            Open Paper Position
          </Button>
        )}
      </div>
    </div>
  );
}

export default function WatchlistPage() {
  const { watchlist, removeFromWatchlist, scanHistory } = useClearGainsStore();
  const [quotes, setQuotes] = useState<Record<string, QuoteData>>({});
  const [fetching, setFetching] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<number>(0);
  const [tick, setTick] = useState(0);
  const [buyTicker, setBuyTicker] = useState<string | null>(null);
  const prevPricesRef = useRef<Record<string, number>>({});

  // Fetch quote + change% via stock profile (which includes dp)
  const fetchFullQuotes = useCallback(async () => {
    if (watchlist.length === 0) return;
    setFetching(true);
    try {
      const results = await Promise.all(
        watchlist.map(sym =>
          fetch(`/api/stock/profile?symbol=${encodeURIComponent(sym)}`)
            .then(r => r.json())
            .then((d: { price: number | null; changePercent: number | null }) => ({ sym, d }))
            .catch(() => ({ sym, d: { price: null, changePercent: null } }))
        )
      );
      setQuotes(prev => {
        const next = { ...prev };
        for (const { sym, d } of results) {
          if (d.price == null) continue;
          const prevPrice = prevPricesRef.current[sym] ?? 0;
          const flash: 'up' | 'down' | null = prevPrice > 0
            ? (d.price > prevPrice ? 'up' : d.price < prevPrice ? 'down' : null)
            : null;
          next[sym] = { price: d.price, changePercent: d.changePercent ?? 0, flash };
          prevPricesRef.current[sym] = d.price;
        }
        return next;
      });
      setTimeout(() => {
        setQuotes(prev => {
          const next = { ...prev };
          for (const sym of Object.keys(next)) next[sym] = { ...next[sym], flash: null };
          return next;
        });
      }, 900);
      setLastRefreshed(Date.now());
    } catch {
      // ignore
    } finally {
      setFetching(false);
    }
  }, [watchlist]);

  // Initial load + 60s refresh
  useEffect(() => {
    fetchFullQuotes();
    const interval = setInterval(fetchFullQuotes, 60_000);
    return () => clearInterval(interval);
  }, [fetchFullQuotes]);

  // 1s countdown tick
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const secondsAgo = lastRefreshed > 0 ? Math.floor((Date.now() - lastRefreshed) / 1000) : null;
  // tick is used only to trigger re-render for countdown; suppress lint
  void tick;

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      {buyTicker && quotes[buyTicker] && (
        <PaperBuyModal
          ticker={buyTicker}
          currentPrice={quotes[buyTicker].price}
          onClose={() => setBuyTicker(null)}
        />
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Bookmark className="h-6 w-6 text-emerald-400" />
            Watchlist
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {watchlist.length} stock{watchlist.length !== 1 ? 's' : ''} · prices refresh every 60 seconds
          </p>
        </div>
        <div className="flex items-center gap-3">
          {secondsAgo !== null && (
            <span className="text-xs text-gray-600 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {secondsAgo < 5 ? 'Just updated' : `${secondsAgo}s ago`}
            </span>
          )}
          <button
            onClick={fetchFullQuotes}
            disabled={fetching}
            className="p-2 text-gray-500 hover:text-emerald-400 transition-colors rounded-lg hover:bg-gray-800"
            title="Refresh prices"
          >
            <RefreshCw className={clsx('h-4 w-4', fetching && 'animate-spin')} />
          </button>
        </div>
      </div>

      {watchlist.length === 0 ? (
        <Card>
          <div className="py-16 text-center">
            <Bookmark className="h-12 w-12 text-gray-700 mx-auto mb-4" />
            <p className="text-gray-500 text-sm">Your watchlist is empty</p>
            <p className="text-gray-600 text-xs mt-1">
              Scan a stock in the AI Scanner and click <span className="text-emerald-400">+ Watchlist</span> to add it here
            </p>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="divide-y divide-gray-800">
            {watchlist.map(ticker => {
              const q = quotes[ticker];
              const lastScan = scanHistory.find(s => s.ticker === ticker);
              return (
                <div
                  key={ticker}
                  className={clsx(
                    'flex items-center justify-between py-4 first:pt-2 last:pb-2 rounded-lg px-2 transition-colors',
                    q?.flash === 'up' ? 'price-flash-up' : q?.flash === 'down' ? 'price-flash-down' : ''
                  )}
                >
                  <div className="flex items-center gap-4">
                    <div>
                      <TickerTooltip symbol={ticker}>
                        <span className="font-mono font-bold text-white text-base">{ticker}</span>
                      </TickerTooltip>
                      {lastScan && (
                        <div className="flex items-center gap-1.5 mt-1">
                          <span className={clsx(
                            'text-[10px] px-1.5 py-0.5 rounded font-semibold',
                            lastScan.signal === 'BUY' ? 'text-emerald-400 bg-emerald-500/10' :
                            lastScan.signal === 'SELL' ? 'text-red-400 bg-red-500/10' :
                            'text-gray-400 bg-gray-700'
                          )}>
                            {lastScan.signal}
                          </span>
                          <span className="text-[10px] text-gray-600">{new Date(lastScan.timestamp).toLocaleDateString('en-GB')}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {q ? (
                      <div className="text-right">
                        <div className="text-sm font-mono font-semibold text-white">{fmtPrice(q.price)}</div>
                        <div className={clsx(
                          'text-xs font-medium flex items-center justify-end gap-0.5',
                          q.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400'
                        )}>
                          {q.changePercent >= 0
                            ? <TrendingUp className="h-3 w-3" />
                            : <TrendingDown className="h-3 w-3" />}
                          {fmtPct(q.changePercent)}
                        </div>
                      </div>
                    ) : fetching ? (
                      <div className="w-16 text-right">
                        <div className="h-4 bg-gray-800 rounded animate-pulse w-16 mb-1" />
                        <div className="h-3 bg-gray-800 rounded animate-pulse w-10 ml-auto" />
                      </div>
                    ) : (
                      <div className="text-right">
                        <Minus className="h-4 w-4 text-gray-600 ml-auto" />
                      </div>
                    )}

                    <div className="flex items-center gap-1">
                      {q && q.price > 0 && (
                        <button
                          onClick={() => setBuyTicker(ticker)}
                          className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border transition-colors text-amber-300 border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20"
                        >
                          <FlaskConical className="h-3 w-3" />
                          BUY
                        </button>
                      )}
                      <button
                        onClick={() => removeFromWatchlist(ticker)}
                        className="p-1.5 text-gray-600 hover:text-red-400 transition-colors rounded"
                        title="Remove from watchlist"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <p className="text-xs text-gray-700 text-center mt-4">
        Prices from Finnhub · For educational purposes only · Not financial advice
      </p>
    </div>
  );
}

'use client';

import { useState, useCallback } from 'react';
import { Search, RefreshCw, TrendingUp, TrendingDown, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

// ── Types ─────────────────────────────────────────────────────────────────────

type MarketCategory = 'indices' | 'us-shares' | 'uk-shares';

type IGSession = { cst: string; securityToken: string; apiKey: string };

type IGMarketResult = {
  epic:           string;
  instrumentName: string;
  instrumentType: string;
  expiry:         string;
  bid?:           number;
  offer?:         number;
  percentageChange?: number;
  high?:          number;
  low?:           number;
};

type TradeState = {
  direction: 'BUY' | 'SELL';
  size:      string;
  stopDist:  string;
  limitDist: string;
};

// ── Indices (hardcoded verified epics) ────────────────────────────────────────

const INDICES = [
  { name: 'FTSE 100',      epic: 'IX.D.FTSE.DAILY.IP',    currency: 'GBP' },
  { name: 'S&P 500',       epic: 'IX.D.SPTRD.DAILY.IP',   currency: 'USD' },
  { name: 'NASDAQ 100',    epic: 'IX.D.NASDAQ.DAILY.IP',  currency: 'USD' },
  { name: 'Wall Street',   epic: 'IX.D.DOW.DAILY.IP',     currency: 'USD' },
  { name: 'Germany 40',    epic: 'IX.D.DAX.DAILY.IP',     currency: 'EUR' },
  { name: 'Japan 225',     epic: 'IX.D.NIKKEI.DAILY.IP',  currency: 'USD' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function igHeaders(s: IGSession, env: 'demo' | 'live') {
  return {
    'x-ig-cst': s.cst,
    'x-ig-security-token': s.securityToken,
    'x-ig-api-key': s.apiKey,
    'x-ig-env': env,
  };
}

function epicFromTicker(ticker: string, category: MarketCategory): string {
  if (category === 'us-shares') return `CS.D.${ticker.toUpperCase()}.TODAY.IP`;
  if (category === 'uk-shares') return `CS.D.${ticker.toUpperCase()}.TODAY.IP`;
  return ticker;
}

function currencyForCategory(cat: MarketCategory): string {
  if (cat === 'us-shares') return 'USD';
  if (cat === 'uk-shares') return 'GBP';
  return 'GBP';
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  session: IGSession | null;
  env:     'demo' | 'live';
  onConnect: () => void;
}

export default function SharesTrading({ session, env, onConnect }: Props) {
  const [category, setCategory] = useState<MarketCategory>('indices');
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState<IGMarketResult[]>([]);
  const [searching, setSearching]       = useState(false);
  const [selected, setSelected]         = useState<IGMarketResult | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [trade, setTrade] = useState<TradeState>({ direction: 'BUY', size: '1', stopDist: '10', limitDist: '20' });
  const [placing, setPlacing]   = useState(false);
  const [result, setResult]     = useState<{ ok: boolean; message: string } | null>(null);

  const searchMarkets = useCallback(async (q: string) => {
    if (!session || !q.trim()) return;
    setSearching(true);
    setSearchResults([]);
    try {
      const res = await fetch(`/api/ig/markets?q=${encodeURIComponent(q)}`, {
        headers: igHeaders(session, env),
      });
      const data = await res.json() as { ok: boolean; markets?: IGMarketResult[] };
      if (data.ok && data.markets) {
        // Filter to relevant type
        const typeFilter = category === 'indices' ? 'INDICES' : 'SHARES';
        const filtered = data.markets.filter(m => m.instrumentType === typeFilter).slice(0, 15);
        setSearchResults(filtered);
      }
    } catch { /* ignore */ }
    finally { setSearching(false); }
  }, [session, env, category]);

  const selectMarket = useCallback(async (market: IGMarketResult) => {
    setSelected(market);
    setSearchResults([]);
    setSearchQuery('');
    setResult(null);
    if (!session) return;
    setPriceLoading(true);
    try {
      const res = await fetch(`/api/ig/price?epic=${encodeURIComponent(market.epic)}`, {
        headers: igHeaders(session, env),
      });
      const data = await res.json() as { ok: boolean; bid?: number; offer?: number; percentageChange?: number; high?: number; low?: number };
      if (data.ok) {
        setSelected(prev => prev ? { ...prev, bid: data.bid, offer: data.offer, percentageChange: data.percentageChange, high: data.high, low: data.low } : prev);
      }
    } catch { /* ignore */ }
    finally { setPriceLoading(false); }
  }, [session, env]);

  const selectIndex = useCallback((idx: typeof INDICES[0]) => {
    selectMarket({
      epic: idx.epic,
      instrumentName: idx.name,
      instrumentType: 'INDICES',
      expiry: 'DFB',
    });
  }, [selectMarket]);

  const placeTrade = useCallback(async () => {
    if (!session || !selected) return;
    setPlacing(true);
    setResult(null);
    const currency = category === 'us-shares' ? 'USD' : category === 'uk-shares' ? 'GBP' : currencyForCategory(category);
    try {
      const res = await fetch('/api/ig/order', {
        method: 'POST',
        headers: { ...igHeaders(session, env), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          epic:         selected.epic,
          expiry:       'DFB',
          direction:    trade.direction,
          size:         parseFloat(trade.size) || 1,
          orderType:    'MARKET',
          currencyCode: currency,
          stopDistance:   parseFloat(trade.stopDist) || undefined,
          profitDistance: parseFloat(trade.limitDist) || undefined,
          forceOpen: true,
        }),
      });
      const data = await res.json() as { ok: boolean; dealReference?: string; dealStatus?: string; error?: string };
      if (data.ok) {
        setResult({ ok: true, message: `Deal ${data.dealStatus ?? 'submitted'} — ref: ${data.dealReference ?? '—'}` });
        setSelected(null);
      } else {
        setResult({ ok: false, message: data.error ?? 'Order failed' });
      }
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : 'Network error' });
    } finally { setPlacing(false); }
  }, [session, selected, env, category, trade]);

  if (!session) {
    return (
      <Card>
        <div className="py-8 text-center">
          <p className="text-gray-400 text-sm mb-3">Connect your IG account to trade</p>
          <Button onClick={onConnect}>Connect IG</Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Category tabs */}
      <div className="flex gap-2 flex-wrap">
        {(['indices', 'us-shares', 'uk-shares'] as MarketCategory[]).map(cat => (
          <button
            key={cat}
            onClick={() => { setCategory(cat); setSelected(null); setSearchResults([]); setSearchQuery(''); }}
            className={clsx(
              'px-4 py-1.5 rounded-lg text-sm font-medium transition-colors border',
              category === cat
                ? 'bg-emerald-600/15 text-emerald-400 border-emerald-600/30'
                : 'text-gray-400 border-gray-700 hover:border-gray-600 hover:text-gray-200'
            )}
          >
            {cat === 'indices' ? 'Indices' : cat === 'us-shares' ? 'US Shares' : 'UK Shares'}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Market selector */}
        <Card>
          <CardHeader
            title={category === 'indices' ? 'Select Index' : 'Search Market'}
            subtitle={category === 'indices' ? 'Major global indices' : `Search IG for ${category === 'us-shares' ? 'US' : 'UK'} shares`}
          />

          {category === 'indices' ? (
            <div className="space-y-1.5">
              {INDICES.map(idx => (
                <button
                  key={idx.epic}
                  onClick={() => selectIndex(idx)}
                  className={clsx(
                    'w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-sm transition-colors',
                    selected?.epic === idx.epic
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                      : 'bg-gray-800/50 border-gray-700 text-gray-300 hover:border-gray-500'
                  )}
                >
                  <span className="font-medium">{idx.name}</span>
                  <span className="text-xs text-gray-500 font-mono">{idx.currency}</span>
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="flex gap-2 mb-3">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && searchMarkets(searchQuery)}
                  placeholder={`e.g. ${category === 'us-shares' ? 'Tesla, AAPL, Apple' : 'Lloyds, Vodafone, BARC'}`}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500"
                />
                <Button
                  onClick={() => searchMarkets(searchQuery)}
                  loading={searching}
                  icon={<Search className="h-4 w-4" />}
                >
                  Search
                </Button>
              </div>

              {searchResults.length > 0 && (
                <div className="space-y-1 max-h-56 overflow-y-auto">
                  {searchResults.map(m => (
                    <button
                      key={m.epic}
                      onClick={() => selectMarket(m)}
                      className="w-full text-left px-3 py-2 rounded-lg bg-gray-800/50 hover:bg-gray-800 border border-gray-700 text-sm transition-colors"
                    >
                      <div className="font-medium text-white">{m.instrumentName}</div>
                      <div className="text-xs text-gray-500 font-mono">{m.epic}</div>
                    </button>
                  ))}
                </div>
              )}

              {/* Quick manual EPIC entry for shares */}
              <div className="mt-3 pt-3 border-t border-gray-800">
                <p className="text-xs text-gray-600 mb-2">Or enter ticker directly (e.g. TSLA, AAPL):</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="TICKER"
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 uppercase"
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const ticker = (e.target as HTMLInputElement).value.trim().toUpperCase();
                        if (ticker) {
                          const epic = epicFromTicker(ticker, category);
                          selectMarket({ epic, instrumentName: ticker, instrumentType: 'SHARES', expiry: 'DFB' });
                          (e.target as HTMLInputElement).value = '';
                        }
                      }
                    }}
                  />
                  <span className="text-xs text-gray-500 self-center whitespace-nowrap">→ CS.D.TICKER.TODAY.IP</span>
                </div>
              </div>
            </>
          )}
        </Card>

        {/* Trade ticket */}
        <Card>
          <CardHeader title="Trade Ticket" subtitle={selected ? selected.instrumentName : 'Select a market first'} />

          {!selected ? (
            <div className="py-8 text-center text-gray-600 text-sm">
              Select a market on the left to place a trade
            </div>
          ) : (
            <div className="space-y-4">
              {/* Price display */}
              <div className="bg-gray-800/50 rounded-lg p-3">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs text-gray-500">Epic</span>
                  <span className="text-xs font-mono text-gray-400">{selected.epic}</span>
                </div>
                {priceLoading ? (
                  <div className="flex items-center gap-2 text-sm text-gray-400 py-2">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Fetching price…
                  </div>
                ) : selected.bid !== undefined ? (
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div>
                      <div className="text-xs text-gray-500">Bid</div>
                      <div className="text-lg font-mono font-bold text-red-400">{selected.bid}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500">Offer</div>
                      <div className="text-lg font-mono font-bold text-emerald-400">{selected.offer}</div>
                    </div>
                    {selected.percentageChange !== undefined && (
                      <div className="col-span-2 flex items-center gap-1">
                        {selected.percentageChange >= 0
                          ? <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
                          : <TrendingDown className="h-3.5 w-3.5 text-red-400" />}
                        <span className={clsx('text-sm font-semibold', selected.percentageChange >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {selected.percentageChange >= 0 ? '+' : ''}{selected.percentageChange.toFixed(2)}% today
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-gray-500 py-2">Price unavailable — market may be closed</div>
                )}
              </div>

              {/* Direction */}
              <div className="flex gap-2">
                {(['BUY', 'SELL'] as const).map(dir => (
                  <button
                    key={dir}
                    onClick={() => setTrade(t => ({ ...t, direction: dir }))}
                    className={clsx(
                      'flex-1 py-2.5 rounded-lg font-semibold text-sm transition-colors',
                      trade.direction === dir
                        ? dir === 'BUY' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                    )}
                  >
                    {dir}
                  </button>
                ))}
              </div>

              {/* Size / stops */}
              {[
                { label: 'Size (£/pt)', key: 'size' as const, hint: '£ per point move' },
                { label: 'Stop Distance (pts)', key: 'stopDist' as const, hint: 'Points from entry' },
                { label: 'Limit Distance (pts)', key: 'limitDist' as const, hint: 'Points from entry' },
              ].map(({ label, key, hint }) => (
                <div key={key}>
                  <label className="text-xs text-gray-500 block mb-1">{label}</label>
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={trade[key]}
                    onChange={e => setTrade(t => ({ ...t, [key]: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                  />
                  <p className="text-xs text-gray-600 mt-0.5">{hint}</p>
                </div>
              ))}

              {/* Currency notice */}
              <div className="text-xs text-gray-600 bg-gray-800/30 rounded px-2 py-1.5">
                Currency: <span className="text-gray-400 font-semibold">{currencyForCategory(category)}</span>
                {' · '}Expiry: <span className="text-gray-400 font-semibold">DFB</span>
                {' · '}Env: <span className={clsx('font-semibold', env === 'live' ? 'text-red-400' : 'text-blue-400')}>{env.toUpperCase()}</span>
              </div>

              {result && (
                <div className={clsx(
                  'flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs',
                  result.ok
                    ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                    : 'bg-red-500/10 border border-red-500/30 text-red-400'
                )}>
                  {result.ok ? <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /> : <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />}
                  {result.message}
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  onClick={placeTrade}
                  loading={placing}
                  className={clsx('flex-1', trade.direction === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500')}
                >
                  Place {trade.direction} Order
                </Button>
                <button
                  onClick={() => { setSelected(null); setResult(null); }}
                  className="p-2.5 text-gray-500 hover:text-gray-300 bg-gray-800 rounded-lg transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

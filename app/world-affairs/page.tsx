'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Globe, RefreshCw, ExternalLink, TrendingUp, TrendingDown,
  Minus, AlertTriangle, Clock, BarChart3, Calendar,
  Newspaper, Zap, Info,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useClearGainsStore } from '@/lib/store';
import { Card, CardHeader } from '@/components/ui/Card';
import type { WorldNewsItem, NewsCategory } from '../api/world-affairs/news/route';
import type { IndexQuote, CommodityQuote } from '../api/world-affairs/markets/route';
import type { EconEvent } from '../api/world-affairs/calendar/route';

// ── Cache keys ────────────────────────────────────────────────────────────────
const LS_NEWS_CACHE    = 'wa_news_cache';
const LS_MARKETS_CACHE = 'wa_markets_cache';
const LS_CAL_CACHE     = 'wa_cal_cache';
const NEWS_TTL_MS      = 15 * 60_000;  // 15 min
const MARKETS_TTL_MS   = 60_000;        // 60 s

// ── Category meta ─────────────────────────────────────────────────────────────
const CAT_META: Record<NewsCategory, { label: string; emoji: string; cls: string }> = {
  geopolitical:    { label: 'Geopolitical',   emoji: '🌍', cls: 'bg-red-500/10 border-red-500/20 text-red-400'     },
  economic:        { label: 'Economic',        emoji: '💰', cls: 'bg-amber-500/10 border-amber-500/20 text-amber-400' },
  'central-bank':  { label: 'Central Banks',  emoji: '🏦', cls: 'bg-blue-500/10 border-blue-500/20 text-blue-400'   },
  commodities:     { label: 'Commodities',     emoji: '🛢️', cls: 'bg-orange-500/10 border-orange-500/20 text-orange-400' },
  earnings:        { label: 'Earnings',        emoji: '📊', cls: 'bg-purple-500/10 border-purple-500/20 text-purple-400' },
  'health-crisis': { label: 'Health/Crisis',   emoji: '🦠', cls: 'bg-pink-500/10 border-pink-500/20 text-pink-400'   },
  energy:          { label: 'Energy',          emoji: '⚡', cls: 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400' },
  'tech-regulation':{ label: 'Tech/Regulation',emoji: '🌐', cls: 'bg-cyan-500/10 border-cyan-500/20 text-cyan-400'   },
};

const ALL_CATEGORIES: NewsCategory[] = [
  'geopolitical','economic','central-bank','commodities',
  'earnings','health-crisis','energy','tech-regulation',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtNum(n: number | null, dp = 2): string {
  if (n === null) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function fmtPct(n: number | null): string {
  if (n === null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function minsAgo(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
}
function formatMins(m: number): string {
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function lsGet<T>(key: string, ttlMs: number): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw) as { data: T; ts: number };
    if (Date.now() - ts > ttlMs) return null;
    return data;
  } catch { return null; }
}
function lsSet(key: string, data: unknown) {
  try { localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() })); } catch {}
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function WorldAffairsPage() {
  const { watchlist } = useClearGainsStore();

  const [news,    setNews]    = useState<WorldNewsItem[]>([]);
  const [indices, setIndices] = useState<IndexQuote[]>([]);
  const [commodities, setCommodities] = useState<CommodityQuote[]>([]);
  const [calEvents, setCalEvents]     = useState<EconEvent[]>([]);
  const [calSample, setCalSample]     = useState(false);

  const [newsTs,    setNewsTs]    = useState<string | null>(null);
  const [marketsTs, setMarketsTs] = useState<string | null>(null);

  const [loadingNews,    setLoadingNews]    = useState(false);
  const [loadingMarkets, setLoadingMarkets] = useState(false);

  const [catFilter, setCatFilter] = useState<NewsCategory | 'all'>('all');
  const [sentFilter, setSentFilter] = useState<'all' | 'bullish' | 'bearish'>('all');
  const [countdown, setCountdown] = useState(60);

  const marketsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch news ──────────────────────────────────────────────────────────────
  const fetchNews = useCallback(async (force = false) => {
    if (!force) {
      const cached = lsGet<WorldNewsItem[]>(LS_NEWS_CACHE, NEWS_TTL_MS);
      if (cached) { setNews(cached); return; }
    }
    setLoadingNews(true);
    try {
      const res = await fetch('/api/world-affairs/news');
      if (res.ok) {
        const data = await res.json() as { items: WorldNewsItem[]; timestamp: string };
        setNews(data.items);
        setNewsTs(data.timestamp);
        lsSet(LS_NEWS_CACHE, data.items);
      }
    } catch {}
    setLoadingNews(false);
  }, []);

  // ── Fetch markets (indices + commodities) ───────────────────────────────────
  const fetchMarkets = useCallback(async (force = false) => {
    if (!force) {
      const cached = lsGet<{ indices: IndexQuote[]; commodities: CommodityQuote[]; timestamp: string }>(LS_MARKETS_CACHE, MARKETS_TTL_MS);
      if (cached) { setIndices(cached.indices); setCommodities(cached.commodities); setMarketsTs(cached.timestamp); return; }
    }
    setLoadingMarkets(true);
    try {
      const res = await fetch('/api/world-affairs/markets');
      if (res.ok) {
        const data = await res.json() as { indices: IndexQuote[]; commodities: CommodityQuote[]; timestamp: string };
        setIndices(data.indices);
        setCommodities(data.commodities);
        setMarketsTs(data.timestamp);
        lsSet(LS_MARKETS_CACHE, data);
      }
    } catch {}
    setLoadingMarkets(false);
  }, []);

  // ── Fetch calendar ──────────────────────────────────────────────────────────
  const fetchCalendar = useCallback(async () => {
    const cached = lsGet<{ events: EconEvent[]; isSample: boolean }>(LS_CAL_CACHE, NEWS_TTL_MS);
    if (cached) { setCalEvents(cached.events); setCalSample(cached.isSample); return; }
    try {
      const res = await fetch('/api/world-affairs/calendar');
      if (res.ok) {
        const data = await res.json() as { events: EconEvent[]; isSample: boolean };
        setCalEvents(data.events);
        setCalSample(data.isSample);
        lsSet(LS_CAL_CACHE, { events: data.events, isSample: data.isSample });
      }
    } catch {}
  }, []);

  // ── On mount ────────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchNews();
    fetchMarkets();
    fetchCalendar();

    // Markets: refresh every 60s
    marketsIntervalRef.current = setInterval(() => {
      fetchMarkets(true);
      setCountdown(60);
    }, MARKETS_TTL_MS);

    // News: refresh every 15 min
    const newsInterval = setInterval(() => fetchNews(true), NEWS_TTL_MS);

    return () => {
      if (marketsIntervalRef.current) clearInterval(marketsIntervalRef.current);
      clearInterval(newsInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdown ticker
  useEffect(() => {
    const id = setInterval(() => setCountdown(c => (c <= 1 ? 60 : c - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Watchlist alerts ────────────────────────────────────────────────────────
  const watchlistAlerts = watchlist.length > 0
    ? news.filter(item =>
        watchlist.some(ticker => {
          const base = ticker.replace('.L', '').toUpperCase();
          return item.title.toUpperCase().includes(base) || item.summary.toUpperCase().includes(base);
        })
      ).slice(0, 5)
    : [];

  // ── Filtered news ───────────────────────────────────────────────────────────
  const filteredNews = news.filter(item => {
    if (catFilter !== 'all' && item.category !== catFilter) return false;
    if (sentFilter !== 'all' && item.sentiment !== sentFilter) return false;
    return true;
  });

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Globe className="h-6 w-6 text-emerald-400" />
            World Affairs
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Global events and their market impact · news refreshes every 15 min · prices every 60s
          </p>
        </div>
        <div className="flex items-center gap-3">
          {newsTs && (
            <span className="text-xs text-gray-600 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              News {formatMins(minsAgo(newsTs))}
            </span>
          )}
          <button
            onClick={() => { fetchNews(true); fetchMarkets(true); fetchCalendar(); }}
            disabled={loadingNews || loadingMarkets}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={clsx('h-3 w-3', (loadingNews || loadingMarkets) && 'animate-spin')} />
            Refresh All
          </button>
        </div>
      </div>

      {/* Watchlist alerts */}
      {watchlistAlerts.length > 0 && (
        <div className="space-y-2">
          {watchlistAlerts.map(item => {
            const ticker = watchlist.find(t => {
              const base = t.replace('.L', '').toUpperCase();
              return item.title.toUpperCase().includes(base) || item.summary.toUpperCase().includes(base);
            });
            return (
              <div key={item.id} className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
                <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-semibold text-amber-300">
                    ⚠️ {ticker} on your watchlist
                  </span>
                  <p className="text-xs text-gray-300 mt-0.5 truncate">{item.title}</p>
                </div>
                <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-amber-400 hover:text-amber-300 flex-shrink-0">
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            );
          })}
        </div>
      )}

      {/* Main grid: markets left, news right */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">

        {/* Left: Market Overview */}
        <div className="space-y-4">

          {/* Global Indices */}
          <Card>
            <CardHeader
              title="Global Indices"
              subtitle="ETF proxies · live prices"
              icon={<BarChart3 className="h-4 w-4" />}
              action={
                <span className="text-[10px] text-gray-600 flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {countdown}s
                </span>
              }
            />
            <div className="space-y-1">
              {indices.length === 0 ? (
                <p className="text-xs text-gray-600 text-center py-4">Loading indices…</p>
              ) : indices.map(idx => (
                <div key={idx.symbol} className="flex items-center justify-between py-1.5 border-b border-gray-800/50 last:border-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{idx.flag}</span>
                    <span className="text-xs font-medium text-gray-300">{idx.name}</span>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-mono text-gray-200">
                      {idx.price !== null ? fmtNum(idx.price) : '—'}
                    </div>
                    <div className={clsx('text-[10px] font-mono', idx.changePercent === null ? 'text-gray-600' : idx.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {idx.changePercent !== null ? (
                        <span className="flex items-center gap-0.5 justify-end">
                          {idx.changePercent >= 0 ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                          {fmtPct(idx.changePercent)}
                        </span>
                      ) : '—'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Commodities */}
          <Card>
            <CardHeader
              title="Commodities"
              subtitle="Live & ETF-proxy prices"
              icon={<Zap className="h-4 w-4" />}
            />
            <div className="space-y-1">
              {commodities.length === 0 ? (
                <p className="text-xs text-gray-600 text-center py-4">Loading commodities…</p>
              ) : commodities.map(com => (
                <div key={com.name} className="flex items-center justify-between py-1.5 border-b border-gray-800/50 last:border-0">
                  <div>
                    <p className="text-xs font-medium text-gray-300">{com.name}</p>
                    <p className="text-[10px] text-gray-600">{com.unit} {!com.isLive && <span className="text-gray-700">· approx</span>}</p>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-mono text-gray-200">
                      ${fmtNum(com.price)}
                    </div>
                    <div className={clsx('text-[10px] font-mono', (com.changePercent ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {fmtPct(com.changePercent)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-gray-700 border-t border-gray-800 pt-2">
              Commodity CFDs and ETFs are subject to CGT in the UK. Consult a tax adviser.
            </p>
          </Card>

        </div>

        {/* Right: News Feed */}
        <div className="xl:col-span-2 space-y-4">

          {/* Filters */}
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setCatFilter('all')}
                className={clsx('px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors', catFilter === 'all' ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300' : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300')}
              >
                All categories
              </button>
              {ALL_CATEGORIES.map(cat => (
                <button
                  key={cat}
                  onClick={() => setCatFilter(cat === catFilter ? 'all' : cat)}
                  className={clsx('px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors', catFilter === cat ? `${CAT_META[cat].cls}` : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300')}
                >
                  {CAT_META[cat].emoji} {CAT_META[cat].label}
                </button>
              ))}
            </div>
            <div className="flex gap-1.5">
              {(['all', 'bullish', 'bearish'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setSentFilter(s)}
                  className={clsx('px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors capitalize',
                    sentFilter === s
                      ? s === 'bullish' ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300'
                        : s === 'bearish' ? 'bg-red-500/20 border-red-500/30 text-red-300'
                        : 'bg-gray-700 border-gray-600 text-gray-300'
                      : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300'
                  )}
                >
                  {s === 'all' ? 'All sentiment' : s === 'bullish' ? '📈 Bullish' : '📉 Bearish'}
                </button>
              ))}
              <span className="ml-auto text-xs text-gray-600 self-center">{filteredNews.length} stories</span>
            </div>
          </div>

          {/* News cards */}
          {loadingNews && news.length === 0 ? (
            <div className="text-center py-12 text-gray-600 text-sm">Fetching world news…</div>
          ) : filteredNews.length === 0 ? (
            <div className="text-center py-12 text-gray-600 text-sm">No stories match your filters.</div>
          ) : (
            <div className="space-y-3">
              {filteredNews.map(item => (
                <NewsCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Economic Calendar */}
      <Card>
        <CardHeader
          title="Economic Calendar"
          subtitle={`Next 7 days · high-impact events highlighted${calSample ? ' · sample data' : ''}`}
          icon={<Calendar className="h-4 w-4" />}
        />
        {calSample && (
          <div className="mb-3 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
            <Info className="h-3.5 w-3.5 flex-shrink-0" />
            Showing sample events. Add a FINNHUB_API_KEY to get live economic calendar data.
          </div>
        )}
        {calEvents.length === 0 ? (
          <p className="text-sm text-gray-600 text-center py-6">No upcoming events found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left py-2 pr-4">Event</th>
                  <th className="text-center py-2 pr-4">Country</th>
                  <th className="text-center py-2 pr-4">Date</th>
                  <th className="text-center py-2 pr-4">Time</th>
                  <th className="text-center py-2 pr-4">Impact</th>
                  <th className="text-right py-2 pr-4">Previous</th>
                  <th className="text-right py-2">Forecast</th>
                </tr>
              </thead>
              <tbody>
                {calEvents.map(ev => (
                  <tr key={ev.id} className={clsx('border-b border-gray-800/50', ev.impact === 'high' && 'bg-red-500/5')}>
                    <td className="py-2 pr-4">
                      <span className={clsx('font-medium', ev.impact === 'high' ? 'text-white' : 'text-gray-300')}>
                        {ev.impact === 'high' && <span className="text-red-400 mr-1">🔴</span>}
                        {ev.impact === 'medium' && <span className="text-amber-400 mr-1">🟡</span>}
                        {ev.impact === 'low' && <span className="text-gray-600 mr-1">⚪</span>}
                        {ev.event}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-center">
                      <span className="text-sm" title={ev.country}>{ev.flag}</span>
                      <span className="text-gray-600 ml-1">{ev.country}</span>
                    </td>
                    <td className="py-2 pr-4 text-center text-gray-400 font-mono">
                      {ev.date ? new Date(ev.date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'}
                    </td>
                    <td className="py-2 pr-4 text-center text-gray-500">{ev.time}</td>
                    <td className="py-2 pr-4 text-center">
                      <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold',
                        ev.impact === 'high'   ? 'bg-red-500/20 text-red-400' :
                        ev.impact === 'medium' ? 'bg-amber-500/20 text-amber-400' :
                                                  'bg-gray-700 text-gray-500')}>
                        {ev.impact.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-right font-mono text-gray-500">{ev.prev}</td>
                    <td className="py-2 text-right font-mono text-gray-400">{ev.estimate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

    </div>
  );
}

// ── News Card ─────────────────────────────────────────────────────────────────
function NewsCard({ item }: { item: WorldNewsItem }) {
  const [expanded, setExpanded] = useState(false);
  const meta = CAT_META[item.category];
  const hasSectors  = item.sectorImpacts.length > 0;
  const hasCurrency = item.currencyImpacts.length > 0;
  const hasCommodity= item.commodityImpacts.length > 0;
  const hasImpact   = hasSectors || hasCurrency || hasCommodity || item.assetImpacts.length > 0;

  return (
    <div className={clsx('bg-gray-900 border rounded-xl p-4 transition-colors', item.sentiment === 'bullish' ? 'border-emerald-900/40' : item.sentiment === 'bearish' ? 'border-red-900/40' : 'border-gray-800')}>

      {/* Top row: category + sentiment + time */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className={clsx('px-2 py-0.5 rounded-full text-[10px] font-semibold border', meta.cls)}>
          {meta.emoji} {meta.label}
        </span>
        <span className={clsx('px-2 py-0.5 rounded-full text-[10px] font-semibold border',
          item.sentiment === 'bullish' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' :
          item.sentiment === 'bearish' ? 'bg-red-500/10 border-red-500/20 text-red-400' :
          'bg-gray-800 border-gray-700 text-gray-500')}>
          {item.sentiment === 'bullish' ? '📈' : item.sentiment === 'bearish' ? '📉' : '➖'} {item.sentiment} {item.confidence}%
        </span>
        <span className="ml-auto text-[10px] text-gray-600">{item.relativeTime} · {item.source}</span>
      </div>

      {/* Headline */}
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm font-semibold text-white hover:text-emerald-300 transition-colors leading-snug flex items-start gap-1 group"
      >
        <span>{item.title}</span>
        <ExternalLink className="h-3 w-3 flex-shrink-0 mt-0.5 text-gray-600 group-hover:text-emerald-400 transition-colors" />
      </a>

      {/* Asset impacts (always visible) */}
      {item.assetImpacts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {item.assetImpacts.slice(0, 4).map((ai, i) => (
            <span key={i} className={clsx('text-[10px] px-1.5 py-0.5 rounded border flex items-center gap-1',
              ai.direction === 'bullish' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' :
              ai.direction === 'bearish' ? 'bg-red-500/10 border-red-500/20 text-red-400' :
              'bg-gray-800 border-gray-700 text-gray-500')}>
              {ai.direction === 'bullish' ? <TrendingUp className="h-2.5 w-2.5" /> : ai.direction === 'bearish' ? <TrendingDown className="h-2.5 w-2.5" /> : <Minus className="h-2.5 w-2.5" />}
              {ai.asset}
            </span>
          ))}
          {hasImpact && (
            <button onClick={() => setExpanded(e => !e)} className="text-[10px] text-gray-600 hover:text-gray-400 flex items-center gap-0.5">
              <Newspaper className="h-2.5 w-2.5" />
              {expanded ? 'less' : 'more detail'}
            </button>
          )}
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="mt-3 space-y-2 border-t border-gray-800 pt-3">
          {item.summary && (
            <p className="text-xs text-gray-500 leading-relaxed">{item.summary}</p>
          )}
          {hasSectors && (
            <div>
              <p className="text-[10px] text-gray-600 font-semibold mb-1">SECTOR IMPACT</p>
              <div className="flex flex-wrap gap-1.5">
                {item.sectorImpacts.map((s, i) => (
                  <span key={i} className={clsx('text-[10px] px-1.5 py-0.5 rounded border',
                    s.direction === 'bullish' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400')}>
                    {s.sector}: {s.direction}
                  </span>
                ))}
              </div>
            </div>
          )}
          {hasCurrency && (
            <div>
              <p className="text-[10px] text-gray-600 font-semibold mb-1">CURRENCY IMPACT</p>
              <div className="flex flex-wrap gap-1.5">
                {item.currencyImpacts.map((c, i) => (
                  <span key={i} className={clsx('text-[10px] px-1.5 py-0.5 rounded border',
                    c.direction === 'strengthen' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400')}>
                    {c.currency} likely to {c.direction}
                  </span>
                ))}
              </div>
            </div>
          )}
          {hasCommodity && (
            <div>
              <p className="text-[10px] text-gray-600 font-semibold mb-1">COMMODITY IMPACT</p>
              <div className="flex flex-wrap gap-1.5">
                {item.commodityImpacts.map((c, i) => (
                  <span key={i} className={clsx('text-[10px] px-1.5 py-0.5 rounded border',
                    c.direction === 'rise' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400')}>
                    {c.commodity} likely to {c.direction} — {c.reason}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

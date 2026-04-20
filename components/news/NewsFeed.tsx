'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { RefreshCw, Newspaper, AlertCircle, ToggleLeft, ToggleRight, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { LiveTimer, LiveCountdown } from '@/components/ui/LiveTimer';
import type { NewsSignal } from '@/app/api/news/analyse/route';

interface NewsItem {
  headline: string;
  source: string;
  datetime: number;
  url: string;
  summary: string;
  category: string;
}

interface AnalysedNewsItem extends NewsItem {
  signal: NewsSignal | null;
  actionTaken?: 'OPENED_LONG' | 'CLOSED_POSITION' | 'SIGNAL_QUEUED' | 'NO_ACTION';
  actionDetail?: string;
  analysedAt: string;
}

interface TradeDecision {
  id: string;
  ts: string;
  asset: string;
  decision: 'BUY' | 'SELL' | 'CLOSE';
  reasoning: string;
  confidence: number;
  result: 'success' | 'error' | 'queued';
  detail: string;
  pnl?: number;
}

interface NewsSettings {
  enabled: boolean;
  minConfidence: number;
  onlyHighUrgencyClose: boolean;
  maxPositionsPerDay: number;
  excludedAssets: string[];
}

const DEFAULT_SETTINGS: NewsSettings = {
  enabled: false,
  minConfidence: 70,
  onlyHighUrgencyClose: true,
  maxPositionsPerDay: 3,
  excludedAssets: [],
};

const SCAN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const STORAGE_KEY_FEED = 'news_feed';
const STORAGE_KEY_DECISIONS = 'news_decisions';
const STORAGE_KEY_SETTINGS = 'news_settings';

function timeAgo(ts: number | string): string {
  const ms = Date.now() - (typeof ts === 'string' ? new Date(ts).getTime() : ts * 1000);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function SentimentBadge({ s }: { s: 'BULLISH' | 'BEARISH' | 'NEUTRAL' }) {
  return (
    <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full font-semibold flex-shrink-0',
      s === 'BULLISH' ? 'bg-emerald-500/20 text-emerald-400' :
      s === 'BEARISH' ? 'bg-red-500/20 text-red-400' :
      'bg-gray-700 text-gray-400'
    )}>{s}</span>
  );
}

function ActionBadge({ a }: { a: AnalysedNewsItem['actionTaken'] }) {
  if (!a) return null;
  const map: Record<string, [string, string]> = {
    OPENED_LONG:     ['OPENED LONG',      'bg-emerald-500/20 text-emerald-400'],
    CLOSED_POSITION: ['CLOSED POSITION',  'bg-red-500/20 text-red-400'],
    SIGNAL_QUEUED:   ['SIGNAL QUEUED',    'bg-amber-500/20 text-amber-400'],
    NO_ACTION:       ['NO ACTION',        'bg-gray-700 text-gray-500'],
  };
  const [label, cls] = map[a] ?? ['UNKNOWN', 'bg-gray-700 text-gray-500'];
  return <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full font-semibold', cls)}>{label}</span>;
}

export function NewsFeed({
  openPositions = [],
  watchlist = [],
  onNewsAction,
}: {
  openPositions?: { symbol: string; direction: string; size: number }[];
  watchlist?: string[];
  onNewsAction?: (action: string, asset: string, reasoning: string, confidence: number) => void;
}) {
  const [settings, setSettings] = useState<NewsSettings>(DEFAULT_SETTINGS);
  const [feed, setFeed] = useState<AnalysedNewsItem[]>([]);
  const [decisions, setDecisions] = useState<TradeDecision[]>([]);
  const [scanning, setScanning] = useState(false);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [nextScanAt, setNextScanAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [showSettings, setShowSettings] = useState(false);
  const [excludeInput, setExcludeInput] = useState('');
  const [activeTab, setActiveTab] = useState<'feed' | 'decisions'>('feed');
  const scanTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const settingsRef = useRef(settings);
  const decisionsCountRef = useRef(0);

  // Load persisted data on mount
  useEffect(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY_SETTINGS);
      if (s) setSettings(JSON.parse(s) as NewsSettings);
      const f = localStorage.getItem(STORAGE_KEY_FEED);
      if (f) setFeed(JSON.parse(f) as AnalysedNewsItem[]);
      const d = localStorage.getItem(STORAGE_KEY_DECISIONS);
      if (d) setDecisions(JSON.parse(d) as TradeDecision[]);
    } catch {}
  }, []);

  useEffect(() => { settingsRef.current = settings; }, [settings]);

  function saveSettings(s: NewsSettings) {
    setSettings(s);
    try { localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(s)); } catch {}
  }

  function updateFeed(items: AnalysedNewsItem[]) {
    setFeed(items);
    try { localStorage.setItem(STORAGE_KEY_FEED, JSON.stringify(items.slice(0, 100))); } catch {}
  }

  function addDecision(d: TradeDecision) {
    setDecisions(prev => {
      const updated = [d, ...prev].slice(0, 50);
      try { localStorage.setItem(STORAGE_KEY_DECISIONS, JSON.stringify(updated)); } catch {}
      return updated;
    });
  }

  const runScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setError(null);

    try {
      // Fetch Finnhub headlines
      const [generalRes, forexRes] = await Promise.allSettled([
        fetch('/api/news/finnhub?category=general').then(r => r.json()),
        fetch('/api/news/finnhub?category=forex').then(r => r.json()),
      ]);

      const raw: NewsItem[] = [];
      if (generalRes.status === 'fulfilled') raw.push(...((generalRes.value as { articles?: NewsItem[] }).articles ?? []));
      if (forexRes.status === 'fulfilled')   raw.push(...((forexRes.value as { articles?: NewsItem[] }).articles ?? []));

      // Deduplicate by id
      const seen = new Set<string>();
      const headlines = raw.filter(a => {
        if (seen.has(a.headline)) return false;
        seen.add(a.headline);
        return true;
      }).slice(0, 40);

      if (!headlines.length) {
        setError('No headlines fetched from Finnhub');
        return;
      }

      // Call Claude analysis
      const analyseRes = await fetch('/api/news/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headlines: headlines.map(h => ({ headline: h.headline, source: h.source, datetime: new Date(h.datetime * 1000).toLocaleTimeString('en-GB') })),
          openPositions,
          watchlist,
        }),
      });

      const analyseData = await analyseRes.json() as { analysis: NewsSignal[]; success: boolean };
      const signals = analyseData.analysis ?? [];

      // Match signals back to headlines
      const analysed: AnalysedNewsItem[] = headlines.map(h => {
        const signal = signals.find(s => s.headline === h.headline || h.headline.includes(s.headline.slice(0, 30)));
        let actionTaken: AnalysedNewsItem['actionTaken'] = signal ? 'NO_ACTION' : undefined;
        let actionDetail = '';

        if (signal && settingsRef.current.enabled) {
          const { action, confidence, urgency } = signal;
          const minConf = settingsRef.current.minConfidence;
          const todayDecisions = decisionsCountRef.current;
          const maxPos = settingsRef.current.maxPositionsPerDay;
          const isExcluded = signal.affectedAssets.some(a => settingsRef.current.excludedAssets.includes(a));

          if (!isExcluded && todayDecisions < maxPos) {
            if ((action === 'CLOSE_LONG' || action === 'CLOSE_SHORT') && confidence > 75
              && (!settingsRef.current.onlyHighUrgencyClose || urgency === 'HIGH')) {
              actionTaken = 'CLOSED_POSITION';
              actionDetail = `Confidence ${confidence}% — ${signal.reasoning}`;
              decisionsCountRef.current++;
              addDecision({ id: Math.random().toString(36).slice(2), ts: new Date().toISOString(), asset: signal.affectedAssets[0] ?? '?', decision: 'CLOSE', reasoning: signal.reasoning, confidence, result: 'queued', detail: actionDetail });
              onNewsAction?.('CLOSE', signal.affectedAssets[0] ?? '?', signal.reasoning, confidence);
            } else if ((action === 'OPEN_LONG') && confidence > minConf) {
              actionTaken = 'SIGNAL_QUEUED';
              actionDetail = `Queued BUY ${signal.affectedAssets[0]} — ${signal.reasoning}`;
              decisionsCountRef.current++;
              addDecision({ id: Math.random().toString(36).slice(2), ts: new Date().toISOString(), asset: signal.affectedAssets[0] ?? '?', decision: 'BUY', reasoning: signal.reasoning, confidence, result: 'queued', detail: actionDetail });
              onNewsAction?.('OPEN_LONG', signal.affectedAssets[0] ?? '?', signal.reasoning, confidence);
            } else if ((action === 'OPEN_SHORT') && confidence > minConf) {
              actionTaken = 'SIGNAL_QUEUED';
              actionDetail = `Queued SHORT ${signal.affectedAssets[0]} — ${signal.reasoning}`;
              decisionsCountRef.current++;
              addDecision({ id: Math.random().toString(36).slice(2), ts: new Date().toISOString(), asset: signal.affectedAssets[0] ?? '?', decision: 'SELL', reasoning: signal.reasoning, confidence, result: 'queued', detail: actionDetail });
              onNewsAction?.('OPEN_SHORT', signal.affectedAssets[0] ?? '?', signal.reasoning, confidence);
            }
          }
        }

        return { ...h, signal: signal ?? null, actionTaken, actionDetail, analysedAt: new Date().toISOString() };
      });

      updateFeed(analysed);
      setLastScanAt(Date.now());
      setNextScanAt(Date.now() + SCAN_INTERVAL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }, [scanning, openPositions, watchlist, onNewsAction]);

  // Auto-scan when enabled
  useEffect(() => {
    if (!settings.enabled) {
      if (scanTimerRef.current) { clearInterval(scanTimerRef.current); scanTimerRef.current = null; }
      setNextScanAt(null);
      return;
    }

    // Run immediately on enable, then every 15 min
    void runScan();
    scanTimerRef.current = setInterval(() => void runScan(), SCAN_INTERVAL_MS);
    return () => { if (scanTimerRef.current) clearInterval(scanTimerRef.current); };
  }, [settings.enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleExpand(idx: number) {
    setExpanded(prev => { const n = new Set(prev); n.has(idx) ? n.delete(idx) : n.add(idx); return n; });
  }

  const analysedItems = feed.filter(f => f.signal);
  const allItems = feed;

  return (
    <div className="space-y-4">
      {/* Header / Monitor status */}
      <Card>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Newspaper className="h-4 w-4 text-amber-400" />
            <div>
              <p className="text-sm font-semibold text-white">News Monitor</p>
              <p className="text-[11px] text-gray-500">
                {settings.enabled ? (
                  <>
                    <span className="text-emerald-400 font-medium">ACTIVE</span>
                    {nextScanAt && <> · next scan in <LiveCountdown until={nextScanAt} className="text-amber-400 font-mono" /></>}
                    {lastScanAt && <> · last <LiveTimer since={lastScanAt} className="text-gray-400" /> ago</>}
                  </>
                ) : 'INACTIVE — enable to start monitoring'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              loading={scanning}
              onClick={() => void runScan()}
              icon={<RefreshCw className="h-3.5 w-3.5" />}
            >
              Scan Now
            </Button>
            <button
              onClick={() => saveSettings({ ...settings, enabled: !settings.enabled })}
              className="flex items-center gap-1.5 text-xs"
            >
              {settings.enabled
                ? <ToggleRight className="h-5 w-5 text-emerald-400" />
                : <ToggleLeft className="h-5 w-5 text-gray-600" />}
              <span className={settings.enabled ? 'text-emerald-400' : 'text-gray-500'}>
                {settings.enabled ? 'News Trading ON' : 'News Trading OFF'}
              </span>
            </button>
            <button
              onClick={() => setShowSettings(s => !s)}
              className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
            >
              Settings
            </button>
          </div>
        </div>

        {/* Settings panel */}
        {showSettings && (
          <div className="mt-4 pt-4 border-t border-gray-800 space-y-4">
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Minimum Confidence: <span className="text-amber-400">{settings.minConfidence}%</span></label>
              <input type="range" min={60} max={90} value={settings.minConfidence}
                onChange={e => saveSettings({ ...settings, minConfidence: Number(e.target.value) })}
                className="w-full accent-amber-500" />
              <div className="flex justify-between text-[10px] text-gray-600 mt-0.5"><span>60%</span><span>90%</span></div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">Only close positions on HIGH urgency</span>
              <button onClick={() => saveSettings({ ...settings, onlyHighUrgencyClose: !settings.onlyHighUrgencyClose })}>
                {settings.onlyHighUrgencyClose
                  ? <ToggleRight className="h-5 w-5 text-emerald-400" />
                  : <ToggleLeft className="h-5 w-5 text-gray-600" />}
              </button>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Max positions per day: <span className="text-amber-400">{settings.maxPositionsPerDay}</span></label>
              <input type="range" min={1} max={10} value={settings.maxPositionsPerDay}
                onChange={e => saveSettings({ ...settings, maxPositionsPerDay: Number(e.target.value) })}
                className="w-full accent-amber-500" />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Excluded assets (comma-separated)</label>
              <div className="flex gap-2">
                <input
                  value={excludeInput}
                  onChange={e => setExcludeInput(e.target.value)}
                  placeholder="AAPL, BTC, GBP/USD…"
                  className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-amber-500"
                />
                <Button size="sm" variant="outline" onClick={() => {
                  const toAdd = excludeInput.split(',').map(s => s.trim()).filter(Boolean);
                  saveSettings({ ...settings, excludedAssets: [...new Set([...settings.excludedAssets, ...toAdd])] });
                  setExcludeInput('');
                }}>Add</Button>
              </div>
              {settings.excludedAssets.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {settings.excludedAssets.map(a => (
                    <span key={a} className="flex items-center gap-0.5 text-[10px] bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">
                      {a}
                      <button onClick={() => saveSettings({ ...settings, excludedAssets: settings.excludedAssets.filter(x => x !== a) })}
                        className="text-gray-600 hover:text-red-400 ml-0.5">×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      {error && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-400">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Tab switcher */}
      <div className="flex gap-1 bg-gray-800/60 rounded-xl p-1 w-fit">
        {(['feed', 'decisions'] as const).map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={clsx('px-4 py-1.5 rounded-lg text-sm font-medium transition-all',
              activeTab === t ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'text-gray-500 hover:text-gray-300'
            )}>
            {t === 'feed' ? `News Feed${analysedItems.length > 0 ? ` (${analysedItems.length})` : ''}` : `Decisions${decisions.length > 0 ? ` (${decisions.length})` : ''}`}
          </button>
        ))}
      </div>

      {activeTab === 'feed' && (
        <div className="space-y-2">
          {allItems.length === 0 && (
            <div className="text-center py-12 text-gray-600">
              <Newspaper className="h-10 w-10 mx-auto mb-3 opacity-20" />
              <p className="text-sm">No news yet</p>
              <p className="text-xs mt-1">{settings.enabled ? 'Scan will run automatically every 15 minutes' : 'Enable News Monitor or click Scan Now'}</p>
            </div>
          )}
          {allItems.map((item, idx) => {
            const isExp = expanded.has(idx);
            return (
              <div key={idx} className={clsx('rounded-xl border p-3 transition-all',
                item.signal?.sentiment === 'BULLISH' ? 'border-emerald-500/20 bg-emerald-500/[0.03]' :
                item.signal?.sentiment === 'BEARISH' ? 'border-red-500/20 bg-red-500/[0.03]' :
                'border-gray-800 bg-gray-900/40'
              )}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap mb-1">
                      {item.signal?.sentiment && <SentimentBadge s={item.signal.sentiment} />}
                      {item.signal?.urgency === 'HIGH' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 font-bold">HIGH</span>
                      )}
                      <ActionBadge a={item.actionTaken} />
                    </div>
                    <p className="text-xs text-white leading-snug">{item.headline}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-[10px] text-gray-600">{item.source} · {timeAgo(item.datetime)}</span>
                      {item.signal?.confidence !== undefined && (
                        <span className="text-[10px] text-gray-500">{item.signal.confidence}% confidence</span>
                      )}
                      {item.signal?.affectedAssets && item.signal.affectedAssets.length > 0 && (
                        <div className="flex gap-1">
                          {item.signal.affectedAssets.map(a => (
                            <span key={a} className="text-[10px] px-1 py-0 rounded bg-gray-800 text-gray-400 font-mono">{a}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    {item.signal?.reasoning && (
                      <p className="text-[11px] text-gray-500 mt-1 italic">{item.signal.reasoning}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {item.url && (
                      <a href={item.url} target="_blank" rel="noopener noreferrer"
                        className="p-1 text-gray-600 hover:text-amber-400 transition-colors">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                    {item.summary && (
                      <button onClick={() => toggleExpand(idx)} className="p-1 text-gray-600 hover:text-gray-300">
                        {isExp ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      </button>
                    )}
                  </div>
                </div>
                {isExp && item.summary && (
                  <p className="mt-2 pt-2 border-t border-gray-800 text-[11px] text-gray-400 leading-relaxed">{item.summary}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'decisions' && (
        <div className="space-y-2">
          {decisions.length === 0 && (
            <div className="text-center py-12 text-gray-600">
              <p className="text-sm">No trade decisions yet</p>
              <p className="text-xs mt-1">News-driven trades will appear here</p>
            </div>
          )}
          {decisions.map(d => (
            <div key={d.id} className="rounded-xl border border-gray-800 bg-gray-900/40 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full font-bold',
                      d.decision === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' :
                      d.decision === 'SELL' ? 'bg-red-500/20 text-red-400' :
                      'bg-amber-500/20 text-amber-400'
                    )}>{d.decision}</span>
                    <span className="text-xs font-semibold text-white">{d.asset}</span>
                    <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full',
                      d.result === 'success' ? 'bg-emerald-500/20 text-emerald-400' :
                      d.result === 'error' ? 'bg-red-500/20 text-red-400' :
                      'bg-gray-700 text-gray-400'
                    )}>{d.result}</span>
                  </div>
                  <p className="text-[11px] text-gray-400">{d.reasoning}</p>
                  <p className="text-[11px] text-gray-600">{d.detail}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-[10px] text-gray-600">{new Date(d.ts).toLocaleTimeString('en-GB')}</p>
                  <p className="text-[10px] text-gray-600">{d.confidence}% conf</p>
                  {d.pnl !== undefined && (
                    <p className={clsx('text-xs font-mono font-semibold', d.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {d.pnl >= 0 ? '+' : ''}£{d.pnl.toFixed(2)}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

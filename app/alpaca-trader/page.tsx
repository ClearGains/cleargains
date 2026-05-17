'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Power, Square, Pause, Play, AlertTriangle, RefreshCw,
  TrendingUp, TrendingDown, DollarSign, BarChart2, Clock,
  ShieldAlert, Sparkles, Newspaper, CheckCircle, ChevronDown, ChevronUp,
  Server, WifiOff, Wifi,
} from 'lucide-react';
import { clsx } from 'clsx';

// ── Types ─────────────────────────────────────────────────────────────────────

type AccountMode = 'paper' | 'live';
type StrategyName = 'rsi_mean_reversion' | 'ema_crossover' | 'orb' | 'vwap' | 'weekly_momentum';

type AlpacaPosition = {
  symbol:           string;
  qty:              string;
  side:             'long' | 'short';
  unrealized_pl:    string;
  unrealized_plpc:  string;
  current_price:    string;
  avg_entry_price:  string;
};

type LogEntry = {
  id:     string;
  ts:     string;
  type:   'info' | 'enter' | 'exit' | 'wait' | 'error';
  symbol: string;
  msg:    string;
};

type BotStatus = {
  running:     boolean;
  paused:      boolean;
  mode:        AccountMode;
  strategy:    StrategyName;
  symbols:     string[];
  equity:      string;
  cash:        string;
  positions:   AlpacaPosition[];
  log:         LogEntry[];
  nextRunMs:   number | null;
  lastPollTs:  string | null;
};

type ServerHealth = 'checking' | 'online' | 'offline' | 'misconfigured';

type KeyHeadline = {
  headline:  string;
  source:    string;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
};

type StrategyRecommendation = {
  strategy:         StrategyName;
  confidence:       number;
  marketCondition:  string;
  reasoning:        string;
  suggestedSymbols: string[];
  allowShorts:      boolean;
  keyHeadlines:     KeyHeadline[];
  generatedAt:      string;
  engine?:          'gemini' | 'rules';
};

// ── Strategy definitions ──────────────────────────────────────────────────────

const STRATEGIES: { value: StrategyName; label: string; timeframe: string; description: string }[] = [
  {
    value:       'rsi_mean_reversion',
    label:       'RSI Mean Reversion',
    timeframe:   'Intraday (5-min)',
    description: 'Buy RSI < 30, sell RSI > 70. Best for volatile large-caps. Stop: 1.5× ATR.',
  },
  {
    value:       'ema_crossover',
    label:       'EMA Crossover',
    timeframe:   'Swing (Daily)',
    description: 'Enter on EMA9 × EMA21 crossover. Hold days to weeks. Stop: 2× ATR.',
  },
  {
    value:       'orb',
    label:       'Opening Range Breakout',
    timeframe:   'Intraday (Daily)',
    description: 'Trade breakouts above/below the first 30-min range. Exit at EOD or midpoint stop.',
  },
  {
    value:       'vwap',
    label:       'VWAP Reversion',
    timeframe:   'Intraday (1-min)',
    description: 'Buy when price dips 0.5% below VWAP + RSI < 45. Exit when price returns to VWAP.',
  },
  {
    value:       'weekly_momentum',
    label:       'Weekly Momentum',
    timeframe:   'Position (Weekly)',
    description: 'Buy when above 12-week SMA + 4-week momentum > 1% + RSI 50–70. Trail 5% stop.',
  },
];

const DEFAULT_SYMBOLS: Record<StrategyName, string> = {
  rsi_mean_reversion: 'SPY,QQQ,AAPL,MSFT,NVDA',
  ema_crossover:      'SPY,QQQ,AAPL,MSFT,NVDA,AMZN',
  orb:                'SPY,QQQ,AAPL,TSLA,NVDA',
  vwap:               'SPY,QQQ,AAPL,MSFT',
  weekly_momentum:    'XLK,XLF,XLE,XLV,XLY,SPY',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPnl(val: string): string {
  const n = parseFloat(val);
  return `${n >= 0 ? '+' : ''}$${Math.abs(n).toFixed(2)}`;
}

function logColor(type: LogEntry['type']): string {
  switch (type) {
    case 'enter': return 'text-green-400';
    case 'exit':  return 'text-red-400';
    case 'error': return 'text-rose-400';
    case 'wait':  return 'text-slate-500';
    default:      return 'text-slate-300';
  }
}

function logIcon(type: LogEntry['type']): string {
  switch (type) {
    case 'enter': return '↑';
    case 'exit':  return '↓';
    case 'error': return '✗';
    case 'wait':  return '…';
    default:      return '·';
  }
}

function sentimentBadge(s: KeyHeadline['sentiment']) {
  return s === 'BULLISH'
    ? 'bg-green-500/15 text-green-400 border-green-500/30'
    : s === 'BEARISH'
    ? 'bg-red-500/15 text-red-400 border-red-500/30'
    : 'bg-slate-700/50 text-slate-400 border-slate-600/40';
}

const STRATEGY_LABEL: Record<StrategyName, string> = {
  rsi_mean_reversion: 'RSI Mean Reversion',
  ema_crossover:      'EMA Crossover',
  orb:                'Opening Range Breakout',
  vwap:               'VWAP Reversion',
  weekly_momentum:    'Weekly Momentum',
};

// ── Server health hook ────────────────────────────────────────────────────────

function useServerHealth(): { health: ServerHealth; lastChecked: string | null; retry: () => void } {
  const [health, setHealth]           = useState<ServerHealth>('checking');
  const [lastChecked, setLastChecked] = useState<string | null>(null);

  const check = useCallback(async () => {
    setHealth('checking');
    try {
      const res  = await fetch('/api/ig/bot?action=health', { signal: AbortSignal.timeout(6_000) });
      const data = await res.json() as { ok?: boolean; error?: string };

      if (res.status === 503) {
        setHealth('misconfigured');
      } else if (res.status === 502 || !data.ok) {
        setHealth('offline');
      } else {
        setHealth('online');
      }
    } catch {
      setHealth('offline');
    }
    setLastChecked(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  }, []);

  useEffect(() => {
    void check();
    const t = setInterval(() => { void check(); }, 30_000);
    return () => clearInterval(t);
  }, [check]);

  return { health, lastChecked, retry: check };
}

// ── Server status banner ──────────────────────────────────────────────────────

function ServerStatusBanner({ health, lastChecked, retry }: ReturnType<typeof useServerHealth>) {
  if (health === 'online') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/8 border border-green-500/20 text-xs text-green-400">
        <Wifi className="w-3.5 h-3.5 shrink-0" />
        <span>Bot server <strong>online</strong></span>
        {lastChecked && <span className="text-green-600 ml-auto">checked {lastChecked}</span>}
      </div>
    );
  }

  if (health === 'checking') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/60 border border-slate-700 text-xs text-slate-400">
        <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" />
        <span>Checking bot server…</span>
      </div>
    );
  }

  if (health === 'misconfigured') {
    return (
      <div className="px-3 py-2.5 rounded-lg bg-amber-500/8 border border-amber-500/25 text-xs text-amber-300 space-y-1.5">
        <div className="flex items-center gap-2">
          <Server className="w-3.5 h-3.5 shrink-0" />
          <span className="font-medium">BOT_SERVER_URL not configured</span>
        </div>
        <p className="text-amber-500 leading-relaxed">
          The bot server URL is missing. Add <code className="text-amber-300">BOT_SERVER_URL=http://&lt;your-vm-ip&gt;:3001</code> and{' '}
          <code className="text-amber-300">BOT_SECRET</code> to your Vercel environment variables, then redeploy.
        </p>
      </div>
    );
  }

  // offline
  return (
    <div className="px-3 py-2.5 rounded-lg bg-rose-500/8 border border-rose-500/25 text-xs text-rose-300 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <WifiOff className="w-3.5 h-3.5 shrink-0" />
          <span className="font-medium">Bot server offline or unreachable</span>
        </div>
        <button
          onClick={retry}
          className="flex items-center gap-1 px-2 py-1 rounded bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Retry
        </button>
      </div>
      <div className="text-rose-400/80 space-y-1">
        <p className="font-medium text-rose-300">To start the bot server:</p>
        <p><strong>Locally:</strong> open a second terminal and run:</p>
        <pre className="bg-slate-900 rounded px-2 py-1.5 text-slate-300 overflow-x-auto">cd bot-server{'\n'}npm run dev</pre>
        <p><strong>On Oracle Cloud:</strong> SSH into your VM and run:</p>
        <pre className="bg-slate-900 rounded px-2 py-1.5 text-slate-300 overflow-x-auto">pm2 start ecosystem.config.cjs{'\n'}pm2 status</pre>
        {lastChecked && <p className="text-rose-600">Last checked: {lastChecked}</p>}
      </div>
    </div>
  );
}

// ── Recommendation panel ──────────────────────────────────────────────────────

function RecommendationPanel({
  onApply,
  isRunning,
}: {
  onApply: (rec: StrategyRecommendation) => void;
  isRunning: boolean;
}) {
  const [rec, setRec]             = useState<StrategyRecommendation | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [expanded, setExpanded]   = useState(true);
  const [applied, setApplied]     = useState(false);

  const fetchRec = useCallback(async () => {
    setLoading(true);
    setError(null);
    setApplied(false);
    try {
      const res  = await fetch('/api/alpaca/recommend');
      const data = await res.json() as { recommendation: StrategyRecommendation | null; success: boolean; error?: string };
      if (!data.success || !data.recommendation) {
        setError(data.error ?? 'No recommendation returned');
        return;
      }
      setRec(data.recommendation);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch recommendation');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchRec(); }, [fetchRec]);

  const handleApply = () => {
    if (!rec) return;
    onApply(rec);
    setApplied(true);
  };

  const confidenceColor =
    !rec                  ? 'bg-slate-600' :
    rec.confidence >= 80  ? 'bg-green-500'  :
    rec.confidence >= 60  ? 'bg-indigo-500' :
                            'bg-amber-500';

  return (
    <div className="bg-slate-900/70 border border-indigo-500/20 rounded-xl overflow-hidden">
      {/* Header row */}
      <div
        className="px-4 py-3 flex items-center justify-between cursor-pointer select-none"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-semibold text-slate-200">AI Strategy Recommendation</span>
          {rec && (
            <>
              <span className="text-xs text-slate-500">
                · {new Date(rec.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${rec.engine === 'gemini' ? 'bg-indigo-500/20 text-indigo-300' : 'bg-slate-700 text-slate-400'}`}>
                {rec.engine === 'gemini' ? 'Gemini' : 'Rules'}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={e => { e.stopPropagation(); void fetchRec(); }}
            className="p-1 rounded hover:bg-slate-700 text-slate-400"
            title="Refresh recommendation"
          >
            <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
          {expanded ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-slate-800">
          {loading && !rec && (
            <div className="px-4 py-6 flex items-center justify-center gap-2 text-slate-500 text-sm">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Analysing today&apos;s market news…
            </div>
          )}

          {error && (
            <div className="px-4 py-3 flex items-start gap-2 text-rose-400 text-xs">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {error}
            </div>
          )}

          {rec && (
            <div className="p-4 space-y-4">
              {/* Recommended strategy + confidence */}
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1.5 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-lg font-bold text-white">{STRATEGY_LABEL[rec.strategy]}</span>
                    <span className="text-xs bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 px-2 py-0.5 rounded-full">
                      {STRATEGIES.find(s => s.value === rec.strategy)?.timeframe}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 italic">{rec.marketCondition}</p>

                  {/* Confidence bar */}
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className={clsx('h-full rounded-full transition-all', confidenceColor)}
                        style={{ width: `${rec.confidence}%` }}
                      />
                    </div>
                    <span className="text-xs font-medium text-slate-300 w-10 text-right">{rec.confidence}%</span>
                  </div>
                </div>

                {/* Apply button */}
                <button
                  onClick={handleApply}
                  disabled={isRunning || applied}
                  className={clsx(
                    'shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all',
                    applied
                      ? 'bg-green-500/15 text-green-400 border border-green-500/30'
                      : isRunning
                      ? 'bg-slate-700/50 text-slate-500 cursor-not-allowed'
                      : 'bg-indigo-600 hover:bg-indigo-500 text-white',
                  )}
                >
                  {applied
                    ? <><CheckCircle className="w-3.5 h-3.5" />Applied</>
                    : 'Apply'}
                </button>
              </div>

              {/* Reasoning */}
              <p className="text-xs text-slate-300 leading-relaxed border-l-2 border-indigo-500/40 pl-3">
                {rec.reasoning}
              </p>

              {/* Suggested symbols */}
              {rec.suggestedSymbols.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-slate-500">Suggested:</span>
                  {rec.suggestedSymbols.map(sym => (
                    <span key={sym} className="text-xs bg-slate-800 border border-slate-700 text-slate-300 px-2 py-0.5 rounded font-mono">
                      {sym}
                    </span>
                  ))}
                  {rec.allowShorts && (
                    <span className="text-xs bg-red-500/10 border border-red-500/30 text-red-400 px-2 py-0.5 rounded">
                      shorts enabled
                    </span>
                  )}
                </div>
              )}

              {/* Key news headlines */}
              {rec.keyHeadlines.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                    <Newspaper className="w-3 h-3" />
                    Key headlines driving this recommendation
                  </div>
                  <div className="space-y-1">
                    {rec.keyHeadlines.map((h, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className={clsx(
                          'shrink-0 mt-0.5 px-1.5 py-0.5 rounded border text-[10px] font-medium',
                          sentimentBadge(h.sentiment),
                        )}>
                          {h.sentiment}
                        </span>
                        <span className="text-slate-300 leading-relaxed">{h.headline}</span>
                        <span className="shrink-0 text-slate-600">{h.source}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AlpacaTraderPage() {
  const [mode, setMode]           = useState<AccountMode>('paper');
  const [strategy, setStrategy]   = useState<StrategyName>('rsi_mean_reversion');
  const [symbols, setSymbols]     = useState(DEFAULT_SYMBOLS.rsi_mean_reversion);
  const [sizeUsd, setSizeUsd]     = useState('500');
  const [maxPos, setMaxPos]       = useState('3');
  const [allowShorts, setAllowShorts] = useState(false);
  const [autoSelect, setAutoSelect]   = useState(false);

  const [status, setStatus]       = useState<BotStatus | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [polling, setPolling]     = useState(false);

  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const serverHealth = useServerHealth();

  const handleStrategyChange = (s: StrategyName) => {
    setStrategy(s);
    setSymbols(DEFAULT_SYMBOLS[s]);
  };

  // Apply a recommendation from the AI panel
  const applyRecommendation = (rec: StrategyRecommendation) => {
    handleStrategyChange(rec.strategy);
    if (rec.suggestedSymbols.length) setSymbols(rec.suggestedSymbols.join(','));
    setAllowShorts(rec.allowShorts);
  };

  // ── Bot status polling ──────────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    try {
      const res  = await fetch(`/api/alpaca?mode=${mode}&action=status`);
      const data = await res.json() as BotStatus & { error?: string };
      if (data.error) { setError(data.error); return; }
      setStatus(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reach bot server');
    }
  }, [mode]);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setPolling(true);
    void fetchStatus();
    pollRef.current = setInterval(() => { void fetchStatus(); }, 5_000);
  }, [fetchStatus]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setPolling(false);
  }, []);

  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  useEffect(() => { startPolling(); }, [mode, startPolling]);

  const post = async (action: string, body?: object) => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`/api/alpaca?mode=${mode}&action=${action}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok && data.error) setError(data.error);
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  const handleStart = () => {
    const syms = symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!syms.length) { setError('Enter at least one symbol'); return; }
    void post('start', {
      strategy,
      symbols:         syms,
      positionSizeUsd: parseFloat(sizeUsd) || 500,
      maxPositions:    parseInt(maxPos, 10) || 3,
      allowShorts,
      autoSelect,
    });
  };

  const isRunning = status?.running ?? false;
  const isPaused  = status?.paused  ?? false;
  const stratMeta = STRATEGIES.find(s => s.value === strategy);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-slate-200 p-4 md:p-6">
      <div className="max-w-6xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <BarChart2 className="w-5 h-5 text-indigo-400" />
              Alpaca Auto Trader
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">Commission-free US stocks — paper &amp; live</p>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex rounded-lg overflow-hidden border border-slate-700 text-xs">
              {(['paper', 'live'] as AccountMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => { if (!isRunning) setMode(m); }}
                  disabled={isRunning}
                  className={clsx(
                    'px-3 py-1.5 font-medium transition-colors capitalize',
                    mode === m
                      ? m === 'live' ? 'bg-rose-600 text-white' : 'bg-indigo-600 text-white'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700',
                    isRunning && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  {m === 'live' ? '🔴 Live' : '📄 Paper'}
                </button>
              ))}
            </div>

            <span className={clsx(
              'text-xs px-2 py-1 rounded-full font-medium',
              isRunning && !isPaused ? 'bg-green-500/20 text-green-400'  :
              isPaused              ? 'bg-yellow-500/20 text-yellow-400' :
                                      'bg-slate-700 text-slate-400',
            )}>
              {isRunning && !isPaused ? '● Running' : isPaused ? '⏸ Paused' : '○ Stopped'}
            </span>

            <button
              onClick={() => { void fetchStatus(); }}
              className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400"
              title="Refresh status"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Server health */}
        <ServerStatusBanner {...serverHealth} />

        {/* ── AI Recommendation panel — full width at top ── */}
        <RecommendationPanel onApply={applyRecommendation} isRunning={isRunning} />

        {/* Error */}
        {error && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-3 text-sm text-rose-400 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {mode === 'live' && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-400 flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              <strong>Live mode active</strong> — real money will be traded. Confirm your Alpaca live credentials
              are set in <code className="text-amber-300">ALPACA_LIVE_KEY</code> / <code className="text-amber-300">ALPACA_LIVE_SECRET</code>.
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* ── Config panel ── */}
          <div className="lg:col-span-1 space-y-4">
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-4">
              <h2 className="text-sm font-semibold text-slate-300">Configuration</h2>

              {/* Strategy picker */}
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Strategy</label>
                <div className="space-y-1.5">
                  {STRATEGIES.map(s => (
                    <button
                      key={s.value}
                      onClick={() => { if (!isRunning) handleStrategyChange(s.value); }}
                      disabled={isRunning}
                      className={clsx(
                        'w-full text-left p-2.5 rounded-lg border text-xs transition-all',
                        strategy === s.value
                          ? 'border-indigo-500/60 bg-indigo-500/10 text-indigo-300'
                          : 'border-slate-700/50 bg-slate-800/40 text-slate-400 hover:border-slate-600',
                        isRunning && 'opacity-60 cursor-not-allowed',
                      )}
                    >
                      <div className="font-medium">{s.label}</div>
                      <div className="text-slate-500 mt-0.5">{s.timeframe}</div>
                    </button>
                  ))}
                </div>
                {stratMeta && (
                  <p className="text-xs text-slate-500 mt-2">{stratMeta.description}</p>
                )}
              </div>

              {/* Symbols */}
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Symbols (comma-separated)</label>
                <input
                  value={symbols}
                  onChange={e => setSymbols(e.target.value.toUpperCase())}
                  disabled={isRunning}
                  placeholder="SPY,QQQ,AAPL"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                />
              </div>

              {/* Position size & max positions */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">Size per trade ($)</label>
                  <input
                    type="number"
                    value={sizeUsd}
                    onChange={e => setSizeUsd(e.target.value)}
                    disabled={isRunning}
                    min="10"
                    step="50"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5">Max positions</label>
                  <input
                    type="number"
                    value={maxPos}
                    onChange={e => setMaxPos(e.target.value)}
                    disabled={isRunning}
                    min="1"
                    max="20"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                  />
                </div>
              </div>

              {/* Allow shorts toggle */}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <div
                  onClick={() => { if (!isRunning) setAllowShorts(v => !v); }}
                  className={clsx(
                    'w-9 h-5 rounded-full relative transition-colors',
                    allowShorts ? 'bg-indigo-500' : 'bg-slate-700',
                    isRunning && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  <div className={clsx(
                    'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
                    allowShorts ? 'left-4' : 'left-0.5',
                  )} />
                </div>
                <span className="text-xs text-slate-400">Allow short selling</span>
              </label>

              {/* Auto-select toggle */}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <div
                  onClick={() => { if (!isRunning) setAutoSelect(v => !v); }}
                  className={clsx(
                    'w-9 h-5 rounded-full relative transition-colors',
                    autoSelect ? 'bg-emerald-500' : 'bg-slate-700',
                    isRunning && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  <div className={clsx(
                    'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
                    autoSelect ? 'left-4' : 'left-0.5',
                  )} />
                </div>
                <span className="text-xs text-slate-400">
                  Auto-select symbols
                  <span className="ml-1 text-slate-600">(scans best picks at start + on close)</span>
                </span>
              </label>

              {/* Controls */}
              <div className="space-y-2 pt-1">
                {!isRunning ? (
                  <button
                    onClick={handleStart}
                    disabled={loading}
                    className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    <Power className="w-4 h-4" />
                    Start Bot
                  </button>
                ) : (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => void post(isPaused ? 'resume' : 'pause')}
                        disabled={loading}
                        className="flex items-center justify-center gap-1.5 bg-yellow-600/20 hover:bg-yellow-600/30 border border-yellow-600/40 text-yellow-300 rounded-lg py-2 text-xs font-medium transition-colors disabled:opacity-50"
                      >
                        {isPaused
                          ? <><Play  className="w-3.5 h-3.5" />Resume</>
                          : <><Pause className="w-3.5 h-3.5" />Pause</>}
                      </button>
                      <button
                        onClick={() => void post('stop')}
                        disabled={loading}
                        className="flex items-center justify-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg py-2 text-xs font-medium transition-colors disabled:opacity-50"
                      >
                        <Square className="w-3.5 h-3.5" />Stop
                      </button>
                    </div>
                    <button
                      onClick={() => {
                        if (!window.confirm('Cancel all open orders? Existing positions will remain open.')) return;
                        void post('emergency-stop');
                      }}
                      disabled={loading}
                      className="w-full flex items-center justify-center gap-2 bg-rose-900/30 hover:bg-rose-900/50 border border-rose-700/40 text-rose-400 rounded-lg py-2 text-xs font-medium transition-colors disabled:opacity-50"
                    >
                      <ShieldAlert className="w-3.5 h-3.5" />
                      Cancel All Orders
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Env vars reminder */}
            <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-3 text-xs text-slate-500 space-y-1">
              <p className="text-slate-400 font-medium">Required env vars</p>
              <p><code className="text-slate-300">ALPACA_PAPER_KEY</code> + <code className="text-slate-300">ALPACA_PAPER_SECRET</code></p>
              <p><code className="text-slate-300">ALPACA_LIVE_KEY</code> + <code className="text-slate-300">ALPACA_LIVE_SECRET</code></p>
              <p className="text-slate-600">Falls back to <code>ALPACA_API_KEY</code> / <code>ALPACA_SECRET_KEY</code></p>
            </div>
          </div>

          {/* ── Status / positions / log ── */}
          <div className="lg:col-span-2 space-y-4">

            {/* Account summary */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Equity',    value: status ? `$${parseFloat(status.equity || '0').toFixed(2)}` : '—', icon: <DollarSign className="w-4 h-4" /> },
                { label: 'Cash',      value: status ? `$${parseFloat(status.cash   || '0').toFixed(2)}` : '—', icon: <DollarSign className="w-4 h-4" /> },
                { label: 'Positions', value: status ? String(status.positions.length) : '—', icon: <BarChart2 className="w-4 h-4" /> },
              ].map(c => (
                <div key={c.label} className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
                  <div className="flex items-center gap-1.5 text-slate-500 text-xs mb-1">
                    {c.icon}{c.label}
                  </div>
                  <div className="text-lg font-semibold text-white">{c.value}</div>
                </div>
              ))}
            </div>

            {/* Next poll */}
            {status?.nextRunMs && (
              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                <Clock className="w-3.5 h-3.5" />
                Next poll in {Math.max(0, Math.round((status.nextRunMs - Date.now()) / 1000))}s
                {status.lastPollTs && ` · Last: ${new Date(status.lastPollTs).toLocaleTimeString()}`}
              </div>
            )}

            {/* Open positions */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-300">Open Positions</h2>
                <span className="text-xs text-slate-500">{status?.positions.length ?? 0} open</span>
              </div>

              {!status?.positions.length ? (
                <div className="px-4 py-8 text-center text-slate-600 text-sm">No open positions</div>
              ) : (
                <div className="divide-y divide-slate-800/60">
                  {status.positions.map(p => {
                    const pl  = parseFloat(p.unrealized_pl);
                    const pct = parseFloat(p.unrealized_plpc) * 100;
                    const pos = pl >= 0;
                    return (
                      <div key={p.symbol} className="px-4 py-3 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {p.side === 'long'
                            ? <TrendingUp   className="w-4 h-4 text-green-400" />
                            : <TrendingDown className="w-4 h-4 text-red-400"   />}
                          <div>
                            <div className="font-medium text-white text-sm">{p.symbol}</div>
                            <div className="text-xs text-slate-500">
                              {p.qty} shares · avg ${parseFloat(p.avg_entry_price).toFixed(2)}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-medium text-sm text-white">
                            ${parseFloat(p.current_price).toFixed(2)}
                          </div>
                          <div className={clsx('text-xs font-medium', pos ? 'text-green-400' : 'text-red-400')}>
                            {fmtPnl(p.unrealized_pl)} ({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Activity log */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-300">Activity Log</h2>
                <span className={clsx(
                  'text-xs px-1.5 py-0.5 rounded',
                  polling ? 'text-green-400 bg-green-500/10' : 'text-slate-500',
                )}>
                  {polling ? '● live' : '○ paused'}
                </span>
              </div>
              <div className="font-mono text-xs overflow-y-auto max-h-80 p-3 space-y-0.5">
                {!status?.log.length ? (
                  <div className="text-slate-600 py-4 text-center">No activity yet — start the bot to see logs</div>
                ) : status.log.map(entry => (
                  <div key={entry.id} className="flex gap-2">
                    <span className="text-slate-600 shrink-0 w-16">{entry.ts}</span>
                    <span className={clsx('shrink-0', logColor(entry.type))}>{logIcon(entry.type)}</span>
                    <span className="text-indigo-400 shrink-0 w-12 truncate">{entry.symbol}</span>
                    <span className={logColor(entry.type)}>{entry.msg}</span>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

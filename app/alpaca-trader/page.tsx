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

type PageTab     = 'alpaca' | 'ig';
type AccountMode = 'paper' | 'live';
type StrategyName = 'rsi_mean_reversion' | 'ema_crossover' | 'orb' | 'vwap' | 'weekly_momentum' | 'options_directional';

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
  lossLock?:   boolean;   // daily-loss circuit breaker engaged (no new entries today)
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
  {
    value:       'options_directional',
    label:       'Options Directional',
    timeframe:   'Intraday (5-min)',
    description: 'Buy calls when RSI < 30, buy puts when RSI > 70. Exit at +75% profit, −50% loss, or ≤2 DTE.',
  },
];

const DEFAULT_SYMBOLS: Record<StrategyName, string> = {
  rsi_mean_reversion:  'SPY,QQQ,AAPL,MSFT,NVDA',
  ema_crossover:       'SPY,QQQ,AAPL,MSFT,NVDA,AMZN',
  orb:                 'SPY,QQQ,AAPL,TSLA,NVDA',
  vwap:                'SPY,QQQ,AAPL,MSFT',
  weekly_momentum:     'XLK,XLF,XLE,XLV,XLY,SPY',
  options_directional: 'SPY,QQQ,AAPL,MSFT,NVDA',
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
  rsi_mean_reversion:  'RSI Mean Reversion',
  ema_crossover:       'EMA Crossover',
  orb:                 'Opening Range Breakout',
  vwap:                'VWAP Reversion',
  weekly_momentum:     'Weekly Momentum',
  options_directional: 'Options Directional',
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

// ── IG Spread Bet tab ─────────────────────────────────────────────────────────

type IgStrategyName = 'rsi_mean_reversion' | 'ema_crossover' | 'orb' | 'vwap' | 'weekly_momentum' | 'donchian_breakout' | 'donchian_hourly' | 'macd_crossover' | 'gemini_opinion';
type IgMode         = 'demo' | 'live';

type IgOpenPosition = {
  dealId:    string;
  epic:      string;
  name:      string;
  direction: 'BUY' | 'SELL';
  size:      number;
  level:     number;
  upl:       number;
  bid:       number;
  offer:     number;
  openedAt?: string;
};

type IgLogEntry = {
  id:   string;
  ts:   string;
  type: 'info' | 'enter' | 'exit' | 'wait' | 'error';
  epic: string;
  msg:  string;
};

type IgBotStatus = {
  running:    boolean;
  paused:     boolean;
  mode:       IgMode;
  strategy:   IgStrategyName;
  epics:      string[];
  epicDataSource: Record<string, 'alpaca' | 'ig'>;
  epicNames:  Record<string, string>;
  balance:    number;
  available:  number;
  positions:  IgOpenPosition[];
  log:        IgLogEntry[];
  nextRunMs:  number | null;
  lastPollTs: string | null;
  sessionOk:  boolean;
  recommendations?: IgRecommendation[];
  dailyPick?: IgRecommendation | null;
  pausedEpics?: string[];
  // Deal IDs the bot will auto-manage (opened by the bot, or released) —
  // anything open but not in here is a manually-opened position the bot is
  // deliberately leaving alone.
  managedDeals?: string[];
};

// A signal computed off IG's own data for an epic the bot isn't acting on
// itself — manual-only, refreshed roughly every 30min across the full
// instrument universe.
type IgRecommendation = {
  epic:             string;
  name:             string;
  action:           'BUY' | 'SELL';
  reason:           string;
  level:            number;
  stopPrice?:       number;
  takeProfitPrice?: number;
  computedAt:       string;
  score:            number;
};

// Any open IG position for the account, however it was opened (manually,
// via the strategy bot, elsewhere) — used by the Gemini watch panel, which
// covers positions the strategy bot itself doesn't know about.
type WatchPosition = {
  dealId:         string;
  epic:           string;
  instrumentName: string;
  direction:      'BUY' | 'SELL';
  size:           number;
  level:          number;
  upl:            number;
  bid:            number;
  offer:          number;
  stopLevel?:     number;
  limitLevel?:    number;
  openedAt?:      string;
};

const IG_STRATEGIES: { value: IgStrategyName; label: string; timeframe: string; description: string }[] = [
  { value: 'donchian_breakout',  label: '🏆 Donchian Breakout',    timeframe: 'Swing (Daily)',    description: 'BEST backtested: +8.9% avg return after financing, PF 1.38. 20-day breakout entry, 10-day opposite breakout exit. No fixed target — let winners run.' },
  { value: 'donchian_hourly',    label: 'Donchian Breakout (Hourly)', timeframe: 'Hours–2 days',  description: 'Same Donchian logic on hourly bars — 24-hour breakout entry, 12-hour opposite breakout exit. Holds hours to ~2 days instead of days-to-weeks. Untested — new strategy, no backtest history yet.' },
  { value: 'ema_crossover',      label: '✅ EMA Crossover',         timeframe: 'Swing (Daily)',    description: 'Backtested: +7.2% avg return after financing, PF 1.26. Enter on EMA9 × EMA21 crossover. Hold days to weeks. Stop: 2× ATR.' },
  { value: 'macd_crossover',     label: '✅ MACD Crossover',        timeframe: 'Swing (Daily)',    description: 'Backtested: +6.1% avg return after financing, PF 1.17. Enter on MACD signal-line crossover. Stop: 2× ATR, target: 5× ATR.' },
  { value: 'rsi_mean_reversion', label: 'RSI Mean Reversion',    timeframe: 'Intraday (5-min)', description: 'Buy RSI < 30, sell RSI > 70. Spread bets on liquid large-caps & indices. Stop: 1.5× ATR. Backtested negative after costs.' },
  { value: 'orb',                label: 'Opening Range Breakout', timeframe: 'Intraday (Daily)', description: 'Trade breakouts above/below the first 30-min range. Exit at EOD or midpoint stop. Backtested negative after costs.' },
  { value: 'vwap',               label: 'VWAP Reversion',         timeframe: 'Intraday (1-min)', description: 'Bet on price returning to VWAP when it dips 0.5% below and RSI < 45. Backtested negative after costs.' },
  { value: 'weekly_momentum',    label: 'Weekly Momentum',        timeframe: 'Position (Weekly)', description: 'Ride weekly trends: above 12-week SMA + 4-week momentum > 1% + RSI 50–70. Backtested negative after financing costs.' },
  { value: 'gemini_opinion',     label: '🧪 Gemini Opinion (Experimental)', timeframe: 'Intraday (Hourly)', description: 'No technical entry rule — Gemini decides BUY/SELL/HOLD from scratch off price, RSI/MACD context, and real news, and sets its own stop/TP. Exits handled entirely by Gemini Position Watch. No track record yet — start small.' },
];

const IG_STRATEGY_LABEL: Record<IgStrategyName, string> = {
  rsi_mean_reversion: 'RSI Mean Reversion',
  ema_crossover:      'EMA Crossover',
  orb:                'Opening Range Breakout',
  vwap:               'VWAP Reversion',
  weekly_momentum:    'Weekly Momentum',
  donchian_breakout:  'Donchian Breakout',
  donchian_hourly:    'Donchian Breakout (Hourly)',
  macd_crossover:     'MACD Crossover',
  gemini_opinion:     'Gemini Opinion (Experimental)',
};

function IgSpreadBetTab() {
  const [igMode, setIgMode]         = useState<IgMode>('demo');
  const [strategy, setStrategy]     = useState<IgStrategyName>('donchian_breakout');
  const [maxRisk, setMaxRisk]           = useState('20');
  const [maxStockPos, setMaxStockPos]   = useState('3');
  const [maxIndexPos, setMaxIndexPos]   = useState('3');
  const [allowShorts, setAllowShorts] = useState(false);

  const [status, setStatus]   = useState<IgBotStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const [watchPositions, setWatchPositions] = useState<WatchPosition[]>([]);
  const [watchedDealIds, setWatchedDealIds] = useState<Set<string>>(new Set());
  const [watchBusy, setWatchBusy]           = useState<string | null>(null);

  const pollRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res  = await fetch(`/api/ig-strategy?mode=${igMode}&action=status`);
      const data = await res.json() as IgBotStatus & { error?: string };
      if (data.error) { setError(data.error); return; }
      setStatus(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reach bot server');
    }
  }, [igMode]);

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

  useEffect(() => { startPolling(); }, [igMode, startPolling]);

  // Gemini watch panel — separate, slower poll (positions + which are
  // watched don't change nearly as often as the strategy bot's own status).
  const fetchWatch = useCallback(async () => {
    try {
      const res  = await fetch(`/api/ig-strategy?mode=${igMode}&action=watch`);
      const data = await res.json() as { ok: boolean; positions?: WatchPosition[]; watchedDealIds?: string[] };
      if (data.ok) {
        setWatchPositions(data.positions ?? []);
        setWatchedDealIds(new Set(data.watchedDealIds ?? []));
      }
    } catch { /* silent — this panel is secondary, main status polling already surfaces errors */ }
  }, [igMode]);

  useEffect(() => {
    void fetchWatch();
    if (watchPollRef.current) clearInterval(watchPollRef.current);
    watchPollRef.current = setInterval(() => { void fetchWatch(); }, 15_000);
    return () => { if (watchPollRef.current) clearInterval(watchPollRef.current); };
  }, [fetchWatch]);

  const [openBusy, setOpenBusy] = useState<string | null>(null);
  const openRecommendation = async (epic: string) => {
    setOpenBusy(epic);
    try {
      const res  = await fetch(`/api/ig-strategy?mode=${igMode}&action=open-recommendation`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ epic }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok && data.error) setError(data.error);
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open position');
    } finally {
      setOpenBusy(null);
    }
  };

  const toggleWatch = async (dealId: string, currentlyWatched: boolean) => {
    setWatchBusy(dealId);
    try {
      if (currentlyWatched) {
        await fetch(`/api/ig-strategy?mode=${igMode}&action=watch&dealId=${encodeURIComponent(dealId)}`, { method: 'DELETE' });
      } else {
        await fetch(`/api/ig-strategy?mode=${igMode}&action=watch`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ dealId }),
        });
      }
      await fetchWatch();
    } finally {
      setWatchBusy(null);
    }
  };

  const [pauseBusy, setPauseBusy] = useState<string | null>(null);
  const togglePauseEpic = async (epic: string, currentlyPaused: boolean) => {
    setPauseBusy(epic);
    try {
      if (currentlyPaused) {
        await fetch(`/api/ig-strategy?mode=${igMode}&action=pause-epic&epic=${encodeURIComponent(epic)}`, { method: 'DELETE' });
      } else {
        await fetch(`/api/ig-strategy?mode=${igMode}&action=pause-epic`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ epic }),
        });
      }
      await fetchStatus();
    } finally {
      setPauseBusy(null);
    }
  };

  const [dealBusy, setDealBusy] = useState<string | null>(null);
  const toggleDealManaged = async (dealId: string, currentlyManaged: boolean) => {
    setDealBusy(dealId);
    try {
      await fetch(`/api/ig-strategy?mode=${igMode}&action=${currentlyManaged ? 'hold-deal' : 'release-deal'}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ dealId }),
      });
      await fetchStatus();
    } finally {
      setDealBusy(null);
    }
  };

  const post = async (action: string, body?: object) => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`/api/ig-strategy?mode=${igMode}&action=${action}`, {
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
    void post('start', {
      strategy,
      maxRiskGbp:        parseFloat(maxRisk) || 20,
      maxStockPositions: parseInt(maxStockPos, 10) || 3,
      maxIndexPositions: parseInt(maxIndexPos, 10) || 3,
      allowShorts,
    });
  };

  const isRunning = status?.running ?? false;
  const isPaused  = status?.paused  ?? false;
  const stratMeta = IG_STRATEGIES.find(s => s.value === strategy);

  return (
    <div className="space-y-5">
      {/* Error */}
      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-3 text-sm text-rose-400 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {igMode === 'live' && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-400 flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            <strong>Live mode active</strong> — real money spread bets will be placed on your IG live account.
            Set <code className="text-amber-300">IG_LIVE_API_KEY</code>, <code className="text-amber-300">IG_LIVE_USERNAME</code>, and <code className="text-amber-300">IG_LIVE_PASSWORD</code>.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Config panel */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-4">
            <h2 className="text-sm font-semibold text-slate-300">Configuration</h2>

            {/* Mode */}
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Account</label>
              <div className="flex rounded-lg overflow-hidden border border-slate-700 text-xs">
                {(['demo', 'live'] as IgMode[]).map(m => (
                  <button
                    key={m}
                    onClick={() => { if (!loading) setIgMode(m); }}
                    disabled={loading}
                    className={clsx(
                      'flex-1 py-2 font-medium transition-colors capitalize',
                      igMode === m
                        ? m === 'live' ? 'bg-rose-600 text-white' : 'bg-emerald-700 text-white'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700',
                      loading && 'opacity-50 cursor-not-allowed',
                    )}
                  >
                    {m === 'live' ? '🔴 Live' : '📄 Demo'}
                  </button>
                ))}
              </div>
            </div>

            {/* Strategy */}
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Strategy</label>
              <div className="space-y-1.5">
                {IG_STRATEGIES.map(s => (
                  <button
                    key={s.value}
                    onClick={() => { if (!isRunning) setStrategy(s.value); }}
                    disabled={isRunning}
                    className={clsx(
                      'w-full text-left p-2.5 rounded-lg border text-xs transition-all',
                      strategy === s.value
                        ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
                        : 'border-slate-700/50 bg-slate-800/40 text-slate-400 hover:border-slate-600',
                      isRunning && 'opacity-60 cursor-not-allowed',
                    )}
                  >
                    <div className="font-medium">{s.label}</div>
                    <div className="text-slate-500 mt-0.5">{s.timeframe}</div>
                  </button>
                ))}
              </div>
              {stratMeta && <p className="text-xs text-slate-500 mt-2">{stratMeta.description}</p>}
            </div>

            {/* Max risk & max positions */}
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Max risk / trade (£)</label>
                <input
                  type="number"
                  value={maxRisk}
                  onChange={e => setMaxRisk(e.target.value)}
                  disabled={isRunning}
                  min="5"
                  step="5"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                />
                <p className="text-[10px] text-slate-500 mt-1">Max £ lost if the stop is hit — stake auto-sizes to this, not a notional target</p>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Max stock positions</label>
                <input
                  type="number"
                  value={maxStockPos}
                  onChange={e => setMaxStockPos(e.target.value)}
                  disabled={isRunning}
                  min="0"
                  max="10"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                />
                <p className="text-[10px] text-slate-500 mt-1">Separate cap — doesn't share room with indices</p>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Max index positions</label>
                <input
                  type="number"
                  value={maxIndexPos}
                  onChange={e => setMaxIndexPos(e.target.value)}
                  disabled={isRunning}
                  min="0"
                  max="10"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                />
                <p className="text-[10px] text-slate-500 mt-1">Separate cap — doesn't share room with stocks</p>
              </div>
            </div>

            {/* Allow shorts */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <div
                onClick={() => { if (!isRunning) setAllowShorts(v => !v); }}
                className={clsx(
                  'w-9 h-5 rounded-full relative transition-colors',
                  allowShorts ? 'bg-emerald-600' : 'bg-slate-700',
                  isRunning && 'opacity-50 cursor-not-allowed',
                )}
              >
                <div className={clsx('absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform', allowShorts ? 'left-4' : 'left-0.5')} />
              </div>
              <span className="text-xs text-slate-400">Allow short selling</span>
            </label>

            {/* Controls */}
            <div className="space-y-2 pt-1">
              {!isRunning ? (
                <button
                  onClick={handleStart}
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded-lg py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
                >
                  <Power className="w-4 h-4" />
                  Start IG Bot
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => void post(isPaused ? 'resume' : 'pause')}
                      disabled={loading}
                      className="flex items-center justify-center gap-1.5 bg-yellow-600/20 hover:bg-yellow-600/30 border border-yellow-600/40 text-yellow-300 rounded-lg py-2 text-xs font-medium transition-colors disabled:opacity-50"
                    >
                      {isPaused ? <><Play className="w-3.5 h-3.5" />Resume</> : <><Pause className="w-3.5 h-3.5" />Pause</>}
                    </button>
                    <button
                      onClick={() => void post('stop')}
                      disabled={loading}
                      className="flex items-center justify-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg py-2 text-xs font-medium transition-colors disabled:opacity-50"
                    >
                      <Square className="w-3.5 h-3.5" />Stop
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Env vars reminder */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-3 text-xs text-slate-500 space-y-1">
            <p className="text-slate-400 font-medium">Required env vars</p>
            <p><code className="text-slate-300">IG_DEMO_API_KEY</code> + <code className="text-slate-300">IG_DEMO_USERNAME</code> + <code className="text-slate-300">IG_DEMO_PASSWORD</code></p>
            <p><code className="text-slate-300">IG_LIVE_API_KEY</code> + <code className="text-slate-300">IG_LIVE_USERNAME</code> + <code className="text-slate-300">IG_LIVE_PASSWORD</code></p>
            <p className="pt-1 text-slate-600">Notional = target exposure per trade. Stake (£/pt) is calculated automatically from the instrument price.</p>
          </div>
        </div>

        {/* Status / positions / log */}
        <div className="lg:col-span-2 space-y-4">

          {/* Account summary */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Balance',   value: status ? `£${status.balance.toFixed(2)}`   : '—', icon: <DollarSign className="w-4 h-4" /> },
              { label: 'Available', value: status ? `£${status.available.toFixed(2)}` : '—', icon: <DollarSign className="w-4 h-4" /> },
              { label: 'Positions', value: status ? String(status.positions.length)   : '—', icon: <BarChart2  className="w-4 h-4" /> },
            ].map(c => (
              <div key={c.label} className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
                <div className="flex items-center gap-1.5 text-slate-500 text-xs mb-1">{c.icon}{c.label}</div>
                <div className="text-lg font-semibold text-white">{c.value}</div>
              </div>
            ))}
          </div>

          {/* Session status */}
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span className={clsx('flex items-center gap-1', status?.sessionOk ? 'text-green-400' : 'text-slate-500')}>
              <span className={clsx('w-1.5 h-1.5 rounded-full inline-block', status?.sessionOk ? 'bg-green-400' : 'bg-slate-600')} />
              {status?.sessionOk ? 'IG session active' : 'No session'}
            </span>
            {status?.nextRunMs && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Next poll in {Math.max(0, Math.round((status.nextRunMs - Date.now()) / 1000))}s
              </span>
            )}
            {status?.strategy && (
              <span className="text-slate-600">{IG_STRATEGY_LABEL[status.strategy]}</span>
            )}
          </div>

          {/* Watchlist — which data source each instrument's real signal actually
              uses right now. IG's historical-data allowance can run out and block
              confirmation for IG-sourced instruments while Alpaca-sourced ones
              keep trading fine — this makes that visible instead of it looking
              like the bot has just stopped doing anything. */}
          {!!status?.epics.length && (
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
              <div className="text-xs text-slate-500 mb-2">Watching ({status.epics.length})</div>
              <div className="flex flex-wrap gap-1.5">
                {status.epics.map(epic => {
                  const source = status.epicDataSource?.[epic] ?? 'ig';
                  const isAlpaca = source === 'alpaca';
                  return (
                    <span
                      key={epic}
                      title={isAlpaca ? 'Confirmed via Alpaca/Yahoo — unaffected by IG data limits' : "Confirmed via IG's own data — blocked if IG's allowance is exhausted"}
                      className={clsx(
                        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border',
                        isAlpaca ? 'border-green-800 bg-green-950/40 text-green-400' : 'border-amber-800 bg-amber-950/40 text-amber-400',
                      )}
                    >
                      {status.epicNames?.[epic] ?? epic}
                      <span className="opacity-60">{isAlpaca ? 'alpaca' : 'ig'}</span>
                      <button
                        onClick={() => void togglePauseEpic(epic, false)}
                        disabled={pauseBusy === epic}
                        title="Pause — exclude from scanning and entries until resumed"
                        className="opacity-50 hover:opacity-100 disabled:opacity-30 ml-0.5"
                      >
                        ⏸
                      </button>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Paused epics — user-excluded from scanning and entries entirely,
              so they no longer show up in Watching above at all. */}
          {!!status?.pausedEpics?.length && (
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
              <div className="text-xs text-slate-500 mb-2">Paused ({status.pausedEpics.length})</div>
              <div className="flex flex-wrap gap-1.5">
                {status.pausedEpics.map(epic => (
                  <span
                    key={epic}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border border-slate-700 bg-slate-800/60 text-slate-400"
                  >
                    {status.epicNames?.[epic] ?? epic}
                    <button
                      onClick={() => void togglePauseEpic(epic, true)}
                      disabled={pauseBusy === epic}
                      title="Resume — allow scanning and entries again"
                      className="opacity-60 hover:opacity-100 disabled:opacity-30 ml-0.5 text-purple-400"
                    >
                      ▶
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Today's Pick — single best-scored signal across the full universe,
              decided once overnight/first-thing and held stable through the
              day, unlike the general Recommended list below which keeps
              refreshing every 30min as price action evolves. */}
          {!!status?.running && (
            <div className="bg-gradient-to-r from-purple-950/40 to-slate-900/60 border border-purple-800/60 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-purple-300">★ Today&apos;s Pick</h2>
                <button
                  onClick={() => void post('refresh-daily-pick')}
                  disabled={loading}
                  className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-400 hover:bg-slate-700 disabled:opacity-50"
                >
                  Redecide
                </button>
              </div>
              {!status.dailyPick ? (
                <div className="px-4 py-6 text-center text-slate-600 text-sm">
                  No signal strong enough across the universe today — check back tomorrow.
                </div>
              ) : (
                <div className="px-4 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {status.dailyPick.action === 'BUY'
                      ? <TrendingUp   className="w-5 h-5 text-green-400" />
                      : <TrendingDown className="w-5 h-5 text-red-400"   />}
                    <div>
                      <div className="font-semibold text-white text-sm">{status.dailyPick.name}</div>
                      <div className="text-xs text-slate-400">{status.dailyPick.reason}</div>
                      <div className="text-xs text-slate-600">
                        score {status.dailyPick.score.toFixed(1)} · decided {new Date(status.dailyPick.computedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>
                  <div className="text-right text-xs">
                    <div className="text-white font-medium">{status.dailyPick.action} @ {status.dailyPick.level.toFixed(2)}</div>
                    {status.dailyPick.stopPrice !== undefined && <div className="text-slate-500">Stop {status.dailyPick.stopPrice.toFixed(2)}</div>}
                    {status.dailyPick.takeProfitPrice !== undefined && <div className="text-slate-500">TP {status.dailyPick.takeProfitPrice.toFixed(2)}</div>}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Recommended — full 38-name universe scan, not just the current
              watch list, plus anything the bot itself tried to open and got
              rejected (kept here instead of silently rotated away — see
              executeIgSignal's catch in igStrategyBot.ts). Refreshed every
              ~30min: limits get updated while it's still a live idea, and it
              drops off this list on its own once it no longer is. */}
          {!!status?.running && (
            <div className="bg-slate-900/60 border border-purple-900/50 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-300">Recommended</h2>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">{status.recommendations?.length ?? 0}</span>
                  <button
                    onClick={() => void post('refresh-recommendations')}
                    disabled={loading}
                    className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-400 hover:bg-slate-700 disabled:opacity-50"
                  >
                    Refresh now
                  </button>
                </div>
              </div>
              <div className="px-4 py-2 text-xs text-slate-500 border-b border-slate-800/60">
                Setups outside the bot&apos;s current scope, skipped for sizing, allowance-blocked, or an auto-entry that failed to place — updated every ~30min while still live, removed once it no longer is. Open Position sends it through at the limits shown, re-priced against the current market.
              </div>
              {!status.recommendations?.length ? (
                <div className="px-4 py-6 text-center text-slate-600 text-sm">None right now</div>
              ) : (
              <div className="divide-y divide-slate-800/60">
                {status.recommendations.map(r => {
                  const isBusy = openBusy === r.epic;
                  return (
                  <div key={r.epic} className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      {r.action === 'BUY'
                        ? <TrendingUp   className="w-4 h-4 text-green-400 shrink-0" />
                        : <TrendingDown className="w-4 h-4 text-red-400 shrink-0"   />}
                      <div className="min-w-0">
                        <div className="font-medium text-white text-sm">{r.name || r.epic}</div>
                        <div className="text-xs text-slate-500 truncate">{r.reason}</div>
                        <div className="text-xs text-slate-600">decided {new Date(r.computedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                      </div>
                    </div>
                    <div className="text-right text-xs shrink-0">
                      <div className="text-white font-medium">{r.action} @ {r.level.toFixed(2)}</div>
                      {r.stopPrice !== undefined && <div className="text-slate-500">Stop {r.stopPrice.toFixed(2)}</div>}
                      {r.takeProfitPrice !== undefined && <div className="text-slate-500">TP {r.takeProfitPrice.toFixed(2)}</div>}
                    </div>
                    <button
                      onClick={() => void openRecommendation(r.epic)}
                      disabled={isBusy}
                      className="shrink-0 text-xs px-2.5 py-1.5 rounded font-medium bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50 transition-colors"
                    >
                      {isBusy ? '…' : 'Open Position'}
                    </button>
                  </div>
                  );
                })}
              </div>
              )}
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
                {status.positions.map(p => (
                  <div key={p.dealId} className="px-4 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {p.direction === 'BUY'
                        ? <TrendingUp   className="w-4 h-4 text-green-400" />
                        : <TrendingDown className="w-4 h-4 text-red-400"   />}
                      <div>
                        <div className="font-medium text-white text-sm flex items-center gap-2">
                          {p.name || p.epic}
                          {p.openedAt && (() => {
                            const heldHrs   = (Date.now() - new Date(p.openedAt).getTime()) / 3_600_000;
                            const longTerm  = heldHrs >= 24;
                            const heldLabel = longTerm ? `${(heldHrs / 24).toFixed(1)}d` : `${heldHrs.toFixed(1)}h`;
                            return (
                              <span className={clsx(
                                'text-[10px] px-1.5 py-0.5 rounded font-normal shrink-0',
                                longTerm ? 'text-blue-400 bg-blue-500/10' : 'text-amber-400 bg-amber-500/10',
                              )}>
                                {longTerm ? 'Long-term' : 'Short-term'} · {heldLabel}
                              </span>
                            );
                          })()}
                        </div>
                        <div className="text-xs text-slate-500">
                          {p.direction} · £{p.size}/pt · entry {p.level.toFixed(2)}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium text-sm text-white">
                        {(p.direction === 'BUY' ? p.bid : p.offer).toFixed(2)}
                      </div>
                      <div className={clsx('text-xs font-medium', (p.upl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400')}>
                        {(p.upl ?? 0) >= 0 ? '+' : ''}£{(p.upl ?? 0).toFixed(2)}
                      </div>
                      {(() => {
                        const managed = status?.managedDeals?.includes(p.dealId) ?? true;
                        return (
                          <button
                            onClick={() => void toggleDealManaged(p.dealId, managed)}
                            disabled={dealBusy === p.dealId}
                            className={clsx(
                              'mt-1 text-[10px] px-1.5 py-0.5 rounded font-normal shrink-0 disabled:opacity-50',
                              managed ? 'text-slate-400 bg-slate-500/10 hover:bg-slate-500/20' : 'text-amber-400 bg-amber-500/10 hover:bg-amber-500/20',
                            )}
                            title={managed ? 'Bot can close this — click to hold it instead' : 'Bot will not close this automatically — click to let it manage exits'}
                          >
                            {managed ? '🔓 Bot-managed' : '🔒 Manual — hold'}
                          </button>
                        );
                      })()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Gemini position watch */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-300">Gemini Position Watch</h2>
              <span className="text-xs text-slate-500">{watchedDealIds.size} watched</span>
            </div>
            <div className="px-4 py-2 text-xs text-slate-500 border-b border-slate-800/60">
              Flag any open position (opened here, in IG&apos;s app, anywhere) for Gemini to review every ~15 min and close if it judges that&apos;s warranted.
              A stop-loss stays attached independently, regardless of Gemini&apos;s availability.
            </div>
            {!watchPositions.length ? (
              <div className="px-4 py-8 text-center text-slate-600 text-sm">No open positions to watch</div>
            ) : (
              <div className="divide-y divide-slate-800/60">
                {watchPositions.map(p => {
                  const isWatched = watchedDealIds.has(p.dealId);
                  const isBusy    = watchBusy === p.dealId;
                  return (
                    <div key={p.dealId} className="px-4 py-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {p.direction === 'BUY'
                          ? <TrendingUp   className="w-4 h-4 text-green-400" />
                          : <TrendingDown className="w-4 h-4 text-red-400"   />}
                        <div>
                          <div className="font-medium text-white text-sm">{p.instrumentName || p.epic}</div>
                          <div className="text-xs text-slate-500">
                            {p.direction} · £{p.size}/pt · entry {p.level.toFixed(2)}
                            {p.stopLevel === undefined && <span className="text-amber-400"> · no stop</span>}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <div className={clsx('text-xs font-medium', (p.upl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400')}>
                            {(p.upl ?? 0) >= 0 ? '+' : ''}£{(p.upl ?? 0).toFixed(2)}
                          </div>
                        </div>
                        <button
                          onClick={() => void toggleWatch(p.dealId, isWatched)}
                          disabled={isBusy}
                          className={clsx(
                            'text-xs px-2.5 py-1 rounded font-medium transition-colors disabled:opacity-50',
                            isWatched
                              ? 'bg-purple-500/20 text-purple-300 hover:bg-purple-500/30'
                              : 'bg-slate-800 text-slate-400 hover:bg-slate-700',
                          )}
                        >
                          {isBusy ? '…' : isWatched ? '✦ Watching' : 'Watch'}
                        </button>
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
              <span className={clsx('text-xs px-1.5 py-0.5 rounded', polling ? 'text-green-400 bg-green-500/10' : 'text-slate-500')}>
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
                  <span className="text-emerald-400 shrink-0 w-16 truncate">{entry.epic}</span>
                  <span className={logColor(entry.type)}>{entry.msg}</span>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AlpacaTraderPage() {
  const [tab, setTab]             = useState<PageTab>('alpaca');
  const [mode, setMode]           = useState<AccountMode>('paper');
  const [strategy, setStrategy]   = useState<StrategyName>('rsi_mean_reversion');
  const [sizeUsd, setSizeUsd]     = useState('500');
  const [maxPos, setMaxPos]       = useState('3');
  const [allowShorts, setAllowShorts] = useState(false);
  const [allow24h, setAllow24h]       = useState(false);

  const [status, setStatus]       = useState<BotStatus | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [polling, setPolling]     = useState(false);

  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const serverHealth = useServerHealth();

  const handleStrategyChange = (s: StrategyName) => setStrategy(s);

  const applyRecommendation = (rec: StrategyRecommendation) => {
    handleStrategyChange(rec.strategy);
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
    void post('start', {
      strategy,
      positionSizeUsd: parseFloat(sizeUsd) || 500,
      maxPositions:    parseInt(maxPos, 10) || 3,
      allowShorts,
      allow24h,
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

            {status?.lossLock && (
              <span
                className="text-xs px-2 py-1 rounded-full font-medium bg-rose-500/20 text-rose-400"
                title="Daily loss limit reached — no new entries until the next trading day; exits are still managed"
              >
                🛑 Loss limit
              </span>
            )}

            <button
              onClick={() => { void fetchStatus(); }}
              className="p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400"
              title="Refresh status"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 p-1 bg-slate-900/60 border border-slate-800 rounded-xl w-fit">
          <button
            onClick={() => setTab('alpaca')}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              tab === 'alpaca' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200',
            )}
          >
            <BarChart2 className="w-4 h-4" />
            Alpaca (Stocks)
          </button>
          <button
            onClick={() => setTab('ig')}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              tab === 'ig' ? 'bg-emerald-700 text-white' : 'text-slate-400 hover:text-slate-200',
            )}
          >
            <TrendingUp className="w-4 h-4" />
            IG Spread Bet
          </button>
        </div>

        {tab === 'ig' && <IgSpreadBetTab />}

        {tab === 'alpaca' && <>

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

              {/* 24/5 trading toggle */}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <div
                  onClick={() => { if (!isRunning) setAllow24h(v => !v); }}
                  className={clsx(
                    'w-9 h-5 rounded-full relative transition-colors',
                    allow24h ? 'bg-amber-500' : 'bg-slate-700',
                    isRunning && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  <div className={clsx(
                    'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
                    allow24h ? 'left-4' : 'left-0.5',
                  )} />
                </div>
                <span className="text-xs text-slate-400">24/5 trading (trade outside NYSE hours)</span>
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

        </>}

      </div>
    </div>
  );
}

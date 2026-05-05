'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play, Square, Plus, Trash2, RefreshCw, CheckCircle2, AlertCircle,
  TrendingUp, TrendingDown, Zap, Settings, BarChart3, Clock,
  ChevronDown, ChevronUp, Wifi, WifiOff, X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { calcIndicators } from '@/lib/indicators';
import type { Candle } from '@/lib/indicators';
import type { AISignal } from '@/lib/claudeSignal';
import { fetchYahooQuotes, fetchYahooHistory } from '@/lib/yahooClient';
import type { QuoteResult } from '@/lib/yahooClient';

// ── Types ─────────────────────────────────────────────────────────────────────

type IGSession = { cst: string; securityToken: string; apiKey: string };
type IGCredentials = { username: string; password: string; apiKey: string; connected?: boolean };

type TradeLog = {
  id:         string;
  ts:         string;
  type:       'info' | 'scan' | 'signal' | 'trade' | 'skip' | 'error';
  symbol:     string;
  message:    string;
  signal?:    string;
  confidence?: number;
};

type PlacedTrade = {
  id:          string;
  symbol:      string;
  name:        string;
  epic:        string;
  direction:   'BUY' | 'SELL';
  size:        number;
  entryPrice:  number;
  stopLoss:    number;
  takeProfit:  number;
  dealRef:     string;
  placedAt:    string;
  env:         'demo' | 'live';
  confidence:  number;
};

type AutoConfig = {
  stakePerTrade:  number;
  minConfidence:  number;   // 1-10 from Claude
  maxPositions:   number;
  scanInterval:   number;   // minutes
  accounts:       ('demo' | 'live')[];
  preFilterRsi:   boolean;  // only call Claude if RSI/MACD pre-filters pass
};

// ── Stock universe ────────────────────────────────────────────────────────────

const DEFAULT_US_STOCKS = [
  'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META', 'GOOGL', 'AMD',
  'NFLX', 'PLTR', 'COIN', 'SNAP', 'SOFI', 'RIVN', 'F', 'BAC',
  'JPM', 'XOM', 'CVX', 'UBER', 'NIO', 'INTC', 'T', 'VZ',
];

const DEFAULT_UK_STOCKS = [
  'LLOY.L', 'BARC.L', 'VOD.L', 'BP.L', 'SHEL.L',
  'AZN.L', 'GSK.L', 'HSBA.L', 'RR.L', 'NWG.L',
];

const PLACED_TRADES_KEY = 'ig_auto_shares_trades';
const CONFIG_KEY        = 'ig_auto_shares_config';

function uid() { return Math.random().toString(36).slice(2, 9); }

function yahooToEpic(symbol: string): string {
  const ticker = symbol.replace('.L', '').replace('-', '.');
  return `CS.D.${ticker}.TODAY.IP`;
}

function isUKStock(symbol: string): boolean {
  return symbol.endsWith('.L');
}

// Pre-filter: should we call Claude? Only when indicators show a signal worth investigating.
function passesPreFilter(symbol: string, candles: Candle[]): { passes: boolean; reason: string } {
  if (candles.length < 26) return { passes: false, reason: 'insufficient data' };
  const ind = calcIndicators(candles).latest;

  if (ind.rsi === null) return { passes: false, reason: 'RSI unavailable' };

  const rsiBuy  = ind.rsi < 38;
  const rsiSell = ind.rsi > 62;
  const macdBull = ind.macdZone === 'bullish' && (ind.macdHist ?? 0) > 0;
  const macdBear = ind.macdZone === 'bearish' && (ind.macdHist ?? 0) < 0;
  const goldenCross = ind.smaCross === 'bullish';
  const deathCross  = ind.smaCross === 'bearish';
  const bbOversold  = ind.bbPosition === 'below';
  const bbOverbought = ind.bbPosition === 'above';

  const bullScore = (rsiBuy ? 2 : 0) + (macdBull ? 2 : 0) + (goldenCross ? 2 : 0) + (bbOversold ? 1 : 0);
  const bearScore = (rsiSell ? 2 : 0) + (macdBear ? 2 : 0) + (deathCross ? 2 : 0) + (bbOverbought ? 1 : 0);

  if (bullScore >= 3) return { passes: true, reason: `BUY setup: RSI ${ind.rsi.toFixed(0)}, MACD ${ind.macdZone}, BB ${ind.bbPosition}` };
  if (bearScore >= 3) return { passes: true, reason: `SELL setup: RSI ${ind.rsi.toFixed(0)}, MACD ${ind.macdZone}, BB ${ind.bbPosition}` };
  return { passes: false, reason: `Neutral: RSI ${ind.rsi.toFixed(0)}, MACD ${ind.macdZone}` };
}

function igHeaders(s: IGSession, env: 'demo' | 'live') {
  return { 'x-ig-cst': s.cst, 'x-ig-security-token': s.securityToken, 'x-ig-api-key': s.apiKey, 'x-ig-env': env };
}

async function getIGSession(env: 'demo' | 'live'): Promise<IGSession | null> {
  const credKey = env === 'demo' ? 'ig_demo_credentials' : 'ig_live_credentials';
  const sessKey = `ig_session_${env}`;
  try {
    const sessRaw = localStorage.getItem(sessKey);
    if (sessRaw) {
      const cached = JSON.parse(sessRaw) as { cst: string; securityToken: string; apiKey: string; authenticatedAt: number };
      if (cached.cst && Date.now() - cached.authenticatedAt < 5 * 60 * 60 * 1000)
        return { cst: cached.cst, securityToken: cached.securityToken, apiKey: cached.apiKey };
    }
    const raw = localStorage.getItem(credKey);
    if (!raw) return null;
    const creds = JSON.parse(raw) as IGCredentials;
    if (!creds.connected) return null;
    const res = await fetch('/api/ig/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: creds.username, password: creds.password, apiKey: creds.apiKey, env }),
    });
    const data = await res.json() as { ok: boolean; cst?: string; securityToken?: string; accountId?: string; error?: string };
    if (!data.ok || !data.cst) return null;
    const sess = { cst: data.cst, securityToken: data.securityToken!, apiKey: creds.apiKey };
    localStorage.setItem(sessKey, JSON.stringify({ ...sess, accountId: data.accountId, authenticatedAt: Date.now() }));
    return sess;
  } catch { return null; }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function LogEntry({ log }: { log: TradeLog }) {
  const icon =
    log.type === 'trade'  ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0 mt-0.5" /> :
    log.type === 'error'  ? <AlertCircle  className="h-3.5 w-3.5 text-red-400 flex-shrink-0 mt-0.5" /> :
    log.type === 'signal' ? <Zap          className="h-3.5 w-3.5 text-purple-400 flex-shrink-0 mt-0.5" /> :
    log.type === 'scan'   ? <RefreshCw    className="h-3.5 w-3.5 text-blue-400 flex-shrink-0 mt-0.5" /> :
    log.type === 'skip'   ? <X            className="h-3.5 w-3.5 text-gray-600 flex-shrink-0 mt-0.5" /> :
                            <Clock        className="h-3.5 w-3.5 text-gray-500 flex-shrink-0 mt-0.5" />;

  const textCol =
    log.type === 'trade'  ? 'text-emerald-300' :
    log.type === 'error'  ? 'text-red-400' :
    log.type === 'signal' ? 'text-purple-300' :
    log.type === 'skip'   ? 'text-gray-600' :
    'text-gray-400';

  return (
    <div className="flex items-start gap-2 py-1.5">
      {icon}
      <div className="min-w-0 flex-1">
        <span className="text-xs text-gray-600 mr-2">{new Date(log.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        <span className="font-mono text-xs text-gray-500 mr-1.5">[{log.symbol}]</span>
        <span className={clsx('text-xs', textCol)}>{log.message}</span>
      </div>
    </div>
  );
}

function PlacedTradeCard({ trade, onRemove }: { trade: PlacedTrade; onRemove: () => void }) {
  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold text-white text-sm">{trade.symbol}</span>
            <span className={clsx('text-xs font-semibold px-1.5 py-0.5 rounded', trade.direction === 'BUY' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400')}>
              {trade.direction}
            </span>
            <span className={clsx('text-xs px-1.5 py-0.5 rounded border', trade.env === 'live' ? 'border-red-500/30 text-red-400' : 'border-blue-500/30 text-blue-400')}>
              {trade.env.toUpperCase()}
            </span>
          </div>
          <div className="text-xs text-gray-500 mt-0.5">{trade.name}</div>
        </div>
        <button onClick={onRemove} className="p-1 text-gray-600 hover:text-gray-400 transition-colors">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-xs">
        <div><div className="text-gray-500">Entry</div><div className="font-mono text-white">{trade.entryPrice}</div></div>
        <div><div className="text-gray-500">Stop</div><div className="font-mono text-red-400">{trade.stopLoss}</div></div>
        <div><div className="text-gray-500">Target</div><div className="font-mono text-emerald-400">{trade.takeProfit}</div></div>
        <div><div className="text-gray-500">Size</div><div className="font-mono text-white">£{trade.size}/pt</div></div>
        <div><div className="text-gray-500">AI Confidence</div><div className="font-mono text-purple-400">{trade.confidence}/10</div></div>
        <div><div className="text-gray-500">Deal Ref</div><div className="font-mono text-gray-400 text-xs truncate">{trade.dealRef.slice(0, 10)}</div></div>
      </div>
      <div className="text-xs text-gray-600 mt-1.5">{new Date(trade.placedAt).toLocaleString('en-GB')}</div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function IGSharesAutoTrader() {
  const [running, setRunning]         = useState(false);
  const [log, setLog]                 = useState<TradeLog[]>([]);
  const [placedTrades, setPlacedTrades] = useState<PlacedTrade[]>([]);
  const [stockList, setStockList]     = useState<string[]>([...DEFAULT_US_STOCKS, ...DEFAULT_UK_STOCKS]);
  const [newTicker, setNewTicker]     = useState('');
  const [showConfig, setShowConfig]   = useState(false);
  const [showLog, setShowLog]         = useState(true);
  const [sessions, setSessions]       = useState<{ demo: IGSession | null; live: IGSession | null }>({ demo: null, live: null });
  const [connecting, setConnecting]   = useState(false);
  const [config, setConfig]           = useState<AutoConfig>({
    stakePerTrade:  1,
    minConfidence:  7,
    maxPositions:   5,
    scanInterval:   15,
    accounts:       ['demo'],
    preFilterRsi:   true,
  });

  const runnerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef    = useRef(false);
  const logEndRef   = useRef<HTMLDivElement>(null);

  // Load persisted state
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PLACED_TRADES_KEY);
      if (raw) setPlacedTrades(JSON.parse(raw) as PlacedTrade[]);
      const cfgRaw = localStorage.getItem(CONFIG_KEY);
      if (cfgRaw) setConfig(JSON.parse(cfgRaw) as AutoConfig);
    } catch { /* ignore */ }
  }, []);

  function saveTrades(trades: PlacedTrade[]) {
    setPlacedTrades(trades);
    try { localStorage.setItem(PLACED_TRADES_KEY, JSON.stringify(trades)); } catch { /* ignore */ }
  }

  function saveConfig(cfg: AutoConfig) {
    setConfig(cfg);
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
  }

  function addLog(entry: Omit<TradeLog, 'id' | 'ts'>) {
    setLog(prev => [...prev.slice(-199), { id: uid(), ts: new Date().toISOString(), ...entry }]);
  }

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  // ── Connect IG sessions ──────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    setConnecting(true);
    const demo = await getIGSession('demo');
    const live = await getIGSession('live');
    setSessions({ demo, live });
    if (!demo && !live) addLog({ type: 'error', symbol: 'SYS', message: 'No IG credentials found. Add them in Settings → Accounts.' });
    else addLog({ type: 'info', symbol: 'SYS', message: `Connected: ${demo ? 'DEMO ✓' : 'DEMO ✗'} ${live ? 'LIVE ✓' : 'LIVE ✗'}` });
    setConnecting(false);
  }, []); // eslint-disable-line

  useEffect(() => { connect(); }, []); // eslint-disable-line

  // ── Core scan loop ───────────────────────────────────────────────────────────

  const runOneCycle = useCallback(async () => {
    const activeAccounts = config.accounts.filter(a => sessions[a] !== null);
    if (activeAccounts.length === 0) {
      addLog({ type: 'error', symbol: 'SYS', message: 'No connected IG accounts for selected environments.' });
      return;
    }

    const currentPositions = placedTrades.filter(t => activeAccounts.includes(t.env));
    if (currentPositions.length >= config.maxPositions) {
      addLog({ type: 'info', symbol: 'SYS', message: `Max positions (${config.maxPositions}) reached — skipping scan cycle.` });
      return;
    }

    addLog({ type: 'info', symbol: 'SYS', message: `Starting scan cycle — ${stockList.length} stocks to evaluate…` });

    // Batch quote fetch directly from browser (avoids Vercel server-side blocking)
    let quotes: QuoteResult[] = [];
    try {
      quotes = await fetchYahooQuotes(stockList);
    } catch {
      addLog({ type: 'error', symbol: 'SYS', message: 'Failed to fetch batch quotes from Yahoo Finance.' });
      return;
    }

    for (const symbol of stockList) {
      if (abortRef.current) break;

      const quote = quotes.find(q => q.symbol === symbol);
      if (!quote || quote.price === 0) {
        addLog({ type: 'skip', symbol, message: 'No price data available.' });
        continue;
      }

      addLog({ type: 'scan', symbol, message: `Price: ${quote.price.toFixed(4)} · ${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%` });

      // Fetch historical candles directly from browser
      let candles: Candle[] = [];
      try {
        candles = await fetchYahooHistory(symbol);
      } catch {
        addLog({ type: 'skip', symbol, message: 'Failed to fetch price history.' });
        continue;
      }

      if (candles.length < 26) {
        addLog({ type: 'skip', symbol, message: `Insufficient history (${candles.length} days).` });
        continue;
      }

      // Pre-filter (saves Claude API calls)
      if (config.preFilterRsi) {
        const { passes, reason } = passesPreFilter(symbol, candles);
        if (!passes) {
          addLog({ type: 'skip', symbol, message: `Pre-filter: ${reason}` });
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        addLog({ type: 'signal', symbol, message: `Pre-filter passed — ${reason}` });
      }

      // Call Claude AI for signal
      let aiSignal: AISignal | null = null;
      try {
        const res = await fetch('/api/ig/claude-signal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            epic:           yahooToEpic(symbol),
            instrumentName: quote.name,
            candles,
            bid:            quote.bid,
            offer:          quote.ask,
            percentageChange: quote.changePercent,
            currency:       isUKStock(symbol) ? 'GBP' : 'USD',
          }),
        });
        const data = await res.json() as { ok: boolean; signal?: AISignal; error?: string };
        if (data.ok && data.signal) aiSignal = data.signal;
        else { addLog({ type: 'error', symbol, message: `AI error: ${data.error ?? 'unknown'}` }); continue; }
      } catch {
        addLog({ type: 'error', symbol, message: 'Claude API call failed.' });
        continue;
      }

      addLog({
        type: 'signal', symbol,
        message: `AI: ${aiSignal.signal} · confidence ${aiSignal.confidence}/10 · ${aiSignal.risk_level} risk · ${aiSignal.reasoning.slice(0, 80)}…`,
        signal: aiSignal.signal, confidence: aiSignal.confidence,
      });

      // Decision: trade?
      const actionable = (aiSignal.signal === 'BUY' || aiSignal.signal === 'SELL') && aiSignal.confidence >= config.minConfidence;
      if (!actionable) {
        addLog({ type: 'skip', symbol, message: `Signal ${aiSignal.signal} confidence ${aiSignal.confidence} < threshold ${config.minConfidence} — skip.` });
        await new Promise(r => setTimeout(r, 1_000));
        continue;
      }

      // Already have a position on this?
      const already = placedTrades.some(t => t.symbol === symbol && activeAccounts.includes(t.env));
      if (already) {
        addLog({ type: 'skip', symbol, message: 'Already have an open position — skip.' });
        continue;
      }

      // Place trade on each active account
      const epic = yahooToEpic(symbol);
      const currency = isUKStock(symbol) ? 'GBP' : 'USD';
      const priceFactor = isUKStock(symbol) ? 100 : 1; // Yahoo gives GBP, IG needs pence

      const stopLossIg   = aiSignal.stop_loss   * priceFactor;
      const takeProfitIg = aiSignal.take_profit  * priceFactor;

      for (const env of activeAccounts) {
        if (abortRef.current) break;
        const session = sessions[env];
        if (!session) continue;

        try {
          const res = await fetch('/api/ig/order', {
            method: 'POST',
            headers: { ...igHeaders(session, env), 'Content-Type': 'application/json' },
            body: JSON.stringify({
              epic,
              expiry:       'DFB',
              direction:    aiSignal.signal,
              size:         config.stakePerTrade,
              orderType:    'MARKET',
              currencyCode: currency,
              stopLevel:    stopLossIg,
              limitLevel:   takeProfitIg,
              forceOpen:    true,
            }),
          });
          const data = await res.json() as { ok: boolean; dealReference?: string; dealStatus?: string; level?: number; error?: string };

          if (data.ok) {
            const trade: PlacedTrade = {
              id:          uid(),
              symbol,
              name:        quote.name,
              epic,
              direction:   aiSignal.signal as 'BUY' | 'SELL',
              size:        config.stakePerTrade,
              entryPrice:  data.level ?? (aiSignal.entry_point * priceFactor),
              stopLoss:    stopLossIg,
              takeProfit:  takeProfitIg,
              dealRef:     data.dealReference ?? '—',
              placedAt:    new Date().toISOString(),
              env,
              confidence:  aiSignal.confidence,
            };
            saveTrades([...placedTrades, trade]);
            addLog({ type: 'trade', symbol, message: `${env.toUpperCase()} ${aiSignal.signal} opened · deal: ${data.dealReference} · status: ${data.dealStatus}` });
          } else {
            addLog({ type: 'error', symbol, message: `${env.toUpperCase()} order failed: ${data.error}` });
          }
        } catch (e) {
          addLog({ type: 'error', symbol, message: `${env.toUpperCase()} order exception: ${e instanceof Error ? e.message : String(e)}` });
        }

        await new Promise(r => setTimeout(r, 1_500)); // rate limit guard
      }

      await new Promise(r => setTimeout(r, 2_000)); // between stocks
    }

    addLog({ type: 'info', symbol: 'SYS', message: `Scan cycle complete. Next in ${config.scanInterval} min.` });
  }, [config, sessions, stockList, placedTrades]); // eslint-disable-line

  const startTrader = useCallback(() => {
    if (running) return;
    abortRef.current = false;
    setRunning(true);
    addLog({ type: 'info', symbol: 'SYS', message: `Auto-trader started · interval: ${config.scanInterval}min · confidence: ≥${config.minConfidence}/10 · stake: £${config.stakePerTrade}/pt` });
    runOneCycle();
    runnerRef.current = setInterval(() => {
      if (!abortRef.current) runOneCycle();
    }, config.scanInterval * 60_000);
  }, [running, config, runOneCycle]);

  const stopTrader = useCallback(() => {
    abortRef.current = true;
    if (runnerRef.current) { clearInterval(runnerRef.current); runnerRef.current = null; }
    setRunning(false);
    addLog({ type: 'info', symbol: 'SYS', message: 'Auto-trader stopped.' });
  }, []);

  const connectedAccounts = Object.entries(sessions).filter(([, s]) => s !== null).map(([env]) => env);
  const activeConfigAccounts = config.accounts.filter(a => sessions[a] !== null);

  return (
    <div className="space-y-4">
      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          {connectedAccounts.length > 0 ? (
            <Wifi className="h-4 w-4 text-emerald-400" />
          ) : (
            <WifiOff className="h-4 w-4 text-gray-500" />
          )}
          <span className="text-sm text-gray-400">
            {connectedAccounts.length > 0 ? `IG connected: ${connectedAccounts.map(a => a.toUpperCase()).join(', ')}` : 'IG not connected'}
          </span>
        </div>
        <Button
          onClick={connect}
          loading={connecting}
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          className="text-xs py-1.5"
        >
          Reconnect
        </Button>
        <div className="ml-auto flex gap-2">
          {!running ? (
            <Button
              onClick={startTrader}
              disabled={activeConfigAccounts.length === 0}
              icon={<Play className="h-4 w-4" />}
              className="bg-emerald-600 hover:bg-emerald-500"
            >
              Start Auto-Trading
            </Button>
          ) : (
            <Button
              onClick={stopTrader}
              icon={<Square className="h-4 w-4" />}
              className="bg-red-600 hover:bg-red-500"
            >
              Stop
            </Button>
          )}
        </div>
      </div>

      {running && (
        <div className="flex items-center gap-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3">
          <RefreshCw className="h-4 w-4 text-emerald-400 animate-spin flex-shrink-0" />
          <div className="text-sm text-emerald-300">
            Auto-trader running · scanning <span className="font-semibold">{stockList.length} stocks</span> every{' '}
            <span className="font-semibold">{config.scanInterval} min</span> ·
            placing on <span className="font-semibold">{activeConfigAccounts.map(a => a.toUpperCase()).join(' + ')}</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Left: config + stock list */}
        <div className="space-y-4">
          {/* Config */}
          <Card>
            <button
              onClick={() => setShowConfig(v => !v)}
              className="flex items-center justify-between w-full"
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <Settings className="h-4 w-4 text-gray-400" /> Configuration
              </div>
              {showConfig ? <ChevronUp className="h-4 w-4 text-gray-500" /> : <ChevronDown className="h-4 w-4 text-gray-500" />}
            </button>

            {showConfig && (
              <div className="mt-4 space-y-3">
                {/* Accounts */}
                <div>
                  <label className="text-xs text-gray-500 block mb-1.5">Trade on accounts</label>
                  <div className="flex gap-2">
                    {(['demo', 'live'] as const).map(env => {
                      const connected = sessions[env] !== null;
                      const active = config.accounts.includes(env);
                      return (
                        <button
                          key={env}
                          onClick={() => {
                            const next = active ? config.accounts.filter(a => a !== env) : [...config.accounts, env];
                            saveConfig({ ...config, accounts: next });
                          }}
                          disabled={!connected}
                          className={clsx(
                            'flex-1 py-2 rounded-lg text-xs font-semibold border transition-colors',
                            !connected ? 'opacity-30 cursor-not-allowed border-gray-700 text-gray-500' :
                            active && env === 'live' ? 'bg-red-600 border-red-500 text-white' :
                            active && env === 'demo' ? 'bg-blue-600 border-blue-500 text-white' :
                            'border-gray-700 text-gray-400 hover:border-gray-500'
                          )}
                        >
                          {env.toUpperCase()} {connected ? '' : '(not connected)'}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {[
                  { label: 'Stake (£/pt per trade)', key: 'stakePerTrade' as const, min: 0.1, step: 0.1 },
                  { label: 'Min AI confidence (1-10)', key: 'minConfidence' as const, min: 1, max: 10, step: 1 },
                  { label: 'Max open positions', key: 'maxPositions' as const, min: 1, max: 20, step: 1 },
                  { label: 'Scan interval (minutes)', key: 'scanInterval' as const, min: 5, max: 120, step: 5 },
                ].map(({ label, key, min, max, step }) => (
                  <div key={key}>
                    <label className="text-xs text-gray-500 block mb-1">{label}</label>
                    <input
                      type="number" min={min} max={max} step={step}
                      value={config[key]}
                      onChange={e => saveConfig({ ...config, [key]: parseFloat(e.target.value) || min })}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                ))}

                <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                  <input
                    type="checkbox" checked={config.preFilterRsi}
                    onChange={e => saveConfig({ ...config, preFilterRsi: e.target.checked })}
                    className="rounded border-gray-600 bg-gray-800 text-emerald-500 focus:ring-emerald-500"
                  />
                  Pre-filter with indicators (reduces Claude API calls)
                </label>

                <div className="text-xs text-yellow-500/70 bg-yellow-500/5 border border-yellow-500/20 rounded-lg p-2">
                  LIVE account will place real trades with real money. Only enable if you have configured and tested on DEMO first.
                </div>
              </div>
            )}
          </Card>

          {/* Stock list */}
          <Card>
            <CardHeader title="Stock Universe" subtitle={`${stockList.length} stocks to scan`} icon={<BarChart3 className="h-4 w-4" />} />
            <div className="flex gap-2 mb-3">
              <input
                type="text" value={newTicker}
                onChange={e => setNewTicker(e.target.value.toUpperCase())}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newTicker.trim()) {
                    setStockList(prev => [...new Set([...prev, newTicker.trim()])]);
                    setNewTicker('');
                  }
                }}
                placeholder="Add ticker (e.g. AAPL, LLOY.L)"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
              />
              <Button
                onClick={() => { if (newTicker.trim()) { setStockList(prev => [...new Set([...prev, newTicker.trim()])]); setNewTicker(''); } }}
                icon={<Plus className="h-3.5 w-3.5" />}
                className="text-xs py-1.5"
              >Add</Button>
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto">
              {stockList.map(sym => (
                <div key={sym} className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs font-mono text-gray-300">
                  <span>{sym}</span>
                  <button onClick={() => setStockList(prev => prev.filter(s => s !== sym))} className="text-gray-600 hover:text-red-400 ml-0.5">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Right: placed trades + log */}
        <div className="xl:col-span-2 space-y-4">
          {/* Placed trades */}
          {placedTrades.length > 0 && (
            <Card>
              <CardHeader
                title="Auto-Placed Trades"
                subtitle={`${placedTrades.length} positions opened by the bot`}
                icon={<TrendingUp className="h-4 w-4" />}
              />
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {[...placedTrades].reverse().map(trade => (
                  <PlacedTradeCard
                    key={trade.id}
                    trade={trade}
                    onRemove={() => saveTrades(placedTrades.filter(t => t.id !== trade.id))}
                  />
                ))}
              </div>
              <button
                onClick={() => { if (confirm('Clear all trade records? This does not close positions on IG.')) saveTrades([]); }}
                className="mt-3 text-xs text-gray-600 hover:text-red-400 transition-colors"
              >
                Clear all records
              </button>
            </Card>
          )}

          {/* Run log */}
          <Card>
            <button onClick={() => setShowLog(v => !v)} className="flex items-center justify-between w-full mb-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <Clock className="h-4 w-4 text-gray-400" />
                Activity Log
                <span className="text-xs text-gray-600 font-normal">({log.length} entries)</span>
              </div>
              {showLog ? <ChevronUp className="h-4 w-4 text-gray-500" /> : <ChevronDown className="h-4 w-4 text-gray-500" />}
            </button>

            {showLog && (
              <>
                {log.length === 0 ? (
                  <div className="py-8 text-center text-gray-600 text-sm">
                    No activity yet. Start the auto-trader to begin scanning.
                  </div>
                ) : (
                  <div className="max-h-96 overflow-y-auto divide-y divide-gray-800/50 pr-1">
                    {log.map(entry => <LogEntry key={entry.id} log={entry} />)}
                    <div ref={logEndRef} />
                  </div>
                )}
                {log.length > 0 && (
                  <button onClick={() => setLog([])} className="mt-2 text-xs text-gray-600 hover:text-gray-400 transition-colors">
                    Clear log
                  </button>
                )}
              </>
            )}
          </Card>

          {placedTrades.length === 0 && log.length === 0 && (
            <div className="text-center py-12">
              <Zap className="h-10 w-10 text-gray-700 mx-auto mb-3" />
              <p className="text-gray-500 text-sm">Configure your settings and click Start Auto-Trading</p>
              <p className="text-gray-600 text-xs mt-1">
                The bot will scan {stockList.length} stocks, run technical + AI analysis, and automatically open the best positions
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

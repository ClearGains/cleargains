'use client';

// Browser-resident CFD auto-trading bot for Interactive Brokers.
//
// Deliberately NOT server-resident like the IG/FX/Alpaca bots — this one
// only trades while this tab is open and IB Gateway is running on this same
// machine (https://localhost:5000). Closing the tab stops it completely;
// there is no backend process to auto-resume, and that's intentional. All
// "is it running / what strategy / what risk settings" state lives in this
// component's own React state, not persisted anywhere.
//
// Rules-only for now — no Gemini/AI call site here at all, by design (saves
// API calls until that's explicitly asked for). Strategy decisions come
// from lib/cfdStrategies.ts, ported from the Alpaca bot's own strategy
// functions (pure, broker-agnostic).
//
// NOTE: built against IBKR's documented API shapes, not yet exercised end to
// end (Gateway login wasn't completing as of writing this). Treat every
// ibkrClient call site as a first guess to verify once a real session works,
// not a settled implementation.

import { useState, useRef, useCallback, useEffect } from 'react';
import { Play, Square, AlertTriangle, Wifi, WifiOff } from 'lucide-react';
import { clsx } from 'clsx';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  checkAuthStatus, tickle, primeSession, getAccounts, searchContract,
  getSnapshot, getHistory, getPositions, placeOrders,
  type IbkrAccount, type IbkrPosition, type IbkrBar,
} from '@/lib/ibkrClient';
import {
  rsiMeanReversionSignal, emaCrossoverSignal, vwapSignal, donchianBreakoutSignal, macdCrossoverSignal,
  STRATEGY_META, type StrategyName, type Bar, type StrategySignal,
} from '@/lib/cfdStrategies';

type LogEntry = { id: string; ts: string; type: 'info' | 'enter' | 'exit' | 'wait' | 'error'; symbol: string; msg: string };
type TrackedConid = { symbol: string; conid: string };

const TICKLE_MS       = 55_000;   // IBKR recommends ~60s
const SEVERE_LOSS_MULT = 5;       // × maxRiskGbp — force close
const PROFIT_LOCK_MULT = 1.5;     // × maxRiskGbp — bank it

function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

function ibkrBarToBar(b: IbkrBar): Bar {
  return { t: new Date(b.t).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
}

const STRATEGY_OPTIONS: { value: StrategyName; label: string }[] = [
  { value: 'rsi_mean_reversion', label: 'RSI Mean Reversion' },
  { value: 'ema_crossover',      label: 'EMA Crossover' },
  { value: 'vwap',               label: 'VWAP Reversion' },
  { value: 'donchian_breakout',  label: 'Donchian Breakout' },
  { value: 'donchian_hourly',    label: 'Donchian Breakout (Hourly)' },
  { value: 'macd_crossover',     label: 'MACD Crossover' },
];

export function IBKRAutoTrader() {
  const [running, setRunning]         = useState(false);
  const [strategy, setStrategy]       = useState<StrategyName>('donchian_breakout');
  const [symbolsInput, setSymbolsInput] = useState('AAPL, MSFT, SPY');
  const [maxRiskGbp, setMaxRiskGbp]   = useState(10);
  const [maxPositions, setMaxPositions] = useState(3);
  const [allowShorts, setAllowShorts] = useState(true);

  const [gatewayOk, setGatewayOk]     = useState<boolean | null>(null);
  const [account, setAccount]         = useState<IbkrAccount | null>(null);
  const [positions, setPositions]     = useState<IbkrPosition[]>([]);
  const [log, setLog]                 = useState<LogEntry[]>([]);
  const [error, setError]             = useState<string | null>(null);

  const trackedRef  = useRef<TrackedConid[]>([]);
  const tickleRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const runningRef    = useRef(false);

  const addLog = useCallback((type: LogEntry['type'], symbol: string, msg: string) => {
    setLog(prev => [{ id: uid(), ts: new Date().toLocaleTimeString('en-GB', { hour12: false }), type, symbol, msg }, ...prev].slice(0, 300));
  }, []);

  // ── Gateway connectivity check (does not require the bot to be running) ──
  const checkGateway = useCallback(async () => {
    try {
      const status = await checkAuthStatus();
      setGatewayOk(status.authenticated === true);
      if (status.authenticated) {
        const accounts = await getAccounts();
        if (accounts[0]) setAccount(accounts[0]);
      }
    } catch (e) {
      setGatewayOk(false);
      setError(e instanceof Error ? e.message : 'Gateway unreachable');
    }
  }, []);

  useEffect(() => { void checkGateway(); }, [checkGateway]);

  // ── Risk management — same tiers as the IG bot: close on a real loss,
  // bank a real profit, otherwise leave it (no weekend-specific guard here,
  // this bot only ever runs while the tab is open anyway). ─────────────────
  const checkRiskGuards = useCallback(async (accountId: string) => {
    const pos = await getPositions(accountId);
    setPositions(pos);
    const severeLossCeiling = maxRiskGbp * SEVERE_LOSS_MULT;
    const profitLockFloor   = maxRiskGbp * PROFIT_LOCK_MULT;

    for (const p of pos) {
      const upl = p.unrealizedPnl ?? 0;
      const name = p.contractDesc ?? String(p.conid);
      if (upl <= -severeLossCeiling) {
        addLog('exit', name, `Severe loss ${upl.toFixed(2)} <= -${severeLossCeiling.toFixed(2)} — closing`);
        try {
          await placeOrders(accountId, [{
            conid: p.conid, orderType: 'MKT',
            side: p.position > 0 ? 'SELL' : 'BUY',
            quantity: Math.abs(p.position), tif: 'DAY', cOID: `severe-${p.conid}-${Date.now()}`,
          }]);
        } catch (e) { addLog('error', name, `Severe-loss close failed: ${e instanceof Error ? e.message : String(e)}`); }
      } else if (upl >= profitLockFloor) {
        addLog('exit', name, `Profit lock ${upl.toFixed(2)} >= ${profitLockFloor.toFixed(2)} — banking it`);
        try {
          await placeOrders(accountId, [{
            conid: p.conid, orderType: 'MKT',
            side: p.position > 0 ? 'SELL' : 'BUY',
            quantity: Math.abs(p.position), tif: 'DAY', cOID: `lock-${p.conid}-${Date.now()}`,
          }]);
        } catch (e) { addLog('error', name, `Profit-lock close failed: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }
  }, [maxRiskGbp, addLog]);

  // ── One evaluation cycle: fetch bars, run the strategy, act on it ────────
  const evaluateOne = useCallback(async (accountId: string, tc: TrackedConid, openCount: number) => {
    const meta = STRATEGY_META[strategy];
    const held = positions.find(p => String(p.conid) === tc.conid);
    const inPosition = !!held && held.position !== 0;
    const side = held ? (held.position > 0 ? 'long' : 'short') : undefined;

    if (!inPosition && openCount >= maxPositions) {
      addLog('wait', tc.symbol, `Max positions (${maxPositions}) reached`);
      return;
    }

    let bars: Bar[];
    try {
      const hist = await getHistory(tc.conid, meta.barPeriod, `${meta.barsNeeded}${meta.barPeriod.includes('d') ? 'd' : meta.barPeriod.includes('w') ? 'w' : 'min'}`);
      bars = (hist.data ?? []).map(ibkrBarToBar);
    } catch (e) {
      addLog('error', tc.symbol, `History fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (bars.length < 5) { addLog('wait', tc.symbol, 'Not enough bars yet'); return; }

    let signal: StrategySignal;
    switch (strategy) {
      case 'rsi_mean_reversion': signal = rsiMeanReversionSignal(bars, inPosition, side); break;
      case 'ema_crossover':      signal = emaCrossoverSignal(bars, inPosition, side); break;
      case 'vwap':               signal = vwapSignal(bars, bars[bars.length - 1].c, inPosition, side); break;
      case 'donchian_breakout':  signal = donchianBreakoutSignal(bars, inPosition, side); break;
      case 'donchian_hourly':    signal = donchianBreakoutSignal(bars, inPosition, side, 24, 12, 'hour'); break;
      case 'macd_crossover':     signal = macdCrossoverSignal(bars, inPosition, side); break;
      default: signal = { action: 'HOLD', reason: 'unsupported strategy' };
    }

    if (signal.action === 'HOLD') { addLog('wait', tc.symbol, signal.reason); return; }

    if ((signal.action === 'CLOSE_LONG' || signal.action === 'CLOSE_SHORT') && held) {
      addLog('exit', tc.symbol, signal.reason);
      try {
        await placeOrders(accountId, [{
          conid: Number(tc.conid), orderType: 'MKT',
          side: held.position > 0 ? 'SELL' : 'BUY',
          quantity: Math.abs(held.position), tif: 'DAY', cOID: `exit-${tc.conid}-${Date.now()}`,
        }]);
      } catch (e) { addLog('error', tc.symbol, `Exit failed: ${e instanceof Error ? e.message : String(e)}`); }
      return;
    }

    if ((signal.action === 'BUY' || signal.action === 'SELL') && !inPosition) {
      if (signal.action === 'SELL' && !allowShorts) { addLog('wait', tc.symbol, 'Shorts disabled'); return; }
      const last = bars[bars.length - 1].c;
      const stopDist = signal.stopPrice ? Math.abs(last - signal.stopPrice) : last * 0.02;
      const quantity = Math.max(1, Math.floor(maxRiskGbp / stopDist));
      addLog('enter', tc.symbol, `${signal.action} — ${signal.reason} (qty ${quantity})`);
      try {
        await placeOrders(accountId, [{
          conid: Number(tc.conid), orderType: 'MKT',
          side: signal.action, quantity, tif: 'DAY', cOID: `entry-${tc.conid}-${Date.now()}`,
        }]);
        // Stop/TP attachment as a follow-up order (IBKR bracket/OCA shape
        // needs empirical confirmation — placeholder single-leg entry only
        // until that's verified against a real paper fill).
      } catch (e) { addLog('error', tc.symbol, `Entry failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }, [strategy, positions, maxPositions, maxRiskGbp, allowShorts, addLog]);

  // ── Main poll cycle ───────────────────────────────────────────────────────
  const pollOnce = useCallback(async () => {
    if (!runningRef.current || !account) return;
    try {
      await checkRiskGuards(account.accountId);
      const openCount = positions.filter(p => p.position !== 0).length;
      for (const tc of trackedRef.current) {
        if (!runningRef.current) break;
        await evaluateOne(account.accountId, tc, openCount);
      }
    } catch (e) {
      addLog('error', '—', `Poll cycle failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [account, positions, checkRiskGuards, evaluateOne, addLog]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const status = await checkAuthStatus();
      if (!status.authenticated) { setError('Gateway session not authenticated — log in at https://localhost:5000 first'); return; }
      await primeSession();
      const accounts = await getAccounts();
      if (!accounts[0]) { setError('No IBKR account returned by Gateway'); return; }
      setAccount(accounts[0]);

      const symbols = symbolsInput.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      const resolved: TrackedConid[] = [];
      for (const symbol of symbols) {
        const results = await searchContract(symbol);
        const conid = results[0]?.conid;
        if (conid) { resolved.push({ symbol, conid }); addLog('info', symbol, `Resolved conid ${conid}`); }
        else addLog('error', symbol, 'No contract found — skipping');
      }
      if (!resolved.length) { setError('No symbols resolved to a tradeable contract'); return; }
      trackedRef.current = resolved;

      runningRef.current = true;
      setRunning(true);
      addLog('info', '—', `Started — ${strategy} on ${resolved.map(r => r.symbol).join(', ')} | £${maxRiskGbp} risk/trade`);

      tickleRef.current = setInterval(() => { void tickle().catch(() => {}); }, TICKLE_MS);
      pollRef.current    = setInterval(() => { void pollOnce(); }, STRATEGY_META[strategy].pollMs);
      void pollOnce();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start');
    }
  }, [symbolsInput, strategy, maxRiskGbp, addLog, pollOnce]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    if (tickleRef.current) { clearInterval(tickleRef.current); tickleRef.current = null; }
    if (pollRef.current)    { clearInterval(pollRef.current); pollRef.current = null; }
    addLog('info', '—', 'Stopped — no further activity until restarted');
  }, [addLog]);

  // Stopping this tab (navigation/close) is the actual "off switch" — no
  // cleanup needed beyond clearing timers, since nothing is persisted.
  useEffect(() => () => { runningRef.current = false; if (tickleRef.current) clearInterval(tickleRef.current); if (pollRef.current) clearInterval(pollRef.current); }, []);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {gatewayOk === null ? <Wifi className="h-4 w-4 text-gray-500" /> :
             gatewayOk ? <Wifi className="h-4 w-4 text-emerald-400" /> : <WifiOff className="h-4 w-4 text-red-400" />}
            <span className="text-sm font-semibold text-white">IBKR CFD Bot (browser-resident)</span>
          </div>
          <span className="text-[10px] text-gray-500">
            {gatewayOk === null ? 'Checking Gateway…' : gatewayOk ? `Connected — ${account?.accountId ?? '…'}` : 'Gateway not reachable — log in at localhost:5000'}
          </span>
        </div>
        <p className="text-[10px] text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1.5 mb-3">
          Runs only while this tab is open and IB Gateway is running on this machine. Closing the tab stops everything — no background trading, no server-side persistence. Paper trading only until you've verified this end to end.
        </p>

        {error && <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1 mb-3">{error}</div>}

        {!running && (
          <div className="space-y-2 mb-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Strategy</label>
              <select value={strategy} onChange={e => setStrategy(e.target.value as StrategyName)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white">
                {STRATEGY_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Symbols (comma-separated)</label>
              <input value={symbolsInput} onChange={e => setSymbolsInput(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white font-mono" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Max risk £/trade</label>
                <input type="number" min={1} value={maxRiskGbp} onChange={e => setMaxRiskGbp(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Max positions</label>
                <input type="number" min={1} value={maxPositions} onChange={e => setMaxPositions(Number(e.target.value))}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input type="checkbox" checked={allowShorts} onChange={e => setAllowShorts(e.target.checked)} />
              Allow shorts
            </label>
          </div>
        )}

        <div className="flex gap-2">
          {!running ? (
            <Button onClick={() => void start()} disabled={!gatewayOk} className="flex-1">
              <Play className="h-4 w-4 mr-1" /> Start
            </Button>
          ) : (
            <Button onClick={stop} variant="secondary" className="flex-1">
              <Square className="h-4 w-4 mr-1" /> Stop
            </Button>
          )}
          <Button onClick={() => void checkGateway()} variant="secondary">Recheck Gateway</Button>
        </div>
      </Card>

      {positions.length > 0 && (
        <Card className="p-4">
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Open Positions</div>
          <div className="space-y-1">
            {positions.filter(p => p.position !== 0).map(p => (
              <div key={p.conid} className="flex justify-between text-xs">
                <span className="text-white">{p.contractDesc ?? p.conid}</span>
                <span className={clsx(p.position > 0 ? 'text-emerald-400' : 'text-red-400')}>
                  {p.position > 0 ? 'LONG' : 'SHORT'} {Math.abs(p.position)} · P&L {(p.unrealizedPnl ?? 0).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Log</div>
        <div className="space-y-1 max-h-80 overflow-y-auto">
          {log.length === 0 && <p className="text-xs text-gray-600">No activity yet.</p>}
          {log.map(l => (
            <div key={l.id} className="flex items-start gap-2 text-[11px]">
              <span className="text-gray-600 shrink-0">{l.ts}</span>
              <span className={clsx('shrink-0 font-semibold uppercase',
                l.type === 'enter' ? 'text-emerald-400' : l.type === 'exit' ? 'text-blue-400' :
                l.type === 'error' ? 'text-red-400' : l.type === 'wait' ? 'text-gray-500' : 'text-gray-400')}>
                {l.type}
              </span>
              <span className="text-gray-500 shrink-0">[{l.symbol}]</span>
              <span className="text-gray-300">{l.msg}</span>
            </div>
          ))}
        </div>
      </Card>

      {!gatewayOk && (
        <Card className="p-4 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-gray-400">
            Gateway isn't reporting an authenticated session. Open <code className="text-gray-300">https://localhost:5000</code> in this browser, log in with your IBKR paper trading credentials, approve 2FA on your phone, then click &quot;Recheck Gateway&quot; above.
          </p>
        </Card>
      )}
    </div>
  );
}

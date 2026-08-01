'use client';

// Browser-resident CFD auto-trading bot for IG (not spread betting — a
// separate IG account/product type, switched into explicitly on login).
// Same "only trades while this tab is open" design as the IBKR foundation
// (components/ibkr/IBKRAutoTrader.tsx) — but IG's REST API is a normal
// cloud API, not a localhost-only Gateway, so this one talks to it via the
// site's own existing /api/ig/* routes instead of needing a local relay.
// Those routes (session, markets, snapshot, order, positions) already
// existed for the spread-bet features elsewhere on the site and needed no
// changes beyond adding an accountType option to the session route.
//
// Rules-only — no Gemini call site here, matching the same deliberate scope
// limit as the IBKR foundation. Strategy logic is lib/cfdStrategies.ts
// (broker-agnostic, shared with the IBKR component).
//
// Bars come from Yahoo Finance via the site's existing /api/chart/history
// (same route DailyBrief.tsx uses) rather than IG's own historical-data
// endpoint — deliberately, to avoid the REST allowance exhaustion this
// session spent a long time fixing for the other IG bots. Only the live
// price (via /api/ig/snapshot, not allowance-limited) and order execution
// itself touch IG directly.
//
// Confirmed live before building this: CFD indices/FX use different epics
// than spread-bet (e.g. IX.D.FTSE.CFD.IP vs IX.D.FTSE.DAILY.IP,
// CS.D.GBPUSD.CFD.IP vs CS.D.GBPUSD.TODAY.IP), CFD orders use expiry: '-'
// instead of 'DFB', and individual-share epics (UA.D.*, etc.) are shared
// between account types unchanged.

import { useState, useRef, useCallback, useEffect } from 'react';
import { Play, Square, AlertTriangle, Wifi, WifiOff } from 'lucide-react';
import { clsx } from 'clsx';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  rsiMeanReversionSignal, emaCrossoverSignal, vwapSignal, donchianBreakoutSignal, macdCrossoverSignal,
  STRATEGY_META, type StrategyName, type Bar, type StrategySignal,
} from '@/lib/cfdStrategies';

type LogEntry = { id: string; ts: string; type: 'info' | 'enter' | 'exit' | 'wait' | 'error'; symbol: string; msg: string };

type Instrument = { name: string; epic: string; yahooSymbol: string };

// Small, empirically-verified starting universe — expand once this is
// proven out. Indices/FX use the CFD-specific epic; shares reuse the same
// epic as everywhere else on the site (confirmed live: not account-type
// exclusive despite an old comment elsewhere claiming otherwise).
const INSTRUMENTS: Instrument[] = [
  { name: 'FTSE 100', epic: 'IX.D.FTSE.CFD.IP',   yahooSymbol: '^FTSE' },
  { name: 'GBP/USD',  epic: 'CS.D.GBPUSD.CFD.IP', yahooSymbol: 'GBPUSD=X' },
  { name: 'Apple',    epic: 'UA.D.AAPL.CASH.IP',  yahooSymbol: 'AAPL' },
];

type IgPosition = { dealId: string; epic: string; direction: string; size: number; level: number; upl: number; instrumentName: string };
type IgAuth = { cst: string; securityToken: string; apiKey: string; env: 'demo' | 'live'; accountId: string };

const SEVERE_LOSS_MULT = 5;
const PROFIT_LOCK_MULT = 1.5;

function uid(): string { return Math.random().toString(36).slice(2, 9); }

const STRATEGY_OPTIONS: { value: StrategyName; label: string }[] = [
  { value: 'rsi_mean_reversion', label: 'RSI Mean Reversion' },
  { value: 'ema_crossover',      label: 'EMA Crossover' },
  { value: 'vwap',               label: 'VWAP Reversion' },
  { value: 'donchian_breakout',  label: 'Donchian Breakout' },
  { value: 'donchian_hourly',    label: 'Donchian Breakout (Hourly)' },
  { value: 'macd_crossover',     label: 'MACD Crossover' },
];

function igHeaders(auth: IgAuth): Record<string, string> {
  return {
    'x-ig-cst': auth.cst, 'x-ig-security-token': auth.securityToken,
    'x-ig-api-key': auth.apiKey, 'x-ig-env': auth.env, 'Content-Type': 'application/json',
  };
}

type IGCfdAutoTraderProps = {
  // When set, locks this instance to one account type instead of offering
  // both in a dropdown — used to give demo and live their own separate tabs.
  // Live still hits the same hard block in start() regardless of this prop;
  // this only changes which account the form defaults/locks to, not whether
  // it's actually safe to start.
  fixedEnv?: 'demo' | 'live';
};

export function IGCfdAutoTrader({ fixedEnv }: IGCfdAutoTraderProps = {}) {
  const [running, setRunning]     = useState(false);
  const [strategy, setStrategy]   = useState<StrategyName>('donchian_breakout');
  const [env, setEnv]             = useState<'demo' | 'live'>(fixedEnv ?? 'demo');
  const [username, setUsername]   = useState('');
  const [password, setPassword]   = useState('');
  const [apiKey, setApiKey]       = useState('');
  const [maxRiskGbp, setMaxRiskGbp]   = useState(10);
  const [maxPositions, setMaxPositions] = useState(3);
  const [allowShorts, setAllowShorts] = useState(true);

  const [connected, setConnected]   = useState(false);
  const [positions, setPositions]   = useState<IgPosition[]>([]);
  const [log, setLog]               = useState<LogEntry[]>([]);
  const [error, setError]           = useState<string | null>(null);
  const [accountInfo, setAccountInfo] = useState<{
    accountId: string; accountName: string; accountType: string;
    balance: number; available: number; currency: string;
  } | null>(null);

  const authRef    = useRef<IgAuth | null>(null);
  const pollRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const runningRef  = useRef(false);

  const addLog = useCallback((type: LogEntry['type'], symbol: string, msg: string) => {
    setLog(prev => [{ id: uid(), ts: new Date().toLocaleTimeString('en-GB', { hour12: false }), type, symbol, msg }, ...prev].slice(0, 300));
  }, []);

  // ── Account identity check — explicit and repeated on purpose. IG's own
  // "preferred" account flag doesn't reflect which account a session is
  // actually switched to (confirmed live), so this always looks up by the
  // exact accountId returned from the login/switch call, never a guess. Logs
  // account number, type, and balance every time so it's obvious at a glance
  // whether this is hitting the intended demo CFD account. ──────────────────
  const refreshAccountInfo = useCallback(async (announce: boolean) => {
    const auth = authRef.current;
    if (!auth) return;
    try {
      const r = await fetch(`/api/ig/account?accountId=${encodeURIComponent(auth.accountId)}`, { headers: igHeaders(auth) });
      const d = await r.json() as {
        ok: boolean; accountId?: string; accountName?: string; accountType?: string;
        balance?: number; available?: number; currency?: string; error?: string;
      };
      if (!d.ok || !d.accountId) { addLog('error', '—', `Account check failed: ${d.error ?? 'unknown'}`); return; }
      if (d.accountId !== auth.accountId) {
        // Should never happen given the accountId-matched lookup above, but
        // this is exactly the kind of mismatch that must never pass silently.
        addLog('error', '—', `🚨 Account mismatch — expected ${auth.accountId}, got ${d.accountId}. Stopping.`);
        stop();
        return;
      }
      setAccountInfo({
        accountId: d.accountId, accountName: d.accountName ?? '', accountType: d.accountType ?? '',
        balance: d.balance ?? 0, available: d.available ?? 0, currency: d.currency ?? 'GBP',
      });
      if (announce) {
        addLog('info', '—', `Account confirmed: ${d.accountName} (${d.accountId}, ${d.accountType}, ${auth.env}) — balance ${d.currency}${d.balance?.toFixed(2)}, available ${d.currency}${d.available?.toFixed(2)}`);
      }
    } catch (e) {
      addLog('error', '—', `Account check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addLog]);

  // ── Positions + risk guards ──────────────────────────────────────────────
  const refreshPositionsAndGuard = useCallback(async (): Promise<IgPosition[]> => {
    const auth = authRef.current;
    if (!auth) return [];
    const r = await fetch('/api/ig/positions', { headers: igHeaders(auth) });
    const d = await r.json() as { ok: boolean; positions?: IgPosition[] };
    const pos = d.positions ?? [];
    setPositions(pos);

    const severeLossCeiling = maxRiskGbp * SEVERE_LOSS_MULT;
    const profitLockFloor   = maxRiskGbp * PROFIT_LOCK_MULT;
    for (const p of pos) {
      if (p.upl <= -severeLossCeiling || p.upl >= profitLockFloor) {
        const reason = p.upl <= -severeLossCeiling ? 'Severe loss' : 'Profit lock';
        addLog('exit', p.instrumentName, `${reason} ${p.upl.toFixed(2)} — closing`);
        try {
          await fetch('/api/ig/order', {
            method: 'DELETE', headers: igHeaders(auth),
            body: JSON.stringify({ dealId: p.dealId, direction: p.direction === 'BUY' ? 'SELL' : 'BUY', size: p.size }),
          });
        } catch (e) { addLog('error', p.instrumentName, `Close failed: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }
    return pos;
  }, [maxRiskGbp, addLog]);

  // ── One evaluation cycle ──────────────────────────────────────────────────
  const evaluateOne = useCallback(async (inst: Instrument, currentPositions: IgPosition[], openCount: number) => {
    const auth = authRef.current;
    if (!auth) return;
    const meta = STRATEGY_META[strategy];
    const held = currentPositions.find(p => p.epic === inst.epic);
    const inPosition = !!held;
    const side = held ? (held.direction === 'BUY' ? 'long' : 'short') : undefined;

    if (!inPosition && openCount >= maxPositions) {
      addLog('wait', inst.name, `Max positions (${maxPositions}) reached`);
      return;
    }

    // Bars from Yahoo — same route DailyBrief.tsx uses, no IG allowance cost.
    const resolution = meta.barPeriod === '1h' ? '10DH' : '3M';
    let bars: Bar[];
    try {
      const hRes = await fetch(`/api/chart/history?symbol=${encodeURIComponent(inst.yahooSymbol)}&resolution=${resolution}`);
      const hData = await hRes.json() as { candles?: Array<{ time: string; open: number; high: number; low: number; close: number }> };
      bars = (hData.candles ?? []).map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: 0 }));
    } catch (e) {
      addLog('error', inst.name, `Bars fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (bars.length < 5) { addLog('wait', inst.name, 'Not enough bars yet'); return; }

    // Live IG price for actual sizing/stop levels — /api/ig/snapshot isn't
    // allowance-limited (confirmed earlier this session, same route used by
    // the other IG bots' equivalent server-side logic).
    let livePrice = bars[bars.length - 1].c;
    try {
      const sRes = await fetch(`/api/ig/snapshot?epics=${encodeURIComponent(inst.epic)}`, { headers: igHeaders(auth) });
      const sData = await sRes.json() as { ok: boolean; snapshot?: Record<string, { mid: number }> };
      const snap = sData.snapshot?.[inst.epic];
      if (snap?.mid) livePrice = snap.mid;
    } catch { /* fall back to last Yahoo close */ }

    let signal: StrategySignal;
    switch (strategy) {
      case 'rsi_mean_reversion': signal = rsiMeanReversionSignal(bars, inPosition, side); break;
      case 'ema_crossover':      signal = emaCrossoverSignal(bars, inPosition, side); break;
      case 'vwap':               signal = vwapSignal(bars, livePrice, inPosition, side); break;
      case 'donchian_breakout':  signal = donchianBreakoutSignal(bars, inPosition, side); break;
      case 'donchian_hourly':    signal = donchianBreakoutSignal(bars, inPosition, side, 24, 12, 'hour'); break;
      case 'macd_crossover':     signal = macdCrossoverSignal(bars, inPosition, side); break;
      default: signal = { action: 'HOLD', reason: 'unsupported strategy' };
    }

    if (signal.action === 'HOLD') { addLog('wait', inst.name, signal.reason); return; }

    if ((signal.action === 'CLOSE_LONG' || signal.action === 'CLOSE_SHORT') && held) {
      addLog('exit', inst.name, signal.reason);
      try {
        await fetch('/api/ig/order', {
          method: 'DELETE', headers: igHeaders(auth),
          body: JSON.stringify({ dealId: held.dealId, direction: held.direction === 'BUY' ? 'SELL' : 'BUY', size: held.size }),
        });
      } catch (e) { addLog('error', inst.name, `Exit failed: ${e instanceof Error ? e.message : String(e)}`); }
      return;
    }

    if ((signal.action === 'BUY' || signal.action === 'SELL') && !inPosition) {
      if (signal.action === 'SELL' && !allowShorts) { addLog('wait', inst.name, 'Shorts disabled'); return; }
      const stopDist = signal.stopPrice ? Math.abs(livePrice - signal.stopPrice) : livePrice * 0.02;
      const size = Math.max(0.1, Math.round((maxRiskGbp / stopDist) * 100) / 100);
      addLog('enter', inst.name, `${signal.action} — ${signal.reason} (size ${size})`);
      try {
        const profitDist = signal.takeProfitPrice ? Math.abs(livePrice - signal.takeProfitPrice) : undefined;
        const r = await fetch('/api/ig/order', {
          method: 'POST', headers: igHeaders(auth),
          body: JSON.stringify({
            epic: inst.epic, expiry: '-', direction: signal.action, size,
            stopDistance: stopDist, profitDistance: profitDist, forceOpen: true,
          }),
        });
        const d = await r.json() as { ok: boolean; error?: string };
        if (!d.ok) addLog('error', inst.name, `Order rejected: ${d.error}`);
      } catch (e) { addLog('error', inst.name, `Entry failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }, [strategy, maxPositions, maxRiskGbp, allowShorts, addLog]);

  const pollOnce = useCallback(async () => {
    if (!runningRef.current) return;
    try {
      // Silent (announce=false) — updates the on-screen account card every
      // cycle without spamming the log, but still hard-stops on a mismatch.
      await refreshAccountInfo(false);
      if (!runningRef.current) return; // refreshAccountInfo may have called stop()
      const pos = await refreshPositionsAndGuard();
      const openCount = pos.length;
      for (const inst of INSTRUMENTS) {
        if (!runningRef.current) break;
        await evaluateOne(inst, pos, openCount);
      }
    } catch (e) {
      addLog('error', '—', `Poll cycle failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [refreshAccountInfo, refreshPositionsAndGuard, evaluateOne, addLog]);

  const start = useCallback(async () => {
    setError(null);
    if (!username || !password || !apiKey) { setError('Username, password and API key are required'); return; }
    // Confirmed live: logging into a CFD session invalidates any other
    // active session on the same login (tested directly — a second login
    // for a different account type kills the first one's session, 401 on
    // its next call). igStrategyBot.ts and fxScalperBot.ts both hold their
    // own persistent live spread-bet sessions on this same IG login — a
    // live CFD login here would very likely kick them. Demo-only until a
    // real fix (e.g. a separate API key, if IG's session limit turns out to
    // be scoped per-key rather than per-login) is actually verified.
    if (env === 'live') { setError('Live is disabled for now — starting a CFD session risks kicking out the other live bots’ IG sessions. Use demo.'); return; }
    try {
      const r = await fetch('/api/ig/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, apiKey, env, accountType: 'CFD' }),
      });
      const d = await r.json() as { ok: boolean; error?: string; cst?: string; securityToken?: string; accountId?: string };
      if (!d.ok || !d.cst || !d.securityToken) { setError(d.error ?? 'Login failed'); return; }
      authRef.current = { cst: d.cst, securityToken: d.securityToken, apiKey, env, accountId: d.accountId ?? '' };
      setConnected(true);

      // Confirm and log the exact account BEFORE marking as running — if
      // this doesn't come back as the expected CFD account, better to know
      // now than after the poll loop has already started acting on it.
      await refreshAccountInfo(true);

      runningRef.current = true;
      setRunning(true);
      addLog('info', '—', `Started — ${strategy} on ${INSTRUMENTS.map(i => i.name).join(', ')} | £${maxRiskGbp} risk/trade | ${env} CFD account`);

      pollRef.current = setInterval(() => { void pollOnce(); }, STRATEGY_META[strategy].pollMs);
      void pollOnce();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start');
    }
  }, [username, password, apiKey, env, strategy, maxRiskGbp, addLog, pollOnce, refreshAccountInfo]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    addLog('info', '—', 'Stopped — no further activity until restarted');
  }, [addLog]);

  useEffect(() => () => { runningRef.current = false; if (pollRef.current) clearInterval(pollRef.current); }, []);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {connected ? <Wifi className="h-4 w-4 text-emerald-400" /> : <WifiOff className="h-4 w-4 text-gray-500" />}
            <span className="text-sm font-semibold text-white">
              IG CFD Bot (browser-resident){fixedEnv ? ` — ${fixedEnv === 'live' ? 'Live' : 'Demo'}` : ''}
            </span>
          </div>
          <span className="text-[10px] text-gray-500">{connected ? `Connected — ${env} CFD` : 'Not connected'}</span>
        </div>
        <p className="text-[10px] text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1.5 mb-3">
          Runs only while this tab is open. Closing the tab stops everything — no background trading, no server-side persistence. Live is disabled for now: logging into a CFD session has been confirmed to invalidate other active sessions on the same IG login, which would risk kicking the other live bots (Gemini Opinion, FX Scalper) off their own sessions.
        </p>

        {error && <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1 mb-3">{error}</div>}

        {connected && accountInfo && (
          <div className="grid grid-cols-2 gap-2 mb-3 bg-gray-900/60 border border-gray-700 rounded px-3 py-2">
            <div>
              <div className="text-[9px] text-gray-500 uppercase tracking-wide">Account</div>
              <div className="text-xs text-white font-mono">{accountInfo.accountId} · {accountInfo.accountName}</div>
              <div className={clsx('text-[10px] font-semibold', accountInfo.accountType === 'CFD' ? 'text-emerald-400' : 'text-red-400')}>
                {accountInfo.accountType} {accountInfo.accountType !== 'CFD' && '⚠ expected CFD'}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[9px] text-gray-500 uppercase tracking-wide">Balance / Available</div>
              <div className="text-xs text-white font-mono">{accountInfo.currency}{accountInfo.balance.toFixed(2)}</div>
              <div className="text-[10px] text-gray-400 font-mono">avail {accountInfo.currency}{accountInfo.available.toFixed(2)}</div>
            </div>
          </div>
        )}

        {!running && (
          <div className="space-y-2 mb-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Account</label>
                {fixedEnv ? (
                  <div className={clsx(
                    'w-full rounded px-2 py-1.5 text-xs font-semibold border',
                    fixedEnv === 'live' ? 'bg-red-500/10 text-red-400 border-red-500/30' : 'bg-gray-800 text-gray-300 border-gray-700',
                  )}>
                    {fixedEnv === 'live' ? 'Live (locked — this tab is IG CFD Live)' : 'Demo (locked — this tab is IG CFD Demo)'}
                  </div>
                ) : (
                  <select value={env} onChange={e => setEnv(e.target.value as 'demo' | 'live')}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white">
                    <option value="demo">Demo</option>
                    <option value="live" disabled>Live (disabled — see note below)</option>
                  </select>
                )}
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Strategy</label>
                <select value={strategy} onChange={e => setStrategy(e.target.value as StrategyName)}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white">
                  {STRATEGY_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">IG username (account number)</label>
              <input value={username} onChange={e => setUsername(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white font-mono" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">IG password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white font-mono" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">IG API key</label>
              <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
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
            <p className="text-[10px] text-gray-600">
              Instruments: {INSTRUMENTS.map(i => i.name).join(', ')} (starting universe — expand once verified end to end)
            </p>
          </div>
        )}

        <div className="flex gap-2">
          {!running ? (
            <Button onClick={() => void start()} className="flex-1">
              <Play className="h-4 w-4 mr-1" /> Start
            </Button>
          ) : (
            <Button onClick={stop} variant="secondary" className="flex-1">
              <Square className="h-4 w-4 mr-1" /> Stop
            </Button>
          )}
        </div>
      </Card>

      {positions.length > 0 && (
        <Card className="p-4">
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Open Positions</div>
          <div className="space-y-1">
            {positions.map(p => (
              <div key={p.dealId} className="flex justify-between text-xs">
                <span className="text-white">{p.instrumentName}</span>
                <span className={clsx(p.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400')}>
                  {p.direction} {p.size} · P&L {p.upl.toFixed(2)}
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

      {!connected && (
        <Card className="p-4 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-gray-400">
            Enter your IG login above and click Start — this switches to your CFD account specifically (separate from spread betting), confirmed to exist on both your demo and live IG logins.
          </p>
        </Card>
      )}
    </div>
  );
}

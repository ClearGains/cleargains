import {
  authenticate,
  getSession,
  type IGSession,
} from './igApi';
import { createStreamManager } from './igStream';
import {
  initEpicState, processTick, recordFill,
  DEFAULT_CONFIG,
  type CandleTick, type ScalperEpicState, type ScalperConfig,
} from './scalperStrategy';
import { isMarketOpen } from './marketHours';
import { askGemini, type EntrySignal } from './gemini';
import type { BotStartParams, LogEntry, BotStatus, EpicStatus } from './bot';

export type AccountKey = 'demo' | 'live';

export type AccountBotHandle = {
  start:   (params: BotStartParams) => Promise<{ ok: boolean; error?: string }>;
  stop:    () => void;
  pause:   () => void;
  resume:  () => void;
  status:  () => BotStatus & { accountKey: AccountKey };
  candles: (epic?: string) => Record<string, CandleTick[]>;
};

function resolveCredentials(accountKey: AccountKey) {
  if (accountKey === 'live') {
    return {
      apiKey:   process.env.IG_LIVE_API_KEY   ?? '',
      username: process.env.IG_LIVE_USERNAME  ?? '',
      password: process.env.IG_LIVE_PASSWORD  ?? '',
      env:      'live' as const,
    };
  }
  return {
    apiKey:   process.env.IG_DEMO_API_KEY  ?? process.env.IG_API_KEY   ?? '',
    username: process.env.IG_DEMO_USERNAME ?? process.env.IG_USERNAME  ?? '',
    password: process.env.IG_DEMO_PASSWORD ?? process.env.IG_PASSWORD  ?? '',
    env:      'demo' as const,
  };
}

const MAX_CONCURRENT = 3;

export function createAccountBot(accountKey: AccountKey): AccountBotHandle {
  const tag    = `bot:${accountKey}`;
  const stream = createStreamManager(`igStream:${accountKey}`);

  // ── Per-instance state ─────────────────────────────────────────────────────
  let session:    IGSession | null = null;
  let running     = false;
  let paused      = false;
  let recentLosses = 0;
  let currentEpics: string[]  = [];
  let currentConfig: ScalperConfig = { ...DEFAULT_CONFIG };
  let epicStates: Record<string, ScalperEpicState> = {};
  const log: LogEntry[] = [];
  const monitorCandles = new Map<string, CandleTick[]>();

  let sessionRefreshTimer: ReturnType<typeof setTimeout>  | null = null;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function uid() { return Math.random().toString(36).slice(2, 9); }
  function ts()  { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

  function addLog(type: LogEntry['type'], epic: string, msg: string) {
    const entry: LogEntry = { id: uid(), ts: ts(), type, epic, msg };
    log.unshift(entry);
    if (log.length > 300) log.splice(300);
    const level = type === 'error' ? 'error' : 'log';
    console[level](`[${tag}] [${type.toUpperCase()}] [${epic}] ${msg}`);
  }

  // ── Candle accumulator ─────────────────────────────────────────────────────
  function feedCandle(epic: string, tick: CandleTick) {
    if (!tick.candleClosed) return;
    const arr = monitorCandles.get(epic) ?? [];
    arr.push(tick);
    if (arr.length > 60) arr.splice(0, arr.length - 60);
    monitorCandles.set(epic, arr);
  }

  // ── Session refresh ────────────────────────────────────────────────────────
  function scheduleRefresh(sess: IGSession) {
    if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
    const delay = sess.expiresAt - Date.now() - 5 * 60_000;
    if (delay <= 0) { void doRefresh(); return; }
    sessionRefreshTimer = setTimeout(() => { void doRefresh(); }, delay);
    console.log(`[${tag}] Session refresh in ${Math.round(delay / 60_000)} min`);
  }

  async function doRefresh() {
    const creds = resolveCredentials(accountKey);
    if (!creds.apiKey) return;
    try {
      addLog('info', '—', 'Refreshing IG session...');
      session = await authenticate(creds.apiKey, creds.username, creds.password, creds.env, accountKey);
      addLog('info', '—', `Session refreshed — expires ${new Date(session.expiresAt).toLocaleTimeString()}`);
      if (running) stream.connect(session, currentEpics, handleTick, '5MINUTE');
      scheduleRefresh(session);
    } catch (e) {
      addLog('error', '—', `Session refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      sessionRefreshTimer = setTimeout(() => { void doRefresh(); }, 5 * 60_000);
    }
  }

  // ── Tick handler — signal generation only, no trade execution ─────────────
  function handleTick(tick: CandleTick) {
    if (!running) return;
    feedCandle(tick.epic, tick);

    const st = epicStates[tick.epic];
    if (!st) return;

    const decision = processTick(st, tick, currentConfig);

    if (decision.action === 'HOLD'     && !tick.candleClosed) return;
    if (decision.action === 'WAIT'     && !tick.candleClosed) return;
    if (decision.action === 'COOLDOWN' && !tick.candleClosed) return;

    const name = tick.epic.split('.').slice(0, 3).join('.');

    switch (decision.action) {
      case 'ENTER': {
        if (paused) { if (tick.candleClosed) addLog('wait', name, 'Paused — skipping signal'); break; }

        const mkt = isMarketOpen(tick.epic);
        if (!mkt.open) { st.state = 'FLAT'; addLog('wait', name, `Market closed — ${mkt.reason}`); break; }

        const active = Object.values(epicStates).filter(s => s.state === 'IN_POSITION').length;
        if (active >= MAX_CONCURRENT) { st.state = 'FLAT'; addLog('wait', name, `Max active signals (${MAX_CONCURRENT}) reached`); break; }

        // Compute ATR-based stop/TP as initial estimate
        const atr     = decision.indicators.atr ?? 20;
        const stopPts = Math.max(5, Math.round(atr * currentConfig.atrStopMult));
        const tpPts   = Math.round(stopPts * 2);
        const rsiStr  = decision.indicators.rsi?.toFixed(0) ?? '—';

        addLog('info', name, `Strategy: ${decision.direction} · RSI ${rsiStr} · ${decision.reason} — asking Gemini…`);

        // Optimistic virtual fill to block duplicate signals while Gemini responds
        recordFill(st, tick.bidClose, stopPts, tpPts);
        st.dealId = `sig-${uid()}`;
        st.size   = 0;

        const entrySignal: EntrySignal = {
          instrumentName: name,
          epic:           tick.epic,
          rsi:            decision.indicators.rsi,
          macd:           decision.indicators.macd,
          atr:            decision.indicators.atr,
          greenCount:     decision.indicators.greenCount,
          suggestedDir:   decision.direction,
          lastCandles:    st.closedCandles.slice(-5).map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close })),
        };

        void askGemini(entrySignal).then(verdict => {
          addLog('info', name, `Gemini (${verdict.engine}): ${verdict.direction} ${verdict.confidence}% — ${verdict.reason}`);

          if (verdict.direction === 'SKIP' || verdict.confidence < currentConfig.minConfidence) {
            st.state  = 'FLAT';
            st.dealId = '';
            addLog('wait', name, `Gemini skipped signal (${verdict.direction}, ${verdict.confidence}%)`);
            return;
          }

          // Refine virtual fill with Gemini's validated stop/TP
          recordFill(st, tick.bidClose, verdict.stopPoints, verdict.takeProfitPoints);
          st.direction = verdict.direction;

          addLog('enter', name,
            `↑ SIGNAL ${verdict.direction} @ ${tick.bidClose.toFixed(1)} · Gemini ${verdict.confidence}% · stop ${verdict.stopPoints}pt TP ${verdict.takeProfitPoints}pt`
          );
        });
        break;
      }

      case 'EXIT': {
        const isLoss = /stop|reversal|red/i.test(decision.reason);
        if (isLoss) {
          recentLosses++;
          const autoCooldown = recentLosses >= 3 ? 60 * 60_000 : recentLosses >= 2 ? 30 * 60_000 : 15 * 60_000;
          if (autoCooldown !== currentConfig.cooldownMs) {
            currentConfig = { ...currentConfig, cooldownMs: autoCooldown };
            addLog('info', name, `Auto-cooldown → ${autoCooldown / 60_000} min (${recentLosses} losses)`);
          }
        } else { recentLosses = 0; }

        st.dealId = '';
        st.size   = 0;
        addLog('exit', name, `↓ EXIT${decision.urgency === 'immediate' ? ' [immediate]' : ''} — ${decision.reason}`);
        break;
      }

      case 'HOLD':    if (tick.candleClosed) addLog('hold', name, `HOLD — ${decision.reason}`); break;
      case 'WAIT':    if (tick.candleClosed) addLog('wait', name, `WAIT — ${decision.reason}`); break;
      case 'COOLDOWN': break;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  async function start(params: BotStartParams): Promise<{ ok: boolean; error?: string }> {
    stop();
    const creds = resolveCredentials(accountKey);
    if (!creds.apiKey || !creds.username || !creds.password) {
      const varPrefix = accountKey === 'live' ? 'IG_LIVE_' : 'IG_DEMO_';
      return { ok: false, error: `${varPrefix}API_KEY / USERNAME / PASSWORD env vars not set` };
    }

    try {
      addLog('info', '—', `Starting ${accountKey} data stream — epics: ${params.epics.join(', ')}`);

      // Reuse an existing valid session (e.g. from the legacy bot) — avoids a fresh
      // IG auth request that can 500 when the IP is rate-limited from rapid logins.
      const existing = getSession(accountKey);
      if (existing && Date.now() < existing.expiresAt - 2 * 60_000) {
        session = existing;
        addLog('info', '—', `Reusing existing ${accountKey} session — expires ${new Date(session.expiresAt).toLocaleTimeString()}`);
      } else {
        session = await authenticate(creds.apiKey, creds.username, creds.password, creds.env, accountKey);
      }

      currentEpics  = params.epics;
      recentLosses  = 0;
      currentConfig = { ...DEFAULT_CONFIG, ...(params.config ?? {}) };
      epicStates    = {};
      monitorCandles.clear();
      for (const epic of params.epics) epicStates[epic] = initEpicState(epic);

      running = true;
      stream.connect(session, params.epics, handleTick, '5MINUTE');
      scheduleRefresh(session);

      addLog('info', '—', `Stream started — ${params.epics.length} instrument(s). Session expires ${new Date(session.expiresAt).toLocaleTimeString()}`);
      return { ok: true };
    } catch (e) {
      running = false;
      const msg = e instanceof Error ? e.message : String(e);
      addLog('error', '—', `Start failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  function stop() {
    running = false;
    paused  = false;
    stream.disconnect();
    if (sessionRefreshTimer) { clearTimeout(sessionRefreshTimer); sessionRefreshTimer = null; }
    session = null;
    if (log.length) addLog('info', '—', `${accountKey} stream stopped`);
  }

  function pause() {
    if (!running) return;
    paused = true;
    addLog('info', '—', 'Paused — monitoring candles, signals suppressed');
  }

  function resume() {
    if (!running) return;
    paused = false;
    addLog('info', '—', 'Resumed — will emit signals on next trigger');
  }

  function candles(epic?: string): Record<string, CandleTick[]> {
    if (epic) {
      const arr = monitorCandles.get(epic);
      return arr ? { [epic]: arr } : {};
    }
    const result: Record<string, CandleTick[]> = {};
    for (const [k, v] of monitorCandles) result[k] = v;
    return result;
  }

  function status(): BotStatus & { accountKey: AccountKey } {
    const statuses: Record<string, EpicStatus> = {};
    for (const [epic, st] of Object.entries(epicStates)) {
      const tick = st.formingCandle;
      statuses[epic] = {
        state:        st.state,
        entryPrice:   st.entryPrice,
        lastPrice:    tick?.bidClose ?? 0,
        reds:         st.consecutiveReds,
        formingIsRed: tick ? tick.close < tick.open : null,
        pnlPct: null, // signal-only: no real P&L
      };
    }
    return {
      accountKey,
      running,
      paused,
      streamConnected: stream.isConnected(),
      epics:           currentEpics,
      recentLosses,
      config:          currentConfig,
      epicStatuses:    statuses,
      log:             log.slice(0, 100),
      sessionOk:       !!session && Date.now() < session.expiresAt,
      sessionExpiry:   session ? new Date(session.expiresAt).toISOString() : null,
    };
  }

  return { start, stop, pause, resume, status, candles };
}

// ── Singleton instances ───────────────────────────────────────────────────────
export const demoBot = createAccountBot('demo');
export const liveBot = createAccountBot('live');

export function getAccountBot(key: AccountKey): AccountBotHandle {
  return key === 'live' ? liveBot : demoBot;
}

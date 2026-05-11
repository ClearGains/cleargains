import {
  authenticate, openPosition, closePosition, fetchPositions,
  type IGSession,
} from './igApi';
import { createStreamManager } from './igStream';
import {
  initEpicState, processTick, recordFill,
  DEFAULT_CONFIG,
  calcRsi, calcMacdHist, calcAtr, isGreen, isRed,
  type CandleTick, type ScalperEpicState, type ScalperConfig,
} from './scalperStrategy';
import { isMarketOpen } from './marketHours';
import { askGemini, type EntrySignal } from './gemini';
import type { BotStartParams, InjectParams, LogEntry, BotStatus, EpicStatus } from './bot';

export type AccountKey = 'demo' | 'live';

export type AccountBotHandle = {
  start:   (params: BotStartParams) => Promise<{ ok: boolean; error?: string }>;
  stop:    () => void;
  pause:   () => void;
  resume:  () => void;
  inject:  (p: InjectParams) => { ok: boolean; error?: string };
  status:  () => BotStatus & { accountKey: AccountKey };
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
  // demo — fall back to generic vars for backward compat
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
  let pendingEpics = new Set<string>();
  const log: LogEntry[] = [];
  const monitorCandles = new Map<string, CandleTick[]>();

  let sessionRefreshTimer: ReturnType<typeof setTimeout>  | null = null;
  let signalMonitorTimer:  ReturnType<typeof setInterval> | null = null;

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

  // ── Signal monitor (per-instance) ─────────────────────────────────────────
  function feedCandle(epic: string, tick: CandleTick) {
    if (!tick.candleClosed) return;
    const arr = monitorCandles.get(epic) ?? [];
    arr.push(tick);
    if (arr.length > 40) arr.splice(0, arr.length - 40);
    monitorCandles.set(epic, arr);
  }

  async function runSignalCheck() {
    if (!session) return;
    let positions;
    try { positions = await fetchPositions(session); } catch { return; }
    if (!positions.length) return;

    for (const pos of positions) {
      const { epic, direction, dealId, size } = pos;
      const shortName = epic.split('.').slice(0, 3).join('.');
      if (currentEpics.includes(epic)) continue;  // scalper manages this

      const candles = monitorCandles.get(epic);
      if (!candles) { monitorCandles.set(epic, []); continue; }
      if (candles.length < 15) continue;

      const rsi  = calcRsi(candles);
      const macd = calcMacdHist(candles);
      const atr  = calcAtr(candles);
      const last5Green = candles.slice(-5).filter(isGreen).length;
      const last = candles[candles.length - 1];
      const isLong = direction === 'BUY';

      let score = 0;
      const reasons: string[] = [];
      if (isLong) {
        if (rsi !== null && rsi > 68)  { score++; reasons.push(`RSI overbought ${rsi.toFixed(0)}`); }
        if (rsi !== null && rsi > 75)  { score++; reasons.push('RSI very overbought'); }
        if (macd !== null && macd < 0) { score++; reasons.push('MACD bearish'); }
        if (last5Green <= 1)           { score++; reasons.push(`only ${last5Green}/5 green`); }
        if (isRed(last))               { score++; reasons.push('last candle red'); }
      } else {
        if (rsi !== null && rsi < 32)  { score++; reasons.push(`RSI oversold ${rsi.toFixed(0)}`); }
        if (rsi !== null && rsi < 25)  { score++; reasons.push('RSI very oversold'); }
        if (macd !== null && macd > 0) { score++; reasons.push('MACD bullish'); }
        if (last5Green >= 4)           { score++; reasons.push(`${last5Green}/5 green`); }
        if (isGreen(last))             { score++; reasons.push('last candle green'); }
      }

      if (score < 2) continue;

      addLog('info', shortName, `Signal monitor: ${isLong ? 'LONG' : 'SHORT'} — ${reasons.join(', ')} (score ${score})`);
      const closeDir = isLong ? 'SELL' : 'BUY';
      const verdict = await askGemini({
        instrumentName: shortName, epic, rsi, macd, atr,
        greenCount: last5Green, suggestedDir: closeDir,
        lastCandles: candles.slice(-5).map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close })),
      });
      addLog('info', shortName, `Gemini signal monitor: ${verdict.direction} ${verdict.confidence}% — ${verdict.reason}`);

      if (verdict.direction !== closeDir || verdict.confidence < 60) {
        addLog('wait', shortName, `Gemini not convinced — holding`);
        continue;
      }

      try {
        await closePosition(session, dealId, direction, size);
        addLog('exit', shortName, `Signal monitor closed ${direction} deal ${dealId}`);
      } catch (e) {
        addLog('error', shortName, `Signal monitor close failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  function startSignalMonitor() {
    if (signalMonitorTimer) clearInterval(signalMonitorTimer);
    signalMonitorTimer = setInterval(() => { void runSignalCheck(); }, 5 * 60_000);
    addLog('info', '—', 'Signal monitor started');
  }

  function stopSignalMonitor() {
    if (signalMonitorTimer) { clearInterval(signalMonitorTimer); signalMonitorTimer = null; }
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
      if (running) stream.connect(session, currentEpics, handleTick, '1MINUTE');
      scheduleRefresh(session);
    } catch (e) {
      addLog('error', '—', `Session refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      sessionRefreshTimer = setTimeout(() => { void doRefresh(); }, 5 * 60_000);
    }
  }

  // ── Tick handler ───────────────────────────────────────────────────────────
  function handleTick(tick: CandleTick) {
    if (!running) return;
    feedCandle(tick.epic, tick);

    const st = epicStates[tick.epic];
    if (!st) return;
    if (pendingEpics.has(tick.epic)) return;

    const decision = processTick(st, tick, currentConfig);

    if (decision.action === 'HOLD'     && !tick.candleClosed) return;
    if (decision.action === 'WAIT'     && !tick.candleClosed) return;
    if (decision.action === 'COOLDOWN' && !tick.candleClosed) return;

    const name = tick.epic.split('.').slice(0, 3).join('.');

    switch (decision.action) {
      case 'ENTER': {
        if (paused) { if (tick.candleClosed) addLog('wait', name, 'Paused — skipping entry'); break; }

        const mkt = isMarketOpen(tick.epic);
        if (!mkt.open) { st.state = 'FLAT'; addLog('wait', name, `Market closed — ${mkt.reason}`); break; }

        const active = Object.values(epicStates).filter(s => s.state === 'IN_POSITION').length + pendingEpics.size;
        if (active >= MAX_CONCURRENT) { st.state = 'FLAT'; addLog('wait', name, `Max positions (${MAX_CONCURRENT}) reached`); break; }

        addLog('info', name, `Signal ${decision.direction} — ${decision.reason}`);
        pendingEpics.add(tick.epic);

        if (!session) { addLog('error', name, 'No session — cannot open'); st.state = 'FLAT'; pendingEpics.delete(tick.epic); break; }

        const entrySignal: EntrySignal = {
          instrumentName: name, epic: tick.epic,
          rsi: decision.indicators.rsi, macd: decision.indicators.macd,
          atr: decision.indicators.atr, greenCount: decision.indicators.greenCount,
          suggestedDir: decision.direction,
          lastCandles: st.closedCandles.slice(-5).map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close })),
        };

        void askGemini(entrySignal).then(async verdict => {
          addLog('info', name, `Gemini (${verdict.engine}): ${verdict.direction} ${verdict.confidence}% — ${verdict.reason}`);

          if (verdict.direction === 'SKIP' || verdict.confidence < currentConfig.minConfidence) {
            st.state = 'FLAT';
            addLog('wait', name, `Skipped (${verdict.direction}, ${verdict.confidence}%)`);
            pendingEpics.delete(tick.epic);
            return;
          }

          st.direction = verdict.direction;

          try {
            await new Promise(r => setTimeout(r, Math.random() * 2000));
            if (!running || !session) { st.state = 'FLAT'; pendingEpics.delete(tick.epic); return; }

            const stopLevel  = verdict.direction === 'BUY' ? tick.bidClose - verdict.stopPoints : tick.bidClose + verdict.stopPoints;
            const limitLevel = verdict.direction === 'BUY' ? tick.bidClose + verdict.takeProfitPoints : tick.bidClose - verdict.takeProfitPoints;

            const { dealId, level } = await openPosition(session, tick.epic, verdict.betSize, verdict.direction, stopLevel, limitLevel);
            recordFill(st, level, verdict.stopPoints, verdict.takeProfitPoints);
            st.dealId = dealId;
            st.size   = verdict.betSize;
            addLog('enter', name, `${verdict.direction} £${verdict.betSize}/pt @ ${level} | stop −${verdict.stopPoints}pts | TP +${verdict.takeProfitPoints}pts | deal ${dealId}`);
          } catch (e) {
            st.state = 'FLAT';
            addLog('error', name, `Order failed: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            pendingEpics.delete(tick.epic);
          }
        });
        break;
      }

      case 'EXIT': {
        addLog('exit', name, `EXIT${decision.urgency === 'immediate' ? ' [IMMEDIATE]' : ''} — ${decision.reason}`);

        const isLoss = /stop|reversal|red/i.test(decision.reason);
        if (isLoss) {
          recentLosses++;
          const autoCooldown = recentLosses >= 3 ? 60 * 60_000 : recentLosses >= 2 ? 30 * 60_000 : 15 * 60_000;
          if (autoCooldown !== currentConfig.cooldownMs) {
            currentConfig = { ...currentConfig, cooldownMs: autoCooldown };
            addLog('info', name, `Auto-cooldown → ${autoCooldown / 60_000} min (${recentLosses} recent losses)`);
          }
        } else { recentLosses = 0; }

        const { dealId } = st;
        if (!dealId) { addLog('info', name, 'No dealId — may already be closed'); break; }
        pendingEpics.add(tick.epic);
        if (!session) { addLog('error', name, 'No session — cannot close'); pendingEpics.delete(tick.epic); break; }

        void closePosition(session, dealId, st.direction, st.size)
          .then(() => { st.dealId = ''; st.size = 0; addLog('exit', name, `Closed deal ${dealId}`); })
          .catch(e => addLog('error', name, `Close failed: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => pendingEpics.delete(tick.epic));
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
      addLog('info', '—', `Starting ${accountKey} bot — epics: ${params.epics.join(', ')}`);
      session = await authenticate(creds.apiKey, creds.username, creds.password, creds.env, accountKey);

      currentEpics  = params.epics;
      recentLosses  = 0;
      currentConfig = { ...DEFAULT_CONFIG, ...(params.config ?? {}) };
      epicStates    = {};
      monitorCandles.clear();
      for (const epic of params.epics) epicStates[epic] = initEpicState(epic);

      running = true;
      stream.connect(session, params.epics, handleTick, '1MINUTE');
      startSignalMonitor();
      scheduleRefresh(session);

      addLog('info', '—', `Bot started — ${params.epics.length} instrument(s). Session expires ${new Date(session.expiresAt).toLocaleTimeString()}`);
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
    stopSignalMonitor();
    if (sessionRefreshTimer) { clearTimeout(sessionRefreshTimer); sessionRefreshTimer = null; }
    session = null;
    if (log.length) addLog('info', '—', `${accountKey} bot stopped`);
  }

  function pause() {
    if (!running) return;
    paused = true;
    addLog('info', '—', 'Paused — monitoring open positions, no new entries');
  }

  function resume() {
    if (!running) return;
    paused = false;
    addLog('info', '—', 'Resumed — will enter on next signal');
  }

  function inject(params: InjectParams): { ok: boolean; error?: string } {
    if (!running) return { ok: false, error: 'Bot is not running' };
    const { epic, dealId, direction, size, entryPrice, stopPoints, tpPoints } = params;

    if (!epicStates[epic]) {
      epicStates[epic] = initEpicState(epic);
      if (session && !currentEpics.includes(epic)) {
        currentEpics = [...currentEpics, epic];
        stream.connect(session, currentEpics, handleTick, '1MINUTE');
      }
    }

    const st = epicStates[epic];
    st.state = 'IN_POSITION'; st.direction = direction;
    st.dealId = dealId;       st.size      = size;
    recordFill(st, entryPrice, stopPoints, tpPoints);

    const name = epic.split('.').slice(0, 3).join('.');
    addLog('info', name, `[DEBUG] Injected ${direction} — dealId=${dealId} entry=${entryPrice} stop±${stopPoints} tp±${tpPoints}`);
    return { ok: true };
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
        pnlPct: st.entryPrice > 0 && (tick?.bidClose ?? 0) > 0
          ? (tick!.bidClose - st.entryPrice) / st.entryPrice * 100
          : null,
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

  return { start, stop, pause, resume, inject, status };
}

// ── Singleton instances ───────────────────────────────────────────────────────
export const demoBot = createAccountBot('demo');
export const liveBot = createAccountBot('live');

export function getAccountBot(key: AccountKey): AccountBotHandle {
  return key === 'live' ? liveBot : demoBot;
}

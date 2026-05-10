import * as fs from 'fs';
import * as path from 'path';
import {
  authenticate, openPosition, closePosition,
  getSession, clearSession,
  type IGSession,
} from './igApi';
import { connect, disconnect, isConnected } from './igStream';
import {
  initEpicState, processTick, recordFill,
  DEFAULT_CONFIG,
  type CandleTick, type ScalperEpicState, type ScalperConfig,
} from './scalperStrategy';
import { isMarketOpen } from './marketHours';
import { askGemini, type EntrySignal } from './gemini';
import { feedCandle, runSignalCheck } from './signalMonitor';

export type InjectParams = {
  epic:        string;
  dealId:      string;
  direction:   'BUY' | 'SELL';
  size:        number;
  entryPrice:  number;
  stopPoints:  number;
  tpPoints:    number;
};

const STATE_FILE = path.join(__dirname, '..', 'bot-state.json');

// ── Types ────────────────────────────────────────────────────────────────────

export type LogEntry = {
  id:   string;
  ts:   string;
  type: 'info' | 'enter' | 'exit' | 'hold' | 'wait' | 'error' | 'cooldown';
  epic: string;
  msg:  string;
};

export type EpicStatus = {
  state:        string;
  entryPrice:   number;
  pnlPct:       number | null;
  lastPrice:    number;
  reds:         number;
  formingIsRed: boolean | null;
};

export type BotStartParams = {
  epics:    string[];
  config?:  Partial<ScalperConfig>;
};

export type BotStatus = {
  running:      boolean;
  paused:       boolean;
  streamConnected: boolean;
  epics:        string[];
  recentLosses: number;
  config:       ScalperConfig;
  epicStatuses: Record<string, EpicStatus>;
  log:          LogEntry[];
  sessionOk:    boolean;
  sessionExpiry: string | null;
};

// ── State ────────────────────────────────────────────────────────────────────

const MAX_CONCURRENT_POSITIONS = 3;

let running     = false;
let paused      = false;
let epicStates: Record<string, ScalperEpicState> = {};
let pendingEpics = new Set<string>();
let currentEpics:  string[] = [];
let currentConfig: ScalperConfig = { ...DEFAULT_CONFIG };
let recentLosses   = 0;   // tracks consecutive losing trades to auto-scale cooldown
let sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let signalMonitorTimer: ReturnType<typeof setInterval> | null = null;

const log: LogEntry[] = [];

function uid() { return Math.random().toString(36).slice(2, 9); }
function ts()  { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

function saveState(params: BotStartParams) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(params), 'utf8'); } catch {}
}
function clearState() {
  try { fs.unlinkSync(STATE_FILE); } catch {}
}
export function loadSavedState(): BotStartParams | null {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as BotStartParams; } catch { return null; }
}

function addLog(type: LogEntry['type'], epic: string, msg: string) {
  const entry: LogEntry = { id: uid(), ts: ts(), type, epic, msg };
  log.unshift(entry);
  if (log.length > 300) log.splice(300);
  const level = type === 'error' ? 'error' : 'log';
  console[level](`[${entry.ts}] [${type.toUpperCase()}] [${epic}] ${msg}`);
}


function startSignalMonitor() {
  if (signalMonitorTimer) clearInterval(signalMonitorTimer);
  // Run every 5 minutes — checks ALL open positions, not just scalper ones
  signalMonitorTimer = setInterval(() => {
    void runSignalCheck(currentEpics, addLog).then(newEpics => {
      if (newEpics.length > 0) {
        // Add newly discovered position epics to the Lightstreamer subscription
        const session = getSession();
        if (session) {
          const merged = [...new Set([...currentEpics, ...newEpics])];
          addLog('info', '—', `Signal monitor: adding ${newEpics.length} new epic(s) to stream`);
          connect(session, merged, handleTick, '1MINUTE');
        }
      }
    });
  }, 5 * 60_000);
  addLog('info', '—', 'Signal monitor started — checks all open positions every 5 min');
}

function stopSignalMonitor() {
  if (signalMonitorTimer) { clearInterval(signalMonitorTimer); signalMonitorTimer = null; }
}

// ── Session refresh ──────────────────────────────────────────────────────────

function scheduleSessionRefresh(session: IGSession) {
  if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
  const msUntilRefresh = session.expiresAt - Date.now() - 5 * 60_000;  // 5 min before expiry
  if (msUntilRefresh <= 0) {
    void refreshSession();
    return;
  }
  sessionRefreshTimer = setTimeout(() => { void refreshSession(); }, msUntilRefresh);
  console.log(`[bot] Session refresh scheduled in ${Math.round(msUntilRefresh / 60_000)} min`);
}

async function refreshSession() {
  const apiKey   = process.env.IG_API_KEY   ?? '';
  const username = process.env.IG_USERNAME  ?? '';
  const password = process.env.IG_PASSWORD  ?? '';
  const env      = (process.env.IG_ENV ?? 'demo') as 'demo' | 'live';

  try {
    addLog('info', '—', 'Refreshing IG session...');
    const session = await authenticate(apiKey, username, password, env);
    addLog('info', '—', `Session refreshed — expires ${new Date(session.expiresAt).toLocaleTimeString()}`);

    if (running) {
      // Reconnect Lightstreamer with new credentials
      connect(session, currentEpics, handleTick, '1MINUTE');
    }
    scheduleSessionRefresh(session);
  } catch (e) {
    addLog('error', '—', `Session refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    // Retry in 5 minutes
    sessionRefreshTimer = setTimeout(() => { void refreshSession(); }, 5 * 60_000);
  }
}

// ── Tick handler ─────────────────────────────────────────────────────────────

function handleTick(tick: CandleTick) {
  if (!running) return;
  // Feed all ticks into signal monitor candle store
  feedCandle(tick.epic, tick);

  const st = epicStates[tick.epic];
  if (!st) return;
  if (pendingEpics.has(tick.epic)) return;

  const decision = processTick(st, tick, currentConfig);

  // Update status (tracked in epicStates for status endpoint)
  // Only act on candle close or immediate exits
  if (decision.action === 'HOLD'    && !tick.candleClosed) return;
  if (decision.action === 'WAIT'    && !tick.candleClosed) return;
  if (decision.action === 'COOLDOWN' && !tick.candleClosed) return;

  const name = tick.epic.split('.').slice(0, 3).join('.');

  switch (decision.action) {
    case 'ENTER': {
      // Paused — skip new entries but still process exits
      if (paused) {
        if (tick.candleClosed) addLog('wait', name, '⏸ Paused — skipping entry');
        break;
      }

      // Market hours check
      const mkt = isMarketOpen(tick.epic);
      if (!mkt.open) {
        st.state = 'FLAT';
        addLog('wait', name, `⏸ Market closed — ${mkt.reason}`);
        break;
      }

      // Max concurrent positions guard
      const activePositions = Object.values(epicStates).filter(s => s.state === 'IN_POSITION').length + pendingEpics.size;
      if (activePositions >= MAX_CONCURRENT_POSITIONS) {
        st.state = 'FLAT';
        addLog('wait', name, `⏸ Max positions (${MAX_CONCURRENT_POSITIONS}) reached — skipping`);
        break;
      }

      addLog('info', name, `📊 Signal ${decision.direction} — ${decision.reason}`);
      pendingEpics.add(tick.epic);

      const session = getSession();
      if (!session) {
        addLog('error', name, '✗ No session — cannot open position');
        st.state = 'FLAT';
        pendingEpics.delete(tick.epic);
        break;
      }

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

      void askGemini(entrySignal).then(async verdict => {
        addLog('info', name, `🤖 Gemini (${verdict.engine}): ${verdict.direction} ${verdict.confidence}% — ${verdict.reason}`);

        if (verdict.direction === 'SKIP' || verdict.confidence < currentConfig.minConfidence) {
          st.state = 'FLAT';
          addLog('wait', name, `✋ Skipped (${verdict.direction}, confidence ${verdict.confidence}%)`);
          pendingEpics.delete(tick.epic);
          return;
        }

        // Gemini may override technical direction
        st.direction = verdict.direction;

        try {
          // Stagger concurrent orders — random 0-2s delay so multiple instruments
          // don't all hit IG's API simultaneously
          await new Promise(r => setTimeout(r, Math.random() * 2000));
          if (!running) { st.state = 'FLAT'; pendingEpics.delete(tick.epic); return; }

          const stopLevel  = verdict.direction === 'BUY'
            ? tick.bidClose - verdict.stopPoints
            : tick.bidClose + verdict.stopPoints;
          const limitLevel = verdict.direction === 'BUY'
            ? tick.bidClose + verdict.takeProfitPoints
            : tick.bidClose - verdict.takeProfitPoints;

          const { dealId, level } = await openPosition(
            session, tick.epic, verdict.betSize,
            verdict.direction, stopLevel, limitLevel,
          );

          recordFill(st, level, verdict.stopPoints, verdict.takeProfitPoints);
          st.dealId = dealId;
          st.size   = verdict.betSize;

          addLog('enter', name,
            `✓ ${verdict.direction} £${verdict.betSize}/pt @ ${level} | stop −${verdict.stopPoints}pts | TP +${verdict.takeProfitPoints}pts | deal ${dealId}`
          );
        } catch (e) {
          st.state = 'FLAT';
          addLog('error', name, `✗ Order failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          pendingEpics.delete(tick.epic);
        }
      });
      break;
    }

    case 'EXIT': {
      const urgencyTag = decision.urgency === 'immediate' ? ' [IMMEDIATE]' : '';
      addLog('exit', name, `↓ EXIT${urgencyTag} — ${decision.reason}`);

      // Track losses to auto-scale cooldown
      const isLoss = decision.reason.includes('stop') || decision.reason.includes('Stop') ||
                     decision.reason.includes('reversal') || decision.reason.includes('red');
      if (isLoss) {
        recentLosses++;
        // Auto-scale cooldown: 15min → 30min → 60min after repeated losses
        const autoCooldown = recentLosses >= 3 ? 60 * 60_000 : recentLosses >= 2 ? 30 * 60_000 : 15 * 60_000;
        if (autoCooldown !== currentConfig.cooldownMs) {
          currentConfig = { ...currentConfig, cooldownMs: autoCooldown };
          addLog('info', name, `⚙ Auto-cooldown adjusted to ${autoCooldown / 60_000} min (${recentLosses} recent losses)`);
        }
      } else {
        recentLosses = 0;  // reset on profitable exit
      }

      // Use dealId stored on entry — no position poll needed
      const dealId = st.dealId;
      const size   = st.size;
      if (!dealId) {
        addLog('info', name, 'No dealId on record — position may already be closed');
        break;
      }
      pendingEpics.add(tick.epic);
      const session = getSession();
      if (!session) {
        addLog('error', name, '✗ No session — cannot close position');
        pendingEpics.delete(tick.epic);
        break;
      }
      void closePosition(session, dealId, st.direction, size)
        .then(() => {
          st.dealId = '';
          st.size   = 0;
          addLog('exit', name, `✓ Closed deal ${dealId}`);
        })
        .catch(e => {
          addLog('error', name, `✗ Close failed: ${e instanceof Error ? e.message : String(e)}`);
        })
        .finally(() => pendingEpics.delete(tick.epic));
      break;
    }

    case 'HOLD':
      if (tick.candleClosed) addLog('hold', name, `→ HOLD — ${decision.reason}`);
      break;

    case 'WAIT':
      if (tick.candleClosed) addLog('wait', name, `… WAIT — ${decision.reason}`);
      break;

    case 'COOLDOWN':
      break;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function startBot(params: BotStartParams): Promise<{ ok: boolean; error?: string }> {
  if (running) stopBot();

  const apiKey   = process.env.IG_API_KEY   ?? '';
  const username = process.env.IG_USERNAME  ?? '';
  const password = process.env.IG_PASSWORD  ?? '';
  const env      = (process.env.IG_ENV ?? 'demo') as 'demo' | 'live';

  if (!apiKey || !username || !password) {
    return { ok: false, error: 'IG_API_KEY, IG_USERNAME, IG_PASSWORD env vars not set' };
  }

  try {
    addLog('info', '—', `Starting bot — epics: ${params.epics.join(', ')} | fully automated sizing`);
    const session = await authenticate(apiKey, username, password, env);

    currentEpics  = params.epics;
    recentLosses  = 0;
    currentConfig = { ...DEFAULT_CONFIG, ...(params.config ?? {}) };
    epicStates    = {};
    for (const epic of params.epics) {
      epicStates[epic] = initEpicState(epic);
    }

    running = true;
    connect(session, params.epics, handleTick, '1MINUTE');
    startSignalMonitor();
    scheduleSessionRefresh(session);

    saveState(params);
    addLog('info', '—', `Bot started — ${params.epics.length} instrument(s). Session expires ${new Date(session.expiresAt).toLocaleTimeString()}`);
    return { ok: true };
  } catch (e) {
    running = false;
    const msg = e instanceof Error ? e.message : String(e);
    addLog('error', '—', `Bot start failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

export function stopBot() {
  running = false;
  paused  = false;
  disconnect();
  stopSignalMonitor();
  if (sessionRefreshTimer) { clearTimeout(sessionRefreshTimer); sessionRefreshTimer = null; }
  clearSession();
  clearState();
  addLog('info', '—', 'Bot stopped');
}

export function pauseBot() {
  if (!running) return;
  paused = true;
  addLog('info', '—', '⏸ Bot paused — monitoring open positions, no new entries');
}

export function resumeBot() {
  if (!running) return;
  paused = false;
  addLog('info', '—', '▶ Bot resumed — will enter new positions on next signal');
}

export function injectPosition(params: InjectParams): { ok: boolean; error?: string } {
  if (!running) return { ok: false, error: 'Bot is not running' };

  const { epic, dealId, direction, size, entryPrice, stopPoints, tpPoints } = params;

  if (!epicStates[epic]) {
    epicStates[epic] = initEpicState(epic);
    // Also subscribe to this epic's stream if not already watching it
    const session = getSession();
    if (session && !currentEpics.includes(epic)) {
      currentEpics = [...currentEpics, epic];
      connect(session, currentEpics, handleTick, '1MINUTE');
    }
  }

  const st = epicStates[epic];
  st.state     = 'IN_POSITION';
  st.direction = direction;
  st.dealId    = dealId;
  st.size      = size;
  recordFill(st, entryPrice, stopPoints, tpPoints);

  const name = epic.split('.').slice(0, 3).join('.');
  addLog('info', name,
    `[DEBUG] Injected ${direction} position — dealId=${dealId} entry=${entryPrice} stop±${stopPoints} tp±${tpPoints}`
  );

  return { ok: true };
}

export function getBotStatus(): BotStatus {
  const session = getSession();
  const statuses: Record<string, EpicStatus> = {};

  for (const [epic, st] of Object.entries(epicStates)) {
    const tick = st.formingCandle;
    statuses[epic] = {
      state:        st.state,
      entryPrice:   st.entryPrice,
      lastPrice:    tick?.bidClose ?? 0,
      reds:         st.consecutiveReds,
      formingIsRed: tick ? tick.close < tick.open : null,
      pnlPct:       st.entryPrice > 0 && (tick?.bidClose ?? 0) > 0
        ? (tick!.bidClose - st.entryPrice) / st.entryPrice * 100
        : null,
    };
  }

  return {
    running,
    paused,
    streamConnected: isConnected(),
    epics:           currentEpics,
    recentLosses,
    config:          currentConfig,
    epicStatuses:    statuses,
    log:             log.slice(0, 100),
    sessionOk:       !!session && Date.now() < session.expiresAt,
    sessionExpiry:   session ? new Date(session.expiresAt).toISOString() : null,
  };
}

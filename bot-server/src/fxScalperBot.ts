import * as fs from 'fs';
import * as path from 'path';
import {
  authenticate, getSession, closePosition, placeMarketOrder,
  fetchMarketDetails, fetchAccountFunds, fetchFullPositions, fetchCandleHistory,
  updatePositionLevels,
  type IGSession, type CandleBar,
} from './igApi';
import { createStreamManager } from './igStream';
import {
  initEpicState, processTick, recordFill, DEFAULT_CONFIG,
  type CandleTick, type ScalperEpicState, type ScalperConfig,
} from './scalperStrategy';
import { isMarketOpen, isClosingSoon } from './marketHours';
import { askGemini, type EntrySignal } from './gemini';
import { resolveCredentials, isLossLocked, registerBotOpenedDeal, type IgMode } from './igStrategyBot';
import { FX_EPICS, SCALPER_INDEX_EPICS } from './igStrategyScanner';

// ── Dedicated FX scalper — persistent, real execution ───────────────────────
// Sources 5-min candles from IG's Lightstreamer feed (free, push-based — no
// REST historical-data allowance cost, unlike igStrategyBot.ts's poll-based
// strategies) and runs the same rules engine + Gemini second-opinion pattern
// the legacy data-only bot (bot.ts/botAccount.ts) already computes but never
// acts on. This module actually places and closes real orders.
//
// Deliberately its own factory/closure per mode (mirrors botAccount.ts's
// createAccountBot pattern) rather than folding into igStrategyBot.ts's
// single-config-per-mode ModeState — that state model has no way to run two
// independent strategies concurrently on one mode, and its severe-loss/
// profit-lock thresholds are scaled to *that* bot's own maxRiskGbp, which
// would silently mis-calibrate FX's real protection if reused as-is. This
// module gets its own equivalent checks (see maintenance() below) scaled to
// its own risk setting, but still registers into igStrategyBot.ts's shared
// botOpenedDeals set + Gemini Position Watch so self-heal-of-naked-stops and
// position review cover FX positions too, without duplicating that logic.

export type FxMode = IgMode;

export type FxLogEntry = {
  id:   string;
  ts:   string;
  type: 'info' | 'enter' | 'exit' | 'hold' | 'wait' | 'error' | 'cooldown';
  epic: string;
  msg:  string;
};

export type FxScalperStartParams = {
  epics?:      string[];   // defaults to all 5 FX majors + 4 supported indices
  maxRiskGbp?: number;     // £ lost if stop hit — independent of igStrategyBot's own maxRiskGbp
  config?:     Partial<ScalperConfig>;
};

export type FxEpicStatus = {
  state:      string;
  direction:  'BUY' | 'SELL';
  entryPrice: number;
  lastPrice:  number;
  dealId:     string;
  pnlPct:     number | null;
};

export type FxScalperStatus = {
  mode:             FxMode;
  running:          boolean;
  paused:           boolean;
  streamConnected:  boolean;
  epics:            string[];
  maxRiskGbp:        number;
  epicStatuses:      Record<string, FxEpicStatus>;
  log:               FxLogEntry[];
  sessionOk:         boolean;
  sessionExpiry:     string | null;
};

export type FxScalperHandle = {
  start:  (params: FxScalperStartParams) => Promise<{ ok: boolean; error?: string }>;
  stop:   () => void;
  pause:  () => void;
  resume: () => void;
  status: () => FxScalperStatus;
};

// ── Persistence ──────────────────────────────────────────────────────────────

type PersistedStartParams = { epics: string[]; maxRiskGbp: number };

function stateFile(mode: FxMode): string { return path.join(__dirname, '..', `fx-scalper-state-${mode}.json`); }
function epicsFile(mode: FxMode): string { return path.join(__dirname, '..', `fx-scalper-epics-${mode}.json`); }

function saveStartState(mode: FxMode, params: PersistedStartParams): void {
  try { fs.writeFileSync(stateFile(mode), JSON.stringify(params), 'utf8'); } catch {}
}
function clearStartState(mode: FxMode): void {
  try { fs.unlinkSync(stateFile(mode)); } catch {}
}
export function loadSavedFxScalperState(mode: FxMode): PersistedStartParams | null {
  try { return JSON.parse(fs.readFileSync(stateFile(mode), 'utf8')) as PersistedStartParams; } catch { return null; }
}

// Persists dealId/size/direction/entry/stop/TP/cooldown per epic across
// restarts — without this, a PM2 restart while IN_POSITION would silently
// orphan a real open position (no tracked dealId to close it with, and the
// scalper would start scoring fresh candles from FLAT as if nothing were
// open, while the actual position sits unmanaged by this module — still
// covered by the shared botOpenedDeals self-heal/Gemini-watch registration,
// but this module's own exit logic wouldn't apply to it anymore).
function saveEpicStates(mode: FxMode, states: Record<string, ScalperEpicState>): void {
  try { fs.writeFileSync(epicsFile(mode), JSON.stringify(states), 'utf8'); } catch {}
}
function loadEpicStates(mode: FxMode): Record<string, ScalperEpicState> | null {
  try { return JSON.parse(fs.readFileSync(epicsFile(mode), 'utf8')) as Record<string, ScalperEpicState>; } catch { return null; }
}

// ── Constants ────────────────────────────────────────────────────────────────

const WEEKEND_FLATTEN_BUFFER_MIN = 30;   // flatten open FX positions this many minutes before Friday 22:00 UTC close
const MAINTENANCE_MS             = 5 * 60_000;
const MAX_LOSS_CEILING_MULT      = 3;    // matches igStrategyBot.ts's realized-max-loss ceiling ratio

function epicName(epic: string): string { return epic.split('.').slice(0, 3).join('.'); }

// Mirrors igStrategyBot.ts's module-private calcStake formula exactly —
// duplicated rather than exported cross-module since this module always
// calls it with its own, deliberately independent maxRiskGbp.
function calcStake(riskGbp: number, stopDist: number, minStake: number): number {
  if (stopDist <= 0) return minStake;
  const raw = riskGbp / stopDist;
  return Math.max(minStake, Math.round(raw * 100) / 100);
}

function barToTick(epic: string, bar: CandleBar): CandleTick {
  return {
    epic,
    time:         bar.snapshotTime,
    open:         bar.openPrice.mid  ?? bar.openPrice.bid,
    high:         bar.highPrice.mid  ?? bar.highPrice.bid,
    low:          bar.lowPrice.mid   ?? bar.lowPrice.bid,
    close:        bar.closePrice.mid ?? bar.closePrice.bid,
    bidClose:     bar.closePrice.bid,
    offerClose:   bar.closePrice.ask,
    candleClosed: true,
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createFxScalperBot(mode: FxMode): FxScalperHandle {
  const tag    = `fx-scalper:${mode}`;
  const stream = createStreamManager(`igStream:fxScalper:${mode}`);

  let session:       IGSession | null = null; // execution — live creds for the live instance, places/closes real orders
  let dataSession:   IGSession | null = null; // data — ALWAYS demo creds, feeds Lightstreamer + prewarm's candle history
  let running        = false;
  let paused         = false;
  let currentEpics:  string[] = [];
  let maxRiskGbp     = 5;
  let currentConfig: ScalperConfig = { ...DEFAULT_CONFIG };
  let epicStates:    Record<string, ScalperEpicState> = {};
  const log: FxLogEntry[] = [];

  let sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let maintenanceTimer:    ReturnType<typeof setInterval> | null = null;
  let authFailCount = 0;

  function uid() { return Math.random().toString(36).slice(2, 9); }
  function ts()  { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

  function addLog(type: FxLogEntry['type'], epic: string, msg: string): void {
    const entry: FxLogEntry = { id: uid(), ts: ts(), type, epic, msg };
    log.unshift(entry);
    if (log.length > 300) log.splice(300);
    console[type === 'error' ? 'error' : 'log'](`[${tag}] [${type.toUpperCase()}] [${epic}] ${msg}`);
  }

  // ── Session refresh ──────────────────────────────────────────────────────
  function scheduleRefresh(sess: IGSession): void {
    if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);

    const now = new Date();
    const day = now.getUTCDay();
    if (day === 0 || day === 6) {
      // FX itself doesn't reopen until Sunday 22:00 UTC — no point refreshing sooner.
      const sunday22 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      sunday22.setUTCDate(sunday22.getUTCDate() + ((7 - day) % 7));
      sunday22.setUTCHours(22, 0, 0, 0);
      const sleepMs = Math.max(sunday22.getTime() - now.getTime(), 60_000);
      addLog('info', '—', `Weekend — deferring session refresh until Sunday 22:00 UTC (~${Math.round(sleepMs / 3_600_000)}h)`);
      sessionRefreshTimer = setTimeout(() => { void doRefresh(); }, sleepMs);
      return;
    }

    const delay = sess.expiresAt - Date.now() - 5 * 60_000;
    if (delay <= 0) { void doRefresh(); return; }
    sessionRefreshTimer = setTimeout(() => { void doRefresh(); }, delay);
  }

  // Data session credentials — ALWAYS demo, regardless of which mode this
  // instance is. IG's demo account streams the same real market data as
  // live (only the account/execution side is simulated), and demo's
  // historical-data REST allowance is tracked completely independently from
  // live's — sourcing candles from demo means generating a signal never
  // touches the live account's own allowance, which (confirmed live) gets
  // exhausted far more easily since it also carries the stock bot's poll
  // traffic. For the demo instance itself, data and execution are already
  // the same account, so this just reuses the execution session directly.
  async function authDataSession(): Promise<IGSession> {
    if (mode === 'demo') return session!;
    const dataCreds = resolveCredentials('demo');
    if (!dataCreds.apiKey) throw new Error('IG_DEMO_API_KEY / USERNAME / PASSWORD not set — required for live FX data feed');
    return authenticate(dataCreds.apiKey, dataCreds.username, dataCreds.password, dataCreds.env, `fxscalper-data:${mode}`);
  }

  async function doRefresh(): Promise<void> {
    const creds = resolveCredentials(mode);
    if (!creds.apiKey) return;
    try {
      addLog('info', '—', 'Refreshing IG session(s)...');
      session     = await authenticate(creds.apiKey, creds.username, creds.password, creds.env, `fxscalper:${mode}`);
      dataSession = await authDataSession();
      authFailCount = 0;
      addLog('info', '—', `Session(s) refreshed — execution expires ${new Date(session.expiresAt).toLocaleTimeString()}`);
      if (running) stream.connect(dataSession, currentEpics, handleTick, '5MINUTE');
      scheduleRefresh(session);
    } catch (e) {
      authFailCount++;
      addLog('error', '—', `Session refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      if (authFailCount >= 3) {
        addLog('error', '—', `Auth failed ${authFailCount}× in a row — stopping retries to prevent account lockout. Fix credentials and restart.`);
        return;
      }
      const backoffMs = 5 * 60_000 * Math.pow(2, authFailCount - 1);
      sessionRefreshTimer = setTimeout(() => { void doRefresh(); }, backoffMs);
    }
  }

  // ── Close + reset helper — shared by strategy-driven EXIT and the
  // maintenance sweep's severe-loss/profit-lock/weekend-flatten closes ──────
  async function closeAndReset(epic: string, dealId: string, direction: 'BUY' | 'SELL', size: number): Promise<void> {
    if (!session) return;
    try {
      await closePosition(session, dealId, direction, size);
      const st = epicStates[epic];
      if (st) {
        // Real cooldown, using the field scalperStrategy.ts already defines
        // for exactly this — processTick already knows how to honor
        // st.state === 'COOLDOWN', it just never gets set anywhere upstream
        // of this module, which otherwise leaves nothing stopping an
        // immediate re-entry on the very next candle after every exit.
        st.state         = 'COOLDOWN';
        st.cooldownUntil = Date.now() + currentConfig.cooldownMs;
        st.dealId = ''; st.size = 0;
        st.entryPrice = 0; st.dynamicStopPrice = 0; st.takeProfitPrice = 0;
      }
      saveEpicStates(mode, epicStates);
    } catch (e) {
      addLog('error', epicName(epic), `Close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Tick handler ─────────────────────────────────────────────────────────
  function handleTick(tick: CandleTick): void {
    if (!running) return;
    const st = epicStates[tick.epic];
    if (!st) return;

    const name = epicName(tick.epic);

    // Capture pre-decision fields so an ENTER we end up skipping (Gemini
    // SKIP, or a guard below) or an EXIT whose close call fails can be
    // reverted to their actual pre-processTick values — processTick mutates
    // st in place before this function gets a chance to act on the result.
    const preState  = st.state;
    const preDeal   = st.dealId;
    const preSize   = st.size;
    const preEntry  = st.entryPrice;
    const preStop   = st.dynamicStopPrice;
    const preTp     = st.takeProfitPrice;

    const decision = processTick(st, tick, currentConfig);

    if ((decision.action === 'HOLD' || decision.action === 'WAIT' || decision.action === 'COOLDOWN') && !tick.candleClosed) return;

    switch (decision.action) {
      case 'ENTER': {
        void (async () => {
          const revertToFlat = () => {
            st.state = preState; st.dealId = preDeal; st.size = preSize;
            st.entryPrice = preEntry; st.dynamicStopPrice = preStop; st.takeProfitPrice = preTp;
          };

          if (paused) { addLog('wait', name, 'Paused — skipping entry'); revertToFlat(); return; }

          const mkt = isMarketOpen(tick.epic);
          if (!mkt.open) { addLog('wait', name, `Market closed — ${mkt.reason}`); revertToFlat(); return; }
          if (isClosingSoon(tick.epic)) { addLog('wait', name, 'Closing soon — no new entries'); revertToFlat(); return; }

          if (isLossLocked(mode)) {
            addLog('wait', name, 'Stock bot daily-loss lock active for this account — skipping new FX entry');
            revertToFlat();
            return;
          }

          if (!session) { addLog('error', name, 'No session — cannot enter'); revertToFlat(); return; }

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

          const verdict = await askGemini(entrySignal);
          addLog('info', name, `Gemini (${verdict.engine}): ${verdict.direction} ${verdict.confidence}% — ${verdict.reason}`);
          if (verdict.noCapacityReason) {
            addLog('info', name, `⚠ Gemini ${verdict.noCapacityReason === 'cap-reached' ? 'daily cap reached' : 'API key unavailable'} — trading on rules-only fallback verdict`);
          }

          if (verdict.direction === 'SKIP' || verdict.confidence < currentConfig.minConfidence) {
            addLog('wait', name, `Gemini skipped entry (${verdict.direction}, ${verdict.confidence}%)`);
            revertToFlat();
            return;
          }

          try {
            const details = await fetchMarketDetails(session, [tick.epic]);
            const detail  = details.get(tick.epic);
            const minDeal = detail?.minDealSize ?? 0.1;
            const minStop = detail?.minStopDist ?? 1;

            const stopDist   = Math.max(verdict.stopPoints, minStop);
            const profitDist = Math.max(verdict.takeProfitPoints, 1);

            if (detail?.bid !== undefined && detail?.offer !== undefined) {
              const spread = detail.offer - detail.bid;
              if (spread > stopDist * 0.25) {
                addLog('wait', name, `Spread ${spread.toFixed(1)} too wide vs stop ${stopDist.toFixed(1)} — skipping`);
                revertToFlat();
                return;
              }
            }

            const stake = calcStake(maxRiskGbp, stopDist, minDeal);
            const actualMaxLoss = stake * stopDist;
            if (actualMaxLoss > maxRiskGbp * MAX_LOSS_CEILING_MULT) {
              addLog('wait', name, `Realized max loss £${actualMaxLoss.toFixed(2)} exceeds ${MAX_LOSS_CEILING_MULT}× target — skipping`);
              revertToFlat();
              return;
            }

            const funds = await fetchAccountFunds(session);
            if (detail?.marginFactorPct !== undefined && detail?.bid !== undefined && detail?.offer !== undefined) {
              const midPrice = (detail.bid + detail.offer) / 2;
              const requiredMargin = stake * midPrice * (detail.marginFactorPct / 100);
              if (requiredMargin > funds.available) {
                addLog('wait', name, `Required margin £${requiredMargin.toFixed(2)} exceeds available £${funds.available.toFixed(2)} — skipping`);
                revertToFlat();
                return;
              }
            }

            // Final live guard immediately before ordering — catches both a
            // stale in-memory state and (since FX epics are excluded from
            // the stock bot's own scan universe specifically to avoid this)
            // any residual manual/external duplicate.
            const livePositions = await fetchFullPositions(session);
            if (livePositions.some(p => p.epic === tick.epic)) {
              addLog('wait', name, 'Position already open on this epic — skipping');
              revertToFlat();
              return;
            }

            const { dealId, level, protectionOk, protectionError } =
              await placeMarketOrder(session, tick.epic, verdict.direction as 'BUY' | 'SELL', stake, stopDist, profitDist);

            recordFill(st, level, stopDist, profitDist);
            st.dealId = dealId;
            st.size   = stake;

            addLog('enter', name, `↑ ${verdict.direction} @ ${level.toFixed(2)} · stake ${stake} · stop ${stopDist.toFixed(1)}pt TP ${profitDist.toFixed(1)}pt · Gemini ${verdict.confidence}%`);
            if (!protectionOk) addLog('error', name, `🚨 UNPROTECTED — stop/TP attach failed: ${protectionError ?? 'unknown'}. Monitor manually.`);

            registerBotOpenedDeal(mode, dealId);
            try {
              const { addToWatch } = await import('./geminiWatch');
              addToWatch(mode, dealId);
            } catch {}

            saveEpicStates(mode, epicStates);
          } catch (e) {
            addLog('error', name, `Order placement failed: ${e instanceof Error ? e.message : String(e)}`);
            revertToFlat();
          }
        })();
        break;
      }

      case 'EXIT': {
        const dealId = preDeal, size = preSize, direction = st.direction;
        if (!dealId) { addLog('error', name, 'EXIT decided but no tracked dealId — nothing to close'); break; }
        addLog('exit', name, `↓ EXIT${decision.urgency === 'immediate' ? ' [immediate]' : ''} — ${decision.reason}`);
        void closeAndReset(tick.epic, dealId, direction, size);
        break;
      }

      case 'HOLD':     if (tick.candleClosed) addLog('hold', name, decision.reason); break;
      case 'WAIT':     if (tick.candleClosed) addLog('wait', name, decision.reason); break;
      case 'COOLDOWN': if (tick.candleClosed) addLog('cooldown', name, decision.reason); break;
    }
  }

  // ── Maintenance sweep — FX-scoped severe-loss/profit-lock + weekend risk
  // guard. Deliberately NOT reusing igStrategyBot.ts's equivalents: those are
  // scaled off that bot's own cfg.maxRiskGbp (unrelated to this module's).
  // Weekend handling used to hard-flatten every remaining position
  // regardless of P&L — changed after live review: closing purely because
  // "it can't be monitored" crystallizes P&L at an arbitrary moment even
  // when there's no actual reason to exit, and Gemini Position Watch keeps
  // reviewing gemini_opinion-owned stock positions through the weekend
  // anyway. Now mirrors igStrategyBot.ts's weekend guard: only close for an
  // actual reason (severe loss or a profit worth banking, both already
  // checked below), otherwise just tighten the stop to cap the gap-risk
  // downside and let it ride. ─────────────────────────────────────────────
  async function maintenance(): Promise<void> {
    if (!running || !session) return;
    try {
      const positions = await fetchFullPositions(session);
      const tracked = Object.values(epicStates).filter(st => st.dealId);

      const severeLossCeiling = maxRiskGbp * 5;
      const profitLockFloor   = maxRiskGbp * 1.5;

      const now = new Date();
      const isFriday = now.getUTCDay() === 5;
      const minsToClose = (22 * 60) - (now.getUTCHours() * 60 + now.getUTCMinutes());
      const weekendGuardWindow = isFriday && minsToClose > 0 && minsToClose <= WEEKEND_FLATTEN_BUFFER_MIN;

      for (const st of tracked) {
        const p = positions.find(pos => pos.dealId === st.dealId);
        if (!p) continue; // closed elsewhere already (e.g. broker-side stop/TP) — epicStates will self-correct on next EXIT/ENTER cycle

        if (p.upl <= -severeLossCeiling) {
          addLog('exit', epicName(p.epic), `🚨 Severe loss £${p.upl.toFixed(2)} ≤ -£${severeLossCeiling.toFixed(2)} — force-closing`);
          await closeAndReset(p.epic, p.dealId, p.direction, p.size);
        } else if (p.upl >= profitLockFloor) {
          addLog('exit', epicName(p.epic), `🔒 Profit lock +£${p.upl.toFixed(2)} ≥ £${profitLockFloor.toFixed(2)} — locking in gain`);
          await closeAndReset(p.epic, p.dealId, p.direction, p.size);
        } else if (weekendGuardWindow && p.stopLevel !== undefined) {
          const currentDist   = Math.abs(p.level - p.stopLevel);
          const tightenedDist = currentDist * 0.5;
          const newStop       = p.direction === 'BUY' ? p.level - tightenedDist : p.level + tightenedDist;
          const wouldTighten  = p.direction === 'BUY' ? newStop > p.stopLevel : newStop < p.stopLevel;
          if (wouldTighten) {
            try {
              await updatePositionLevels(session, p.dealId, newStop, p.limitLevel ?? null);
              addLog('info', epicName(p.epic), `Weekend risk guard — tightened stop ${currentDist.toFixed(2)}→${tightenedDist.toFixed(2)} pts ahead of the gap, ${minsToClose}min to Friday close`);
            } catch (e) {
              addLog('error', epicName(p.epic), `Weekend stop-tighten failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      }
    } catch (e) {
      addLog('error', '—', `Maintenance sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Candle pre-warmer ──────────────────────────────────────────────────────
  async function prewarmCandles(sess: IGSession, epics: string[]): Promise<void> {
    addLog('info', '—', `Pre-warming 5-min candles for ${epics.length} epic(s)…`);
    let warmed = 0;
    for (const epic of epics) {
      try {
        const bars = await fetchCandleHistory(sess, epic, 'MINUTE_5', 35);
        // Spaced out, matching the throttle igStrategyScanner.ts already uses
        // for its own IG-hitting calls — back-to-back calls with no spacing
        // is exactly what's tripped IG's account-wide allowance before
        // (confirmed live: a burst of rapid restarts is enough on its own).
        await new Promise(r => setTimeout(r, 1200));
        if (!bars.length) continue;
        const st = epicStates[epic];
        if (!st) continue;
        for (const bar of bars) processTick(st, barToTick(epic, bar), currentConfig);
        // Historical replay can itself satisfy processTick's ENTER conditions
        // on the last bar, flipping st.state to IN_POSITION with no real
        // order behind it (dealId/entryPrice stay 0) — that phantom state
        // would then block real entries on this epic until a live reversal
        // happened to self-correct it back to FLAT. Only reset the phantom
        // case (no dealId); a persisted dealId here means a genuinely open
        // position survived a restart and must stay IN_POSITION.
        if (st.state === 'IN_POSITION' && !st.dealId) {
          st.state = 'FLAT';
          st.consecutiveReds = 0;
          st.consecutiveGreens = 0;
        }
        warmed++;
        addLog('info', epicName(epic), `Pre-warmed ${bars.length} candles — ${st.closedCandles.length} closed, ready: ${st.closedCandles.length >= 26}`);
      } catch (e) {
        addLog('info', epicName(epic), `Pre-warm skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    addLog('info', '—', `Pre-warm done — ${warmed}/${epics.length} epic(s) ready`);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  async function start(params: FxScalperStartParams): Promise<{ ok: boolean; error?: string }> {
    stop();
    const creds = resolveCredentials(mode);
    if (!creds.apiKey || !creds.username || !creds.password) {
      const varPrefix = mode === 'live' ? 'IG_LIVE_' : 'IG_DEMO_';
      return { ok: false, error: `${varPrefix}API_KEY / USERNAME / PASSWORD env vars not set` };
    }

    const requestedEpics = (params.epics?.length ? params.epics : [...FX_EPICS, ...SCALPER_INDEX_EPICS])
      .filter(e => FX_EPICS.has(e) || SCALPER_INDEX_EPICS.has(e));
    if (!requestedEpics.length) return { ok: false, error: 'No valid epics in request — must be one of the 5 FX majors or 4 supported indices' };

    try {
      authFailCount = 0;
      currentEpics  = requestedEpics;
      maxRiskGbp    = params.maxRiskGbp ?? 5;
      currentConfig = { ...DEFAULT_CONFIG, ...(params.config ?? {}) };

      addLog('info', '—', `Starting FX scalper — epics: ${currentEpics.join(', ')} | £${maxRiskGbp} risk/trade`);
      session     = await authenticate(creds.apiKey, creds.username, creds.password, creds.env, `fxscalper:${mode}`);
      dataSession = await authDataSession();
      if (mode === 'live') addLog('info', '—', 'Data feed: demo account (real market data, keeps live\'s own allowance untouched) · Execution: live account');

      // Restore any positions still open from before a restart — falls back
      // to a fresh FLAT state for any epic with no persisted record.
      const persisted = loadEpicStates(mode);
      epicStates = {};
      for (const epic of currentEpics) {
        epicStates[epic] = persisted?.[epic] ?? initEpicState(epic);
      }

      await prewarmCandles(dataSession, currentEpics);

      running = true;
      paused  = false;
      stream.connect(dataSession, currentEpics, handleTick, '5MINUTE');
      scheduleRefresh(session);

      if (maintenanceTimer) clearInterval(maintenanceTimer);
      maintenanceTimer = setInterval(() => { void maintenance(); }, MAINTENANCE_MS);

      saveStartState(mode, { epics: currentEpics, maxRiskGbp });
      addLog('info', '—', `FX scalper started — session expires ${new Date(session.expiresAt).toLocaleTimeString()}`);
      return { ok: true };
    } catch (e) {
      running = false;
      const msg = e instanceof Error ? e.message : String(e);
      addLog('error', '—', `Start failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  function stop(): void {
    running = false;
    paused  = false;
    stream.disconnect();
    if (sessionRefreshTimer) { clearTimeout(sessionRefreshTimer); sessionRefreshTimer = null; }
    if (maintenanceTimer)    { clearInterval(maintenanceTimer);   maintenanceTimer = null; }
    session = null;
    dataSession = null;
    clearStartState(mode);
    if (log.length) addLog('info', '—', 'FX scalper stopped');
  }

  function pause(): void {
    if (!running) return;
    paused = true;
    addLog('info', '—', '⏸ Paused — monitoring open positions, no new entries');
  }

  function resume(): void {
    if (!running) return;
    paused = false;
    addLog('info', '—', '▶ Resumed — will enter on next qualifying signal');
  }

  function status(): FxScalperStatus {
    const statuses: Record<string, FxEpicStatus> = {};
    for (const [epic, st] of Object.entries(epicStates)) {
      const tick = st.formingCandle;
      statuses[epic] = {
        state:      st.state,
        direction:  st.direction,
        entryPrice: st.entryPrice,
        lastPrice:  tick?.bidClose ?? 0,
        dealId:     st.dealId,
        pnlPct: st.entryPrice > 0 && (tick?.bidClose ?? 0) > 0
          ? (st.direction === 'BUY'
              ? (tick!.bidClose - st.entryPrice) / st.entryPrice * 100
              : (st.entryPrice - tick!.bidClose) / st.entryPrice * 100)
          : null,
      };
    }
    return {
      mode,
      running,
      paused,
      streamConnected: stream.isConnected(),
      epics:           currentEpics,
      maxRiskGbp,
      epicStatuses:    statuses,
      log:             log.slice(0, 100),
      sessionOk:       !!session && Date.now() < session.expiresAt,
      sessionExpiry:   session ? new Date(session.expiresAt).toISOString() : null,
    };
  }

  return { start, stop, pause, resume, status };
}

// ── Singleton instances ───────────────────────────────────────────────────────
export const fxScalperDemo = createFxScalperBot('demo');
export const fxScalperLive = createFxScalperBot('live');

export function getFxScalperBot(mode: FxMode): FxScalperHandle {
  return mode === 'live' ? fxScalperLive : fxScalperDemo;
}

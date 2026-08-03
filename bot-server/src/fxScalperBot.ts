import * as fs from 'fs';
import * as path from 'path';
import {
  authenticate, getSession, closePosition, placeMarketOrder,
  fetchMarketDetails, fetchAccountFunds, fetchFullPositions, fetchCandleHistory,
  updatePositionLevels,
  type IGSession, type CandleBar, type MarketDetail,
} from './igApi';
import { type CandleTick } from './scalperStrategy';
import {
  initSwingEpicState, processSwingTick, recordSwingFill, DEFAULT_SWING_CONFIG, isGreen,
  type SwingEpicState, type SwingConfig,
} from './fxSwingStrategy';
import { isMarketOpen, isClosingSoon } from './marketHours';
import { askGemini, type EntrySignal } from './gemini';
import { resolveCredentials, isLossLocked, registerBotOpenedDeal, type IgMode } from './igStrategyBot';
import { FX_EPICS, SCALPER_INDEX_EPICS } from './igStrategyScanner';

// ── Dedicated FX bot — persistent, real execution ───────────────────────────
// Runs fxSwingStrategy.ts (hourly bars, hours-scale holds, position-condition
// driven exits) rather than scalperStrategy.ts's 5-min mean-reversion, which
// spent most of its "losses" to spread + noise rather than being wrong about
// direction. scalperStrategy.ts itself is untouched and still in the repo —
// this module just no longer runs it. Polls every 15 minutes via REST instead
// of a continuous Lightstreamer tick stream — hourly-bar decisions don't need
// tick-level granularity, and it's a much lighter footprint on IG's account.
//
// Deliberately its own factory/closure per mode (mirrors botAccount.ts's
// createAccountBot pattern) rather than folding into igStrategyBot.ts's
// single-config-per-mode ModeState — that state model has no way to run two
// independent strategies concurrently on one mode, and its severe-loss/
// profit-lock thresholds are scaled to *that* bot's own maxRiskGbp, which
// would silently mis-calibrate this bot's real protection if reused as-is.
// This module gets its own equivalent checks scaled to its own risk setting,
// but still registers into igStrategyBot.ts's shared botOpenedDeals set +
// Gemini Position Watch so self-heal-of-naked-stops and position review
// cover these positions too, without duplicating that logic.

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
  config?:     Partial<SwingConfig>;
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
  streamConnected:  boolean;  // poll-loop health, not a literal stream — kept for frontend compatibility
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
// bot would start scoring fresh candles from FLAT as if nothing were open,
// while the actual position sits unmanaged by this module — still covered
// by the shared botOpenedDeals self-heal/Gemini-watch registration, but
// this module's own exit logic wouldn't apply to it anymore).
function saveEpicStates(mode: FxMode, states: Record<string, SwingEpicState>): void {
  try { fs.writeFileSync(epicsFile(mode), JSON.stringify(states), 'utf8'); } catch {}
}
function loadEpicStates(mode: FxMode): Record<string, SwingEpicState> | null {
  try { return JSON.parse(fs.readFileSync(epicsFile(mode), 'utf8')) as Record<string, SwingEpicState>; } catch { return null; }
}

// ── Constants ────────────────────────────────────────────────────────────────

const POLL_MS                    = 15 * 60_000;  // scan cadence — hourly-bar decisions don't need tighter
const WEEKEND_FLATTEN_BUFFER_MIN = 30;   // tighten (not flatten) open positions this many minutes before Friday 22:00 UTC close
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
  const tag = `fx-scalper:${mode}`;

  let session:       IGSession | null = null; // execution — live creds for the live instance, places/closes real orders
  let dataSession:   IGSession | null = null; // data — ALWAYS demo creds, sources candle history + live snapshots
  let running        = false;
  let paused         = false;
  let currentEpics:  string[] = [];
  let maxRiskGbp     = 5;
  let currentConfig: SwingConfig = { ...DEFAULT_SWING_CONFIG };
  let epicStates:    Record<string, SwingEpicState> = {};
  const lastBarTime: Record<string, string> = {};
  const log: FxLogEntry[] = [];

  let sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer:           ReturnType<typeof setInterval> | null = null;
  let lastPollAt = 0;
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
    // Sunday stops being "weekend" the moment FX/indices reopen at 22:00
    // UTC — without the hour check, the target below computes to *today*
    // 22:00, which has already passed once we're past it, so sleepMs
    // collapses to the 60s floor and this re-fires in a tight loop until
    // UTC midnight.
    if (day === 6 || (day === 0 && now.getUTCHours() < 22)) {
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
  // instance is. IG's demo account streams/serves the same real market data
  // as live (only the account/execution side is simulated), and demo's
  // historical-data REST allowance is tracked completely independently from
  // live's — sourcing candles from demo means generating a signal never
  // touches the live account's own allowance, which (confirmed live) gets
  // exhausted far more easily since it also carries the stock bot's poll
  // traffic. For the demo instance itself, data and execution are already
  // the same account, so this just reuses the execution session directly.
  //
  // IG only tolerates one active session per login — the demo login is
  // shared with the IG strategy bot's own demo session ('igstrat:demo'),
  // so this reuses whatever is already cached there instead of opening a
  // second concurrent demo login (same fix as the live side below).
  async function authDataSession(): Promise<IGSession> {
    if (mode === 'demo') return session!;
    const dataCreds = resolveCredentials('demo');
    if (!dataCreds.apiKey) throw new Error('IG_DEMO_API_KEY / USERNAME / PASSWORD not set — required for FX data feed');
    const existing = getSession('igstrat:demo');
    if (existing && Date.now() < existing.expiresAt - 2 * 60_000) return existing;
    return authenticate(dataCreds.apiKey, dataCreds.username, dataCreds.password, dataCreds.env, 'igstrat:demo');
  }

  // Execution session is shared with the IG strategy bot — same login, same
  // account for both live ('igstrat:live') and demo ('igstrat:demo'). IG's
  // account rejects a second concurrent login on the same credentials with
  // error.security.api-key-disabled, so rather than each bot independently
  // opening its own session, whichever bot is already holding a valid one
  // gets reused here instead of triggering a fresh login.
  async function authExecSession(creds: ReturnType<typeof resolveCredentials>): Promise<IGSession> {
    const key = mode === 'live' ? 'igstrat:live' : 'igstrat:demo';
    const existing = getSession(key);
    if (existing && Date.now() < existing.expiresAt - 2 * 60_000) return existing;
    return authenticate(creds.apiKey, creds.username, creds.password, creds.env, key);
  }

  async function doRefresh(): Promise<void> {
    const creds = resolveCredentials(mode);
    if (!creds.apiKey) return;
    try {
      addLog('info', '—', 'Refreshing IG session(s)...');
      session     = await authExecSession(creds);
      dataSession = await authDataSession();
      authFailCount = 0;
      addLog('info', '—', `Session(s) refreshed — execution expires ${new Date(session.expiresAt).toLocaleTimeString()}`);
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
  // poll cycle's severe-loss/profit-lock/weekend-guard closes ─────────────
  async function closeAndReset(epic: string, dealId: string, direction: 'BUY' | 'SELL', size: number): Promise<void> {
    if (!session) return;
    try {
      await closePosition(session, dealId, direction, size);
      const st = epicStates[epic];
      if (st) {
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

  // ── Decision handler ──────────────────────────────────────────────────────
  async function handleDecision(epic: string, tick: CandleTick, decision: ReturnType<typeof processSwingTick>): Promise<void> {
    const st = epicStates[epic];
    if (!st) return;
    const name = epicName(epic);

    switch (decision.action) {
      case 'ENTER': {
        const revertToFlat = () => { st.state = 'FLAT'; };

        if (paused) { addLog('wait', name, 'Paused — skipping entry'); revertToFlat(); return; }

        const mkt = isMarketOpen(epic);
        if (!mkt.open) { addLog('wait', name, `Market closed — ${mkt.reason}`); revertToFlat(); return; }
        if (isClosingSoon(epic)) { addLog('wait', name, 'Closing soon — no new entries'); revertToFlat(); return; }

        if (isLossLocked(mode)) {
          addLog('wait', name, 'Stock bot daily-loss lock active for this account — skipping new entry');
          revertToFlat();
          return;
        }

        if (!session) { addLog('error', name, 'No session — cannot enter'); revertToFlat(); return; }

        const greenCount = st.closedCandles.slice(-5).filter(isGreen).length;
        const entrySignal: EntrySignal = {
          instrumentName: name,
          epic,
          rsi:            decision.indicators.rsi,
          macd:           decision.indicators.macd,
          atr:            decision.indicators.atr,
          greenCount,
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
          const details = await fetchMarketDetails(session, [epic]);
          const detail  = details.get(epic);
          const minDeal = detail?.minDealSize ?? 0.1;
          const minStop = detail?.minStopDist ?? 1;

          // Swing stops/targets come off hourly ATR (via decision.indicators.atr,
          // computed on 1H bars) rather than Gemini's own points suggestion —
          // Gemini's points calibration in gemini.ts assumes 5-min-scalp scale,
          // so it would badly undersize a hours-scale stop. Gemini's job here
          // is confirming direction/confidence, not sizing the trade.
          const atr = decision.indicators.atr ?? minStop * 4;
          const stopDist   = Math.max(atr * currentConfig.atrStopMult, minStop);
          const profitDist = Math.max(atr * currentConfig.atrTpMult, minStop * 2);

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

          const livePositions = await fetchFullPositions(session);
          if (livePositions.some(p => p.epic === epic)) {
            addLog('wait', name, 'Position already open on this epic — skipping');
            revertToFlat();
            return;
          }

          const { dealId, level, protectionOk, protectionError } =
            await placeMarketOrder(session, epic, verdict.direction as 'BUY' | 'SELL', stake, stopDist, profitDist);

          recordSwingFill(st, level, stopDist, profitDist);
          st.dealId = dealId;
          st.size   = stake;

          addLog('enter', name, `↑ ${verdict.direction} @ ${level.toFixed(2)} · stake ${stake} · stop ${stopDist.toFixed(1)}pt TP ${profitDist.toFixed(1)}pt (1H ATR×${currentConfig.atrStopMult}/${currentConfig.atrTpMult}) · Gemini ${verdict.confidence}%`);
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
        break;
      }

      case 'EXIT': {
        const dealId = st.dealId, size = st.size, direction = st.direction;
        if (!dealId) break; // nothing was ever really open (e.g. an invalidation right after a reverted entry)
        addLog('exit', name, `↓ EXIT${decision.urgency === 'immediate' ? ' [immediate]' : ''} — ${decision.reason}`);
        await closeAndReset(epic, dealId, direction, size);
        break;
      }

      case 'TIGHTEN': {
        if (!session || !st.dealId) break;
        try {
          const positions = await fetchFullPositions(session);
          const p = positions.find(pos => pos.dealId === st.dealId);
          await updatePositionLevels(session, st.dealId, decision.newStopPrice, p?.limitLevel ?? null);
          addLog('info', name, decision.reason);
        } catch (e) {
          addLog('error', name, `Stop tighten failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }

      case 'HOLD':     addLog('hold', name, decision.reason); break;
      case 'WAIT':     addLog('wait', name, decision.reason); break;
      case 'COOLDOWN': addLog('cooldown', name, decision.reason); break;
    }
  }

  // ── Per-epic evaluation — fresh hourly bars + a live-price check every cycle ──
  async function evaluateEpic(epic: string, detail: MarketDetail | undefined): Promise<void> {
    const st = epicStates[epic];
    if (!st || !dataSession) return;

    try {
      // Small window, not a full refill — the strategy already carries its
      // own rolling closedCandles history forward across cycles (built once
      // at prewarm), so each poll only needs enough bars to catch a newly
      // closed one since last time. Requesting 80 bars every 15 minutes
      // would burn through IG's historical-data allowance for no benefit —
      // confirmed live that allowance exhausts fast under repeated polling.
      const bars = await fetchCandleHistory(dataSession, epic, 'HOUR', 4);
      if (bars.length) {
        const known   = lastBarTime[epic] ?? '';
        const newBars = bars.filter(b => b.snapshotTime > known);
        for (const bar of newBars) {
          const tick = barToTick(epic, bar);
          const decision = processSwingTick(st, tick, currentConfig);
          await handleDecision(epic, tick, decision);
        }
        lastBarTime[epic] = bars[bars.length - 1].snapshotTime;
      }
    } catch (e) {
      addLog('info', epicName(epic), `Bar fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (detail?.bid !== undefined) {
      const liveTick: CandleTick = {
        epic, time: new Date().toISOString(),
        open: detail.bid, high: detail.bid, low: detail.bid, close: detail.bid,
        bidClose: detail.bid, offerClose: detail.offer ?? detail.bid,
        candleClosed: false,
      };
      const decision = processSwingTick(st, liveTick, currentConfig);
      await handleDecision(epic, liveTick, decision);
    }
  }

  // ── Poll cycle — replaces the old tick stream. Also folds in the
  // severe-loss/profit-lock circuit breaker and the pre-weekend stop-tighten,
  // reusing the same fetchFullPositions() call rather than a second timer
  // hitting IG on its own schedule. Deliberately NOT reusing
  // igStrategyBot.ts's equivalents: those are scaled off that bot's own
  // cfg.maxRiskGbp. Weekend handling doesn't flatten — positions surviving
  // into the weekend is now the normal, intended case for an hours-scale
  // hold, not an exception; it just tightens the stop ahead of the gap risk. ──
  async function pollCycle(): Promise<void> {
    if (!running || !session || !dataSession) return;
    lastPollAt = Date.now();
    try {
      const positions = await fetchFullPositions(session);
      const tracked    = Object.values(epicStates).filter(st => st.dealId);

      const severeLossCeiling = maxRiskGbp * 5;
      const profitLockFloor   = maxRiskGbp * 1.5;

      const now = new Date();
      const isFriday = now.getUTCDay() === 5;
      const minsToClose = (22 * 60) - (now.getUTCHours() * 60 + now.getUTCMinutes());
      const weekendGuardWindow = isFriday && minsToClose > 0 && minsToClose <= WEEKEND_FLATTEN_BUFFER_MIN;

      for (const st of tracked) {
        const p = positions.find(pos => pos.dealId === st.dealId);
        if (!p) {
          // Closed elsewhere already (broker-side stop/TP, or manual) — self-heal back to COOLDOWN.
          addLog('exit', epicName(st.epic), 'Position no longer open on IG — resetting local state');
          st.state = 'COOLDOWN'; st.cooldownUntil = Date.now() + currentConfig.cooldownMs;
          st.dealId = ''; st.size = 0; st.entryPrice = 0; st.dynamicStopPrice = 0; st.takeProfitPrice = 0;
          continue;
        }

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

      const details = await fetchMarketDetails(session, currentEpics);
      for (const epic of currentEpics) {
        await evaluateEpic(epic, details.get(epic));
        await new Promise(r => setTimeout(r, 400)); // light throttle across epics — same discipline as the old pre-warmer
      }

      saveEpicStates(mode, epicStates);
    } catch (e) {
      addLog('error', '—', `Poll cycle failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Candle pre-warmer ──────────────────────────────────────────────────────
  async function prewarmCandles(sess: IGSession, epics: string[]): Promise<void> {
    addLog('info', '—', `Pre-warming hourly candles for ${epics.length} epic(s)…`);
    let warmed = 0;
    for (const epic of epics) {
      try {
        const bars = await fetchCandleHistory(sess, epic, 'HOUR', 80);
        await new Promise(r => setTimeout(r, 1200));
        if (!bars.length) continue;
        const st = epicStates[epic];
        if (!st) continue;
        for (const bar of bars) processSwingTick(st, barToTick(epic, bar), currentConfig);
        lastBarTime[epic] = bars[bars.length - 1].snapshotTime;
        // Historical replay can itself satisfy processSwingTick's ENTER
        // conditions on the last bar, flipping st.state to IN_POSITION with
        // no real order behind it (dealId/entryPrice stay 0) — that phantom
        // state would then block real entries on this epic until a live
        // reversal happened to self-correct it back to FLAT. Only reset the
        // phantom case (no dealId); a persisted dealId here means a
        // genuinely open position survived a restart and must stay IN_POSITION.
        if (st.state === 'IN_POSITION' && !st.dealId) st.state = 'FLAT';
        warmed++;
        addLog('info', epicName(epic), `Pre-warmed ${bars.length} hourly candles — ${st.closedCandles.length} closed`);
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
      currentConfig = { ...DEFAULT_SWING_CONFIG, ...(params.config ?? {}) };

      addLog('info', '—', `Starting FX swing bot — epics: ${currentEpics.join(', ')} | £${maxRiskGbp} risk/trade | scanning every ${POLL_MS / 60_000}min, 1H bars`);
      session     = await authExecSession(creds);
      dataSession = await authDataSession();
      if (mode === 'live') addLog('info', '—', 'Data feed: demo account (real market data, keeps live\'s own allowance untouched) · Execution: live account');

      // Restore any positions still open from before a restart — falls back
      // to a fresh FLAT state for any epic with no persisted record.
      const persisted = loadEpicStates(mode);
      epicStates = {};
      for (const epic of currentEpics) {
        epicStates[epic] = persisted?.[epic] ?? initSwingEpicState(epic);
      }

      await prewarmCandles(dataSession, currentEpics);

      running = true;
      paused  = false;
      scheduleRefresh(session);

      void pollCycle();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => { void pollCycle(); }, POLL_MS);

      saveStartState(mode, { epics: currentEpics, maxRiskGbp });
      addLog('info', '—', `FX swing bot started — session expires ${new Date(session.expiresAt).toLocaleTimeString()}`);
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
    if (sessionRefreshTimer) { clearTimeout(sessionRefreshTimer); sessionRefreshTimer = null; }
    if (pollTimer)           { clearInterval(pollTimer);          pollTimer = null; }
    session = null;
    dataSession = null;
    clearStartState(mode);
    if (log.length) addLog('info', '—', 'FX swing bot stopped');
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
      streamConnected: running && lastPollAt > 0 && (Date.now() - lastPollAt) < POLL_MS * 1.5,
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

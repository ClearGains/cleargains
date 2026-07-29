import * as fs from 'fs';
import * as path from 'path';
import {
  authenticate, getSession, fetchCandleHistory, fetchFullPositions,
  fetchAccountFunds, placeMarketOrder, closePosition as igClosePos,
  fetchMarketDetails, updatePositionLevels,
  type IGSession, type CandleBar, type FullPosition, type MarketDetail,
} from './igApi';
import {
  rsiMeanReversionSignal, emaCrossoverSignal, orbSignal,
  vwapSignal, weeklyMomentumSignal, donchianBreakoutSignal, macdCrossoverSignal,
  STRATEGY_META,
  type StrategySignal,
} from './alpacaStrategies';
import { scanIgEpics, epicName } from './igStrategyScanner';
import { askGeminiDailyVerdict } from './gemini';
import { fetchBarsWithFallback, fetchYahooBars, EPIC_TO_YAHOO, EPIC_TO_ALPACA } from './yahooFetch';
import type { AlpacaBar } from './alpacaApi';
import {
  isNYSEOpen, isInOpeningRange, isNearClose,
  isDailyCheckTime, isWeeklyCheckTime, isWeekend, msUntilMondayOpen,
} from './alpacaApi';

// ── State persistence ─────────────────────────────────────────────────────────
// Mirrors alpacaBot.ts — without this, a PM2 restart while the bot is running
// leaves open IG positions un-monitored until a human notices.

function stateFile(mode: IgMode): string {
  return path.join(__dirname, '..', `ig-strategy-bot-state-${mode}.json`);
}
function saveIgState(mode: IgMode, cfg: IgStrategyConfig): void {
  try { fs.writeFileSync(stateFile(mode), JSON.stringify(cfg), 'utf8'); } catch {}
}
function clearIgState(mode: IgMode): void {
  try { fs.unlinkSync(stateFile(mode)); } catch {}
}
export function loadSavedIgStrategyState(mode: IgMode): IgStrategyConfig | null {
  try { return JSON.parse(fs.readFileSync(stateFile(mode), 'utf8')) as IgStrategyConfig; } catch { return null; }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type IgStrategyName = 'rsi_mean_reversion' | 'ema_crossover' | 'orb' | 'vwap' | 'weekly_momentum' | 'donchian_breakout' | 'macd_crossover';
export type IgMode         = 'demo' | 'live';

export type IgStrategyConfig = {
  mode:             IgMode;
  strategy:         IgStrategyName;
  epics:            string[];   // populated by scanner at start
  // Max £ lost if the stop is hit — NOT a notional-exposure target. Stake is
  // derived as maxRiskGbp ÷ stop-distance-in-points, which is scale-agnostic
  // (works correctly for FX at ~1.3 with a 0.0001 point size, and indices at
  // ~10,000 with a 1.0 point size alike) unlike a price-based notional calc.
  maxRiskGbp:       number;
  maxPositions:     number;
  allowShorts:      boolean;
  maxDailyLossPct?: number;    // circuit breaker: no new entries after balance drops this % from day start (default 3)
};

export type IgLogEntry = {
  id:   string;
  ts:   string;
  type: 'info' | 'enter' | 'exit' | 'wait' | 'error';
  epic: string;
  msg:  string;
};

export type IgOpenPosition = {
  dealId:    string;
  epic:      string;
  name:      string;
  direction: 'BUY' | 'SELL';
  size:      number;    // stake £/pt
  level:     number;    // entry price
  upl:       number;    // unrealised P/L in £
  bid:       number;
  offer:     number;
  openedAt?: string;    // ISO timestamp — see FullPosition.openedAt
};

export type IgStrategyBotStatus = {
  running:    boolean;
  paused:     boolean;
  mode:       IgMode;
  strategy:   IgStrategyName;
  epics:      string[];
  // Which data source each watched epic's real signal/pricing confirm step
  // actually uses right now — 'alpaca' (free, unaffected by IG's allowance),
  // or 'ig' (needs IG's own candle data, currently allowance-limited).
  epicDataSource: Record<string, 'alpaca' | 'ig'>;
  epicNames:  Record<string, string>;
  balance:    number;
  available:  number;
  positions:  IgOpenPosition[];
  log:        IgLogEntry[];
  nextRunMs:  number | null;
  lastPollTs: string | null;
  orbState:   Record<string, OrbState>;
  sessionOk:  boolean;
  lossLock:   boolean;   // daily-loss circuit breaker engaged
};

type OrbState  = { high: number; low: number; established: boolean };

// ── Per-mode state ────────────────────────────────────────────────────────────

type ModeState = {
  running:              boolean;
  paused:               boolean;
  config:               IgStrategyConfig | null;
  session:              IGSession | null;
  log:                  IgLogEntry[];
  pollTimer:            ReturnType<typeof setTimeout> | null;
  nextRunMs:            number | null;
  lastPollTs:           string | null;
  orbState:             Record<string, OrbState>;
  authFailCount:        number;
  sessionRefreshTimer:  ReturnType<typeof setTimeout> | null;
  marketDetails:        Map<string, MarketDetail>;
  // Epics dropped for the rest of this run after IG's own historical-data
  // allowance rejected them — see blockEpicOnAllowance.
  blockedEpics:         Set<string>;
  // Daily-loss circuit breaker
  dayKey:               string;   // UTC date the balance baseline belongs to
  dayStartBalance:      number;
  lossLock:             boolean;  // true = no new entries until the next trading day
  // Weekend risk-window guard
  weekendGuardDate:     string;   // UTC date the guard last fired — one-shot per Friday
};

function makeModeState(): ModeState {
  return {
    running: false, paused: false, config: null, session: null,
    log: [], pollTimer: null, nextRunMs: null, lastPollTs: null,
    orbState: {}, authFailCount: 0, sessionRefreshTimer: null,
    marketDetails: new Map(),
    blockedEpics: new Set(),
    dayKey: '', dayStartBalance: 0, lossLock: false,
    weekendGuardDate: '',
  };
}

const modeStates = new Map<IgMode, ModeState>([
  ['demo', makeModeState()],
  ['live', makeModeState()],
]);

function ms(mode: IgMode): ModeState { return modeStates.get(mode)!; }

// ── IG resolution map ─────────────────────────────────────────────────────────

const IG_RES: Record<IgStrategyName, { resolution: string; count: number }> = {
  rsi_mean_reversion: { resolution: 'MINUTE_5', count: 60 },
  ema_crossover:      { resolution: 'DAY',       count: 30 },
  orb:                { resolution: 'MINUTE',    count: 60 },
  vwap:               { resolution: 'MINUTE',    count: 60 },
  weekly_momentum:    { resolution: 'WEEK',       count: 20 },
  donchian_breakout:  { resolution: 'DAY',       count: 40 },
  macd_crossover:     { resolution: 'DAY',       count: 50 },
};

// Daily-timeframe strategies poll far more often here than STRATEGY_META's
// shared pollMs (an hourly value really meant for the once-a-day gate below) —
// IG-bot-specific, so it doesn't touch the Alpaca bot's own cadence for
// ema_crossover. Safe to run this often because each cycle tries a free
// Yahoo pre-check before ever touching IG's own (allowance-limited) candle
// API — see evaluateEpic.
const IG_POLL_MS_OVERRIDE: Partial<Record<IgStrategyName, number>> = {
  ema_crossover:     15 * 60_000,
  donchian_breakout: 5 * 60_000,
  macd_crossover:    15 * 60_000,
};
function pollIntervalFor(strategy: IgStrategyName): number {
  return IG_POLL_MS_OVERRIDE[strategy] ?? STRATEGY_META[strategy].pollMs;
}

// ── Yahoo directional pre-check ─────────────────────────────────────────────
// Yahoo has no historical-data allowance cost, unlike IG's own candle API.
// Used ONLY for a directional yes/no (BUY/SELL/CLOSE_LONG/CLOSE_SHORT/HOLD) —
// never for actual price levels. Yahoo and IG quote the same instrument on
// completely different numeric scales (confirmed empirically: GBP/USD reads
// ~1.33 on Yahoo vs ~13,289 on IG's own feed), so mixing a Yahoo-derived stop/
// target into a real IG order would be meaningless. When this flags a real
// signal, the caller re-evaluates against IG's own data before doing anything.
async function yahooPreCheckAction(
  strategy:   IgStrategyName,
  yahooSym:   string,
  inPosition: boolean,
  side?:      'long' | 'short',
): Promise<StrategySignal['action'] | null> {
  const bars = await fetchYahooBars(yahooSym, '1d', '6mo');
  if (!bars || bars.length < 40) return null;  // Yahoo unavailable — caller decides fallback

  switch (strategy) {
    case 'ema_crossover':      return emaCrossoverSignal(bars, inPosition, side).action;
    case 'donchian_breakout':  return donchianBreakoutSignal(bars, inPosition, side).action;
    case 'macd_crossover':     return macdCrossoverSignal(bars, inPosition, side).action;
    default:                   return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 8); }
function now() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

// FX/spread-bet markets close Friday 22:00 UTC and gap over the weekend —
// true whenever we're within `leadMinutes` of that close, still on Friday.
function isNearWeekendClose(leadMinutes = 120): boolean {
  const nowDate = new Date();
  if (nowDate.getUTCDay() !== 5) return false;
  const utcMins = nowDate.getUTCHours() * 60 + nowDate.getUTCMinutes();
  const closeMins = 22 * 60;
  return utcMins >= closeMins - leadMinutes && utcMins < closeMins;
}

function addLog(mode: IgMode, type: IgLogEntry['type'], epic: string, msg: string) {
  const st    = ms(mode);
  const entry: IgLogEntry = { id: uid(), ts: now(), type, epic, msg };
  st.log.unshift(entry);
  if (st.log.length > 400) st.log.splice(400);
  console[type === 'error' ? 'error' : 'log'](`[ig-bot:${mode}] [${type.toUpperCase()}] [${epic}] ${msg}`);
}

function igBarToAlpacaBar(b: CandleBar): AlpacaBar {
  return {
    t: b.snapshotTime,
    o: b.openPrice.mid  ?? b.openPrice.bid,
    h: b.highPrice.mid  ?? b.highPrice.bid,
    l: b.lowPrice.mid   ?? b.lowPrice.bid,
    c: b.closePrice.mid ?? b.closePrice.bid,
    v: 0,
  };
}

// Risk-based sizing: stake (£/point) = £risk ÷ stop-distance-in-points.
// Deliberately never divides by price — a price-based notional calc
// (£notional ÷ price) silently produces wildly oversized stakes on FX, where
// price (~1.3) and point size (0.0001) are unrelated scales, unlike indices
// where price and point size roughly coincide.
function calcStake(maxRiskGbp: number, stopDist: number): number {
  if (stopDist <= 0) return 0.1;
  const raw = maxRiskGbp / stopDist;
  return Math.max(0.1, Math.round(raw * 10) / 10);
}

function resolveCredentials(mode: IgMode) {
  if (mode === 'live') {
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

// ── Session management ────────────────────────────────────────────────────────

function scheduleSessionRefresh(mode: IgMode, session: IGSession) {
  const st = ms(mode);
  if (st.sessionRefreshTimer) clearTimeout(st.sessionRefreshTimer);

  const d = new Date().getUTCDay();
  if (d === 0 || d === 6) {
    const sun = new Date();
    sun.setUTCDate(sun.getUTCDate() + ((7 - d) % 7));
    sun.setUTCHours(22, 0, 0, 0);
    const sleepMs = Math.max(sun.getTime() - Date.now(), 60_000);
    addLog(mode, 'wait', '—', `Weekend — deferring session refresh (~${Math.round(sleepMs / 3_600_000)}h)`);
    st.sessionRefreshTimer = setTimeout(() => { void doSessionRefresh(mode); }, sleepMs);
    return;
  }

  const delay = session.expiresAt - Date.now() - 5 * 60_000;
  if (delay <= 0) { void doSessionRefresh(mode); return; }
  st.sessionRefreshTimer = setTimeout(() => { void doSessionRefresh(mode); }, delay);
}

async function doSessionRefresh(mode: IgMode) {
  const st    = ms(mode);
  const creds = resolveCredentials(mode);
  if (!creds.apiKey) return;
  try {
    addLog(mode, 'info', '—', 'Refreshing IG session…');
    st.session = await authenticate(creds.apiKey, creds.username, creds.password, creds.env, `igstrat:${mode}`);
    st.authFailCount = 0;
    addLog(mode, 'info', '—', `Session refreshed — expires ${new Date(st.session.expiresAt).toLocaleTimeString()}`);
    scheduleSessionRefresh(mode, st.session);
  } catch (e) {
    st.authFailCount++;
    addLog(mode, 'error', '—', `Session refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    if (st.authFailCount >= 3) {
      addLog(mode, 'error', '—', 'Auth failed 3× — stopping retries to prevent account lockout');
      return;
    }
    const backoffMs = 5 * 60_000 * Math.pow(2, st.authFailCount - 1);
    addLog(mode, 'info', '—', `Retrying in ${Math.round(backoffMs / 60_000)} min (${st.authFailCount}/3)`);
    st.sessionRefreshTimer = setTimeout(() => { void doSessionRefresh(mode); }, backoffMs);
  }
}

// ── ORB ───────────────────────────────────────────────────────────────────────

function resetOrbState(mode: IgMode, epics: string[]) {
  const st = ms(mode);
  for (const epic of epics) st.orbState[epic] = { high: 0, low: 0, established: false };
}

async function buildOrbRange(mode: IgMode, session: IGSession, epics: string[]) {
  addLog(mode, 'info', '—', 'Building Opening Range (first 30 min)…');
  const st = ms(mode);
  for (const epic of epics) {
    try {
      const raw  = await fetchCandleHistory(session, epic, 'MINUTE', 60);
      const last30 = raw.slice(-30);
      if (!last30.length) continue;
      const high = Math.max(...last30.map(b => b.highPrice.mid ?? b.highPrice.bid));
      const low  = Math.min(...last30.map(b => b.lowPrice.mid  ?? b.lowPrice.bid));
      st.orbState[epic] = { high, low, established: true };
      addLog(mode, 'info', epicName(epic), `ORB: ${low.toFixed(2)}–${high.toFixed(2)}`);
    } catch {}
  }
}

// Non-Alpaca-covered epics (indices, and proxies like SK Hynix/Nokia) always
// need IG's own historical candle data to get a confirmed signal. Once IG
// rejects one with an allowance error, retrying every poll just burns more
// calls for no benefit — block it for the rest of this run and pull in a
// fresh scan pick so the watch-list slot isn't dead weight.
function blockEpicOnAllowance(mode: IgMode, cfg: IgStrategyConfig, session: IGSession, badEpic: string): void {
  const st   = ms(mode);
  const name = epicName(badEpic);
  st.blockedEpics.add(badEpic);
  void (async () => {
    try {
      const current = st.config?.epics ?? [];
      const held    = (await fetchFullPositions(session)).map(p => p.epic);
      const exclude = [...new Set([...current, ...held, ...st.blockedEpics])];
      const picks   = await scanIgEpics(cfg.strategy, session, exclude, 1, msg => addLog(mode, 'info', '—', msg));
      if (picks[0] && st.config) {
        const idx = st.config.epics.indexOf(badEpic);
        if (idx !== -1) st.config.epics[idx] = picks[0];
        addLog(mode, 'info', '—', `Blocked (IG allowance) — ${name} → ${epicName(picks[0])}`);
      } else {
        addLog(mode, 'info', '—', `Blocked (IG allowance) — ${name} dropped, no replacement found this scan`);
      }
    } catch {}
  })();
}

// ── Signal evaluation ─────────────────────────────────────────────────────────

async function evaluateEpic(
  mode:      IgMode,
  epic:      string,
  positions: FullPosition[],
  cfg:       IgStrategyConfig,
  session:   IGSession,
): Promise<void> {
  const openPos    = positions.find(p => p.epic === epic);
  const inPosition = !!openPos;
  const side       = openPos ? (openPos.direction === 'BUY' ? 'long' : 'short') as 'long' | 'short' : undefined;

  // Only epics with a genuine Alpaca mapping (EPIC_TO_ALPACA) use the free
  // fallback chain for real price levels — those are individually verified
  // US-listed shares. Everything else (indices, UK stocks, and non-USD-
  // listing Yahoo proxies like SK Hynix's Korean-won primary listing or
  // Nokia's Helsinki/EUR listing) keeps using IG's own data — those aren't
  // a clean scale factor away (real currency conversion, not just points
  // scaling), confirmed by checking their actual IG-vs-source ratios
  // directly rather than assuming. IG quotes the Alpaca-covered shares in
  // points = cents (×100 vs the raw Alpaca/Yahoo dollar price) — also
  // confirmed live across all 24, not assumed — and fetchBarsWithFallback
  // applies that conversion before returning bars for this set.
  const meta         = STRATEGY_META[cfg.strategy];
  const usesFreeData = epic in EPIC_TO_ALPACA;
  const confirmSource = usesFreeData ? 'Alpaca/Yahoo (×100 scaled)' : "IG's own data";

  // Already rejected by IG's historical-data allowance this run — observed
  // live not clearing for 30+ minutes across repeated polls, so retrying on
  // every cycle just wastes calls. Skip silently; the slot gets a fresh scan
  // pick from blockEpicOnAllowance below instead of hammering IG again.
  if (!usesFreeData && ms(mode).blockedEpics.has(epic)) return;

  // ── Yahoo pre-check gate (daily-timeframe strategies, outside the guaranteed
  // once-daily window) — skip IG's allowance-limited candle fetch entirely
  // unless Yahoo's free data already suggests something worth confirming.
  if (meta.timeframe === 'daily' && !isDailyCheckTime()) {
    const yahooSym = EPIC_TO_YAHOO[epic];
    if (!yahooSym) return;  // can't pre-check — wait for the guaranteed daily window
    const preAction = await yahooPreCheckAction(cfg.strategy, yahooSym, inPosition, side);
    if (preAction === null || preAction === 'HOLD') return;  // no signal, or Yahoo unavailable — skip this cycle
    addLog(mode, 'info', epicName(epic), `Yahoo pre-check flagged ${preAction} — confirming against ${confirmSource}`);
  }

  const { resolution, count } = IG_RES[cfg.strategy];
  let bars: AlpacaBar[];
  if (meta.timeframe === 'daily' && usesFreeData) {
    const fallbackBars = await fetchBarsWithFallback(epic, '6mo');
    if (!fallbackBars?.length) { addLog(mode, 'wait', epicName(epic), 'No bar data (Alpaca/Yahoo unavailable)'); return; }
    bars = fallbackBars.slice(-count);
  } else {
    try {
      bars = (await fetchCandleHistory(session, epic, resolution, count)).map(igBarToAlpacaBar);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(mode, 'error', epicName(epic), `Bar fetch failed (${confirmSource}): ${msg}`);
      if (msg.toLowerCase().includes('allowance')) blockEpicOnAllowance(mode, cfg, session, epic);
      return;
    }
  }
  if (!bars.length) { addLog(mode, 'wait', epicName(epic), 'No bar data'); return; }

  const st = ms(mode);
  let signal: StrategySignal;

  switch (cfg.strategy) {
    case 'rsi_mean_reversion':
      signal = rsiMeanReversionSignal(bars, inPosition, side);
      break;

    case 'ema_crossover':
      signal = emaCrossoverSignal(bars, inPosition, side);
      break;

    case 'orb': {
      const orb = st.orbState[epic] ?? { high: 0, low: 0, established: false };
      if (!orb.established) { addLog(mode, 'wait', epicName(epic), 'ORB not established'); return; }
      signal = orbSignal(orb.high, orb.low, bars[bars.length - 1].c, inPosition, side);
      break;
    }

    case 'vwap':
      signal = vwapSignal(bars, bars[bars.length - 1].c, inPosition, side);
      break;

    case 'weekly_momentum': {
      let dailyBars: AlpacaBar[] = [];
      try { dailyBars = (await fetchCandleHistory(session, epic, 'DAY', 30)).map(igBarToAlpacaBar); } catch {}
      signal = weeklyMomentumSignal(bars, dailyBars, inPosition, side);
      break;
    }

    case 'donchian_breakout':
      signal = donchianBreakoutSignal(bars, inPosition, side);
      break;

    case 'macd_crossover':
      signal = macdCrossoverSignal(bars, inPosition, side);
      break;

    default: return;
  }

  let executionPrice  = bars[bars.length - 1].c;
  let executionSignal = signal;

  // For free-data-confirmed shares, anchor the final absolute stop/TP levels
  // to IG's own live quote rather than the free-data close — this removes
  // any dependence on the manual points-scale conversion being exactly right
  // at the moment of execution; only the *distance* (how far the stop/TP sit
  // from price) needs to have been correctly scaled, which was verified
  // against the live account already. Reuses st.marketDetails (poll()
  // already refreshes it for the whole watch list every cycle, line ~707)
  // instead of issuing a second live fetchMarketDetails call here — an
  // earlier version fetched fresh per-signal, which duplicated a call IG
  // had just made moments earlier in the same poll and tripped the
  // account-wide non-trading allowance (error.public-api.exceeded-*-allowance),
  // locking the whole account out, not just this epic.
  if (usesFreeData && (signal.action === 'BUY' || signal.action === 'SELL')) {
    const live = st.marketDetails.get(epic);
    if (live?.bid && live?.offer) {
      const livePrice     = (live.bid + live.offer) / 2;
      const freeDataPrice = executionPrice;
      const stopDist      = signal.stopPrice       !== undefined ? Math.abs(freeDataPrice - signal.stopPrice)       : undefined;
      const profitDist    = signal.takeProfitPrice  !== undefined ? Math.abs(freeDataPrice - signal.takeProfitPrice) : undefined;
      executionSignal = {
        ...signal,
        stopPrice:       stopDist   !== undefined ? (signal.action === 'BUY' ? livePrice - stopDist   : livePrice + stopDist)   : signal.stopPrice,
        takeProfitPrice: profitDist !== undefined ? (signal.action === 'BUY' ? livePrice + profitDist : livePrice - profitDist) : signal.takeProfitPrice,
      };
      executionPrice = livePrice;
    }
  }

  await executeIgSignal(mode, epic, executionSignal, openPos ?? null, cfg, session, executionPrice);
}

// ── Order execution ───────────────────────────────────────────────────────────

// Mirrors the Demo Trader tab's classification: indices/FX are driven by liquid
// price-action data with no edge from an LLM opinion (and it adds ~8s latency
// per call) — only shares get the Gemini second-opinion check.
function classifyMarketType(epic: string): 'INDEX' | 'FOREX' | 'SHARES' {
  if (epic.startsWith('CS.')) return 'FOREX';
  if (epic.startsWith('IX.')) return 'INDEX';
  return 'SHARES';
}

async function executeIgSignal(
  mode:         IgMode,
  epic:         string,
  signal:       StrategySignal,
  openPos:      FullPosition | null,
  cfg:          IgStrategyConfig,
  session:      IGSession,
  currentPrice: number,
): Promise<void> {
  const { action, reason, stopPrice, takeProfitPrice, trailPercent } = signal;
  const st   = ms(mode);
  const name = epicName(epic);

  if (action === 'HOLD') { addLog(mode, 'wait', name, reason); return; }

  if (action === 'CLOSE_LONG' || action === 'CLOSE_SHORT') {
    if (!openPos) return;
    addLog(mode, 'exit', name, `Closing — ${reason}`);
    try {
      await igClosePos(session, openPos.dealId, openPos.direction, openPos.size);
      addLog(mode, 'exit', name, `Closed deal ${openPos.dealId}`);

      // Find replacement epic
      void (async () => {
        try {
          const current = st.config?.epics ?? [];
          const held    = (await fetchFullPositions(session)).map(p => p.epic);
          const exclude = [...new Set([...current, ...held])].filter(e => e !== epic);
          const picks   = await scanIgEpics(cfg.strategy, session, exclude, 1, msg => addLog(mode, 'info', '—', msg));
          if (picks[0] && st.config) {
            const idx = st.config.epics.indexOf(epic);
            if (idx !== -1) st.config.epics[idx] = picks[0];
            else st.config.epics.push(picks[0]);
            addLog(mode, 'info', '—', `Slot replacement: ${name} → ${epicName(picks[0])}`);
          }
        } catch {}
      })();
    } catch (e) {
      addLog(mode, 'error', name, `Close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (st.paused)                       { addLog(mode, 'wait', name, `⏸ Paused — skipping ${action}`); return; }
  if (st.lossLock)                     { addLog(mode, 'wait', name, `🛑 Daily-loss limit hit — skipping ${action} (entries resume next day)`); return; }
  if (action === 'SELL' && !cfg.allowShorts) { addLog(mode, 'wait', name, 'Shorts disabled'); return; }
  if (openPos)                          { addLog(mode, 'wait', name, `Already in position — skipping ${action}`); return; }
  if (isNearClose())                    { addLog(mode, 'wait', name, '⏸ Market closing <15 min — no new entries'); return; }

  const direction  = action === 'BUY' ? 'BUY' : 'SELL';

  // IG rejects (or silently adjusts) stakes/stops below the instrument's own
  // minimums — without clamping to these, entries can fail outright or leave
  // a smaller-than-intended stop. Falls back to conservative defaults when
  // fetchMarketDetails couldn't reach IG for this epic.
  const detail  = st.marketDetails.get(epic);
  const minDeal = detail?.minDealSize ?? 0.5;
  const minStop = detail?.minStopDist ?? 1;

  const stopDist   = stopPrice        ? Math.abs(currentPrice - stopPrice)        : undefined;
  const profitDistRaw = takeProfitPrice ? Math.abs(currentPrice - takeProfitPrice) : undefined;

  // Trailing stop: use trail_percent converted to points
  const effectiveStopDistRaw = trailPercent ? currentPrice * (trailPercent / 100) : stopDist;
  const effectiveStopDist = effectiveStopDistRaw !== undefined ? Math.max(minStop, effectiveStopDistRaw) : undefined;
  const profitDist        = profitDistRaw !== undefined ? Math.max(minStop, profitDistRaw) : undefined;

  // Sizing needs a stop distance to divide by — strategies should always
  // provide one, but fall back to a conservative 1.5% price-based distance
  // rather than crash if one somehow didn't.
  const sizingStopDist = effectiveStopDist ?? Math.max(minStop, currentPrice * 0.015);
  const rawStake = calcStake(cfg.maxRiskGbp, sizingStopDist);
  const stake    = Math.max(minDeal, rawStake);

  // Any time the stake actually used ends up above what the target risk
  // would size — whether because IG's minDealSize forced it up, or because
  // calcStake's own internal floor (min 0.1/pt) did — the realized max loss
  // can silently exceed cfg.maxRiskGbp with no bound at all. Confirmed live:
  // a genuinely volatile instrument's wide ATR-based stop combined with
  // calcStake's 0.1 floor produced a real £310 max loss against a £20
  // target, and the previous version of this check only looked at whether
  // minDeal specifically was the cause — missed this because calcStake's
  // own floor was what did it here, not IG's minimum. Checking the actual
  // realized loss directly, unconditionally, closes that gap regardless of
  // which mechanism pushed the stake up.
  const actualMaxLoss = stake * sizingStopDist;
  const lossCeiling    = cfg.maxRiskGbp * 3;
  if (actualMaxLoss > lossCeiling) {
    addLog(mode, 'wait', name,
      `Skipped — sizing works out to £${actualMaxLoss.toFixed(0)} max loss (stake £${stake}/pt × ${sizingStopDist.toFixed(0)}pt stop), above the £${lossCeiling.toFixed(0)} ceiling (3× target)`);
    return;
  }
  if (rawStake < minDeal) {
    addLog(mode, 'info', name,
      `Stake £${rawStake}/pt below IG minimum £${minDeal}/pt — using minimum (max loss £${actualMaxLoss.toFixed(0)}, within the £${lossCeiling.toFixed(0)} ceiling)`);
  }

  // Final live guard — ask IG directly before committing funds. `openPos` was
  // resolved once at the top of poll() and can be stale by the time execution
  // reaches here; re-check fresh immediately before placing the order. Same
  // pattern the Demo Trader tab already uses, as defense-in-depth on top of
  // the fetchFullPositions endpoint fix — if we can't verify the account is
  // actually flat on this epic, don't risk a duplicate entry.
  try {
    const freshPositions = await fetchFullPositions(session);
    if (freshPositions.some(p => p.epic === epic)) {
      addLog(mode, 'wait', name, '🛡 Live guard — position already exists on this epic, aborting entry');
      return;
    }
  } catch (e) {
    addLog(mode, 'error', name, `🛡 Live guard check failed — aborting entry to be safe: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // Gemini second opinion — SHARES only, same scope as the Demo Trader tab.
  // Indices/FX are liquid price-action markets where an LLM opinion adds ~8s
  // of latency per call with no edge (no live feed of its own); shares are
  // where a sanity check on the setup earns its cost.
  let effectiveDirection: 'BUY' | 'SELL' = direction;
  if (classifyMarketType(epic) === 'SHARES') {
    try {
      const verdict = await askGeminiDailyVerdict({
        instrumentName: name,
        direction,
        strength:       70,  // no granular numeric score at this layer — fixed moderate default
        price:          currentPrice,
        changePercent:  0,   // not available at this layer; doesn't affect the direction check
        stopPoints:     sizingStopDist,
        tpPoints:       profitDist ?? sizingStopDist * 2.5,
      });
      addLog(mode, 'info', name, `[GEMINI] ${verdict.direction} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);
      if (verdict.direction === 'SKIP' || verdict.confidence < 50) {
        addLog(mode, 'wait', name, `[GEMINI] Skipped entry — ${verdict.direction} ${verdict.confidence}%`);
        return;
      }
      if (verdict.direction === 'BUY' || verdict.direction === 'SELL') effectiveDirection = verdict.direction;
    } catch { /* Gemini unavailable — proceed with original signal */ }
  }

  addLog(mode, 'enter', name, `${effectiveDirection} — ${reason}`);
  addLog(mode, 'info',  name, `Stake: £${stake}/pt | Price: ~${currentPrice.toFixed(2)} | max loss at stop: ~£${(stake * sizingStopDist).toFixed(0)}`);

  try {
    const { dealId, level, protectionOk, protectionError } =
      await placeMarketOrder(session, epic, effectiveDirection, stake, effectiveStopDist, profitDist);
    addLog(mode, 'enter', name, `Deal confirmed — id ${dealId} @ ${level.toFixed(2)}`);

    // Only claim Stop/TP protection once it's actually confirmed attached —
    // otherwise a silently-failed PUT leaves the position naked with no
    // record of it, and it only ever exits via the strategy's own (often
    // lagging) thesis-reversal check instead of taking profit.
    if (effectiveStopDist || profitDist) {
      if (protectionOk) {
        if (effectiveStopDist) addLog(mode, 'info', name, `Stop attached: ${effectiveStopDist.toFixed(2)} pts`);
        if (profitDist)        addLog(mode, 'info', name, `TP attached:   ${profitDist.toFixed(2)} pts`);
      } else {
        addLog(mode, 'error', name,
          `🚨 UNPROTECTED — Stop/TP failed to attach after retry: ${protectionError ?? 'unknown error'}. Position has no broker-side protection; will retry on next poll.`);
      }
    }
  } catch (e) {
    addLog(mode, 'error', name, `Order failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function poll(mode: IgMode) {
  const st = ms(mode);
  if (!st.running || !st.config || !st.session) return;

  const cfg   = st.config;
  const meta  = STRATEGY_META[cfg.strategy];
  const today = new Date().toISOString().slice(0, 10);
  st.lastPollTs = new Date().toISOString();

  if (isWeekend()) {
    const sleepMs = msUntilMondayOpen();
    addLog(mode, 'wait', '—', `Weekend — sleeping until Monday (~${Math.round(sleepMs / 3_600_000)}h)`);
    st.nextRunMs = Date.now() + sleepMs;
    st.pollTimer = setTimeout(() => { void poll(mode); }, sleepMs);
    return;
  }

  // ── Weekend risk-window guard ─────────────────────────────────────────────
  // Runs before the per-strategy timeframe gate below — weekly_momentum and
  // ema_crossover only pass that gate a few minutes a day/week, so placed
  // after it this would almost never fire for exactly the strategies most
  // exposed to a weekend gap (the ones designed to hold positions through
  // it). Intraday strategies were never meant to hold through the gap at
  // all, so those get flattened; swing/weekly strategies get their stop
  // pulled in to cap the worst case instead of losing the whole position.
  if (isNearWeekendClose(120) && st.weekendGuardDate !== today) {
    st.weekendGuardDate = today;
    try {
      const positions = await fetchFullPositions(st.session);
      for (const p of positions) {
        const name = epicName(p.epic);
        if (meta.timeframe === 'intraday') {
          addLog(mode, 'exit', name, `Weekend risk guard — closing before the gap (${cfg.strategy} isn't meant to hold through it)`);
          try { await igClosePos(st.session, p.dealId, p.direction, p.size); }
          catch (e) { addLog(mode, 'error', name, `Weekend flatten failed: ${e instanceof Error ? e.message : String(e)}`); }
        } else if (p.stopLevel !== undefined) {
          const currentDist   = Math.abs(p.level - p.stopLevel);
          const tightenedDist = currentDist * 0.5;
          const newStop       = p.direction === 'BUY' ? p.level - tightenedDist : p.level + tightenedDist;
          const wouldTighten  = p.direction === 'BUY' ? newStop > p.stopLevel : newStop < p.stopLevel;
          if (wouldTighten) {
            try {
              await updatePositionLevels(st.session, p.dealId, newStop, p.limitLevel ?? null);
              addLog(mode, 'info', name, `Weekend risk guard — tightened stop ${currentDist.toFixed(2)}→${tightenedDist.toFixed(2)} pts ahead of the gap`);
            } catch (e) {
              addLog(mode, 'error', name, `Weekend stop-tighten failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      }
      if (positions.length) addLog(mode, 'info', '—', `Weekend risk guard checked ${positions.length} position(s)`);
    } catch (e) {
      addLog(mode, 'error', '—', `Weekend risk guard failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (meta.timeframe === 'intraday' && !isNYSEOpen()) { schedule(mode, cfg); return; }
  // 'daily' strategies no longer gate the whole poll on isDailyCheckTime() —
  // they now run every pollIntervalFor() cycle (see IG_POLL_MS_OVERRIDE) and
  // gate per-epic inside evaluateEpic via the free Yahoo pre-check instead,
  // so a real signal doesn't have to wait for the once-a-day window.
  if (meta.timeframe === 'weekly'   && !isWeeklyCheckTime()) { schedule(mode, cfg); return; }

  if (cfg.strategy === 'orb' && isInOpeningRange()) {
    await buildOrbRange(mode, st.session, cfg.epics);
    schedule(mode, cfg);
    return;
  }

  // Cheap — one batched request for cfg.epics (≤ ~10). Refreshed every poll so
  // slot replacements (new epic swapped in) always get correct min size/stop.
  st.marketDetails = await fetchMarketDetails(st.session, cfg.epics).catch(() => st.marketDetails);

  let positions: FullPosition[] = [];
  let balance = 0, available = 0;
  try {
    [positions, { balance, available }] = await Promise.all([
      fetchFullPositions(st.session),
      fetchAccountFunds(st.session),
    ]);
    if (Math.random() < 0.1) {
      addLog(mode, 'info', '—', `Balance: £${balance.toFixed(2)} | Available: £${available.toFixed(2)} | Positions: ${positions.length}`);
    }
  } catch (e) {
    addLog(mode, 'error', '—', `Account fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    schedule(mode, cfg);
    return;
  }

  // ── Daily-loss circuit breaker ────────────────────────────────────────────
  // Mirrors alpacaBot.ts — without this, correlated positions moving against
  // each other at once (or a fast/gapping move slipping past a non-guaranteed
  // stop) can keep bleeding the account with nothing to stop new entries.
  if (st.dayKey !== today) {
    st.dayKey = today;
    st.dayStartBalance = balance;
    if (st.lossLock) addLog(mode, 'info', '—', 'New trading day — daily-loss lock reset');
    st.lossLock = false;
  }
  const maxLossPct = cfg.maxDailyLossPct ?? 3;
  if (!st.lossLock && st.dayStartBalance > 0 && balance > 0) {
    const ddPct = (st.dayStartBalance - balance) / st.dayStartBalance * 100;
    if (ddPct >= maxLossPct) {
      st.lossLock = true;
      addLog(mode, 'error', '—',
        `🛑 Daily loss ${ddPct.toFixed(2)}% ≥ ${maxLossPct}% limit — no new entries today (exits/self-heal still managed)`);
    }
  }

  // Self-heal naked positions — a failed SL/TP attach (at entry, or on a prior
  // poll) otherwise leaves a position with no broker-side exit until the
  // strategy's own thesis-reversal check fires, which is how trades were
  // riding losses instead of taking profit. Checked against IG's own reported
  // stopLevel/limitLevel, so this also repairs positions left naked before
  // this fix existed.
  for (const p of positions) {
    if (p.stopLevel !== undefined && p.limitLevel !== undefined) continue;
    const detail    = st.marketDetails.get(p.epic);
    const minStop   = detail?.minStopDist ?? 1;
    const fallbackStopDist   = Math.max(minStop, p.level * 0.015);
    const fallbackProfitDist = Math.max(minStop, p.level * 0.03);
    const fallbackStop  = p.direction === 'BUY' ? p.level - fallbackStopDist   : p.level + fallbackStopDist;
    const fallbackLimit = p.direction === 'BUY' ? p.level + fallbackProfitDist : p.level - fallbackProfitDist;
    const stopLevel  = p.stopLevel  ?? fallbackStop;
    const limitLevel = p.limitLevel ?? fallbackLimit;
    try {
      await updatePositionLevels(st.session, p.dealId, stopLevel, limitLevel);
      addLog(mode, 'info', epicName(p.epic),
        `Self-heal: attached missing ${p.stopLevel === undefined ? 'stop' : ''}${p.stopLevel === undefined && p.limitLevel === undefined ? '/' : ''}${p.limitLevel === undefined ? 'TP' : ''} — was naked`);
    } catch (e) {
      addLog(mode, 'error', epicName(p.epic),
        `🚨 UNPROTECTED — self-heal failed: ${e instanceof Error ? e.message : String(e)}. Monitor manually.`);
    }
  }

  // Trailing stop (donchian_breakout only) — ratchets the stop toward price
  // at the same 3%-of-price distance used at entry, but only ever tightens,
  // never loosens. Locks in gains as a trend continues instead of capping
  // the upside with a fixed take-profit, which would cut short exactly the
  // sustained directional moves this strategy exists to catch. A sharp move
  // *against* an open position is unaffected by this — that's still bounded
  // by whatever stop is already live on IG's side, checked every poll cycle
  // (short here, see pollIntervalFor) independent of this trail logic.
  if (cfg.strategy === 'donchian_breakout') {
    for (const p of positions) {
      if (p.stopLevel === undefined) continue;  // naked — self-heal above handles it
      const currentPrice = p.direction === 'BUY' ? p.bid : p.offer;
      const trailDist     = currentPrice * 0.03;
      const candidateStop = p.direction === 'BUY' ? currentPrice - trailDist : currentPrice + trailDist;
      const wouldTighten  = p.direction === 'BUY' ? candidateStop > p.stopLevel : candidateStop < p.stopLevel;
      if (!wouldTighten) continue;
      try {
        await updatePositionLevels(st.session, p.dealId, candidateStop, p.limitLevel ?? null);
        addLog(mode, 'info', epicName(p.epic), `Trailing stop tightened: ${p.stopLevel.toFixed(2)} → ${candidateStop.toFixed(2)}`);
      } catch (e) {
        addLog(mode, 'error', epicName(p.epic), `Trailing stop update failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const openCount = positions.length;

  for (const epic of cfg.epics) {
    if (!st.running) break;
    const inPos = positions.find(p => p.epic === epic);
    if (!inPos && openCount >= cfg.maxPositions) {
      addLog(mode, 'wait', epicName(epic), `Max positions (${cfg.maxPositions}) reached`);
      continue;
    }
    await evaluateEpic(mode, epic, positions, cfg, st.session);
  }

  schedule(mode, cfg);
}

function schedule(mode: IgMode, cfg: IgStrategyConfig) {
  const st = ms(mode);
  if (!st.running) return;
  const delay  = pollIntervalFor(cfg.strategy);
  st.nextRunMs = Date.now() + delay;
  st.pollTimer = setTimeout(() => { void poll(mode); }, delay);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function startIgStrategyBot(cfg: IgStrategyConfig): Promise<{ ok: boolean; error?: string }> {
  const mode = cfg.mode;
  stopIgStrategyBot(mode);

  const creds = resolveCredentials(mode);
  if (!creds.apiKey || !creds.username || !creds.password) {
    return { ok: false, error: `IG ${mode} credentials not configured — set IG_${mode.toUpperCase()}_API_KEY / USERNAME / PASSWORD` };
  }

  const st = ms(mode);
  try {
    const sessionKey = `igstrat:${mode}`;
    const existing   = getSession(sessionKey);
    if (existing && Date.now() < existing.expiresAt - 2 * 60_000) {
      st.session = existing;
      addLog(mode, 'info', '—', `Reusing existing session — expires ${new Date(st.session.expiresAt).toLocaleTimeString()}`);
    } else {
      addLog(mode, 'info', '—', 'Authenticating with IG…');
      st.session = await authenticate(creds.apiKey, creds.username, creds.password, creds.env, sessionKey);
    }
  } catch (e) {
    return { ok: false, error: `IG auth failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const { balance } = await fetchAccountFunds(st.session).catch(() => ({ balance: 0, available: 0 }));
  addLog(mode, 'info', '—', `Connected — account ${st.session.accountId} | balance £${balance.toFixed(2)}`);

  st.config        = cfg;
  st.running       = true;
  st.paused        = false;
  st.authFailCount = 0;

  // Persist immediately — a crash mid-scan should still resume the bot
  saveIgState(mode, cfg);

  addLog(mode, 'info', '—', 'Scanning for best instruments…');
  try {
    const best = await scanIgEpics(cfg.strategy, st.session, [], cfg.maxPositions + 2, msg => addLog(mode, 'info', '—', msg));
    cfg.epics = best;
  } catch (e) {
    addLog(mode, 'info', '—', `Scan failed — using default indices: ${e instanceof Error ? e.message : String(e)}`);
    cfg.epics = ['IX.D.DOW.DAILY.IP', 'IX.D.NASDAQ.DAILY.IP', 'IX.D.FTSE.DAILY.IP'];
  }

  if (cfg.strategy === 'orb') resetOrbState(mode, cfg.epics);
  scheduleSessionRefresh(mode, st.session);

  addLog(mode, 'info', '—', `Bot started — ${STRATEGY_META[cfg.strategy].label} | ${mode} | ${cfg.epics.map(epicName).join(', ')}`);
  addLog(mode, 'info', '—', `Max risk/trade: £${cfg.maxRiskGbp} | Max positions: ${cfg.maxPositions} | Shorts: ${cfg.allowShorts ? 'yes' : 'no'}`);

  // Startup just fired a burst of IG calls (auth + balance + up to
  // maxPositions+2 sequential candle fetches while scanning for instruments).
  // Hitting the API again immediately with poll()'s own balance/positions/
  // market-details calls was intermittently getting a 403 — give it a few
  // seconds to clear before the first real poll.
  st.pollTimer = setTimeout(() => { void poll(mode); }, 10_000);
  return { ok: true };
}

export function stopIgStrategyBot(mode: IgMode): void {
  const st = ms(mode);
  st.running = false;
  st.paused  = false;
  if (st.pollTimer)           { clearTimeout(st.pollTimer);           st.pollTimer           = null; }
  if (st.sessionRefreshTimer) { clearTimeout(st.sessionRefreshTimer); st.sessionRefreshTimer = null; }
  st.nextRunMs  = null;
  st.lastPollTs = null;
  clearIgState(mode);
  addLog(mode, 'info', '—', `IG strategy bot ${mode} stopped`);
}

export function pauseIgStrategyBot(mode: IgMode): void {
  const st = ms(mode);
  if (!st.running) return;
  st.paused = true;
  addLog(mode, 'info', '—', '⏸ Paused — monitoring positions, no new entries');
}

export function resumeIgStrategyBot(mode: IgMode): void {
  const st = ms(mode);
  if (!st.running) return;
  st.paused = false;
  addLog(mode, 'info', '—', '▶ Resumed');
}

export async function getIgStrategyBotStatus(mode: IgMode): Promise<IgStrategyBotStatus> {
  const st = ms(mode);
  let positions: IgOpenPosition[] = [];
  let balance = 0, available = 0;

  if (st.running && st.session) {
    try {
      const [full, funds] = await Promise.all([fetchFullPositions(st.session), fetchAccountFunds(st.session)]);
      balance   = funds.balance;
      available = funds.available;
      positions = full.map(p => ({
        dealId:    p.dealId,
        epic:      p.epic,
        name:      p.instrumentName,
        direction: p.direction,
        size:      p.size,
        level:     p.level,
        upl:       p.upl,
        bid:       p.bid,
        offer:     p.offer,
        openedAt:  p.openedAt,
      }));
    } catch {}
  }

  return {
    running:    st.running,
    paused:     st.paused,
    mode,
    strategy:   st.config?.strategy  ?? 'rsi_mean_reversion',
    epics:      st.config?.epics     ?? [],
    epicDataSource: Object.fromEntries(
      (st.config?.epics ?? []).map(e => [e, (e in EPIC_TO_ALPACA ? 'alpaca' : 'ig') as 'alpaca' | 'ig']),
    ),
    epicNames: Object.fromEntries((st.config?.epics ?? []).map(e => [e, epicName(e)])),
    balance,
    available,
    positions,
    log:        st.log.slice(0, 100),
    nextRunMs:  st.nextRunMs,
    lastPollTs: st.lastPollTs,
    orbState:   { ...st.orbState },
    sessionOk:  !!st.session && Date.now() < st.session.expiresAt,
    lossLock:   st.lossLock,
  };
}

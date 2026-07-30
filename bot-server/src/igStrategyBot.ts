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
import { scanIgEpics, epicName, IG_EPICS, scoreForStrategy } from './igStrategyScanner';
import { askGeminiDailyVerdict } from './gemini';
import { fetchBarsWithFallback, fetchYahooBars, EPIC_TO_YAHOO, EPIC_TO_ALPACA } from './yahooFetch';
import { fetchCompanyHeadlines } from './newsFetch';
import type { AlpacaBar, Timeframe } from './alpacaApi';
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

// Allowance-blocked epics survive a restart too — see blockedEpics on ModeState.
const BLOCK_COOLDOWN_MS = 6 * 60 * 60_000;  // re-try after 6h, not "forever" or "every restart"

function blockedEpicsFile(mode: IgMode): string {
  return path.join(__dirname, '..', `ig-blocked-epics-${mode}.json`);
}
function saveBlockedEpics(mode: IgMode, map: Map<string, number>): void {
  try { fs.writeFileSync(blockedEpicsFile(mode), JSON.stringify([...map]), 'utf8'); } catch {}
}
function loadBlockedEpics(mode: IgMode): Map<string, number> {
  try {
    const pairs = JSON.parse(fs.readFileSync(blockedEpicsFile(mode), 'utf8')) as [string, number][];
    const now = Date.now();
    return new Map(pairs.filter(([, unblockAt]) => unblockAt > now));  // drop any already-expired on load
  } catch {
    return new Map();
  }
}

// User-paused epics — manual only, no auto-expiry, survives restarts.
function pausedEpicsFile(mode: IgMode): string {
  return path.join(__dirname, '..', `ig-paused-epics-${mode}.json`);
}
function savePausedEpics(mode: IgMode, set: Set<string>): void {
  try { fs.writeFileSync(pausedEpicsFile(mode), JSON.stringify([...set]), 'utf8'); } catch {}
}
function loadPausedEpics(mode: IgMode): Set<string> {
  try { return new Set(JSON.parse(fs.readFileSync(pausedEpicsFile(mode), 'utf8')) as string[]); }
  catch { return new Set(); }
}

// Last entry trigger per epic (fresh-breakout re-entry filter) — was
// in-memory only, wiped on every restart. Confirmed live this actually
// matters: a PM2 restart 33 seconds before a poll cycle let Qualcomm
// re-enter on the exact same "20-day low 16227.00" the filter was built to
// block, purely because the restart erased the record of the prior entry.
function lastEntryTriggerFile(mode: IgMode): string {
  return path.join(__dirname, '..', `ig-last-entry-trigger-${mode}.json`);
}
function saveLastEntryTrigger(mode: IgMode, map: Map<string, { level: number; direction: 'BUY' | 'SELL' }>): void {
  try { fs.writeFileSync(lastEntryTriggerFile(mode), JSON.stringify([...map]), 'utf8'); } catch {}
}
function loadLastEntryTrigger(mode: IgMode): Map<string, { level: number; direction: 'BUY' | 'SELL' }> {
  try {
    const pairs = JSON.parse(fs.readFileSync(lastEntryTriggerFile(mode), 'utf8')) as [string, { level: number; direction: 'BUY' | 'SELL' }][];
    return new Map(pairs);
  } catch {
    return new Map();
  }
}

// Deal IDs the bot itself opened — used to tell those apart from positions
// that exist on a watched epic for some other reason (opened manually via
// the IG app, or anywhere else outside this bot). Confirmed live this
// matters: a manually-opened Micron position got closed automatically
// within a second of the bot discovering it, because the strategy's own
// exit rule was already satisfied — no chance to let it play out. The bot
// now only auto-manages exits on deals it opened itself, or ones explicitly
// released (see releasedDeals below).
function botOpenedDealsFile(mode: IgMode): string {
  return path.join(__dirname, '..', `ig-bot-opened-deals-${mode}.json`);
}
function saveBotOpenedDeals(mode: IgMode, set: Set<string>): void {
  try { fs.writeFileSync(botOpenedDealsFile(mode), JSON.stringify([...set]), 'utf8'); } catch {}
}
function loadBotOpenedDeals(mode: IgMode): Set<string> {
  try { return new Set(JSON.parse(fs.readFileSync(botOpenedDealsFile(mode), 'utf8')) as string[]); }
  catch { return new Set(); }
}

// Deal IDs explicitly released by the user — "you can close it now". Applies
// to any position (manually-opened, or a bot-opened one the user separately
// asked to hold and is now letting go). Union with botOpenedDeals is what
// executeIgSignal checks before actually closing anything.
function releasedDealsFile(mode: IgMode): string {
  return path.join(__dirname, '..', `ig-released-deals-${mode}.json`);
}
function saveReleasedDeals(mode: IgMode, set: Set<string>): void {
  try { fs.writeFileSync(releasedDealsFile(mode), JSON.stringify([...set]), 'utf8'); } catch {}
}
function loadReleasedDeals(mode: IgMode): Set<string> {
  try { return new Set(JSON.parse(fs.readFileSync(releasedDealsFile(mode), 'utf8')) as string[]); }
  catch { return new Set(); }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type IgStrategyName = 'rsi_mean_reversion' | 'ema_crossover' | 'orb' | 'vwap' | 'weekly_momentum' | 'donchian_breakout' | 'donchian_hourly' | 'macd_crossover';
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

// A signal computed off IG's own native data for an epic the bot itself
// isn't acting on — manual-only suggestion, see refreshRecommendations.
export type IgRecommendation = {
  epic:             string;
  name:             string;
  action:           'BUY' | 'SELL';
  reason:           string;
  level:            number;   // price at the time this was computed
  stopPrice?:       number;
  takeProfitPrice?: number;
  computedAt:       string;   // ISO timestamp
  score:            number;   // same conviction score the scanner uses to rank the watch list
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
  recommendations: IgRecommendation[];
  dailyPick:  IgRecommendation | null;
  pausedEpics: string[];
  // Deal IDs the bot will auto-manage (opened by the bot itself, or
  // explicitly released) — anything open but NOT in this list is a
  // manually-opened position the bot is deliberately leaving alone.
  managedDeals: string[];
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
  // Epics IG's own historical-data allowance rejected — value is the epoch ms
  // when the block expires and it's worth trying again. Persisted to disk
  // (see loadBlockedEpics/saveBlockedEpics) so a PM2 restart doesn't lose the
  // block and re-fail the same epic on every single restart, which is what
  // was happening before — SK Hynix scores highest almost every scan, so it
  // got picked and re-failed on every one of today's several restarts.
  blockedEpics:         Map<string, number>;
  // Full-universe manual-only suggestions — see refreshRecommendations.
  recommendations:      Map<string, IgRecommendation>;
  // Single best-scored recommendation for the day, set once (first refresh
  // after UTC midnight — effectively overnight for a UK day) and held stable
  // through the day rather than flipping every 30min refresh like the
  // general recommendations list above does — see ensureDailyPick.
  dailyPick:             IgRecommendation | null;
  dailyPickDate:         string;   // UTC date the current dailyPick was set for
  // Per-epic level that triggered the last entry (Donchian strategies only —
  // signal.triggerLevel). A new signal only executes if it's a genuinely
  // more extreme breakout than this, not just "still past the same old
  // level" — otherwise a stopped-out (or manually closed) position on a
  // multi-hour decline just re-enters again on the very next poll, since
  // the 20-day low it broke below is still valid days later. Confirmed
  // live: Qualcomm cycled through 4 separate entries in under 3 hours, all
  // citing the identical "20-day low 16227.00".
  lastEntryTrigger:      Map<string, { level: number; direction: 'BUY' | 'SELL' }>;
  // User-paused epics — excluded from scanning and entries until manually
  // resumed. Persisted, no auto-expiry (see pausedEpics.ts pattern below).
  pausedEpics:           Set<string>;
  // Daily-loss circuit breaker
  dayKey:               string;   // UTC date the balance baseline belongs to
  dayStartBalance:      number;
  lossLock:             boolean;  // true = no new entries until the next trading day
  // Weekend risk-window guard
  weekendGuardDate:     string;   // UTC date the guard last fired — one-shot per Friday
  // Deal IDs the bot itself opened (see botOpenedDealsFile above) — only
  // these, plus anything in releasedDeals, get automatically closed by the
  // strategy's own exit logic.
  botOpenedDeals:       Set<string>;
  // Deal IDs explicitly released by the user — "you can close it now".
  releasedDeals:        Set<string>;
};

function makeModeState(): ModeState {
  return {
    running: false, paused: false, config: null, session: null,
    log: [], pollTimer: null, nextRunMs: null, lastPollTs: null,
    orbState: {}, authFailCount: 0, sessionRefreshTimer: null,
    marketDetails: new Map(),
    blockedEpics: new Map(),
    recommendations: new Map(),
    dailyPick: null, dailyPickDate: '',
    lastEntryTrigger: new Map(),
    pausedEpics: new Set(),
    dayKey: '', dayStartBalance: 0, lossLock: false,
    weekendGuardDate: '',
    botOpenedDeals: new Set(), releasedDeals: new Set(),
  };
}

const modeStates = new Map<IgMode, ModeState>([
  ['demo', makeModeState()],
  ['live', makeModeState()],
]);
for (const [mode, st] of modeStates) {
  st.blockedEpics    = loadBlockedEpics(mode);
  st.pausedEpics     = loadPausedEpics(mode);
  st.lastEntryTrigger = loadLastEntryTrigger(mode);
  st.botOpenedDeals  = loadBotOpenedDeals(mode);
  st.releasedDeals   = loadReleasedDeals(mode);
}

export function isDealManaged(mode: IgMode, dealId: string): boolean {
  const st = ms(mode);
  return st.botOpenedDeals.has(dealId) || st.releasedDeals.has(dealId);
}
export function releaseDeal(mode: IgMode, dealId: string): void {
  const st = ms(mode);
  st.releasedDeals.add(dealId);
  saveReleasedDeals(mode, st.releasedDeals);
  addLog(mode, 'info', '—', `🔓 Deal ${dealId} released — bot can now manage/close it`);
}
export function holdDeal(mode: IgMode, dealId: string): void {
  const st = ms(mode);
  st.releasedDeals.delete(dealId);
  st.botOpenedDeals.delete(dealId);
  saveReleasedDeals(mode, st.releasedDeals);
  saveBotOpenedDeals(mode, st.botOpenedDeals);
  addLog(mode, 'info', '—', `🔒 Deal ${dealId} held — bot will not close it automatically`);
}

export function isPaused(mode: IgMode, epic: string): boolean { return ms(mode).pausedEpics.has(epic); }
export function getPausedEpics(mode: IgMode): string[] { return [...ms(mode).pausedEpics]; }
export function pauseEpic(mode: IgMode, epic: string): void {
  const st = ms(mode);
  st.pausedEpics.add(epic);
  savePausedEpics(mode, st.pausedEpics);
  addLog(mode, 'info', epicName(epic), '⏸ Paused by user — excluded from scanning and entries until resumed');
}
export function resumeEpic(mode: IgMode, epic: string): void {
  const st = ms(mode);
  st.pausedEpics.delete(epic);
  savePausedEpics(mode, st.pausedEpics);
  addLog(mode, 'info', epicName(epic), '▶ Resumed by user');
}

function ms(mode: IgMode): ModeState { return modeStates.get(mode)!; }

// ── IG resolution map ─────────────────────────────────────────────────────────

const IG_RES: Record<IgStrategyName, { resolution: string; count: number }> = {
  rsi_mean_reversion: { resolution: 'MINUTE_5', count: 60 },
  ema_crossover:      { resolution: 'DAY',       count: 30 },
  orb:                { resolution: 'MINUTE',    count: 60 },
  vwap:               { resolution: 'MINUTE',    count: 60 },
  weekly_momentum:    { resolution: 'WEEK',       count: 20 },
  donchian_breakout:  { resolution: 'DAY',       count: 40 },
  donchian_hourly:    { resolution: 'HOUR',       count: 40 },
  macd_crossover:     { resolution: 'DAY',       count: 50 },
};

// Free-data params for strategies that need something other than the daily
// bars fetchBarsWithFallback defaults to — see the free-data branch in
// evaluateEpic and refreshRecommendations. Every strategy gets an entry now
// (not just the hourly one) — IG's own candle API is allowance-limited and
// intraday strategies poll far more often than daily ones, which is exactly
// what makes them the most likely to burn through it (confirmed live:
// daily-timeframe polling alone was already tripping the allowance before
// this existed at all).
const FREE_DATA_PARAMS: Partial<Record<IgStrategyName, { range: string; alpacaTimeframe: Timeframe; yahooInterval: '1m' | '5m' | '1h' | '1wk' }>> = {
  rsi_mean_reversion: { range: '1mo', alpacaTimeframe: '5Min', yahooInterval: '5m' },
  orb:                { range: '5d',  alpacaTimeframe: '1Min', yahooInterval: '1m' },
  vwap:               { range: '5d',  alpacaTimeframe: '1Min', yahooInterval: '1m' },
  weekly_momentum:    { range: '5y',  alpacaTimeframe: '1Week', yahooInterval: '1wk' },
  donchian_hourly:    { range: '1mo', alpacaTimeframe: '1Hour', yahooInterval: '1h' },
};

// Daily-timeframe strategies poll far more often here than STRATEGY_META's
// shared pollMs (an hourly value really meant for the once-a-day gate below) —
// IG-bot-specific, so it doesn't touch the Alpaca bot's own cadence for
// ema_crossover. Safe to run this often because each cycle tries a free
// Yahoo pre-check before ever touching IG's own (allowance-limited) candle
// API — see evaluateEpic. donchian_hourly isn't gated the same way (see
// evaluateEpic — 'hourly' timeframe skips the once-daily-window gate
// entirely) so it just uses STRATEGY_META's own pollMs directly.
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

export function addLog(mode: IgMode, type: IgLogEntry['type'], epic: string, msg: string) {
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
// minStake defaults to 0.1 only as a last resort when an instrument's real
// minimum couldn't be fetched — every real call site passes IG's actual
// per-instrument minDealSize instead. Confirmed live this matters: this
// function used to hardcode a 0.1 floor and round to 1 decimal place
// regardless of the instrument, even though this exact account has
// successfully traded Micron/WDC at 0.01-0.08 — IG's real minimum for both
// is 0.01, not 0.1. The hardcoded floor was forcing stakes 3-10x larger
// than necessary, which is what was actually driving the repeated
// INSUFFICIENT_FUNDS rejections on higher-priced-per-point shares, not a
// genuine lack of funds for the size that was actually needed.
function calcStake(maxRiskGbp: number, stopDist: number, minStake = 0.1): number {
  if (stopDist <= 0) return minStake;
  const raw = maxRiskGbp / stopDist;
  return Math.max(minStake, Math.round(raw * 100) / 100);
}

export function resolveCredentials(mode: IgMode) {
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
      const usesFreeData = epic in EPIC_TO_ALPACA;
      if (usesFreeData) {
        const bars = await fetchBarsWithFallback(epic, '5d', { alpacaTimeframe: '1Min', yahooInterval: '1m' });
        const last30 = (bars ?? []).slice(-30);
        if (!last30.length) continue;
        const high = Math.max(...last30.map(b => b.h));
        const low  = Math.min(...last30.map(b => b.l));
        st.orbState[epic] = { high, low, established: true };
        addLog(mode, 'info', epicName(epic), `ORB: ${low.toFixed(2)}–${high.toFixed(2)}`);
        continue;
      }
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

// Generic temporary block-and-replace — originally allowance-only, now also
// used for orders IG rejects outright. Confirmed live: Amazon got a SELL
// signal rejected with "Deal REJECTED: UNKNOWN" (an opaque IG-side reason,
// not something missing on our end — placeMarketOrder already surfaces
// whatever reason IG returns), and with no cooldown on a failed order the
// bot retried the identical trade every single poll for hours, all rejected
// the same way — the fresh-breakout filter never engaged because it only
// records a trigger level after a *successful* entry. Same fix as the
// allowance case: block the epic for a cooldown and pull in a fresh scan
// pick instead of hammering IG with the same doomed order indefinitely.
function blockEpicTemporarily(mode: IgMode, cfg: IgStrategyConfig, session: IGSession, badEpic: string, reason: string): void {
  const st   = ms(mode);
  const name = epicName(badEpic);
  st.blockedEpics.set(badEpic, Date.now() + BLOCK_COOLDOWN_MS);
  saveBlockedEpics(mode, st.blockedEpics);
  void (async () => {
    try {
      const current = st.config?.epics ?? [];
      const held    = (await fetchFullPositions(session)).map(p => p.epic);
      const exclude = [...new Set([...current, ...held, ...st.blockedEpics.keys(), ...st.pausedEpics])];
      const picks   = await scanIgEpics(cfg.strategy, session, exclude, 1, msg => addLog(mode, 'info', '—', msg));
      if (picks[0] && st.config) {
        const idx = st.config.epics.indexOf(badEpic);
        if (idx !== -1) st.config.epics[idx] = picks[0];
        addLog(mode, 'info', '—', `Blocked (${reason}, retry in 6h) — ${name} → ${epicName(picks[0])}`);
      } else {
        addLog(mode, 'info', '—', `Blocked (${reason}, retry in 6h) — ${name} dropped, no replacement found this scan`);
      }
    } catch {}
  })();
}

// Periodically (see startRecommendationRefresh) scans the FULL 38-name IG
// universe — not just the handful the bot is currently watching — for a
// live BUY/SELL signal, so a good setup outside the current top-N watch
// slots (or one that's watched but got skipped for sizing/ceiling reasons)
// is still surfaced instead of silently discarded. Alpaca/Yahoo-covered
// names (the majority) are free and checked every cycle; IG-only names
// (indices, FX, UK stocks, and proxies like SK Hynix/Nokia) respect the
// same allowance cooldown as the main bot — never a foreign/ADR proxy for
// those, for the same currency-conversion-risk reason evaluateEpic avoids
// it (see EPIC_TO_ALPACA comment). A successful IG-only fetch also means
// the allowance recovered, unblocking that epic for real trading too.
export async function refreshRecommendations(mode: IgMode, force = false): Promise<void> {
  const st = ms(mode);
  if (!st.running || !st.session || !st.config) {
    if (force) addLog(mode, 'error', '—', '[Recommendation check] Bot not running — nothing to check');
    return;
  }
  const cfg = st.config;
  const { resolution, count } = IG_RES[cfg.strategy];

  let heldEpics = new Set<string>();
  try { heldEpics = new Set((await fetchFullPositions(st.session)).map(p => p.epic)); } catch {}

  const candidates = IG_EPICS.map(e => e.epic).filter(epic => !heldEpics.has(epic) && !st.pausedEpics.has(epic));
  if (force) addLog(mode, 'info', '—', `[Recommendation check] Scanning ${candidates.length} instrument(s)…`);

  let checked = 0, found = 0, blocked = 0;

  for (const epic of candidates) {
    const name         = epicName(epic);
    const usesFreeData = epic in EPIC_TO_ALPACA;

    if (!usesFreeData) {
      const unblockAt = st.blockedEpics.get(epic);
      if (unblockAt !== undefined && !force && Date.now() < unblockAt) continue;
    }

    try {
      let bars: AlpacaBar[];
      if (usesFreeData) {
        const freeParams = FREE_DATA_PARAMS[cfg.strategy];
        const fetched     = freeParams
          ? await fetchBarsWithFallback(epic, freeParams.range, freeParams)
          : await fetchBarsWithFallback(epic, '6mo');
        if (!fetched?.length) continue;
        bars = fetched.slice(-count);
      } else {
        bars = (await fetchCandleHistory(st.session, epic, resolution, count)).map(igBarToAlpacaBar);
      }
      if (!bars.length) throw new Error('No bar data');
      checked++;

      if (!usesFreeData && st.blockedEpics.has(epic)) {
        st.blockedEpics.delete(epic);
        saveBlockedEpics(mode, st.blockedEpics);
        addLog(mode, 'info', name, 'Allowance recovered — unblocked');
      }

      let signal: StrategySignal | null = null;
      switch (cfg.strategy) {
        case 'rsi_mean_reversion': signal = rsiMeanReversionSignal(bars, false); break;
        case 'ema_crossover':      signal = emaCrossoverSignal(bars, false); break;
        case 'vwap':               signal = vwapSignal(bars, bars[bars.length - 1].c, false); break;
        case 'donchian_breakout':  signal = donchianBreakoutSignal(bars, false); break;
        case 'donchian_hourly':    signal = donchianBreakoutSignal(bars, false, undefined, 24, 12, 'hour'); break;
        case 'macd_crossover':     signal = macdCrossoverSignal(bars, false); break;
        default: break;  // orb/weekly_momentum need extra state this scan doesn't track
      }

      if (signal && (signal.action === 'BUY' || signal.action === 'SELL')) {
        found++;
        st.recommendations.set(epic, {
          epic, name, action: signal.action, reason: signal.reason,
          level: bars[bars.length - 1].c,
          stopPrice: signal.stopPrice, takeProfitPrice: signal.takeProfitPrice,
          computedAt: new Date().toISOString(),
          score: scoreForStrategy(cfg.strategy, bars, epic, name),
        });
      } else {
        st.recommendations.delete(epic);
      }
    } catch (e) {
      st.recommendations.delete(epic);
      if (!usesFreeData) {
        blocked++;
        st.blockedEpics.set(epic, Date.now() + BLOCK_COOLDOWN_MS);
        saveBlockedEpics(mode, st.blockedEpics);
        if (force) addLog(mode, 'info', name, `[Recommendation check] Still blocked, retry in 6h: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Only IG's own calls share the allowance — free-data ones get the scanner's lighter spacing.
    await new Promise(r => setTimeout(r, usesFreeData ? 250 : 1200));
  }

  if (force) addLog(mode, 'info', '—', `[Recommendation check] Done — ${checked} checked, ${found} signal(s) found, ${blocked} allowance-blocked`);
}

// Sets today's single best-scored pick the first time this runs after UTC
// midnight (effectively overnight/first-thing-in-the-morning for a UK day),
// then leaves it untouched for the rest of the day — a stable "here's the
// one to look at today" rather than the general recommendations list, which
// keeps changing every 30min as the day's price action evolves. Always
// re-runs a full scan rather than reusing whatever's already in
// st.recommendations, since those could be hours stale by the next morning.
async function ensureDailyPick(mode: IgMode, force = false): Promise<void> {
  const st    = ms(mode);
  const today = new Date().toISOString().slice(0, 10);
  if (!force && st.dailyPickDate === today) return;
  // Bot not actually up yet (e.g. this fires from the boot-time immediate
  // check before auto-resume's async auth/scan has finished) — don't lock
  // in an empty pick for the whole day off a scan that never really ran.
  // Retry on the next tick instead of marking today "done".
  if (!st.running || !st.session || !st.config) return;

  await refreshRecommendations(mode, force);
  const best = [...st.recommendations.values()].sort((a, b) => b.score - a.score)[0] ?? null;

  st.dailyPick     = best;
  st.dailyPickDate = today;
  addLog(mode, 'info', '—', best
    ? `[Daily pick] ${best.name} — ${best.action} (score ${best.score.toFixed(1)}) — ${best.reason}`
    : '[Daily pick] No signal strong enough across the universe today');
}

// Manual override — re-decides today's pick right now regardless of whether
// one was already set today. Useful for testing, or if you just want a
// fresh read given how the day's traded so far.
export async function refreshDailyPick(mode: IgMode): Promise<void> {
  await ensureDailyPick(mode, true);
}

const RECOMMENDATION_REFRESH_MS = 30 * 60_000;  // full-universe sweep every 30min — cheap for free-data names, cooldown-gated for IG-only ones
let recommendationTimer: ReturnType<typeof setInterval> | null = null;

export function startRecommendationRefresh(): void {
  if (recommendationTimer) return;
  recommendationTimer = setInterval(() => {
    for (const mode of ['demo', 'live'] as const) {
      void refreshRecommendations(mode);
      void ensureDailyPick(mode);
    }
  }, RECOMMENDATION_REFRESH_MS);
  // Also check once immediately on boot — otherwise a server that's been up
  // since before midnight won't get today's pick until the next 30min tick.
  for (const mode of ['demo', 'live'] as const) void ensureDailyPick(mode);
}

// ── Signal evaluation ─────────────────────────────────────────────────────────

async function evaluateEpic(
  mode:      IgMode,
  epic:      string,
  positions: FullPosition[],
  cfg:       IgStrategyConfig,
  session:   IGSession,
  available = 0,
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

  // Already rejected by IG's historical-data allowance — persists across
  // restarts (see blockedEpics on ModeState), retried again after
  // BLOCK_COOLDOWN_MS rather than every single poll or every restart. Skip
  // silently; the slot gets a fresh scan pick from blockEpicOnAllowance
  // instead of hammering IG again in the meantime.
  if (!usesFreeData) {
    const st         = ms(mode);
    const unblockAt  = st.blockedEpics.get(epic);
    if (unblockAt !== undefined) {
      if (Date.now() < unblockAt) return;
      st.blockedEpics.delete(epic);
      saveBlockedEpics(mode, st.blockedEpics);
    }
  }

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
  // Free data (Alpaca/Yahoo) is used for every strategy now, not just daily/
  // hourly ones — usesFreeData already restricts this to genuinely-mapped
  // Alpaca shares (EPIC_TO_ALPACA), so there's no timeframe restriction left
  // to apply on top of that.
  if (usesFreeData) {
    const freeParams   = FREE_DATA_PARAMS[cfg.strategy];
    const fallbackBars = freeParams
      ? await fetchBarsWithFallback(epic, freeParams.range, freeParams)
      : await fetchBarsWithFallback(epic, '6mo');
    if (!fallbackBars?.length) { addLog(mode, 'wait', epicName(epic), 'No bar data (Alpaca/Yahoo unavailable)'); return; }
    bars = fallbackBars.slice(-count);
  } else {
    try {
      bars = (await fetchCandleHistory(session, epic, resolution, count)).map(igBarToAlpacaBar);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(mode, 'error', epicName(epic), `Bar fetch failed (${confirmSource}): ${msg}`);
      if (msg.toLowerCase().includes('allowance')) blockEpicTemporarily(mode, cfg, session, epic, 'IG allowance');
      return;
    }
  }
  if (!bars.length) { addLog(mode, 'wait', epicName(epic), 'No bar data'); return; }

  // How current the free-data feed actually is right now — the execution
  // price itself is always IG's live quote (see below), but the *signal*
  // (VWAP/RSI) is computed off Alpaca's free bars, and during quiet hours
  // that feed can go a while between real prints. Used in place of a clock-
  // based "is it NYSE hours" guess — trade whenever the data itself is
  // fresh, not whenever the wall clock says it should be.
  const barAgeMs = Date.now() - new Date(bars[bars.length - 1].t).getTime();

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

    // Same signal function, hourly bars, shorter windows — 24h entry / 12h
    // exit channel instead of 20-day/10-day, for a hours-to-~2-day hold
    // instead of days-to-weeks.
    case 'donchian_hourly':
      signal = donchianBreakoutSignal(bars, inPosition, side, 24, 12, 'hour');
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

  await executeIgSignal(mode, epic, executionSignal, openPos ?? null, cfg, session, executionPrice, barAgeMs, available);
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
  barAgeMs      = 0,
  available     = 0,
): Promise<void> {
  const { action, reason, stopPrice, takeProfitPrice, trailPercent } = signal;
  const st   = ms(mode);
  const name = epicName(epic);
  const is24hStrategy = cfg.strategy === 'vwap';

  if (action === 'HOLD') { addLog(mode, 'wait', name, reason); return; }

  if (action === 'CLOSE_LONG' || action === 'CLOSE_SHORT') {
    if (!openPos) return;
    // Only auto-close deals the bot itself opened, or ones explicitly
    // released by the user — a manually-opened position (e.g. via the IG
    // app directly) is left alone by default, since the strategy's exit
    // logic wasn't what the user was trading on when they opened it.
    if (!st.botOpenedDeals.has(openPos.dealId) && !st.releasedDeals.has(openPos.dealId)) {
      addLog(mode, 'wait', name, `🔒 Manually-opened position — not closing automatically (would have: ${reason}). Release it to let the bot manage exits.`);
      return;
    }
    addLog(mode, 'exit', name, `Closing — ${reason}`);
    try {
      await igClosePos(session, openPos.dealId, openPos.direction, openPos.size);
      addLog(mode, 'exit', name, `Closed deal ${openPos.dealId}`);

      // Find replacement epic
      void (async () => {
        try {
          const current = st.config?.epics ?? [];
          const held    = (await fetchFullPositions(session)).map(p => p.epic);
          const exclude = [...new Set([...current, ...held, ...st.pausedEpics])].filter(e => e !== epic || st.pausedEpics.has(e));
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
  // isNearClose() means "NYSE closing in <15 min" — meaningless for a
  // continuously-quoted 24h product with no session close to hold through.
  if (!is24hStrategy && isNearClose())  { addLog(mode, 'wait', name, '⏸ Market closing <15 min — no new entries'); return; }
  if (st.pausedEpics.has(epic))         { addLog(mode, 'wait', name, '⏸ Paused by user — skipping entry'); return; }

  // Real-time tradeability, not a fixed-hours guess — the "(24 Hours)"
  // branding on these IG products isn't an unconditional guarantee (IG can
  // still suspend dealing around news, extreme moves, or its own maintenance
  // windows). Checked for every strategy, not just the 24h one — it's a pure
  // safety addition that only ever blocks entries IG itself says can't be
  // dealt right now, never blocks anything that was working before.
  const marketStatus = st.marketDetails.get(epic)?.marketStatus;
  if (marketStatus && marketStatus !== 'TRADEABLE') {
    addLog(mode, 'wait', name, `⏸ Market not tradeable right now (${marketStatus})`);
    return;
  }

  const direction  = action === 'BUY' ? 'BUY' : 'SELL';

  // Fresh-breakout-only re-entry (Donchian strategies) — the new signal's
  // trigger level must be more extreme than whatever triggered the last
  // entry on this epic, not just "still past the same old level". Otherwise
  // a stopped-out (or manually closed) position on a multi-hour move just
  // re-enters again on the very next poll, since the historical high/low it
  // broke past hasn't itself been surpassed yet — confirmed live: Qualcomm
  // cycled through 4 separate entries in under 3 hours, all citing the
  // identical "20-day low 16227.00".
  if (signal.triggerLevel !== undefined) {
    const lastTrigger = st.lastEntryTrigger.get(epic);
    if (lastTrigger && lastTrigger.direction === direction) {
      const moreExtreme = direction === 'BUY'
        ? signal.triggerLevel > lastTrigger.level
        : signal.triggerLevel < lastTrigger.level;
      if (!moreExtreme) {
        addLog(mode, 'wait', name, `Same breakout level as last entry (${lastTrigger.level.toFixed(2)}) — waiting for a fresh one`);
        return;
      }
    }
  }

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

  // Overnight liquidity guard — outside NYSE cash hours, the 24h product's
  // spread is the concrete symptom of thinner dealing depth. A spread eating
  // a large share of the stop distance means either the "edge" the strategy
  // computed is mostly spread cost, or a fill would land materially worse
  // than the signal price. Checked for every strategy (never blocks anything
  // that was already fine during normal hours), but this is the actual risk
  // the 24h VWAP window introduces, so it matters most there.
  if (detail?.bid !== undefined && detail?.offer !== undefined) {
    const spread = detail.offer - detail.bid;
    if (spread > sizingStopDist * 0.25) {
      addLog(mode, 'wait', name,
        `Skipped — spread ${spread.toFixed(2)} is >25% of the ${sizingStopDist.toFixed(2)}pt stop (thin liquidity right now)`);
      return;
    }
  }

  // Size off actual data freshness, not the wall clock — "is it NYSE hours"
  // was only ever a rough proxy for "is the free-data feed current right
  // now", and a genuinely fresh feed at 9am UK deserves full size same as
  // one at 2pm UK; a stale feed deserves half size regardless of the hour.
  // The execution price itself is always IG's live quote either way (see
  // the free-data-confirm block above) — this only affects confidence in
  // the *signal* that decided to trade in the first place. Only applies to
  // the 24h strategy; normal-hours sizing is untouched for everything else.
  const STALE_DATA_MS = 5 * 60_000;
  const overnightDerate = is24hStrategy && barAgeMs > STALE_DATA_MS ? 0.5 : 1;
  const rawStake = calcStake(cfg.maxRiskGbp * overnightDerate, sizingStopDist, minDeal);
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

  // Margin affordability — confirmed live this matters: Western Digital and
  // Micron both got rejected with INSUFFICIENT_FUNDS at the IG minimum
  // stake, with zero other positions open and the full account balance
  // available — the required margin for even the smallest possible
  // position exceeded what the account holds. No amount of stake-shrinking
  // fixes that once already at the floor, so check it up front rather than
  // wasting a live order attempt (and the 6h cooldown that follows a failed
  // one) on an instrument this account structurally can't afford right now.
  if (detail?.marginFactorPct !== undefined) {
    const requiredMargin = stake * currentPrice * (detail.marginFactorPct / 100);
    if (requiredMargin > available) {
      addLog(mode, 'wait', name,
        `Skipped — would need £${requiredMargin.toFixed(0)} margin (stake £${stake}/pt, ${detail.marginFactorPct}% factor), only £${available.toFixed(0)} available`);
      blockEpicTemporarily(mode, cfg, session, epic, 'insufficient margin for this account size');
      return;
    }
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
      // Best-effort — [] if no Alpaca ticker mapping or Finnhub unavailable,
      // Gemini still runs on technicals alone in that case (see prompt).
      const ticker    = EPIC_TO_ALPACA[epic];
      const headlines = ticker ? await fetchCompanyHeadlines(ticker, 5, name) : [];
      const verdict = await askGeminiDailyVerdict({
        instrumentName: name,
        direction,
        strength:       70,  // no granular numeric score at this layer — fixed moderate default
        price:          currentPrice,
        changePercent:  0,   // not available at this layer; doesn't affect the direction check
        stopPoints:     sizingStopDist,
        tpPoints:       profitDist ?? sizingStopDist * 2.5,
        headlines,
      });
      addLog(mode, 'info', name, `[GEMINI] ${verdict.direction} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);
      // Fail closed, not open — confirmed live this matters: a Qualcomm BUY
      // went through unconfirmed purely because Gemini returned a 503 at
      // that exact moment, on a 6.54%-below-VWAP setup extreme enough that
      // it's exactly the kind of trade the news check exists to catch.
      // "Gemini unavailable" should skip the entry, not silently trade the
      // technical signal alone as if it had been reviewed and approved.
      if (verdict.engine === 'passthrough') {
        addLog(mode, 'wait', name, `[GEMINI] Unavailable (${verdict.reason}) — skipping entry rather than trading unconfirmed`);
        return;
      }
      if (verdict.direction === 'SKIP' || verdict.confidence < 50) {
        addLog(mode, 'wait', name, `[GEMINI] Skipped entry — ${verdict.direction} ${verdict.confidence}%`);
        return;
      }
      if (verdict.direction === 'BUY' || verdict.direction === 'SELL') effectiveDirection = verdict.direction;
    } catch {
      addLog(mode, 'wait', name, '[GEMINI] Call failed — skipping entry rather than trading unconfirmed');
      return;
    }
  }

  addLog(mode, 'enter', name, `${effectiveDirection} — ${reason}`);
  addLog(mode, 'info',  name, `Stake: £${stake}/pt | Price: ~${currentPrice.toFixed(2)} | max loss at stop: ~£${(stake * sizingStopDist).toFixed(0)}`);

  try {
    const { dealId, level, protectionOk, protectionError } =
      await placeMarketOrder(session, epic, effectiveDirection, stake, effectiveStopDist, profitDist);
    addLog(mode, 'enter', name, `Deal confirmed — id ${dealId} @ ${level.toFixed(2)}`);
    st.botOpenedDeals.add(dealId);
    saveBotOpenedDeals(mode, st.botOpenedDeals);
    // Auto-enrol every bot-opened deal in Gemini Position Watch — previously
    // opt-in only (manually flagged via the UI), so a bot-opened position had
    // no qualitative review at all beyond the fixed 1.5x profit-lock number.
    // Dynamic import avoids a static circular dependency (geminiWatch.ts
    // already imports from this file); safe here since it only runs well
    // after both modules have finished initializing.
    try {
      const { addToWatch } = await import('./geminiWatch');
      addToWatch(mode, dealId);
    } catch {}
    if (signal.triggerLevel !== undefined) {
      st.lastEntryTrigger.set(epic, { level: signal.triggerLevel, direction: effectiveDirection });
      saveLastEntryTrigger(mode, st.lastEntryTrigger);
    }

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
    const msg = e instanceof Error ? e.message : String(e);
    addLog(mode, 'error', name, `Order failed: ${msg}`);
    // A failed order never reaches the lastEntryTrigger write above, so the
    // fresh-breakout filter has nothing to compare against — without this,
    // an epic IG keeps rejecting just retries the identical trade every
    // poll indefinitely. Confirmed live: Amazon SELL rejected 14 times over
    // ~2 hours, "Deal REJECTED: UNKNOWN" every time, same signal, same
    // stake, no backoff.
    blockEpicTemporarily(mode, cfg, session, epic, `order rejected: ${msg.slice(0, 60)}`);
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

  // VWAP trades IG's own individually-quoted "(24 Hours)" shares (confirmed
  // live against the account — AAPL/AMD/QCOM/MU/WDC all show as TRADEABLE
  // with live pricing well outside NYSE cash hours), not Alpaca's exchange-
  // hours-only feed — so it isn't gated on isNYSEOpen() the way ORB/RSI Mean
  // Reversion still are (ORB specifically needs a defined session open to
  // build an opening range from; that concept doesn't exist on a continuously-
  // quoted product). Per-epic real tradeability (marketStatus) and an
  // overnight risk reduction are enforced instead, in executeIgSignal.
  const is24hStrategy = cfg.strategy === 'vwap';
  if (meta.timeframe === 'intraday' && !is24hStrategy && !isNYSEOpen()) { schedule(mode, cfg); return; }
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

  // Drop dealIds no longer open (closed by the bot, manually, or by any of
  // the circuit breakers below) — otherwise botOpenedDeals/releasedDeals
  // grow forever with stale IDs that can never matter again.
  {
    const openIds = new Set(positions.map(p => p.dealId));
    let changed = false;
    for (const id of st.botOpenedDeals) if (!openIds.has(id)) { st.botOpenedDeals.delete(id); changed = true; }
    for (const id of st.releasedDeals)  if (!openIds.has(id)) { st.releasedDeals.delete(id);  changed = true; }
    if (changed) { saveBotOpenedDeals(mode, st.botOpenedDeals); saveReleasedDeals(mode, st.releasedDeals); }
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

  // Severe-loss circuit breaker — every stop this bot sets is non-guaranteed
  // (guaranteedStop: false throughout igApi.ts), so it CAN slip past its set
  // level on a fast gap rather than fill exactly there. These share CFDs are
  // 24-hour instruments with no market-hours gate protecting them, so that
  // risk exists around the clock, not just during a session. Independent of
  // the strategy's own exit logic and of which stop mechanism was supposed
  // to protect it: if a position's actual realized loss has blown past 5x
  // the per-trade risk target regardless of why, close it immediately rather
  // than trust whatever was meant to have already stopped it out.
  const severeLossCeiling = cfg.maxRiskGbp * 5;
  for (const p of positions) {
    if (p.upl >= -severeLossCeiling) continue;
    const name = epicName(p.epic);
    addLog(mode, 'error', name,
      `🚨 Severe loss guard — £${Math.abs(p.upl).toFixed(2)} loss exceeds £${severeLossCeiling.toFixed(0)} (5× target) — closing immediately, stop may have slipped`);
    try {
      await igClosePos(st.session, p.dealId, p.direction, p.size);
    } catch (e) {
      addLog(mode, 'error', name, `🚨 Severe loss guard close FAILED: ${e instanceof Error ? e.message : String(e)}. Manual intervention needed.`);
    }
  }

  // Profit-lock circuit breaker — banks a healthy win outright once it's
  // reached, rather than trusting the trailing stop / channel-exit to
  // eventually catch it. Confirmed live this matters: visible gains have
  // gone back to red because nothing closed the position in time. Doesn't
  // need active monitoring — checked every poll alongside the loss guard
  // above, same cadence. Threshold is a clear, worthwhile multiple of what
  // was risked (not a token amount), so it's banking real wins, not just
  // clipping tiny ones early.
  const profitLockFloor = cfg.maxRiskGbp * 1.5;
  for (const p of positions) {
    if (p.upl < profitLockFloor) continue;
    const name = epicName(p.epic);
    addLog(mode, 'exit', name,
      `💰 Profit lock — £${p.upl.toFixed(2)} gain clears £${profitLockFloor.toFixed(0)} (1.5× target) — banking it`);
    try {
      await igClosePos(st.session, p.dealId, p.direction, p.size);
    } catch (e) {
      addLog(mode, 'error', name, `Profit lock close failed: ${e instanceof Error ? e.message : String(e)}. Will retry next poll.`);
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
    await evaluateEpic(mode, epic, positions, cfg, st.session, available);
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
    const best = await scanIgEpics(cfg.strategy, st.session, [...st.pausedEpics], cfg.maxPositions + 2, msg => addLog(mode, 'info', '—', msg));
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
    recommendations: [...st.recommendations.values()],
    dailyPick:  st.dailyPick,
    pausedEpics: [...st.pausedEpics],
    managedDeals: [...new Set([...st.botOpenedDeals, ...st.releasedDeals])],
  };
}

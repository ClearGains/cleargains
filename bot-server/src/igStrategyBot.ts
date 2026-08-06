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
  calcRsi, calcMacdHist, calcAtr,
  STRATEGY_META,
  type StrategySignal,
} from './alpacaStrategies';
import { scanIgEpics, epicName, IG_EPICS, scoreForStrategy, LIGHTSTREAM_ELIGIBLE_EPICS, isIndexEpic, SECTOR_MAP } from './igStrategyScanner';
import { askGeminiDailyVerdict, askGeminiTradeIdea } from './gemini';
import { fetchBarsWithFallback, fetchYahooBars, EPIC_TO_YAHOO, EPIC_TO_ALPACA } from './yahooFetch';
import { fetchCompanyHeadlines } from './newsFetch';
import { createStreamManager, type StreamManager } from './igStream';
import type { CandleTick } from './scalperStrategy';
import type { AlpacaBar, Timeframe } from './alpacaApi';
import {
  isNYSEOpen, isInOpeningRange, isNearClose,
  isDailyCheckTime, isWeeklyCheckTime, isWeekend, msUntilMondayOpen, isScannerQuietWeekend,
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
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(mode), 'utf8')) as IgStrategyConfig & { maxPositions?: number };
    // Migrate state files saved before maxPositions was split into separate
    // stock/index caps — without this, an auto-resume loading an old file
    // gets undefined for both new fields, which silently disables the
    // position-cap check entirely (openCount >= undefined is always false).
    if (parsed.maxStockPositions === undefined || parsed.maxIndexPositions === undefined) {
      const legacy = parsed.maxPositions ?? 3;
      parsed.maxStockPositions ??= legacy;
      parsed.maxIndexPositions ??= legacy;
    }
    return parsed;
  } catch { return null; }
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

// Per-epic cooldown after a losing exit — confirmed live this matters: the
// account-wide daily-loss lock is a blunt, all-instruments circuit breaker,
// so rapid repeated re-entry into the SAME instrument right after it just
// lost (no cooldown existed before this) can burn through the whole day's
// loss budget on one bad thesis, locking out genuinely different, unrelated
// opportunities for the rest of the day. This doesn't touch the daily lock
// itself — it just slows how fast one instrument can spend that budget.
const LOSS_COOLDOWN_MS = 3 * 60 * 60_000;  // 3h — long enough to stop immediate flip-flopping, short enough a same-day different setup isn't locked out for good

function lossCooldownFile(mode: IgMode): string {
  return path.join(__dirname, '..', `ig-loss-cooldown-${mode}.json`);
}
function saveLossCooldownEpics(mode: IgMode, map: Map<string, number>): void {
  try { fs.writeFileSync(lossCooldownFile(mode), JSON.stringify([...map]), 'utf8'); } catch {}
}
function loadLossCooldownEpics(mode: IgMode): Map<string, number> {
  try {
    const pairs = JSON.parse(fs.readFileSync(lossCooldownFile(mode), 'utf8')) as [string, number][];
    const now = Date.now();
    return new Map(pairs.filter(([, until]) => until > now));
  } catch {
    return new Map();
  }
}

// How long a close reason stays worth mentioning to the next entry decision
// on the same instrument — long enough to catch a same-day re-entry, short
// enough that it doesn't keep citing a stale reason indefinitely. In-memory
// only (not persisted) since it's advisory context, not a safety guard.
const EXIT_CONTEXT_MS = 4 * 60 * 60_000;

// Called right after any position close where the realized P&L is known —
// only losses set a re-entry cooldown, but the reason itself (win or loss)
// is always kept as short-lived context for the next entry decision on the
// same instrument, so it doesn't ignore its own recent reasoning. A win
// resets the consecutive-loss streak; a loss increments it, so a second
// loss in a row on the same name/direction gets flagged more emphatically
// than a first — confirmed live this matters: Seagate lost 8 times in one
// session on the same bullish thesis, each entry blind to the ones before it.
export function recordLossExit(mode: IgMode, epic: string, upl: number, reason: string): void {
  const st = ms(mode);
  st.lastExitReason.set(epic, { reason, at: Date.now() });
  if (upl >= 0) { st.lossStreak.set(epic, 0); return; }
  const streak = (st.lossStreak.get(epic) ?? 0) + 1;
  st.lossStreak.set(epic, streak);
  st.lossCooldownEpics.set(epic, Date.now() + LOSS_COOLDOWN_MS);
  saveLossCooldownEpics(mode, st.lossCooldownEpics);
}

// Short text for the entry prompt if this epic — or another name in the same
// sector — closed recently. Sector correlation matters here: a lot of this
// bot's stock universe clusters into a handful of sectors (memory/storage,
// AI/semiconductors, etc.), and a sector-wide theme tends to hit correlated
// names together, not just the one that already got cut — confirmed live
// via Seagate's exits repeatedly citing "memory sector cooling" while
// SanDisk/Micron/Western Digital entries carried on with no awareness of it.
export function getRecentExitContext(mode: IgMode, epic: string): string {
  const st = ms(mode);
  const now = Date.now();
  const parts: string[] = [];

  const own = st.lastExitReason.get(epic);
  if (own && now - own.at <= EXIT_CONTEXT_MS) {
    const minsAgo = Math.round((now - own.at) / 60_000);
    const streak  = st.lossStreak.get(epic) ?? 0;
    const streakNote = streak >= 2 ? ` (${streak} losses in a row on this name)` : '';
    parts.push(`This instrument closed ${minsAgo}min ago${streakNote}: ${own.reason}`);
  }

  const sector = SECTOR_MAP[epic];
  if (sector) {
    const sectorHits = [...st.lastExitReason.entries()]
      .filter(([e, rec]) => e !== epic && SECTOR_MAP[e] === sector && now - rec.at <= EXIT_CONTEXT_MS)
      .sort((a, b) => b[1].at - a[1].at);
    if (sectorHits.length > 0) {
      const [topEpic, topRec] = sectorHits[0];
      parts.push(`${sectorHits.length} other ${sector} name(s) closed recently too, most recently ${epicName(topEpic)}: "${topRec.reason}"`);
    }
  }

  return parts.join(' | ');
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

export type IgStrategyName = 'rsi_mean_reversion' | 'ema_crossover' | 'orb' | 'vwap' | 'weekly_momentum' | 'donchian_breakout' | 'donchian_hourly' | 'macd_crossover' | 'gemini_opinion';
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
  // Split so one category can't crowd out the other's allowance — stocks
  // and indices are counted and capped independently, not against one
  // shared pool.
  maxStockPositions: number;
  maxIndexPositions: number;
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

// Confirmed live this needs a hard ceiling: every failed auto-entry adds one
// more tracked recommendation, and gemini_opinion's 30-min refresh re-asks
// Gemini for every one of them — with nothing bounding the list, a day with
// a lot of rejected entries just keeps growing the recurring Gemini call
// volume with no upper limit. Caps at the best-scored MAX_RECOMMENDATIONS;
// adding past that evicts the weakest one first.
const MAX_RECOMMENDATIONS = 10;
function addRecommendation(recommendations: Map<string, IgRecommendation>, rec: IgRecommendation): void {
  if (!recommendations.has(rec.epic) && recommendations.size >= MAX_RECOMMENDATIONS) {
    let weakest: IgRecommendation | null = null;
    for (const r of recommendations.values()) if (!weakest || r.score < weakest.score) weakest = r;
    if (weakest && weakest.score >= rec.score) return; // new idea isn't even better than what's already full — skip it
    if (weakest) recommendations.delete(weakest.epic);
  }
  recommendations.set(rec.epic, rec);
}

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
  // Fast-interval severe-loss check, independent of the main poll cycle —
  // see runSevereLossGuard.
  severeLossTimer:      ReturnType<typeof setInterval> | null;
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
  // Epics that just closed at a loss — value is the epoch ms cooldown expiry.
  // See recordLossExit/LOSS_COOLDOWN_MS.
  lossCooldownEpics:    Map<string, number>;
  // Most recent close reason per epic, win or loss — see getRecentExitContext.
  lastExitReason:       Map<string, { reason: string; at: number }>;
  // Consecutive losses per epic, reset to 0 on a win — see recordLossExit.
  lossStreak:           Map<string, number>;
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
  // Live-updated candle buffer per epic, fed by Lightstreamer — only used
  // for donchian_hourly/gemini_opinion on LIGHTSTREAM_ELIGIBLE_EPICS (UK
  // stocks/indices), the only strategies on an hourly-or-finer timeframe;
  // IG's Lightstreamer CHART subscription has no DAY/WEEK resolution at
  // all (confirmed live), so daily/weekly strategies can't use this and
  // stay on the Yahoo dynamic-scale fallback instead. Not persisted —
  // rebuilt via prewarmLightstreamBuffer on demand after any restart.
  candleBuffers:        Map<string, CandleTick[]>;
  // One shared Lightstreamer connection per mode, re-subscribed whenever
  // the watched epic list changes (see syncStreamSubscription) — created
  // once here rather than per-epic, mirroring fxScalperBot.ts's pattern.
  stream:               StreamManager;
};

function makeModeState(mode: IgMode): ModeState {
  return {
    running: false, paused: false, config: null, session: null,
    log: [], pollTimer: null, severeLossTimer: null, nextRunMs: null, lastPollTs: null,
    orbState: {}, authFailCount: 0, sessionRefreshTimer: null,
    marketDetails: new Map(),
    blockedEpics: new Map(),
    lossCooldownEpics: new Map(),
    lastExitReason: new Map(),
    lossStreak: new Map(),
    recommendations: new Map(),
    dailyPick: null, dailyPickDate: '',
    lastEntryTrigger: new Map(),
    pausedEpics: new Set(),
    dayKey: '', dayStartBalance: 0, lossLock: false,
    weekendGuardDate: '',
    botOpenedDeals: new Set(), releasedDeals: new Set(),
    candleBuffers: new Map(),
    stream: createStreamManager(`igStream:strat:${mode}`),
  };
}

const modeStates = new Map<IgMode, ModeState>([
  ['demo', makeModeState('demo')],
  ['live', makeModeState('live')],
]);
for (const [mode, st] of modeStates) {
  st.blockedEpics    = loadBlockedEpics(mode);
  st.lossCooldownEpics = loadLossCooldownEpics(mode);
  st.pausedEpics     = loadPausedEpics(mode);
  st.lastEntryTrigger = loadLastEntryTrigger(mode);
  st.botOpenedDeals  = loadBotOpenedDeals(mode);
  st.releasedDeals   = loadReleasedDeals(mode);
}

export function isDealManaged(mode: IgMode, dealId: string): boolean {
  const st = ms(mode);
  return st.botOpenedDeals.has(dealId) || st.releasedDeals.has(dealId);
}

// Read-only escape hatch for other bot modules (e.g. fxScalperBot.ts) that
// want to respect this mode's own daily-loss circuit breaker as a shared
// account-wide backstop, without duplicating the balance/day-start tracking
// that computes it.
export function isLossLocked(mode: IgMode): boolean {
  return ms(mode).lossLock;
}

// Mirrors exactly what executeIgSignal does inline right after a successful
// placeMarketOrder call — pulled out so other bot modules placing their own
// orders directly (bypassing executeIgSignal entirely) can still register
// into the same persisted set, which is what makes self-heal-of-naked-stops
// and the daily-loss lock treat their positions the same as this bot's own.
export function registerBotOpenedDeal(mode: IgMode, dealId: string): void {
  const st = ms(mode);
  st.botOpenedDeals.add(dealId);
  saveBotOpenedDeals(mode, st.botOpenedDeals);
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
  gemini_opinion:     { resolution: 'HOUR',       count: 40 },
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
  gemini_opinion:     { range: '1mo', alpacaTimeframe: '1Hour', yahooInterval: '1h' },
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

// ── Lightstreamer candle buffer (donchian_hourly/gemini_opinion on
// LIGHTSTREAM_ELIGIBLE_EPICS only) ──────────────────────────────────────────
// Same CandleBar→CandleTick shape used by bot.ts/botAccount.ts/fxScalperBot.ts's
// own barToTick converters, duplicated locally rather than imported to avoid
// pulling in scalperStrategy.ts's unrelated processTick machinery here.
function candleBarToTick(epic: string, b: CandleBar): CandleTick {
  return {
    epic,
    time:         b.snapshotTime,
    open:         b.openPrice.mid  ?? b.openPrice.bid,
    high:         b.highPrice.mid  ?? b.highPrice.bid,
    low:          b.lowPrice.mid   ?? b.lowPrice.bid,
    close:        b.closePrice.mid ?? b.closePrice.bid,
    bidClose:     b.closePrice.bid,
    offerClose:   b.closePrice.ask,
    candleClosed: true,
  };
}

function tickToAlpacaBar(t: CandleTick): AlpacaBar {
  return { t: t.time, o: t.open, h: t.high, l: t.low, c: t.close, v: 0 };
}

function handleStreamTick(mode: IgMode, tick: CandleTick): void {
  if (!tick.candleClosed) return; // only closed candles are usable for signal computation
  const st  = ms(mode);
  const arr = st.candleBuffers.get(tick.epic) ?? [];
  arr.push(tick);
  if (arr.length > 60) arr.splice(0, arr.length - 60);
  st.candleBuffers.set(tick.epic, arr);
}

// Re-subscribes the mode's shared Lightstreamer connection to match whatever
// LIGHTSTREAM_ELIGIBLE_EPICS are currently in cfg.epics — only when the
// active strategy is donchian_hourly/gemini_opinion (the only two on an
// hourly timeframe; IG's Lightstreamer CHART item has no DAY/WEEK
// resolution, confirmed live). Called on start, and again immediately after
// either of the two places cfg.epics gets mutated mid-run (blockEpicTemporarily,
// and executeIgSignal's close-position replacement) — igStream.ts's connect()
// always tears down and rebuilds the subscription from scratch (no
// incremental add/remove), so simply re-calling it with the current full
// list is the only way to keep the stream in sync with the watchlist.
function syncStreamSubscription(mode: IgMode): void {
  const st = ms(mode);
  if (!st.config || !st.session) { st.stream.disconnect(); return; }
  const isHourlyStrategy = st.config.strategy === 'donchian_hourly' || st.config.strategy === 'gemini_opinion';
  const streamEpics = isHourlyStrategy ? st.config.epics.filter(e => LIGHTSTREAM_ELIGIBLE_EPICS.has(e)) : [];
  if (!streamEpics.length) { st.stream.disconnect(); return; }
  st.stream.connect(st.session, streamEpics, tick => handleStreamTick(mode, tick), 'HOUR');
}

// One-time seed so a freshly-subscribed epic doesn't have to wait ~40 hours
// accumulating live ticks from nothing before a strategy can evaluate it.
// Sourced from a demo-credentialed session even when mode is 'live' —
// mirrors fxScalperBot.ts's identical reasoning: this is IG's own REST
// candle endpoint, which IS allowance-limited, so seeding it from live's
// own account would defeat the entire point of this feature. Demo's
// allowance is independent and has headroom; the live account's own
// allowance is never touched by this.
async function prewarmLightstreamBuffer(mode: IgMode, epic: string, count: number): Promise<void> {
  const st = ms(mode);
  try {
    let dataSession: IGSession;
    if (mode === 'demo') {
      if (!st.session) return;
      dataSession = st.session;
    } else {
      const existing = getSession('igstrat-data:live');
      if (existing && Date.now() < existing.expiresAt - 2 * 60_000) {
        dataSession = existing;
      } else {
        const creds = resolveCredentials('demo');
        if (!creds.apiKey) return;
        dataSession = await authenticate(creds.apiKey, creds.username, creds.password, creds.env, 'igstrat-data:live');
      }
    }
    const bars = await fetchCandleHistory(dataSession, epic, 'HOUR', count);
    if (bars.length) st.candleBuffers.set(epic, bars.map(b => candleBarToTick(epic, b)));
  } catch (e) {
    addLog(mode, 'info', epicName(epic), `Lightstream prewarm skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
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

  const now = new Date();
  const d = now.getUTCDay();
  // Sunday stops being "weekend" the moment FX/indices reopen at 22:00 UTC —
  // without the hour check, the target below computes to *today* 22:00,
  // which has already passed once we're past it, so sleepMs collapses to
  // the 60s floor and this re-fires in a tight loop until UTC midnight.
  if (d === 6 || (d === 0 && now.getUTCHours() < 22)) {
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
      const exclude = [...new Set([...current, ...held, ...st.blockedEpics.keys(), ...st.lossCooldownEpics.keys(), ...st.pausedEpics])];
      // Ask for several candidates, not just one — two epics blocked in the
      // same cycle can each start this scan before either has written its
      // pick back, so both score the same top name as "best available" and
      // pick it independently. Confirmed live: AUD/USD and USD/JPY both got
      // blocked together and both replaced with BlackBerry, leaving it
      // duplicated in the watchlist while one slot silently got nothing.
      // The include-check and the write below are synchronous with no
      // await between them, so re-checking the live array immediately
      // before writing (rather than trusting the `current` snapshot taken
      // before the scan) closes the race instead of just narrowing it.
      const picks = await scanIgEpics(cfg.strategy, session, exclude, 5, msg => addLog(mode, 'info', '—', msg));
      const idx = st.config?.epics.indexOf(badEpic) ?? -1;
      if (idx === -1) {
        addLog(mode, 'info', '—', `Blocked (${reason}, retry in 6h) — ${name} — slot already changed, nothing to replace`);
        return;
      }
      const replacement = picks.find(p => !st.config!.epics.includes(p));
      if (replacement) {
        st.config!.epics[idx] = replacement;
        syncStreamSubscription(mode); // watchlist changed — keep the Lightstream subscription in sync, not just the config array
        addLog(mode, 'info', '—', `Blocked (${reason}, retry in 6h) — ${name} → ${epicName(replacement)}`);
      } else {
        addLog(mode, 'info', '—', `Blocked (${reason}, retry in 6h) — ${name} dropped, no distinct replacement found this scan`);
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

  // gemini_opinion has no free technical rule to sweep the full 38-name
  // universe with the way the strategies below do, and re-validating
  // tracked recommendations with a real Gemini call every 30min turned out
  // to meaningfully add to the daily call volume (confirmed live) on top of
  // the entry-scan's own steady usage. Reverted to just leaving whatever's
  // already flagged as a recommendation (a failed auto-entry — see
  // executeIgSignal's catch block) as-is, no periodic Gemini re-check —
  // still capped in size by addRecommendation, just no longer refreshed.
  if (cfg.strategy === 'gemini_opinion') return;

  const { resolution, count } = IG_RES[cfg.strategy];

  let heldEpics = new Set<string>();
  try { heldEpics = new Set((await fetchFullPositions(st.session)).map(p => p.epic)); } catch {}

  const candidates = IG_EPICS.map(e => e.epic).filter(epic => !heldEpics.has(epic) && !st.pausedEpics.has(epic));
  if (force) addLog(mode, 'info', '—', `[Recommendation check] Scanning ${candidates.length} instrument(s)…`);

  // Batch-fetch live quotes once for whichever candidates would use the
  // Yahoo dynamic-scale path below — fetchMarketDetails is NOT allowance-
  // limited (unlike fetchCandleHistory), and this function has no other
  // source of a live IG price for epics outside evaluateEpic's cfg.epics
  // (st.marketDetails is only populated for the active watchlist).
  const yahooScaledCandidates = candidates.filter(epic => !(epic in EPIC_TO_ALPACA) && epic in EPIC_TO_YAHOO);
  const yahooRefPrices = new Map<string, number>();
  if (yahooScaledCandidates.length) {
    try {
      const details = await fetchMarketDetails(st.session, yahooScaledCandidates);
      for (const [epic, d] of details) if (d.bid !== undefined && d.offer !== undefined) yahooRefPrices.set(epic, (d.bid + d.offer) / 2);
    } catch {}
  }

  let checked = 0, found = 0, blocked = 0;

  for (const epic of candidates) {
    const name         = epicName(epic);
    const usesFreeData = epic in EPIC_TO_ALPACA;
    // Opportunistic only — this function doesn't drive prewarmLightstreamBuffer
    // itself (that's evaluateEpic's job for the actively-watched epics); if
    // the buffer happens to already be populated (because this epic is also
    // in cfg.epics), reuse it for free, otherwise fall through to Yahoo/IG-REST.
    const usesLightstream = !usesFreeData
      && cfg.strategy === 'donchian_hourly'
      && LIGHTSTREAM_ELIGIBLE_EPICS.has(epic)
      && (st.candleBuffers.get(epic)?.length ?? 0) >= count;
    const usesYahooScaled = !usesFreeData && !usesLightstream && yahooRefPrices.has(epic);
    const usesAnyFreePath = usesFreeData || usesLightstream || usesYahooScaled;

    if (!usesAnyFreePath) {
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
      } else if (usesLightstream) {
        bars = (st.candleBuffers.get(epic) ?? []).slice(-count).map(tickToAlpacaBar);
      } else if (usesYahooScaled) {
        const freeParams = FREE_DATA_PARAMS[cfg.strategy];
        const liveLevel  = yahooRefPrices.get(epic);
        const fetched    = freeParams
          ? await fetchBarsWithFallback(epic, freeParams.range, { ...freeParams, liveReferenceLevel: liveLevel })
          : await fetchBarsWithFallback(epic, '6mo', { liveReferenceLevel: liveLevel });
        if (!fetched?.length) continue;
        bars = fetched.slice(-count);
      } else {
        bars = (await fetchCandleHistory(st.session, epic, resolution, count)).map(igBarToAlpacaBar);
      }
      if (!bars.length) throw new Error('No bar data');
      checked++;

      if (!usesAnyFreePath && st.blockedEpics.has(epic)) {
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
        addRecommendation(st.recommendations, {
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
      if (!usesAnyFreePath) {
        blocked++;
        st.blockedEpics.set(epic, Date.now() + BLOCK_COOLDOWN_MS);
        saveBlockedEpics(mode, st.blockedEpics);
        if (force) addLog(mode, 'info', name, `[Recommendation check] Still blocked, retry in 6h: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Only IG's own calls share the allowance — free-data ones get the scanner's lighter spacing.
    await new Promise(r => setTimeout(r, usesAnyFreePath ? 250 : 1200));
  }

  if (force) addLog(mode, 'info', '—', `[Recommendation check] Done — ${checked} checked, ${found} signal(s) found, ${blocked} allowance-blocked`);
}

// Manually executes a currently-listed recommendation as a real order — the
// "just send it through" path: re-prices against the live market rather
// than trusting the (possibly several-minutes-stale) level the recommendation
// was computed at, but keeps the same stop/TP *distance* the recommendation
// chose, applied relative to the fresh price. Sized off the bot's own
// maxRiskGbp, same as every other entry this bot places.
export async function openRecommendation(mode: IgMode, epic: string): Promise<{ ok: boolean; error?: string }> {
  const st = ms(mode);
  if (!st.running || !st.session || !st.config) return { ok: false, error: 'Bot not running' };
  const rec = st.recommendations.get(epic);
  if (!rec) return { ok: false, error: 'No current recommendation for this epic' };
  const cfg  = st.config;
  const name = epicName(epic);

  try {
    const livePositions = await fetchFullPositions(st.session);
    if (livePositions.some(p => p.epic === epic)) return { ok: false, error: 'Position already open on this epic' };

    const details = await fetchMarketDetails(st.session, [epic]);
    const detail  = details.get(epic);
    const minDeal = detail?.minDealSize ?? 0.5;
    const minStop = detail?.minStopDist ?? 1;
    const currentPrice = (rec.action === 'BUY' ? detail?.offer : detail?.bid) ?? rec.level;

    const stopDist   = Math.max(minStop, rec.stopPrice       !== undefined ? Math.abs(rec.level - rec.stopPrice)       : currentPrice * 0.02);
    const profitDist = Math.max(minStop, rec.takeProfitPrice !== undefined ? Math.abs(rec.level - rec.takeProfitPrice) : currentPrice * 0.03);
    const stake       = Math.max(minDeal, calcStake(cfg.maxRiskGbp, stopDist, minDeal));

    const { dealId, level, protectionOk, protectionError, guaranteedStop } =
      await placeMarketOrder(st.session, epic, rec.action, stake, stopDist, profitDist, 'GBP', true);

    addLog(mode, 'enter', name,
      `↑ Manually opened from recommendation — ${rec.action} @ ${level.toFixed(2)} · stake ${stake} · stop ${stopDist.toFixed(1)}pt${guaranteedStop ? ' (guaranteed)' : ''} TP ${profitDist.toFixed(1)}pt`);
    if (!protectionOk) addLog(mode, 'error', name, `🚨 UNPROTECTED — stop/TP attach failed: ${protectionError ?? 'unknown'}. Monitor manually.`);

    registerBotOpenedDeal(mode, dealId);
    try { const { addToWatch } = await import('./geminiWatch'); addToWatch(mode, dealId); } catch {}
    st.recommendations.delete(epic);

    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    addLog(mode, 'error', name, `Manual open from recommendation failed: ${msg}`);
    return { ok: false, error: msg };
  }
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
    if (isScannerQuietWeekend()) return;  // nothing tradeable to scan for — see isScannerQuietWeekend
    for (const mode of ['demo', 'live'] as const) {
      void refreshRecommendations(mode);
      void ensureDailyPick(mode);
    }
  }, RECOMMENDATION_REFRESH_MS);
  // Also check once immediately on boot — otherwise a server that's been up
  // since before midnight won't get today's pick until the next 30min tick.
  // Still skipped during the weekend quiet window, same as the periodic tick.
  if (!isScannerQuietWeekend()) {
    for (const mode of ['demo', 'live'] as const) void ensureDailyPick(mode);
  }
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
  // Nokia's Helsinki/EUR listing) used to always fall to IG's own allowance-
  // limited REST candle API — confirmed live that's a real problem (Nokia
  // hit error.public-api.exceeded-account-historical-data-allowance), so
  // there are now two additional free paths for exactly these epics:
  //  - usesLightstream: donchian_hourly/gemini_opinion only (the sole two
  //    strategies on an hourly timeframe), for LIGHTSTREAM_ELIGIBLE_EPICS
  //    (UK stocks/indices) — a live-updated candle buffer fed by IG's own
  //    Lightstreamer feed (confirmed live: HOUR resolution works), so no
  //    scale conversion is ever needed at all, unlike the Yahoo case below.
  //  - usesYahooScaled: everything else Yahoo-covers but Alpaca doesn't
  //    (same set, plus Nokia/SK Hynix, plus these same UK/index epics under
  //    any of the four daily/weekly strategies — IG's Lightstreamer CHART
  //    item has no DAY/WEEK resolution at all, confirmed live, so streaming
  //    can never cover those regardless of strategy). Yahoo's raw price
  //    isn't on the same scale as IG's own (confirmed live: indices are
  //    ~1:1, but Nokia is ~69.74x — not a guessable constant), so this path
  //    dynamically derives the scale from IG's own live quote each time
  //    rather than assuming one, mirroring geminiWatch.ts's identical
  //    technique for FX position reviews.
  const meta              = STRATEGY_META[cfg.strategy];
  const usesFreeData      = epic in EPIC_TO_ALPACA;
  // gemini_opinion no longer uses Lightstream here — confirmed live its UK
  // stocks (Barclays, BP, HSBC, AstraZeneca etc, all Lightstream-eligible
  // but not Alpaca-covered) were falling through to prewarmLightstreamBuffer
  // every single poll cycle whenever the buffer wasn't already filled,
  // hitting fetchCandleHistory (IG's own allowance-limited REST candle API)
  // on every attempt — actively prolonging an already-exhausted allowance
  // rather than just failing once. Yahoo already serves these same UK
  // stocks fine elsewhere (confirmed live, ~15min-fresh) at zero allowance
  // cost, so gemini_opinion falls through to usesYahooScaled below instead.
  const usesLightstream   = !usesFreeData
    && cfg.strategy === 'donchian_hourly'
    && LIGHTSTREAM_ELIGIBLE_EPICS.has(epic);
  const usesYahooScaled   = !usesFreeData && !usesLightstream && epic in EPIC_TO_YAHOO;
  const usesAnyFreePath   = usesFreeData || usesLightstream || usesYahooScaled;
  const confirmSource = usesFreeData      ? 'Alpaca/Yahoo (×100 scaled)'
                       : usesLightstream  ? 'Lightstreamer (IG native, no scaling needed)'
                       : usesYahooScaled  ? 'Yahoo (dynamically scaled to IG live quote)'
                       : "IG's own data";

  const st = ms(mode);

  // Already rejected by IG's historical-data allowance — persists across
  // restarts (see blockedEpics on ModeState), retried again after
  // BLOCK_COOLDOWN_MS rather than every single poll or every restart. Skip
  // silently; the slot gets a fresh scan pick from blockEpicOnAllowance
  // instead of hammering IG again in the meantime.
  if (!usesAnyFreePath) {
    const unblockAt = st.blockedEpics.get(epic);
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
  if (usesFreeData) {
    const freeParams   = FREE_DATA_PARAMS[cfg.strategy];
    const fallbackBars = freeParams
      ? await fetchBarsWithFallback(epic, freeParams.range, freeParams)
      : await fetchBarsWithFallback(epic, '6mo');
    if (!fallbackBars?.length) { addLog(mode, 'wait', epicName(epic), 'No bar data (Alpaca/Yahoo unavailable)'); return; }
    bars = fallbackBars.slice(-count);
  } else if (usesLightstream) {
    let buffered = st.candleBuffers.get(epic) ?? [];
    if (buffered.length < count) {
      await prewarmLightstreamBuffer(mode, epic, count);
      buffered = st.candleBuffers.get(epic) ?? [];
    }
    if (buffered.length < count) { addLog(mode, 'wait', epicName(epic), `Lightstream buffer still filling (${buffered.length}/${count})`); return; }
    bars = buffered.slice(-count).map(tickToAlpacaBar);
  } else if (usesYahooScaled) {
    const live      = st.marketDetails.get(epic);
    const liveLevel = live?.bid !== undefined && live?.offer !== undefined ? (live.bid + live.offer) / 2 : undefined;
    const freeParams    = FREE_DATA_PARAMS[cfg.strategy];
    const fallbackBars  = freeParams
      ? await fetchBarsWithFallback(epic, freeParams.range, { ...freeParams, liveReferenceLevel: liveLevel })
      : await fetchBarsWithFallback(epic, '6mo', { liveReferenceLevel: liveLevel });
    if (!fallbackBars?.length) { addLog(mode, 'wait', epicName(epic), 'No bar data (Yahoo unavailable or unscalable — no live IG quote yet)'); return; }
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

    // No technical rule at all — Gemini decides from scratch. No exit logic
    // of its own either: an open position here is managed entirely by
    // Gemini Position Watch (auto-enrolled at entry, same as every other
    // strategy), not a thesis-reversal check, since there's no thesis
    // beyond "Gemini thought so" to re-evaluate here.
    case 'gemini_opinion': {
      if (inPosition) { signal = { action: 'HOLD', reason: 'Open position — managed by Gemini Position Watch' }; break; }
      // Data staleness kill switch — confirmed live this matters badly:
      // Alpaca's paper-account historical bars for INTC were stuck ~3 weeks
      // stale (last bar over 3 weeks old) despite the API call succeeding
      // with no error, which fed a nonsense "-27% today" figure into
      // Gemini's position review and got a genuinely fine position closed
      // for a fabricated reason. A successful API response is not the same
      // as fresh data — refuse to trust bars this old for anything.
      //
      // 6h was too tight for this, though — confirmed live it was tripping
      // on completely ordinary overnight closure (NYSE closed ~17.5h,
      // LSE ~15.5h between sessions), blocking entries most of every day on
      // every name rather than catching an actually-stuck feed. 20h clears
      // both markets' normal overnight gap while still catching the INTC
      // case (which was stale for *weeks*, not hours) comfortably.
      const STALE_ENTRY_DATA_MS = 20 * 60 * 60_000;
      if (barAgeMs > STALE_ENTRY_DATA_MS) {
        signal = { action: 'HOLD', reason: `Data too stale to trust (${(barAgeMs / 3_600_000).toFixed(1)}h old) — skipping` };
        break;
      }
      const last  = bars[bars.length - 1].c;
      if (last == null || !Number.isFinite(last)) {
        signal = { action: 'HOLD', reason: 'Latest bar has no valid close price — skipping' };
        break;
      }
      const rsi   = calcRsi(bars);
      const macd  = calcMacdHist(bars);
      const atr   = calcAtr(bars);
      const ticker    = EPIC_TO_ALPACA[epic];
      const headlines = ticker ? await fetchCompanyHeadlines(ticker, 8, epicName(epic)) : [];
      // How far this has already moved today, from the bars already
      // fetched — no extra API call. Confirmed live this matters: Micron
      // got bought at 86690 after running from a 73900 prior close, i.e.
      // after ~17% of the day's move had already happened, and nothing in
      // the prompt could tell Gemini that at the time.
      const todayUtc   = new Date().toISOString().slice(0, 10);
      const todaysBars = bars.filter(b => b.t.slice(0, 10) === todayUtc);
      const dayOpen     = todaysBars[0]?.o ?? bars[0]?.o;
      const dayChangePercent = dayOpen ? ((last - dayOpen) / dayOpen) * 100 : undefined;
      // Multi-day trend, from the wider bar window (barsNeeded widened
      // 40->120 specifically for this) — confirmed live this matters:
      // SanDisk got bought on "post-earnings selloff reversing" using only
      // ~40h of history to judge that, and the selloff was still actively
      // continuing at the multi-day level, cutting the position 11min later
      // on the exact same event the entry thesis had called finished.
      // Report the trend over whatever span is actually available rather
      // than assuming a fixed "3-day"/"5-day" label that may not match.
      const spanHours = bars.length - 1;
      const multiDayTrendPercent  = spanHours >= 48 ? ((last - bars[0].c) / bars[0].c) * 100 : undefined;
      const multiDayTrendSpanDays = Math.round(spanHours / 24);
      const recentExitContext = getRecentExitContext(mode, epic);
      const idea = await askGeminiTradeIdea({
        instrumentName: epicName(epic), price: last, rsi, macdHist: macd?.hist ?? null, atr, headlines, dayChangePercent,
        multiDayTrendPercent, multiDayTrendSpanDays,
        recentExitContext,
      });
      // Fails closed — no underlying rule to fall back to the way VWAP
      // falls back to its own technicals when Gemini's unavailable. A
      // passthrough result (no key, cap reached, API error) means no
      // signal at all here, and a low-confidence real verdict is treated
      // the same as HOLD — this strategy only trades on real conviction.
      if (idea.engine !== 'gemini' || idea.action === 'HOLD' || idea.confidence < 60) {
        signal = { action: 'HOLD', reason: `[GEMINI] ${idea.action} ${idea.confidence}% — ${idea.reason} (${idea.engine})` };
        break;
      }
      signal = {
        action:           idea.action,
        reason:           `[GEMINI] ${idea.reason}`,
        confidence:       idea.confidence,
        stopPrice:        idea.action === 'BUY' ? last - idea.stopPoints : last + idea.stopPoints,
        takeProfitPrice:  idea.action === 'BUY' ? last + idea.takeProfitPoints : last - idea.takeProfitPoints,
        orderType:        'market',
      };
      break;
    }

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
  // locking the whole account out, not just this epic. Also covers
  // usesLightstream — its bars are already in IG's native units so there's
  // no scale error to worry about, but the last closed hourly candle can
  // still be up to ~an hour stale relative to true current price, so
  // re-anchoring to the freshest live quote matters there too — and
  // usesYahooScaled, same reasoning as the original Alpaca/Yahoo case.
  if (usesAnyFreePath && (signal.action === 'BUY' || signal.action === 'SELL')) {
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

  await executeIgSignal(mode, epic, executionSignal, openPos ?? null, cfg, session, executionPrice, barAgeMs, available, positions);
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
  positions:    FullPosition[] = [],
): Promise<void> {
  const { action, reason, stopPrice, takeProfitPrice, trailPercent } = signal;
  const st   = ms(mode);
  const name = epicName(epic);
  const is24hStrategy = cfg.strategy === 'vwap' || cfg.strategy === 'gemini_opinion';

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
      recordLossExit(mode, epic, openPos.upl, reason);

      // Find replacement epic — same race as blockEpicTemporarily below can
      // apply here too if multiple positions close around the same time,
      // so this uses the same fix: several candidates, and a synchronous
      // re-check against the live array immediately before writing.
      void (async () => {
        try {
          const current = st.config?.epics ?? [];
          const held    = (await fetchFullPositions(session)).map(p => p.epic);
          const exclude = [...new Set([...current, ...held, ...st.pausedEpics])].filter(e => e !== epic || st.pausedEpics.has(e));
          const picks   = await scanIgEpics(cfg.strategy, session, exclude, 5, msg => addLog(mode, 'info', '—', msg));
          if (!st.config) return;
          const replacement = picks.find(p => !st.config!.epics.includes(p));
          if (!replacement) return;
          const idx = st.config.epics.indexOf(epic);
          if (idx !== -1) st.config.epics[idx] = replacement;
          else st.config.epics.push(replacement);
          syncStreamSubscription(mode); // watchlist changed — keep the Lightstream subscription in sync, not just the config array
          addLog(mode, 'info', '—', `Slot replacement: ${name} → ${epicName(replacement)}`);
        } catch {}
      })();
    } catch (e) {
      addLog(mode, 'error', name, `Close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (st.paused)                       { addLog(mode, 'wait', name, `⏸ Paused — skipping ${action}`); return; }
  if (st.lossLock)                     { addLog(mode, 'wait', name, `🛑 Daily-loss limit hit — skipping ${action} (entries resume next day)`); return; }
  const coolUntil = st.lossCooldownEpics.get(epic);
  if (coolUntil && coolUntil > Date.now()) {
    addLog(mode, 'wait', name, `❄️ Lost recently — cooling down for ${((coolUntil - Date.now()) / 3_600_000).toFixed(1)}h before re-entering (skipping ${action})`);
    return;
  }
  if (action === 'SELL' && !cfg.allowShorts) { addLog(mode, 'wait', name, 'Shorts disabled'); return; }
  if (openPos)                          { addLog(mode, 'wait', name, `Already in position — skipping ${action}`); return; }
  // isNearClose() means "NYSE closing in <15 min" — meaningless for a
  // continuously-quoted 24h product with no session close to hold through.
  if (!is24hStrategy && isNearClose())  { addLog(mode, 'wait', name, '⏸ Market closing <15 min — no new entries'); return; }
  if (st.pausedEpics.has(epic))         { addLog(mode, 'wait', name, '⏸ Paused by user — skipping entry'); return; }

  // Position rotation (gemini_opinion only) — when there's no room for a
  // new entry, compare this candidate against the weakest currently held
  // position instead of just discarding it. Only swaps when the new idea
  // clearly beats the weakest holding by a real margin — a fuzzy or too-
  // eager version of this would just churn out of decent positions chasing
  // slightly shinier ones, which is worse than holding steady.
  const candidateIsIndex = isIndexEpic(epic);
  const samePool          = positions.filter(p => isIndexEpic(p.epic) === candidateIsIndex);
  const poolCap           = candidateIsIndex ? cfg.maxIndexPositions : cfg.maxStockPositions;
  if (cfg.strategy === 'gemini_opinion' && samePool.length >= poolCap) {
    const SWAP_MARGIN = 15;
    const { getWeakestConfidence } = await import('./geminiWatch');
    const weakest       = getWeakestConfidence(samePool.map(p => p.dealId));
    const newConfidence = signal.confidence ?? 0;
    if (!weakest || newConfidence < weakest.confidence + SWAP_MARGIN) {
      addLog(mode, 'wait', name,
        `Skipped — no room (${candidateIsIndex ? 'indices' : 'stocks'} ${samePool.length}/${poolCap})${weakest ? `, ${newConfidence}% doesn't clear the weakest held position (${weakest.confidence}%) by the ${SWAP_MARGIN}pt swap margin` : ''}`);
      return;
    }
    const weakPos = positions.find(p => p.dealId === weakest.dealId);
    if (weakPos) {
      const rotateReason = `Rotating out — ${name}'s ${newConfidence}% idea beats this ${weakest.confidence}% held position by ${SWAP_MARGIN}+ points`;
      addLog(mode, 'exit', epicName(weakPos.epic), `💱 ${rotateReason}`);
      try {
        await igClosePos(session, weakPos.dealId, weakPos.direction, weakPos.size);
        recordLossExit(mode, weakPos.epic, weakPos.upl, rotateReason);
      } catch (e) {
        addLog(mode, 'error', epicName(weakPos.epic), `Rotation close failed: ${e instanceof Error ? e.message : String(e)}`);
        return;  // couldn't actually free the slot — don't proceed with the new entry
      }
    }
  }

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

  // Margin-proportional risk target — when even the instrument's minimum
  // viable stake ties up a large chunk of capital, the flat maxRiskGbp
  // target badly under-uses the capital that's going to be committed
  // regardless. Confirmed live: Dell's minimum stake alone needs £325
  // margin against a £914 account — over a third of it — for a nominal £20
  // risk target, meaning most of that committed capital wasn't actually
  // backing any real risk/reward. Scales the effective target up toward a
  // fraction of the margin actually being tied up, but never below the
  // user's own flat target (cheap-margin instruments like Intel are
  // untouched — the proportional figure comes out smaller than £20 there)
  // and never more than 5x it (an absolute ceiling so a truly extreme
  // instrument can't balloon sizing far past what's sane).
  const RISK_TO_MARGIN_RATIO = 0.15;
  let effectiveRiskGbp = cfg.maxRiskGbp;
  if (detail?.marginFactorPct !== undefined) {
    const minMargin = minDeal * currentPrice * (detail.marginFactorPct / 100);
    effectiveRiskGbp = Math.min(cfg.maxRiskGbp * 5, Math.max(cfg.maxRiskGbp, minMargin * RISK_TO_MARGIN_RATIO));
    if (effectiveRiskGbp > cfg.maxRiskGbp) {
      addLog(mode, 'info', name,
        `Risk target scaled to £${effectiveRiskGbp.toFixed(0)} (from £${cfg.maxRiskGbp}) — minimum stake here ties up ~£${minMargin.toFixed(0)} margin regardless`);
    }
  }

  // Same reasoning again, but for realized loss rather than margin —
  // confirmed live Microsoft and Alphabet were never once clearing the
  // ceiling below despite the conviction scaling there, because their price
  // level and ATR-based stop mean even IG's own minimum stake produces a
  // realized loss of £250-375, structurally higher than the ceiling could
  // ever reach regardless of confidence. There's no smaller stake to fall
  // back to — the margin scaling above doesn't help here since it's driven
  // by margin required, not points-at-risk, and the two aren't the same
  // thing. Scales the effective target up to comfortably clear the
  // instrument's own structural floor, capped so a genuinely absurd
  // instrument still can't balloon sizing without bound.
  const minPossibleLoss = minDeal * sizingStopDist;
  if (minPossibleLoss > effectiveRiskGbp) {
    const scaledForFloor = Math.min(cfg.maxRiskGbp * 25, minPossibleLoss * 1.15);
    if (scaledForFloor > effectiveRiskGbp) {
      effectiveRiskGbp = scaledForFloor;
      addLog(mode, 'info', name,
        `Risk target scaled to £${effectiveRiskGbp.toFixed(0)} — minimum stake here produces at least £${minPossibleLoss.toFixed(0)} realized loss regardless of sizing`);
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
  const rawStake = calcStake(effectiveRiskGbp * overnightDerate, sizingStopDist, minDeal);
  const stake    = Math.max(minDeal, rawStake);

  // Any time the stake actually used ends up above what the target risk
  // would size — whether because IG's minDealSize forced it up, or because
  // calcStake's own internal floor (min 0.1/pt) did — the realized max loss
  // can silently exceed the target with no bound at all. Confirmed live:
  // a genuinely volatile instrument's wide ATR-based stop combined with
  // calcStake's 0.1 floor produced a real £310 max loss against a £20
  // target, and the previous version of this check only looked at whether
  // minDeal specifically was the cause — missed this because calcStake's
  // own floor was what did it here, not IG's minimum. Checking the actual
  // realized loss directly, unconditionally, closes that gap regardless of
  // which mechanism pushed the stake up. Ceiling uses effectiveRiskGbp, not
  // the flat cfg value, so the margin-proportional scaling above isn't
  // immediately undone by this check.
  // Ceiling scales with conviction — a routine 60%-confidence idea (the
  // entry threshold for gemini_opinion) still gets the standard 3x cap, but
  // genuine conviction, as Gemini itself reports it, earns room to size past
  // it, tapering straight back down as confidence drops toward that same
  // threshold. Confirmed live this blocked a genuinely good Microsoft entry
  // purely on the ceiling math, with nothing wrong with the trade itself.
  // Strategies with no real confidence signal (signal.confidence stays
  // undefined) fall back to 60 here, which resolves to the unchanged 3x —
  // this only ever gives gemini_opinion's real conviction more room, never
  // loosens anything for a strategy that has no conviction score to earn it.
  const confidence  = signal.confidence ?? 60;
  const ceilingMult = 3 + Math.max(0, Math.min(confidence, 100) - 60) / 40 * 3; // 3x @60% conviction → 6x @100%
  const actualMaxLoss = stake * sizingStopDist;
  const lossCeiling    = effectiveRiskGbp * ceilingMult;
  if (actualMaxLoss > lossCeiling) {
    addLog(mode, 'wait', name,
      `Skipped — sizing works out to £${actualMaxLoss.toFixed(0)} max loss (stake £${stake}/pt × ${sizingStopDist.toFixed(0)}pt stop), above the £${lossCeiling.toFixed(0)} ceiling (${ceilingMult.toFixed(1)}× target${confidence > 60 ? `, scaled up for ${confidence}% conviction` : ''})`);
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
  // where a sanity check on the setup earns its cost. Skipped entirely for
  // gemini_opinion — the entry signal already IS Gemini's own judgment,
  // asking it to confirm itself would just double the cost for no benefit.
  let effectiveDirection: 'BUY' | 'SELL' = direction;
  if (cfg.strategy !== 'gemini_opinion' && classifyMarketType(epic) === 'SHARES') {
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
    const { dealId, level, protectionOk, protectionError, guaranteedStop } =
      await placeMarketOrder(session, epic, effectiveDirection, stake, effectiveStopDist, profitDist, 'GBP', true);
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
      const { addToWatch, recordEntryConfidence } = await import('./geminiWatch');
      addToWatch(mode, dealId);
      // Seeds the position-rotation baseline with Gemini's own entry
      // confidence, so a fresh gemini_opinion position has something real
      // to be compared against immediately, not an arbitrary default.
      if (cfg.strategy === 'gemini_opinion' && signal.confidence !== undefined) {
        recordEntryConfidence(dealId, signal.confidence);
      }
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
        if (effectiveStopDist) addLog(mode, 'info', name, `Stop attached: ${effectiveStopDist.toFixed(2)} pts${guaranteedStop ? ' (guaranteed — immune to slippage)' : ''}`);
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

    // The idea itself may still be genuinely good even though the order
    // mechanically failed (a transient IG-side rejection, a sizing edge
    // case) — surface it as a standing recommendation instead of just
    // rotating away and losing it. refreshRecommendations() keeps this
    // current (or drops it) every 30min from here on; the user can also
    // open it manually at any point while it's still listed.
    addRecommendation(st.recommendations, {
      epic, name, action: action as 'BUY' | 'SELL',
      reason: `${reason} (auto-entry failed: ${msg.slice(0, 60)})`,
      level: currentPrice, stopPrice, takeProfitPrice,
      computedAt: new Date().toISOString(),
      score: signal.confidence ?? 60,
    });
  }
}

// ── Severe-loss circuit breaker ──────────────────────────────────────────────
// Runs on its own fast interval (see severeLossTimer, started/stopped
// alongside the bot) instead of once per 15min poll — a synthetic substitute
// for a broker-side guaranteed stop, since IG rejects guaranteed stops on
// every real attempt for this account's instruments. Independent of the
// strategy's own exit logic and of which stop mechanism was supposed to
// protect the position: if a position's actual realized loss has blown past
// 5x the per-trade risk target regardless of why, close it immediately
// rather than trust whatever was meant to have already stopped it out.
async function runSevereLossGuard(mode: IgMode): Promise<void> {
  const st = ms(mode);
  if (!st.running || !st.session || !st.config) return;
  try {
    const positions = await fetchFullPositions(st.session);
    const severeLossCeiling = st.config.maxRiskGbp * 5;
    for (const p of positions) {
      if (p.upl >= -severeLossCeiling) continue;
      const name = epicName(p.epic);
      const slReason = `Severe loss guard — £${Math.abs(p.upl).toFixed(2)} loss exceeds £${severeLossCeiling.toFixed(0)} (5× target) — closing immediately, stop may have slipped`;
      addLog(mode, 'error', name, `🚨 ${slReason}`);
      try {
        await igClosePos(st.session, p.dealId, p.direction, p.size);
        recordLossExit(mode, p.epic, p.upl, slReason);
      } catch (e) {
        addLog(mode, 'error', name, `🚨 Severe loss guard close FAILED: ${e instanceof Error ? e.message : String(e)}. Manual intervention needed.`);
      }
    }
  } catch { /* transient fetch failure — next tick retries */ }
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
  // exposed to a weekend gap.
  // Used to unconditionally close every position for "intraday" strategies
  // regardless of P&L — changed after live review: closing purely because a
  // position "can't be monitored" over the weekend crystallizes P&L at an
  // arbitrary moment even when there's no real reason to exit, and Gemini
  // Position Watch keeps reviewing gemini_opinion positions through the
  // weekend anyway (separate mechanism, no weekend pause). Now: close only
  // for an actual reason (a real loss or a profit worth banking), otherwise
  // just tighten the stop to cap gap-risk downside and let it ride —
  // uniformly for every strategy, not just swing/weekly ones.
  if (isNearWeekendClose(120) && st.weekendGuardDate !== today) {
    st.weekendGuardDate = today;
    try {
      const positions = await fetchFullPositions(st.session);
      const severeLossCeiling = cfg.maxRiskGbp * 5;
      const profitLockFloor   = cfg.maxRiskGbp * 1.5;
      for (const p of positions) {
        const name = epicName(p.epic);
        if (p.upl <= -severeLossCeiling) {
          const wkReason = `Weekend risk guard — £${Math.abs(p.upl).toFixed(2)} loss exceeds £${severeLossCeiling.toFixed(0)} (5× target) — closing before the gap`;
          addLog(mode, 'exit', name, wkReason);
          try { await igClosePos(st.session, p.dealId, p.direction, p.size); recordLossExit(mode, p.epic, p.upl, wkReason); }
          catch (e) { addLog(mode, 'error', name, `Weekend flatten failed: ${e instanceof Error ? e.message : String(e)}`); }
        } else if (p.upl >= profitLockFloor) {
          addLog(mode, 'exit', name, `Weekend risk guard — £${p.upl.toFixed(2)} gain clears £${profitLockFloor.toFixed(0)} (1.5× target) — banking it before the gap`);
          try { await igClosePos(st.session, p.dealId, p.direction, p.size); }
          catch (e) { addLog(mode, 'error', name, `Weekend profit-lock failed: ${e instanceof Error ? e.message : String(e)}`); }
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

  // VWAP and Gemini Opinion both trade IG's own individually-quoted
  // "(24 Hours)" shares (confirmed live against the account —
  // AAPL/AMD/QCOM/MU/WDC/Dell all show as TRADEABLE with live pricing well
  // outside NYSE cash hours), not Alpaca's exchange-hours-only feed — so
  // neither is gated on isNYSEOpen() the way ORB/RSI Mean Reversion still
  // are (ORB specifically needs a defined session open to build an opening
  // range from; that concept doesn't exist on a continuously-quoted
  // product, and Gemini Opinion has no technical rule tied to a session at
  // all). Per-epic real tradeability (marketStatus) and an overnight risk
  // reduction are enforced instead, in executeIgSignal.
  const is24hStrategy = cfg.strategy === 'vwap' || cfg.strategy === 'gemini_opinion';
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

  // Severe-loss circuit breaker now runs on its own fast interval (see
  // runSevereLossGuard/severeLossTimer) instead of once per 15min poll —
  // guaranteed stops turned out to be rejected on every real attempt for
  // this account's instruments (confirmed live: 100% ATTACHED_ORDER_LEVEL_ERROR
  // across many different names), so a normal stop slipping is the real,
  // unmitigated risk. A once-per-poll check gave a slip up to 15 minutes to
  // run — confirmed live this is exactly how a £40-stop Seagate position
  // reached an £854.53 loss before anything caught it.

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

  // Market-open weakness guard — a stock/index that's opened red tends to
  // keep weakening rather than reverse, and it's much more dangerous when a
  // major index is *also* down since its own open — broad selling pressure,
  // not something idiosyncratic to one name. This is a fast, rules-only
  // check run every poll, deliberately independent of Gemini Position
  // Watch's own periodic review (geminiWatch.ts): that review cadence isn't
  // built to catch a position that needs to come off *now*, before a weak
  // open compounds into a much bigger loss than a stop was sized for.
  {
    const WEAK_OPEN_PCT = 0.5; // % down/up from today's open before this counts as a real warning
    let referenceIndexPct: number | null | undefined; // undefined = not fetched yet this poll, null = fetch failed
    const getReferenceIndexPct = async (): Promise<number | null> => {
      if (referenceIndexPct !== undefined) return referenceIndexPct;
      try {
        const bars = await fetchBarsWithFallback('IX.D.DOW.DAILY.IP', '1d', { yahooInterval: '15m' });
        referenceIndexPct = (bars && bars.length >= 2 && bars[0].o > 0)
          ? (bars[bars.length - 1].c - bars[0].o) / bars[0].o * 100
          : null;
      } catch { referenceIndexPct = null; }
      return referenceIndexPct;
    };

    for (const p of positions) {
      try {
        // Indices trade continuously (24h-dealable CFDs) — there's no real
        // "session open" the way an individual stock has one, so treating a
        // routine intraday wobble against an arbitrary UTC-midnight
        // reference point as "opened weak, close before it compounds" makes
        // no sense here. Confirmed live this was closing genuine Gemini
        // theses (Wall St/US 500 short-the-overbought-bounce entries) within
        // 15-30min on completely ordinary ~1% moves, before they'd had any
        // real chance to play out — indices still serve as the broad-market
        // corroboration signal for STOCK positions below, just never get
        // closed by this check themselves.
        if (p.epic.startsWith('IX.D.')) continue;

        const bars = await fetchBarsWithFallback(p.epic, '1d', { yahooInterval: '15m' });
        if (!bars || bars.length < 2 || bars[0].o <= 0) continue;

        const isBuy          = p.direction === 'BUY';
        const currentPrice   = isBuy ? p.bid : p.offer; // conservative side for each direction
        const pctFromOpen    = (currentPrice - bars[0].o) / bars[0].o * 100;
        const weakForThisPos = isBuy ? pctFromOpen <= -WEAK_OPEN_PCT : pctFromOpen >= WEAK_OPEN_PCT;
        if (!weakForThisPos) continue;

        const name = epicName(p.epic);
        // Only escalate to an outright close when a major index is
        // confirming the same direction of weakness; otherwise this looks
        // idiosyncratic to this one name, so just tighten instead.
        const idxPct = await getReferenceIndexPct();
        const corroborated = idxPct !== null && (isBuy ? idxPct <= -WEAK_OPEN_PCT * 0.6 : idxPct >= WEAK_OPEN_PCT * 0.6);

        if (corroborated) {
          const woReason = `Weak open — ${pctFromOpen >= 0 ? '+' : ''}${pctFromOpen.toFixed(2)}% vs today's open, market broadly weak too (${idxPct?.toFixed(2)}%) — closing before it compounds`;
          addLog(mode, 'exit', name, `⚠️ ${woReason}`);
          try { await igClosePos(st.session, p.dealId, p.direction, p.size); recordLossExit(mode, p.epic, p.upl, woReason); }
          catch (e) { addLog(mode, 'error', name, `Weak-open close failed: ${e instanceof Error ? e.message : String(e)}`); }
        } else if (p.stopLevel !== undefined) {
          const currentDist   = Math.abs(p.level - p.stopLevel);
          const tightenedDist = currentDist * 0.4;
          const newStop       = p.direction === 'BUY' ? p.level - tightenedDist : p.level + tightenedDist;
          const wouldTighten  = p.direction === 'BUY' ? newStop > p.stopLevel : newStop < p.stopLevel;
          if (wouldTighten) {
            try {
              await updatePositionLevels(st.session, p.dealId, newStop, p.limitLevel ?? null);
              addLog(mode, 'info', name, `⚠️ Weak open — ${pctFromOpen >= 0 ? '+' : ''}${pctFromOpen.toFixed(2)}% vs today's open — tightened stop as a precaution`);
            } catch (e) {
              addLog(mode, 'error', name, `Weak-open stop-tighten failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      } catch { /* best-effort — never let a data-source hiccup block the rest of the poll cycle */ }
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

  // Mutable, re-fetched after every epic — confirmed live this matters: with
  // a single position snapshot reused for the whole loop, Intel and Micron
  // both opened in the same poll cycle under maxPositions:1, because each
  // epic's "is there room" check was still looking at the count from before
  // either entry happened. Re-checking fresh after each epic closes that
  // race instead of just narrowing it.
  let livePositions = positions;
  let stockCount     = livePositions.filter(p => !isIndexEpic(p.epic)).length;
  let indexCount     = livePositions.filter(p => isIndexEpic(p.epic)).length;

  for (const epic of cfg.epics) {
    if (!st.running) break;
    const inPos = livePositions.find(p => p.epic === epic);
    const epicIsIndex = isIndexEpic(epic);
    const poolCount    = epicIsIndex ? indexCount : stockCount;
    const poolCap      = epicIsIndex ? cfg.maxIndexPositions : cfg.maxStockPositions;
    // gemini_opinion still evaluates flat candidates even when full — a
    // fresh idea here is what a full slot gets compared against for a
    // possible swap (see the position-rotation check in executeIgSignal).
    // Every other strategy keeps the original behaviour: skip entirely
    // when there's no room, since there's nothing to act on and no
    // comparison logic that would use the extra call anyway.
    if (!inPos && poolCount >= poolCap && cfg.strategy !== 'gemini_opinion') {
      addLog(mode, 'wait', epicName(epic), `Max ${epicIsIndex ? 'index' : 'stock'} positions (${poolCap}) reached`);
      continue;
    }
    await evaluateEpic(mode, epic, livePositions, cfg, st.session, available);
    try {
      livePositions = await fetchFullPositions(st.session);
      stockCount    = livePositions.filter(p => !isIndexEpic(p.epic)).length;
      indexCount    = livePositions.filter(p => isIndexEpic(p.epic)).length;
    } catch { /* keep the last known count on a fetch failure */ }

    // gemini_opinion makes one real Gemini call per epic here, with nothing
    // else between them — confirmed live this bursts back-to-back requests
    // close enough together (a few seconds apart, ~8 epics a cycle, plus
    // Gemini Position Watch's own calls landing in the same window) to trip
    // rate-limit-shaped failures (503s, request timeouts) that a lone call
    // wouldn't hit. A small gap here costs nothing against a 15min poll
    // interval but meaningfully de-bursts the request rate.
    if (cfg.strategy === 'gemini_opinion') await new Promise(r => setTimeout(r, 3_000));
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
    const best = await scanIgEpics(cfg.strategy, st.session, [...st.pausedEpics], cfg.maxStockPositions + cfg.maxIndexPositions + 2, msg => addLog(mode, 'info', '—', msg), cfg.maxIndexPositions);
    cfg.epics = best;
  } catch (e) {
    addLog(mode, 'info', '—', `Scan failed — using default indices: ${e instanceof Error ? e.message : String(e)}`);
    cfg.epics = ['IX.D.DOW.DAILY.IP', 'IX.D.NASDAQ.CASH.IP', 'IX.D.FTSE.DAILY.IP'];
  }

  if (cfg.strategy === 'orb') resetOrbState(mode, cfg.epics);
  scheduleSessionRefresh(mode, st.session);
  syncStreamSubscription(mode); // subscribe Lightstream now that cfg.epics is finalized (no-op unless strategy is donchian_hourly/gemini_opinion)

  addLog(mode, 'info', '—', `Bot started — ${STRATEGY_META[cfg.strategy].label} | ${mode} | ${cfg.epics.map(epicName).join(', ')}`);
  addLog(mode, 'info', '—', `Max risk/trade: £${cfg.maxRiskGbp} | Max positions: ${cfg.maxStockPositions} stocks + ${cfg.maxIndexPositions} indices | Shorts: ${cfg.allowShorts ? 'yes' : 'no'}`);

  // Startup just fired a burst of IG calls (auth + balance + up to
  // maxPositions+2 sequential candle fetches while scanning for instruments).
  // Hitting the API again immediately with poll()'s own balance/positions/
  // market-details calls was intermittently getting a 403 — give it a few
  // seconds to clear before the first real poll.
  st.pollTimer = setTimeout(() => { void poll(mode); }, 10_000);
  // Independent of the above — see runSevereLossGuard for why this needs
  // its own much tighter cadence than the main 15min poll.
  st.severeLossTimer = setInterval(() => { void runSevereLossGuard(mode); }, 30_000);
  return { ok: true };
}

export function stopIgStrategyBot(mode: IgMode): void {
  const st = ms(mode);
  st.running = false;
  st.paused  = false;
  if (st.pollTimer)           { clearTimeout(st.pollTimer);           st.pollTimer           = null; }
  if (st.severeLossTimer)     { clearInterval(st.severeLossTimer);    st.severeLossTimer     = null; }
  if (st.sessionRefreshTimer) { clearTimeout(st.sessionRefreshTimer); st.sessionRefreshTimer = null; }
  st.nextRunMs  = null;
  st.lastPollTs = null;
  st.stream.disconnect();
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

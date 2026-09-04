import * as fs from 'fs';
import * as path from 'path';
import {
  getAccount, getPositions, getBars, getLatestBars, placeOrder, closePosition, getOrders,
  cancelAllOrders, cancelOrdersForSymbol, isNYSEOpen, isInOpeningRange, isNearClose,
  sessionStartUtcMs,
  isDailyCheckTime, isWeeklyCheckTime, isWeekend, msUntilMondayOpen,
  selectOptionsContract, getOptionQuote,
  type AccountMode, type AlpacaPosition, type AlpacaBar,
} from './alpacaApi';
import { scanForBestSymbols } from './alpacaScanner';
import { recordJournalEvent } from './tradeJournal';
import { edgeSizing } from './quant';
import { hasImminentEarnings } from './earningsGuard';
import {
  rsiMeanReversionSignal, emaCrossoverSignal, orbSignal,
  vwapSignal, weeklyMomentumSignal, optionsDirectionalSignal, optionsNewsBasedEntrySignal,
  meanReversionSwingSignal,
  calcAtr, STRATEGY_META,
  type StrategyName, type StrategySignal,
} from './alpacaStrategies';
import { MAX_HOLD_DAYS as MR_SWING_MAX_HOLD_DAYS } from './meanReversionStrategy';
// Grok (xAI) is a live test as the acting decision-maker here as of
// 2026-08-25, paper-trading only (see xai.ts's own comment) — Gemini called
// only as a fallback when Grok's own attempt genuinely fails. Options
// positions specifically no longer use this path at all as of 2026-09-04 —
// see reviewOpenPositions and confirmOptionsEntryFinnhub below.
import { askAlpacaDailyVerdict, askAlpacaPositionVerdict } from './xai';
import { askGeminiPositionVerdict } from './gemini';
import { fetchAllHeadlines } from './newsFetch';
import { hasBreakingNews } from './alpacaNewsStream';
import { sentimentScore } from './momentumSignal';

// ── State persistence ─────────────────────────────────────────────────────────
// Survives a PM2 restart / crash: without this, a bot running when the process
// dies leaves open positions un-monitored until a human notices and restarts
// it by hand via the UI.

function stateFile(mode: AccountMode): string {
  return path.join(__dirname, '..', `alpaca-bot-state-${mode}.json`);
}
function saveAlpacaState(mode: AccountMode, cfg: AlpacaBotConfig): void {
  try { fs.writeFileSync(stateFile(mode), JSON.stringify(cfg), 'utf8'); } catch {}
}
function clearAlpacaState(mode: AccountMode): void {
  try { fs.unlinkSync(stateFile(mode)); } catch {}
}
export function loadSavedAlpacaState(mode: AccountMode): AlpacaBotConfig | null {
  try { return JSON.parse(fs.readFileSync(stateFile(mode), 'utf8')) as AlpacaBotConfig; } catch { return null; }
}

// ── High-conviction sizing (2026-08-24, explicit request) ──────────────────
// A deliberate exception to the normal $positionSizeUsd budget: when the
// *same* signal + Gemini pipeline every other entry already goes through
// rates a setup at genuinely top-tier confidence (90%+, i.e. Gemini's own
// "9-10/10"), size that one trade far larger — still through the exact same
// live-quote sizing and capped-limit execution every entry uses, just with a
// bigger budget when everything strongly agrees. Deliberately NOT a
// separate/manual path — same automatic pipeline, just gated by an
// unusually high bar, per explicit request ("guessing how it's picked now
// but just with 9/10-10/10 conviction"). Capped at one concurrent
// high-conviction position (across all symbols) so a good week can't
// compound into several large bets stacking risk at once.
const HIGH_CONVICTION_MIN_CONFIDENCE = 85;
const HIGH_CONVICTION_SIZE_USD       = 5_000;
// 45min/±$X-move throttle, same shape as geminiWatch.ts's own — a dedicated
// ongoing watch beyond the standard -50%/+75%/DTE exit rule, per explicit
// request ("gemini confirms and watches it"). Persisted so a PM2 restart
// doesn't lose track of which position this is and silently stop watching
// it — the position itself survives a restart fine either way (Alpaca is
// the source of truth), but this file is what tells the bot to give it the
// extra attention.
type HighConvictionEntry = { enteredAt: number; lastReviewAt: number; lastUpl: number };
function hcFile(mode: AccountMode): string {
  return path.join(__dirname, '..', `alpaca-high-conviction-${mode}.json`);
}
function loadHc(mode: AccountMode): Map<string, HighConvictionEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(hcFile(mode), 'utf8')) as Record<string, HighConvictionEntry>;
    return new Map(Object.entries(raw));
  } catch { return new Map(); }
}
function saveHc(mode: AccountMode, map: Map<string, HighConvictionEntry>): void {
  try { fs.writeFileSync(hcFile(mode), JSON.stringify(Object.fromEntries(map)), 'utf8'); } catch {}
}
const highConviction = new Map<AccountMode, Map<string, HighConvictionEntry>>([
  ['paper', loadHc('paper')],
  ['live',  loadHc('live')],
]);

// Peak P/L% per option position — feeds optionsDirectionalSignal's
// peak-and-retrace lock-in (see its own comment). Tracked separately from
// positionWatch's throttled state since this needs to update every single
// poll (the exit check runs on the main loop, before positionWatch's own
// pass later in the same cycle — using that map here would read stale data).
function peakFile(mode: AccountMode): string {
  return path.join(__dirname, '..', `alpaca-option-peaks-${mode}.json`);
}
function loadPeaks(mode: AccountMode): Map<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(peakFile(mode), 'utf8')) as Record<string, number>;
    return new Map(Object.entries(raw));
  } catch { return new Map(); }
}
function savePeaks(mode: AccountMode, map: Map<string, number>): void {
  try { fs.writeFileSync(peakFile(mode), JSON.stringify(Object.fromEntries(map)), 'utf8'); } catch {}
}
const optionPeaks = new Map<AccountMode, Map<string, number>>([
  ['paper', loadPeaks('paper')],
  ['live',  loadPeaks('live')],
]);

// Options buying-power cooldown — added 2026-09-04 per explicit request.
// Confirmed live: once the account's options buying power is fully
// committed to existing positions, EVERY subsequent symbol's entry attempt
// (headlines fetch, contract selection, live quote, and finally the order
// itself) still ran in full every single poll, only to fail at the very
// last step with the same "insufficient options buying power" 403 — pure
// wasted work every cycle until something closed. In-memory only (worst
// case after a restart is one more wasted attempt before it re-trips) —
// same tradeoff as this file's other in-memory-only trackers.
type OptionsBpState = { active: boolean; since: number; lastCount: number };
const optionsBpCooldown = new Map<AccountMode, OptionsBpState>([
  ['paper', { active: false, since: 0, lastCount: 0 }],
  ['live',  { active: false, since: 0, lastCount: 0 }],
]);
const OPTIONS_BP_COOLDOWN_BACKSTOP_MS = 2 * 3_600_000; // self-clears after 2h even if the position-count check somehow misses a close

// Entry timestamp per symbol for the mean_reversion_swing strategy — the
// pure meanReversionSwingSignal function isn't given a position's age (it
// only sees bars), so this is what lets the original strategy's
// MAX_HOLD_DAYS backstop actually work here. Same minimal
// Map<symbol, timestamp>-persisted-as-JSON shape as optionPeaks above.
function mrEnteredFile(mode: AccountMode): string {
  return path.join(__dirname, '..', `alpaca-mr-entered-${mode}.json`);
}
function loadMrEntered(mode: AccountMode): Map<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(mrEnteredFile(mode), 'utf8')) as Record<string, number>;
    return new Map(Object.entries(raw));
  } catch { return new Map(); }
}
function saveMrEntered(mode: AccountMode, map: Map<string, number>): void {
  try { fs.writeFileSync(mrEnteredFile(mode), JSON.stringify(Object.fromEntries(map)), 'utf8'); } catch {}
}
const mrEntered = new Map<AccountMode, Map<string, number>>([
  ['paper', loadMrEntered('paper')],
  ['live',  loadMrEntered('live')],
]);

// ── Types ─────────────────────────────────────────────────────────────────────

export type AlpacaBotConfig = {
  mode:             AccountMode;
  strategy:         StrategyName;
  symbols:          string[];   // populated by scanner — do not set manually
  positionSizeUsd:  number;
  maxPositions:     number;
  allowShorts:      boolean;
  allow24h:         boolean;    // skip NYSE hours gate — trade Mon-Fri around the clock
  maxDailyLossPct?: number;     // circuit breaker: no new entries after equity drops this % from day start (default 3)
};

export type AlpacaLogEntry = {
  id:     string;
  ts:     string;
  type:   'info' | 'enter' | 'exit' | 'wait' | 'error';
  symbol: string;
  msg:    string;
};

export type AlpacaBotStatus = {
  running:     boolean;
  paused:      boolean;
  mode:        AccountMode;
  strategy:    StrategyName;
  symbols:     string[];
  equity:      string;
  cash:        string;
  positions:   AlpacaPosition[];
  log:         AlpacaLogEntry[];
  nextRunMs:   number | null;
  orbState:    Record<string, OrbState>;
  lastPollTs:  string | null;
  lossLock:    boolean;   // daily-loss circuit breaker engaged
  // Latest AI watch verdict per symbol currently held, if it's been
  // reviewed at least once — see reviewOpenPositions/getPositionWatchStatus.
  positionWatch: Record<string, { enabled: boolean; lastVerdict?: { action: string; confidence: number; reason: string; engine: string; at: number } }>;
};

// tradedLong/tradedShort: one breakout entry per direction per day — without
// this the bot re-enters every poll while price sits beyond the range
type OrbState = { high: number; low: number; established: boolean; tradedLong?: boolean; tradedShort?: boolean };

// ── Per-mode state ────────────────────────────────────────────────────────────

type ModeState = {
  running:    boolean;
  paused:     boolean;
  config:     AlpacaBotConfig | null;
  log:        AlpacaLogEntry[];
  pollTimer:  ReturnType<typeof setTimeout> | null;
  nextRunMs:  number | null;
  lastPollTs: string | null;
  orbState:   Record<string, OrbState>;
  // Daily-loss circuit breaker
  dayKey:         string;   // UTC date the equity baseline belongs to
  dayStartEquity: number;
  lossLock:       boolean;  // true = no new entries until the next trading day
};

function makeModeState(): ModeState {
  return {
    running: false, paused: false, config: null,
    log: [], pollTimer: null, nextRunMs: null, lastPollTs: null,
    orbState: {},
    dayKey: '', dayStartEquity: 0, lossLock: false,
  };
}

const modeStates = new Map<AccountMode, ModeState>([
  ['paper', makeModeState()],
  ['live',  makeModeState()],
]);

function s(mode: AccountMode): ModeState {
  return modeStates.get(mode)!;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 8); }
function now() { return new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Europe/London' }); }
function round2(v: number) { return Math.round(v * 100) / 100; }

// OCC option symbol: underlying + YYMMDD + C/P + 8-digit strike, e.g.
// GOOGL260828P00245000. Stocks never match this shape.
const OCC_SYMBOL_RE = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
function isOptionSymbol(sym: string): boolean { return OCC_SYMBOL_RE.test(sym); }

// cfg.symbols holds underlying tickers ("PLTR"), but options_directional's
// open positions live under the OCC contract symbol ("PLTR260828P00127000")
// — an exact-match lookup never finds them. Confirmed live: this silently
// broke the whole position-cap gate below once the account filled up, since
// every held options underlying looked position-less and got skipped before
// evaluateSymbol ever ran its exit check, leaving losing contracts stuck
// open indefinitely with no further evaluation at all.
function findPositionFor(positions: AlpacaPosition[], underlying: string): AlpacaPosition | undefined {
  return positions.find(p => p.symbol === underlying || new RegExp(`^${underlying}\\d{6}[CP]`).test(p.symbol));
}

// Ongoing AI watch for every open position, not just the high-conviction
// one — extended 2026-08-24 per explicit request ("is there a position
// watch on these stocks... add it"). Same throttle shape as geminiWatch.ts's
// IG-side watch ($X move or 45min silence, whichever first). Runs alongside,
// not instead of, the normal -50%/+75%/DTE exit rule already checked every
// poll — this can close a position earlier on a real thesis change; the
// mechanical rule is still the hard backstop if this misses something or
// Gemini's unavailable. Positions with a genuinely dead market (no live
// price — see the GLD/PLTR/GOOGL saga) are skipped: there's no live level
// for Gemini to reason about and nothing it could do differently from just
// waiting for expiry anyway.
const WATCH_MOVE_THRESHOLD_USD = 150;
const WATCH_MAX_SILENCE_MS     = 45 * 60_000;
type WatchEntry = {
  enteredAt: number; lastReviewAt: number; lastUpl: number;
  enabled:   boolean;  // per-position on/off toggle, mirroring the IG bot's own Watch button — defaults on, user can turn it off per symbol
  lastVerdict?: { action: string; confidence: number; reason: string; engine: string; at: number };
};
function watchFile(mode: AccountMode): string {
  return path.join(__dirname, '..', `alpaca-position-watch-${mode}.json`);
}
function loadWatch(mode: AccountMode): Map<string, WatchEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(watchFile(mode), 'utf8')) as Record<string, WatchEntry>;
    // `enabled` was added after this file format existed — a pre-existing
    // entry saved before that has it as undefined, and `!tracked.enabled`
    // in reviewOpenPositions reads that as "disabled", silently dropping an
    // already-watched position out of review on the next restart. Default
    // it to true (the field's own intended default) rather than let a
    // missing key flip the meaning.
    return new Map(Object.entries(raw).map(([symbol, entry]) => [symbol, { ...entry, enabled: entry.enabled ?? true }]));
  } catch { return new Map(); }
}
function saveWatch(mode: AccountMode, map: Map<string, WatchEntry>): void {
  try { fs.writeFileSync(watchFile(mode), JSON.stringify(Object.fromEntries(map)), 'utf8'); } catch {}
}
const positionWatch = new Map<AccountMode, Map<string, WatchEntry>>([
  ['paper', loadWatch('paper')],
  ['live',  loadWatch('live')],
]);

// UI-facing snapshot — see /alpaca/:mode/status in index.ts.
export function getPositionWatchStatus(mode: AccountMode): Record<string, { enabled: boolean; lastVerdict?: WatchEntry['lastVerdict'] }> {
  const out: Record<string, { enabled: boolean; lastVerdict?: WatchEntry['lastVerdict'] }> = {};
  for (const [symbol, entry] of positionWatch.get(mode) ?? []) {
    out[symbol] = { enabled: entry.enabled, lastVerdict: entry.lastVerdict };
  }
  return out;
}

// Per-position on/off — mirrors the IG bot's Watch button (POST enables,
// DELETE disables). Alpaca defaults every position to watched (per explicit
// request to cover everything, not just the rare high-conviction trade),
// so this is a mute switch, not an opt-in — the position still keeps
// getting created in the map (with enabled:true) the first time it's seen;
// this only ever flips the flag on an already-known symbol.
export function setPositionWatchEnabled(mode: AccountMode, symbol: string, enabled: boolean): { ok: boolean; error?: string } {
  const map = positionWatch.get(mode)!;
  const entry = map.get(symbol);
  if (!entry) return { ok: false, error: 'Position not found or not yet tracked — it will be watched automatically once seen' };
  entry.enabled = enabled;
  saveWatch(mode, map);
  return { ok: true };
}

async function reviewOpenPositions(mode: AccountMode, cfg: AlpacaBotConfig, positions: AlpacaPosition[]): Promise<void> {
  const watchMap = positionWatch.get(mode)!;
  const hcMap    = highConviction.get(mode)!;
  const liveSymbols = new Set(positions.map(p => p.symbol));

  // Drop anything no longer held — closed elsewhere (normal exit rule).
  let changed = false;
  for (const symbol of [...watchMap.keys()]) {
    if (!liveSymbols.has(symbol)) { watchMap.delete(symbol); changed = true; }
  }

  for (const pos of positions) {
    const symbol = pos.symbol;
    // Dead market — no live price to reason about (see isOptionSymbol's own
    // GLD/PLTR/GOOGL history). Nothing actionable, so don't spend a call.
    if (parseFloat(pos.current_price) === 0 && parseFloat(pos.market_value) === 0) continue;

    let tracked = watchMap.get(symbol);
    if (!tracked) {
      tracked = { enteredAt: Date.now(), lastReviewAt: 0, lastUpl: 0, enabled: true };
      watchMap.set(symbol, tracked);
      changed = true;
    }
    if (!tracked.enabled) continue;

    const upl = parseFloat(pos.unrealized_pl) || 0;
    const moved = Math.abs(upl - tracked.lastUpl) >= WATCH_MOVE_THRESHOLD_USD;
    const stale = Date.now() - tracked.lastReviewAt >= WATCH_MAX_SILENCE_MS;
    if (!moved && !stale) continue;

    tracked.lastUpl = upl;
    tracked.lastReviewAt = Date.now();
    changed = true;

    const isOption = isOptionSymbol(symbol);
    const underlying = isOption ? symbol.replace(/\d{6}[CP]\d{8}$/, '') : symbol;
    let headlines: string[] = [];
    try { headlines = await fetchAllHeadlines(underlying, 5); } catch {}
    const watchReq = {
      instrumentName:  symbol,
      direction:       (pos.side === 'long' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
      entryLevel:      parseFloat(pos.avg_entry_price) || 0,
      currentLevel:    parseFloat(pos.current_price) || 0,
      uplGbp:          upl,
      currency:        '$',
      heldHours:       (Date.now() - tracked.enteredAt) / 3_600_000,
      headlines,
    };
    // Options positions watch via Gemini directly, no Grok call first — per
    // explicit request 2026-09-04 to drop xAI entirely from the options bot.
    // Every other Alpaca position keeps the existing Grok-acting/Gemini-
    // fallback path (askAlpacaPositionVerdict) unchanged.
    const verdict = isOption
      ? await askGeminiPositionVerdict(watchReq)
      : await askAlpacaPositionVerdict(watchReq);
    const isHc = hcMap.has(symbol);
    tracked.lastVerdict = { action: verdict.action, confidence: verdict.confidence, reason: verdict.reason, engine: verdict.engine, at: Date.now() };
    addLog(mode, 'info', underlying, `${isHc ? '[HIGH CONVICTION WATCH]' : '[POSITION WATCH]'} ${verdict.action} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);

    if (verdict.action === 'CLOSE' && verdict.engine === 'gemini') {
      await executeSignal(mode, symbol, { action: 'CLOSE_LONG', reason: `[Position watch] ${verdict.reason}` }, pos, cfg);
      watchMap.delete(symbol);
      if (isHc) { hcMap.delete(symbol); saveHc(mode, hcMap); }
    }
  }
  if (changed) saveWatch(mode, watchMap);
}

// ── Pre-entry Gemini + news gate ────────────────────────────────────────────
// Every strategy here (RSI mean-reversion, EMA crossover, ORB, VWAP, weekly
// momentum, options directional) is pure price/indicator math — none of them
// know a headline exists. Confirmed live this is a real gap, not a
// theoretical one: the options bot bought a PUT on GOOGL (RSI-overbought +
// MACD rolling over) at the exact moment GOOGL was breaking out on genuine
// bullish news (a Google-Marvell AI chip deal) — the same blind spot that
// separately caused repeat losing shorts on the IG side, fixed there by
// requiring Gemini confirmation before entry. This is that same fix for the
// Alpaca bot, applied to every entry rather than gated per-instrument, per
// explicit request. Fails closed (skips the trade) on any Gemini outage or
// missing key, same discipline as the IG bot's own gate — an unconfirmed
// entry is worse than a missed one.
async function confirmEntryWithNews(
  mode:      AccountMode,
  sym:       string,
  direction: 'BUY' | 'SELL',   // BUY = bullish thesis (long call or long stock), SELL = bearish (long put or short stock)
  price:     number,
  strategyReason: string,
  strength?: number,
): Promise<{ ok: boolean; reason: string; confidence: number }> {
  let headlines: string[] = [];
  try { headlines = await fetchAllHeadlines(sym, 5); } catch {}
  const breaking = hasBreakingNews(sym);

  const verdict = await askAlpacaDailyVerdict({
    instrumentName: sym,
    direction,
    strength:       strength ?? 60,
    price,
    changePercent:  0,  // not tracked at this layer — direction check doesn't depend on it
    stopPoints:     price * 0.25,  // placeholder R:R framing only — real stop/TP for options is a % of premium, not points
    tpPoints:       price * 0.5,
    headlines: breaking ? [`[BREAKING — flagged by real-time news stream in the last 30min]`, ...headlines] : headlines,
  });

  addLog(mode, 'info', sym, `[AI] ${verdict.direction} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine}) | signal: ${strategyReason}`);

  // Reason text below is user/log-facing, so it names the real engine that
  // answered rather than a hardcoded "Gemini" — confirmed live 2026-08-25
  // this file still said "Gemini vetoed"/"Gemini unavailable" even after
  // Alpaca moved to Grok-acting (askAlpacaDailyVerdict, ./xai), which made
  // every real Grok veto/outage look like a Gemini one in the UI.
  if (verdict.engine === 'passthrough') {
    return { ok: false, reason: `AI unavailable (${verdict.reason}) — skipping entry rather than trading unconfirmed`, confidence: 0 };
  }
  if (verdict.direction === 'SKIP' || verdict.confidence < 50) {
    return { ok: false, reason: `${verdict.engine} vetoed — ${verdict.direction} ${verdict.confidence}%: ${verdict.reason}`, confidence: verdict.confidence };
  }
  if (verdict.direction !== direction) {
    return { ok: false, reason: `${verdict.engine} disagreed on direction (wanted ${verdict.direction}, signal was ${direction}) — ${verdict.reason}`, confidence: verdict.confidence };
  }
  return { ok: true, reason: verdict.reason, confidence: verdict.confidence };
}

// Options-only entry gate — deliberately NOT an AI call. Replaced
// confirmEntryWithNews (Grok/Gemini) here 2026-09-04 per explicit request
// ("drop the xai completely... score Finnhub headlines directly") after the
// options bot was burning through AI usage without much to show for it.
// Scores the same Finnhub+Finviz headlines optionsNewsBasedEntrySignal
// already fetched for the technical signal itself (see the options_directional
// case below — reused, not re-fetched) via sentimentScore's existing
// bull/bear keyword count, same source this whole codebase already trusts
// for a "does the news actually support this direction" veto elsewhere.
// No headlines at all is NOT a veto — same "proceed on the technical signal
// alone" default confirmEntryWithNews's own callers get when Finnhub simply
// has nothing on a name — but thin evidence (0-1 sentiment-bearing
// headlines) caps confidence well below the high-conviction sizing bar so a
// single ambiguous headline can't alone trigger the $5,000 tier.
function confirmOptionsEntryFinnhub(
  direction: 'BUY' | 'SELL', headlines: string[],
): { ok: boolean; reason: string; confidence: number } {
  if (headlines.length === 0) {
    return { ok: true, reason: 'No Finnhub/Finviz headlines found — no news veto, proceeding on the technical signal alone', confidence: 50 };
  }
  const { score, bull, bear } = sentimentScore(headlines);
  const evidence = bull + bear;
  let confidence = Math.round(50 + score * 40);
  confidence = Math.max(5, Math.min(95, confidence));
  if (evidence < 2) confidence = Math.min(confidence, 60);

  if (direction === 'BUY' && score < -0.3) {
    return { ok: false, reason: `Headlines lean bearish (${bull} bullish/${bear} bearish, score ${score.toFixed(2)}) — skipping the call`, confidence };
  }
  if (direction === 'SELL' && score > 0.3) {
    return { ok: false, reason: `Headlines lean bullish (${bull} bullish/${bear} bearish, score ${score.toFixed(2)}) — skipping the put`, confidence };
  }
  return { ok: true, reason: `Headlines ${bull} bullish/${bear} bearish, net score ${score.toFixed(2)} — supports the ${direction === 'BUY' ? 'call' : 'put'}`, confidence };
}

// Deterministic per-decision order ID. Stable across a retry of the *same*
// poll's decision (so a resend dedupes at Alpaca instead of double-filling),
// but changes every poll cycle (so a genuine new signal later isn't blocked).
function makeClientOrderId(mode: AccountMode, sym: string, action: string, pollTs: string | null): string {
  const bucket = (pollTs ?? new Date().toISOString()).replace(/[^0-9]/g, '');
  return `bot-${mode}-${sym}-${action}-${bucket}`.slice(0, 128);
}

// Flat dollar sizing ignores volatility — a $500 clip in a calm ETF and a
// $500 clip in a high-ATR momentum name carry very different real risk. Scale
// against a 2% ATR baseline (matches lib/risk.ts's flat-vol fallback) and
// clamp so a single low/high-vol symbol can't swing size more than 1.5x/0.5x.
const BASELINE_ATR_PCT = 2;
function sizeMultiplierFromAtr(bars: AlpacaBar[]): number {
  const atr   = calcAtr(bars);
  const price = bars[bars.length - 1]?.c;
  if (!atr || !price || price <= 0) return 1;
  const atrPct = (atr / price) * 100;
  if (atrPct <= 0) return 1;
  return Math.min(1.5, Math.max(0.5, BASELINE_ATR_PCT / atrPct));
}

function addLog(mode: AccountMode, type: AlpacaLogEntry['type'], symbol: string, msg: string) {
  const st    = s(mode);
  const entry: AlpacaLogEntry = { id: uid(), ts: now(), type, symbol, msg };
  st.log.unshift(entry);
  if (st.log.length > 400) st.log.splice(400);
  const level = type === 'error' ? 'error' : 'log';
  console[level](`[alpaca:${mode}] [${entry.ts}] [${type.toUpperCase()}] [${symbol}] ${msg}`);
}

// ── ORB range builder ─────────────────────────────────────────────────────────

function resetOrbState(mode: AccountMode, symbols: string[]) {
  const st = s(mode);
  for (const sym of symbols) {
    st.orbState[sym] = { high: 0, low: 0, established: false };
  }
}

async function buildOrbRange(mode: AccountMode, symbols: string[]) {
  addLog(mode, 'info', '—', 'Building Opening Range (first 30 min)…');
  try {
    const barsMap = await getBars(symbols, '1Min', 60, mode);
    const st      = s(mode);
    const sessionStart = sessionStartUtcMs();
    for (const sym of symbols) {
      const bars    = barsMap[sym] ?? [];
      if (!bars.length) continue;
      // Only bars inside the 30-min opening window — slice(-30) could include
      // pre-market or the previous session's bars
      const windowBars = bars.filter(b => {
        const t = new Date(b.t).getTime();
        return t >= sessionStart && t < sessionStart + 30 * 60_000;
      });
      const orbBars = windowBars.length ? windowBars : bars.slice(-30);
      const high    = Math.max(...orbBars.map(b => b.h));
      const low     = Math.min(...orbBars.map(b => b.l));
      st.orbState[sym] = { high, low, established: true };
      addLog(mode, 'info', sym, `ORB established: ${low.toFixed(2)}–${high.toFixed(2)}`);
    }
  } catch (e) {
    addLog(mode, 'error', '—', `ORB build failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Signal dispatch ───────────────────────────────────────────────────────────

// Returns true when a new position was opened.
async function evaluateSymbol(
  mode:      AccountMode,
  sym:       string,
  positions: AlpacaPosition[],
  cfg:       AlpacaBotConfig,
): Promise<boolean> {
  const openPos    = positions.find(p => p.symbol === sym);
  const inPosition = !!openPos;
  const side       = openPos?.side;
  const meta       = STRATEGY_META[cfg.strategy];

  let bars;
  try {
    const barsMap = await getBars([sym], meta.barPeriod, meta.barsNeeded, mode);
    bars = barsMap[sym] ?? [];
  } catch (e) {
    addLog(mode, 'error', sym, `Failed to fetch bars: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }

  if (!bars.length) {
    addLog(mode, 'wait', sym, 'No bar data returned');
    return false;
  }

  let signal: StrategySignal;
  const st = s(mode);
  // Approximate — computed on whatever bar resolution this strategy already
  // fetches for its own signal, so magnitude varies by strategy. Only used as
  // a soft ±50% adjustment around the configured position size, not a hard risk cap.
  let sizeMult = sizeMultiplierFromAtr(bars);

  // Real-track-record sizing on top of the volatility adjustment above —
  // scales toward what this exact strategy's own closed-trade history
  // supports rather than sizing purely off this one trade's signal/Gemini
  // confidence. Neutral until there's a real sample; see quant.ts for why
  // the history is filtered to post-rewrite trades only.
  const edge = edgeSizing(mode, cfg.strategy);
  if (edge.skip) {
    addLog(mode, 'wait', sym, `Skipped — ${edge.reason}`);
    return false;
  }
  if (edge.multiplier !== 1) {
    addLog(mode, 'info', sym, edge.reason);
    sizeMult *= edge.multiplier;
  }

  switch (cfg.strategy) {
    case 'rsi_mean_reversion':
      signal = rsiMeanReversionSignal(bars, inPosition, side);
      break;

    case 'ema_crossover':
      signal = emaCrossoverSignal(bars, inPosition, side);
      break;

    case 'orb': {
      const orb = st.orbState[sym] ?? { high: 0, low: 0, established: false };
      if (!orb.established) {
        addLog(mode, 'wait', sym, 'ORB not established yet');
        return false;
      }
      const latestBars = await getLatestBars([sym], mode).catch(() => ({} as Record<string, typeof bars[0]>));
      const price      = latestBars[sym]?.c ?? bars[bars.length - 1].c;
      signal = orbSignal(orb.high, orb.low, price, inPosition, side);
      // One breakout trade per direction per day
      if (signal.action === 'BUY'  && orb.tradedLong)  { addLog(mode, 'wait', sym, 'ORB long already traded today'); return false; }
      if (signal.action === 'SELL' && orb.tradedShort) { addLog(mode, 'wait', sym, 'ORB short already traded today'); return false; }
      const opened = await executeSignal(mode, sym, signal, openPos ?? null, cfg, price, sizeMult);
      if (opened && signal.action === 'BUY')  orb.tradedLong  = true;
      if (opened && signal.action === 'SELL') orb.tradedShort = true;
      return opened;
    }

    case 'vwap': {
      const latestBars = await getLatestBars([sym], mode).catch(() => ({} as Record<string, typeof bars[0]>));
      const price      = latestBars[sym]?.c ?? bars[bars.length - 1].c;
      // Anchor VWAP to today's session — a rolling-60-min VWAP is a different
      // (noisier) reference. Overnight/24-5 mode falls back to the rolling window.
      const sessionStart = sessionStartUtcMs();
      const sessionBars  = bars.filter(b => new Date(b.t).getTime() >= sessionStart);
      signal = vwapSignal(sessionBars.length >= 5 ? sessionBars : bars, price, inPosition, side);
      break;
    }

    case 'weekly_momentum': {
      let dailyBars: import('./alpacaApi').AlpacaBar[] = [];
      try {
        const daily = await getBars([sym], '1Day', 30, mode);
        dailyBars = daily[sym] ?? [];
      } catch {
        dailyBars = [];
      }
      signal = weeklyMomentumSignal(bars, dailyBars, inPosition, side);
      break;
    }

    // Self-contained (like options_directional below), not a fall-through to
    // the shared tail — needs to track/check position entry time for the
    // MAX_HOLD_DAYS backstop (see mrEntered's own comment), which the shared
    // tail below has no hook for.
    case 'mean_reversion_swing': {
      if (inPosition) {
        const map = mrEntered.get(mode)!;
        const entered = map.get(sym);
        const heldDays = entered ? (Date.now() - entered) / 86_400_000 : 0;
        if (entered && heldDays >= MR_SWING_MAX_HOLD_DAYS) {
          const exitSig: StrategySignal = {
            action: side === 'long' ? 'CLOSE_LONG' : 'CLOSE_SHORT',
            reason: `Max hold reached (${heldDays.toFixed(1)}d) — same backstop as the original strategy`,
          };
          const closed = await executeSignal(mode, sym, exitSig, openPos ?? null, cfg);
          if (closed) { map.delete(sym); saveMrEntered(mode, map); }
          return false;
        }
        addLog(mode, 'wait', sym, entered ? `Held ${heldDays.toFixed(1)}d — stop/TP live as bracket legs` : 'In position — stop/TP live as bracket legs');
        return false;
      }
      const mrSig = meanReversionSwingSignal(bars);
      if (mrSig.action !== 'BUY' && mrSig.action !== 'SELL') { addLog(mode, 'wait', sym, mrSig.reason); return false; }
      const entryPrice = bars[bars.length - 1].c;
      const confirm = await confirmEntryWithNews(mode, sym, mrSig.action, entryPrice, mrSig.reason);
      if (!confirm.ok) { addLog(mode, 'wait', sym, `[AI] ${confirm.reason}`); return false; }
      const opened = await executeSignal(mode, sym, mrSig, null, cfg, entryPrice, sizeMult);
      if (opened) { mrEntered.get(mode)!.set(sym, Date.now()); saveMrEntered(mode, mrEntered.get(mode)!); }
      return opened;
    }

    case 'options_directional': {
      // Check for an existing options position on this underlying (OCC symbols start with underlying ticker)
      const occRegex = new RegExp(`^${sym}\\d{6}[CP]`);
      const optPos   = positions.find(p => occRegex.test(p.symbol));

      if (optPos) {
        // We hold an options contract — evaluate exit conditions
        const plPct  = parseFloat(optPos.unrealized_plpc) * 100;
        const yymmdd = optPos.symbol.slice(sym.length, sym.length + 6);
        const expiry = new Date(`20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`);
        const dte    = Math.ceil((expiry.getTime() - Date.now()) / 86_400_000);

        const peaks = optionPeaks.get(mode)!;
        const peak  = Math.max(peaks.get(optPos.symbol) ?? plPct, plPct);
        peaks.set(optPos.symbol, peak);
        savePeaks(mode, peaks);

        const exitSig = optionsDirectionalSignal(bars, true, plPct, dte, peak);
        if (exitSig.action !== 'HOLD') {
          await executeSignal(mode, optPos.symbol, exitSig, optPos, cfg);
          peaks.delete(optPos.symbol);
          savePeaks(mode, peaks);
        } else {
          addLog(mode, 'wait', sym, exitSig.reason);
        }
        return false;
      }

      // No position — check entry. Rewritten 2026-09-04 per explicit
      // request to use the same news-based approaches proven elsewhere in
      // this account (short-horizon momentum, long-horizon trend+news)
      // instead of the pure-technical EMA/RSI/MACD read — see
      // optionsNewsBasedEntrySignal's own comment. optionsDirectionalSignal
      // itself is untouched and still used below for exits.
      //
      // Buying-power cooldown gate — see optionsBpCooldown's own comment.
      // Tracks the open option-position count on every call regardless of
      // whether the cooldown is active; a real decrease (a position closing,
      // freeing margin) clears it automatically. Placed here, before the
      // headlines fetch/contract lookup/quote fetch below, so a tripped
      // cooldown skips ALL of that per-symbol work, not just the final order
      // placement that would fail anyway.
      const bp = optionsBpCooldown.get(mode)!;
      const currentOptionCount = positions.filter(p => isOptionSymbol(p.symbol)).length;
      if (bp.active && currentOptionCount < bp.lastCount) {
        bp.active = false;
        addLog(mode, 'info', sym, `Options buying power cooldown cleared — a position closed (${bp.lastCount} → ${currentOptionCount} open)`);
      }
      bp.lastCount = currentOptionCount;
      if (bp.active) {
        if (Date.now() - bp.since > OPTIONS_BP_COOLDOWN_BACKSTOP_MS) {
          bp.active = false;
          addLog(mode, 'info', sym, `Options buying power cooldown expired after ${(OPTIONS_BP_COOLDOWN_BACKSTOP_MS / 3_600_000).toFixed(0)}h backstop — retrying entries`);
        } else {
          addLog(mode, 'wait', sym, 'Skipping entry — options buying power exhausted, waiting for a position to close');
          return false;
        }
      }

      let entryHeadlines: string[] = [];
      try { entryHeadlines = await fetchAllHeadlines(sym, 8); } catch { /* prompt/scoring handles empty */ }
      const entrySig = optionsNewsBasedEntrySignal(bars, entryHeadlines);
      if (entrySig.action === 'BUY') {
        const currentPrice = bars[bars.length - 1].c;
        const optType      = entrySig.optionType ?? 'call';

        // No AI call — see confirmOptionsEntryFinnhub's own comment. Reuses
        // entryHeadlines already fetched above for the signal itself.
        const confirm = confirmOptionsEntryFinnhub(optType === 'call' ? 'BUY' : 'SELL', entryHeadlines);
        addLog(mode, 'info', sym, `[Finnhub] ${confirm.confidence}% — ${confirm.reason}`);
        if (!confirm.ok) {
          addLog(mode, 'wait', sym, `[Finnhub] ${confirm.reason}`);
          return false;
        }

        const contract     = await selectOptionsContract(sym, optType, currentPrice, mode);
        if (!contract) {
          addLog(mode, 'wait', sym, `No tradable ATM ${optType} contract found`);
          return false;
        }
        // contract.close_price is yesterday's close — sizing off it on an
        // illiquid contract that's since moved badly undershoots the real
        // cost (confirmed live: a $500 budget filled at $4,000+ once actual
        // fill price came in far above that stale number). No live quote
        // means no reliable way to size or bound the fill, so skip rather
        // than guess — same liquidity gap that also makes these contracts
        // hard to close later.
        const quote = await getOptionQuote(contract.symbol, mode);
        if (!quote) {
          addLog(mode, 'wait', sym, `No live quote for ${contract.symbol} — skipping (too illiquid to size safely)`);
          return false;
        }
        const contractPrice = quote.ask;
        const hcMap = highConviction.get(mode)!;
        const isHighConviction = confirm.confidence >= HIGH_CONVICTION_MIN_CONFIDENCE && hcMap.size === 0;
        const budgetUsd = isHighConviction ? HIGH_CONVICTION_SIZE_USD : cfg.positionSizeUsd;
        const qty = Math.max(1, Math.floor((budgetUsd * sizeMult) / (contractPrice * 100)));
        entrySig.optionContract = contract.symbol;
        entrySig.optionQty      = qty;
        if (isHighConviction) {
          addLog(mode, 'enter', sym, `🌟 HIGH CONVICTION (AI ${confirm.confidence}%) — sizing to $${budgetUsd} instead of the usual $${cfg.positionSizeUsd}`);
        }
        const opened = await executeSignal(mode, sym, entrySig, null, cfg, contractPrice);
        if (opened && isHighConviction) {
          hcMap.set(contract.symbol, { enteredAt: Date.now(), lastReviewAt: 0, lastUpl: 0 });
          saveHc(mode, hcMap);
        }
        return opened;
      }
      addLog(mode, 'wait', sym, entrySig.reason);
      return false;
    }

    default:
      return false;
  }

  const entryPrice = bars[bars.length - 1].c;
  if (signal.action === 'BUY' || signal.action === 'SELL') {
    const confirm = await confirmEntryWithNews(mode, sym, signal.action, entryPrice, signal.reason, signal.confidence);
    if (!confirm.ok) {
      addLog(mode, 'wait', sym, `[AI] ${confirm.reason}`);
      return false;
    }
  }
  return executeSignal(mode, sym, signal, openPos ?? null, cfg, entryPrice, sizeMult);
}

// ── Order execution ───────────────────────────────────────────────────────────

// Returns true when a NEW position was opened (used to enforce maxPositions).
async function executeSignal(
  mode:         AccountMode,
  sym:          string,
  signal:       StrategySignal,
  openPos:      AlpacaPosition | null,
  cfg:          AlpacaBotConfig,
  currentPrice?: number,
  sizeMult:     number = 1,
): Promise<boolean> {
  const { action, reason, stopPrice, takeProfitPrice, trailPercent, orderType } = signal;
  const st = s(mode);

  if (action === 'HOLD') {
    addLog(mode, 'wait', sym, reason);
    return false;
  }

  if (action === 'CLOSE_LONG' || action === 'CLOSE_SHORT') {
    if (!openPos) return false;

    // Options on a dead/no-bid contract: confirmed live this was looping
    // forever — cancel the resting $0.01 close order, place an identical
    // one, repeat every ~5min, because nothing ever bids even a cent for
    // a contract nobody's quoting. Checked *before* the "Closing position"
    // log line below, not after — confirmed live that ordering was its own
    // separate confusion: even once the actual re-submit was skipped, this
    // path still printed a fresh "Closing position — Stop loss hit" every
    // cycle, which reads as a new close attempt happening when nothing new
    // is happening at all. If an order from an earlier attempt is still
    // resting, skip the whole sequence — including this log line and the
    // journal write — rather than re-announcing the same unresolved state
    // every 5 minutes. It'll fill if a real bid ever shows up, or the
    // contract just expires worthless on its own, which costs nothing extra.
    if (isOptionSymbol(sym)) {
      const stillPending = await getOrders(mode, 'open').then(os => os.some(o => o.symbol === sym)).catch(() => false);
      if (stillPending) {
        addLog(mode, 'wait', sym, 'Close order already pending from an earlier attempt — leaving it, not re-submitting');
        return false;
      }
    }

    addLog(mode, 'exit', sym, `Closing position — ${reason}`);
    try {
      // Cancel bracket legs / stops first — Alpaca rejects a close while
      // shares are held for open orders, and orphaned GTC stops would later
      // fill into an unwanted reverse position.
      const cancelled = await cancelOrdersForSymbol(mode, sym).catch(() => 0);
      if (cancelled) addLog(mode, 'info', sym, `Cancelled ${cancelled} open order(s) before close`);
      // Options: closePosition's market-order liquidation gets rejected on
      // thin/illiquid contracts ("no available quote for symbol, please
      // reenter with a limit") — confirmed live this leaves losing positions
      // stuck open with no way to exit. A marketable limit (well under the
      // last known price, so it fills against whatever bid actually exists
      // rather than requiring one at market) sidesteps that rejection; a
      // plain stock close still uses the simpler market DELETE.
      if (isOptionSymbol(sym)) {
        const qty         = Math.abs(parseFloat(openPos.qty)) || 0;
        const lastPrice   = parseFloat(openPos.current_price) || 0;
        const limitPrice  = Math.max(0.01, round2(lastPrice * 0.5));
        await placeOrder(mode, {
          symbol: sym, qty, side: 'sell', type: 'limit',
          time_in_force: 'day', limit_price: limitPrice,
        });
        addLog(mode, 'exit', sym, `Close order placed — limit sell @ ${limitPrice} (last known ${lastPrice})`);
      } else {
        await closePosition(mode, sym);
        addLog(mode, 'exit', sym, 'Position closed');
      }

      recordJournalEvent({
        mode, event: 'exit', symbol: sym, strategy: cfg.strategy,
        side:  openPos.side,
        qty:   Math.abs(parseFloat(openPos.qty) || 0),
        price: parseFloat(openPos.current_price) || 0,
        reason,
        plUsd: parseFloat(openPos.unrealized_pl) || 0,
        plPct: (parseFloat(openPos.unrealized_plpc) || 0) * 100,
      });

      // Find replacement symbol for the freed slot
      void (async () => {
        try {
          const current = st.config?.symbols ?? [];
          const held    = (await getPositions(mode)).map(p => p.symbol);
          const exclude = [...new Set([...current, ...held])].filter(s => s !== sym);
          const picks   = await scanForBestSymbols(
            cfg.strategy, mode, exclude, 1,
            msg => addLog(mode, 'info', '—', msg),
          );
          if (picks[0] && st.config) {
            const idx = st.config.symbols.indexOf(sym);
            if (idx !== -1) st.config.symbols[idx] = picks[0];
            else st.config.symbols.push(picks[0]);
            addLog(mode, 'info', '—', `Slot replacement: ${sym} → ${picks[0]}`);
          }
        } catch (e) {
          addLog(mode, 'info', '—', `Replacement scan failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    } catch (e) {
      addLog(mode, 'error', sym, `Close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return false;
  }

  if (st.paused) {
    addLog(mode, 'wait', sym, `⏸ Paused — skipping ${action} signal`);
    return false;
  }

  if (st.lossLock) {
    addLog(mode, 'wait', sym, `🛑 Daily-loss limit hit — skipping ${action} signal (entries resume next day)`);
    return false;
  }

  if (action === 'SELL' && !cfg.allowShorts) {
    addLog(mode, 'wait', sym, 'Short selling disabled — skipping SELL signal');
    return false;
  }

  if (openPos) {
    addLog(mode, 'wait', sym, `Already in position (${openPos.side}) — skipping ${action}`);
    return false;
  }

  if (isNearClose()) {
    addLog(mode, 'wait', sym, '⏸ Market closing in <15 min — no new entries');
    return false;
  }

  // Skip entries within 2 days of an earnings report (no-op without FINNHUB_API_KEY)
  if (await hasImminentEarnings(sym)) {
    addLog(mode, 'wait', sym, '📊 Earnings within 2 days — skipping entry');
    return false;
  }

  const orderSide = action === 'BUY' ? 'buy' : 'sell';

  // ── Options entry — contract symbol with qty, no notional ────────────────
  if (signal.optionContract) {
    const qty         = signal.optionQty ?? 1;
    const optionType  = signal.optionType ?? 'call';
    addLog(mode, 'enter', sym, `${reason}`);
    // A raw market buy on an illiquid contract can fill far above the ask
    // that qty was sized against — confirmed live this is exactly how a
    // $500 budget turned into a $4,000+ fill. currentPrice here is that
    // live ask (see evaluateSymbol's options_directional branch), so a
    // limit a little above it still fills promptly against a real quote
    // while capping how far a bad print can blow past the intended budget.
    const limitPrice = currentPrice ? round2(Math.max(currentPrice * 1.1, currentPrice + 0.02)) : undefined;
    addLog(mode, 'info',  sym, `Ordering ${qty}x ${signal.optionContract} (${optionType}) — $${cfg.positionSizeUsd} budget, limit ${limitPrice ?? 'n/a'}`);
    try {
      const order = await placeOrder(mode, {
        symbol:           signal.optionContract,
        qty,
        side:             'buy',
        type:             limitPrice !== undefined ? 'limit' : 'market',
        time_in_force:    'day',
        limit_price:      limitPrice,
        client_order_id:  makeClientOrderId(mode, sym, 'opt_buy', st.lastPollTs),
      });
      addLog(mode, 'enter', sym, `Options order placed — ${signal.optionContract} id ${order.id}`);
      recordJournalEvent({
        mode, event: 'entry', symbol: signal.optionContract, strategy: cfg.strategy,
        side: 'long', qty, price: currentPrice ?? 0, reason,
      });

      // Options carry no default broker-side protection like the bracket stock
      // orders below — without this, an exit depends entirely on the next poll
      // noticing the loss, on the highest-gamma instrument in the system.
      const entryPx = parseFloat(order.filled_avg_price ?? '') || currentPrice || 0;
      if (entryPx > 0) {
        const stopPx = round2(entryPx * 0.5); // matches optionsDirectionalSignal's -50% exit rule
        const attachStop = () => placeOrder(mode, {
          symbol:        signal.optionContract!,
          qty,
          side:          'sell',
          type:          'stop',
          time_in_force: 'gtc',
          stop_price:    stopPx,
        });
        // The market buy above can report back before Alpaca's own book has
        // settled it — an opposite-side order placed immediately after
        // regularly gets rejected as a "potential wash trade" (existing_order_id
        // pointing at the still-settling buy), confirmed live across several
        // contracts. A short settle delay before the first attempt, plus one
        // retry, mirrors the trailing-stop pattern below and clears it in
        // practice — this was previously a single unretried attempt.
        await new Promise(r => setTimeout(r, 2_000));
        try {
          await attachStop();
          addLog(mode, 'info', sym, `Protective stop attached — sell at ${stopPx} (-50%)`);
        } catch (e1) {
          const msg1 = e1 instanceof Error ? e1.message : String(e1);
          // "stop price must be less than current price" means the contract
          // already crashed through the -50% level in the couple of seconds
          // between the buy and this attempt — confirmed live (a far-OTM
          // contract went to near-zero that fast). Retrying with the same
          // stopPx would just fail identically, so exit immediately instead
          // of leaving it open and naked waiting for the next poll.
          if (msg1.includes('stop price must be less than current price')) {
            addLog(mode, 'error', sym, `⚠️ Already through -50% before the stop could attach — closing now: ${msg1}`);
            try {
              const limitPrice = Math.max(0.01, round2(entryPx * 0.1));
              await placeOrder(mode, {
                symbol: signal.optionContract!, qty, side: 'sell', type: 'limit',
                time_in_force: 'day', limit_price: limitPrice,
              });
              addLog(mode, 'exit', sym, `Close order placed — limit sell @ ${limitPrice}`);
            } catch (eClose) {
              addLog(mode, 'error', sym,
                `🚨 UNPROTECTED — emergency close also failed for ${signal.optionContract}: ${eClose instanceof Error ? eClose.message : String(eClose)}. Exit relies on the next poll only.`);
            }
          } else {
            addLog(mode, 'error', sym, `Stop order failed (retrying): ${msg1}`);
            await new Promise(r => setTimeout(r, 3_000));
            try {
              await attachStop();
              addLog(mode, 'info', sym, `Protective stop attached on retry — sell at ${stopPx} (-50%)`);
            } catch (e2) {
              addLog(mode, 'error', sym,
                `🚨 UNPROTECTED — stop order failed twice for ${signal.optionContract}: ${e2 instanceof Error ? e2.message : String(e2)}. Exit relies on the next poll only.`);
            }
          }
        }
      }
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(mode, 'error', sym, `Options order failed: ${msg}`);
      // Trips the cooldown checked at the top of options_directional's entry
      // path (see optionsBpCooldown's own comment) — this specific failure
      // means the account has no more room for a NEW options position
      // regardless of symbol, so every other symbol's entry attempt this
      // poll (and every poll after, until something closes) would fail the
      // exact same way. lastCount is left as whatever the entry gate last
      // observed — the gate itself updates it every call, this only flips
      // the flag on.
      if (msg.includes('insufficient options buying power')) {
        const bp = optionsBpCooldown.get(mode)!;
        if (!bp.active) {
          bp.active = true;
          bp.since = Date.now();
          addLog(mode, 'info', sym, `Options buying power exhausted — pausing new options entries until a position closes (or a ${(OPTIONS_BP_COOLDOWN_BACKSTOP_MS / 3_600_000).toFixed(0)}h backstop)`);
        }
      }
      return false;
    }
  }

  // ── Stock entry — whole-share qty so bracket TP/SL legs are accepted ─────
  const price          = currentPrice ?? 0;
  const effectiveSizeUsd = cfg.positionSizeUsd * sizeMult;
  const qty   = price > 0 ? Math.floor(effectiveSizeUsd / price) : 0;
  if (qty < 1) {
    addLog(mode, 'wait', sym, `Position size $${effectiveSizeUsd.toFixed(0)} < 1 share at $${price.toFixed(2)} — skipping`);
    return false;
  }
  if (Math.abs(sizeMult - 1) > 0.05) {
    addLog(mode, 'info', sym, `Volatility-adjusted size: $${effectiveSizeUsd.toFixed(0)} (${sizeMult.toFixed(2)}x base)`);
  }

  // Sanity: bracket legs must be on the correct side of the market or Alpaca rejects them
  const validStop = stopPrice !== undefined &&
    (orderSide === 'buy' ? stopPrice < price : stopPrice > price);
  const validTp   = takeProfitPrice !== undefined &&
    (orderSide === 'buy' ? takeProfitPrice > price : takeProfitPrice < price);
  const useBracket = validStop && validTp && !trailPercent;

  addLog(mode, 'enter', sym, `${action} signal — ${reason}`);
  // Only log Stop/TP when a bracket leg is actually attached — otherwise (e.g.
  // weekly_momentum, which always sets trailPercent) this claimed protection
  // that wasn't there, with no way to tell a protected position from a naked one.
  if (useBracket) {
    addLog(mode, 'info', sym, `Stop: ${round2(stopPrice!).toFixed(2)}`);
    addLog(mode, 'info', sym, `TP:   ${round2(takeProfitPrice!).toFixed(2)}`);
  }

  try {
    const order = await placeOrder(mode, {
      symbol:           sym,
      qty,
      side:             orderSide,
      type:             'market',
      time_in_force:    useBracket ? 'gtc' : 'day',
      client_order_id:  makeClientOrderId(mode, sym, action, st.lastPollTs),
      ...(useBracket ? {
        order_class: 'bracket' as const,
        take_profit: { limit_price: round2(takeProfitPrice!) },
        stop_loss:   { stop_price:  round2(stopPrice!) },
      } : {}),
    });

    addLog(mode, 'enter', sym, `Order placed — ${qty} shares, id ${order.id} status ${order.status}${useBracket ? ' (bracket TP+SL attached)' : ''}`);

    recordJournalEvent({
      mode, event: 'entry', symbol: sym, strategy: cfg.strategy,
      side: orderSide === 'buy' ? 'long' : 'short',
      qty, price, reason,
    });

    // Trailing-stop exit (weekly momentum): attach after the market entry.
    // One retry before giving up — this is the position's only broker-side
    // protection when useBracket is false, so a silent failure here leaves
    // it naked until the strategy's own discretionary exit next fires.
    if (trailPercent && orderType !== 'trailing_stop') {
      const attachTrailingStop = () => placeOrder(mode, {
        symbol:        sym,
        qty,
        side:          orderSide === 'buy' ? 'sell' : 'buy',
        type:          'trailing_stop',
        time_in_force: 'gtc',
        trail_percent: trailPercent,
      });
      try {
        await attachTrailingStop();
        addLog(mode, 'info', sym, `Trailing stop attached — ${trailPercent}%`);
      } catch (e1) {
        addLog(mode, 'error', sym, `Trailing stop failed (retrying): ${e1 instanceof Error ? e1.message : String(e1)}`);
        await new Promise(r => setTimeout(r, 2_000));
        try {
          await attachTrailingStop();
          addLog(mode, 'info', sym, `Trailing stop attached on retry — ${trailPercent}%`);
        } catch (e2) {
          addLog(mode, 'error', sym,
            `🚨 UNPROTECTED — trailing stop failed twice for ${sym}: ${e2 instanceof Error ? e2.message : String(e2)}. Position has no server-side stop; monitor manually.`);
        }
      }
    }
    return true;
  } catch (e) {
    addLog(mode, 'error', sym, `Order failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// weekly_momentum only evaluates entries/exits in a 5-min window once a week
// (isWeeklyCheckTime). If its trailing stop failed to attach, that SMA-based
// discretionary exit is the only other protection — and without this, a
// missed window (VM reboot, slow poll) leaves it unchecked for up to 7 days.
// Runs once a day so it doesn't add meaningful API load.
async function checkWeeklyMomentumExits(mode: AccountMode, cfg: AlpacaBotConfig): Promise<void> {
  let positions: AlpacaPosition[];
  try {
    positions = await getPositions(mode);
  } catch (e) {
    addLog(mode, 'error', '—', `Weekly exit check: position fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const held = cfg.symbols.filter(sym => positions.some(p => p.symbol === sym));
  for (const sym of held) {
    const openPos = positions.find(p => p.symbol === sym)!;
    try {
      const [weeklyMap, dailyMap] = await Promise.all([
        getBars([sym], '1Week', 20, mode),
        getBars([sym], '1Day', 30, mode),
      ]);
      const weeklyBars = weeklyMap[sym] ?? [];
      if (!weeklyBars.length) continue;
      const signal = weeklyMomentumSignal(weeklyBars, dailyMap[sym] ?? [], true, openPos.side);
      if (signal.action === 'CLOSE_LONG' || signal.action === 'CLOSE_SHORT') {
        await executeSignal(mode, sym, signal, openPos, cfg);
      }
    } catch (e) {
      addLog(mode, 'error', sym, `Weekly exit check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function poll(mode: AccountMode) {
  const st = s(mode);
  if (!st.running || !st.config) return;

  const cfg  = st.config;
  const meta = STRATEGY_META[cfg.strategy];
  st.lastPollTs = new Date().toISOString();

  // Weekend — markets closed globally, sleep until Monday 13:00 UTC
  if (isWeekend()) {
    const sleepMs = msUntilMondayOpen();
    addLog(mode, 'wait', '—', `Weekend — markets closed. Sleeping until Monday open (~${Math.round(sleepMs / 3_600_000)}h)`);
    st.nextRunMs = Date.now() + sleepMs;
    st.pollTimer = setTimeout(() => { void poll(mode); }, sleepMs);
    return;
  }

  if (meta.timeframe === 'intraday' && !isNYSEOpen() && !cfg.allow24h) {
    addLog(mode, 'wait', '—', 'Market closed — skipping poll');
    schedule(mode, cfg);
    return;
  }

  if (meta.timeframe === 'daily' && !isDailyCheckTime()) {
    schedule(mode, cfg);
    return;
  }

  if (meta.timeframe === 'weekly' && !isWeeklyCheckTime()) {
    if (cfg.strategy === 'weekly_momentum' && isDailyCheckTime()) {
      await checkWeeklyMomentumExits(mode, cfg);
    }
    schedule(mode, cfg);
    return;
  }

  if (cfg.strategy === 'orb') {
    if (isInOpeningRange()) {
      await buildOrbRange(mode, cfg.symbols);
      schedule(mode, cfg);
      return;
    }
  }

  let positions: AlpacaPosition[] = [];
  try {
    const account = await getAccount(mode);
    positions     = await getPositions(mode);
    if (Math.random() < 0.1) {
      addLog(mode, 'info', '—', `Equity: $${parseFloat(account.equity).toFixed(2)} | Cash: $${parseFloat(account.cash).toFixed(2)} | Positions: ${positions.length}`);
    }

    // ── Daily-loss circuit breaker ──────────────────────────────────────────
    const equity = parseFloat(account.equity);
    const today  = new Date().toISOString().slice(0, 10);
    if (st.dayKey !== today) {
      st.dayKey = today;
      st.dayStartEquity = equity;
      if (st.lossLock) addLog(mode, 'info', '—', 'New trading day — daily-loss lock reset');
      st.lossLock = false;
    }
    const maxLossPct = cfg.maxDailyLossPct ?? 3;
    if (!st.lossLock && st.dayStartEquity > 0 && equity > 0) {
      const ddPct = (st.dayStartEquity - equity) / st.dayStartEquity * 100;
      if (ddPct >= maxLossPct) {
        st.lossLock = true;
        addLog(mode, 'error', '—',
          `🛑 Daily loss ${ddPct.toFixed(2)}% ≥ ${maxLossPct}% limit — no new entries today (exits still managed)`);
      }
    }
  } catch (e) {
    addLog(mode, 'error', '—', `Account fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    schedule(mode, cfg);
    return;
  }

  let openCount = positions.length;

  for (const sym of cfg.symbols) {
    if (!st.running) break;
    const inPos = findPositionFor(positions, sym);
    if (!inPos && openCount >= cfg.maxPositions) {
      addLog(mode, 'wait', sym, `Max positions (${cfg.maxPositions}) reached — skipping`);
      continue;
    }
    const opened = await evaluateSymbol(mode, sym, positions, cfg);
    if (opened) openCount++;
  }

  try {
    const freshPositions = await getPositions(mode);
    await reviewOpenPositions(mode, cfg, freshPositions);
  } catch (e) {
    addLog(mode, 'error', '—', `High-conviction watch failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  schedule(mode, cfg);
}

function schedule(mode: AccountMode, cfg: AlpacaBotConfig) {
  const st = s(mode);
  if (!st.running) return;
  const delay   = STRATEGY_META[cfg.strategy].pollMs;
  st.nextRunMs  = Date.now() + delay;
  st.pollTimer  = setTimeout(() => { void poll(mode); }, delay);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function startAlpacaBot(cfg: AlpacaBotConfig): Promise<{ ok: boolean; error?: string }> {
  const mode = cfg.mode;
  stopAlpacaBot(mode);  // stop this mode only, leave the other intact

  try {
    const account = await getAccount(mode);
    if (account.trading_blocked) {
      return { ok: false, error: 'Account trading is blocked' };
    }
    addLog(mode, 'info', '—', `Alpaca ${mode} account connected — equity $${parseFloat(account.equity).toFixed(2)}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Alpaca auth failed: ${msg}` };
  }

  const st    = s(mode);
  st.config   = cfg;
  st.running  = true;
  st.paused   = false;

  // Persist immediately — a crash mid-scan should still resume the bot
  saveAlpacaState(mode, cfg);

  // Always scan for best symbols before first poll
  addLog(mode, 'info', '—', 'Scanning market for best symbols…');
  try {
    // Was maxPositions+2 — the watchlist size was tied directly to how many
    // positions could be held at once, so a low maxPositions (the common
    // case) meant the bot only ever considered a handful of names each
    // cycle even though the scan pool behind it is ~200 liquid stocks/ETFs.
    // openCount >= cfg.maxPositions is already enforced separately at entry
    // time (see executeSignal), so a bigger watchlist doesn't risk holding
    // more positions than the cap — it just means more real candidates get
    // evaluated each cycle instead of the same 5-10 names every time.
    const watchlistSize = Math.max(cfg.maxPositions + 2, 20);
    const best = await scanForBestSymbols(
      cfg.strategy, mode, [], watchlistSize,
      msg => addLog(mode, 'info', '—', msg),
    );
    cfg.symbols = best;
  } catch (e) {
    addLog(mode, 'info', '—', `Symbol scan failed — using fallback: ${e instanceof Error ? e.message : String(e)}`);
    cfg.symbols = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA'];
  }

  if (cfg.strategy === 'orb') resetOrbState(mode, cfg.symbols);

  addLog(mode, 'info', '—', `Bot started — strategy: ${STRATEGY_META[cfg.strategy].label} | mode: ${mode} | symbols: ${cfg.symbols.join(', ')}`);
  addLog(mode, 'info', '—', `Position size: $${cfg.positionSizeUsd} | max positions: ${cfg.maxPositions} | shorts: ${cfg.allowShorts ? 'allowed' : 'disabled'} | 24/5: ${cfg.allow24h ? 'on' : 'off'}`);

  void poll(mode);
  return { ok: true };
}

export function stopAlpacaBot(mode: AccountMode): void {
  const st    = s(mode);
  st.running  = false;
  st.paused   = false;
  if (st.pollTimer) { clearTimeout(st.pollTimer); st.pollTimer = null; }
  st.nextRunMs  = null;
  st.lastPollTs = null;
  clearAlpacaState(mode);
  addLog(mode, 'info', '—', `Alpaca ${mode} bot stopped`);
}

export function pauseAlpacaBot(mode: AccountMode): void {
  const st = s(mode);
  if (!st.running) return;
  st.paused = true;
  addLog(mode, 'info', '—', '⏸ Alpaca bot paused — monitoring positions, no new entries');
}

export function resumeAlpacaBot(mode: AccountMode): void {
  const st = s(mode);
  if (!st.running) return;
  st.paused = false;
  addLog(mode, 'info', '—', '▶ Alpaca bot resumed');
}

export async function getAlpacaBotStatus(mode: AccountMode): Promise<AlpacaBotStatus> {
  const st = s(mode);
  let positions: AlpacaPosition[] = [];
  let equity = '0', cash = '0';

  if (st.running && st.config) {
    try {
      const [acct, pos] = await Promise.all([getAccount(mode), getPositions(mode)]);
      positions = pos;
      equity    = acct.equity;
      cash      = acct.cash;
    } catch {}
  }

  return {
    running:   st.running,
    paused:    st.paused,
    mode:      st.config?.mode     ?? mode,
    strategy:  st.config?.strategy ?? 'rsi_mean_reversion',
    symbols:   st.config?.symbols  ?? [],
    equity,
    cash,
    positions,
    log:       st.log.slice(0, 100),
    nextRunMs: st.nextRunMs,
    orbState:  { ...st.orbState },
    lastPollTs: st.lastPollTs,
    lossLock:  st.lossLock,
    positionWatch: getPositionWatchStatus(mode),
  };
}

export async function emergencyStop(mode: AccountMode): Promise<{ ok: boolean; error?: string }> {
  stopAlpacaBot(mode);
  try {
    await cancelAllOrders(mode);
    addLog(mode, 'info', '—', 'Emergency stop: all orders cancelled');
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    addLog(mode, 'error', '—', `Emergency stop error: ${msg}`);
    return { ok: false, error: msg };
  }
}

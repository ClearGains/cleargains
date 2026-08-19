import * as fs from 'fs';
import * as path from 'path';
import {
  authenticate, getSession, fetchFullPositions, closePosition, updatePositionLevels, fetchCandleHistory,
  placeMarketOrder, fetchMarketDetails,
  type FullPosition, type IGSession, type CandleBar,
} from './igApi';
import {
  resolveCredentials, addLog, recordLossExit, calcStake, isLossLocked, isProfitLocked, getMaxRiskGbp,
  registerBotOpenedDeal, getPeerGroupChange, type IgMode,
} from './igStrategyBot';
import { askGeminiPositionVerdict, askGeminiTradeIdea } from './gemini';
import { EPIC_TO_ALPACA, EPIC_TO_YAHOO, fetchBarsWithFallback } from './yahooFetch';
import { calcRsi, calcMacdHist } from './alpacaStrategies';
import { fetchAllHeadlines } from './newsFetch';
import { hasBreakingNews } from './alpacaNewsStream';
import { isNYSEOpen, isNearClose, type AlpacaBar } from './alpacaApi';
import { FX_EPICS, isIndexEpic } from './igStrategyScanner';

// Manual kill-switch for this watcher's own Gemini usage, independent of
// which positions are flagged — same purpose as igStrategyBot.ts's own
// strategy-side pause (see its own comment): back off Gemini specifically
// during a stretch of real API degradation without having to un-watch
// every position. Paused reviews simply don't fire this cycle — the hard
// stop-loss still protects every watched position regardless, same as any
// other Gemini outage. Persisted per mode so it survives a restart.
function watchAiPauseFile(mode: IgMode): string {
  return path.join(__dirname, '..', `ig-watch-ai-paused-${mode}.json`);
}
function loadWatchAiPaused(mode: IgMode): boolean {
  try { return (JSON.parse(fs.readFileSync(watchAiPauseFile(mode), 'utf8')) as { paused: boolean }).paused; }
  catch { return false; }
}
function saveWatchAiPaused(mode: IgMode, paused: boolean): void {
  try { fs.writeFileSync(watchAiPauseFile(mode), JSON.stringify({ paused }), 'utf8'); } catch {}
}
const watchAiPaused = new Map<IgMode, boolean>([
  ['demo', loadWatchAiPaused('demo')],
  ['live', loadWatchAiPaused('live')],
]);
export function isWatchAiPaused(mode: IgMode): boolean {
  return watchAiPaused.get(mode) ?? false;
}
export function setWatchAiPaused(mode: IgMode, paused: boolean): void {
  watchAiPaused.set(mode, paused);
  saveWatchAiPaused(mode, paused);
}

// ── Gemini position watch — for positions opened outside the strategy bot
// (manually via IG's own app, the Demo Trader panel, or anywhere else) that
// the user explicitly flags for Gemini to review periodically and close if
// it judges that's warranted. Independent of any running strategy — works
// whether or not the Donchian bot itself is active.

function watchFile(mode: IgMode): string {
  return path.join(__dirname, '..', `gemini-watch-${mode}.json`);
}

// Value is a free-text note the user can attach when watching a position —
// e.g. "opened this expecting a bounce off support, close if it breaks
// below X" — passed straight into askGeminiPositionVerdict's prompt so
// Gemini's periodic review has the user's own stated intent for the
// position, not just the price/news/technicals it derives on its own.
// Empty string means watched with no note, same as the old boolean-only
// behaviour.
function loadWatch(mode: IgMode): Map<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(watchFile(mode), 'utf8')) as string[] | Record<string, string>;
    // Old format was a plain array of dealIds (no notes) — read those in
    // as watched-with-no-note rather than losing them on the first load
    // after this change ships.
    if (Array.isArray(raw)) return new Map(raw.map(id => [id, '']));
    return new Map(Object.entries(raw));
  } catch { return new Map(); }
}

function saveWatch(mode: IgMode, notes: Map<string, string>): void {
  try { fs.writeFileSync(watchFile(mode), JSON.stringify(Object.fromEntries(notes)), 'utf8'); } catch {}
}

const watched = new Map<IgMode, Map<string, string>>([
  ['demo', loadWatch('demo')],
  ['live', loadWatch('live')],
]);

export function getWatchedDealIds(mode: IgMode): string[] {
  return [...(watched.get(mode) ?? new Map()).keys()];
}

export function getWatchNotes(mode: IgMode): Record<string, string> {
  return Object.fromEntries(watched.get(mode) ?? new Map());
}

export function getWatchNote(mode: IgMode, dealId: string): string {
  return watched.get(mode)?.get(dealId) ?? '';
}

export function isWatched(mode: IgMode, dealId: string): boolean {
  return watched.get(mode)?.has(dealId) ?? false;
}

export function addToWatch(mode: IgMode, dealId: string, note = ''): void {
  const map = watched.get(mode)!;
  map.set(dealId, note);
  saveWatch(mode, map);
}

export function setWatchNote(mode: IgMode, dealId: string, note: string): void {
  const map = watched.get(mode)!;
  if (!map.has(dealId)) return; // no-op on a deal that isn't actually watched
  map.set(dealId, note);
  saveWatch(mode, map);
}

export function removeFromWatch(mode: IgMode, dealId: string): void {
  const map = watched.get(mode)!;
  map.delete(dealId);
  saveWatch(mode, map);
  lastReview.delete(dealId);
  peakUpl.delete(dealId);
  lastStopTightenAt.delete(dealId);
  lastEarlyLossTightenAt.delete(dealId);
}

// Throttle — a position that hasn't moved meaningfully since its last actual
// Gemini call gets skipped rather than re-asked every single 15-min cycle
// for no new information. In-memory only (not persisted): worst case after
// a restart, every watched position gets one extra call it might not have
// strictly needed, which is a fine tradeoff against added persisted state.
// Also doubles as the confidence tracker for gemini_opinion's position-
// rotation logic — "how convinced are we in holding this right now" is the
// same information this throttle already needs, just also read externally.
const lastReview = new Map<string, { upl: number; at: number; confidence: number }>();
const MOVE_THRESHOLD_GBP = 3;          // re-ask once P&L has moved at least this much since the last call
const MAX_SILENCE_MS     = 45 * 60_000; // ...or at least this long has passed, even if flat

// High-water mark of unrealized P&L per watched position, updated every poll
// regardless of throttle — lets a swing from meaningfully-in-profit to
// in-loss be recognized as a distinct "reversedToRed" risk signal (see
// reviewOne), not just folded into the ordinary move-threshold check.
// In-memory only, same tradeoff as lastReview: worst case after a restart is
// one missed reversal detection on an already-reversed position, not a
// silent failure to protect it (the hard stop still applies regardless).
const peakUpl = new Map<string, number>();

// Mechanical stop-tightening on a stalling position — same lesson
// fxScalperBot.ts's stall detection already learned the hard way (see its
// own comment): locking to flat breakeven on any giveback converts
// promising trades into near-guaranteed small losses well before their
// real take-profit gets a fair chance, so this only acts once a REAL chunk
// of the peak favorable move has actually been given back, and locks in a
// fraction of that peak — not all of it, not none of it. Reuses those same
// two fractions for consistency. Built after confirming live 2026-08-18
// that Gemini Position Watch had leaned on "the stop protects it" as its
// own reasoning to keep holding Western Digital all the way through a
// genuine reversal — a mechanical action here doesn't depend on Gemini's
// judgment holding up on any given review the way that reasoning did.
const STALL_RETRACE_FRAC = 0.65; // fraction of peak favorable £ given back before treating it as stalling
const STALL_LOCK_IN_FRAC = 0.3;  // fraction of peak favorable move to lock in when it fires
const lastStopTightenAt = new Map<string, number>();

// Real company shares only — excludes FX, indices, and the commodities/
// crypto that share the same 'CS.'/'CC.' epic prefixes FX and indices use
// (Silver and Bitcoin are both 'CS.'-prefixed but aren't FX_EPICS members;
// Brent Crude/Natural Gas are 'CC.'-prefixed). Used to scope the two
// mechanical rules below to what the user actually asked about ("in
// particular stocks"), not FX/commodities where the same day-close/
// early-loss intuition wasn't what was being tested.
const NON_STOCK_EPICS = new Set(['CC.D.LCO.USS.IP', 'CC.D.NG.USS.IP', 'CS.D.USCSI.TODAY.IP', 'CS.D.BITCOIN.TODAY.IP']);
function isStockEpic(epic: string): boolean {
  return !FX_EPICS.has(epic) && !isIndexEpic(epic) && !NON_STOCK_EPICS.has(epic);
}

// Mechanical stop-tightening for a stock that's never gone meaningfully
// green and is still red after a real amount of time open — see its own
// use below for the reasoning (user's own trading intuition, checked first
// against real trade history and found directionally plausible but on too
// small a sample to statistically confirm; implemented anyway on explicit
// request, moderately rather than as a hard close).
const lastEarlyLossTightenAt = new Map<string, number>();

// Seeds a freshly-opened gemini_opinion position with its entry confidence,
// so there's an immediate baseline to compare against rather than an
// arbitrary default until the first real Position Watch review lands. `at:
// 0` guarantees that first review isn't throttled away — it always runs on
// the very next watch cycle regardless of how little the position has
// moved, so the baseline gets refreshed with real judgment quickly.
export function recordEntryConfidence(dealId: string, confidence: number): void {
  if (!lastReview.has(dealId)) lastReview.set(dealId, { upl: 0, at: 0, confidence });
}

// Weakest-conviction currently-held position, for gemini_opinion's swap
// check — a dealId never yet reviewed defaults to 60 (the same bar an
// entry itself has to clear), a neutral assumption rather than treating an
// unreviewed position as automatically weak or automatically safe.
export function getWeakestConfidence(dealIds: string[]): { dealId: string; confidence: number } | null {
  if (!dealIds.length) return null;
  let weakest: { dealId: string; confidence: number } | null = null;
  for (const dealId of dealIds) {
    const confidence = lastReview.get(dealId)?.confidence ?? 60;
    if (!weakest || confidence < weakest.confidence) weakest = { dealId, confidence };
  }
  return weakest;
}

// Reuses the strategy bot's own session if one's already authenticated
// (same sessionKey pattern, 'igstrat:<mode>') rather than logging in twice —
// authenticates fresh only if no live session exists yet.
async function getOrAuthSession(mode: IgMode): Promise<IGSession | null> {
  const sessionKey = `igstrat:${mode}`;
  const existing = getSession(sessionKey);
  if (existing && Date.now() < existing.expiresAt - 2 * 60_000) return existing;

  const creds = resolveCredentials(mode);
  if (!creds.apiKey || !creds.username || !creds.password) return null;
  try {
    return await authenticate(creds.apiKey, creds.username, creds.password, creds.env, sessionKey);
  } catch {
    return null;
  }
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

// Alpaca goes quiet outside NYSE hours (no new bars once the exchange
// closes — expected, not broken), which leaves US-stock positions with no
// day-change/sharp-dip context for most of the day. IG prices these CFDs
// continuously even when the underlying exchange is shut, so its own candle
// history is genuinely fresher during that window — reused here as a
// fallback, always via the shared demo session (same pattern as the FX
// scalper's data feed) specifically so this never touches live's own
// allowance, which the rest of this account's traffic already leans on.
async function fetchIgOffHoursBars(epic: string): Promise<AlpacaBar[] | null> {
  const key = 'igstrat:demo';
  let session = getSession(key);
  if (!session || Date.now() >= session.expiresAt - 2 * 60_000) {
    const creds = resolveCredentials('demo');
    if (!creds.apiKey) return null;
    try { session = await authenticate(creds.apiKey, creds.username, creds.password, creds.env, key); }
    catch { return null; }
  }
  try {
    const bars = await fetchCandleHistory(session, epic, 'HOUR', 48);
    return bars.length ? bars.map(igBarToAlpacaBar) : null;
  } catch {
    return null;
  }
}

async function reviewOne(mode: IgMode, session: IGSession, p: FullPosition): Promise<void> {
  const name = p.instrumentName;

  const heldHours = p.openedAt ? (Date.now() - new Date(p.openedAt).getTime()) / 3_600_000 : 0;

  // Hard backstop, independent of Gemini's judgment — a watched position
  // must always have a real IG-side stop. If Gemini is down, rate-limited,
  // or just wrong, this is what actually bounds the loss, same 3%-of-price
  // fallback the strategy bot's own self-heal uses.
  //
  // Grace period — confirmed live this matters: IG's own /positions
  // endpoint doesn't always report a guaranteed stop's level the same way
  // a normal stop shows up. A Silver position's confirmed guaranteed stop
  // (42pts, immune to slippage) came back as stopLevel:null ~71s after the
  // order confirmed it was attached, tricking this check into replacing it
  // with a much wider (~199pts), non-guaranteed fallback stop — same
  // pattern hit EUR/USD and Wall St the same day, both self-healed within
  // a minute of opening. Skipping a position younger than this doesn't
  // weaken the backstop for anything that's genuinely naked — it's still
  // caught on this position's very next review — it only stops overwriting
  // a real guaranteed stop still propagating through IG's own reporting.
  const SELF_HEAL_GRACE_HOURS = 3 / 60; // 3 minutes
  if (p.stopLevel === undefined && heldHours >= SELF_HEAL_GRACE_HOURS) {
    const fallbackDist = Math.max(1, p.level * 0.03);
    const fallbackStop = p.direction === 'BUY' ? p.level - fallbackDist : p.level + fallbackDist;
    try {
      await updatePositionLevels(session, p.dealId, fallbackStop, p.limitLevel ?? null);
      addLog(mode, 'info', name, `[Gemini watch] Attached missing stop (was naked) — ${fallbackStop.toFixed(2)}`);
    } catch (e) {
      addLog(mode, 'error', name, `[Gemini watch] 🚨 UNPROTECTED — failed to attach stop: ${e instanceof Error ? e.message : String(e)}. Monitor manually.`);
    }
  }

  const currentLevel = p.direction === 'BUY' ? p.bid : p.offer;
  // Confirmed live: IG's own position feed returned bid/offer as null during
  // a fast-moving/gapping market — the exact moment a real severe-loss event
  // was also firing. Left unguarded, that null reached askGeminiPositionVerdict
  // and crashed inside its prompt-building step (outside that function's own
  // try/catch, which only wraps the network call), as an unhandled rejection
  // that silently aborted review of every other watched position this cycle
  // (see pollAll's own try/catch, added for the same incident). Skip this
  // position for now rather than review on a fabricated price — same
  // best-effort pattern used for bars above; the next poll retries.
  if (currentLevel == null) {
    addLog(mode, 'wait', name, '[Gemini watch] No live bid/offer yet — skipping this cycle');
    return;
  }

  const last = lastReview.get(p.dealId);

  // High-water mark of this position's P&L, updated every poll regardless of
  // throttle — a swing from meaningfully-in-profit to in-loss is a distinct
  // risk signal (a real reversal, not just "P&L is down") worth flagging to
  // Gemini even when news hasn't caught up to explain it yet.
  const priorPeak = peakUpl.get(p.dealId) ?? p.upl;
  const peak = Math.max(priorPeak, p.upl);
  peakUpl.set(p.dealId, peak);
  const GREEN_TO_RED_THRESHOLD_GBP = 2; // "meaningfully" in profit at some point — not just noise around zero
  const reversedToRed = peak >= GREEN_TO_RED_THRESHOLD_GBP && p.upl < 0;
  // Edge-triggered version for the throttle bypass below — reversedToRed
  // alone would force a fresh Gemini call every single poll for as long as
  // the position stays red after ever having been green, which could burn
  // through the daily call cap fast on a position left to sit. Only force
  // the bypass the first time this shows up since Gemini's last actual look
  // (i.e. it was still green, or unreviewed, as of the last real call) —
  // once Gemini has seen it, the ordinary £3-move / 45-min throttle governs
  // follow-up calls same as anything else.
  const justTurnedRed = reversedToRed && (!last || last.upl >= 0);

  // Mechanical stall-tightening — runs every poll regardless of the
  // Gemini-call throttle below, on purpose (see STALL_RETRACE_FRAC's own
  // comment above). Only acts once a real chunk of a real peak has been
  // given back — not on ordinary noise near entry, and not to flat
  // breakeven either.
  if (peak >= GREEN_TO_RED_THRESHOLD_GBP && p.size > 0) {
    const retracedFrac = (peak - p.upl) / peak;
    const lastTightened = lastStopTightenAt.get(p.dealId) ?? 0;
    if (retracedFrac >= STALL_RETRACE_FRAC && Date.now() - lastTightened > 30 * 60_000) {
      const isLong    = p.direction === 'BUY';
      const peakPts    = peak / p.size;
      const lockInPts  = peakPts * STALL_LOCK_IN_FRAC;
      const newStop    = isLong ? p.level + lockInPts : p.level - lockInPts;
      const wouldTighten = p.stopLevel === undefined
        || (isLong ? newStop > p.stopLevel : newStop < p.stopLevel);
      // Never place a stop on the wrong side of current price — that
      // would trigger an immediate close instead of protecting anything.
      const stopIsValid = isLong ? newStop < currentLevel : newStop > currentLevel;
      if (wouldTighten && stopIsValid) {
        try {
          await updatePositionLevels(session, p.dealId, newStop, p.limitLevel ?? null);
          lastStopTightenAt.set(p.dealId, Date.now());
          addLog(mode, 'info', name, `Stalling — gave back ${(retracedFrac * 100).toFixed(0)}%+ of its £${peak.toFixed(2)} peak, tightened stop to lock in ~£${(lockInPts * p.size).toFixed(2)} of it`);
        } catch (e) {
          addLog(mode, 'error', name, `Stop tighten failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  // ── EOD profit-taking trigger (every instrument, not just stocks) ──────
  // User's own trading intuition: a position sitting in real profit late in
  // the day is worth evaluating for closing rather than automatically held
  // into the next day, on the reasoning that direction can just as easily
  // reverse overnight — FX and commodities carry the same daily-noise/
  // reversal risk as stocks do, per explicit follow-up, so this isn't
  // stock-scoped the way the early-loss rule below still is. Uses the NYSE
  // close as a single, already-defined "end of day" checkpoint for the
  // whole account rather than inventing a separate one per market.
  //
  // Deliberately NOT a mechanical auto-close (an earlier version was) — per
  // further explicit follow-up, the decision needs an actual evaluation of
  // whether the profit is worth banking now, whether the trend looks set to
  // continue (in which case holding through the close has a real case), and
  // whether the opposite direction might be the better position from here —
  // not just "profitable + near close = close." So this only sets a flag:
  // it forces a fresh askGeminiPositionVerdict call below (bypassing the
  // ordinary move/silence throttle, same as sharpDip/justTurnedRed already
  // do) with end-of-day context added to the prompt, and lets that verdict's
  // existing CLOSE handling (below) — including its existing reversal-flip
  // check — decide what actually happens. Needs a minimum age too: a
  // position opened during (or just before) this same 15min buffer
  // shouldn't be swept into this evaluation within minutes of opening — an
  // overnight-opened position is meant to run to the *next* close, which
  // the natural ~24h gap between close windows already gives it.
  const EOD_PROFIT_MIN_GBP       = 2;   // same "meaningfully" bar as GREEN_TO_RED_THRESHOLD_GBP above
  const EOD_PROFIT_MIN_AGE_HOURS = 0.5; // comfortably past the 15min close buffer itself
  const nearEndOfDayProfit = isNearClose(15) && heldHours >= EOD_PROFIT_MIN_AGE_HOURS && p.upl >= EOD_PROFIT_MIN_GBP;

  // ── Early-loss escalation tightening (stocks only) ─────────────────────
  // Same user intuition, other direction: a stock position that's never
  // gone meaningfully green and is still red after a real amount of time
  // open is treated as more likely to keep escalating than recover —
  // tighten the stop partway rather than wait for the original full
  // distance. Same "lock in a fraction, not all/none" caution as the
  // stall-tightening block above, applied to remaining risk instead of
  // banked profit since there's no real peak to speak of here. Own
  // cooldown map so it only fires once per position, same pattern.
  const EARLY_LOSS_MIN_AGE_HOURS   = 20 / 60; // 20min — past pure entry noise
  const EARLY_LOSS_NEVER_GREEN_GBP = 1;       // "never really went green" bar
  const EARLY_LOSS_TIGHTEN_FRAC    = 0.5;     // halve the remaining stop distance
  if (isStockEpic(p.epic) && heldHours >= EARLY_LOSS_MIN_AGE_HOURS && peak < EARLY_LOSS_NEVER_GREEN_GBP && p.upl < 0 && p.stopLevel !== undefined) {
    const lastTightened = lastEarlyLossTightenAt.get(p.dealId) ?? 0;
    if (Date.now() - lastTightened > 30 * 60_000) {
      const isLong = p.direction === 'BUY';
      const remainingDist = isLong ? currentLevel - p.stopLevel : p.stopLevel - currentLevel;
      if (remainingDist > 0) {
        const newStop = isLong
          ? p.stopLevel + remainingDist * EARLY_LOSS_TIGHTEN_FRAC
          : p.stopLevel - remainingDist * EARLY_LOSS_TIGHTEN_FRAC;
        const stopIsValid = isLong ? newStop < currentLevel : newStop > currentLevel;
        if (stopIsValid) {
          try {
            await updatePositionLevels(session, p.dealId, newStop, p.limitLevel ?? null);
            lastEarlyLossTightenAt.set(p.dealId, Date.now());
            addLog(mode, 'info', name, `[Early-loss] Never went green after ${(heldHours * 60).toFixed(0)}min, still red — tightened stop to cut further downside`);
          } catch (e) {
            addLog(mode, 'error', name, `[Early-loss] Stop tighten failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
  }

  // Best-effort — [] if no Alpaca ticker mapping or Finnhub unavailable,
  // same pattern as the entry-confirmation flow. Lets Gemini weigh whether
  // today's news/volatility could reverse this position, not just P&L and
  // hold time alone. Headlines specifically need a real company ticker
  // (Finnhub's company-news endpoint) — FX/indices have no such thing, so
  // this stays Alpaca-only regardless of what bars are available below.
  const ticker = EPIC_TO_ALPACA[p.epic];

  // Bars, by contrast, are available far more broadly — EPIC_TO_YAHOO covers
  // the full IG_EPICS universe (FX, indices, UK stocks included), not just
  // Alpaca's US-shares-only set. Gating this on the Alpaca ticker alone was
  // silently leaving every FX (and index/UK-stock) position out of the
  // sharp-dip and day-change checks below even though free bar data for them
  // was available the whole time — fetchBarsWithFallback already falls
  // through to Yahoo internally, this just stops refusing to call it.
  const hasBarSource = ticker !== undefined || p.epic in EPIC_TO_YAHOO;

  // Fetched every poll (not just when the throttle would otherwise allow a
  // real call) so a sudden sharp dip against the position can be detected
  // promptly rather than waiting on the ordinary £3-move / 45-min throttle —
  // Alpaca/Yahoo bars are free, unlike the Gemini call itself below, which
  // still respects the throttle (and the daily cap) as before.
  let dayChangePercent:     number | undefined;
  let sharpDipPercent:      number | undefined;
  let volumeSurgeMultiple:  number | undefined;
  // Entry decisions (askGeminiTradeIdea) get real candle shape + RSI/MACD —
  // review only ever got two numbers derived from price (dayChangePercent,
  // sharpDipPercent), never the shape or momentum indicators themselves.
  // Nobody ever deliberately chose that gap — every review enrichment so
  // far (news, sharp-dip, reversal) patched a specific incident, and none
  // of them happened to touch this. Gemini was deciding whether the entry
  // thesis still holds without seeing the same picture that thesis was
  // built on. Reuses the same already-scaled `bars` this block already
  // fetches for dayChangePercent/sharpDipPercent — no extra fetch.
  let recentCandles: Array<{ open: number; high: number; low: number; close: number }> | undefined;
  let rsi:      number | null = null;
  let macdHist: number | null = null;
  if (hasBarSource) {
    try {
      let bars = await fetchBarsWithFallback(p.epic, '5d', { alpacaTimeframe: '1Hour', yahooInterval: '1h' });

      // Alpaca-covered US stocks go quiet the moment NYSE closes — the bars
      // above are then correctly "yesterday's close", not broken, but stale
      // for review purposes. IG's own price for these keeps moving 24h, so
      // its candle history is a genuinely fresher source specifically for
      // this window — try it, and use it in place of Alpaca's frozen bars
      // if it comes back with something newer. Never touches live's own
      // allowance (always the shared demo session — see fetchIgOffHoursBars).
      if (ticker !== undefined && !isNYSEOpen()) {
        const igBars = await fetchIgOffHoursBars(p.epic);
        const igIsNewer = igBars?.length && (!bars?.length
          || new Date(igBars[igBars.length - 1].t).getTime() > new Date(bars[bars.length - 1].t).getTime());
        if (igIsNewer) bars = igBars;
      }

      // fetchBarsWithFallback only applies its known ×100 shares scaling to
      // Alpaca-covered epics — everything else it can now reach through this
      // wider gate (FX, indices, UK stocks, all via Yahoo) comes back raw,
      // and there's no one common ratio to IG's own quote the way shares'
      // confirmed ×100 works. Confirmed live: IG quotes GBP/USD at ~13425
      // vs Yahoo's raw ~1.3425 — a ×10000 ratio, not ×100, and not
      // necessarily uniform across every pair either (JPY crosses use a
      // different pip convention). Rather than hardcode a guessed factor
      // per instrument, derive it from the one already-trusted reference
      // point available: IG's own live currentLevel against Yahoo's most
      // recent close, taken at essentially the same moment.
      if (bars?.length && ticker === undefined) {
        const lastRaw = bars[bars.length - 1].c;
        if (lastRaw > 0 && currentLevel > 0) {
          const scale = currentLevel / lastRaw;
          bars = bars.map(b => ({ ...b, o: b.o * scale, h: b.h * scale, l: b.l * scale, c: b.c * scale }));
        } else {
          bars = null; // can't safely scale — proceed without day-change/sharp-dip context rather than risk garbage numbers
        }
      }

      if (bars?.length) {
        const latestBarAgeMs = Date.now() - new Date(bars[bars.length - 1].t).getTime();
        // 20h, not 6h — confirmed live 6h was tripping on completely
        // ordinary overnight closure (NYSE closed ~17.5h, LSE ~15.5h
        // between sessions), losing day-change/sharp-dip context for most
        // of every day rather than catching an actually-stuck feed. This
        // still comfortably catches the case it was built for: Alpaca's
        // paper-account bars for INTC were once stuck ~3 *weeks* stale
        // despite the fetch succeeding with no error, and the old fallback
        // here (oldest bar in the whole 5-day window when nothing matched
        // "today") produced a nonsense "-27% today" figure that got a
        // genuinely fine position closed for a fabricated reason. No
        // fallback to an older bar anymore — if the feed's stale, or
        // nothing matches today, this just stays unset. No day-change
        // context beats a wrong one.
        const STALE_DATA_MS  = 20 * 60 * 60_000;
        if (latestBarAgeMs <= STALE_DATA_MS) {
          const todayUtc   = new Date().toISOString().slice(0, 10);
          const todaysBars = bars.filter(b => b.t.slice(0, 10) === todayUtc);
          const dayOpen     = todaysBars[0]?.o;
          if (dayOpen) dayChangePercent = ((currentLevel - dayOpen) / dayOpen) * 100;

          // Adverse move against the position's direction within just the
          // last few bars — distinct from dayChangePercent, since a position
          // can look unremarkable on the day as a whole while a fast reversal
          // is happening right now within it.
          const RECENT_BARS = Math.min(4, bars.length);
          const window      = bars.slice(-RECENT_BARS);
          if (p.direction === 'BUY') {
            const recentHigh = Math.max(...window.map(b => b.h));
            if (recentHigh > 0) sharpDipPercent = ((recentHigh - currentLevel) / recentHigh) * 100;
          } else {
            const recentLow = Math.min(...window.map(b => b.l));
            if (recentLow > 0) sharpDipPercent = ((currentLevel - recentLow) / recentLow) * 100;
          }

          // Hourly bars here (not 30-min like the entry path), so the
          // standard 14/12-26-9 periods already cover the same wall-clock
          // window the entry side doubles to 28/24-52-18 to preserve.
          recentCandles = bars.slice(-8).map(b => ({ open: b.o, high: b.h, low: b.l, close: b.c }));
          rsi = calcRsi(bars, 14);
          macdHist = calcMacdHist(bars, 12, 26, 9)?.hist ?? null;

          // Same relative-volume check askGeminiTradeIdea already gets at
          // entry — carried into the ongoing review too, per explicit
          // request (an entry could see a volume surge, then the review
          // went blind to it for the rest of the position's life).
          const recent20    = bars.slice(-20);
          const avgVolPrior = bars.slice(0, -20).reduce((s, b) => s + b.v, 0) / Math.max(bars.length - 20, 1);
          const recentVol   = recent20.reduce((s, b) => s + b.v, 0) / recent20.length;
          volumeSurgeMultiple = avgVolPrior > 0 ? recentVol / avgVolPrior : undefined;
        }
      }
    } catch { /* best-effort — proceed without it */ }
  }

  // FX naturally oscillates more within what's still "normal" than a stock
  // does — a same-size move that would be a real warning sign for a stock
  // (news-driven, directional) is often just ordinary short-term noise for
  // a currency pair. Give FX more room before treating a move as alarming.
  // Confirmed live this was too tight for stocks: 1.5% is well within
  // ordinary single-name intraday noise (individual stocks routinely move
  // several percent in a day, more than a major FX pair does), yet it was
  // firing the same "sharp move — lean toward closing" alarm as a genuine
  // reversal, converting positions that would have gone on to hit a real
  // take-profit into an early cut instead — seen repeatedly on names like
  // Seagate, closed within ~15min of entry on moves this small.
  const isFx = p.epic.startsWith('CS.');
  const SHARP_DIP_THRESHOLD_PCT = isFx ? 2.5 : 3;
  const sharpDip = sharpDipPercent !== undefined && sharpDipPercent >= SHARP_DIP_THRESHOLD_PCT;

  const moved = !last || Math.abs(p.upl - last.upl) >= MOVE_THRESHOLD_GBP;
  const stale = !last || (Date.now() - last.at) >= MAX_SILENCE_MS;
  // A real headline just hit for this instrument (Alpaca's real-time news
  // stream, opt-in — see alpacaNewsStream.ts) — same bypass category as a
  // sharp dip: price hasn't necessarily moved yet, but that's exactly the
  // case where waiting for the ordinary throttle to notice a move is too
  // late. Doesn't feed the prompt itself, just makes sure this cycle's
  // review actually runs instead of being silently skipped.
  const breakingNews = !!ticker && hasBreakingNews(ticker);
  // A sharp dip, a just-turned-red reversal, or a real end-of-day profit
  // worth evaluating always gets a fresh Gemini call this cycle even if the
  // ordinary throttle would otherwise skip it — these are exactly the
  // situations where sitting on stale judgment for up to another 45 minutes
  // is the wrong tradeoff.
  if (!moved && !stale && !sharpDip && !justTurnedRed && !nearEndOfDayProfit && !breakingNews) return;
  // Mechanical checks above (stall-tightening, EOD, early-loss) already ran
  // and don't touch Gemini at all — only the actual AI review is skipped
  // here, so the hard stop-loss and every price-only protection still work
  // normally while paused.
  if (isWatchAiPaused(mode)) return;

  const headlines = ticker ? await fetchAllHeadlines(ticker, 8, name) : [];
  const peerGroup = getPeerGroupChange(p.epic);
  const userNote  = getWatchNote(mode, p.dealId);

  const verdict = await askGeminiPositionVerdict({
    instrumentName: name,
    headlines,
    userNote: userNote || undefined,
    direction:      p.direction,
    entryLevel:     p.level,
    currentLevel,
    uplGbp:         p.upl,
    heldHours,
    stopLevel:      p.stopLevel,
    limitLevel:     p.limitLevel,
    dayChangePercent,
    sharpDipPercent,
    reversedToRed,
    isFx,
    recentCandles,
    rsi,
    macdHist,
    nearEndOfDay: nearEndOfDayProfit,
    volumeSurgeMultiple,
    peerGroupChangePercent: peerGroup?.changePercent,
    peerGroupLabel: peerGroup?.label,
  });

  addLog(mode, 'info', name, `[Gemini watch] ${verdict.action} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);

  // Only update the tracked confidence on a real verdict — a Gemini outage
  // (passthrough) shouldn't silently make a healthy position look weak in
  // the rotation comparison, so it keeps whatever the last real reading was.
  lastReview.set(p.dealId, {
    upl: p.upl, at: Date.now(),
    confidence: verdict.engine === 'gemini' ? verdict.confidence : (last?.confidence ?? 60),
  });

  // Passthrough always returns HOLD (see askGeminiPositionVerdict's own
  // fail-closed default) — fine normally, since the stop still protects an
  // ordinary position either way. But this specific evaluation exists to
  // proactively bank a real profit before it's exposed to an unreviewed
  // overnight/next-day reversal; silently falling back to "just hold
  // through the close" because Gemini happened to be unavailable at this
  // exact moment defeats the entire point. Falls back to the original
  // mechanical behavior (just close) instead, only for this specific case.
  const eodFallbackClose = nearEndOfDayProfit && verdict.engine === 'passthrough';
  if (eodFallbackClose) addLog(mode, 'info', name, `[EOD] Gemini unavailable for the end-of-day review — closing on the original mechanical rule rather than holding unreviewed`);
  const closeReason = eodFallbackClose
    ? `[EOD] +£${p.upl.toFixed(2)} near end of day, Gemini unavailable to weigh trend continuation — closing rather than holding unreviewed`
    : verdict.reason;

  if (verdict.action === 'CLOSE' || eodFallbackClose) {
    try {
      await closePosition(session, p.dealId, p.direction, p.size);
      addLog(mode, 'exit', name, `[Gemini watch] Closed — ${closeReason}`);
      recordLossExit(mode, p.epic, p.upl, closeReason);
      removeFromWatch(mode, p.dealId);

      // Reversal flip — closing on a genuine, price-confirmed reversal is
      // exactly the situation where the opposite direction has real merit,
      // not "we lost, so try the other way." Requires independent
      // confirmation (real price action, not just this CLOSE verdict's own
      // reasoning) and a fresh full entry-quality read, not a bare
      // mechanical trigger — see maybeReverseFlip's own comment.
      await maybeReverseFlip(mode, session, p, recentCandles, closeReason);
    } catch (e) {
      addLog(mode, 'error', name, `[Gemini watch] Close failed, still watching: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// After a position closes, consider opening the opposite direction. The
// original CLOSE is itself the evidence a mistake was made — deliberately
// NOT re-gated behind a slow, strict 3-bar price-action pattern the way
// entries are (that check earned its keep blocking brand-new ideas with no
// evidence behind them yet; recycling it here mostly just cost time on a
// leveraged trade, and a clean 3-bar monotonic sequence is rare enough in
// real price action that this would barely ever have fired). The one gate
// kept is a completely fresh askGeminiTradeIdea call actually agreeing with
// the reversed direction — no confidence bar, deliberately loose, since the
// real safety net here is what happens *after* it opens: it goes straight
// into this same watched-position pipeline (stall-tightening, ongoing
// review), not left to run unmanaged. Built 2026-08-18: real trade history
// showed this account is weak at initial direction (28% win rate) but
// disciplined about cutting losses small (wins average ~3x loss size) — a
// flip plays to that second strength to offset the first, trusting the
// exit-management to correct it fast if the flip itself turns out wrong.
async function maybeReverseFlip(
  mode: IgMode, session: IGSession, closedPos: FullPosition,
  recentCandles: Array<{ open: number; high: number; low: number; close: number }> | undefined,
  closeReason: string,
): Promise<void> {
  const name = closedPos.instrumentName;
  const originalWasLong = closedPos.direction === 'BUY';

  if (isLossLocked(mode))   { addLog(mode, 'wait', name, 'Reversal flip skipped — daily-loss lock active'); return; }
  if (isProfitLocked(mode)) { addLog(mode, 'wait', name, 'Reversal flip skipped — daily-profit target already banked'); return; }

  const wantDirection = originalWasLong ? 'SELL' : 'BUY';
  const currentLevel  = originalWasLong ? closedPos.offer : closedPos.bid;
  if (!currentLevel) return;

  const ticker    = EPIC_TO_ALPACA[closedPos.epic];
  const headlines = ticker ? await fetchAllHeadlines(ticker, 8, name) : [];

  let idea;
  try {
    idea = await askGeminiTradeIdea({
      instrumentName: name, price: currentLevel,
      rsi: null, macdHist: null, atr: null, headlines,
      recentCandles: recentCandles?.slice(-3) ?? [],
      recentExitContext: `Just closed the opposite side (${closedPos.direction}) moments ago: "${closeReason}"`,
    });
  } catch { return; }

  // Deliberately no confidence bar — see this function's own comment. Only
  // blocks if Gemini actively disagrees (still says the original direction,
  // or HOLD) or the call itself failed (passthrough).
  if (idea.engine !== 'gemini' || idea.action !== wantDirection) {
    addLog(mode, 'wait', name, `Reversal flip not confirmed — fresh read said ${idea.action} ${idea.confidence}%, needed ${wantDirection}`);
    return;
  }

  try {
    const details  = await fetchMarketDetails(session, [closedPos.epic]);
    const d        = details.get(closedPos.epic);
    const minDeal  = d?.minDealSize || 0.1;
    const minStop  = d?.minStopDist || 1;
    const stopDist = Math.max(idea.stopPoints, minStop);
    const stake    = calcStake(getMaxRiskGbp(mode), stopDist, minDeal);

    const result = await placeMarketOrder(session, closedPos.epic, wantDirection, stake, stopDist, idea.takeProfitPoints, 'GBP');
    addLog(mode, 'enter', name, `Reversal flip — ${wantDirection} @ ${result.level.toFixed(2)} — ${idea.reason}`);
    registerBotOpenedDeal(mode, result.dealId);
    addToWatch(mode, result.dealId);
    recordEntryConfidence(result.dealId, idea.confidence);
  } catch (e) {
    addLog(mode, 'error', name, `Reversal flip entry failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function pollAll(): Promise<void> {
  for (const mode of ['demo', 'live'] as const) {
    const ids = getWatchedDealIds(mode);
    if (!ids.length) continue;

    const session = await getOrAuthSession(mode);
    if (!session) { addLog(mode, 'error', '—', '[Gemini watch] No IG session available — skipping this cycle'); continue; }

    let positions: FullPosition[];
    try {
      positions = await fetchFullPositions(session);
    } catch (e) {
      addLog(mode, 'error', '—', `[Gemini watch] Position fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    for (const dealId of ids) {
      const p = positions.find(pos => pos.dealId === dealId);
      if (!p) { removeFromWatch(mode, dealId); continue; }  // closed elsewhere already
      // Confirmed live: an uncaught error reviewing one position (a null
      // live price crashing askGeminiPositionVerdict) silently aborted this
      // whole loop mid-cycle, skipping every remaining watched position with
      // no retry until the next scheduled poll 15min later — right when a
      // volatile market made review matter most. One position's failure
      // must never again cost every other position its review this cycle.
      try {
        await reviewOne(mode, session, p);
      } catch (e) {
        addLog(mode, 'error', p.instrumentName, `[Gemini watch] Review failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

const POLL_MS = 15 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startGeminiWatch(): void {
  if (timer) return;
  timer = setInterval(() => { void pollAll(); }, POLL_MS);
  void pollAll();
}

import * as fs from 'fs';
import * as path from 'path';
import {
  authenticate, getSession, fetchCandleHistory, fetchFullPositions,
  fetchAccountFunds, placeMarketOrder, closePosition as igClosePos,
  fetchMarketDetails, updatePositionLevels, fetchClosedTransactions,
  type IGSession, type CandleBar, type FullPosition, type MarketDetail,
} from './igApi';
import {
  rsiMeanReversionSignal, emaCrossoverSignal, orbSignal,
  vwapSignal, weeklyMomentumSignal, donchianBreakoutSignal, macdCrossoverSignal, pivotPointsSignal,
  ruleBasedAnalysisSignal, meanReversionSwingSignal,
  calcRsi, calcMacdHist, calcAtr, calcEfficiencyRatio,
  STRATEGY_META, MIN_SWING_CONFIDENCE, MIN_DAILY_EFFICIENCY_RATIO,
  type StrategySignal,
} from './alpacaStrategies';
import { MAX_HOLD_DAYS as MR_SWING_MAX_HOLD_DAYS } from './meanReversionStrategy';
import { ruleBasedAnalysis } from './ruleBasedAnalysis';
import { recordJournalEvent } from './tradeJournal';
import { edgeSizing } from './quant';
import { scanIgEpics, epicName, IG_EPICS, scoreForStrategy, LIGHTSTREAM_ELIGIBLE_EPICS, SECTOR_MAP, RULE_BASED_ANALYSIS_CONFIRMED_EPICS } from './igStrategyScanner';
// OpenAI is the acting decision-maker for this bot as of 2026-08-25 (moved
// from an earlier same-day Grok attempt — Grok proved too slow on the
// longer prompts here for a scan evaluating up to ~64 epics), with Gemini
// called only as a fallback when OpenAI's own attempt genuinely fails — see
// openai.ts's askIg* wrappers for the failover logic. Not importing the
// askGemini* functions directly here any more.
import { askIgDailyVerdict, askIgTradeIdea, askIgConfirmStockTrade } from './openai';
import { fetchBarsWithFallback, fetchYahooBars, EPIC_TO_YAHOO, EPIC_TO_ALPACA } from './yahooFetch';
import { fetchAllHeadlines } from './newsFetch';
import { createStreamManager, type StreamManager } from './igStream';
import type { CandleTick } from './scalperStrategy';
import type { AlpacaBar, Timeframe } from './alpacaApi';
import {
  isNYSEOpen, isInOpeningRange, isNearClose, hoursUntilNYSEClose, nyseVolatilityRegime,
  isDailyCheckTime, isWeeklyCheckTime, msUntilWeekendReopen, isScannerQuietWeekend,
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
    const parsed = JSON.parse(fs.readFileSync(stateFile(mode), 'utf8')) as IgStrategyConfig & { maxStockPositions?: number; maxIndexPositions?: number };
    // Migrate state files saved during the brief stock/index-split era —
    // without this, an auto-resume loading one of those files gets
    // undefined for maxPositions, which silently disables the position-cap
    // check entirely (openCount >= undefined is always false).
    if (parsed.maxPositions === undefined) {
      parsed.maxPositions = (parsed.maxStockPositions ?? 3) + (parsed.maxIndexPositions ?? 3);
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

// Manual kill-switch for this bot's own Gemini usage, independent of
// running/stopped — lets the user back off Gemini specifically (e.g.
// during a stretch of real API degradation, to stop burning daily-cap
// budget and retry latency on a service that's currently unreliable)
// without having to stop the whole bot. When paused, entry decisions fall
// back to the exact same passthrough/skip behavior already used when
// Gemini itself is genuinely unavailable — no new code path, just an
// earlier, deliberate trigger for the one that already exists. Persisted
// per mode so it survives a restart rather than silently re-enabling.
function aiPauseFile(mode: IgMode): string {
  return path.join(__dirname, '..', `ig-ai-paused-${mode}.json`);
}
function loadAiPaused(mode: IgMode): boolean {
  try { return (JSON.parse(fs.readFileSync(aiPauseFile(mode), 'utf8')) as { paused: boolean }).paused; }
  catch { return false; }
}
function saveAiPaused(mode: IgMode, paused: boolean): void {
  try { fs.writeFileSync(aiPauseFile(mode), JSON.stringify({ paused }), 'utf8'); } catch {}
}
const strategyAiPaused = new Map<IgMode, boolean>([
  ['demo', loadAiPaused('demo')],
  ['live', loadAiPaused('live')],
]);
export function isStrategyAiPaused(mode: IgMode): boolean {
  return strategyAiPaused.get(mode) ?? false;
}
export function setStrategyAiPaused(mode: IgMode, paused: boolean): void {
  strategyAiPaused.set(mode, paused);
  saveAiPaused(mode, paused);
}

// Per-epic cooldown after a losing exit — confirmed live this matters: the
// account-wide daily-loss lock is a blunt, all-instruments circuit breaker,
// so rapid repeated re-entry into the SAME instrument right after it just
// lost (no cooldown existed before this) can burn through the whole day's
// loss budget on one bad thesis, locking out genuinely different, unrelated
// opportunities for the rest of the day. This doesn't touch the daily lock
// itself — it just slows how fast one instrument can spend that budget.
const LOSS_COOLDOWN_MS = 3 * 60 * 60_000;  // 3h — long enough to stop immediate flip-flopping, short enough a same-day different setup isn't locked out for good

// Scales the cooldown by how many times in a row this exact instrument has
// just been cut — confirmed live 2026-08-25 that a flat 3h wasn't enough on
// its own: Visa got re-entered and re-closed twice more (02:24→02:39,
// 06:21→08:35) even with getRecentExitContext's own streak warning in every
// entry prompt ("2 losses in a row on this name... don't just repeat the
// same thesis"), each time simply waiting out the fixed cooldown rather
// than being deterred by the AI reading that warning. A prompt-level nudge
// clearly isn't enough to stop a determined re-entry when the scanner keeps
// re-flagging the same name as a top pick all day, so the cooldown duration
// itself now escalates instead of relying on the AI to self-moderate.
function cooldownDurationMs(streak: number): number {
  if (streak >= 3) return 24 * 3600_000; // third+ same-day failure — effectively locked out for the rest of the day
  if (streak >= 2) return 8  * 3600_000; // second in a row — well past any one intraday rally/pullback cycle
  return LOSS_COOLDOWN_MS;               // first bad exit — unchanged
}

// Minimum gap between any two gemini_opinion entries, account-wide — not
// per-epic. Confirmed live this matters: 15 entries in one session across
// many different names is far more churn than a "daily conviction"
// strategy should produce; this doesn't fix the underlying judgment, just
// stops it from rapid-firing through the whole candidate list in one bad
// stretch the way it did on 2026-08-06.
const GEMINI_ENTRY_SPACING_MS = 20 * 60_000;

// Below this, an instrument's recent price action nets out to roughly
// nowhere despite looking active — the efficiency-ratio equivalent of
// "moved a lot, went nowhere." Modest on purpose: this should filter out
// only the clearest chop, not require a strong trend — a bar this low
// still lets most real candidates through, per the concern that too
// strict a filter would starve the strategy of any trades at all.
const MIN_EFFICIENCY_RATIO = 0.22;

// lastExitReason persistence — confirmed via live evidence this was needed:
// Seagate/Marvell/Western Digital lost repeatedly across a ~2 week span,
// but sectorCooldownBlock's old window (3h, borrowed from lossCooldownEpics)
// never once saw two of them "cooling" at the same time since the losses
// were spread across days, not hours — and even that short window got
// wiped on every restart anyway, since this map was in-memory only. Now
// persisted like every other cooldown-relevant map in this file.
function lastExitReasonFile(mode: IgMode): string {
  return path.join(__dirname, '..', `ig-last-exit-reason-${mode}.json`);
}
function saveLastExitReason(mode: IgMode, map: Map<string, { reason: string; at: number; wasWin: boolean }>): void {
  try { fs.writeFileSync(lastExitReasonFile(mode), JSON.stringify([...map]), 'utf8'); } catch {}
}
function loadLastExitReason(mode: IgMode): Map<string, { reason: string; at: number; wasWin: boolean }> {
  try {
    const pairs = JSON.parse(fs.readFileSync(lastExitReasonFile(mode), 'utf8')) as [string, { reason: string; at: number; wasWin: boolean }][];
    return new Map(pairs);
  } catch { return new Map(); }
}

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

// Opportunistic cache of each epic's own dayChangePercent, filled in by
// evaluateEpic below whenever it computes one for ANY epic (demo or live —
// the underlying market fact is the same regardless of account mode, no
// reason to track it twice). Not a dedicated fetch — reuses whatever's
// already being calculated per-entry-decision. Lets a candidate's own
// evaluation see how its sector peers have moved today, even though this
// bot only evaluates one epic at a time. Confirmed live this gap matters:
// Seagate's entry reasoning called a ~5% drop "intraday pullback finding
// strong support," judged with zero visibility into Western Digital/
// Micron/Broadcom/SMCI/NVDA all being down together the same day — a real,
// broad sector unwind, not stock-specific weakness. In-memory only, same
// tradeoff as the exit-context maps above — advisory, not a safety guard.
const dayChangeCache = new Map<string, { changePercent: number; day: string }>();

function recordDayChange(epic: string, changePercent: number): void {
  dayChangeCache.set(epic, { changePercent, day: new Date().toISOString().slice(0, 10) });
}

// Average of this epic's own sector peers' cached day-changes, today only —
// stale (yesterday's) entries are excluded rather than averaged in, since a
// peer that simply hasn't been evaluated yet today is silence, not evidence
// the sector is flat. Returns undefined (not 0) when there's nothing fresh
// to compare against, so the prompt can omit the line entirely rather than
// claim a peer average of exactly 0%.
export function getPeerGroupChange(epic: string): { changePercent: number; label: string } | undefined {
  const sector = SECTOR_MAP[epic];
  if (!sector) return undefined;
  const today = new Date().toISOString().slice(0, 10);
  const peers = [...dayChangeCache.entries()].filter(([e, rec]) => e !== epic && SECTOR_MAP[e] === sector && rec.day === today);
  if (!peers.length) return undefined;
  const avg = peers.reduce((s, [, rec]) => s + rec.changePercent, 0) / peers.length;
  return { changePercent: avg, label: `${sector} peers` };
}

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
  const wasWin = upl >= 0;
  st.lastExitReason.set(epic, { reason, at: Date.now(), wasWin });
  saveLastExitReason(mode, st.lastExitReason);
  if (wasWin) { st.lossStreak.set(epic, 0); return; }
  const streak = (st.lossStreak.get(epic) ?? 0) + 1;
  st.lossStreak.set(epic, streak);
  st.lossCooldownEpics.set(epic, Date.now() + cooldownDurationMs(streak));
  saveLossCooldownEpics(mode, st.lossCooldownEpics);
}

// Cooldown after ANY watch-triggered close, win or loss — distinct from
// recordLossExit above, which only cools down on an actual loss. Built
// 2026-08-25 after Visa got opened and closed 5 times in one day (net
// -£9.24): the scanner kept re-flagging Visa as a fresh "best pick" the
// moment price cooled slightly after each close, and two of those five
// closes were technically small wins (so recordLossExit's own cooldown
// never engaged), while a third loss got re-entered just 15 minutes later
// because openRecommendation — the actual path that placed every one of
// these — never checked lossCooldownEpics at all (only the scanner's
// candidate-exclusion list did). A watch-triggered close, whichever way the
// P&L landed, means the AI just judged that specific move exhausted right
// now; re-entering the same name minutes later on a fresh signal is chasing
// that same move, not an independently-justified new setup. Reuses
// lossCooldownEpics/LOSS_COOLDOWN_MS rather than a parallel mechanism, so
// every existing consumer of that cooldown (including openRecommendation's
// new check below) picks this up automatically.
export function recordWatchClose(mode: IgMode, epic: string): void {
  const st = ms(mode);
  const count = (st.watchCloseCount.get(epic) ?? 0) + 1;
  st.watchCloseCount.set(epic, count);
  st.lossCooldownEpics.set(epic, Date.now() + cooldownDurationMs(count));
  saveLossCooldownEpics(mode, st.lossCooldownEpics);
}

// Trade journal — persists per-strategy entry/exit history with reasoning so
// a future "why did this lose" question is a query against real records, not
// a manual reconstruction from raw IG transaction history (which is all that
// existed before this). tradeJournal.ts already existed but was only ever
// wired into the old, stopped Alpaca auto-trader — never into this bot,
// despite it being the one actually live-trading.
function journalMode(mode: IgMode): 'ig-demo' | 'ig-live' {
  return mode === 'live' ? 'ig-live' : 'ig-demo';
}

function strategyFor(cfg: IgStrategyConfig, epic: string): IgStrategyName {
  return cfg.epicStrategyOverrides?.[epic] ?? cfg.strategy;
}

function journalEntry(
  mode: IgMode, cfg: IgStrategyConfig, epic: string,
  side: 'long' | 'short', qty: number, price: number, reason: string, confidence?: number,
): void {
  recordJournalEvent({
    mode: journalMode(mode), event: 'entry',
    symbol: epicName(epic), strategy: strategyFor(cfg, epic),
    side, qty, price, reason, confidence,
  });
}

// Marked by every explicit close path (journalExit/recordWatchExit) so the
// silent-close recovery below (see journalSilentCloses) can tell "already
// journaled through a real close path" apart from "vanished without any of
// our own code ever closing it" — only the latter needs recovering from IG's
// own transaction history. Shared across modes — dealIds are globally
// unique. In-memory only; worst case after a restart is one dealId that
// closed in the last instant before the restart gets treated as silent and
// re-journaled from transaction history — a harmless duplicate record, not
// a gap, and rare in practice.
const journaledDealIds = new Set<string>();

function journalExit(mode: IgMode, cfg: IgStrategyConfig, p: FullPosition, reason: string): void {
  journaledDealIds.add(p.dealId);
  const notional = p.level * p.size;
  recordJournalEvent({
    mode: journalMode(mode), event: 'exit',
    symbol: epicName(p.epic), strategy: strategyFor(cfg, p.epic),
    side: p.direction === 'BUY' ? 'long' : 'short',
    qty: p.size, price: p.level, reason,
    plUsd: p.upl,
    plPct: notional > 0 ? (p.upl / notional) * 100 : 0,
  });
}

// Same as journalExit above, but callable from geminiWatch.ts, which closes
// positions (including manually-opened ones the strategy bot never placed)
// without necessarily having this bot's own IgStrategyConfig in hand.
// Confirmed live 2026-08-25 this was a real, longstanding gap: neither
// openRecommendation's manual-open path nor Position Watch's own close ever
// called into the journal at all, despite both being real trading paths on
// this account — the journal (trade-journal-ig-live.json) had essentially
// nothing in it beyond the scanner's own auto-exits, making "does AI
// confirmation actually help" unanswerable from real data. Falls back to a
// 'gemini_watch' strategy label only when this mode has no config loaded at
// all (bot not currently running) — otherwise attributes to whatever
// strategy this epic is actually configured under, same as journalExit.
export function recordWatchExit(mode: IgMode, p: FullPosition, reason: string): void {
  journaledDealIds.add(p.dealId);
  const cfg = ms(mode).config;
  const notional = p.level * p.size;
  recordJournalEvent({
    mode: journalMode(mode), event: 'exit',
    symbol: epicName(p.epic), strategy: cfg ? strategyFor(cfg, p.epic) : 'gemini_watch',
    side: p.direction === 'BUY' ? 'long' : 'short',
    qty: p.size, price: p.level, reason,
    plUsd: p.upl,
    plPct: notional > 0 ? (p.upl / notional) * 100 : 0,
  });
}

// Last-known snapshot of every open position this bot has seen, refreshed
// every poll — the only way to know what a dealId WAS (epic/level/opened
// time) after it's already vanished from /positions, which is exactly the
// moment journalSilentCloses needs that context to match it against IG's
// transaction history. Shared across modes (dealIds are globally unique),
// in-memory only (same tradeoff as journaledDealIds above).
const lastKnownPosition = new Map<string, { epic: string; direction: 'BUY' | 'SELL'; size: number; level: number; openedAt?: string }>();

// Recovers any dealId that disappeared from /positions without ever going
// through journalExit/recordWatchExit — i.e. closed by IG itself (a
// stop-loss or take-profit actually triggering server-side) rather than by
// any of this codebase's own close paths, which previously left zero record
// of what happened. Confirmed live 2026-08-25: a Nike short's tightened stop
// was hit this way, closing for a real -£3.15 with no journal entry, no log
// line, nothing — only recoverable at all by querying IG's own transaction
// history directly. Deliberately journal-only: doesn't touch
// lossCooldownEpics/lastExitReason/lossStreak, since retroactively feeding
// those could change live entry-gating behavior in ways nobody asked for —
// this only closes the visibility gap.
async function journalSilentCloses(mode: IgMode, session: IGSession, dealIds: string[]): Promise<void> {
  if (!dealIds.length) return;
  const cfg = ms(mode).config;
  let transactions;
  try {
    // 24h back is comfortably more than any gap between polls could ever
    // need — cheap enough to over-fetch here since this only runs when
    // there's actually something to recover (rare), not every poll.
    transactions = await fetchClosedTransactions(session, new Date(Date.now() - 24 * 3600_000).toISOString());
  } catch { return; } // best-effort — next poll's pruning won't retry the same dealId (already dropped from botOpenedDeals), so a failure here just means this one stays unjournaled rather than blocking anything live

  for (const dealId of dealIds) {
    const last = lastKnownPosition.get(dealId);
    if (!last) continue; // never actually seen it open (e.g. restart lost the cache) — nothing to match against
    const name = epicName(last.epic);
    // Match by instrument + closest opening level — IG's transaction
    // history uses its own reference for the closing deal, which does NOT
    // equal the dealId this bot tracked at open time, so dealId itself
    // can't be used to look this up directly.
    const candidates = transactions.filter(t => t.instrumentName === name);
    const match = candidates.length === 1 ? candidates[0]
      : candidates.filter(t => t.openLevel !== undefined && Math.abs(t.openLevel - last.level) < Math.max(1, last.level * 0.005))[0];
    if (!match) continue; // couldn't confidently identify which transaction this was — skip rather than guess
    recordJournalEvent({
      mode: journalMode(mode), event: 'exit',
      symbol: name, strategy: cfg ? strategyFor(cfg, last.epic) : 'unknown',
      side: last.direction === 'BUY' ? 'long' : 'short',
      qty: last.size, price: match.closeLevel ?? last.level,
      reason: 'Closed outside the bot\'s own logic (broker-side stop/limit execution, or closed manually via IG\'s own app) — recovered from IG transaction history',
      plUsd: match.profitAndLoss,
      plPct: last.level > 0 ? (match.profitAndLoss / (last.level * last.size)) * 100 : 0,
    });
    journaledDealIds.add(dealId);
    addLog(mode, 'info', name, `[Journal] Recovered a silent close — £${match.profitAndLoss.toFixed(2)} (${last.level.toFixed(2)} → ${(match.closeLevel ?? last.level).toFixed(2)}), no bot code path had closed or journaled it`);
  }
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
    if (own.wasWin) {
      // Confirmed live this matters: Dell banked a profit-lock win at
      // 49410, then — with no memory of that win at all (this branch
      // didn't exist yet; a win was never recorded here) — got bought
      // again ~1.7% higher a few hours later on the same "AI server
      // momentum" thesis, chasing the tail of the same move already
      // captured rather than catching a fresh one.
      parts.push(`This instrument banked a win ${minsAgo}min ago: ${own.reason} — if reconsidering entry now, treat this as needing a clearly NEW reason. Re-entering shortly after a winning exit often means buying after the easy part of the move is already captured, not catching it fresh.`);
    } else {
      const streak = st.lossStreak.get(epic) ?? 0;
      const streakNote = streak >= 2 ? ` (${streak} losses in a row on this name)` : '';
      parts.push(`This instrument closed ${minsAgo}min ago${streakNote}: ${own.reason} — weigh this seriously. If that reasoning still holds, don't just repeat the same thesis hoping for a different result; either hold off until the picture is genuinely clearer, or if the evidence now points the other way, that direction may be the better trade instead. Only take the same direction again if the catalyst has clearly changed or resolved since then.`);
    }
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

// Hard block, not advisory — confirmed live the advisory sector context
// alone didn't stop it: Seagate/Marvell/Micron/Western Digital all got
// bought through an active, already-flagged memory-sector selloff anyway,
// each treated as an independent decision.
//
// Originally reused lossCooldownEpics (3h expiry, needed 2+ concurrently
// cooling) — confirmed live over a 2-week span this never actually fired
// for the exact cluster it was built for: Seagate/Marvell/Western Digital's
// losses landed hours to days apart, never overlapping within a 3h window,
// so "2 currently cooling" was essentially never true even after 5-6
// losses in the same sector. Sector-wide drag plays out over days, not
// hours — LOSS_COOLDOWN_MS governs re-flipping the *same* instrument
// (a genuinely different, shorter-timescale concern) and stays as-is;
// this now uses its own longer window and fires on a single recent loss
// rather than waiting for a second one to pile on top of it first.
const SECTOR_BLOCK_LOOKBACK_MS = 24 * 60 * 60_000; // 24h
// direction, when the caller already knows it, changes what this actually
// means: a sector selling off is a real reason to avoid ANOTHER long in that
// sector (chasing the same weakness that already burned a peer), but it's
// not a reason to avoid a short — sector-wide weakness is corroborating
// evidence FOR a short, not against it. Per explicit request 2026-08-25 ("if
// theres a sector wide sell of the way to deal with that is go short and
// make a profit"): only block when direction is missing (caller doesn't
// know it yet — stay conservative) or is itself a long. A short still has
// to clear every other gate downstream (allowShorts, the rule engine's own
// confidence bar, Gemini confirmation) — this only stops the sector check
// itself from vetoing a short it should actually be supporting.
function sectorCooldownBlock(mode: IgMode, epic: string, direction?: 'LONG' | 'SHORT'): string | null {
  if (direction === 'SHORT') return null;
  const st = ms(mode);
  const sector = SECTOR_MAP[epic];
  if (!sector) return null;
  const now = Date.now();
  const sectorLosses = [...st.lastExitReason.entries()]
    .filter(([e, rec]) => e !== epic && SECTOR_MAP[e] === sector && !rec.wasWin && now - rec.at <= SECTOR_BLOCK_LOOKBACK_MS)
    .sort((a, b) => b[1].at - a[1].at);
  if (sectorLosses.length < 1) return null;
  const names = sectorLosses.map(([e]) => epicName(e)).join(', ');
  return `${sectorLosses.length} other ${sector} name(s) lost within the last 24h (${names}) — sector-wide weakness, skipping new entries here too`;
}

// Whole-bot pause (no new entries, existing positions still managed) —
// added 2026-08-28: this was in-memory only (reset to false by
// makeModeState on every restart), which silently undid a manual pause put
// in place specifically so the mean-reversion bots could take priority —
// confirmed live twice in one session (a routine pm2 restart for an
// unrelated deploy quietly re-enabled entries both times). Same
// load-once-at-startup / save-on-toggle pattern as pausedEpics below.
function pausedFile(mode: IgMode): string {
  return path.join(__dirname, '..', `ig-bot-paused-${mode}.json`);
}
function savePaused(mode: IgMode, paused: boolean): void {
  try { fs.writeFileSync(pausedFile(mode), JSON.stringify({ paused }), 'utf8'); } catch {}
}
function loadPaused(mode: IgMode): boolean {
  try { return (JSON.parse(fs.readFileSync(pausedFile(mode), 'utf8')) as { paused: boolean }).paused; }
  catch { return false; }
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

export type IgStrategyName = 'rsi_mean_reversion' | 'ema_crossover' | 'orb' | 'vwap' | 'weekly_momentum' | 'donchian_breakout' | 'donchian_hourly' | 'macd_crossover' | 'pivot_points' | 'gemini_opinion' | 'rule_based_analysis' | 'gemini_confirmed' | 'mean_reversion_swing';

// Fixed watchlist for mean_reversion_swing — deliberately NOT scan-and-score
// picked the way every other strategy's watchlist is. The original strategy
// (meanReversionBot.ts's 'stocks' instance, and bot_ig.py before it) never
// scanned/ranked candidates at all; it always watched a fixed universe and
// let the RSI(2)/EMA200 rule itself decide which of them actually has a
// signal on a given day. Scan-and-score would rank by scoreMeanReversionSwing's
// flat "signal fired or didn't" score, which doesn't reflect the original
// design and would just narrow this back down to whatever handful happen to
// be signalling at the exact moment the scan runs — the opposite of "watch
// the same large list."
//
// Started as a hand-picked 26-name copy of meanReversionBot.ts's own
// stocks universe, then widened per explicit follow-up request 2026-08-28
// ("the 150 or whatever the gemini bots... were watching") to the FULL
// IG_EPICS list instead — the same 72-name universe gemini_confirmed/
// rule_based_analysis already scan on this exact bot (confirmed live there
// is no real "150" on the IG side — IG epics have to be individually
// verified as real dealable codes, unlike Alpaca's arbitrary-ticker
// universe; 72 is the actual verified count, and the user's explicit choice
// once told that was to use all of it rather than the smaller hand-picked
// list or the Alpaca-side strategy instead).
export const MEAN_REVERSION_WATCHLIST = IG_EPICS.map(e => e.epic);
export type IgMode         = 'demo' | 'live';

export type IgStrategyConfig = {
  mode:             IgMode;
  strategy:         IgStrategyName;
  epics:            string[];   // populated by scanner at start
  // Pins specific epics to a different strategy than the bot's own default
  // above — e.g. running rule_based_analysis as the default (restricted to
  // RULE_BASED_ANALYSIS_CONFIRMED_EPICS) while a handful of names that
  // didn't backtest confirmed-profitable under that engine still get
  // Gemini's own judgment instead of being dropped outright. Resolved once
  // per epic at the top of evaluateEpic; every cfg.strategy check
  // downstream (in evaluateEpic and executeIgSignal, which both receive
  // the already-resolved cfg) then naturally applies to the right one —
  // see evaluateEpic's own comment for why a local reassignment there is
  // safe (doesn't mutate the shared config object).
  epicStrategyOverrides?: Partial<Record<string, IgStrategyName>>;
  // Max £ lost if the stop is hit — NOT a notional-exposure target. Stake is
  // derived as maxRiskGbp ÷ stop-distance-in-points, which is scale-agnostic
  // (works correctly for FX at ~1.3 with a 0.0001 point size, and indices at
  // ~10,000 with a 1.0 point size alike) unlike a price-based notional calc.
  maxRiskGbp:       number;
  // Single shared cap across every open position regardless of asset class.
  // Previously split into separate stock/index pools, but the "stock" pool
  // was really "everything not IX.D.-prefixed" — FX pairs (EUR/GBP) and
  // commodities (Silver) counted as "stock" and could fill that pool while
  // the index pool sat empty with real stock candidates locked out. One
  // pool is simpler and matches how the user actually thinks about it.
  maxPositions: number;
  allowShorts:      boolean;
  maxDailyLossPct?: number;    // circuit breaker: no new entries after balance drops this % from day start (default 3)
  // Mirror of maxDailyLossPct on the upside — once today's banked gain
  // reaches this, stop opening new positions for the rest of the day
  // (existing positions/exits still managed as normal). User call
  // (2026-08-14): too many days were giving back a good early win by
  // continuing to trade afterward — wants one clean profitable day, not
  // several small wins ground down by later losers. Default £40.
  dailyProfitTargetGbp?: number;
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
  // Read-only context shown next to the recommendation so a manual
  // "Open Position" click isn't made blind to why the stock's actually
  // moving — deliberately NOT a gate on the signal itself (that's what
  // gemini_opinion is for; this strategy's backtested edge was validated
  // on pure technicals with no news filter, and bolting one on here would
  // mean trading a different strategy than the one that was tested).
  // Undefined for IG-only instruments (indices/commodities) with no
  // ticker to fetch headlines against.
  headlines?:       string[];
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
  profitLock: boolean;   // daily-profit target already banked — no new entries today
  maxDailyLossPct: number;   // current effective limit (config override, or the default 3)
  dailyProfitTargetGbp: number;   // current effective target (config override, or the default 40)
  dayStartBalance: number;   // account balance at today's UTC-day boundary — 0 until the first poll of the day
  recommendations: IgRecommendation[];
  dailyPick:  IgRecommendation | null;
  pausedEpics: string[];
  // Deal IDs the bot will auto-manage (opened by the bot itself, or
  // explicitly released) — anything open but NOT in this list is a
  // manually-opened position the bot is deliberately leaving alone.
  managedDeals: string[];
  aiPaused:   boolean;   // manual Gemini kill-switch for this bot's own entries — see isStrategyAiPaused
  // Latest position-watch verdict per watched dealId, keyed by dealId — see
  // geminiWatch.ts's getWatchVerdicts. Surfaces which provider actually
  // answered (gemini/openai/xai/passthrough), not a fixed assumption.
  positionWatch: Record<string, { action: string; confidence: number; reason: string; engine: string; at: number }>;
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
  // Periodic re-scan of the actively-TRADED candidate list, independent of
  // the main poll cycle — see refreshWatchlist. Without this, cfg.epics is
  // a one-time snapshot taken only at bot start and never changes again
  // until the next restart, however long that is. Confirmed live this cost
  // a real opportunity: Micron scored high enough to make the watchlist at
  // 08-11 14:18, dropped off during several unrelated restarts that
  // evening, and then sat completely unwatched through the entire next
  // morning's NYSE session (16.5h with zero re-scans) — by the time an
  // unrelated restart happened to bring it back at 08-12 14:47, its gap-up
  // had already mostly played out.
  watchlistRefreshTimer: ReturnType<typeof setInterval> | null;
  // Fast-interval exit-only check (self-heal, stuck-loss flag, weak-open
  // tighten, profit-lock trail) — independent of the main poll cycle, same
  // reasoning as severeLossTimer above. See manageSwingExits/swingExitMonitor.
  swingExitMonitorTimer: ReturnType<typeof setTimeout> | null;
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
  lastExitReason:       Map<string, { reason: string; at: number; wasWin: boolean }>;
  // Consecutive losses per epic, reset to 0 on a win — see recordLossExit.
  lossStreak:           Map<string, number>;
  // Same-day watch-triggered close count per epic, win or loss — unlike
  // lossStreak this does NOT reset on a win, since a win here still means
  // the AI had to proactively bail out of an already-overextended position;
  // interspersing small wins with losses (exactly what happened with Visa,
  // 2026-08-25) doesn't mean the underlying "keeps getting bought back into
  // the same exhausted move" problem has gone away. See recordWatchClose.
  watchCloseCount:      Map<string, number>;
  // Epoch ms of the last gemini_opinion entry, account-wide (not per-epic) —
  // see GEMINI_ENTRY_SPACING_MS. Confirmed live this matters: 15 entries in
  // one session, several different names within the same hour, is far more
  // churn than a "daily conviction" strategy should produce.
  lastGeminiEntryAt:    number;
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
  profitLock:           boolean;  // true = today's profit target already banked — no new entries until the next trading day
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
    log: [], pollTimer: null, severeLossTimer: null, watchlistRefreshTimer: null, swingExitMonitorTimer: null, nextRunMs: null, lastPollTs: null,
    orbState: {}, authFailCount: 0, sessionRefreshTimer: null,
    marketDetails: new Map(),
    blockedEpics: new Map(),
    lossCooldownEpics: new Map(),
    lastExitReason: new Map(),
    lossStreak: new Map(),
    watchCloseCount: new Map(),
    lastGeminiEntryAt: 0,
    recommendations: new Map(),
    dailyPick: null, dailyPickDate: '',
    lastEntryTrigger: new Map(),
    pausedEpics: new Set(),
    dayKey: '', dayStartBalance: 0, lossLock: false, profitLock: false,
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
  st.lastExitReason  = loadLastExitReason(mode);
  st.pausedEpics     = loadPausedEpics(mode);
  st.paused          = loadPaused(mode);
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
  pivot_points:       { resolution: 'DAY',       count: 30 },
  // MINUTE_30 (IG's documented resolution enum) + count 240 = 5 days of
  // 30-min bars — see STRATEGY_META.gemini_opinion in alpacaStrategies.ts
  // for why this strategy specifically needs finer-than-hourly bars and a
  // wider lookback. In practice this raw-IG-REST path is a rare fallback:
  // gemini_opinion's real universe is almost entirely Alpaca/Yahoo-covered
  // (see FREE_DATA_PARAMS/usesFreeData/usesYahooScaled below), so this
  // barely touches IG's own allowance-limited candle API.
  gemini_opinion:     { resolution: 'MINUTE_30',  count: 240 },
  // 250 daily bars (~1y) — see FREE_DATA_PARAMS.rule_based_analysis; this
  // strategy is Yahoo/Alpaca-covered in practice (usesFreeData), so this
  // IG-native resolution/count barely gets used, same as gemini_opinion.
  rule_based_analysis: { resolution: 'DAY', count: 250 },
  // Same daily/250-bar shape as rule_based_analysis — built on the exact
  // same underlying scoring, just with a Gemini confirmation layer on top.
  gemini_confirmed:    { resolution: 'DAY', count: 250 },
  // 210 = meanReversionStrategy.ts's own MIN_BARS_NEEDED (200-day EMA + 10
  // buffer) — same shape as rule_based_analysis/gemini_confirmed above,
  // this strategy is Yahoo/Alpaca-covered in practice (see FREE_DATA_PARAMS
  // below), so this IG-native path is a rare fallback too.
  mean_reversion_swing: { resolution: 'DAY', count: 210 },
};

// Free-data params for strategies that need something other than the daily
// bars fetchBarsWithFallback defaults to — see the free-data branch in
// evaluateEpic and refreshRecommendations. Every strategy gets an entry now
// (not just the hourly one) — IG's own candle API is allowance-limited and
// intraday strategies poll far more often than daily ones, which is exactly
// what makes them the most likely to burn through it (confirmed live:
// daily-timeframe polling alone was already tripping the allowance before
// this existed at all).
const FREE_DATA_PARAMS: Partial<Record<IgStrategyName, { range: string; alpacaTimeframe: Timeframe; yahooInterval: '1m' | '5m' | '30m' | '1h' | '1d' | '1wk'; includePrePost?: boolean }>> = {
  rsi_mean_reversion: { range: '1mo', alpacaTimeframe: '5Min', yahooInterval: '5m' },
  orb:                { range: '5d',  alpacaTimeframe: '1Min', yahooInterval: '1m' },
  vwap:               { range: '5d',  alpacaTimeframe: '1Min', yahooInterval: '1m' },
  weekly_momentum:    { range: '5y',  alpacaTimeframe: '1Week', yahooInterval: '1wk' },
  donchian_hourly:    { range: '1mo', alpacaTimeframe: '1Hour', yahooInterval: '1h' },
  // No entry needed here — like ema_crossover/donchian_breakout/macd_crossover,
  // this daily-timeframe strategy falls through to fetchBarsWithFallback's
  // own '6mo'/1Day default when absent from this map (see the `freeParams
  // ? ... : fetchBarsWithFallback(epic, '6mo')` fallback at each call site).
  // 30-min bars, not hourly — see STRATEGY_META.gemini_opinion for why.
  // Yahoo's 30m interval is only available for ~60 days back, well within
  // this 1-month range request. includePrePost: true so IG's "24 Hour" US
  // share CFDs (live/dealable well outside regular NASDAQ hours — confirmed
  // live) get fresh extended-hours bars instead of sitting on a stale
  // Friday-close bar until 13:30 UTC — see fetchBarsWithFallback's
  // includePrePost doc for why this also routes around Alpaca entirely.
  gemini_opinion:     { range: '1mo', alpacaTimeframe: '30Min', yahooInterval: '30m', includePrePost: true },
  // Needs ~250 daily bars for its SMA200 trend filter to actually be
  // populated (see STRATEGY_META.rule_based_analysis) — every other daily
  // strategy's 6mo default (~126 trading days) isn't enough.
  rule_based_analysis: { range: '2y', alpacaTimeframe: '1Day', yahooInterval: '1d' },
  // Same 2y/daily need as rule_based_analysis — same underlying scoring,
  // same SMA200 trend filter requirement.
  gemini_confirmed:    { range: '2y', alpacaTimeframe: '1Day', yahooInterval: '1d' },
  // 2y daily bars — needs a real 200-day EMA read (meanReversionStrategy.ts's
  // MIN_BARS_NEEDED=210), same reasoning as rule_based_analysis/gemini_confirmed
  // above; the 6mo default (~126 trading days) would never be enough.
  mean_reversion_swing: { range: '2y', alpacaTimeframe: '1Day', yahooInterval: '1d' },
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

  // rule_based_analysis deliberately excluded — this pre-check only ever
  // fetches 6mo of bars (line above), but that strategy needs ~250 daily
  // bars for its SMA200 trend filter to be populated. Including it here
  // would make it permanently HOLD on every pre-check (insufficient bars),
  // silently blocking the real evaluation from ever running outside the
  // guaranteed once-daily window. Falls to default: null, which skips this
  // opportunistic path but still gets a proper full-history evaluation
  // once a day via isDailyCheckTime() — fine for a daily-bar strategy with
  // no new information intraday anyway.
  switch (strategy) {
    case 'ema_crossover':      return emaCrossoverSignal(bars, inPosition, side).action;
    case 'donchian_breakout':  return donchianBreakoutSignal(bars, inPosition, side).action;
    case 'macd_crossover':     return macdCrossoverSignal(bars, inPosition, side).action;
    case 'pivot_points':       return pivotPointsSignal(bars, inPosition, side).action;
    default:                   return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 8); }
function now() { return new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Europe/London' }); }

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

// Demo-credentialed session even when mode is 'live' — mirrors
// fxScalperBot.ts's identical reasoning: IG's own REST candle endpoint is
// allowance-limited, so touching it from live's own account for a read
// defeats the entire point of ever routing around that allowance. Demo's
// allowance is independent and has headroom; the live account's own
// allowance is never touched via this helper. Shared by
// prewarmLightstreamBuffer and evaluateEpic's raw-IG fallback below — the
// latter used to call fetchCandleHistory with the live session directly,
// confirmed live 2026-08-18 as what let Japan 225 drain the live account's
// allowance (Nokia hit the identical error before it got a Yahoo mapping —
// this fallback branch was always one missing free-data entry away from
// repeating it on whatever epic slipped through next).
async function getDemoDataSession(mode: IgMode): Promise<IGSession | null> {
  if (mode === 'demo') {
    const st = ms(mode);
    return st.session ?? null;
  }
  const existing = getSession('igstrat-data:live');
  if (existing && Date.now() < existing.expiresAt - 2 * 60_000) return existing;
  const creds = resolveCredentials('demo');
  if (!creds.apiKey) return null;
  return authenticate(creds.apiKey, creds.username, creds.password, creds.env, 'igstrat-data:live');
}

// One-time seed so a freshly-subscribed epic doesn't have to wait ~40 hours
// accumulating live ticks from nothing before a strategy can evaluate it.
async function prewarmLightstreamBuffer(mode: IgMode, epic: string, count: number): Promise<void> {
  const st = ms(mode);
  // Same blockedEpics cooldown evaluateEpic's own allowance gate uses —
  // this call site was missing it (found 2026-08-19 auditing the FX bot's
  // near-identical bug, prewarmCandles in fxScalperBot.ts): a restart while
  // the candle buffer hadn't filled yet re-attempted this on every restart
  // regardless of a previous allowance failure, same failure shape that
  // exhausted the demo account that day. Currently dormant in practice
  // (only donchian_hourly reaches this path — gemini_opinion was already
  // moved off Lightstream for the same reason, see usesLightstream's own
  // comment above), but closing it now rather than waiting for it to bite
  // the same way once donchian_hourly is used again.
  const unblockAt = st.blockedEpics.get(epic);
  if (unblockAt !== undefined && Date.now() < unblockAt) return;
  try {
    const dataSession = await getDemoDataSession(mode);
    if (!dataSession) return;
    const bars = await fetchCandleHistory(dataSession, epic, 'HOUR', count);
    if (bars.length) st.candleBuffers.set(epic, bars.map(b => candleBarToTick(epic, b)));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    addLog(mode, 'info', epicName(epic), `Lightstream prewarm skipped: ${msg}`);
    if (msg.toLowerCase().includes('allowance')) {
      st.blockedEpics.set(epic, Date.now() + BLOCK_COOLDOWN_MS);
      saveBlockedEpics(mode, st.blockedEpics);
    }
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
export function calcStake(maxRiskGbp: number, stopDist: number, minStake = 0.1): number {
  if (stopDist <= 0) return minStake;
  const raw = maxRiskGbp / stopDist;
  return Math.max(minStake, Math.round(raw * 100) / 100);
}

// Same purpose as isLossLocked below — geminiWatch.ts's reversal-flip needs
// to respect both daily circuit breakers before opening a fresh position of
// its own, not just the loss one.
export function isProfitLocked(mode: IgMode): boolean {
  return ms(mode).profitLock;
}
export function getMaxRiskGbp(mode: IgMode): number {
  return ms(mode).config?.maxRiskGbp ?? 20;
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
    addLog(mode, 'info', '—', `Session refreshed — expires ${new Date(st.session.expiresAt).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Europe/London' })}`);
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
      // Demo-sourced even in live mode — see getDemoDataSession's own
      // comment. Not currently reachable from gemini_opinion (ORB isn't the
      // active live strategy), but fixed for the same reason as the
      // weekly_momentum branch below in evaluateEpic.
      const dataSession = await getDemoDataSession(mode);
      if (!dataSession) continue;
      const raw  = await fetchCandleHistory(dataSession, epic, 'MINUTE', 60);
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

  // rule_based_analysis: restrict the recommendations sweep the same way
  // scanIgEpics restricts the actual trading watchlist — no point
  // surfacing a "recommendation" on an instrument this exact strategy's
  // own backtest confirmed was a loser (see RULE_BASED_ANALYSIS_CONFIRMED_EPICS).
  const candidates = IG_EPICS.map(e => e.epic)
    .filter(epic => !heldEpics.has(epic) && !st.pausedEpics.has(epic))
    .filter(epic => cfg.strategy !== 'rule_based_analysis' || RULE_BASED_ANALYSIS_CONFIRMED_EPICS.has(epic));
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
      for (const [epic, d] of details) if (typeof d.bid === 'number' && typeof d.offer === 'number') yahooRefPrices.set(epic, (d.bid + d.offer) / 2);
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
        // Demo-sourced even in live mode — see getDemoDataSession's own
        // comment. Same class of gap as evaluateEpic's fallback: this
        // scanner ranks every candidate, including ones with no free-data
        // mapping yet, so it's an independent path to the same live-
        // allowance drain that Japan 225 caused, not covered by fixing
        // evaluateEpic alone.
        const dataSession = await getDemoDataSession(mode);
        if (!dataSession) throw new Error('No demo session available for bar fetch');
        bars = (await fetchCandleHistory(dataSession, epic, resolution, count)).map(igBarToAlpacaBar);
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
        case 'pivot_points':       signal = pivotPointsSignal(bars, false); break;
        case 'rule_based_analysis': signal = ruleBasedAnalysisSignal(bars, false); break;
        // Read-only preview only — shows what the rule layer thinks;
        // actual execution in evaluateEpic also requires Gemini's
        // confirmation on top of this, which isn't worth spending a real
        // Gemini call on for every candidate this recommendations sweep
        // considers.
        case 'gemini_confirmed':   signal = ruleBasedAnalysisSignal(bars, false); break;
        default: break;  // orb/weekly_momentum need extra state this scan doesn't track
      }

      if (signal && (signal.action === 'BUY' || signal.action === 'SELL')) {
        found++;
        // Read-only context only — see IgRecommendation.headlines' own
        // comment. Only fetched for the (few) epics that actually produce
        // a signal, not the whole candidate pool, and failure here should
        // never cost the recommendation itself.
        const ticker = EPIC_TO_ALPACA[epic];
        let headlines: string[] | undefined;
        if (ticker) {
          try { headlines = await fetchAllHeadlines(ticker, 3, name); } catch {}
        }
        addRecommendation(st.recommendations, {
          epic, name, action: signal.action, reason: signal.reason,
          level: bars[bars.length - 1].c,
          stopPrice: signal.stopPrice, takeProfitPrice: signal.takeProfitPrice,
          computedAt: new Date().toISOString(),
          score: scoreForStrategy(cfg.strategy, bars, epic, name),
          headlines,
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

    // Confirmed live 2026-08-25 this check was missing entirely — Visa got
    // opened and closed 5 times in one day through this exact function
    // (every one logged "Manually opened from recommendation"), because
    // this was the one entry path in the whole file that never consulted
    // lossCooldownEpics (the scanner's own candidate list already excludes
    // cooling-down epics — see its exclude-list build — but a recommendation
    // already sitting in st.recommendations bypasses that scan entirely).
    const coolUntil = st.lossCooldownEpics.get(epic);
    if (coolUntil && Date.now() < coolUntil) {
      return { ok: false, error: `Recently closed on this instrument — cooling down until ${new Date(coolUntil).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} before re-entering` };
    }

    // The recommendations sweep deliberately skips Gemini confirmation per
    // candidate (see refreshRecommendations' own comment — not worth a real
    // call for every idea a wide scan considers), which means clicking
    // "Open Position" was sending the raw rule signal straight to the
    // broker with none of the news-aware check that automatic entries get
    // — confirmed live this is exactly how a GOOGL SELL went through
    // repeatedly while the stock was breaking out on genuinely bullish
    // news. Run that same check here, once, only for the idea actually
    // being acted on. Fails closed like every other Gemini gate in this
    // file — an unconfirmed manual entry is worse than a blocked one.
    if (isStrategyAiPaused(mode)) {
      return { ok: false, error: 'AI paused for this bot — resume to open recommendations again' };
    }
    const ticker    = EPIC_TO_ALPACA[epic];
    let headlines: string[] = [];
    try { if (ticker) headlines = await fetchAllHeadlines(ticker, 5, name); } catch {}
    const confirmVerdict = await askIgDailyVerdict({
      instrumentName: name,
      direction:      rec.action,
      strength:       70,
      price:          rec.level,
      changePercent:  0,
      stopPoints:     rec.stopPrice       !== undefined ? Math.abs(rec.level - rec.stopPrice)       : rec.level * 0.02,
      tpPoints:       rec.takeProfitPrice !== undefined ? Math.abs(rec.level - rec.takeProfitPrice) : rec.level * 0.03,
      headlines,
    });
    addLog(mode, 'info', name, `[AI] ${confirmVerdict.direction} ${confirmVerdict.confidence}% — ${confirmVerdict.reason} (${confirmVerdict.engine})`);
    if (confirmVerdict.engine === 'passthrough') {
      return { ok: false, error: `Gemini unavailable (${confirmVerdict.reason}) — not opening unconfirmed` };
    }
    if (confirmVerdict.direction !== rec.action || confirmVerdict.confidence < 50) {
      return { ok: false, error: `Gemini vetoed — ${confirmVerdict.direction} ${confirmVerdict.confidence}%: ${confirmVerdict.reason}` };
    }

    const details = await fetchMarketDetails(st.session, [epic]);
    const detail  = details.get(epic);
    // `||` not `??` — confirmed live a stake of 0.05 got through despite
    // this clamp existing, on an instrument (Amazon) whose real minDealSize
    // is 0.24. IG never legitimately returns 0 for these, so if it ever
    // does, `??` treats that as a real value and skips the fallback,
    // silently turning the clamp into a no-op.
    const minDeal = detail?.minDealSize || 0.5;
    const minStop = detail?.minStopDist || 1;
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
    journalEntry(mode, cfg, epic, rec.action === 'BUY' ? 'long' : 'short', stake, level,
      'Manually opened from recommendation', confirmVerdict.confidence);
    try { const { addToWatch } = await import('./geminiWatch'); addToWatch(mode, dealId); } catch {}
    st.recommendations.delete(epic);

    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    addLog(mode, 'error', name, `Manual open from recommendation failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

// Auto-executes whatever's currently sitting in the Recommended list,
// same execution path (openRecommendation) the manual "Open Position"
// button uses — re-priced against the live market, sized off maxRiskGbp,
// enrolled in Gemini Position Watch same as any other entry. The one real
// difference from a manual click: this respects the same position cap
// the main watchlist obeys (a manual click deliberately bypasses it, since
// a human clicking is itself the override) — without that check here, an
// unattended loop could keep stacking positions off a recommendation list
// that scans a much wider universe than cfg.epics.
// Runs on both demo and live — extended to live on explicit request after
// running demo-only first. Still gated by the same position cap and
// maxRiskGbp sizing as everything else this bot does on live money.
async function autoOpenRecommendations(mode: IgMode): Promise<void> {
  const st = ms(mode);
  if (!st.running || !st.session || !st.config) return;
  const cfg = st.config;

  let livePositions;
  try { livePositions = await fetchFullPositions(st.session); } catch { return; }
  let count = livePositions.length;

  // Ranked by score, best first — confirmed live this previously just took
  // whatever order the recommendations happened to sit in (Map insertion
  // order, i.e. essentially whichever epic's scan finished first), not
  // which one was actually the strongest idea. With N free slots and more
  // than N recommendations, that meant a mediocre-but-early idea could take
  // a slot a stronger-but-later one deserved more.
  const ranked = [...st.recommendations.values()].sort((a, b) => b.score - a.score);

  for (const rec of ranked) {
    if (!st.running) break;
    if (count >= cfg.maxPositions) continue;
    const result = await openRecommendation(mode, rec.epic);
    if (result.ok) count++;
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

// Live override for the daily-loss circuit breaker — takes effect on the
// very next poll cycle (evaluateEpic/poll both read st.config directly each
// time, not a snapshot taken at start), no restart needed. Persisted so it
// survives a PM2 restart/auto-resume rather than silently reverting to the
// default.
// Clamped 0.5-20%: below 0.5 the breaker would trip on completely ordinary
// day-to-day noise; above 20 it's not really acting as a circuit breaker
// any more. An explicit update while currently locked is treated as a
// deliberate "let it keep trading today" decision and clears the lock right
// away, without re-fetching the live balance to double-check first — this
// is safe either way, since the very next poll re-runs the same ddPct >=
// maxLossPct check regardless and will just re-trip the lock immediately if
// the new limit still doesn't actually cover today's drawdown.
export function updateMaxDailyLossPct(mode: IgMode, pct: number): { ok: boolean; error?: string } {
  const st = ms(mode);
  if (!st.config) return { ok: false, error: 'Bot not running — start it first' };
  if (!Number.isFinite(pct)) return { ok: false, error: 'Invalid percentage' };
  const clamped = Math.min(20, Math.max(0.5, pct));
  st.config.maxDailyLossPct = clamped;
  saveIgState(mode, st.config);
  if (st.lossLock) {
    st.lossLock = false;
    addLog(mode, 'info', '—', `Daily loss limit changed to ${clamped}% — unlocking new entries for the rest of today`);
  } else {
    addLog(mode, 'info', '—', `Daily loss limit changed to ${clamped}%`);
  }
  return { ok: true };
}

// Live override for the daily-profit lock — same shape as
// updateMaxDailyLossPct above, takes effect on the very next poll cycle.
// Clamped to a sane £5-£1000 band; an explicit update while currently
// locked is treated as a deliberate "let it keep trading today" decision
// and clears the lock immediately, same reasoning as the loss-limit setter.
export function updateDailyProfitTargetGbp(mode: IgMode, gbp: number): { ok: boolean; error?: string } {
  const st = ms(mode);
  if (!st.config) return { ok: false, error: 'Bot not running — start it first' };
  if (!Number.isFinite(gbp)) return { ok: false, error: 'Invalid amount' };
  const clamped = Math.min(1000, Math.max(5, gbp));
  st.config.dailyProfitTargetGbp = clamped;
  saveIgState(mode, st.config);
  if (st.profitLock) {
    st.profitLock = false;
    addLog(mode, 'info', '—', `Daily profit target changed to £${clamped} — unlocking new entries for the rest of today`);
  } else {
    addLog(mode, 'info', '—', `Daily profit target changed to £${clamped}`);
  }
  return { ok: true };
}

const RECOMMENDATION_REFRESH_MS = 30 * 60_000;  // full-universe sweep every 30min — cheap for free-data names, cooldown-gated for IG-only ones
let recommendationTimer: ReturnType<typeof setInterval> | null = null;

export function startRecommendationRefresh(): void {
  if (recommendationTimer) return;
  recommendationTimer = setInterval(() => {
    if (isScannerQuietWeekend()) return;  // nothing tradeable to scan for — see isScannerQuietWeekend
    for (const mode of ['demo', 'live'] as const) {
      // Sequenced, not fire-and-forget in parallel — autoOpenRecommendations
      // needs this cycle's fresh st.recommendations, not whatever's left
      // over from 30min ago.
      void (async () => {
        await refreshRecommendations(mode);
        await autoOpenRecommendations(mode);
      })();
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

  // Resolve this specific epic's effective strategy and rebind the local
  // `cfg` parameter to it — every cfg.strategy check for the rest of this
  // function, and in executeIgSignal (which receives this same rebound
  // object below), then transparently applies to whichever strategy this
  // epic is actually pinned to. Safe: reassigning a function parameter to
  // a new object only changes this call's local binding, it does not
  // mutate the original config object other concurrent/later calls still
  // hold a reference to.
  const effectiveStrategy = cfg.epicStrategyOverrides?.[epic] ?? cfg.strategy;
  if (effectiveStrategy !== cfg.strategy) cfg = { ...cfg, strategy: effectiveStrategy };

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
    const liveLevel = typeof live?.bid === 'number' && typeof live?.offer === 'number' ? (live.bid + live.offer) / 2 : undefined;
    const freeParams    = FREE_DATA_PARAMS[cfg.strategy];
    const fallbackBars  = freeParams
      ? await fetchBarsWithFallback(epic, freeParams.range, { ...freeParams, liveReferenceLevel: liveLevel })
      : await fetchBarsWithFallback(epic, '6mo', { liveReferenceLevel: liveLevel });
    if (!fallbackBars?.length) { addLog(mode, 'wait', epicName(epic), 'No bar data (Yahoo unavailable or unscalable — no live IG quote yet)'); return; }
    bars = fallbackBars.slice(-count);
  } else {
    try {
      // Demo-sourced even in live mode — see getDemoDataSession's own
      // comment. This is the last-resort path for whatever hasn't got a
      // free-data mapping yet, so it's exactly the branch most likely to
      // hit an epic nobody's added coverage for — must not be the one place
      // that still touches the live account's own allowance for a read.
      const dataSession = await getDemoDataSession(mode);
      if (!dataSession) { addLog(mode, 'wait', epicName(epic), 'No bar data (demo session unavailable)'); return; }
      bars = (await fetchCandleHistory(dataSession, epic, resolution, count)).map(igBarToAlpacaBar);
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
      // Not currently reachable from live (gemini_opinion is the only live
      // strategy today), but demo-sourced anyway so a future strategy
      // switch can't reopen the same live-allowance gap fixed elsewhere in
      // this function.
      let dailyBars: AlpacaBar[] = [];
      try {
        const dataSession = await getDemoDataSession(mode);
        if (dataSession) dailyBars = (await fetchCandleHistory(dataSession, epic, 'DAY', 30)).map(igBarToAlpacaBar);
      } catch {}
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

    case 'pivot_points':
      signal = pivotPointsSignal(bars, inPosition, side);
      break;

    case 'rule_based_analysis':
      signal = ruleBasedAnalysisSignal(bars, inPosition, side);
      break;

    // Two-layer entry, built per explicit request: give stocks the same
    // structure that's made the FX swing bot's own entries meaningfully
    // more reliable than gemini_opinion's from-scratch approach — rules
    // qualify a real setup first, Gemini only confirms or vetoes it with
    // context the rules can't see (real news, sector-peer correlation),
    // rather than inventing a thesis on its own. Exits reuse
    // ruleBasedAnalysisSignal's own thesis-recheck directly — same
    // underlying engine, so a position closes the moment the rule-based
    // bias itself flips away from the held side.
    case 'gemini_confirmed': {
      if (inPosition) { signal = ruleBasedAnalysisSignal(bars, true, side); break; }
      if (isStrategyAiPaused(mode)) { signal = { action: 'HOLD', reason: 'AI paused for this bot — resume to evaluate entries again' }; break; }

      const candles = bars.map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
      let analysis;
      try { analysis = ruleBasedAnalysis('', candles); } catch (e) {
        signal = { action: 'HOLD', reason: `Rule analysis failed: ${e instanceof Error ? e.message : String(e)}` };
        break;
      }
      const swing = analysis.swing;
      if (swing.direction === 'FLAT') {
        signal = { action: 'HOLD', reason: swing.reasoning || `${analysis.bias} bias — no clear swing setup` };
        break;
      }
      // Below this bar, don't even spend a Gemini call — nothing to
      // confirm if the rules themselves aren't convinced. Same floor
      // pure rule_based_analysis now requires to actually trade.
      if (swing.confidence < MIN_SWING_CONFIDENCE) {
        signal = { action: 'HOLD', reason: `${swing.direction} bias but only ${swing.confidence}/10 rule confidence — below the ${MIN_SWING_CONFIDENCE}/10 bar to even ask Gemini to confirm` };
        break;
      }
      // Same chop gate rule_based_analysis now has — checked here too,
      // before spending a Gemini call, not after.
      const geminiConfirmedEfficiency = calcEfficiencyRatio(bars, 20);
      if (geminiConfirmedEfficiency !== null && geminiConfirmedEfficiency < MIN_DAILY_EFFICIENCY_RATIO) {
        signal = { action: 'HOLD', reason: `${swing.direction} bias but too choppy over the last month — efficiency ratio ${geminiConfirmedEfficiency.toFixed(2)} < ${MIN_DAILY_EFFICIENCY_RATIO} (moved a lot, went nowhere) — not even worth asking Gemini` };
        break;
      }

      // swing.direction is already known here (unlike the other two call
      // sites below, which decide direction only after this point) — pass
      // it through so sector weakness only blocks another long, not a short
      // the rule engine already independently wants to take.
      const sectorBlock = sectorCooldownBlock(mode, epic, swing.direction);
      if (sectorBlock) { signal = { action: 'HOLD', reason: sectorBlock }; break; }

      const last  = candles[candles.length - 1].close;
      const rsi   = calcRsi(bars, 14);
      const macd  = calcMacdHist(bars, 12, 26, 9);
      const ticker    = EPIC_TO_ALPACA[epic];
      const headlines = ticker ? await fetchAllHeadlines(ticker, 8, epicName(epic)) : [];
      const todayUtc    = new Date().toISOString().slice(0, 10);
      const todaysBars  = bars.filter(b => b.t.slice(0, 10) === todayUtc);
      const dayOpen     = todaysBars[0]?.o ?? bars[0]?.o;
      const dayChangePercent = dayOpen ? ((last - dayOpen) / dayOpen) * 100 : undefined;
      // Same relative-volume computation as the rule engine's own volume
      // signal (chartIndicators.ts's summarizeIndicators) — recomputed
      // here rather than plumbed through AnalysisResult, since that type
      // doesn't expose it.
      const recent5   = bars.slice(-5);
      const prior20   = bars.slice(-25, -5);
      const avgRecent = recent5.reduce((s, b) => s + b.v, 0) / Math.max(recent5.length, 1);
      const avgPrior  = prior20.reduce((s, b) => s + b.v, 0) / Math.max(prior20.length, 1);
      const volumeSurgeMultiple = prior20.length >= 10 && avgPrior > 0 ? avgRecent / avgPrior : undefined;
      const peerGroup = getPeerGroupChange(epic);

      const verdict = await askIgConfirmStockTrade({
        instrumentName: epicName(epic),
        suggestedDir:   swing.direction === 'LONG' ? 'BUY' : 'SELL',
        ruleReasoning:  swing.reasoning,
        ruleConfidence: swing.confidence,
        price:          last,
        rsi,
        macdHist:       macd?.hist ?? null,
        lastCandles:    candles.slice(-8).map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close })),
        headlines,
        dayChangePercent,
        volumeSurgeMultiple,
        peerGroupChangePercent: peerGroup?.changePercent,
        peerGroupLabel:         peerGroup?.label,
      });

      addLog(mode, 'info', epicName(epic), `[GEMINI-CONFIRM] ${verdict.direction} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);

      // Same 70% floor gemini_opinion's own entries already require —
      // consistent bar for "Gemini's own conviction," whichever role it's
      // playing (deciding vs confirming).
      const CONFIRM_MIN_CONFIDENCE = 70;
      if (verdict.direction === 'SKIP' || verdict.confidence < CONFIRM_MIN_CONFIDENCE) {
        signal = { action: 'HOLD', reason: `[GEMINI-CONFIRM] Vetoed rule signal (${swing.direction} ${swing.confidence}/10) — ${verdict.reason} (${verdict.engine})` };
        break;
      }

      signal = {
        action:           swing.direction === 'LONG' ? 'BUY' : 'SELL',
        reason:           `Rules (${swing.confidence}/10): ${swing.reasoning} | Gemini confirmed ${verdict.confidence}%: ${verdict.reason}`,
        stopPrice:        swing.stopLoss,
        takeProfitPrice:  swing.takeProfit1,
        orderType:        'market',
        confidence:       verdict.confidence,
      };
      break;
    }

    // No technical rule at all — Gemini decides from scratch. No exit logic
    // of its own either: an open position here is managed entirely by
    // Gemini Position Watch (auto-enrolled at entry, same as every other
    // strategy), not a thesis-reversal check, since there's no thesis
    // beyond "Gemini thought so" to re-evaluate here.
    case 'gemini_opinion': {
      if (inPosition) { signal = { action: 'HOLD', reason: 'Open position — managed by Gemini Position Watch' }; break; }
      if (isStrategyAiPaused(mode)) { signal = { action: 'HOLD', reason: 'AI paused for this bot — resume to evaluate entries again' }; break; }
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
        // Gap mode — no real bars exist for RSI/MACD/efficiency-ratio to run
        // on here (confirmed live: this only fires in the dead stretch
        // between Friday's close and Monday's real pre-market data, since
        // even IG's own Lightstreamer candle feed goes quiet then despite
        // the raw dealing quote staying live — see includePrePost's comment
        // in yahooFetch.ts). Rather than sitting out the whole gap and
        // risking missing a genuine weekend catalyst, still ask Gemini
        // using IG's live quote + news alone, explicitly told it has no
        // technical confirmation, held to a stricter bar than the normal
        // 70. Falls through to the same execution path as every other
        // signal below, so a resulting position auto-enrolls into Gemini
        // Position Watch exactly like normal (see the addToWatch call
        // later in this file) — that reviews it again within 45min
        // regardless of throttling, so it gets a first real technical
        // check as soon as real data actually resumes, not just left
        // alone until the next scheduled poll.
        const live = st.marketDetails.get(epic);
        if (!live?.bid || !live?.offer) {
          signal = { action: 'HOLD', reason: `Data too stale to trust (${(barAgeMs / 3_600_000).toFixed(1)}h old) and no live IG quote available either — skipping` };
          break;
        }
        const gapSectorBlock = sectorCooldownBlock(mode, epic);
        if (gapSectorBlock) { signal = { action: 'HOLD', reason: gapSectorBlock }; break; }
        const gapMsSinceLastEntry = Date.now() - st.lastGeminiEntryAt;
        if (gapMsSinceLastEntry < GEMINI_ENTRY_SPACING_MS) {
          signal = { action: 'HOLD', reason: `Pacing — last entry ${(gapMsSinceLastEntry / 60_000).toFixed(0)}min ago, waiting ${(GEMINI_ENTRY_SPACING_MS / 60_000).toFixed(0)}min between entries` };
          break;
        }
        const gapTicker    = EPIC_TO_ALPACA[epic];
        const gapHeadlines = gapTicker ? await fetchAllHeadlines(gapTicker, 8, epicName(epic)) : [];
        if (!gapHeadlines.length) {
          signal = { action: 'HOLD', reason: `Data too stale to trust (${(barAgeMs / 3_600_000).toFixed(1)}h old) and no news to evaluate on either — skipping` };
          break;
        }
        const gapPrice = (live.bid + live.offer) / 2;
        const gapIdea = await askIgTradeIdea({
          instrumentName: epicName(epic), price: gapPrice, rsi: null, macdHist: null, atr: null,
          headlines: gapHeadlines, noTechnicalData: true,
        });
        // Stricter than the normal 70 — this decision has zero technical
        // grounding, only news plus a single live quote.
        const GAP_MODE_MIN_CONFIDENCE = 85;
        if (gapIdea.engine !== 'gemini' || gapIdea.action === 'HOLD' || gapIdea.confidence < GAP_MODE_MIN_CONFIDENCE) {
          signal = { action: 'HOLD', reason: `[GEMINI-GAP] Data too stale (${(barAgeMs / 3_600_000).toFixed(1)}h old) — ${gapIdea.action} ${gapIdea.confidence}% — ${gapIdea.reason} (${gapIdea.engine})` };
          break;
        }
        // lastGeminiEntryAt is set on confirmed placement (executeIgSignal),
        // not here — see that assignment's own comment.
        signal = {
          action:          gapIdea.action,
          reason:          `[GEMINI-GAP] No technical data (${(barAgeMs / 3_600_000).toFixed(1)}h stale) — news-only entry: ${gapIdea.reason}`,
          confidence:      gapIdea.confidence,
          stopPrice:       gapIdea.action === 'BUY' ? gapPrice - gapIdea.stopPoints : gapPrice + gapIdea.stopPoints,
          takeProfitPrice: gapIdea.action === 'BUY' ? gapPrice + gapIdea.takeProfitPoints : gapPrice - gapIdea.takeProfitPoints,
          orderType:       'market',
        };
        break;
      }
      const last  = bars[bars.length - 1].c;
      if (last == null || !Number.isFinite(last)) {
        signal = { action: 'HOLD', reason: 'Latest bar has no valid close price — skipping' };
        break;
      }
      const todayUtc   = new Date().toISOString().slice(0, 10);
      const todaysBars = bars.filter(b => b.t.slice(0, 10) === todayUtc);
      // Checked before spending a Gemini call — all three are cheap,
      // mechanical disqualifiers that don't need the AI's opinion first.
      // Judged on TODAY's own bars once there are enough of them, not a
      // fixed cross-day window — a straight 40-bar/~20h window nets a fresh
      // reversal against yesterday's opposite move (yesterday +20, today
      // reversing -20 nets to ~0 change over ~40 traveled = ~0 ratio) and
      // calls it "chop," even though today's own move is a single clean
      // direction — exactly the kind of fresh reversal this strategy
      // should catch, not block. Falls back to the old ~20h window only
      // early in the session, before today has enough bars (<~3h in) of
      // its own to judge. Note: MIN_EFFICIENCY_RATIO was tuned against the
      // ~20h window specifically — a shorter same-day window has a higher
      // expected ratio from noise alone (ratio scales ~1/sqrt(bars) for a
      // pure random walk), so this errs slightly more permissive early in
      // the session than the original tuning assumed.
      const MIN_TODAY_BARS_FOR_CHOP_CHECK = 6;
      const efficiencyRatio = todaysBars.length > MIN_TODAY_BARS_FOR_CHOP_CHECK
        ? calcEfficiencyRatio(todaysBars, todaysBars.length - 1)
        : calcEfficiencyRatio(bars, 40);
      if (efficiencyRatio !== null && efficiencyRatio < MIN_EFFICIENCY_RATIO) {
        signal = { action: 'HOLD', reason: `Too choppy to trade — efficiency ratio ${efficiencyRatio.toFixed(2)} < ${MIN_EFFICIENCY_RATIO} (moved a lot, went nowhere)` };
        break;
      }
      const sectorBlock = sectorCooldownBlock(mode, epic);
      if (sectorBlock) {
        signal = { action: 'HOLD', reason: sectorBlock };
        break;
      }
      const msSinceLastEntry = Date.now() - st.lastGeminiEntryAt;
      if (msSinceLastEntry < GEMINI_ENTRY_SPACING_MS) {
        signal = { action: 'HOLD', reason: `Pacing — last entry ${(msSinceLastEntry / 60_000).toFixed(0)}min ago, waiting ${(GEMINI_ENTRY_SPACING_MS / 60_000).toFixed(0)}min between entries` };
        break;
      }
      // Periods doubled from the defaults (14/12-26-9/14) — bars are now
      // 30-min not hourly, so this preserves the same wall-clock windows
      // (RSI/ATR: 14h, MACD: 12h/26h/9h) rather than quietly halving them.
      const rsi   = calcRsi(bars, 28);
      const macd  = calcMacdHist(bars, 24, 52, 18);
      const atr   = calcAtr(bars, 28);
      const ticker    = EPIC_TO_ALPACA[epic];
      const headlines = ticker ? await fetchAllHeadlines(ticker, 8, epicName(epic)) : [];
      // How far this has already moved today, from the bars already
      // fetched — no extra API call. Confirmed live this matters: Micron
      // got bought at 86690 after running from a 73900 prior close, i.e.
      // after ~17% of the day's move had already happened, and nothing in
      // the prompt could tell Gemini that at the time.
      const dayOpen     = todaysBars[0]?.o ?? bars[0]?.o;
      const dayChangePercent = dayOpen ? ((last - dayOpen) / dayOpen) * 100 : undefined;
      if (dayChangePercent !== undefined) recordDayChange(epic, dayChangePercent);
      // Multi-day trend, from the wider bar window (240 30-min bars = 5
      // days) — confirmed live this matters: SanDisk got bought on
      // "post-earnings selloff reversing" using only ~40h of history to
      // judge that, and the selloff was still actively continuing at the
      // multi-day level, cutting the position 11min later on the exact
      // same event the entry thesis had called finished.
      // Report the trend over whatever span is actually available rather
      // than assuming a fixed "3-day"/"5-day" label that may not match.
      // Bars are 30-min, not 1h — each one is half an hour, not an hour.
      const spanHours = (bars.length - 1) * 0.5;
      const multiDayTrendPercent  = spanHours >= 48 ? ((last - bars[0].c) / bars[0].c) * 100 : undefined;
      const multiDayTrendSpanDays = Math.round(spanHours / 24);
      // Gap at today's open (distinct from dayChangePercent, which is
      // today's open vs the CURRENT price) and a relative-volume surge read
      // — same calc scoreGeminiOpinion uses for candidate selection, now
      // also surfaced to the actual entry decision rather than only
      // influencing which candidates got considered in the first place.
      const todayIdx    = bars.findIndex(b => b.t.slice(0, 10) === todayUtc);
      const priorClose  = todayIdx > 0 ? bars[todayIdx - 1].c : undefined;
      const gapPercent  = priorClose && todaysBars[0] ? ((todaysBars[0].o - priorClose) / priorClose) * 100 : undefined;
      // Window doubled (10->20 bars) — 30-min bars now, so this is still a
      // ~10h "recent" volume window, same as before.
      const recent20       = bars.slice(-20);
      const avgVolPrior    = bars.slice(0, -20).reduce((s, b) => s + b.v, 0) / Math.max(bars.length - 20, 1);
      const recentVol      = recent20.reduce((s, b) => s + b.v, 0) / recent20.length;
      const volumeSurgeMultiple = avgVolPrior > 0 ? recentVol / avgVolPrior : undefined;
      const recentExitContext = getRecentExitContext(mode, epic);
      // Actual recent candle-by-candle shape, not just a single RSI/MACD/ATR
      // snapshot — this is a leveraged spread bet, not a buy-and-hold, so
      // Gemini needs to see how price has actually been moving over the
      // last several hours at 30-min resolution, not just where it ended up.
      const recentCandles = bars.slice(-8).map(b => ({ open: b.o, high: b.h, low: b.l, close: b.c }));
      // Only meaningful for a US-listed share (ticker set) — NYSE hours
      // have nothing to do with a UK/other-listed name's own real session.
      // Confirmed live this was missing: Intel got bought on a fresh
      // breakout thesis ~1h before NYSE close with no signal at all that
      // there was barely any real session time left for it to play out in.
      const sessionHoursRemaining = ticker ? hoursUntilNYSEClose() ?? undefined : undefined;
      // Real, data-verified NYSE intraday volatility shape (see
      // nyseVolatilityRegime's own comment) — same US-listed-only gating.
      const volatilityRegime = ticker ? nyseVolatilityRegime() ?? undefined : undefined;
      const peerGroup = getPeerGroupChange(epic);
      const idea = await askIgTradeIdea({
        instrumentName: epicName(epic), price: last, rsi, macdHist: macd?.hist ?? null, atr, headlines, dayChangePercent,
        multiDayTrendPercent, multiDayTrendSpanDays, gapPercent, volumeSurgeMultiple,
        recentExitContext, recentCandles, sessionHoursRemaining, volatilityRegime,
        peerGroupChangePercent: peerGroup?.changePercent, peerGroupLabel: peerGroup?.label,
      });
      // Fails closed — no underlying rule to fall back to the way VWAP
      // falls back to its own technicals when Gemini's unavailable. A
      // passthrough result (no key, cap reached, API error) means no
      // signal at all here, and a low-confidence real verdict is treated
      // the same as HOLD — this strategy only trades on real conviction.
      // Threshold raised 60->70 — confirmed live 60% calls were wrong far
      // more often than right; not a fix by itself, but no reason to keep
      // trading on the lower bar while everything else here is being
      // tightened.
      if (idea.engine !== 'gemini' || idea.action === 'HOLD' || idea.confidence < 70) {
        signal = { action: 'HOLD', reason: `[AI] ${idea.action} ${idea.confidence}% — ${idea.reason} (${idea.engine})` };
        break;
      }
      // Price-confirmation gate for reversal/dip-buy theses specifically —
      // the exact failure mode seen live all day: "RSI oversold, buying
      // the bounce" while the last bar was still actively making a new
      // low. RSI can stay oversold through an entire selloff; requiring
      // the most recent bar to have already turned in the proposed
      // direction is a real, mechanical check Gemini can't reason past
      // with a good enough story, unlike the same guidance as a prompt
      // instruction (already tried — didn't hold up).
      const prevClose = bars[bars.length - 2]?.c;
      if (prevClose !== undefined && rsi !== null) {
        const isReversalBuy  = idea.action === 'BUY'  && rsi < 35;
        const isReversalSell = idea.action === 'SELL' && rsi > 65;
        const lastBarConfirmsUp   = last > prevClose;
        const lastBarConfirmsDown = last < prevClose;
        if ((isReversalBuy && !lastBarConfirmsUp) || (isReversalSell && !lastBarConfirmsDown)) {
          signal = { action: 'HOLD', reason: `[AI] ${idea.action} ${idea.confidence}% called but RSI ${rsi.toFixed(0)} reversal isn't confirmed by the last bar yet (still moving the wrong way) — waiting for actual confirmation, not just the story` };
          break;
        }
      }
      // Same declining-highs/rising-lows gate fxScalperBot.ts has, scoped to
      // FX only at the time — confirmed live 2026-08-18 the identical
      // failure mode happens on stocks too: a Western Digital BUY fired
      // citing "53500 support" while real price had already rolled over
      // from ~539 to ~535 in the hours before, i.e. an active reversal
      // against the thesis, not confirmation of it. Broader than the RSI-
      // reversal gate above (that one only fires when RSI itself is in
      // reversal territory) — this catches any BUY/SELL against a visible
      // 3-bar reversal regardless of RSI.
      const recent3 = bars.slice(-3);
      if (recent3.length === 3) {
        const [a, b, c] = recent3;
        const decliningHighs = idea.action === 'BUY'  && a.h >= b.h && b.h >= c.h && a.h > c.h;
        const risingLows     = idea.action === 'SELL' && a.l  <= b.l  && b.l  <= c.l  && a.l  < c.l;
        if (decliningHighs || risingLows) {
          const shape = decliningHighs
            ? `declining highs (${a.h.toFixed(2)} > ${b.h.toFixed(2)} > ${c.h.toFixed(2)})`
            : `rising lows (${a.l.toFixed(2)} < ${b.l.toFixed(2)} < ${c.l.toFixed(2)})`;
          signal = { action: 'HOLD', reason: `[AI] ${idea.action} ${idea.confidence}% called but the last 3 bars show ${shape} — that's an active short-term reversal against this direction, not confirmation; waiting for it to actually turn` };
          break;
        }
      }
      // lastGeminiEntryAt is set on confirmed placement (executeIgSignal),
      // not here — see that assignment's own comment.
      signal = {
        action:           idea.action,
        reason:           `[AI] ${idea.reason}`,
        confidence:       idea.confidence,
        stopPrice:        idea.action === 'BUY' ? last - idea.stopPoints : last + idea.stopPoints,
        takeProfitPrice:  idea.action === 'BUY' ? last + idea.takeProfitPoints : last - idea.takeProfitPoints,
        orderType:        'market',
      };
      break;
    }

    // RSI(2) + 200-day EMA trend filter — the same strategy already running
    // as the standalone mean-reversion bot's 'stocks' instance
    // (meanReversionBot.ts) and, since 2026-08-28, as an Alpaca strategy too
    // (meanReversionSwingSignal in alpacaStrategies.ts, shared with that
    // Alpaca case verbatim) — added here as a third venue per explicit
    // request, so it can also run as a normal selectable strategy on this
    // bot rather than only on the separate always-on instance. Exit is
    // broker-side ATR stop/TP (stopPrice/takeProfitPrice below, handled
    // generically by the shared tail same as every other strategy here) —
    // the only thing this case needs to do itself is the original
    // strategy's MAX_HOLD_DAYS backstop, which needs a position's entry
    // time. Unlike the Alpaca port (which had to add its own persisted
    // entry-time tracking, AlpacaPosition has no such field), IG's own
    // FullPosition.openedAt already gives this directly — no extra state
    // needed here at all.
    case 'mean_reversion_swing': {
      if (inPosition) {
        const heldDays = openPos!.openedAt ? (Date.now() - new Date(openPos!.openedAt).getTime()) / 86_400_000 : 0;
        if (openPos!.openedAt && heldDays >= MR_SWING_MAX_HOLD_DAYS) {
          signal = {
            action: side === 'long' ? 'CLOSE_LONG' : 'CLOSE_SHORT',
            reason: `Max hold reached (${heldDays.toFixed(1)}d) — same backstop as the original strategy`,
          };
          break;
        }
        signal = { action: 'HOLD', reason: `Held ${heldDays.toFixed(1)}d — stop/TP live as broker-side bracket legs` };
        break;
      }
      signal = meanReversionSwingSignal(bars);
      break;
    }

    default: return;
  }

  // Requested directly: rule-driven entries (rule_based_analysis, and
  // gemini_confirmed's rule-qualified leg) compute their signal off the
  // last available bar's close, which can already be stale by the time
  // the order actually places — confirmed live 2026-08-18 a Western
  // Digital BUY fired citing "support" while live price had already
  // rolled over well past it (see the reversal-gate comment earlier in
  // this switch, same underlying gap, that one just catches it a few
  // bars sooner). This is the last-mile version: a final check that the
  // live IG quote hasn't already moved a real, non-noise amount against
  // the signal's own direction since that reference bar closed. 2% is
  // deliberately tighter than the 3-4% "already extended" thresholds used
  // elsewhere in this file (SHARP_DIP, the extension dampener in
  // ruleBasedAnalysis.ts) — this is catching an active reversal against a
  // *fresh* entry, not flagging an existing position as overextended, so
  // a smaller real move already invalidates the thesis. Only gates entries
  // (!openPos) — never blocks an exit signal for an already-open position.
  if (!openPos && (cfg.strategy === 'rule_based_analysis' || cfg.strategy === 'gemini_confirmed')
      && (signal.action === 'BUY' || signal.action === 'SELL')) {
    const liveQuote = st.marketDetails.get(epic);
    if (liveQuote?.bid && liveQuote?.offer) {
      const livePrice = (liveQuote.bid + liveQuote.offer) / 2;
      const refPrice  = bars[bars.length - 1].c;
      const movePct   = ((livePrice - refPrice) / refPrice) * 100;
      const REVERSAL_INVALIDATION_PCT = 2;
      const reversedAgainst = signal.action === 'BUY' ? movePct <= -REVERSAL_INVALIDATION_PCT : movePct >= REVERSAL_INVALIDATION_PCT;
      if (reversedAgainst) {
        addLog(mode, 'info', epicName(epic), `Skipped ${signal.action} — signal priced off ${refPrice.toFixed(2)} but live quote has since moved ${movePct.toFixed(2)}% against it (now ${livePrice.toFixed(2)}) — real reversal since the signal was computed, not noise, thesis looks stale`);
        return;
      }
    }
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
      journalExit(mode, cfg, openPos, reason);

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
          // This epic was running under a per-epic override (cfg.strategy
          // here is the resolved effective strategy, which differs from
          // st.config's own default exactly when that's the case) — carry
          // the override to whatever replaces it, or the replacement would
          // silently fall back to the bot's default strategy instead.
          if (cfg.strategy !== st.config.strategy) {
            const overrides = { ...(st.config.epicStrategyOverrides ?? {}) };
            delete overrides[epic];
            overrides[replacement] = cfg.strategy;
            st.config.epicStrategyOverrides = overrides;
          }
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
  if (st.profitLock)                   { addLog(mode, 'wait', name, `✅ Today's profit target already banked — skipping ${action} (entries resume next day; close positions manually if you want to keep this one going)`); return; }
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
  const poolCap = cfg.maxPositions;
  if (cfg.strategy === 'gemini_opinion' && positions.length >= poolCap) {
    const SWAP_MARGIN = 15;
    const { getWeakestConfidence } = await import('./geminiWatch');
    const weakest       = getWeakestConfidence(positions.map(p => p.dealId));
    const newConfidence = signal.confidence ?? 0;
    if (!weakest || newConfidence < weakest.confidence + SWAP_MARGIN) {
      addLog(mode, 'wait', name,
        `Skipped — no room (${positions.length}/${poolCap})${weakest ? `, ${newConfidence}% doesn't clear the weakest held position (${weakest.confidence}%) by the ${SWAP_MARGIN}pt swap margin` : ''}`);
      return;
    }
    const weakPos = positions.find(p => p.dealId === weakest.dealId);
    if (weakPos) {
      const rotateReason = `Rotating out — ${name}'s ${newConfidence}% idea beats this ${weakest.confidence}% held position by ${SWAP_MARGIN}+ points`;
      addLog(mode, 'exit', epicName(weakPos.epic), `💱 ${rotateReason}`);
      try {
        await igClosePos(session, weakPos.dealId, weakPos.direction, weakPos.size);
        recordLossExit(mode, weakPos.epic, weakPos.upl, rotateReason);
        journalExit(mode, cfg, weakPos, rotateReason);
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
  // `||` not `??` — see openRecommendation's identical fix for why.
  const minDeal = detail?.minDealSize || 0.5;
  const minStop = detail?.minStopDist || 1;

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
  if (typeof detail?.bid === 'number' && typeof detail?.offer === 'number') {
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

  // Real-track-record sizing — scales effectiveRiskGbp toward what this
  // exact strategy's own closed-trade history actually supports, on top of
  // the margin/loss-floor scaling above, rather than sizing purely off this
  // one trade's Gemini confidence. Neutral (1x, no skip) until there's a
  // real sample — see quant.ts for why the history has to be filtered to
  // post-rewrite trades only.
  const edge = edgeSizing(journalMode(mode), strategyFor(cfg, epic));
  if (edge.skip) {
    addLog(mode, 'wait', name, `Skipped — ${edge.reason}`);
    return;
  }
  if (edge.multiplier !== 1) {
    addLog(mode, 'info', name, edge.reason);
    effectiveRiskGbp *= edge.multiplier;
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
  let stake      = Math.max(minDeal, rawStake);

  // Minimum £/pt floor — added 2026-08-31 per explicit, repeated request:
  // raising maxRiskGbp alone only goes so far, since calcStake = risk ÷
  // stopDist and a wide-ATR name (UnitedHealth's real stop is ~2300pt) eats
  // most of that increase back into a wider stop rather than a bigger
  // stake. This directly guarantees a real £/pt on every mean_reversion_swing
  // trade regardless of how wide that particular name's stop is — real
  // consequence, stated plainly: it overrides the risk-proportional sizing,
  // so the ACTUAL max loss on a wide-stop name can exceed the nominal
  // maxRiskGbp target. The downstream loss-ceiling check below still applies
  // on top of this and will skip anything that floor pushes past a sane
  // multiple of target. Scoped to mean_reversion_swing only — this
  // strategy's own tight-stake complaint prompted it, not a blanket change
  // to every strategy's sizing.
  //
  // Conviction-scaled since 2026-08-31 rather than a flat number — per
  // explicit follow-up ("SB is not like normal stocks... what's correct is
  // based on the situation in realtime and how well-selected a position
  // was"). signal.confidence now carries getMeanReversionSignal's own
  // mechanical conviction score (RSI(2) extremity + trend strength, NOT an
  // AI guess — see meanReversionStrategy.ts) threaded through
  // meanReversionSwingSignal. A barely-qualifying setup gets the same 0.02
  // floor as before the ceiling math tightened; a genuinely well-selected
  // one (deep oversold pullback in a strong established trend) earns a
  // real bigger stake, up to 0.06/pt — same reasoning as the confidence
  // ceiling below, applied to the floor instead.
  const confidence = signal.confidence ?? 60;
  const MIN_STAKE_LOW  = 0.02;
  const MIN_STAKE_HIGH = 0.06;
  const minStakePerPoint = MIN_STAKE_LOW + Math.max(0, Math.min(confidence, 100)) / 100 * (MIN_STAKE_HIGH - MIN_STAKE_LOW);
  if (cfg.strategy === 'mean_reversion_swing' && stake < minStakePerPoint) {
    addLog(mode, 'info', name, `Stake raised to the £${minStakePerPoint.toFixed(3)}/pt floor for this ${confidence}%-conviction setup (was £${stake}/pt) — real max loss now £${(minStakePerPoint * sizingStopDist).toFixed(2)}, above the £${effectiveRiskGbp.toFixed(0)} risk target`);
    stake = minStakePerPoint;
  }

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
  // (confidence itself is computed above, before the stake floor, so both
  // this ceiling and that floor scale off the same number.)
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

  // Minimum meaningful-move floor — added 2026-08-31 per explicit request
  // ("its point per trade is really small"). £/pt = risk ÷ stop distance;
  // a wide ATR-based stop on an expensive/volatile instrument (NVIDIA at
  // this account's own risk figure is the case that prompted this) forces
  // a stake so small that even a real, sizeable move in the underlying
  // barely registers — confirmed live moves of several hundred points
  // netting single-digit £ P&L. There's no fix that keeps the SAME risk
  // cap and produces a bigger stake here — stopDist is what the
  // instrument's own volatility actually is, tightening it artificially
  // just means getting stopped out on ordinary noise, and raising the risk
  // cap is the opposite of what was just asked for. So instead of forcing
  // a bad trade-off, skip entries this unproductive entirely — the slot
  // goes to a name where the same risk budget buys a real position, not to
  // paying real spread/slippage cost for a trade that can only ever move
  // by pennies. Threshold: what a realistic 1% move in the underlying
  // would net in £ — below £3, the trade isn't worth having regardless of
  // whether the thesis is right.
  const MIN_MEANINGFUL_MOVE_GBP = 3;
  const expectedMoveGbp = stake * currentPrice * 0.01;
  if (expectedMoveGbp < MIN_MEANINGFUL_MOVE_GBP) {
    addLog(mode, 'wait', name,
      `Skipped — even a 1% move here only nets ~£${expectedMoveGbp.toFixed(2)} at this stake (£${stake}/pt on a ${sizingStopDist.toFixed(0)}pt stop) — not worth the trade at the current £${cfg.maxRiskGbp} risk target`);
    return;
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
  // Same reasoning for gemini_confirmed — its own entry decision already
  // went through a real, purpose-built Gemini confirmation
  // (askGeminiConfirmStockTrade, richer context than this generic check's
  // fixed strength:70 placeholder); running this too would just be a
  // second, worse-informed opinion capable of overriding the first one.
  let effectiveDirection: 'BUY' | 'SELL' = direction;
  if (cfg.strategy !== 'gemini_opinion' && cfg.strategy !== 'gemini_confirmed' && classifyMarketType(epic) === 'SHARES') {
    if (isStrategyAiPaused(mode)) {
      addLog(mode, 'wait', name, 'AI paused for this bot — skipping entry rather than trading unconfirmed');
      return;
    }
    try {
      // Best-effort — [] if no Alpaca ticker mapping or Finnhub unavailable,
      // Gemini still runs on technicals alone in that case (see prompt).
      const ticker    = EPIC_TO_ALPACA[epic];
      const headlines = ticker ? await fetchAllHeadlines(ticker, 5, name) : [];
      const verdict = await askIgDailyVerdict({
        instrumentName: name,
        direction,
        strength:       70,  // no granular numeric score at this layer — fixed moderate default
        price:          currentPrice,
        changePercent:  0,   // not available at this layer; doesn't affect the direction check
        stopPoints:     sizingStopDist,
        tpPoints:       profitDist ?? sizingStopDist * 2.5,
        headlines,
      });
      addLog(mode, 'info', name, `[AI] ${verdict.direction} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);
      // Fail closed, not open — confirmed live this matters: a Qualcomm BUY
      // went through unconfirmed purely because Gemini returned a 503 at
      // that exact moment, on a 6.54%-below-VWAP setup extreme enough that
      // it's exactly the kind of trade the news check exists to catch.
      // "Gemini unavailable" should skip the entry, not silently trade the
      // technical signal alone as if it had been reviewed and approved.
      if (verdict.engine === 'passthrough') {
        addLog(mode, 'wait', name, `[AI] Unavailable (${verdict.reason}) — skipping entry rather than trading unconfirmed`);
        return;
      }
      if (verdict.direction === 'SKIP' || verdict.confidence < 50) {
        addLog(mode, 'wait', name, `[AI] Skipped entry — ${verdict.direction} ${verdict.confidence}%`);
        return;
      }
      if (verdict.direction === 'BUY' || verdict.direction === 'SELL') effectiveDirection = verdict.direction;
    } catch {
      addLog(mode, 'wait', name, '[AI] Call failed — skipping entry rather than trading unconfirmed');
      return;
    }
  }

  addLog(mode, 'enter', name, `${effectiveDirection} — ${reason}`);
  addLog(mode, 'info',  name, `Stake: £${stake}/pt | Price: ~${currentPrice.toFixed(2)} | max loss at stop: ~£${(stake * sizingStopDist).toFixed(0)}`);

  try {
    const { dealId, level, protectionOk, protectionError, guaranteedStop } =
      await placeMarketOrder(session, epic, effectiveDirection, stake, effectiveStopDist, profitDist, 'GBP', true);
    addLog(mode, 'enter', name, `Deal confirmed — id ${dealId} @ ${level.toFixed(2)}`);
    // Moved here from evaluateEpic's signal-decision point — confirmed live
    // that set the pacing clock the moment Gemini said BUY/SELL, before any
    // of the checks below (loss ceiling, margin, live guard, second-opinion
    // SKIP) had a chance to reject it. A Meta SELL that failed on
    // insufficient margin still blocked every other instrument's entry for
    // the full 20min, off a trade that never actually happened. Only counts
    // as "an entry" once IG has actually confirmed one.
    if (cfg.strategy === 'gemini_opinion') st.lastGeminiEntryAt = Date.now();
    st.botOpenedDeals.add(dealId);
    saveBotOpenedDeals(mode, st.botOpenedDeals);
    journalEntry(mode, cfg, epic, effectiveDirection === 'BUY' ? 'long' : 'short', stake, level, reason, signal.confidence);
    // Auto-enrol every bot-opened deal in Gemini Position Watch — previously
    // opt-in only (manually flagged via the UI), so a bot-opened position had
    // no qualitative review at all beyond the fixed 1.5x profit-lock number.
    // Dynamic import avoids a static circular dependency (geminiWatch.ts
    // already imports from this file); safe here since it only runs well
    // after both modules have finished initializing.
    try {
      const { addToWatch, recordEntryConfidence, markNoAiClose } = await import('./geminiWatch');
      addToWatch(mode, dealId);
      // Seeds the position-rotation baseline with Gemini's own entry
      // confidence, so a fresh gemini_opinion position has something real
      // to be compared against immediately, not an arbitrary default.
      if (cfg.strategy === 'gemini_opinion' && signal.confidence !== undefined) {
        recordEntryConfidence(dealId, signal.confidence);
      }
      // mean_reversion_swing already carries its own wide stop/TP built for
      // a multi-day swing thesis — exempt from the discretionary AI close,
      // same reasoning (and same live evidence) as meanReversionBot.ts's own
      // fx/japan225 instances. See markNoAiClose's own comment.
      if (cfg.strategy === 'mean_reversion_swing') markNoAiClose(mode, dealId);
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
        journalExit(mode, st.config, p, slReason);
      } catch (e) {
        addLog(mode, 'error', name, `🚨 Severe loss guard close FAILED: ${e instanceof Error ? e.message : String(e)}. Manual intervention needed.`);
      }
    }
  } catch { /* transient fetch failure — next tick retries */ }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

// Shared across both modes deliberately — dealIds are globally unique (IG
// issues them per-deal, not per-account-mode), and this only ever needs to
// answer "has this exact position already had its one weak-open tighten,"
// so there's no cross-mode collision risk worth a separate map per mode.
// In-memory only, same tradeoff as this file's other per-position trackers
// (lastStopTightenAt, peakUpl in geminiWatch.ts) — worst case after a
// restart is one extra tighten on a position that already had one, not a
// safety gap (the stop itself, wherever it currently sits, still protects
// the position regardless).
const weakOpenTightenedOnce = new Set<string>();

// Per-position "stuck loss" caution flag — added 2026-08-31 per explicit
// request, distinct from the weak-open guard above: that one reacts to a
// same-day move against a fresh position; this tracks a position sitting
// underwater for a real stretch of time without recovering, well before it
// reaches its own hard stop. Log-only — deliberately does not close or
// tighten anything itself (the account already has enough mechanical
// closers; this is purely a visibility flag for the human to act on).
// In-memory only, same tradeoff as weakOpenTightenedOnce.
const stuckLossFirstSeenAt = new Map<string, number>(); // dealId -> ms since epoch it first crossed the threshold
const stuckLossFlagged     = new Set<string>();          // dealId -> already flagged, don't repeat every poll
const STUCK_LOSS_GBP      = -10;   // caution threshold — below the account's own £15 hard stop, an early warning
const STUCK_LOSS_PERSIST_MS = 20 * 60_000; // must stay unrecovered this long before flagging, not just a single bad tick

// Peak tracking for the profit-lock trail below — same in-memory tradeoff
// as the trackers above (worst case after a restart is one missed peak,
// not a safety gap; the position's own broker-side stop/TP still protects it).
const profitPeakByDeal = new Map<string, number>();

// Exit-only position management — self-heal naked stops, the stuck-loss
// caution flag, the weak-open guard (tighten-only for mean_reversion_swing,
// outright close for every other strategy), and the profit-lock peak-retrace
// trail. Extracted 2026-08-31 out of poll() so it can run on its own fast
// cadence via swingExitMonitor (2min) as well as inside the main poll cycle
// (25min for mean_reversion_swing) — same split already proven on the
// options bot: real intraday peaks/losses between infrequent checks were
// otherwise invisible to the trackers above. Deliberately does NOT touch
// anything entry-related (scanning, sizing, daily-profit-lock-on-new-entries)
// — this only ever manages positions that are already open.
async function manageSwingExits(mode: IgMode, cfg: IgStrategyConfig, positions: FullPosition[]): Promise<void> {
  const st = ms(mode);
  if (!st.session) return;

  // Self-heal naked positions — a failed SL/TP attach (at entry, or on a prior
  // poll) otherwise leaves a position with no broker-side exit until the
  // strategy's own thesis-reversal check fires, which is how trades were
  // riding losses instead of taking profit. Checked against IG's own reported
  // stopLevel/limitLevel, so this also repairs positions left naked before
  // this fix existed.
  for (const p of positions) {
    if (p.stopLevel !== undefined && p.limitLevel !== undefined) continue;
    // Grace period — confirmed live this matters: IG's own /positions
    // endpoint doesn't always report a guaranteed stop's level the same
    // way a normal stop shows up. A Silver position's confirmed guaranteed
    // stop (42pts, immune to slippage) came back as stopLevel:null ~71s
    // after the order confirmed it was attached, tricking this check into
    // replacing it with a much wider (~1.5%), non-guaranteed fallback stop
    // — same pattern hit EUR/USD and Wall St the same day, both self-
    // healed within a minute of opening. Skipping a position younger than
    // this doesn't weaken the backstop for anything genuinely naked — it's
    // still caught on this account's very next poll — it only stops
    // overwriting a real guaranteed stop still propagating through IG's
    // own reporting. Same grace window as geminiWatch.ts's identical fix.
    const ageMs = p.openedAt ? Date.now() - new Date(p.openedAt).getTime() : Infinity;
    const SELF_HEAL_GRACE_MS = 3 * 60_000;
    if (ageMs < SELF_HEAL_GRACE_MS) continue;
    const detail    = st.marketDetails.get(p.epic);
    const minStop   = detail?.minStopDist || 1;
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

  // Profit-lock trail — rebuilt 2026-08-31 per explicit request ("find a
  // better way to take profits whilst avoiding hefty losses... allowing
  // positions to play out"). The original version banked the INSTANT upl
  // crossed the floor, at whatever price happened to be showing that
  // poll — confirmed this was cutting real trends short well before their
  // own ATR-based take-profit (often several times bigger) had any chance
  // to be reached, the mirror image of the AI-close/weak-open problems
  // already fixed today, just via a third mechanism. Now: the floor below
  // only ACTIVATES tracking (still "a clear, worthwhile multiple of what
  // was risked, not a token amount" — same reasoning as before), then the
  // position is left alone to keep running toward its real broker-side
  // take-profit for as long as it's still working. Only closes early if it
  // gives back a real chunk (30%, matching the same figure already tuned
  // and validated on the options bot's identical peak-retrace design
  // today) of its own best-ever gain — protects against a real reversal
  // giving it all back, without capping a winner at a fixed small number.
  // Checking this every 2min (swingExitMonitor) instead of only once per
  // 25min poll cycle matters here specifically: the peak can only ever
  // reflect what a check actually observed, so an infrequent check can miss
  // the real intraday high entirely and trail from a lower, stale one —
  // same gap already confirmed live on the options bot's identical design.
  const profitLockFloor = cfg.maxRiskGbp * 1.5;
  const PROFIT_RETRACE_TRIGGER = 0.3;
  for (const p of positions) {
    const peak = Math.max(profitPeakByDeal.get(p.dealId) ?? -Infinity, p.upl);
    profitPeakByDeal.set(p.dealId, peak);
    if (peak < profitLockFloor) continue; // never earned real protection yet — leave it to the broker-side stop/TP
    const giveback = peak > 0 ? (peak - p.upl) / peak : 0;
    if (giveback < PROFIT_RETRACE_TRIGGER) continue; // still running well (or just made a fresh peak) — let it play out
    const name = epicName(p.epic);
    const plReason = `💰 Profit lock — gave back ${(giveback * 100).toFixed(0)}% of its £${peak.toFixed(2)} peak, banking £${p.upl.toFixed(2)} before it erodes further`;
    addLog(mode, 'exit', name, plReason);
    try {
      await igClosePos(st.session, p.dealId, p.direction, p.size);
      profitPeakByDeal.delete(p.dealId);
      // Confirmed live this gap mattered: with no record of a win here,
      // the very next fresh evaluation of the same instrument had zero
      // memory that it had already delivered a gain — Dell got bought
      // again ~1.7% higher a few hours after banking a profit-lock win,
      // chasing the tail of the same move rather than a fresh setup. See
      // getRecentExitContext's win branch for the entry-side guardrail.
      recordLossExit(mode, p.epic, p.upl, plReason);
      journalExit(mode, cfg, p, plReason);
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
    // One tighten per position, not one per poll — confirmed live 2026-08-25
    // this was compounding every ~5-15min poll while the weak-open condition
    // persisted (40% of whatever the CURRENT distance was, repeatedly),
    // collapsing a Nike short's stop from 129.5pt to ~21pt within under an
    // hour on nothing more than ordinary intraday noise relative to today's
    // open — it got stopped out on a 21pt move against a swing thesis built
    // for a multi-day hold, well before the actual thesis had any chance to
    // be wrong. Directly the "closed off at little losses" pattern the
    // Position Watch prompt rewrite (same day) was built to stop — this is
    // the same failure mode via a completely separate, non-AI code path.
    // Capped to fire once per open position: still reacts to a genuinely
    // weak open (the protective intent stays), just can't keep re-tightening
    // an already-tightened stop into oblivion while the position sits
    // through an ordinary intraday dip. Pruned to currently-open dealIds
    // each poll so this doesn't grow unbounded across the account's history.
    const openDealIds = new Set(positions.map(p => p.dealId));
    for (const id of weakOpenTightenedOnce) if (!openDealIds.has(id)) weakOpenTightenedOnce.delete(id);
    for (const id of stuckLossFirstSeenAt.keys()) if (!openDealIds.has(id)) stuckLossFirstSeenAt.delete(id);
    for (const id of stuckLossFlagged) if (!openDealIds.has(id)) stuckLossFlagged.delete(id);
    for (const id of profitPeakByDeal.keys()) if (!openDealIds.has(id)) profitPeakByDeal.delete(id);
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

        // FX pairs (CS.D.*) are already exclusively managed by the FX swing
        // bot's own exit logic (fxSwingStrategy.ts) — this check was built
        // for stocks and was never meant to also reach into positions a
        // different bot owns. It was silently doing exactly that, and badly:
        // confirmed live this compared IG's own scaled FX price (e.g.
        // ~13498 for GBP/USD) directly against Yahoo's raw, unscaled FX
        // quote (~1.27 for the same pair) with no conversion between the
        // two, producing nonsense readings like "+999865.77% vs today's
        // open" every ~15min and needlessly tightening a stop this bot
        // doesn't actually own the exit thesis for.
        if (p.epic.startsWith('CS.')) continue;

        // Same scaling bug as the FX case above, just never caught for this
        // prefix — commodities (CC.D.*, Brent Crude/Natural Gas) have the
        // identical IG-scaled-points-vs-Yahoo-raw-price mismatch (confirmed
        // live: Brent Crude read "+9737.17% vs today's open", IG's ~8994
        // points compared directly against Yahoo BZ=F's raw ~$68/barrel,
        // no conversion). Silver and Bitcoin happen to already be covered
        // by the CS. check above purely by coincidence — they're commodities
        // too, but their real IG epics share FX's "CS." prefix (see
        // FX_EPICS's own comment in igStrategyScanner.ts) — CC.* has no such
        // accidental protection.
        if (p.epic.startsWith('CC.')) continue;

        // Stuck-loss caution flag — per explicit request 2026-08-31, applies
        // to every position this loop reaches (i.e. stocks; FX/indices are
        // already skipped above and owned by their own bots). Log-only,
        // never closes or touches the stop — the account's own hard stop
        // (currently £15/trade) still does that job.
        {
          const name = epicName(p.epic);
          if (p.upl <= STUCK_LOSS_GBP) {
            const firstSeen = stuckLossFirstSeenAt.get(p.dealId);
            if (firstSeen === undefined) {
              stuckLossFirstSeenAt.set(p.dealId, Date.now());
            } else if (!stuckLossFlagged.has(p.dealId) && Date.now() - firstSeen >= STUCK_LOSS_PERSIST_MS) {
              stuckLossFlagged.add(p.dealId);
              addLog(mode, 'error', name, `🚨 Caution — sitting at £${p.upl.toFixed(2)} for over ${Math.round(STUCK_LOSS_PERSIST_MS / 60_000)}min without recovering to profit (hard stop caps the loss at £${cfg.maxRiskGbp})`);
            }
          } else if (p.upl >= 0) {
            // Only a real recovery to profit clears the flag — matches the
            // user's own framing ("doesn't come back to PROFIT"), not just
            // ticking back above -£10.
            stuckLossFirstSeenAt.delete(p.dealId);
            stuckLossFlagged.delete(p.dealId);
          }
        }

        // No alpacaTimeframe passed here, so fetchBarsWithFallback's Alpaca
        // branch (used for every Alpaca-covered share — most of this bot's
        // stock universe) defaults to 250 DAILY bars, not today's intraday
        // ones. bars[0] is therefore ~a year of trading days back, not
        // "today's open" — confirmed live this is exactly what produced
        // readings like "Alphabet +69.55% vs today's open": that was
        // Alphabet's real ~69% gain over the past year, mislabeled as an
        // intraday move and used to tighten (or, when "corroborated",
        // outright close) a position on completely wrong reasoning. Filter
        // for today's own bar explicitly instead of trusting array
        // position — same pattern evaluateEpic's dayChangePercent already
        // uses elsewhere in this file.
        const bars = await fetchBarsWithFallback(p.epic, '1d', { yahooInterval: '15m' });
        if (!bars || bars.length < 2) continue;
        const todayUtc = new Date().toISOString().slice(0, 10);
        const dayOpen  = bars.find(b => b.t.slice(0, 10) === todayUtc)?.o;
        if (!dayOpen || dayOpen <= 0) continue;

        const isBuy          = p.direction === 'BUY';
        const currentPrice   = isBuy ? p.bid : p.offer; // conservative side for each direction
        const pctFromOpen    = (currentPrice - dayOpen) / dayOpen * 100;
        const weakForThisPos = isBuy ? pctFromOpen <= -WEAK_OPEN_PCT : pctFromOpen >= WEAK_OPEN_PCT;
        if (!weakForThisPos) continue;

        const name = epicName(p.epic);
        // Only escalate to an outright close when a major index is
        // confirming the same direction of weakness; otherwise this looks
        // idiosyncratic to this one name, so just tighten instead.
        const idxPct = await getReferenceIndexPct();
        const corroborated = idxPct !== null && (isBuy ? idxPct <= -WEAK_OPEN_PCT * 0.6 : idxPct >= WEAK_OPEN_PCT * 0.6);

        // mean_reversion_swing's own thesis is built for a multi-day hold
        // (buys AFTER a dip, MAX_HOLD_DAYS backstop is 10 days) — a same-day
        // 0.5%/0.3%-corroborated move against it is exactly the ordinary
        // noise the strategy is designed to sit through, not a reason to
        // force-close within the first hour. Confirmed live 2026-08-31:
        // UnitedHealth and Intel both got closed here for pennies (+£0.13,
        // -£0.66) under two hours after opening, on nothing more than a
        // routine red afternoon — the exact "closed off at little losses"
        // pattern this guard's own header comment already names as the
        // failure mode it exists to prevent, just reached via this same
        // mechanism instead. Originally kept a softer once-only stop-tighten
        // for mean-reversion positions instead of an outright close — but
        // confirmed live 2026-09-01 that tighten was doing the same damage
        // by a different route: Intel got tightened toward breakeven after
        // an ordinary red day, then closed for ~£0.00 within the next poll
        // once price ticked back through the now-much-closer stop — same
        // "closed off at a little loss/nothing before the thesis had a real
        // chance to play out" outcome, just reached via the stop instead of
        // a direct close. Removed entirely for mean_reversion_swing now that
        // it has a more deliberate exit instead — meanReversionBot.ts's own
        // trendStillIntact check (see that file), which closes only when the
        // actual 200-day trend thesis this position was opened on has
        // genuinely broken, not on an ordinary same-day wobble.
        if (cfg.strategy === 'mean_reversion_swing') {
          // No action at all — see comment above.
        } else if (corroborated) {
          const woReason = `Weak open — ${pctFromOpen >= 0 ? '+' : ''}${pctFromOpen.toFixed(2)}% vs today's open, market broadly weak too (${idxPct?.toFixed(2)}%) — closing before it compounds`;
          addLog(mode, 'exit', name, `⚠️ ${woReason}`);
          try { await igClosePos(st.session, p.dealId, p.direction, p.size); recordLossExit(mode, p.epic, p.upl, woReason); journalExit(mode, cfg, p, woReason); }
          catch (e) { addLog(mode, 'error', name, `Weak-open close failed: ${e instanceof Error ? e.message : String(e)}`); }
        } else if (p.stopLevel !== undefined && !weakOpenTightenedOnce.has(p.dealId)) {
          const currentDist   = Math.abs(p.level - p.stopLevel);
          const tightenedDist = currentDist * 0.4;
          const newStop       = p.direction === 'BUY' ? p.level - tightenedDist : p.level + tightenedDist;
          const wouldTighten  = p.direction === 'BUY' ? newStop > p.stopLevel : newStop < p.stopLevel;
          if (wouldTighten) {
            try {
              await updatePositionLevels(st.session, p.dealId, newStop, p.limitLevel ?? null);
              weakOpenTightenedOnce.add(p.dealId);
              addLog(mode, 'info', name, `⚠️ Weak open — ${pctFromOpen >= 0 ? '+' : ''}${pctFromOpen.toFixed(2)}% vs today's open — tightened stop as a precaution (won't re-tighten further on this position)`);
            } catch (e) {
              addLog(mode, 'error', name, `Weak-open stop-tighten failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      } catch { /* best-effort — never let a data-source hiccup block the rest of the poll cycle */ }
    }
  }
}

// Fast, standalone exit-only cadence — entries/scanning stay on their own
// pollIntervalFor() cadence (25min for mean_reversion_swing), but exit
// management (self-heal, stuck-loss flag, weak-open tighten, profit-lock
// trail) now also runs this often, independent of it. Confirmed live this
// exact gap mattered on the options bot's identical peak-tracking design
// (see manageSwingExits' own profit-lock comment) — a real intraday peak or
// a stuck loss between infrequent checks was simply invisible until the
// next slow poll caught up. Only ever fetches+manages currently-open
// positions (1-4 typically), never the 72-name watchlist, so this stays
// cheap enough to run often without adding to the entry-scan's own IG call
// volume or rate-limit exposure.
const SWING_EXIT_MONITOR_MS = 2 * 60_000;

async function swingExitMonitor(mode: IgMode): Promise<void> {
  const st = ms(mode);
  if (!st.running) return;

  if (st.session && st.config && !isScannerQuietWeekend()) {
    try {
      const positions = await fetchFullPositions(st.session);
      if (positions.length) await manageSwingExits(mode, st.config, positions);
    } catch (e) {
      addLog(mode, 'error', '—', `Fast exit monitor failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (st.running) {
    st.swingExitMonitorTimer = setTimeout(() => { void swingExitMonitor(mode); }, SWING_EXIT_MONITOR_MS);
  }
}

async function poll(mode: IgMode) {
  const st = ms(mode);
  if (!st.running || !st.config || !st.session) return;

  const cfg   = st.config;
  const meta  = STRATEGY_META[cfg.strategy];
  const today = new Date().toISOString().slice(0, 10);
  st.lastPollTs = new Date().toISOString();

  // Sunday 22:00 UTC reopen, not Monday NYSE open — this bot's universe
  // includes indices (UK 100/Germany 40 open Monday ~7am UTC, hours before
  // NYSE) and IG's "24 Hours" share CFDs (near-continuously quoted, not
  // NYSE-cash-hours-gated). Sleeping until NYSE open needlessly missed the
  // entire Sunday-evening-through-Monday-morning window for those.
  if (isScannerQuietWeekend()) {
    const sleepMs = msUntilWeekendReopen();
    addLog(mode, 'wait', '—', `Weekend — sleeping until reopen (~${Math.round(sleepMs / 3_600_000)}h)`);
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
          try { await igClosePos(st.session, p.dealId, p.direction, p.size); recordLossExit(mode, p.epic, p.upl, wkReason); journalExit(mode, cfg, p, wkReason); }
          catch (e) { addLog(mode, 'error', name, `Weekend flatten failed: ${e instanceof Error ? e.message : String(e)}`); }
        } else if (p.upl >= profitLockFloor) {
          const wkProfitReason = `Weekend risk guard — £${p.upl.toFixed(2)} gain clears £${profitLockFloor.toFixed(0)} (1.5× target) — banking it before the gap`;
          addLog(mode, 'exit', name, wkProfitReason);
          try { await igClosePos(st.session, p.dealId, p.direction, p.size); journalExit(mode, cfg, p, wkProfitReason); }
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
  // grow forever with stale IDs that can never matter again. Any bot-managed
  // dealId disappearing here without having gone through journalExit first
  // (checked via journaledDealIds) means IG closed it server-side — a real
  // stop/limit hit, not any of this file's own close code — see
  // journalSilentCloses's own comment for why that previously left zero
  // record of it.
  {
    const openIds = new Set(positions.map(p => p.dealId));
    let changed = false;
    const silentlyClosed: string[] = [];
    for (const id of st.botOpenedDeals) {
      if (!openIds.has(id)) {
        st.botOpenedDeals.delete(id);
        changed = true;
        if (!journaledDealIds.has(id)) silentlyClosed.push(id);
      }
    }
    for (const id of st.releasedDeals)  if (!openIds.has(id)) { st.releasedDeals.delete(id);  changed = true; }
    if (changed) { saveBotOpenedDeals(mode, st.botOpenedDeals); saveReleasedDeals(mode, st.releasedDeals); }
    if (silentlyClosed.length) void journalSilentCloses(mode, st.session, silentlyClosed);
    for (const p of positions) lastKnownPosition.set(p.dealId, { epic: p.epic, direction: p.direction, size: p.size, level: p.level, openedAt: p.openedAt });
  }

  // ── Daily-loss circuit breaker ────────────────────────────────────────────
  // Mirrors alpacaBot.ts — without this, correlated positions moving against
  // each other at once (or a fast/gapping move slipping past a non-guaranteed
  // stop) can keep bleeding the account with nothing to stop new entries.
  if (st.dayKey !== today) {
    st.dayKey = today;
    st.dayStartBalance = balance;
    if (st.lossLock)   addLog(mode, 'info', '—', 'New trading day — daily-loss lock reset');
    if (st.profitLock) addLog(mode, 'info', '—', 'New trading day — daily-profit lock reset');
    st.lossLock = false;
    st.profitLock = false;
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

  // ── Daily-profit lock ─────────────────────────────────────────────────────
  // Mirrors the loss circuit breaker above, on the upside: once today's
  // banked gain clears the target, stop opening new positions for the rest
  // of the day rather than letting a good win get ground back down by
  // whatever the bot trades next. Doesn't cap or force-close a still-running
  // winner — only blocks new entries (see the st.profitLock check in
  // executeIgSignal) — so a position that's genuinely still working past the
  // target is left to its own exit logic, not chopped off at exactly £40.
  const profitTargetGbp = cfg.dailyProfitTargetGbp ?? 40;
  if (!st.profitLock && st.dayStartBalance > 0 && balance > 0) {
    const gainGbp = balance - st.dayStartBalance;
    if (gainGbp >= profitTargetGbp) {
      st.profitLock = true;
      addLog(mode, 'info', '—',
        `✅ Daily profit target hit — £${gainGbp.toFixed(2)} banked (≥ £${profitTargetGbp} target) — no new entries today, current position(s) left to run`);
    }
  }

  // Exit-only position management (self-heal naked stops, stuck-loss flag,
  // weak-open tighten, profit-lock trail) — extracted 2026-08-31 into its own
  // function so it can also run on a fast standalone cadence (swingExitMonitor,
  // 2min) independent of this poll's own 25min entry-scan cycle. Per explicit
  // request: shrinking the whole 72-epic poll cycle to react faster would risk
  // tripping IG's rate limit for no real benefit (the entry signal itself only
  // changes once/day); splitting exit-checks out lets THOSE react fast without
  // touching the entry-scan cadence at all. Still called here too as a
  // backstop, same pattern as manageExits on the options bot.
  await manageSwingExits(mode, cfg, positions);

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

  for (const epic of cfg.epics) {
    if (!st.running) break;
    // Same per-epic resolution evaluateEpic itself does — needed here too
    // since both checks below (pool-cap exception, de-burst delay) are
    // strategy-specific and cfg.strategy alone is only the bot's default,
    // not necessarily what this particular epic is actually running under.
    const epicStrategy = cfg.epicStrategyOverrides?.[epic] ?? cfg.strategy;
    const inPos = livePositions.find(p => p.epic === epic);
    // gemini_opinion still evaluates flat candidates even when full — a
    // fresh idea here is what a full slot gets compared against for a
    // possible swap (see the position-rotation check in executeIgSignal).
    // Every other strategy keeps the original behaviour: skip entirely
    // when there's no room, since there's nothing to act on and no
    // comparison logic that would use the extra call anyway.
    if (!inPos && livePositions.length >= cfg.maxPositions && epicStrategy !== 'gemini_opinion') {
      addLog(mode, 'wait', epicName(epic), `Max positions (${cfg.maxPositions}) reached`);
      continue;
    }
    await evaluateEpic(mode, epic, livePositions, cfg, st.session, available);
    try {
      livePositions = await fetchFullPositions(st.session);
    } catch { /* keep the last known count on a fetch failure */ }

    // gemini_opinion makes one real Gemini call per epic here, with nothing
    // else between them — confirmed live this bursts back-to-back requests
    // close enough together (a few seconds apart, ~8 epics a cycle, plus
    // Gemini Position Watch's own calls landing in the same window) to trip
    // rate-limit-shaped failures (503s, request timeouts) that a lone call
    // wouldn't hit. A small gap here costs nothing against a 15min poll
    // interval but meaningfully de-bursts the request rate.
    if (epicStrategy === 'gemini_opinion') await new Promise(r => setTimeout(r, 3_000));
  }

  schedule(mode, cfg);
}

function schedule(mode: IgMode, cfg: IgStrategyConfig) {
  const st = ms(mode);
  if (!st.running) return;
  // Overridden epics need their own strategy's cadence too — e.g. a
  // gemini_opinion override under a rule_based_analysis default shouldn't
  // be stuck polling only once an hour just because that's the default
  // strategy's own interval. rule_based_analysis's daily-timeframe check
  // is already gated by isDailyCheckTime() inside evaluateEpic regardless
  // of how often this fires, so ticking faster costs nothing extra there.
  const overrideStrategies = Object.values(cfg.epicStrategyOverrides ?? {}).filter((s): s is IgStrategyName => s !== undefined);
  const strategiesInPlay = new Set<IgStrategyName>([cfg.strategy, ...overrideStrategies]);
  const delay  = Math.min(...[...strategiesInPlay].map(pollIntervalFor));
  st.nextRunMs = Date.now() + delay;
  st.pollTimer = setTimeout(() => { void poll(mode); }, delay);
}

// ── Watchlist refresh ─────────────────────────────────────────────────────────
// Periodically re-scans the universe and updates the actively-TRADED
// candidate list (cfg.epics) — distinct from refreshRecommendations' own
//30-min cadence, which only feeds the manual-click "Recommended" panel and
// never changes what this bot actually trades on its own. Without this,
// cfg.epics only ever changes on a restart, however long that is between —
// confirmed live this let a new setup (Micron, scored 28.7 the moment it
// first qualified) sit completely unwatched for 16.5h spanning an entire
// NYSE session, only picked back up by luck when an unrelated restart
// happened to re-scan. Runs on the same cadence as the manual list so a
// genuine gap-up/volume-surge mover gets caught within one cycle of it
// happening, not by chance.
const WATCHLIST_REFRESH_MS = 30 * 60_000;

async function refreshWatchlist(mode: IgMode): Promise<void> {
  const st = ms(mode);
  if (!st.running || !st.config || !st.session) return;
  const cfg = st.config;

  // Currently-open positions must stay watched regardless of how they now
  // score — dropping one would strand a strategy with real rule-based exit
  // logic (donchian/ema/macd all live inside evaluateEpic, which only runs
  // for epics still in cfg.epics) with no way to ever exit it again. If we
  // can't even confirm what's open right now, skip this cycle rather than
  // risk dropping something live.
  let openEpics: string[];
  try {
    openEpics = (await fetchFullPositions(st.session)).map(p => p.epic);
  } catch {
    return;
  }

  let fresh: string[];
  if (cfg.strategy === 'mean_reversion_swing') {
    // Fixed universe, same reasoning as startIgStrategyBot's own comment —
    // this "refresh" always converges back to the same 26 names, it's not
    // meant to narrow down to whatever's currently signalling.
    fresh = [...MEAN_REVERSION_WATCHLIST];
  } else {
    try {
      fresh = await scanIgEpics(
        cfg.strategy, st.session, [...st.pausedEpics],
        cfg.maxPositions + 2,
        () => {}, // this scan's own progress lines aren't worth logging every 30min — only the resulting diff is
        Math.min(2, cfg.maxPositions), // keep a little index representation in the watchlist, not a hard pool anymore
      );
    } catch (e) {
      addLog(mode, 'info', '—', `Watchlist refresh scan failed, keeping current list: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  }

  // Override epics stay pinned regardless of how they'd score under the
  // scan above (which only ever runs cfg.strategy, the bot's default) —
  // same protection openEpics gets, for the same reason: dropping one here
  // would silently take it out of rotation with no way back in short of a
  // manual reconfigure.
  const overrideEpics = Object.keys(cfg.epicStrategyOverrides ?? {});
  const merged  = [...new Set([...openEpics, ...overrideEpics, ...fresh])];
  const added   = merged.filter(e => !cfg.epics.includes(e));
  const dropped = cfg.epics.filter(e => !merged.includes(e));
  if (!added.length && !dropped.length) return; // nothing changed — skip the noisy log/persist/re-subscribe

  cfg.epics = merged;
  saveIgState(mode, cfg);
  syncStreamSubscription(mode);

  const label = (list: string[]) => list.length ? list.map(epicName).join(', ') : 'none';
  addLog(mode, 'info', '—', `Watchlist refreshed — added: ${label(added)} · dropped: ${label(dropped)}`);
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
      addLog(mode, 'info', '—', `Reusing existing session — expires ${new Date(st.session.expiresAt).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Europe/London' })}`);
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
  // st.paused is deliberately NOT reset here — it's loaded from disk at
  // module init (see loadPaused) and only ever changes via explicit
  // pauseIgStrategyBot/resumeIgStrategyBot calls. This function runs on
  // every start AND every auto-resume-after-restart; resetting paused here
  // used to silently undo a manual pause on every routine deploy restart.
  st.authFailCount = 0;

  // Persist immediately — a crash mid-scan should still resume the bot
  saveIgState(mode, cfg);

  if (cfg.strategy === 'mean_reversion_swing') {
    cfg.epics = [...MEAN_REVERSION_WATCHLIST];
    addLog(mode, 'info', '—', `Fixed watchlist (not scanned) — ${cfg.epics.length} instruments, same universe as the retired standalone stocks instance`);
  } else {
    addLog(mode, 'info', '—', 'Scanning for best instruments…');
    try {
      const best = await scanIgEpics(cfg.strategy, st.session, [...st.pausedEpics], cfg.maxPositions + 2, msg => addLog(mode, 'info', '—', msg), Math.min(2, cfg.maxPositions));
      cfg.epics = best;
    } catch (e) {
      addLog(mode, 'info', '—', `Scan failed — using default indices: ${e instanceof Error ? e.message : String(e)}`);
      cfg.epics = ['IX.D.DOW.DAILY.IP', 'IX.D.NASDAQ.CASH.IP', 'IX.D.FTSE.DAILY.IP'];
    }
  }
  // Always fold in every epic pinned via epicStrategyOverrides — the scan
  // above only ever picks epics for cfg.strategy itself (e.g.
  // rule_based_analysis's scan is restricted to
  // RULE_BASED_ANALYSIS_CONFIRMED_EPICS), so an override epic would
  // otherwise never make it into the tracked list at all.
  const overrideEpics = Object.keys(cfg.epicStrategyOverrides ?? {});
  if (overrideEpics.length) cfg.epics = [...new Set([...cfg.epics, ...overrideEpics])];

  if (cfg.strategy === 'orb') resetOrbState(mode, cfg.epics);
  scheduleSessionRefresh(mode, st.session);
  syncStreamSubscription(mode); // subscribe Lightstream now that cfg.epics is finalized (no-op unless strategy is donchian_hourly/gemini_opinion)

  const overrideNote = overrideEpics.length
    ? ` | overrides: ${overrideEpics.map(e => `${epicName(e)}→${STRATEGY_META[cfg.epicStrategyOverrides![e]!].label}`).join(', ')}`
    : '';
  addLog(mode, 'info', '—', `Bot started — ${STRATEGY_META[cfg.strategy].label} | ${mode} | ${cfg.epics.map(epicName).join(', ')}${overrideNote}`);
  addLog(mode, 'info', '—', `Max risk/trade: £${cfg.maxRiskGbp} | Max positions: ${cfg.maxPositions} | Shorts: ${cfg.allowShorts ? 'yes' : 'no'}`);

  // Startup just fired a burst of IG calls (auth + balance + up to
  // maxPositions+2 sequential candle fetches while scanning for instruments).
  // Hitting the API again immediately with poll()'s own balance/positions/
  // market-details calls was intermittently getting a 403 — give it a few
  // seconds to clear before the first real poll.
  st.pollTimer = setTimeout(() => { void poll(mode); }, 10_000);
  // Independent of the above — see runSevereLossGuard for why this needs
  // its own much tighter cadence than the main 15min poll.
  st.severeLossTimer = setInterval(() => { void runSevereLossGuard(mode); }, 30_000);
  // Independent of the above — see refreshWatchlist for why cfg.epics needs
  // its own periodic re-scan rather than staying fixed for the bot's whole
  // run. First refresh deliberately not immediate — the scan just run above
  // is already fresh.
  st.watchlistRefreshTimer = setInterval(() => { void refreshWatchlist(mode); }, WATCHLIST_REFRESH_MS);
  // Independent of the above — see manageSwingExits/swingExitMonitor for why
  // exit management needs its own faster cadence than the entry-scan poll.
  st.swingExitMonitorTimer = setTimeout(() => { void swingExitMonitor(mode); }, SWING_EXIT_MONITOR_MS);
  return { ok: true };
}

export function stopIgStrategyBot(mode: IgMode): void {
  const st = ms(mode);
  st.running = false;
  // st.paused intentionally untouched — see startIgStrategyBot's own
  // comment; stopping shouldn't silently clear a manual pause either.
  if (st.pollTimer)             { clearTimeout(st.pollTimer);             st.pollTimer             = null; }
  if (st.severeLossTimer)       { clearInterval(st.severeLossTimer);      st.severeLossTimer       = null; }
  if (st.watchlistRefreshTimer) { clearInterval(st.watchlistRefreshTimer);st.watchlistRefreshTimer = null; }
  if (st.swingExitMonitorTimer) { clearTimeout(st.swingExitMonitorTimer);  st.swingExitMonitorTimer = null; }
  if (st.sessionRefreshTimer)   { clearTimeout(st.sessionRefreshTimer);   st.sessionRefreshTimer   = null; }
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
  savePaused(mode, true);
  addLog(mode, 'info', '—', '⏸ Paused — monitoring positions, no new entries');
}

export function resumeIgStrategyBot(mode: IgMode): void {
  const st = ms(mode);
  if (!st.running) return;
  st.paused = false;
  savePaused(mode, false);
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

  const { getWatchVerdicts } = await import('./geminiWatch');

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
    profitLock: st.profitLock,
    maxDailyLossPct: st.config?.maxDailyLossPct ?? 3,
    dailyProfitTargetGbp: st.config?.dailyProfitTargetGbp ?? 40,
    dayStartBalance: st.dayStartBalance,
    recommendations: [...st.recommendations.values()],
    dailyPick:  st.dailyPick,
    pausedEpics: [...st.pausedEpics],
    managedDeals: [...new Set([...st.botOpenedDeals, ...st.releasedDeals])],
    aiPaused:   isStrategyAiPaused(mode),
    positionWatch: getWatchVerdicts(mode),
  };
}

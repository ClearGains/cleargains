// ── T212 Stocks ISA — autonomous bot ────────────────────────────────────────
// Built 2026-08-24 per explicit request: full automation "like the others"
// (IG/Alpaca), scoped to the user's Stocks ISA specifically (confirmed
// live — CGT-exempt, unlike a general Invest account, which is why full
// autonomy was acceptable here in a way it wasn't proposed for elsewhere).
//
// Two hard rules, both enforced structurally, not just by convention:
//   1. Never touch what was already in the account. On first-ever run, every
//      currently-held ticker is snapshotted into `preExisting` and locked —
//      the sell path only ever iterates `botOpened`, so a pre-existing
//      holding is never even reachable from the code that places sell
//      orders, not just "instructed not to."
//   2. Bounded sizing, not literally unlimited. The user was fine leaving
//      sizing to "the strategy/Gemini's discretion," but an ISA is real
//      money with no per-trade backstop the way IG's stop-loss is — so
//      Gemini picks size *within* a capped range (MIN/MAX per position,
//      total budget across all bot-opened positions), not an open-ended
//      amount. See T212_MIN_POSITION_GBP etc. below; adjust if the user
//      wants a different envelope.
//
// Selection logic deliberately NOT copied from the IG/Alpaca swing engines
// (RSI/MACD/SMA-crossover timing, days-to-weeks holds) — an ISA is a
// long-term buy-and-hold account, months to years, per explicit request.
// Entries and exits here are instead built on the same philosophy already
// proven in this codebase's own T212 position-review tool
// (app/api/t212/position-review/route.ts): multi-week/month price trend +
// a 30-day news window, defaulting hard to inaction unless both genuinely
// corroborate each other over a real timeframe — ported into this file
// since that logic lives in the Next.js app, not reachable from here.
// An AI's role is to confirm/veto that picture with real-world judgment
// (askOpenAiIsaThesis / askGeminiIsaThesis / askXaiIsaThesis, all sharing
// one prompt via buildIsaThesisPrompt in gemini.ts, framed explicitly around
// a months-to-years horizon), not to time entries the way the fast bots' AI
// does. Grok (xAI) is the acting verdict as of 2026-08-25 — swapped in from
// a same-day OpenAI stint per the user's own decision after reviewing all
// three (OpenAI was the evidence-backed pick on financial-reasoning
// benchmarks; the user's call was to run Grok here, GPT on the IG/FX bots,
// Gemini kept on Alpaca). Gemini and OpenAI run alongside it as a standing
// comparison, logged but never gating a trade; see logComparison.

import * as fs from 'fs';
import * as path from 'path';
import { scanForBestSymbols } from './alpacaScanner';
import { askGeminiIsaThesis, type IsaThesisVerdict, type StockConfirmVerdict } from './gemini';
import { askOpenAiIsaThesis, askIgConfirmStockTrade } from './openai';
import { askXaiIsaThesis } from './xai';
import { recordJournalEvent, type JournalMode } from './tradeJournal';
import { edgeSizing } from './quant';
import { UNIVERSE as MOMENTUM_UNIVERSE, ADR_MAP, type UniverseStock } from './t212MomentumUniverse';
import { isWeekend, msUntilMondayOpen } from './marketHours';
import {
  getPortfolio, getCash, getOrders, resolveT212Ticker, placeMarketOrder,
  hasT212Creds, type T212Mode, type T212Position,
} from './t212Api';

// ── Config (adjust here if the user wants a different envelope) ────────────
// Raised 2026-08-25 per explicit request ("takes ages to make gains") — the
// old £150-500 range meant even a max-conviction pick barely moved the
// account. £400 is now the floor regardless of confidence; the AI's own
// conviction (via the confidence-scaled formula below, and edgeSizing's
// real-track-record multiplier) still decides how far above that a
// particular pick goes, up to £800 — roughly 3.75-7.5 positions across the
// £3,000 total budget depending on how convinced the acting model is,
// versus 6-20 before. Not maximally concentrated (still room for genuine
// diversification across several holdings), just no longer sized so small
// that a real win doesn't register.
const T212_MIN_POSITION_GBP = 400;
const T212_MAX_POSITION_GBP = 800;
const T212_TOTAL_BUDGET_GBP = 3_000; // across all bot-opened positions at once — raised 2026-08-25 per explicit request; still comfortably within free cash (£3,993 at the time)
const T212_POLL_MS = 3 * 60 * 60_000; // "every few hours" per explicit request
const T212_CANDIDATES_PER_CYCLE = 40; // liquid-US-stock candidates scanned each cycle — keeps API/Gemini call volume sane
const T212_MIN_CONFIRM_CONFIDENCE = 70;
// Quality bar for a NEW long-term holding — a real, sustained multi-month
// uptrend, not a short-term blip. Matches the "effective stock selection
// for a buy-and-hold ISA" ask directly: favour durable strength over
// anything that just looks good this week.
const ENTRY_MIN_TREND_12W = 8;    // %
const ENTRY_MIN_TREND_4W  = -3;   // % — allow a small pullback within an intact longer trend, not a full reversal
// Exit consideration bar — same numbers as the existing position-review
// tool's own `shouldFlag`, kept identical deliberately (already the
// validated "this isn't noise" threshold for this exact use case).
const EXIT_TREND_12W_BAD = -12;   // %
const EXIT_TREND_4W_BAD  = -5;    // %
const EXIT_NEWS_BEAR_MIN = 2;     // bearish headline count
const EXIT_NEWS_SENTIMENT_MAX = -0.3;
// A trend-following entry always buys AFTER a move has already happened —
// the risk this doesn't account for on its own is chasing a move that's
// already fully played out. These two together (a very large run, sitting
// right at its high with no pullback) describe a spent/parabolic move where
// the easy gain is already priced in and mean-reversion risk is elevated —
// a structural pre-filter on top of Gemini's own judgment, not instead of it.
const EXTENDED_TREND_12W     = 40;  // % — a run this large already reflects a major re-rating
const EXTENDED_NEAR_HIGH_PCT = 4;   // % below 6-month high counts as "sitting at the top" of that move
// A stock can also have already "made its move" over the full year even if
// it's since pulled back some way off its high (MRVL +214%/52w still 27.5%
// off-high, ASML +130%/52w still 12.5% off-high — neither trips the 12w+
// near-high rule above, but both had already captured most of a huge
// re-rating before this order was even placed). Judged on 2026-08-24 to be
// worth screening out before Gemini even sees them, not just flagging.
const ISA_STRATEGY = 'isa_trend_news'; // journal/quant strategy key
function journalMode(mode: T212Mode): JournalMode { return mode === 'live' ? 't212-live' : 't212-demo'; }

// ── Momentum + news strategy (added 2026-08-28) ─────────────────────────────
// This is a second, genuinely different strategy running inside the same
// bot/account, not a replacement for the long-horizon trend+news logic above.
// It's a direct port of the old /demo-trader page's client-side scanner
// (today's price move + volume surge + same-day news sentiment → a 0-100
// "profit score" and a BUY/SELL/NEUTRAL signal) — the thing that used to
// auto-trade MSFT/PLTR/etc. onto the T212 account whenever that browser tab
// happened to be open with a "practice" portfolio's Auto-Trade on. The user
// confirmed this actually made good trades over time and asked for it to be
// built into the real always-on bot instead of something that only ran
// "when the site was on." Per that same request, the rules-based signal
// (unchanged from the original) is the entry trigger; an AI layer sits on
// top as a confirm/veto step before anything is actually bought — reusing
// askIgConfirmStockTrade as-is (OpenAI primary, Gemini fallback), the exact
// same "rules qualify, AI confirms" mechanism already proven on the IG stock
// bot's gemini_confirmed strategy. Deliberately NOT run through the ISA
// thesis prompt above — that prompt explicitly frames itself around a
// months-to-years buy-and-hold horizon and would systematically veto
// short-term momentum setups for not looking like durable trends, which
// isn't the question this strategy is actually asking.
//
// Kept on its own faster poll loop, own budget, own position tracking
// (botOpenedMomentum, separate from the ISA bot's botOpened) and own
// journal/quant strategy key — a momentum signal is stale within hours, so
// it can't share the ISA bot's 3-hour cadence, and its P&L needs to be
// measurable separately from the long-horizon strategy's, not blended in.
const MOMENTUM_STRATEGY = 't212_momentum_news';
const MOMENTUM_POLL_MS = 15 * 60_000;       // frequent enough that "today's move" is still fresh; gentle enough on the Finnhub key shared with the ISA bot's own news calls
const MOMENTUM_MIN_POSITION_GBP = 100;
const MOMENTUM_MAX_POSITION_GBP = 250;      // meaningfully smaller than the ISA bot's £400-800 — more numerous, shorter-lived positions by design, not a second long-term book
const MOMENTUM_TOTAL_BUDGET_GBP = 750;      // separate pool from the ISA bot's £3,000 — a deliberately modest carve-out for a strategy that's new to this always-on bot, easy to raise once it's shown itself live
const MOMENTUM_MAX_POSITIONS = 5;
const MOMENTUM_MIN_CONFIRM_CONFIDENCE = 65; // slightly below the ISA bot's 70 — this is a faster, smaller-size, higher-turnover strategy by nature, not a long-term conviction call
// Exit plan is plain rules, not another AI call — a momentum trade's risk
// needs to be bounded even if the AI/Finnhub side is down, same "structural
// stop, not a persuadable one" reasoning as every other bot's stop-loss.
const MOMENTUM_STOP_LOSS_PCT   = -5;
const MOMENTUM_TAKE_PROFIT_PCT = 10;        // 2:1 reward:risk
const MOMENTUM_MAX_HOLD_DAYS   = 5;         // this is a swing strategy, not buy-and-hold — force-close backstop regardless of P&L
const MOMENTUM_WINDOW_SIZE = 60;            // stocks scanned per cycle — rotates through the universe over a couple of cycles rather than scanning ~90 names (and burning that many Finnhub calls) every 15 minutes

const EXTENDED_TREND_52W = 80; // % — already more than ~doubled over the past year
function isExtendedMove(trend: TrendResult): boolean {
  if (trend.trend12w !== null && trend.trend12w >= EXTENDED_TREND_12W
    && trend.pctBelowHigh !== null && trend.pctBelowHigh < EXTENDED_NEAR_HIGH_PCT) return true;
  if (trend.trend52w !== null && trend.trend52w >= EXTENDED_TREND_52W) return true;
  return false;
}

type BotOpenedEntry = {
  enteredAt: number; budgetGbp: number; avgPrice: number;
  lastVerdict?: { action: string; confidence: number; reason: string; engine: string; at: number };
  // Per-position AI-review kill-switch, added 2026-08-25 per explicit
  // request — the global isT212AiPaused above is all-or-nothing; this lets
  // one specific holding be left alone (e.g. "I want to hold GILD through
  // anything, don't let the AI touch it") while every other position keeps
  // getting reviewed normally. Undefined/false = reviewed as normal.
  aiReviewPaused?: boolean;
};

type T212State = {
  initialized:  boolean;               // has the first-run preExisting snapshot happened yet
  preExisting:  string[];              // T212 tickers held before the bot ever ran — permanently protected
  botOpened:    Record<string, BotOpenedEntry>;          // isa_trend_news
  botOpenedMomentum: Record<string, BotOpenedEntry>;     // t212_momentum_news — tracked separately, own budget/exit plan
};

function stateFile(mode: T212Mode): string {
  return path.join(__dirname, '..', `t212-bot-state-${mode}.json`);
}
function loadState(mode: T212Mode): T212State {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile(mode), 'utf8')) as T212State;
    st.botOpenedMomentum ??= {}; // older state files predate this field
    return st;
  }
  catch { return { initialized: false, preExisting: [], botOpened: {}, botOpenedMomentum: {} }; }
}
function saveState(mode: T212Mode, st: T212State): void {
  try { fs.writeFileSync(stateFile(mode), JSON.stringify(st), 'utf8'); } catch {}
}

// Manual AI kill-switch — added 2026-08-25 per explicit request, mirroring
// igStrategyBot.ts's isStrategyAiPaused/geminiWatch.ts's isWatchAiPaused.
// Unlike IG (separate scan-side and watch-side toggles, since those run on
// different cadences in different files), T212 does entries and exits in
// the same poll cycle in this one file, so a single combined toggle covers
// both: paused means no new buys AND no exit review that cycle — existing
// positions just sit untouched (no stop-loss backstop the way IG's CFDs
// have, so "don't touch it" is the safe default while paused, same as
// every other AI-outage fallback in this account already behaves).
// Persisted per mode so it survives a restart.
function t212AiPauseFile(mode: T212Mode): string {
  return path.join(__dirname, '..', `t212-ai-paused-${mode}.json`);
}
function loadT212AiPaused(mode: T212Mode): boolean {
  try { return (JSON.parse(fs.readFileSync(t212AiPauseFile(mode), 'utf8')) as { paused: boolean }).paused; }
  catch { return false; }
}
function saveT212AiPaused(mode: T212Mode, paused: boolean): void {
  try { fs.writeFileSync(t212AiPauseFile(mode), JSON.stringify({ paused }), 'utf8'); } catch {}
}
const t212AiPaused = new Map<T212Mode, boolean>([
  ['demo', loadT212AiPaused('demo')],
  ['live', loadT212AiPaused('live')],
]);
export function isT212AiPaused(mode: T212Mode): boolean {
  return t212AiPaused.get(mode) ?? false;
}
export function setT212AiPaused(mode: T212Mode, paused: boolean): void {
  t212AiPaused.set(mode, paused);
  saveT212AiPaused(mode, paused);
}

// Momentum-strategy-only fallback switch, added 2026-08-28 per explicit
// request after the xAI key's allowance got burned through by unrelated
// usage elsewhere (T212's own ISA-thesis calls + Alpaca's separate Grok
// test). If OpenAI/Gemini ever run into the same thing on this strategy's
// confirm step, this lets the momentum strategy fall back to running
// exactly like the original /demo-trader tab's auto-trade did — the rules
// signal alone decides, no AI call at all — without needing a redeploy to
// flip it. Off by default (AI confirms, as built) — this is a manual
// contingency switch, not something the bot flips itself. Separate from
// the global isT212AiPaused above: that one stops ALL new entries on both
// strategies; this one only removes the AI layer from the momentum
// strategy specifically, entries keep happening on rules alone.
function t212MomentumAiGateFile(mode: T212Mode): string {
  return path.join(__dirname, '..', `t212-momentum-ai-gate-${mode}.json`);
}
function loadMomentumAiGateEnabled(mode: T212Mode): boolean {
  try { return (JSON.parse(fs.readFileSync(t212MomentumAiGateFile(mode), 'utf8')) as { enabled: boolean }).enabled; }
  catch { return true; }
}
function saveMomentumAiGateEnabled(mode: T212Mode, enabled: boolean): void {
  try { fs.writeFileSync(t212MomentumAiGateFile(mode), JSON.stringify({ enabled }), 'utf8'); } catch {}
}
const momentumAiGateEnabled = new Map<T212Mode, boolean>([
  ['demo', loadMomentumAiGateEnabled('demo')],
  ['live', loadMomentumAiGateEnabled('live')],
]);
export function isMomentumAiGateEnabled(mode: T212Mode): boolean {
  return momentumAiGateEnabled.get(mode) ?? true;
}
export function setMomentumAiGateEnabled(mode: T212Mode, enabled: boolean): void {
  momentumAiGateEnabled.set(mode, enabled);
  saveMomentumAiGateEnabled(mode, enabled);
  addLog(mode, 'info', '—', enabled
    ? '[Momentum] AI confirm step turned back ON — rules signals now need AI agreement again'
    : '[Momentum] AI confirm step turned OFF — now trading the rules signal alone, exactly like the old /demo-trader auto-trade did');
}

// Per-position companion to the global toggle above — see
// BotOpenedEntry.aiReviewPaused's own comment. Persisted as part of the
// normal state file (saveState), same as everything else about a
// bot-opened position.
export function setT212PositionAiPaused(mode: T212Mode, ticker: string, paused: boolean): { ok: boolean; error?: string } {
  const st = rs(mode).state;
  const entry = st.botOpened[ticker];
  if (!entry) return { ok: false, error: 'Not a bot-opened position on this ticker' };
  entry.aiReviewPaused = paused;
  saveState(mode, st);
  return { ok: true };
}

// ── AI provider comparison (read-only) ──────────────────────────────────────
// Logs every provider's verdict on the exact same question, purely for
// later review — never read by any code path that places or blocks an
// order. Only whichever provider is currently wired as `actingEngine` at
// the call site actually gates a trade; this function just records what
// all three said. Appended to a flat JSON array so it's easy to pull down
// and analyze after a couple of weeks; not surfaced in getT212BotStatus to
// keep the status payload small. actingEngine is stored per-record (not
// assumed) specifically so old records stay correctly interpretable if
// which provider acts changes again later (it already has once — Gemini to
// OpenAI, 2026-08-25).
type ComparisonRecord = {
  ts: string; symbol: string; questionAction: 'BUY' | 'SELL';
  actingEngine: 'gemini' | 'openai' | 'xai';
  gemini: { action: string; confidence: number; reason: string; engine: string };
  openai: { action: string; confidence: number; reason: string; engine: string };
  xai:    { action: string; confidence: number; reason: string; engine: string };
  agree:  { gemini: boolean; openai: boolean; xai: boolean }; // vs. the acting verdict's action
};
function comparisonFile(mode: T212Mode): string {
  return path.join(__dirname, '..', `t212-ai-comparison-${mode}.json`);
}
function logComparison(
  mode: T212Mode, symbol: string, questionAction: 'BUY' | 'SELL', actingEngine: 'gemini' | 'openai' | 'xai',
  gemini: IsaThesisVerdict, openai: IsaThesisVerdict, xai: IsaThesisVerdict,
): void {
  const byEngine = { gemini, openai, xai };
  const actingAction = byEngine[actingEngine].action;
  const record: ComparisonRecord = {
    ts: new Date().toISOString(), symbol, questionAction, actingEngine, gemini, openai, xai,
    agree: {
      gemini: gemini.action === actingAction,
      openai: openai.action === actingAction,
      xai:    xai.action === actingAction,
    },
  };
  try {
    const existing = JSON.parse(fs.readFileSync(comparisonFile(mode), 'utf8')) as ComparisonRecord[];
    existing.push(record);
    fs.writeFileSync(comparisonFile(mode), JSON.stringify(existing), 'utf8');
  } catch {
    fs.writeFileSync(comparisonFile(mode), JSON.stringify([record]), 'utf8');
  }
  addLog(mode, 'info', symbol,
    `[COMPARE] acting=${actingEngine} (${actingAction}) · Gemini: ${gemini.action} ${gemini.confidence}% (${record.agree.gemini ? 'agree' : 'DISAGREE'}) · OpenAI: ${openai.action} ${openai.confidence}% (${record.agree.openai ? 'agree' : 'DISAGREE'}) · xAI: ${xai.action} ${xai.confidence}% (${record.agree.xai ? 'agree' : 'DISAGREE'})`);
}

type LogEntry = { id: string; ts: string; type: 'info' | 'enter' | 'exit' | 'wait' | 'error'; symbol: string; msg: string };
type RunState = {
  running: boolean;
  state:   T212State;
  log:     LogEntry[];
  pollTimer: ReturnType<typeof setTimeout> | null;
  nextRunMs: number | null;
  lastPollTs: string | null;
  momentumPollTimer: ReturnType<typeof setTimeout> | null;
  momentumNextRunMs: number | null;
};
const runStates = new Map<T212Mode, RunState>([
  ['live', { running: false, state: loadState('live'), log: [], pollTimer: null, nextRunMs: null, lastPollTs: null, momentumPollTimer: null, momentumNextRunMs: null }],
  ['demo', { running: false, state: loadState('demo'), log: [], pollTimer: null, nextRunMs: null, lastPollTs: null, momentumPollTimer: null, momentumNextRunMs: null }],
]);
function rs(mode: T212Mode): RunState { return runStates.get(mode)!; }

function addLog(mode: T212Mode, type: LogEntry['type'], symbol: string, msg: string): void {
  const st = rs(mode);
  const entry: LogEntry = { id: Math.random().toString(36).slice(2, 8), ts: new Date().toLocaleTimeString('en-GB', { hour12: false }), type, symbol, msg };
  st.log.unshift(entry);
  if (st.log.length > 300) st.log.splice(300);
  console[type === 'error' ? 'error' : 'log'](`[t212:${mode}] [${entry.ts}] [${type.toUpperCase()}] [${symbol}] ${msg}`);
}

// ── Trend + news — ported from app/api/t212/position-review/route.ts ───────

type TrendResult = {
  trend4w:       number | null;
  trend12w:      number | null;
  trend52w:      number | null;  // full-year change — context for whether the 12w move is a fresh re-rating within a longer uptrend, a recovery within a longer downtrend, or already very extended over the full year
  pctBelowHigh:  number | null;  // % below the 52-week high right now — 0 = sitting at the high, i.e. whatever move it made is fully realized and priced in already
  currentPrice:  number | null;
};
const EMPTY_TREND: TrendResult = { trend4w: null, trend12w: null, trend52w: null, pctBelowHigh: null, currentPrice: null };

async function fetchTrend(yahooTicker: string): Promise<TrendResult> {
  try {
    // 1y range, not just the recent window — the point isn't just "is it up
    // over 12 weeks" but *how has it moved relative to the last year*: a
    // steady multi-month climb reads very differently from a sudden spike
    // within an otherwise flat/declining year, even if the 12-week number
    // looks identical.
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=1y`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClearGains/1.0)', Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return EMPTY_TREND;
    const data = await res.json() as {
      chart?: { result?: Array<{ indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> };
    };
    const closes = (data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []).filter(
      (c): c is number => c !== null && c !== undefined && c > 0,
    );
    if (closes.length < 10) return { ...EMPTY_TREND, currentPrice: closes.at(-1) ?? null };
    const last = closes[closes.length - 1];
    const idx4w  = Math.max(0, closes.length - 1 - 20);
    const idx12w = Math.max(0, closes.length - 1 - 60);
    const trend4w  = closes[idx4w]  > 0 ? ((last - closes[idx4w])  / closes[idx4w])  * 100 : null;
    const trend12w = closes[idx12w] > 0 ? ((last - closes[idx12w]) / closes[idx12w]) * 100 : null;
    const trend52w = closes[0] > 0 ? ((last - closes[0]) / closes[0]) * 100 : null;
    const high52w  = Math.max(...closes);
    const pctBelowHigh = high52w > 0 ? ((high52w - last) / high52w) * 100 : null;
    return { trend4w, trend12w, trend52w, pctBelowHigh, currentPrice: last };
  } catch {
    return EMPTY_TREND;
  }
}

const BULLISH = ['beats','beat','surges','surge','soars','soar','rises','rise','gains','gain',
  'rallies','rally','record','upgrade','upgraded','outperform','strong','growth','profit','profits',
  'boost','boosted','raises','raised','exceeds','positive','higher','bullish','buy','overweight',
  'breakthrough','approval','deal','wins','guidance raised'];
const BEARISH = ['misses','miss','falls','plunges','plunge','slumps','slump','loss','losses','cuts','cut',
  'downgrade','downgraded','underperform','weak','concern','concerns','risk','warning','warns',
  'layoffs','disappoints','sell','bearish','negative','lower','lawsuit','probe','recall',
  'guidance cut','bankruptcy','investigation','fraud','scandal'];

function sentimentScore(headlines: string[]): { score: number; bull: number; bear: number } {
  let bull = 0, bear = 0;
  for (const h of headlines) {
    const l = h.toLowerCase();
    bull += BULLISH.filter(w => l.includes(w)).length;
    bear += BEARISH.filter(w => l.includes(w)).length;
  }
  const total = bull + bear;
  return { score: total === 0 ? 0 : (bull - bear) / total, bull, bear };
}

async function fetch30DayNews(symbol: string): Promise<{ headlines: string[]; sentiment: number; bull: number; bear: number }> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return { headlines: [], sentiment: 0, bull: 0, bear: 0 };
  try {
    const to   = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const res = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${apiKey}`,
      { signal: AbortSignal.timeout(6_000) },
    );
    if (!res.ok) return { headlines: [], sentiment: 0, bull: 0, bear: 0 };
    const raw = await res.json() as Array<{ headline?: string; datetime?: number }>;
    if (!Array.isArray(raw)) return { headlines: [], sentiment: 0, bull: 0, bear: 0 };
    const headlines = raw.filter(a => !!a.headline).sort((a, b) => (b.datetime ?? 0) - (a.datetime ?? 0))
      .slice(0, 15).map(a => a.headline!);
    const { score, bull, bear } = sentimentScore(headlines);
    return { headlines, sentiment: score, bull, bear };
  } catch {
    return { headlines: [], sentiment: 0, bull: 0, bear: 0 };
  }
}

// ── Momentum + news scanner ─────────────────────────────────────────────────
// Same-day window, not 30-day — this is "what's moving right now and why",
// not the ISA bot's "what's the narrative been over the last month" check
// above. Reuses the same sentimentScore/word lists — the two questions are
// different but "count bull vs bear keywords in these headlines" is the same
// primitive either way.
async function fetchTodayNews(symbol: string): Promise<{ headlines: string[]; sentiment: number }> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return { headlines: [], sentiment: 0 };
  try {
    const to        = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const res = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${yesterday}&to=${to}&token=${apiKey}`,
      { signal: AbortSignal.timeout(6_000) },
    );
    if (!res.ok) return { headlines: [], sentiment: 0 };
    const raw = await res.json() as Array<{ headline?: string; datetime?: number }>;
    if (!Array.isArray(raw)) return { headlines: [], sentiment: 0 };
    const headlines = raw.filter(a => !!a.headline).slice(0, 10).map(a => a.headline!);
    return { headlines, sentiment: sentimentScore(headlines).score };
  } catch {
    return { headlines: [], sentiment: 0 };
  }
}

type MomentumQuote = { price: number; changePercent: number; volume: number; high: number; low: number };

// UK (.L) stocks: ALWAYS priced off their US-dollar ADR (Finnhub), never the
// LSE listing — every UK entry in this universe now executes on T212 via its
// ADR ticker (see t212MomentumUniverse.ts's own comment: the LSE tickers this
// file originally guessed don't exist on T212 at all). The qty math below
// (budgetGbp × GBP/USD rate ÷ price) only makes sense if `price` is a real
// USD figure for the instrument actually being bought — the LSE quote this
// used to fall back to first is priced in pence, not dollars, and even where
// it isn't, an ADR's per-share ratio to the ordinary LSE share isn't 1:1, so
// there's no correct conversion from an LSE price to what the ADR trade
// should cost anyway. Confirmed live 2026-08-31 while fixing the "Ticker
// does not exist" 404s these entries were all hitting: fixing only the
// ticker without fixing this would have gone from cleanly failing to placing
// a real order sized off the wrong instrument's price entirely. No live ADR
// quote available → skip the stock this cycle, same as any other missing-price case.
async function fetchMomentumQuote(stock: UniverseStock): Promise<MomentumQuote | null> {
  if (stock.isUK) {
    const adr = ADR_MAP[stock.symbol];
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!adr || !apiKey) return null;
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${adr}&token=${apiKey}`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return null;
      const q = await res.json() as { c: number; dp: number; h: number; l: number; v: number };
      return q.c > 0 ? { price: q.c, changePercent: q.dp ?? 0, volume: q.v ?? 0, high: q.h ?? q.c, low: q.l ?? q.c } : null;
    } catch { return null; }
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${stock.symbol}&token=${apiKey}`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const q = await res.json() as { c: number; dp: number; h: number; l: number; v: number };
    return q.c > 0 ? { price: q.c, changePercent: q.dp ?? 0, volume: q.v ?? 0, high: q.h ?? q.c, low: q.l ?? q.c } : null;
  } catch { return null; }
}

type MomentumCandidate = {
  stock: UniverseStock; price: number; changePercent: number; volRatio: number;
  profitScore: number; reason: string; headlines: string[];
};

// Exact scoring/signal logic ported from app/api/demo-trader/signals/route.ts
// (default, non-smart-money branch — the mode the user's own auto-trade
// portfolio was actually running, confirmed from the "+X% today · N
// headlines (sentiment) · vol" reason format they showed). Rotates a 60-
// stock window of the ~90-stock universe each cycle (same rationale as that
// route's own rotation, and same window size) so the full universe still
// gets covered over a couple of cycles without scanning all of it, and all
// its Finnhub calls, every 15 minutes.
async function scanMomentumCandidates(exclude: Set<string>): Promise<MomentumCandidate[]> {
  const pool = MOMENTUM_UNIVERSE.filter(s => !exclude.has(s.t212));
  const windowsPerCycle = Math.max(1, Math.ceil(pool.length / MOMENTUM_WINDOW_SIZE));
  const bucket = Math.floor(Date.now() / MOMENTUM_POLL_MS) % windowsPerCycle;
  const offset = pool.length > 0 ? (bucket * MOMENTUM_WINDOW_SIZE) % pool.length : 0;
  const window = pool.length > MOMENTUM_WINDOW_SIZE
    ? [...pool.slice(offset), ...pool.slice(0, offset)].slice(0, MOMENTUM_WINDOW_SIZE)
    : pool;

  const quotes: Array<{ stock: UniverseStock; q: MomentumQuote }> = [];
  for (const stock of window) {
    await new Promise<void>(r => setTimeout(r, 100)); // stay under Finnhub's free-tier rate limit
    const q = await fetchMomentumQuote(stock);
    if (q) quotes.push({ stock, q });
  }
  if (quotes.length === 0) return [];

  const volumes = quotes.map(x => x.q.volume).filter(v => v > 0).sort((a, b) => a - b);
  const medianVolume = volumes[Math.floor(volumes.length / 2)] || 1;

  const movers = quotes.filter(x => Math.abs(x.q.changePercent) >= 0.5 || x.q.volume >= medianVolume * 2);

  const results: MomentumCandidate[] = [];
  await Promise.all(movers.map(async ({ stock, q }) => {
    const news = await fetchTodayNews(stock.symbol);
    const volRatio = q.volume > 0 && medianVolume > 0 ? q.volume / medianVolume : 1;
    const intradayRange = q.high > 0 && q.low > 0 ? ((q.high - q.low) / q.price) * 100 : 0;

    const momentumScore  = Math.min(35, Math.abs(q.changePercent) * 7);
    const volumeScore    = Math.max(0, Math.min(25, (volRatio - 1) * 12.5));
    const newsScore      = Math.min(30, news.headlines.length * 6);
    const volatilityScore = Math.min(10, intradayRange * 2);
    const profitScore = Math.round(Math.min(100, momentumScore + volumeScore + newsScore + volatilityScore));

    let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    if (q.changePercent >= 0.5) signal = news.sentiment <= -0.5 ? 'NEUTRAL' : 'BUY';
    else if (q.changePercent <= -0.5) signal = news.sentiment >= 0.5 ? 'NEUTRAL' : 'SELL';
    if (signal !== 'BUY') return;

    const sentimentLabel = news.sentiment >= 0.1 ? 'positive' : news.sentiment <= -0.1 ? 'negative' : 'neutral';
    const reason = [
      `${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}% today`,
      news.headlines.length > 0 ? `${news.headlines.length} headlines (${sentimentLabel} sentiment)` : 'no news found',
      volRatio >= 1.5 ? `${volRatio.toFixed(1)}x volume surge` : 'normal volume',
    ].join(' · ');

    results.push({ stock, price: q.price, changePercent: q.changePercent, volRatio, profitScore, reason, headlines: news.headlines });
  }));

  results.sort((a, b) => b.profitScore - a.profitScore);
  return results;
}

// ── Momentum entries/exits ──────────────────────────────────────────────────

async function pollMomentumEntries(mode: T212Mode): Promise<void> {
  const st = rs(mode).state;

  if (isT212AiPaused(mode)) {
    addLog(mode, 'wait', '—', '[Momentum] AI paused — skipping new entries this cycle');
    return;
  }

  // Run in batches, not a continuously-topped-up pool — per explicit
  // request 2026-08-31 (this strategy's own T212 call volume, on a 15min
  // cadence, was tripping T212's own rate limit). While ANY momentum
  // position is open, this cycle only monitors it for exit (pollMomentumExits,
  // called separately and unconditionally) — no scan, no AI confirm call,
  // no T212 instrument-lookup calls. Scanning for a fresh batch only resumes
  // once the book is completely flat again.
  const openCount = Object.keys(st.botOpenedMomentum).length;
  if (openCount > 0) return;

  const exclude = new Set([
    ...st.preExisting, ...Object.keys(st.botOpened), ...Object.keys(st.botOpenedMomentum),
  ]);

  let candidates: MomentumCandidate[];
  try {
    candidates = await scanMomentumCandidates(exclude);
  } catch (e) {
    addLog(mode, 'error', '—', `[Momentum] Scan failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  const aiGateOn = isMomentumAiGateEnabled(mode);
  const slotsLeft = MOMENTUM_MAX_POSITIONS - openCount;
  for (const cand of candidates.slice(0, slotsLeft)) {
    const remainingNow = MOMENTUM_TOTAL_BUDGET_GBP - Object.values(st.botOpenedMomentum).reduce((s, e) => s + e.budgetGbp, 0);
    if (remainingNow < MOMENTUM_MIN_POSITION_GBP) break;

    // Fallback path — see isMomentumAiGateEnabled's own comment. Buys
    // straight off the rules signal, exactly like the original /demo-trader
    // auto-trade did (no AI call, no confidence to size from — flat
    // mid-range size instead of the confidence-scaled amount below).
    let verdict: StockConfirmVerdict;
    let budgetGbp: number;
    if (!aiGateOn) {
      verdict = { direction: 'BUY', confidence: cand.profitScore, reason: 'AI gate off — rules signal alone', engine: 'passthrough' };
      addLog(mode, 'info', cand.stock.symbol, `[Momentum] Score ${cand.profitScore} — ${cand.reason} → AI gate OFF, buying on rules signal alone`);
      budgetGbp = Math.round((MOMENTUM_MIN_POSITION_GBP + MOMENTUM_MAX_POSITION_GBP) / 2);
    } else {
      const signal = {
        instrumentName: cand.stock.symbol, suggestedDir: 'BUY' as const,
        ruleReasoning: cand.reason, ruleConfidence: Math.max(1, Math.min(10, Math.round(cand.profitScore / 10))),
        price: cand.price, rsi: null, macdHist: null, lastCandles: [],
        headlines: cand.headlines, dayChangePercent: cand.changePercent, volumeSurgeMultiple: cand.volRatio,
      };
      verdict = await askIgConfirmStockTrade(signal);
      addLog(mode, 'info', cand.stock.symbol, `[Momentum] Score ${cand.profitScore} — ${cand.reason} → AI: ${verdict.direction} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);
      if (verdict.engine === 'passthrough' || verdict.direction !== 'BUY' || verdict.confidence < MOMENTUM_MIN_CONFIRM_CONFIDENCE) continue;
      const scale = Math.min(1, Math.max(0, (verdict.confidence - MOMENTUM_MIN_CONFIRM_CONFIDENCE) / (100 - MOMENTUM_MIN_CONFIRM_CONFIDENCE)));
      budgetGbp = Math.round(MOMENTUM_MIN_POSITION_GBP + scale * (MOMENTUM_MAX_POSITION_GBP - MOMENTUM_MIN_POSITION_GBP));
    }

    const edge = edgeSizing(journalMode(mode), MOMENTUM_STRATEGY);
    if (edge.skip) { addLog(mode, 'wait', cand.stock.symbol, `[Momentum] Skipped — ${edge.reason}`); continue; }
    if (edge.multiplier !== 1) budgetGbp = Math.round(budgetGbp * edge.multiplier);
    budgetGbp = Math.min(remainingNow, budgetGbp);
    if (budgetGbp < MOMENTUM_MIN_POSITION_GBP) continue;

    const gbpUsd = await getGbpUsd();
    const qty = Math.round(((budgetGbp * gbpUsd) / cand.price) * 10000) / 10000;
    if (qty <= 0) continue;

    try {
      const order = await placeMarketOrder(mode, cand.stock.t212, qty);
      addLog(mode, 'enter', cand.stock.symbol, `[Momentum] BUY ${qty} ${cand.stock.t212} — £${budgetGbp} (score ${cand.profitScore}${aiGateOn ? `, AI ${verdict.confidence}%` : ', no AI'}) — order ${order.id ?? 'placed'}`);
      st.botOpenedMomentum[cand.stock.t212] = { enteredAt: Date.now(), budgetGbp, avgPrice: cand.price };
      saveState(mode, st);
      recordJournalEvent({
        mode: journalMode(mode), event: 'entry', symbol: cand.stock.symbol, strategy: MOMENTUM_STRATEGY,
        side: 'long', qty, price: cand.price, reason: verdict.reason, confidence: verdict.confidence,
      });
    } catch (e) {
      addLog(mode, 'error', cand.stock.symbol, `[Momentum] Order failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// Plain rules, not an AI call (see MOMENTUM_STOP_LOSS_PCT's own comment) —
// runs regardless of isT212AiPaused, same as every other bot's stop-loss
// staying live through an AI outage/pause.
async function pollMomentumExits(mode: T212Mode, positions: T212Position[]): Promise<void> {
  const st = rs(mode).state;
  const byTicker = new Map(positions.map(p => [p.ticker, p]));
  let pendingTickers = new Set<string>();
  try { pendingTickers = new Set((await getOrders(mode)).map(o => o.ticker)); } catch { /* best-effort */ }

  for (const [ticker, tracked] of Object.entries(st.botOpenedMomentum)) {
    if (st.preExisting.includes(ticker)) { delete st.botOpenedMomentum[ticker]; continue; }

    const pos = byTicker.get(ticker);
    if (!pos) {
      if (pendingTickers.has(ticker)) continue;
      delete st.botOpenedMomentum[ticker]; saveState(mode, st); continue;
    }

    const upl = pos.ppl ?? ((pos.currentPrice ?? tracked.avgPrice) - tracked.avgPrice) * pos.quantity;
    const uplPct = tracked.avgPrice > 0 ? (upl / (tracked.avgPrice * pos.quantity)) * 100 : 0;
    const heldDays = (Date.now() - tracked.enteredAt) / 86_400_000;

    let closeReason: string | null = null;
    if (uplPct <= MOMENTUM_STOP_LOSS_PCT) closeReason = `Stop-loss hit (${uplPct.toFixed(1)}%)`;
    else if (uplPct >= MOMENTUM_TAKE_PROFIT_PCT) closeReason = `Take-profit hit (+${uplPct.toFixed(1)}%)`;
    else if (heldDays >= MOMENTUM_MAX_HOLD_DAYS) closeReason = `Max hold reached (${heldDays.toFixed(1)}d, ${uplPct >= 0 ? '+' : ''}${uplPct.toFixed(1)}%)`;
    if (!closeReason) continue;

    const underlying = ticker.replace(/_[A-Z]{2}_EQ$/, '');
    try {
      await placeMarketOrder(mode, ticker, -Math.abs(pos.quantity));
      addLog(mode, 'exit', underlying, `[Momentum] SOLD ${pos.quantity} ${ticker} — ${closeReason}`);
      recordJournalEvent({
        mode: journalMode(mode), event: 'exit', symbol: underlying, strategy: MOMENTUM_STRATEGY,
        side: 'long', qty: pos.quantity, price: pos.currentPrice ?? tracked.avgPrice, reason: closeReason,
        plUsd: upl, plPct: uplPct,
      });
      delete st.botOpenedMomentum[ticker];
      saveState(mode, st);
    } catch (e) {
      addLog(mode, 'error', underlying, `[Momentum] Sell failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ── Entries ──────────────────────────────────────────────────────────────

async function pollEntries(mode: T212Mode): Promise<void> {
  const run = rs(mode);
  const st  = run.state;

  if (isT212AiPaused(mode)) {
    addLog(mode, 'wait', '—', 'AI paused — skipping new entries this cycle');
    return;
  }

  // Run in batches, not a continuously-topped-up pool — same fix as
  // pollMomentumEntries above, extended here 2026-09-01 per explicit
  // repeated request after a T212 429 surfaced: while ANY bot-opened ISA
  // position exists, this cycle only monitors it for exit (pollExits,
  // called separately and unconditionally in poll()) — no candidate scan,
  // no trend/news/AI calls, no T212 instrument-lookup calls. Previously this
  // only stopped once the budget was FULLY deployed, which still let a
  // partially-funded book scan up to T212_CANDIDATES_PER_CYCLE (40)
  // candidates every cycle — each candidate potentially reaching
  // resolveT212Ticker (a real T212 API call) — real volume even with just
  // one or two positions open. Scanning for fresh candidates only resumes
  // once the book is completely flat again, exactly like momentum.
  const openCount = Object.keys(st.botOpened).length;
  if (openCount > 0) {
    const currentBudgetUsed = Object.values(st.botOpened).reduce((s, e) => s + e.budgetGbp, 0);
    addLog(mode, 'wait', '—', `${openCount} position(s) open (£${currentBudgetUsed.toFixed(0)}/£${T212_TOTAL_BUDGET_GBP} budget) — monitoring only, no new-candidate scan until flat`);
    return;
  }

  const exclude = [...st.preExisting.map(t => t.replace(/_[A-Z]{2}_EQ$/, '')), ...Object.keys(st.botOpened).map(t => t.replace(/_[A-Z]{2}_EQ$/, ''))];
  let candidates: string[];
  try {
    // 'rule_based_analysis' here only drives the scanner's liquidity
    // pre-filter (top-volume US names) — the actual selection below is
    // the trend/news logic, not that strategy's own scoring.
    candidates = await scanForBestSymbols('rule_based_analysis', 'paper', exclude, T212_CANDIDATES_PER_CYCLE, msg => addLog(mode, 'info', '—', msg));
  } catch (e) {
    addLog(mode, 'error', '—', `Candidate scan failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  for (const sym of candidates) {
    if (!run.running) break;
    const remaining = T212_TOTAL_BUDGET_GBP - Object.values(st.botOpened).reduce((s, e) => s + e.budgetGbp, 0);
    if (remaining < T212_MIN_POSITION_GBP) break;

    const trend = await fetchTrend(sym);
    if (trend.trend12w === null || trend.currentPrice === null) continue;
    if (trend.trend12w < ENTRY_MIN_TREND_12W || (trend.trend4w !== null && trend.trend4w < ENTRY_MIN_TREND_4W)) continue;
    // Deliberately NOT a hard skip on move size alone — a large move backed
    // by real fundamentals (earnings, guidance, structural demand) is a
    // fine long-term buy regardless of how far it's already run; it's an
    // *unbacked* move (pure momentum/hype, no substance behind it) that's
    // the actual risk. isExtendedMove is still computed and handed to
    // Gemini as context below — the judgment on whether it's earned belongs
    // to the fundamentals-and-conviction check, not a price-magnitude rule.

    const news = await fetch30DayNews(sym);
    if (news.bear >= EXIT_NEWS_BEAR_MIN && news.sentiment <= EXIT_NEWS_SENTIMENT_MAX) {
      addLog(mode, 'wait', sym, `Trend looks good (+${trend.trend12w.toFixed(1)}% /12w) but 30-day news is genuinely negative — skipping`);
      continue;
    }

    const thesisReq = {
      instrumentName: sym, action: 'BUY' as const, price: trend.currentPrice,
      trend4w: trend.trend4w, trend12w: trend.trend12w, trend52w: trend.trend52w, pctBelowHigh: trend.pctBelowHigh,
      newsSentiment: news.sentiment, headlines: news.headlines,
    };
    // Grok (xAI) is the acting verdict as of 2026-08-25 (moved here from a
    // same-day OpenAI stint — OpenAI was the evidence-backed pick on
    // financial-reasoning benchmarks, but the user's own call after
    // reviewing all three was to run Grok here instead, GPT on the IG/FX
    // bots, Gemini kept on Alpaca). Gemini and OpenAI both run alongside as
    // a logged comparison, never gating a trade. See logComparison's own
    // comment — only the verdict actually used to trade is awaited
    // synchronously; the rest are logged fire-and-forget and never gate
    // anything.
    const verdict = await askXaiIsaThesis(thesisReq);
    addLog(mode, 'info', sym, `[XAI] ${verdict.action} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);

    // Comparison-only — never affects the trade, see logComparison's own comment.
    void Promise.all([askGeminiIsaThesis(thesisReq), askOpenAiIsaThesis(thesisReq)])
      .then(([geminiVerdict, openaiVerdict]) => logComparison(mode, sym, 'BUY', 'xai', geminiVerdict, openaiVerdict, verdict))
      .catch(() => {});

    if (verdict.engine === 'passthrough' || verdict.action !== 'BUY' || verdict.confidence < T212_MIN_CONFIRM_CONFIDENCE) continue;

    // Confidence-scaled size within the bounded range, capped by whatever's
    // actually left in the budget — the acting model's discretion within
    // rails, not an unbounded amount on a real account.
    const scale = Math.min(1, Math.max(0, (verdict.confidence - T212_MIN_CONFIRM_CONFIDENCE) / (100 - T212_MIN_CONFIRM_CONFIDENCE)));
    let budgetGbp = Math.min(remaining, Math.round(T212_MIN_POSITION_GBP + scale * (T212_MAX_POSITION_GBP - T212_MIN_POSITION_GBP)));

    // Real-track-record sizing on top of the confidence scale — scales
    // toward what this bot's own closed-trade history actually supports.
    // Neutral until there's a real sample (nothing yet — this bot only just
    // started), same infra as the IG/Alpaca bots use.
    const edge = edgeSizing(journalMode(mode), ISA_STRATEGY);
    if (edge.skip) { addLog(mode, 'wait', sym, `Skipped — ${edge.reason}`); continue; }
    if (edge.multiplier !== 1) {
      addLog(mode, 'info', sym, edge.reason);
      budgetGbp = Math.min(remaining, Math.round(budgetGbp * edge.multiplier));
    }
    if (budgetGbp < T212_MIN_POSITION_GBP) continue;

    const t212Ticker = await resolveT212Ticker(mode, sym).catch(() => null);
    if (!t212Ticker) { addLog(mode, 'wait', sym, 'Not tradable on T212 — skipping'); continue; }

    const gbpUsd = await getGbpUsd();
    const qty = Math.round(((budgetGbp * gbpUsd) / trend.currentPrice) * 10000) / 10000;
    if (qty <= 0) continue;

    try {
      const order = await placeMarketOrder(mode, t212Ticker, qty);
      addLog(mode, 'enter', sym, `BUY ${qty} ${t212Ticker} — £${budgetGbp} (trend +${trend.trend12w.toFixed(1)}%/12w, Gemini ${verdict.confidence}%) — order ${order.id ?? 'placed'}`);
      st.botOpened[t212Ticker] = { enteredAt: Date.now(), budgetGbp, avgPrice: trend.currentPrice };
      saveState(mode, st);
      recordJournalEvent({
        mode: journalMode(mode), event: 'entry', symbol: sym, strategy: ISA_STRATEGY,
        side: 'long', qty, price: trend.currentPrice, reason: verdict.reason, confidence: verdict.confidence,
      });
    } catch (e) {
      addLog(mode, 'error', sym, `Order failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ── Exits ────────────────────────────────────────────────────────────────

async function pollExits(mode: T212Mode, positions: T212Position[]): Promise<void> {
  const st  = rs(mode).state;
  const byTicker = new Map(positions.map(p => [p.ticker, p]));
  // A just-placed market order does NOT appear in getPortfolio() until it
  // actually fills — which, placed at/after market close, can take hours.
  // Without checking pending orders too, a botOpened entry whose order
  // simply hasn't filled yet looks identical to one that was "closed
  // elsewhere," gets dropped from tracking, and gets re-entered next cycle
  // as a duplicate — this happened for real on 2026-08-24 (MSFT/V/MA/MRVL/
  // ASML all double-bought on a restart minutes after entry). Only treat a
  // tracked ticker as gone if it's in neither the portfolio nor pending orders.
  let pendingTickers = new Set<string>();
  try { pendingTickers = new Set((await getOrders(mode)).map(o => o.ticker)); }
  catch { /* best-effort — on failure, fall through and rely on portfolio only */ }

  for (const [ticker, tracked] of Object.entries(st.botOpened)) {
    // Structural guard, not just convention — this loop only ever iterates
    // botOpened, and preExisting entries are never added to it, so there is
    // no code path here that can reach a pre-existing holding. Belt-and-
    // braces check anyway.
    if (st.preExisting.includes(ticker)) { delete st.botOpened[ticker]; continue; }

    const pos = byTicker.get(ticker);
    if (!pos) {
      if (pendingTickers.has(ticker)) continue; // order still working, not filled yet — leave tracked, check again next cycle
      delete st.botOpened[ticker]; saveState(mode, st); continue; // genuinely closed elsewhere (or the order never filled/was cancelled)
    }

    const underlying = ticker.replace(/_[A-Z]{2}_EQ$/, '');
    const trend = await fetchTrend(underlying);
    // Two separate reasons to escalate to Gemini, both intentionally rare:
    //  1. A genuinely sustained, corroborated decline (same conservative bar
    //     as the existing position-review tool) — "defaults hard to KEEP",
    //     ordinary noise gets no call at all.
    //  2. The position has become an extended/spent move (up a lot, sitting
    //     right at its high) — this can be worth trimming on its own even
    //     with no bad news yet, since the concern is the easy gain being
    //     already priced in, not a deterioration. Throttled to once/24h per
    //     position so a stock that stays extended doesn't get re-asked every
    //     3-hour cycle.
    const trendBad = trend.trend12w !== null && trend.trend12w <= EXIT_TREND_12W_BAD && trend.trend4w !== null && trend.trend4w <= EXIT_TREND_4W_BAD;
    const extended = isExtendedMove(trend);
    const extendedRecentlyChecked = !!tracked.lastVerdict && (Date.now() - tracked.lastVerdict.at) < 24 * 3600_000;
    if (!trendBad && !(extended && !extendedRecentlyChecked)) continue;

    if (isT212AiPaused(mode)) {
      addLog(mode, 'wait', underlying, 'AI paused — would normally review this position now, skipping');
      continue;
    }
    if (tracked.aiReviewPaused) {
      addLog(mode, 'wait', underlying, 'AI review paused for this position — skipping (other positions unaffected)');
      continue;
    }

    const news = await fetch30DayNews(underlying);
    const newsBad = news.bear >= EXIT_NEWS_BEAR_MIN && news.sentiment <= EXIT_NEWS_SENTIMENT_MAX;
    if (trendBad && !newsBad && !extended) {
      addLog(mode, 'wait', underlying, `Down ${trend.trend12w!.toFixed(1)}%/12w but no corroborating negative news — holding, could be sector-wide or temporary`);
      continue;
    }
    if (!trendBad && extended) {
      addLog(mode, 'info', underlying, `Up ${trend.trend12w!.toFixed(1)}%/12w, sitting ${trend.pctBelowHigh!.toFixed(1)}% below its 52-week high — checking whether this run still has room or is already fully priced in`);
    }

    const upl = pos.ppl ?? ((pos.currentPrice ?? tracked.avgPrice) - tracked.avgPrice) * pos.quantity;
    const uplPct = tracked.avgPrice > 0 ? (upl / (tracked.avgPrice * pos.quantity)) * 100 : 0;
    const thesisReq = {
      instrumentName: ticker, action: 'SELL' as const, price: pos.currentPrice ?? tracked.avgPrice,
      trend4w: trend.trend4w, trend12w: trend.trend12w, trend52w: trend.trend52w, pctBelowHigh: trend.pctBelowHigh,
      newsSentiment: news.sentiment, headlines: news.headlines,
      heldWeeks: (Date.now() - tracked.enteredAt) / (7 * 86_400_000),
      unrealizedPlPct: uplPct,
    };
    const verdict = await askXaiIsaThesis(thesisReq);
    tracked.lastVerdict = { action: verdict.action, confidence: verdict.confidence, reason: verdict.reason, engine: verdict.engine, at: Date.now() };
    addLog(mode, 'info', underlying, `[XAI] ${verdict.action} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);

    // Comparison-only — never affects the trade, see logComparison's own comment.
    void Promise.all([askGeminiIsaThesis(thesisReq), askOpenAiIsaThesis(thesisReq)])
      .then(([geminiVerdict, openaiVerdict]) => logComparison(mode, underlying, 'SELL', 'xai', geminiVerdict, openaiVerdict, verdict))
      .catch(() => {});

    if (verdict.action === 'SELL' && verdict.engine === 'xai') {
      try {
        await placeMarketOrder(mode, ticker, -Math.abs(pos.quantity));
        addLog(mode, 'exit', underlying, `SOLD ${pos.quantity} ${ticker} — ${verdict.reason}`);
        recordJournalEvent({
          mode: journalMode(mode), event: 'exit', symbol: underlying, strategy: ISA_STRATEGY,
          side: 'long', qty: pos.quantity, price: pos.currentPrice ?? tracked.avgPrice, reason: verdict.reason,
          confidence: verdict.confidence, plUsd: upl, plPct: uplPct,
        });
        delete st.botOpened[ticker];
      } catch (e) {
        addLog(mode, 'error', underlying, `Sell failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    saveState(mode, st);
  }
}

// Live-ish GBP/USD — needed because T212 orders take a share quantity, not
// a £ amount, and most candidates here are USD-priced. Approximate (a
// single Yahoo quote, not a real-time FX feed) is an acceptable trade-off
// at these position sizes (£150-500) — a few % FX drift doesn't materially
// change the outcome the way it would on a much larger order.
let cachedGbpUsd: { at: number; rate: number } | null = null;
async function getGbpUsd(): Promise<number> {
  if (cachedGbpUsd && Date.now() - cachedGbpUsd.at < 30 * 60_000) return cachedGbpUsd.rate;
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/GBPUSD=X?interval=1d&range=5d', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClearGains/1.0)' }, signal: AbortSignal.timeout(8_000),
    });
    const data = await res.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } };
    const rate = data.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (rate && rate > 0) { cachedGbpUsd = { at: Date.now(), rate }; return rate; }
  } catch { /* fall through to fallback */ }
  return cachedGbpUsd?.rate ?? 1.27; // stale cache or a reasonable static fallback rather than throwing
}

// ── Poll loop / public API ──────────────────────────────────────────────────

async function poll(mode: T212Mode): Promise<void> {
  const run = rs(mode);
  if (!run.running) return;
  run.lastPollTs = new Date().toISOString();

  // US/UK stock markets are shut all weekend — skip the scan (Gemini/OpenAI/
  // xAI + Finnhub calls) entirely rather than burning that usage on stale
  // Friday-close data. Still runs the one-time first-run snapshot below even
  // on a weekend so a bot started on a Saturday doesn't sit unprotected.
  if (run.state.initialized && isWeekend()) {
    addLog(mode, 'info', '—', 'Weekend — markets closed, skipping poll');
  } else {
    try {
      const positions = await getPortfolio(mode);

      if (!run.state.initialized) {
        run.state.preExisting = positions.map(p => p.ticker);
        run.state.initialized = true;
        saveState(mode, run.state);
        addLog(mode, 'info', '—', `First run — locked ${positions.length} existing position(s) as permanently protected: ${positions.map(p => p.ticker).join(', ')}`);
      } else {
        await pollExits(mode, positions);
        await pollEntries(mode);
      }
    } catch (e) {
      addLog(mode, 'error', '—', `Poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (run.running) {
    const delayMs = isWeekend() ? msUntilMondayOpen() : T212_POLL_MS;
    run.nextRunMs = Date.now() + delayMs;
    run.pollTimer = setTimeout(() => { void poll(mode); }, delayMs);
  }
}

// Own loop, own cadence — see the momentum strategy's own top-of-section
// comment for why this can't share the ISA bot's 3-hour poll() above.
// Still gated behind the same first-run preExisting snapshot (reads
// run.state.initialized, set by poll() above) so momentum entries can't
// possibly fire before that snapshot exists, same protection the ISA side gets.
async function pollMomentum(mode: T212Mode): Promise<void> {
  const run = rs(mode);
  if (!run.running) return;

  // Same weekend skip as poll() above — this loop is 15min-cadence, so
  // leaving it ungated would burn Finnhub + AI-confirm calls all weekend
  // for nothing (no fresh price/news to react to until Monday).
  if (run.state.initialized && !isWeekend()) {
    try {
      const positions = await getPortfolio(mode);
      await pollMomentumExits(mode, positions);
      await pollMomentumEntries(mode);
    } catch (e) {
      addLog(mode, 'error', '—', `[Momentum] Poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (run.running) {
    const delayMs = isWeekend() ? msUntilMondayOpen() : MOMENTUM_POLL_MS;
    run.momentumNextRunMs = Date.now() + delayMs;
    run.momentumPollTimer = setTimeout(() => { void pollMomentum(mode); }, delayMs);
  }
}

// Survives a PM2 restart — without this, a VM restart (which happens
// routinely whenever any part of this codebase gets redeployed) would
// silently stop the T212 bot until someone noticed and started it by hand,
// same reasoning as every other bot's own auto-resume.
function runningFlagFile(mode: T212Mode): string {
  return path.join(__dirname, '..', `t212-bot-running-${mode}.json`);
}
export function wasT212BotRunning(mode: T212Mode): boolean {
  try { return (JSON.parse(fs.readFileSync(runningFlagFile(mode), 'utf8')) as { running: boolean }).running; }
  catch { return false; }
}
function saveRunningFlag(mode: T212Mode, running: boolean): void {
  try { fs.writeFileSync(runningFlagFile(mode), JSON.stringify({ running }), 'utf8'); } catch {}
}

export async function startT212Bot(mode: T212Mode): Promise<{ ok: boolean; error?: string }> {
  if (!hasT212Creds(mode)) return { ok: false, error: `T212 ${mode} credentials not configured` };
  const run = rs(mode);
  if (run.pollTimer) clearTimeout(run.pollTimer);
  if (run.momentumPollTimer) clearTimeout(run.momentumPollTimer);
  run.running = true;
  saveRunningFlag(mode, true);
  addLog(mode, 'info', '—', `T212 ISA bot started — £${T212_MIN_POSITION_GBP}-${T212_MAX_POSITION_GBP}/position, £${T212_TOTAL_BUDGET_GBP} total budget, checking every ${(T212_POLL_MS / 3_600_000).toFixed(0)}h — long-term trend+news selection, not swing timing`);
  addLog(mode, 'info', '—', `[Momentum] Second strategy running alongside — £${MOMENTUM_MIN_POSITION_GBP}-${MOMENTUM_MAX_POSITION_GBP}/position, £${MOMENTUM_TOTAL_BUDGET_GBP} total budget, checking every ${(MOMENTUM_POLL_MS / 60_000).toFixed(0)}m — today's move+volume+news, AI-confirmed`);
  void poll(mode);
  void pollMomentum(mode);
  return { ok: true };
}

export function stopT212Bot(mode: T212Mode): { ok: boolean } {
  const run = rs(mode);
  run.running = false;
  saveRunningFlag(mode, false);
  if (run.pollTimer) { clearTimeout(run.pollTimer); run.pollTimer = null; }
  if (run.momentumPollTimer) { clearTimeout(run.momentumPollTimer); run.momentumPollTimer = null; }
  addLog(mode, 'info', '—', 'T212 ISA bot stopped (both strategies)');
  return { ok: true };
}

export async function getT212BotStatus(mode: T212Mode): Promise<{
  running: boolean; log: LogEntry[]; nextRunMs: number | null; lastPollTs: string | null;
  preExisting: string[]; botOpened: Record<string, BotOpenedEntry>;
  botOpenedMomentum: Record<string, BotOpenedEntry>; momentumNextRunMs: number | null; momentumBudgetGbp: number;
  momentumAiGateEnabled: boolean;
  cash?: { free: number; total: number }; positions?: T212Position[];
  aiPaused: boolean; totalBudgetGbp: number;
}> {
  const run = rs(mode);
  let cash, positions;
  if (hasT212Creds(mode)) {
    try { [cash, positions] = await Promise.all([getCash(mode), getPortfolio(mode)]); } catch { /* best-effort */ }
  }
  return {
    running: run.running, log: run.log.slice(0, 100), nextRunMs: run.nextRunMs, lastPollTs: run.lastPollTs,
    preExisting: run.state.preExisting, botOpened: run.state.botOpened,
    botOpenedMomentum: run.state.botOpenedMomentum, momentumNextRunMs: run.momentumNextRunMs, momentumBudgetGbp: MOMENTUM_TOTAL_BUDGET_GBP,
    momentumAiGateEnabled: isMomentumAiGateEnabled(mode),
    cash: cash ? { free: cash.free, total: cash.total } : undefined,
    positions,
    aiPaused: isT212AiPaused(mode), totalBudgetGbp: T212_TOTAL_BUDGET_GBP,
  };
}

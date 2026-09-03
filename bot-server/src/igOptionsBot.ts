// ── IG index-options autotrader ─────────────────────────────────────────────
// Built 2026-08-31 per explicit request: an options-specific autotrader "like
// we made for options" on Alpaca, running against IG's own index options
// (spread-bet options — monthly OP.D.* epics: "FTSE 10300 Call" SEP-26,
// "US 500 5000 Put", etc., confirmed to exist on the demo API by direct
// search probe the same day). Demo-first per the same request.
//
// Deliberately NOT a new strategy design. The entry/exit brain is
// optionsDirectionalSignal from alpacaStrategies.ts — the trend-following
// rewrite (daily bars, price/EMA20 vs sloping EMA50, RSI continuation zone,
// MACD accelerating) built 2026-08-21 to replace the RSI-extreme logic that
// kept buying puts into rallies, plus its own full exit lifecycle (≤DTE
// close, +75% target, peak-retrace lock-in, -50% premium stop). One brain,
// two brokers. The AI confirm layer is askIgConfirmStockTrade (OpenAI
// primary, Gemini fallback) — the exact same "rules qualify, AI confirms"
// step the IG stock bot's gemini_confirmed strategy and the T212 momentum
// port already use.
//
// Why buying options here needs no broker-side stop at all: a bought option
// spread bet's maximum loss is the premium paid × stake, full stop. The
// premium IS the risk — sizing is budget ÷ premium, and there is nothing a
// stop-loss could protect that isn't already capped by construction. This is
// structurally safer than any CFD position this account runs.
//
// Same-day (DO.D.*) options exist too and are deliberately NOT traded —
// tried first for the stock strategy below, corrected same day after
// hitting exactly the failure mode the 2026-08-21 Alpaca options rebuild
// already taught this codebase to avoid (its own expiry window was widened
// 7-21d → 21-45d for the identical reason): almost no time for a thesis to
// play out, dead OTM/ATM liquidity, and theta bleeding a stalled-but-not-
// wrong trade to zero within hours. See STOCK_UNDERLYINGS' own comment for
// the full story and what it trades instead (a real weekly chain).
import * as fs from 'fs';
import * as path from 'path';
import {
  authenticate, getSession, fetchFullPositions, closePosition,
  fetchMarketDetails, searchMarkets, placeMarketOrder, fetchClosedTransactions,
  type IGSession, type FullPosition,
} from './igApi';
import { optionsDirectionalSignal } from './alpacaStrategies';
import { resolveCredentials, type IgMode } from './igStrategyBot';
import { recordJournalEvent, type JournalMode } from './tradeJournal';
import { askIgConfirmStockTrade, askMrSafety, askOptionsExit } from './openai';
import { fetchAllHeadlines } from './newsFetch';
import { fetchBarsWithFallback } from './yahooFetch';
import { isScannerQuietWeekend, msUntilWeekendReopen, isNYSEOpen, isNearClose } from './alpacaApi';
import { edgeSizing } from './quant';
import { sentimentScore } from './momentumSignal';

// Underlyings whose IG option chains this bot scans. optName is the exact
// name prefix IG's option markets use ("FTSE 10300 Call" — note NOT
// "FTSE 100"), confirmed from the live search probe. newsTicker is a
// US-listed ETF proxy for the index, for the AI confirm step's headline
// context (Finnhub has no direct index-news endpoint) — null means the AI
// just gets "no news found", which its prompt already handles.
const UNDERLYINGS = [
  { epic: 'IX.D.FTSE.DAILY.IP',   name: 'FTSE 100',   optName: 'FTSE',        newsTicker: null  as string | null },
  { epic: 'IX.D.SPTRD.DAILY.IP',  name: 'US 500',     optName: 'US 500',      newsTicker: 'SPY' as string | null },
  { epic: 'IX.D.DOW.DAILY.IP',    name: 'Wall Street', optName: 'Wall Street', newsTicker: 'DIA' as string | null },
  { epic: 'IX.D.DAX.DAILY.IP',    name: 'Germany 40', optName: 'Germany 40',  newsTicker: null  as string | null },
];

// ── WEEKLY stock options (second strategy, added same day per explicit
// request — "part of the reason I wanted it setup on IG [was] to create
// stock option positions"). Originally built against IG's same-day dailies
// (DO.D.AAPL.* etc.) — corrected same day after the user directly checked
// IG's own UI and found a weekly chain the API search hadn't surfaced (a
// plain "Apple Call" search's 50-result cap was entirely consumed by the
// ~45-strike daily chain, silently hiding the much shorter weekly one from
// every earlier probe). Confirmed directly against IG: the weekly chain
// (ON.D.*, "Weekly Apple Inc 29000 CALL" etc.) exists for Apple/Amazon/
// NVIDIA with real liquidity (1-6% spreads, vs 13-100%+ on the dailies —
// same-day options were structurally the wrong product: dead OTM/ATM
// markets, some strikes rejecting MARKET orders outright, and theta
// bleeding a stalled-but-not-wrong thesis to zero within hours). Tesla has
// no live weekly listing right now (its only "weekly" search hit was an
// expired 2025 contract) so it's dropped rather than forced.
//
// Universe widened same day after the user pointed out IG's own "24 Hours"
// share list has ~30 names, not just these 3 — checked every one with a
// real weekly-chain + live-spread probe rather than adding names blind.
// Meta/AMD/Palantir cleared the same liquidity bar as Apple/NVIDIA/Amazon
// (5-8% spreads). Explicitly tried and rejected: Microsoft, Netflix,
// Broadcom, Micron, Super Micro — no ON.D weekly chain exists for these at
// all on IG right now, not a liquidity issue, just not offered. Also
// rejected on liquidity despite a chain existing: Robinhood (39% spread),
// GameStop (86%), MARA Holdings (92%), SoFi (100%, i.e. a dead market) —
// same illiquid-meme-stock pattern that broke the original same-day
// strategy; adding these would reintroduce the exact problem this
// migration fixed. Alphabet/Coinbase/Salesforce/ARM sit in a borderline
// 10-13% tier — left out for now to keep the universe at the same quality
// bar as the rest, not a hard no if the user wants more breadth later.
//
// This still runs the same momentum+news idea proven on the T212 momentum
// port — a real move today, AI-confirmed with real headlines — just
// expressed with several days of runway instead of hours, which is a far
// better match for "the news needs a bit of time to keep mattering" anyway.
// Own journal key so /performance judges it separately.
const STOCK_UNDERLYINGS = [
  { shareEpic: 'UA.D.AAPL.CASH.IP',  name: 'Apple',    searchName: 'Weekly Apple Inc',                  finnhub: 'AAPL', strikeStep: 250 },
  { shareEpic: 'UC.D.NVDA.DAILY.IP', name: 'NVIDIA',   searchName: 'Weekly NVIDIA Corp',                finnhub: 'NVDA', strikeStep: 250 },
  { shareEpic: 'UA.D.AMZN.CASH.IP',  name: 'Amazon',   searchName: 'Weekly Amazon.com Inc',             finnhub: 'AMZN', strikeStep: 250 },
  { shareEpic: 'UB.D.FB.DAILY.IP',   name: 'Meta',     searchName: 'Weekly Meta Platforms Inc',         finnhub: 'META', strikeStep: 250 },
  { shareEpic: 'SA.D.AMD.DAILY.IP',  name: 'AMD',      searchName: 'Weekly Advanced Micro Devices Inc', finnhub: 'AMD',  strikeStep: 250 },
  { shareEpic: 'SE.D.PLTRUS.DAILY.IP', name: 'Palantir', searchName: 'Weekly Palantir Technologies Inc', finnhub: 'PLTR', strikeStep: 250 },
];
const STOCK_STRATEGY = 'ig_options_weekly_momentum';
// Same-day chain, re-added 2026-09-01 per explicit request ("consider
// opening both options daily and weekly position... even raise the
// positions if you have to... gives us a better scope and opportunity...
// now we're using demo, how profitable could this strategy be") — running
// on demo specifically to actually find out, same reasoning the weekly
// premium budget below already uses. This is the ORIGINAL strategy key
// from before the 2026-08-31 pivot to weekly (see that migration's own
// comment above) — reused deliberately so any pre-pivot journal history
// under this same key is picked back up, not orphaned under a new one.
// Kept genuinely separate from weekly, not a replacement: different search
// name ("Daily X Inc" vs "Weekly X Inc"), different tracked-state key
// (`${shareEpic}:daily` vs plain shareEpic) so the same stock can carry
// both a same-day AND a several-day position at once, own day/eval-key
// throttle namespace, tighter spread cap (same-day chains are structurally
// worse — see the weekly migration comment for the 13-100%+ figures that
// caused it), and a hard force-close before the bell (no overnight hold —
// unlike weekly, there's no "a few days of runway" to fall back on here).
const STOCK_DAILY_STRATEGY = 'ig_options_daily_momentum';
const STOCK_DAILY_UNDERLYINGS = STOCK_UNDERLYINGS.map(u => ({ ...u, searchName: u.searchName.replace('Weekly', 'Daily') }));
const STOCK_DAILY_MAX_POSITIONS = 2;
const STOCK_DAILY_SPREAD_CAP    = 0.25; // tighter than weekly's 0.35 — same-day chains run structurally wider

// ── MONTHLY stock options (third strategy, added 2026-09-03 per explicit
// request/observation: weekly and same-day entries both fire off TODAY's
// price move, which means they're structurally always chasing a move that's
// already partly (same-day) or mostly (weekly) played out by the time
// they act — real trend-following theory says news-backed positions need
// real TIME to develop, the exact reasoning already proven in this account
// on the T212 ISA bot (12-week trend + 30-day news, months-to-years
// horizon, not today's move). This isn't the weekly/daily momentum logic
// on a longer clock — it's a genuinely different entry question, borrowed
// from the ISA bot's own philosophy: has this stock shown a REAL sustained
// trend over weeks, corroborated by real news, without already being a
// spent/extended move — not "did it move today."
//
// Confirmed live 2026-09-03 by direct search probe that this chain
// actually exists and was never being found: IG's stock options ALSO have
// genuine monthly-dated contracts (e.g. "Meta Platforms Inc 65000 CALL",
// expiry "SEP-26"/"OCT-26"/"DEC-26", epic root ON.D.*, OPT_SHARES) —
// completely separate from the Weekly/Daily chains, and only surfaced by a
// PLAIN company-name search (no "Weekly"/"Daily" prefix). The existing
// index-options constants (MIN_DTE/MAX_DTE/EXIT_DTE) already describe
// exactly this kind of monthly-expiry lifecycle, so this reuses them
// directly rather than inventing separate ones — same target of ~30 DTE at
// entry, same ≤5 DTE exit, same "3rd Friday" expiry estimate tolerance.
const STOCK_MONTHLY_STRATEGY = 'ig_options_monthly_trend';
const STOCK_MONTHLY_UNDERLYINGS = STOCK_UNDERLYINGS.map(u => ({ ...u, searchName: u.searchName.replace('Weekly ', '') }));
const STOCK_MONTHLY_MAX_POSITIONS = 2; // fewer, higher-conviction positions — same "not maximally concentrated" spirit as the ISA bot
// Same quality bar as the T212 ISA bot's own entry screen (t212Bot.ts) —
// deliberately reused numbers, not re-derived, since this is the exact
// same question asked about a different account/instrument.
const MONTHLY_MIN_TREND_12W_PCT = 8;   // % — a real, sustained multi-week uptrend, not a blip
const MONTHLY_MIN_TREND_4W_PCT  = -3;  // % — allow a small pullback within an intact longer trend
const MONTHLY_EXTENDED_TREND_12W_PCT = 40; // % — already a major re-rating, easy gain likely priced in
const MONTHLY_EXTENDED_NEAR_HIGH_PCT = 4;  // % below the 52-week high counts as "sitting at the top" of the move
const MONTHLY_MIN_CONFIRM_CONFIDENCE = 70; // same AI bar as every other confirmed entry in this codebase
// Per-mode premium budgets — demo runs big deliberately (per explicit
// request 2026-08-31, "its running on demo for now so put more on the
// line": demo money exists to generate meaningful P&L data, and tiny
// positions make even a good run look like noise). Live keeps the
// conservative figures automatically — going live must never inherit demo
// sizing by accident. Demo figure carried over from the daily-options era
// (found by trial there: real liquidity sits at ITM strikes, which cost
// more at IG's own minimum deal size than a small budget can afford) —
// the weekly chain's premiums are in the same range, so the same budget
// still applies.
// Demo raised to 800 2026-09-03 per explicit request — the real target for
// a demo position's sizing is now "however much it needs to open, capped by
// max loss" (see DEMO_MAX_LOSS_CEILING_GBP below), not a nominal budget the
// bot tries to hit and gives up past. Live stays untouched at its original
// £30 — this whole "size to whatever it needs, capped by loss not budget"
// approach is demo-only for now; live gets it too only once demo's proven
// out, per explicit instruction.
const STOCK_PREMIUM_GBP: Record<IgMode, number> = { demo: 800, live: 30 };
// Hard ceiling on total premium (= max possible loss, since a bought
// option can never lose more than that) a demo position is allowed to
// reach — replaces the old "2x nominal budget" escalation cap. The aim per
// explicit request: let every position open and size up to whatever it
// actually needs (not choke on a too-small nominal budget or IG's own
// unreliable minimum-size metadata), with max loss per position the only
// real constraint — target ~£800 (STOCK_PREMIUM_GBP.demo above), hard stop
// at £1,000 even if IG's real minimum would need more.
const DEMO_MAX_LOSS_CEILING_GBP = 1000;
const STOCK_MAX_POSITIONS   = 3; // raised from 2, 2026-09-01 per explicit request for more scope now the daily chain runs alongside it
const STOCK_MIN_MOVE_PCT    = 1.5;  // today's move must be a real one before the AI is even asked
// Same-day options get their own, lower bar — added 2026-09-03 per explicit
// request/catch: this was sharing STOCK_MIN_MOVE_PCT with the weekly
// strategy, but the two have completely different runway. A weekly option
// entered after a 1.5% move still has ~5 trading days for the thesis to
// keep developing; a same-day option entered after the same 1.5% move can
// have just a few hours left before the forced pre-close, with theta
// accelerating the whole time and the "easy" part of the move already
// priced into the premium — waiting for the full weekly-sized bar before
// acting means entering after most of the realistic move for the day is
// already behind you. Set below T212 momentum's own 0.5% (same-day options
// have even less runway than that strategy's multi-day swing hold), so
// this can catch a move earlier and smaller rather than waiting for it to
// fully play out first.
const STOCK_DAILY_MIN_MOVE_PCT = 0.3;
// Upper bound to go with the lower one above — added 2026-09-03 per
// explicit request. moveIsPlausible (below) only asks whether the
// REMAINING move to breakeven is reasonable; it says nothing about how much
// of TODAY's move has already happened before this bought in. A stock
// already up 5%+ intraday is the same-day version of "already extended" —
// most of the day's realistic move is probably already behind it, entering
// now is chasing, not catching it early. Deliberately a flat percentage
// (same style as EXTENDED_TREND_12W_PCT/EXTENDED_TREND_52W_PCT in
// meanReversionBot.ts) rather than a per-stock historical baseline — no
// extra historical-bars fetch needed, just a sanity ceiling on top of the
// lower entry bar.
const STOCK_DAILY_ALREADY_EXTENDED_PCT = 4;
const STOCK_POLL_MS         = 15 * 60_000; // entries still want to catch intraday momentum promptly
const STOCK_EXIT_DTE_DAYS   = 1;    // close with ~1 day left rather than ride into the weekly's own theta/settlement endgame

// Premium budget per position — the literal maximum £ this trade can lose
// (bought option, loss capped at premium × stake by construction). Live is
// sized in the same league as the CFD bots' £20 risk/trade but slightly
// higher since, unlike a CFD stop, this cap physically cannot slip or gap.
// Demo runs bigger — see STOCK_PREMIUM_GBP's comment above.
const INDEX_PREMIUM_GBP: Record<IgMode, number> = { demo: 250, live: 60 };
const MAX_POSITIONS   = 2;        // across all underlyings; one per underlying enforced separately
const MIN_CONFIRM_CONFIDENCE = 70; // same AI bar as every other confirmed entry in this codebase
const POLL_MS = 60 * 60_000;       // hourly — the signal only changes on daily bars
// How much longer than a loop's own normal cadence counts as "this bot was
// actually down/delayed" rather than ordinary jitter — same threshold and
// reasoning as meanReversionBot.ts's identical constant.
const STALE_GAP_MULTIPLE = 3;
// Expiry window for a NEW position — same 21-45d target as the Alpaca
// options rebuild, with tolerance either side because IG's monthly chains
// only come in fixed expiries (a "SEP-26" chain is whatever DTE it is today).
const MIN_DTE = 15;
const MAX_DTE = 50;
// Monthly expiries ("SEP-26") don't carry an exact day — estimated as the
// 3rd Friday (standard index-option convention). Exits close at ≤5 DTE
// rather than the Alpaca signal's own ≤2 to absorb that estimate's error.
const EXIT_DTE = 5;

const STRATEGY = 'ig_options_directional';
function journalMode(mode: IgMode): JournalMode { return mode === 'live' ? 'ig-live' : 'ig-demo'; }
function strategyFor(tr: { kind?: 'index' | 'stock' | 'stock-daily' | 'stock-monthly' }): string {
  if (tr.kind === 'stock-daily') return STOCK_DAILY_STRATEGY;
  if (tr.kind === 'stock-monthly') return STOCK_MONTHLY_STRATEGY;
  return tr.kind === 'stock' ? STOCK_STRATEGY : STRATEGY;
}

type Tracked = {
  dealId: string; epic: string; underlyingEpic: string; name: string;
  optionType: 'call' | 'put'; strike: number; expiry: string; expiryMs: number;
  premium: number; size: number; enteredAt: number; peakPlPct: number;
  lastAiCheckAt?: number; // daily severe-news safety check — see manageExits
  kind?: 'index' | 'stock' | 'stock-daily' | 'stock-monthly'; // absent = index (positions tracked before the stock strategy existed)
};

type LogEntry = { id: string; ts: string; type: 'info' | 'enter' | 'exit' | 'wait' | 'error'; epic: string; msg: string };

type BotState = {
  running: boolean;
  session: IGSession | null;
  tracked: Record<string, Tracked>; // keyed by underlying epic — one option position per underlying
  log: LogEntry[];
  pollTimer: ReturnType<typeof setTimeout> | null;
  stockPollTimer: ReturnType<typeof setTimeout> | null; // faster loop for the weekly stock strategy's entries
  fastMonitorTimer: ReturnType<typeof setTimeout> | null; // exits-only loop, both kinds — see fastPositionMonitor's own comment
  nextRunMs: number | null;
  lastPollTs: string | null;
  stockLastPollTs: string | null; // stockPoll's own cadence is independent of poll's, see each one's own gap-check
  // One momentum entry per stock per day, even after that entry has closed —
  // re-chasing the same move after banking/stopping it is how a daily-theta
  // product churns premium away. In-memory only: worst case a restart allows
  // one repeat entry, still AI-gated.
  lastStockEntryDay: Record<string, string>;
  // What the AI was actually shown last time this underlying was evaluated
  // — shared by both the daily stock strategy (keyed by finnhub symbol:
  // headline set + rounded day-change) and the monthly index strategy
  // (keyed by underlying epic: headline set + side only — the index side's
  // technical numbers genuinely refresh every hourly bar, so only the news
  // component needs this guard). See scanStockEntries' own comment:
  // confirmed live the AI call re-asked on IDENTICAL facts every 15min
  // oscillates HOLD/SKIP with no new information, and the trade that
  // eventually fires is whichever side of that noise it happened to land on,
  // not a real signal. In-memory only, resets on restart (worst case one
  // extra AI call per underlying, not a correctness issue).
  lastOptionEvalKey: Record<string, string>;
};

const states = new Map<IgMode, BotState>();

function trackedFile(mode: IgMode): string { return path.join(__dirname, '..', `ig-options-tracked-${mode}.json`); }
function loadTracked(mode: IgMode): Record<string, Tracked> {
  try { return JSON.parse(fs.readFileSync(trackedFile(mode), 'utf8')) as Record<string, Tracked>; }
  catch { return {}; }
}
function saveTracked(mode: IgMode, tracked: Record<string, Tracked>): void {
  try { fs.writeFileSync(trackedFile(mode), JSON.stringify(tracked), 'utf8'); } catch {}
}

function runningFlagFile(mode: IgMode): string { return path.join(__dirname, '..', `ig-options-running-${mode}.json`); }
export function wasIgOptionsBotRunning(mode: IgMode): boolean {
  try { return (JSON.parse(fs.readFileSync(runningFlagFile(mode), 'utf8')) as { running: boolean }).running; }
  catch { return false; }
}
function saveRunningFlag(mode: IgMode, running: boolean): void {
  try { fs.writeFileSync(runningFlagFile(mode), JSON.stringify({ running }), 'utf8'); } catch {}
}

function st(mode: IgMode): BotState {
  let s = states.get(mode);
  if (!s) {
    s = { running: false, session: null, tracked: loadTracked(mode), log: [], pollTimer: null, stockPollTimer: null, fastMonitorTimer: null, nextRunMs: null, lastPollTs: null, stockLastPollTs: null, lastStockEntryDay: {}, lastOptionEvalKey: {} };
    states.set(mode, s);
  }
  return s;
}

function addLog(mode: IgMode, type: LogEntry['type'], epic: string, msg: string): void {
  const s = st(mode);
  const entry: LogEntry = { id: Math.random().toString(36).slice(2, 9), ts: new Date().toLocaleTimeString('en-GB', { hour12: false }), type, epic, msg };
  s.log.unshift(entry);
  if (s.log.length > 200) s.log.length = 200;
  console.log(`[ig-options:${mode}] [${type.toUpperCase()}] [${epic}] ${msg}`);
}

// Same shared session key as every other IG bot (igStrategyBot, fx scalper,
// geminiWatch, meanReversionBot) — one login, not another separate one.
async function getOrAuthSession(mode: IgMode): Promise<IGSession | null> {
  const sessionKey = `igstrat:${mode}`;
  const existing = getSession(sessionKey);
  if (existing && Date.now() < existing.expiresAt - 2 * 60_000) return existing;
  const creds = resolveCredentials(mode);
  if (!creds.apiKey || !creds.username || !creds.password) return null;
  try { return await authenticate(creds.apiKey, creds.username, creds.password, creds.env, sessionKey); }
  catch { return null; }
}

// ── Expiry parsing ──────────────────────────────────────────────────────────
const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

function thirdFriday(year: number, month: number): Date {
  const d = new Date(Date.UTC(year, month, 1));
  const firstFriday = 1 + ((5 - d.getUTCDay() + 7) % 7);
  return new Date(Date.UTC(year, month, firstFriday + 14, 16, 0, 0));
}

// "30-SEP-26" → that exact date; "SEP-26" → estimated 3rd Friday (standard
// index-option expiry convention; see EXIT_DTE's comment for the buffer that
// absorbs this being a few days off IG's real settlement day).
function parseExpiryMs(expiry: string): number | null {
  const exact = /^(\d{1,2})-([A-Z]{3})-(\d{2})$/.exec(expiry);
  if (exact) {
    const mo = MONTHS[exact[2]];
    if (mo === undefined) return null;
    return Date.UTC(2000 + Number(exact[3]), mo, Number(exact[1]), 16, 0, 0);
  }
  const monthly = /^([A-Z]{3})-(\d{2})$/.exec(expiry);
  if (monthly) {
    const mo = MONTHS[monthly[1]];
    if (mo === undefined) return null;
    return thirdFriday(2000 + Number(monthly[2]), mo).getTime();
  }
  return null;
}

// ── Option chain discovery ──────────────────────────────────────────────────
// IG has no chain endpoint on this API — but its market search matches the
// option names exactly ("FTSE 10300 Call"), confirmed by live probe. So:
// compute candidate strikes around spot (nearest-OTM first, over the strike
// steps IG's index ladders actually use), search each exact name, and take
// the first hit whose parsed expiry lands in the DTE window. Worst case a
// handful of search calls, and only after a signal has already fired AND the
// AI confirmed it — rare by construction, so no allowance concern.
async function findOptionEpic(
  mode: IgMode, session: IGSession, optName: string, side: 'call' | 'put', spot: number,
): Promise<{ epic: string; name: string; strike: number; expiry: string; expiryMs: number } | null> {
  const STEPS = [25, 50, 100];
  const candidates: number[] = [];
  for (const step of STEPS) {
    const base = side === 'call' ? Math.ceil(spot / step) * step : Math.floor(spot / step) * step;
    for (let k = 0; k < 2; k++) {
      const strike = base + k * step * (side === 'call' ? 1 : -1);
      if (!candidates.includes(strike)) candidates.push(strike);
    }
  }
  // Nearest to spot first — slightly OTM, never deep
  candidates.sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));

  const sideWord = side === 'call' ? 'Call' : 'Put';
  const now = Date.now();
  let searches = 0;
  for (const strike of candidates) {
    if (searches >= 8) break; // hard cap on API calls per entry attempt
    searches++;
    await new Promise(r => setTimeout(r, 350));
    let results;
    try { results = await searchMarkets(session, `${optName} ${strike} ${sideWord}`); }
    catch (e) { addLog(mode, 'error', optName, `Chain search failed: ${e instanceof Error ? e.message : String(e)}`); continue; }

    const nameRe = new RegExp(`^${optName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\(End of Month\\))? ${strike} ${sideWord}$`, 'i');
    const matches = results
      .filter(m => m.instrumentType === 'OPT_INDICES' && nameRe.test(m.name))
      .map(m => ({ ...m, expiryMs: parseExpiryMs(m.expiry) }))
      .filter((m): m is typeof m & { expiryMs: number } => m.expiryMs !== null)
      .map(m => ({ ...m, dte: (m.expiryMs - now) / 86_400_000 }))
      .filter(m => m.dte >= MIN_DTE && m.dte <= MAX_DTE)
      .sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30)); // closest to ~30 DTE

    if (matches.length) {
      const m = matches[0];
      return { epic: m.epic, name: m.name, strike, expiry: m.expiry, expiryMs: m.expiryMs };
    }
  }
  return null;
}

// ── Monthly stock option chain discovery ────────────────────────────────────
// Same shape as findOptionEpic above (DTE-windowed search, closest-to-30-DTE
// pick), adapted for stocks: OPT_SHARES not OPT_INDICES, and strike steps
// per-underlying (u.strikeStep) rather than the index's fixed 25/50/100
// ladder — matches the exact strike-stepping already used by
// scanStockEntries/scanStockDailyEntries for the same underlyings.
async function findStockMonthlyOptionEpic(
  mode: IgMode, session: IGSession, u: typeof STOCK_MONTHLY_UNDERLYINGS[number], side: 'call' | 'put', spot: number,
): Promise<{ epic: string; name: string; strike: number; expiry: string; expiryMs: number } | null> {
  const dir = side === 'call' ? 1 : -1;
  const base = side === 'call' ? Math.ceil(spot / u.strikeStep) * u.strikeStep : Math.floor(spot / u.strikeStep) * u.strikeStep;
  const candidates = [base, base + u.strikeStep * dir, base - u.strikeStep * dir];
  const sideWord = side === 'call' ? 'CALL' : 'PUT';
  const now = Date.now();
  for (const strike of candidates) {
    await new Promise(r => setTimeout(r, 350));
    let results;
    try { results = await searchMarkets(session, `${u.searchName} ${strike} ${sideWord}`); }
    catch (e) { addLog(mode, 'error', u.name, `[Monthly] Chain search failed: ${e instanceof Error ? e.message : String(e)}`); continue; }

    const nameRe = new RegExp(`^${u.searchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${strike} ${sideWord}$`, 'i');
    const matches = results
      .filter(m => m.instrumentType === 'OPT_SHARES' && nameRe.test(m.name))
      .map(m => ({ ...m, expiryMs: parseExpiryMs(m.expiry) }))
      .filter((m): m is typeof m & { expiryMs: number } => m.expiryMs !== null)
      .map(m => ({ ...m, dte: (m.expiryMs - now) / 86_400_000 }))
      .filter(m => m.dte >= MIN_DTE && m.dte <= MAX_DTE)
      .sort((a, b) => Math.abs(a.dte - 30) - Math.abs(b.dte - 30));

    if (matches.length) {
      const m = matches[0];
      return { epic: m.epic, name: m.name, strike, expiry: m.expiry, expiryMs: m.expiryMs };
    }
  }
  return null;
}

// ── Monthly stock trend read ─────────────────────────────────────────────────
// Same trend/extension question as t212Bot.ts's fetchTrend/isExtendedMove
// (12-week trend, 4-week pullback tolerance, 52-week-high proximity) —
// re-implemented here rather than imported, since those live in a different
// bot's module and aren't exported; kept numerically identical
// (MONTHLY_MIN_TREND_12W_PCT etc. above are the same values, not re-derived)
// so "a real trend" means the same thing in both places.
type StockTrend = { trend12w: number | null; trend4w: number | null; pctBelowHigh: number | null; currentPrice: number | null };
async function fetchStockTrend(u: typeof STOCK_MONTHLY_UNDERLYINGS[number], spot: number): Promise<StockTrend> {
  const empty: StockTrend = { trend12w: null, trend4w: null, pctBelowHigh: null, currentPrice: null };
  try {
    const bars = await fetchBarsWithFallback(u.shareEpic, '1y', { alpacaTimeframe: '1Day', yahooInterval: '1d', liveReferenceLevel: spot });
    if (!bars?.length || bars.length < 60) return empty;
    const closes = bars.map(b => b.c);
    const last = closes[closes.length - 1];
    const idx4w  = Math.max(0, closes.length - 1 - 20);
    const idx12w = Math.max(0, closes.length - 1 - 60);
    const trend4w  = closes[idx4w]  > 0 ? ((last - closes[idx4w])  / closes[idx4w])  * 100 : null;
    const trend12w = closes[idx12w] > 0 ? ((last - closes[idx12w]) / closes[idx12w]) * 100 : null;
    const window = closes.slice(Math.max(0, closes.length - 252));
    const high52w = Math.max(...window);
    const pctBelowHigh = high52w > 0 ? ((high52w - last) / high52w) * 100 : null;
    return { trend12w, trend4w, pctBelowHigh, currentPrice: last };
  } catch {
    return empty;
  }
}

// ── Monthly stock options — trend+news entries ──────────────────────────────
// Entry question is deliberately NOT "did it move today" (that's the
// weekly/daily strategies' job) — it's the ISA bot's own question: a real,
// sustained multi-week uptrend, not already extended, corroborated by real
// news, on a horizon that can actually afford to wait out ordinary noise.
// Own 15-min poll slot (piggybacks on stockPoll below, no separate loop
// needed — this doesn't need the weekly/daily strategies' urgency, but
// there's no harm in checking this often either, since a real trend doesn't
// appear or vanish between one 15-min check and the next).
async function scanStockMonthlyEntries(mode: IgMode, session: IGSession): Promise<void> {
  const s = st(mode);
  if (countKind(s, 'stock-monthly') >= STOCK_MONTHLY_MAX_POSITIONS) return;
  if (!isNYSEOpen()) return;

  const details = await fetchMarketDetails(session, STOCK_MONTHLY_UNDERLYINGS.map(u => u.shareEpic));

  for (const u of STOCK_MONTHLY_UNDERLYINGS) {
    if (countKind(s, 'stock-monthly') >= STOCK_MONTHLY_MAX_POSITIONS) break;
    if (s.tracked[`${u.shareEpic}:monthly`]) continue;

    const d = details.get(u.shareEpic);
    const spot = typeof d?.bid === 'number' && typeof d?.offer === 'number' ? (d.bid + d.offer) / 2 : null;
    if (!spot) continue;

    const trend = await fetchStockTrend(u, spot);
    if (trend.trend12w === null || trend.currentPrice === null) continue;
    if (trend.trend12w < MONTHLY_MIN_TREND_12W_PCT || (trend.trend4w !== null && trend.trend4w < MONTHLY_MIN_TREND_4W_PCT)) continue;
    const extended = trend.trend12w >= MONTHLY_EXTENDED_TREND_12W_PCT && trend.pctBelowHigh !== null && trend.pctBelowHigh < MONTHLY_EXTENDED_NEAR_HIGH_PCT;
    if (extended) {
      addLog(mode, 'wait', u.name, `[Monthly] +${trend.trend12w.toFixed(1)}% /12w but sitting ${trend.pctBelowHigh!.toFixed(1)}% below its 52w high — already looks like a spent move, skipping`);
      continue;
    }

    let headlines: string[] = [];
    try { headlines = await fetchAllHeadlines(u.finnhub, 8, u.name); } catch { /* prompt handles empty */ }
    const sentiment = sentimentScore(headlines).score;
    if (sentiment <= -0.3 && headlines.length >= 2) {
      addLog(mode, 'wait', u.name, `[Monthly] Trend looks good (+${trend.trend12w.toFixed(1)}% /12w) but recent news is genuinely negative — skipping`);
      continue;
    }

    const side: 'call' | 'put' = 'call'; // long-only for now — same "not yet proven to short well" reasoning as most of this account's other strategies
    const verdict = await askIgConfirmStockTrade({
      instrumentName: `${u.name} (buying a monthly CALL option, weeks of runway, not a scalp)`,
      suggestedDir: 'BUY',
      ruleReasoning: `Sustained uptrend +${trend.trend12w.toFixed(1)}% over 12 weeks, real news backing, not already extended`,
      ruleConfidence: Math.max(1, Math.min(10, Math.round(trend.trend12w / 5))),
      price: trend.currentPrice, rsi: null, macdHist: null, lastCandles: [],
      headlines, dayChangePercent: trend.trend4w ?? 0,
      horizon: 'swing',
    });
    addLog(mode, 'info', u.name, `[Monthly] +${trend.trend12w.toFixed(1)}% /12w trend+news candidate → AI: ${verdict.direction} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);
    if (verdict.engine === 'passthrough' || verdict.direction !== 'BUY' || verdict.confidence < MONTHLY_MIN_CONFIRM_CONFIDENCE) continue;

    const opt = await findStockMonthlyOptionEpic(mode, session, u, side, spot);
    if (!opt) { addLog(mode, 'wait', u.name, `[Monthly] No ${side} found near ${spot.toFixed(0)} in the ${MIN_DTE}-${MAX_DTE}d monthly window`); continue; }

    const optDetails = (await fetchMarketDetails(session, [opt.epic])).get(opt.epic);
    const optBid   = typeof optDetails?.bid   === 'number' ? optDetails.bid   : null;
    const optOffer = typeof optDetails?.offer === 'number' ? optDetails.offer : null;
    if (!optDetails || optOffer === null || optOffer <= 0 || optDetails.marketStatus !== 'TRADEABLE') continue;
    if (optBid !== null && (optOffer - optBid) / optOffer > 0.35) {
      addLog(mode, 'wait', opt.name, `[Monthly] Spread too wide (${optBid}/${optOffer}) — skipping`);
      continue;
    }

    const premiumBudget = STOCK_PREMIUM_GBP[mode];
    const edge = edgeSizing(journalMode(mode), STOCK_MONTHLY_STRATEGY);
    if (edge.skip) { addLog(mode, 'wait', u.name, `[Monthly] Skipped — ${edge.reason}`); continue; }
    const scaledBudget = edge.multiplier !== 1 ? Math.round(premiumBudget * edge.multiplier) : premiumBudget;

    const minDeal = optDetails.minDealSize || 0.1;
    let stake = Math.max(minDeal, Math.floor((scaledBudget / optOffer) * 100) / 100);
    stake = Math.round(stake * 100) / 100;
    if (mode === 'live' && optOffer * stake > scaledBudget * 1.25) {
      addLog(mode, 'wait', opt.name, `[Monthly] Minimum stake costs £${(optOffer * stake).toFixed(0)} premium — over budget, skipping`);
      continue;
    }

    await placeStockOrder(mode, session, s, u, opt, side, stake, optOffer, trend.trend12w, verdict.confidence, verdict.reason, new Date().toISOString().slice(0, 10), 'stock-monthly', scaledBudget);
  }
}

// ── Exits ───────────────────────────────────────────────────────────────────
async function manageExits(mode: IgMode, session: IGSession, positions: FullPosition[]): Promise<void> {
  const s = st(mode);
  const byDealId = new Map(positions.map(p => [p.dealId, p]));

  for (const [underlyingEpic, tr] of Object.entries(s.tracked)) {
    const p = byDealId.get(tr.dealId);
    if (!p) {
      // Gone without this bot closing it — expired at IG, or closed manually.
      // Recover the real P&L from the transaction history, same pattern as
      // meanReversionBot's recoverSilentClose.
      try {
        const since = new Date(tr.enteredAt - 3600_000).toISOString();
        const txns = await fetchClosedTransactions(session, since);
        const match = txns.find(t => t.instrumentName?.includes(String(tr.strike)));
        const plUsd = match?.profitAndLoss ?? -(tr.premium * tr.size); // worst case: expired worthless
        recordJournalEvent({
          mode: journalMode(mode), event: 'exit', symbol: tr.name, strategy: strategyFor(tr),
          side: 'long', qty: tr.size, price: match?.closeLevel ?? 0,
          reason: match ? 'Closed at IG (expiry or manual)' : 'Position gone — assumed expired worthless',
          plUsd, plPct: tr.premium > 0 ? (plUsd / (tr.premium * tr.size)) * 100 : 0,
        });
        addLog(mode, 'exit', tr.name, `Position gone at IG — journalled £${plUsd.toFixed(2)}`);
      } catch (e) {
        addLog(mode, 'error', tr.name, `Silent-close recovery failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      delete s.tracked[underlyingEpic];
      saveTracked(mode, s.tracked);
      continue;
    }

    // Premium-based P&L% — the bought option's bid is what closing now
    // fetches, vs the premium paid at entry.
    const bid = typeof p.bid === 'number' ? p.bid : null;
    const plPct = bid !== null && tr.premium > 0 ? ((bid - tr.premium) / tr.premium) * 100 : 0;
    if (plPct > tr.peakPlPct) { tr.peakPlPct = plPct; saveTracked(mode, s.tracked); }
    const dte = (tr.expiryMs - Date.now()) / 86_400_000;

    // The signal function's own exit lifecycle (profit target, premium stop,
    // peak-retrace lock-in) — bars aren't needed for the in-position branch
    // beyond the minimum-length gate, so reuse of the underlying's daily bars
    // here is only for that gate. DTE exit handled locally at the wider
    // EXIT_DTE (estimated monthly expiries — see its comment).
    // Peak-retrace tuning — tightened 2026-08-31 per explicit request after
    // positions that had shown real profit closed for far less than that:
    // two things compounded. (1) This whole check used to only run every
    // 15min (stock) / hourly (index) — a real intraday peak between checks
    // was invisible to peakPlPct entirely, so lock-in couldn't react to a
    // move it never saw (fixed by fastPositionMonitor's own faster loop,
    // see its comment). (2) The retrace tolerance itself was loose — 40%
    // giveback before acting meant a position that peaked +80% could
    // legitimately ride to +48% before anything happened. Tightened to 30%
    // and paired with more frequent checks so lock-in both sees the real
    // peak and reacts closer to it. Fixed profit targets also raised
    // (stock 60%->120%, index 75%->150%) — they're now a generous backstop
    // for a genuine runaway winner, not the primary profit-protection
    // mechanism; that job now belongs to the tighter trailing lock-in,
    // matching this account's own donchianBreakoutSignal philosophy
    // ("no fixed target by design — let winners run").
    const RETRACE_TRIGGER_FRAC = 0.3;

    let closeReason: string | null = null;
    if (tr.kind === 'stock-daily') {
      // Same-day option — no overnight hold at all, unlike weekly's few days
      // of runway. Force-close before the bell always wins regardless of
      // P&L (theta and the settlement/assignment risk of holding into the
      // close aren't worth any amount of "let it run" here). Tighter profit
      // target than weekly's 120% — same-day theta decay is brutal enough
      // that a big same-day move is less likely to have much further to
      // run before the session ends anyway.
      if (isNearClose(20)) closeReason = 'Closing before the bell — same-day option, no overnight hold';
      else if (plPct >= 80) closeReason = `Profit target hit: +${plPct.toFixed(1)}% on premium`;
      else if (tr.peakPlPct >= 25 && plPct > 0 && (tr.peakPlPct - plPct) / tr.peakPlPct >= RETRACE_TRIGGER_FRAC) {
        closeReason = `Momentum stalling — gave back ${(((tr.peakPlPct - plPct) / tr.peakPlPct) * 100).toFixed(0)}% of its +${tr.peakPlPct.toFixed(1)}% peak, locking in +${plPct.toFixed(1)}%`;
      }
      else if (plPct <= -50) closeReason = `Premium stop hit: ${plPct.toFixed(1)}%`;
    }
    else if (tr.kind === 'stock') {
      // Weekly option — a few days of runway, not hours. Same shape as the
      // index side's exit lifecycle, just a tighter DTE trigger since the
      // whole chain only spans about a week to begin with.
      if (dte <= STOCK_EXIT_DTE_DAYS) closeReason = `${dte.toFixed(1)} days to expiry — closing to avoid the weekly's own settlement/theta endgame`;
      else if (plPct >= 120) closeReason = `Profit target hit: +${plPct.toFixed(1)}% on premium`;
      else if (tr.peakPlPct >= 25 && plPct > 0 && (tr.peakPlPct - plPct) / tr.peakPlPct >= RETRACE_TRIGGER_FRAC) {
        closeReason = `Momentum stalling — gave back ${(((tr.peakPlPct - plPct) / tr.peakPlPct) * 100).toFixed(0)}% of its +${tr.peakPlPct.toFixed(1)}% peak, locking in +${plPct.toFixed(1)}%`;
      }
      else if (plPct <= -50) closeReason = `Premium stop hit: ${plPct.toFixed(1)}%`;
    }
    else if (dte <= EXIT_DTE) closeReason = `${dte.toFixed(1)} days to expiry — closing to avoid settlement/theta endgame`;
    else if (plPct >= 150) closeReason = `Profit target hit: +${plPct.toFixed(1)}% on premium`;
    else if (tr.peakPlPct >= 30 && plPct > 0 && (tr.peakPlPct - plPct) / tr.peakPlPct >= RETRACE_TRIGGER_FRAC) {
      closeReason = `Stalling — gave back ${(((tr.peakPlPct - plPct) / tr.peakPlPct) * 100).toFixed(0)}% of its +${tr.peakPlPct.toFixed(1)}% peak, locking in +${plPct.toFixed(1)}%`;
    }
    else if (plPct <= -50) closeReason = `Premium stop hit: ${plPct.toFixed(1)}%`;

    // AI news check — the ONE exit power the AI keeps, and only where it has
    // real information the mechanical rules can't see: headlines. Two
    // different questions depending on how much runway the position has,
    // NOT a "close or hold?" chart judgment either way — that was removed
    // account-wide 2026-08-31 after confirmed live flip-flopping (Exxon,
    // Silver), and stays removed: both checks below are asymmetric (can only
    // push toward closing early on real news, never override the mechanical
    // stop/target/DTE rules to hold longer), and a close is a one-way
    // action, so an inconsistent verdict on a later call can't undo an
    // earlier one — that one-directional shape is what makes an LLM call
    // safe to use here even though the bidirectional version wasn't.
    //
    //  - Index positions (weeks of runway, exit around 5 DTE) keep the
    //    original askMrSafety question — a genuine, crash-grade emergency
    //    only, checked at most once/20h. Ordinary bad news is fine to ride
    //    out here; there's real time for it to resolve.
    //  - Weekly/daily stock options (added 2026-09-03, explicit request)
    //    get a different, options-aware question instead: askOptionsExit.
    //    A weekly option has maybe a week of total life and bleeds theta the
    //    whole time — "wait out ordinary bad news" isn't available the way
    //    it is for a stock with weeks of runway, so this asks the broader
    //    "has the news genuinely turned against this option's direction"
    //    question (same real-headlines input the T212 momentum strategy
    //    pulls for its own entries), not just a literal-emergency filter.
    //    Checked far more often (every 4h vs 20h) since the position's
    //    entire remaining life is often only 1-2 days long — the old 20h
    //    cadence meant a weekly option could go its whole remaining runway
    //    getting checked once, or not at all.
    if (!closeReason) {
      // Three kinds now, two questions. "Tight" (askOptionsExit, 4h) is for
      // options with only days of life — weekly and same-day. "Loose"
      // (askMrSafety, 20h, emergency-only) is for anything with weeks-to-
      // months of runway — index AND, as of stock-monthly (2026-09-03), a
      // monthly stock option too: it has the same "ordinary bad news is
      // fine to ride out, there's real time for it to resolve" shape as the
      // index side, not the weekly/daily side's time pressure.
      const isTightStockKind = tr.kind === 'stock' || tr.kind === 'stock-daily';
      const isAnyStockKind = isTightStockKind || tr.kind === 'stock-monthly';
      const idxU   = isAnyStockKind ? undefined : UNDERLYINGS.find(x => x.epic === tr.underlyingEpic);
      const stockU = isAnyStockKind ? STOCK_UNDERLYINGS.find(x => x.shareEpic === tr.underlyingEpic) : undefined;
      const label      = idxU?.name ?? stockU?.name;
      const newsTicker = idxU?.newsTicker ?? stockU?.finnhub;
      const checkIntervalMs = isTightStockKind ? 4 * 3_600_000 : 20 * 3_600_000;
      if (label && newsTicker && Date.now() - (tr.lastAiCheckAt ?? 0) >= checkIntervalMs) {
        tr.lastAiCheckAt = Date.now();
        saveTracked(mode, s.tracked);
        try {
          const headlines = await fetchAllHeadlines(newsTicker, 8, label);
          if (headlines.length) {
            if (isTightStockKind) {
              const verdict = await askOptionsExit({
                instrumentName: tr.name, optionType: tr.optionType, underlyingName: label,
                entryPremium: tr.premium, currentPremium: bid ?? tr.premium, plPct,
                daysToExpiry: dte, headlines,
              });
              addLog(mode, 'info', tr.name, `[News check] thesisIntact=${verdict.thesisIntact} — ${verdict.reason} (${verdict.engine})`);
              if (!verdict.thesisIntact) closeReason = `AI news check — ${verdict.reason}`;
            } else {
              const kindWord = idxU ? ' index' : '';
              const verdict = await askMrSafety({
                instrumentName: `${label}${kindWord} (holding a bought ${tr.optionType.toUpperCase()} option)`,
                direction: tr.optionType === 'call' ? 'BUY' : 'SELL',
                entryLevel: tr.premium, currentLevel: bid ?? tr.premium,
                uplGbp: p.upl, heldDays: (Date.now() - tr.enteredAt) / 86_400_000, headlines,
              });
              addLog(mode, 'info', tr.name, `[Safety check] severe=${verdict.severe} — ${verdict.reason} (${verdict.engine})`);
              if (verdict.severe) closeReason = `AI safety override — ${verdict.reason}`;
            }
          }
        } catch (e) {
          addLog(mode, 'error', tr.name, `News check failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    if (!closeReason) {
      addLog(mode, 'wait', tr.name, `Holding — ${plPct >= 0 ? '+' : ''}${plPct.toFixed(1)}% on premium (peak +${tr.peakPlPct.toFixed(1)}%), ${dte.toFixed(0)}d to expiry, £${p.upl.toFixed(2)}`);
      continue;
    }

    try {
      await closePosition(session, p.dealId, p.direction, p.size);
      recordJournalEvent({
        mode: journalMode(mode), event: 'exit', symbol: tr.name, strategy: strategyFor(tr),
        side: 'long', qty: p.size, price: bid ?? 0, reason: closeReason,
        plUsd: p.upl, plPct,
      });
      addLog(mode, 'exit', tr.name, `Closed — ${closeReason} (£${p.upl.toFixed(2)})`);
      delete s.tracked[underlyingEpic];
      saveTracked(mode, s.tracked);
    } catch (e) {
      addLog(mode, 'error', tr.name, `Close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ── Entries ─────────────────────────────────────────────────────────────────
function countKind(s: BotState, kind: 'index' | 'stock' | 'stock-daily' | 'stock-monthly'): number {
  return Object.values(s.tracked).filter(t => (t.kind ?? 'index') === kind).length;
}

async function scanEntries(mode: IgMode, session: IGSession): Promise<void> {
  const s = st(mode);
  if (countKind(s, 'index') >= MAX_POSITIONS) return;

  // One batched snapshot for all underlyings — spot for signal rescale +
  // strike selection. Snapshot endpoint isn't allowance-gated (see
  // MarketDetail's own comment in igApi.ts).
  const details = await fetchMarketDetails(session, UNDERLYINGS.map(u => u.epic));

  for (const u of UNDERLYINGS) {
    if (countKind(s, 'index') >= MAX_POSITIONS) break;
    if (s.tracked[u.epic]) continue; // one option position per underlying

    const d = details.get(u.epic);
    const spot = typeof d?.bid === 'number' && typeof d?.offer === 'number' ? (d.bid + d.offer) / 2 : null;
    if (!spot) { addLog(mode, 'wait', u.name, 'No live underlying quote — skipping'); continue; }

    // Daily bars from free sources, rescaled to IG's own points level so the
    // signal's EMAs and the strike selection live on the same scale —
    // indices are ~1:1 but this makes it exact by construction.
    let bars;
    try {
      bars = await fetchBarsWithFallback(u.epic, '1y', { alpacaTimeframe: '1Day', yahooInterval: '1d', liveReferenceLevel: spot });
    } catch (e) {
      addLog(mode, 'error', u.name, `Bar fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!bars?.length) continue;

    const signal = optionsDirectionalSignal(bars, false);
    if (signal.action !== 'BUY' || !signal.optionType) {
      addLog(mode, 'wait', u.name, signal.reason);
      continue;
    }
    const side = signal.optionType;

    // AI confirm — same mechanism as gemini_confirmed / the T212 momentum
    // port: rules qualified it, the AI's only job is confirm-or-veto with
    // context the rules can't see. For a put, the directional thesis on the
    // underlying is SELL.
    let headlines: string[] = [];
    try { if (u.newsTicker) headlines = await fetchAllHeadlines(u.newsTicker, 8, u.name); } catch { /* prompt handles empty */ }

    // Guard the news component the same way the daily stock strategy does
    // (see lastOptionEvalKey's own comment) — the technical side (signal.reason)
    // deliberately isn't in this key since it genuinely refreshes every
    // hourly bar; only "same side, same headlines" gets skipped.
    const evalKey = `${side}|${[...headlines].sort().join('~')}`;
    if (s.lastOptionEvalKey[u.epic] === evalKey) continue;
    s.lastOptionEvalKey[u.epic] = evalKey;

    const verdict = await askIgConfirmStockTrade({
      instrumentName: `${u.name} index (buying a ${side.toUpperCase()} option, ~1 month to expiry)`,
      suggestedDir: side === 'call' ? 'BUY' : 'SELL',
      ruleReasoning: signal.reason, ruleConfidence: 7, price: spot,
      rsi: null, macdHist: null,
      lastCandles: bars.slice(-3).map(b => ({ open: b.o, high: b.h, low: b.l, close: b.c })),
      headlines,
    });
    addLog(mode, 'info', u.name, `Signal ${side.toUpperCase()} — ${signal.reason} → AI: ${verdict.direction} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);
    if (verdict.engine === 'passthrough' || verdict.direction === 'SKIP' || verdict.confidence < MIN_CONFIRM_CONFIDENCE) continue;

    // Track-record sizing/gate — same quant layer as T212/mean-reversion.
    let premiumBudget = INDEX_PREMIUM_GBP[mode];
    const edge = edgeSizing(journalMode(mode), STRATEGY);
    if (edge.skip) { addLog(mode, 'wait', u.name, `Skipped — ${edge.reason}`); continue; }
    if (edge.multiplier !== 1) {
      addLog(mode, 'info', u.name, edge.reason);
      premiumBudget = Math.round(INDEX_PREMIUM_GBP[mode] * edge.multiplier);
    }

    const opt = await findOptionEpic(mode, session, u.optName, side, spot);
    if (!opt) { addLog(mode, 'wait', u.name, `No ${side} option found near spot ${spot.toFixed(0)} in the ${MIN_DTE}-${MAX_DTE}d window`); continue; }

    const optDetails = (await fetchMarketDetails(session, [opt.epic])).get(opt.epic);
    const optBid   = typeof optDetails?.bid   === 'number' ? optDetails.bid   : null;
    const optOffer = typeof optDetails?.offer === 'number' ? optDetails.offer : null;
    if (!optDetails || optOffer === null || optOffer <= 0 || optDetails.marketStatus !== 'TRADEABLE') {
      addLog(mode, 'wait', opt.name, `Option not currently dealable (status ${optDetails?.marketStatus ?? 'unknown'})`);
      continue;
    }
    // A spread wider than ~25% of the premium is paying that entire slice on
    // entry — same illiquidity guard idea as the Alpaca side's live-quote
    // requirement (its stale-price sizing bug is the cautionary tale here).
    if (optBid !== null && optOffer > 0 && (optOffer - optBid) / optOffer > 0.25) {
      addLog(mode, 'wait', opt.name, `Spread too wide (${optBid}/${optOffer}) — skipping illiquid strike`);
      continue;
    }

    const minDeal = optDetails.minDealSize || 0.1;
    let stake = Math.max(minDeal, Math.floor((premiumBudget / optOffer) * 100) / 100);
    stake = Math.round(stake * 100) / 100;
    const maxLoss = optOffer * stake;
    if (maxLoss > premiumBudget * 1.25) {
      addLog(mode, 'wait', opt.name, `Even minimum stake ${stake} costs £${maxLoss.toFixed(0)} premium — over the £${premiumBudget} budget, skipping`);
      continue;
    }

    try {
      // No stop, no take-profit legs — the premium is the entire risk (see
      // header comment); exits are this bot's own premium-based lifecycle.
      const result = await placeMarketOrder(session, opt.epic, 'BUY', stake, undefined, undefined, 'GBP', false, opt.expiry, optOffer);
      const premium = result.level || optOffer;
      s.tracked[u.epic] = {
        dealId: result.dealId, epic: opt.epic, underlyingEpic: u.epic, name: opt.name,
        optionType: side, strike: opt.strike, expiry: opt.expiry, expiryMs: opt.expiryMs,
        premium, size: stake, enteredAt: Date.now(), peakPlPct: 0, kind: 'index',
      };
      saveTracked(mode, s.tracked);
      recordJournalEvent({
        mode: journalMode(mode), event: 'entry', symbol: opt.name, strategy: STRATEGY,
        side: 'long', qty: stake, price: premium,
        reason: `${signal.reason} · AI ${verdict.confidence}%`, confidence: verdict.confidence,
      });
      addLog(mode, 'enter', opt.name, `BUY ${side.toUpperCase()} @ ${premium.toFixed(1)} premium · ${stake}/pt · max loss £${(premium * stake).toFixed(2)} · expiry ${opt.expiry} — ${verdict.reason}`);
    } catch (e) {
      addLog(mode, 'error', opt.name, `Order failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ── Weekly stock options — momentum entries ─────────────────────────────────
async function scanStockEntries(mode: IgMode, session: IGSession): Promise<void> {
  const s = st(mode);
  if (countKind(s, 'stock') >= STOCK_MAX_POSITIONS) return;
  // Still gated to NYSE hours — "today's move" only means something fresh
  // while the market's actually open; no runway requirement anymore since
  // the position isn't forced flat same-day (see STOCK_EXIT_DTE_DAYS).
  if (!isNYSEOpen()) return;

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return;
  const today = new Date().toISOString().slice(0, 10);
  const details = await fetchMarketDetails(session, STOCK_UNDERLYINGS.map(u => u.shareEpic));

  for (const u of STOCK_UNDERLYINGS) {
    if (countKind(s, 'stock') >= STOCK_MAX_POSITIONS) break;
    if (s.tracked[u.shareEpic]) continue;
    if (s.lastStockEntryDay[u.finnhub] === today) continue; // one shot per stock per day

    // Today's move from Finnhub (has day-change %; IG's snapshot doesn't
    // carry one) — the qualifying bar before any AI call is spent.
    let dp: number;
    let usdPrice: number; // real $ price — what the AI prompt gets (IG's
                          // ×100 points scale read as "$26130 Amazon" made
                          // the AI veto on "impossible price", confirmed live)
    let dailyRangePct: number; // today's (high-low)/close — crude one-day
                                // volatility proxy for the plausibility check
                                // below, reusing this same quote call rather
                                // than fetching historical bars separately.
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${u.finnhub}&token=${apiKey}`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) continue;
      const q = await res.json() as { c: number; dp: number; h?: number; l?: number };
      if (!q.c || q.dp === undefined || q.dp === null) continue;
      dp = q.dp;
      usdPrice = q.c;
      dailyRangePct = q.h && q.l && q.h > q.l ? ((q.h - q.l) / q.c) * 100 : Math.abs(dp);
    } catch { continue; }
    if (Math.abs(dp) < STOCK_MIN_MOVE_PCT) continue;
    const side: 'call' | 'put' = dp > 0 ? 'call' : 'put';

    // Spot in IG points (matches the option strikes' own scale — Apple
    // ~$260 quotes as ~26000, and its chain's strikes are 26000/26500/…).
    const d = details.get(u.shareEpic);
    const spot = typeof d?.bid === 'number' && typeof d?.offer === 'number' ? (d.bid + d.offer) / 2 : null;
    if (!spot) continue;

    let headlines: string[] = [];
    try { headlines = await fetchAllHeadlines(u.finnhub, 8, u.name); } catch { /* prompt handles empty */ }

    // Don't re-ask on facts the AI has already judged today. Confirmed live
    // 2026-08-31 (Apple/Tim Cook, 8 calls on the exact same headline over
    // 2 hours): with nothing new to weigh, the verdict just drifts —
    // SKIP 15/BUY 70/BUY 70/SKIP 45/SKIP 35/SKIP 45/SKIP 35/SELL 82 — and
    // the trade that actually fires is whichever side of that noise it
    // happens to land on 15 minutes later, not a real re-read of anything.
    // Key = today's rounded move (0.5% buckets — small wobbles shouldn't
    // count as "new") + the exact headline set. A genuinely fresh headline
    // or a further-extended move changes the key and gets a real fresh call.
    const evalKey = `${Math.round(dp * 2) / 2}|${[...headlines].sort().join('~')}`;
    if (s.lastOptionEvalKey[u.finnhub] === evalKey) continue;
    s.lastOptionEvalKey[u.finnhub] = evalKey;

    const verdict = await askIgConfirmStockTrade({
      instrumentName: `${u.name} (buying a ${side.toUpperCase()} option, this week's expiry — a few trading days, not months)`,
      suggestedDir: side === 'call' ? 'BUY' : 'SELL',
      ruleReasoning: `Moving ${dp >= 0 ? '+' : ''}${dp.toFixed(1)}% today — momentum-continuation bet over the rest of this week`,
      ruleConfidence: Math.max(1, Math.min(10, Math.round(Math.abs(dp) * 2))),
      price: usdPrice, rsi: null, macdHist: null, lastCandles: [],
      headlines, dayChangePercent: dp,
      // Default 'swing' framing ("days to weeks") fits a several-day weekly
      // option far better than 'intraday' did when this traded same-day
      // dailies — see STOCK_UNDERLYINGS' own comment for why that changed.
    });
    addLog(mode, 'info', u.name, `[Weekly] ${dp >= 0 ? '+' : ''}${dp.toFixed(1)}% today → ${side.toUpperCase()} candidate → AI: ${verdict.direction} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);
    if (verdict.engine === 'passthrough' || verdict.direction === 'SKIP' || verdict.confidence < MIN_CONFIRM_CONFIDENCE) continue;

    let premiumBudget = STOCK_PREMIUM_GBP[mode];
    const edge = edgeSizing(journalMode(mode), STOCK_STRATEGY);
    if (edge.skip) { addLog(mode, 'wait', u.name, `[Weekly] Skipped — ${edge.reason}`); continue; }
    if (edge.multiplier !== 1) premiumBudget = Math.round(STOCK_PREMIUM_GBP[mode] * edge.multiplier);

    // Chain discovery — same exact-name search as the index side, with the
    // daily chain's own naming ("Daily Apple Inc 26000 CALL") and today's
    // exact expiry. Strike order is ITM first, then ATM-adjacent, then one
    // OTM — confirmed live (Amazon, first qualifying signal this strategy
    // ever produced, AI 85%): the nearest-OTM daily quoted 22.7/34.7, a
    // ~35% spread that means the option must gain ~50% just to break even.
    // Wide percentage spreads are structural on these tiny-premium dailies,
    // and the OTM strike is where they're at their worst; one step ITM the
    // premium is several times larger, the same absolute spread is a far
    // smaller percentage, and the higher delta actually suits a
    // momentum-continuation bet better anyway. Each candidate is priced and
    // the first one passing the spread/budget checks is taken, instead of
    // hard-failing the whole stock on the single worst strike's quote.
    const sideWord = side === 'call' ? 'CALL' : 'PUT';
    const dir = side === 'call' ? 1 : -1;
    const base = side === 'call' ? Math.ceil(spot / u.strikeStep) * u.strikeStep : Math.floor(spot / u.strikeStep) * u.strikeStep;
    const STOCK_SPREAD_CAP = 0.35; // wider than the index cap — structural on dailies, see above
    let entered = false;
    let anyFound = false;

    for (const strike of [base - u.strikeStep * dir, base, base + u.strikeStep * dir]) {
      await new Promise(r => setTimeout(r, 350));
      let results;
      try { results = await searchMarkets(session, `${u.searchName} ${strike} ${sideWord}`); }
      catch { continue; }
      const nameRe = new RegExp(`^${u.searchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${strike} ${sideWord}$`, 'i');
      const m = results.find(r => r.instrumentType === 'OPT_SHARES' && nameRe.test(r.name));
      if (!m) continue;
      const expiryMs = parseExpiryMs(m.expiry);
      // Must genuinely be THIS week's chain, not a stale one or a future
      // cycle IG's search happened to also surface. Bug found and fixed
      // 2026-09-01: this used to require expiry within 36 HOURS — a
      // leftover from the pre-pivot same-day version (see that migration's
      // own comment above), never updated when the search moved to
      // "Weekly X Inc" naming. In practice that meant this only ever
      // accepted a weekly contract in the last day and a half of its own
      // life, rejecting genuinely-weekly candidates found earlier in the
      // week — the search said "weekly," the accept condition still
      // enforced "basically same-day." 8 days comfortably covers one real
      // weekly cycle while still rejecting a wrong/future one.
      if (expiryMs === null || expiryMs <= Date.now() || expiryMs - Date.now() > 8 * 86_400_000) continue;
      anyFound = true;
      const opt = { epic: m.epic, name: m.name, strike, expiry: m.expiry, expiryMs };

      const optDetails = (await fetchMarketDetails(session, [opt.epic])).get(opt.epic);
      const optBid   = typeof optDetails?.bid   === 'number' ? optDetails.bid   : null;
      const optOffer = typeof optDetails?.offer === 'number' ? optDetails.offer : null;
      if (!optDetails || optOffer === null || optOffer <= 0 || optDetails.marketStatus !== 'TRADEABLE') continue;
      if (optBid !== null && (optOffer - optBid) / optOffer > STOCK_SPREAD_CAP) {
        addLog(mode, 'wait', opt.name, `[Weekly] Spread too wide (${optBid}/${optOffer}) — trying next strike`);
        continue;
      }

      const daysRemaining = (opt.expiryMs - Date.now()) / 86_400_000;
      const move = moveIsPlausible(spot, strike, optOffer, side, daysRemaining, dailyRangePct);
      if (!move.plausible) {
        addLog(mode, 'wait', opt.name, `[Weekly] Needs a ${move.requiredMovePct.toFixed(1)}% move to breakeven vs a typical ~${move.expectedMovePct.toFixed(1)}% over ${daysRemaining.toFixed(1)}d — too much of a stretch, trying next strike`);
        continue;
      }

      const minDeal = optDetails.minDealSize || 0.1;
      let stake = Math.max(minDeal, Math.floor((premiumBudget / optOffer) * 100) / 100);
      stake = Math.round(stake * 100) / 100;
      // Budget ceiling skipped on demo — explicit request 2026-09-03 ("let
      // it trade freely, take off the restrictions") after this cap kept
      // skipping strikes the strategy would otherwise have taken, on top of
      // the separate minDealSize-mismatch issue placeStockOrder's own
      // escalation now handles. Real money on live still respects it.
      if (mode === 'live' && optOffer * stake > premiumBudget * 1.25) {
        addLog(mode, 'wait', opt.name, `[Weekly] Minimum stake costs £${(optOffer * stake).toFixed(0)} premium — over budget, trying next strike`);
        continue;
      }

      entered = await placeStockOrder(mode, session, s, u, opt, side, stake, optOffer, dp, verdict.confidence, verdict.reason, today, 'stock', premiumBudget);
      if (entered) break;
    }
    if (!entered && !anyFound) addLog(mode, 'wait', u.name, `[Weekly] No ${side} found near ${spot.toFixed(0)} in this week's chain`);
  }
}

// ── Move-plausibility screen — added 2026-09-03, explicit request ──────────
// A weekly/daily bought option needs the underlying to actually move enough
// to clear its breakeven before expiry — theta keeps bleeding the whole
// time regardless. This is a cheap, deterministic sanity check (no AI call,
// so no flip-flop risk at all) against entering a strike that would need an
// implausibly large move to ever pay off. Deliberately crude, not a real
// options-pricing/IV model: dailyRangePct (today's high-low range as a %
// of close) stands in for one day's expected volatility, scaled by
// sqrt(days remaining) — a standard rough scaling, not a precise one. The
// point is only to catch the obviously-unreasonable case (a strike needing
// a 15% move in 2 days on a stock whose own daily range is under 1%), not
// to finely rank plausible candidates against each other.
const REQUIRED_MOVE_MULTIPLE = 2; // required move can run up to 2x the naive expected move before this flags it
function moveIsPlausible(
  spot: number, strike: number, premium: number, side: 'call' | 'put',
  daysRemaining: number, dailyRangePct: number,
): { plausible: boolean; requiredMovePct: number; expectedMovePct: number } {
  const breakeven = side === 'call' ? strike + premium : strike - premium;
  const requiredMovePct = side === 'call'
    ? Math.max(0, ((breakeven - spot) / spot) * 100)
    : Math.max(0, ((spot - breakeven) / spot) * 100);
  const expectedMovePct = Math.max(dailyRangePct, 0.1) * Math.sqrt(Math.max(daysRemaining, 0.25));
  return { plausible: requiredMovePct <= REQUIRED_MOVE_MULTIPLE * expectedMovePct, requiredMovePct, expectedMovePct };
}

// Shared by both the weekly and same-day stock strategies — generalized
// 2026-09-01 (was placeStockDailyOrder, weekly-only) when the daily chain
// was re-added alongside it. `kind` drives the tracked-state key (plain
// shareEpic for weekly, `${shareEpic}:daily` for same-day — deliberately
// different so the same stock can hold both a weekly AND a same-day
// position at once), the journal strategy key, and the log tag.
async function placeStockOrder(
  mode: IgMode, session: IGSession, s: BotState,
  u: typeof STOCK_UNDERLYINGS[number],
  opt: { epic: string; name: string; strike: number; expiry: string; expiryMs: number },
  side: 'call' | 'put', stake: number, optOffer: number, dp: number,
  confidence: number, aiReason: string, today: string, kind: 'stock' | 'stock-daily' | 'stock-monthly',
  premiumBudget: number,
): Promise<boolean> {
  const tag         = kind === 'stock-daily' ? '[Daily]' : kind === 'stock-monthly' ? '[Monthly]' : '[Weekly]';
  const trackedKey   = kind === 'stock-daily' ? `${u.shareEpic}:daily` : kind === 'stock-monthly' ? `${u.shareEpic}:monthly` : u.shareEpic;
  const dayThrottleKey = kind === 'stock-daily' ? `${u.finnhub}:daily` : kind === 'stock-monthly' ? `${u.finnhub}:monthly` : u.finnhub;
  const strategy     = kind === 'stock-daily' ? STOCK_DAILY_STRATEGY : kind === 'stock-monthly' ? STOCK_MONTHLY_STRATEGY : STOCK_STRATEGY;
  try {
    // 'USD', not 'GBP' — confirmed live 2026-09-01 by querying IG's own
    // /markets/{epic} directly: this whole US-stock weekly/daily options
    // chain (ON.D.* — Apple/NVIDIA/Amazon/Meta/AMD/Palantir, both weekly
    // and same-day) only lists USD in its `currencies` array, no GBP
    // option at all. Every single order this strategy had ever placed
    // since going live 2026-08-31 was rejected with
    // INSTRUMENT_NOT_TRADEABLE_IN_THIS_CURRENCY — confirmed via the trade
    // journal: zero entry events ever recorded for ig_options_weekly_momentum,
    // only exits (of positions opened before the pivot, under the old
    // same-day system). The strategy has been entirely non-functional this
    // whole time, silently. IG handles the GBP-account/USD-instrument
    // conversion itself once given the currency the instrument actually
    // supports — no other change needed here for the order to go through.
    // Demo-only escalation on MINIMUM_ORDER_SIZE_ERROR — added 2026-09-03
    // per explicit request ("let it trade freely... take off the
    // restrictions") after finding this chain's IG-reported minDealSize
    // (2) doesn't match what IG actually enforces at order time — every
    // attempt at size 2-2.8 kept getting rejected for hours. IG's own
    // dealingRules for these same-day option epics can't be trusted (the
    // same query that returned minDealSize:2 also returned a nonsense
    // minStepDistance of 10 billion points), so rather than guess the real
    // number, this doubles the stake and retries on that specific rejection
    // until it clears. Demo-only — real money on live still respects the
    // budget/minimum checks as before; this is deliberately not extended
    // there.
    //
    // Reworked 2026-09-03 per explicit request — the aim now isn't "hit a
    // nominal budget," it's "let this position open and size up to whatever
    // it actually needs, with max loss (= total premium, since a bought
    // option can never lose more than that) as the only real constraint."
    // DEMO_MAX_LOSS_CEILING_GBP (£1,000) is that constraint — the stake
    // escalates on IG's minimum-size rejection until it clears, and only
    // gives up if the NEXT step would push total premium past that hard
    // ceiling, not past some smaller nominal budget.
    const DEMO_MAX_SIZE_ATTEMPTS = 6; // backstop even within the loss ceiling, in case optOffer is tiny
    let attemptStake = stake;
    let result: Awaited<ReturnType<typeof placeMarketOrder>> | null = null;
    for (let attempt = 1; attempt <= (mode === 'demo' ? DEMO_MAX_SIZE_ATTEMPTS : 1); attempt++) {
      try {
        result = await placeMarketOrder(session, opt.epic, 'BUY', attemptStake, undefined, undefined, 'USD', false, opt.expiry, optOffer);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (mode === 'demo' && msg.includes('MINIMUM_ORDER_SIZE_ERROR') && attempt < DEMO_MAX_SIZE_ATTEMPTS) {
          const nextStake = Math.round(attemptStake * 2 * 100) / 100;
          const nextPremium = optOffer * nextStake;
          if (nextPremium > DEMO_MAX_LOSS_CEILING_GBP) {
            addLog(mode, 'info', opt.name, `${tag} Size ${attemptStake} rejected — next retry (${nextStake}) would commit £${nextPremium.toFixed(0)} premium (= max loss), over the £${DEMO_MAX_LOSS_CEILING_GBP} ceiling — giving up rather than exceeding it`);
            throw e;
          }
          addLog(mode, 'info', opt.name, `${tag} Size ${attemptStake} rejected as below IG's real minimum (reported minDealSize was wrong) — retrying at ${nextStake} (£${nextPremium.toFixed(0)} max loss, within the £${DEMO_MAX_LOSS_CEILING_GBP} ceiling)`);
          attemptStake = nextStake;
          continue;
        }
        throw e;
      }
    }
    if (!result) throw new Error('Order failed after size-escalation retries');
    stake = attemptStake;
    const premium = result.level || optOffer;
    s.lastStockEntryDay[dayThrottleKey] = today;
    s.tracked[trackedKey] = {
      dealId: result.dealId, epic: opt.epic, underlyingEpic: u.shareEpic, name: opt.name,
      optionType: side, strike: opt.strike, expiry: opt.expiry, expiryMs: opt.expiryMs,
      premium, size: stake, enteredAt: Date.now(), peakPlPct: 0, kind,
    };
    saveTracked(mode, s.tracked);
    recordJournalEvent({
      mode: journalMode(mode), event: 'entry', symbol: opt.name, strategy,
      side: 'long', qty: stake, price: premium,
      reason: kind === 'stock-monthly'
        ? `+${dp.toFixed(1)}% /12w trend + news · AI ${confidence}%`
        : `${dp >= 0 ? '+' : ''}${dp.toFixed(1)}% today, momentum continuation · AI ${confidence}%`,
      confidence,
    });
    addLog(mode, 'enter', opt.name, `${tag} BUY ${side.toUpperCase()} @ ${premium.toFixed(1)} premium · ${stake}/pt · max loss £${(premium * stake).toFixed(2)} · expiry ${opt.expiry} — ${aiReason}`);
    return true;
  } catch (e) {
    addLog(mode, 'error', opt.name, `${tag} Order failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ── Same-day stock options — momentum entries ───────────────────────────────
// Re-added 2026-09-01, deliberately separate from scanStockEntries above
// rather than merged into it — different chain, different DTE filter,
// different exit lifecycle (force-close before the bell, no overnight
// hold), different (tighter) spread tolerance, own tracked-state key so a
// stock can carry both a weekly AND a same-day position at once. See
// STOCK_DAILY_STRATEGY's own comment for the full reasoning.
async function scanStockDailyEntries(mode: IgMode, session: IGSession): Promise<void> {
  const s = st(mode);
  if (countKind(s, 'stock-daily') >= STOCK_DAILY_MAX_POSITIONS) return;
  // Needs real runway before forcing flat — no point opening a same-day
  // position that would just get force-closed a few minutes later.
  if (!isNYSEOpen() || isNearClose(60)) return;

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return;
  const today = new Date().toISOString().slice(0, 10);
  const details = await fetchMarketDetails(session, STOCK_DAILY_UNDERLYINGS.map(u => u.shareEpic));

  for (const u of STOCK_DAILY_UNDERLYINGS) {
    if (countKind(s, 'stock-daily') >= STOCK_DAILY_MAX_POSITIONS) break;
    if (s.tracked[`${u.shareEpic}:daily`]) continue;
    if (s.lastStockEntryDay[`${u.finnhub}:daily`] === today) continue; // one shot per stock per day

    let dp: number;
    let usdPrice: number;
    let dailyRangePct: number; // see scanStockEntries' own comment
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${u.finnhub}&token=${apiKey}`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) continue;
      const q = await res.json() as { c: number; dp: number; h?: number; l?: number };
      if (!q.c || q.dp === undefined || q.dp === null) continue;
      dp = q.dp;
      usdPrice = q.c;
      dailyRangePct = q.h && q.l && q.h > q.l ? ((q.h - q.l) / q.c) * 100 : Math.abs(dp);
    } catch { continue; }
    if (Math.abs(dp) < STOCK_DAILY_MIN_MOVE_PCT) continue;
    if (Math.abs(dp) >= STOCK_DAILY_ALREADY_EXTENDED_PCT) {
      addLog(mode, 'wait', u.name, `[Daily] ${dp >= 0 ? '+' : ''}${dp.toFixed(1)}% today already — too much of today's move likely already behind it, skipping rather than chasing`);
      continue;
    }
    const side: 'call' | 'put' = dp > 0 ? 'call' : 'put';

    const d = details.get(u.shareEpic);
    const spot = typeof d?.bid === 'number' && typeof d?.offer === 'number' ? (d.bid + d.offer) / 2 : null;
    if (!spot) continue;

    let headlines: string[] = [];
    try { headlines = await fetchAllHeadlines(u.finnhub, 8, u.name); } catch { /* prompt handles empty */ }

    // Same anti-drift throttle as weekly, own namespace (":daily" suffix)
    // so a stock evaluating for weekly doesn't block its own same-day eval
    // or vice versa — see scanStockEntries' own comment for why this exists.
    const evalKey = `${Math.round(dp * 2) / 2}|${[...headlines].sort().join('~')}`;
    if (s.lastOptionEvalKey[`${u.finnhub}:daily`] === evalKey) continue;
    s.lastOptionEvalKey[`${u.finnhub}:daily`] = evalKey;

    const verdict = await askIgConfirmStockTrade({
      instrumentName: `${u.name} (buying a ${side.toUpperCase()} option, today's expiry — intraday, no overnight hold)`,
      suggestedDir: side === 'call' ? 'BUY' : 'SELL',
      ruleReasoning: `Moving ${dp >= 0 ? '+' : ''}${dp.toFixed(1)}% today — same-day momentum-continuation bet`,
      ruleConfidence: Math.max(1, Math.min(10, Math.round(Math.abs(dp) * 2))),
      price: usdPrice, rsi: null, macdHist: null, lastCandles: [],
      headlines, dayChangePercent: dp,
      // Without this, StockConfirmSignal.horizon defaults to 'swing' — the
      // prompt then contradicts itself (instrumentName says intraday, the
      // horizon framing says "days to weeks, not a scalp") and the AI
      // vetoes on that mismatch alone. Confirmed live minutes after this
      // daily path first went live: Apple/NVIDIA/Amazon/AMD/Palantir all
      // rejected with some form of "horizon mismatch," not a real
      // assessment of the trade itself. This exact 'intraday' flag already
      // exists in gemini.ts specifically for this case — just wasn't wired
      // up here yet.
      horizon: 'intraday',
    });
    addLog(mode, 'info', u.name, `[Daily] ${dp >= 0 ? '+' : ''}${dp.toFixed(1)}% today → ${side.toUpperCase()} candidate → AI: ${verdict.direction} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);
    if (verdict.engine === 'passthrough' || verdict.direction === 'SKIP' || verdict.confidence < MIN_CONFIRM_CONFIDENCE) continue;

    let premiumBudget = STOCK_PREMIUM_GBP[mode];
    const edge = edgeSizing(journalMode(mode), STOCK_DAILY_STRATEGY);
    if (edge.skip) { addLog(mode, 'wait', u.name, `[Daily] Skipped — ${edge.reason}`); continue; }
    if (edge.multiplier !== 1) premiumBudget = Math.round(STOCK_PREMIUM_GBP[mode] * edge.multiplier);

    const sideWord = side === 'call' ? 'CALL' : 'PUT';
    const dir = side === 'call' ? 1 : -1;
    const base = side === 'call' ? Math.ceil(spot / u.strikeStep) * u.strikeStep : Math.floor(spot / u.strikeStep) * u.strikeStep;
    let entered = false;
    let anyFound = false;

    // Same ITM-first strike order as weekly (see that function's own
    // comment) — the OTM strike is where the same-day chain's already-worse
    // spreads are at their worst, one step ITM the premium is large enough
    // that the same absolute spread is a much smaller percentage.
    for (const strike of [base - u.strikeStep * dir, base, base + u.strikeStep * dir]) {
      await new Promise(r => setTimeout(r, 350));
      let results;
      try { results = await searchMarkets(session, `${u.searchName} ${strike} ${sideWord}`); }
      catch { continue; }
      const nameRe = new RegExp(`^${u.searchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${strike} ${sideWord}$`, 'i');
      const m = results.find(r => r.instrumentType === 'OPT_SHARES' && nameRe.test(r.name));
      if (!m) continue;
      const expiryMs = parseExpiryMs(m.expiry);
      // Must genuinely be today's daily — a stale/next-session chain would
      // break the whole force-close-before-the-bell exit model. This is the
      // filter the weekly search used to (wrongly) share — see that
      // function's own bug-fix comment.
      if (expiryMs === null || expiryMs <= Date.now() || expiryMs - Date.now() >= 36 * 3_600_000) continue;
      anyFound = true;
      const opt = { epic: m.epic, name: m.name, strike, expiry: m.expiry, expiryMs };

      const optDetails = (await fetchMarketDetails(session, [opt.epic])).get(opt.epic);
      const optBid   = typeof optDetails?.bid   === 'number' ? optDetails.bid   : null;
      const optOffer = typeof optDetails?.offer === 'number' ? optDetails.offer : null;
      if (!optDetails || optOffer === null || optOffer <= 0 || optDetails.marketStatus !== 'TRADEABLE') continue;
      if (optBid !== null && (optOffer - optBid) / optOffer > STOCK_DAILY_SPREAD_CAP) {
        addLog(mode, 'wait', opt.name, `[Daily] Spread too wide (${optBid}/${optOffer}) — trying next strike`);
        continue;
      }

      const daysRemaining = (opt.expiryMs - Date.now()) / 86_400_000;
      const move = moveIsPlausible(spot, strike, optOffer, side, daysRemaining, dailyRangePct);
      if (!move.plausible) {
        addLog(mode, 'wait', opt.name, `[Daily] Needs a ${move.requiredMovePct.toFixed(1)}% move to breakeven vs a typical ~${move.expectedMovePct.toFixed(1)}% today — too much of a stretch, trying next strike`);
        continue;
      }

      const minDeal = optDetails.minDealSize || 0.1;
      let stake = Math.max(minDeal, Math.floor((premiumBudget / optOffer) * 100) / 100);
      stake = Math.round(stake * 100) / 100;
      // See scanStockEntries' own comment — same demo-only budget-ceiling skip.
      if (mode === 'live' && optOffer * stake > premiumBudget * 1.25) {
        addLog(mode, 'wait', opt.name, `[Daily] Minimum stake costs £${(optOffer * stake).toFixed(0)} premium — over budget, trying next strike`);
        continue;
      }

      entered = await placeStockOrder(mode, session, s, u, opt, side, stake, optOffer, dp, verdict.confidence, verdict.reason, today, 'stock-daily', premiumBudget);
      if (entered) break;
    }
    if (!entered && !anyFound) addLog(mode, 'wait', u.name, `[Daily] No ${side} found near ${spot.toFixed(0)} in today's chain`);
  }
}

// Faster loop for the weekly stock strategy — momentum entries are stale
// within hours even though the position itself can run several days.
// Entries AND exits for stock-kind positions both live here; the hourly
// poll() below still covers everything as a backstop via the shared manageExits.
async function stockPoll(mode: IgMode): Promise<void> {
  const s = st(mode);
  if (!s.running) return;
  // Same gap-check as meanReversionBot.ts's poll — see its own comment for
  // the full reasoning. Own timestamp/threshold since this loop runs on its
  // own 15min cadence, independent of the index side's hourly one.
  const previousStockPollTs = s.stockLastPollTs;
  const stockGapMs = previousStockPollTs ? Date.now() - new Date(previousStockPollTs).getTime() : 0;
  const stockRecoveringFromGap = stockGapMs > STOCK_POLL_MS * STALE_GAP_MULTIPLE;
  s.stockLastPollTs = new Date().toISOString();

  if (!isScannerQuietWeekend() && isNYSEOpen()) {
    try {
      const session = await getOrAuthSession(mode);
      if (session) {
        s.session = session;
        const positions = await fetchFullPositions(session);
        await manageExits(mode, session, positions);
        if (stockRecoveringFromGap) {
          addLog(mode, 'info', '—', `[Weekly/Daily] Back after a ${(stockGapMs / 60_000).toFixed(0)}min gap (normal cadence is ${(STOCK_POLL_MS / 60_000).toFixed(0)}min) — skipping new entries this cycle so nothing fires on a stale signal; will scan fresh next cycle`);
        } else {
          await scanStockEntries(mode, session);
          await scanStockDailyEntries(mode, session);
          await scanStockMonthlyEntries(mode, session);
        }
      }
    } catch (e) {
      addLog(mode, 'error', '—', `[Weekly] Poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (s.running) {
    const delayMs = isScannerQuietWeekend() ? msUntilWeekendReopen() : STOCK_POLL_MS;
    s.stockPollTimer = setTimeout(() => { void stockPoll(mode); }, delayMs);
  }
}

// ── Poll loop ───────────────────────────────────────────────────────────────
async function poll(mode: IgMode): Promise<void> {
  const s = st(mode);
  if (!s.running) return;
  // Same gap-check as meanReversionBot.ts's poll and this file's own
  // stockPoll above — see either one's comment for the full reasoning.
  const previousPollTs = s.lastPollTs;
  const gapMs = previousPollTs ? Date.now() - new Date(previousPollTs).getTime() : 0;
  const recoveringFromGap = gapMs > POLL_MS * STALE_GAP_MULTIPLE;
  s.lastPollTs = new Date().toISOString();

  // Index options only deal in their underlying's session — nothing to scan
  // or manage across the weekend. Sleep straight through to the reopen
  // rather than burning the hourly cycle on closed markets.
  if (isScannerQuietWeekend()) {
    addLog(mode, 'info', '—', 'Weekend — markets closed, skipping poll');
  } else {
    try {
      const session = await getOrAuthSession(mode);
      if (!session) { addLog(mode, 'error', '—', 'No IG session — check credentials'); }
      else {
        s.session = session;
        const positions = await fetchFullPositions(session);
        await manageExits(mode, session, positions);
        if (recoveringFromGap) {
          addLog(mode, 'info', '—', `Back after a ${(gapMs / 60_000).toFixed(0)}min gap (normal cadence is ${(POLL_MS / 60_000).toFixed(0)}min) — skipping new entries this cycle so nothing fires on a stale signal; will scan fresh next cycle`);
        } else {
          await scanEntries(mode, session);
        }
      }
    } catch (e) {
      addLog(mode, 'error', '—', `Poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (s.running) {
    const delayMs = isScannerQuietWeekend() ? msUntilWeekendReopen() : POLL_MS;
    s.nextRunMs = Date.now() + delayMs;
    s.pollTimer = setTimeout(() => { void poll(mode); }, delayMs);
  }
}

// Fast exits-only loop — entries/scanning stay on their own cadences
// (hourly index, 15min stock), but exit management (peak tracking, the
// retrace lock-in, profit target, DTE, premium stop) now runs far more
// often than either. Confirmed live 2026-08-31 this mattered: peakPlPct can
// only reflect what a check actually observed, and a real intraday peak
// between 15min/hourly checks was simply invisible to it — positions that
// had shown real profit closed for far less because the lock-in never saw
// the real high to trail from. No AI, one shared fetchFullPositions call
// (covers every tracked position at once) — cheap enough to run this often.
const FAST_MONITOR_MS = 2 * 60_000;

async function fastPositionMonitor(mode: IgMode): Promise<void> {
  const s = st(mode);
  if (!s.running) return;

  if (Object.keys(s.tracked).length > 0 && !isScannerQuietWeekend()) {
    try {
      const session = await getOrAuthSession(mode);
      if (session) {
        s.session = session;
        const positions = await fetchFullPositions(session);
        await manageExits(mode, session, positions);
      }
    } catch (e) {
      addLog(mode, 'error', '—', `Fast monitor failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (s.running) {
    s.fastMonitorTimer = setTimeout(() => { void fastPositionMonitor(mode); }, FAST_MONITOR_MS);
  }
}

export function startIgOptionsBot(mode: IgMode): { ok: boolean; error?: string } {
  const creds = resolveCredentials(mode);
  if (!creds.apiKey) return { ok: false, error: `IG ${mode} credentials not configured` };
  const s = st(mode);
  if (s.pollTimer)        clearTimeout(s.pollTimer);
  if (s.stockPollTimer)   clearTimeout(s.stockPollTimer);
  if (s.fastMonitorTimer) clearTimeout(s.fastMonitorTimer);
  s.running = true;
  saveRunningFlag(mode, true);
  addLog(mode, 'info', '—', `IG options bot started — trend-following index options (${UNDERLYINGS.map(u => u.name).join(', ')}, £${INDEX_PREMIUM_GBP[mode]}/position, ${MIN_DTE}-${MAX_DTE}d, max ${MAX_POSITIONS}) + weekly stock momentum options (${STOCK_UNDERLYINGS.map(u => u.name).join(', ')}, £${STOCK_PREMIUM_GBP[mode]}/position, closed ~1 day before expiry, max ${STOCK_MAX_POSITIONS}) + same-day stock momentum options (£${STOCK_PREMIUM_GBP[mode]}/position, closed before the bell, max ${STOCK_DAILY_MAX_POSITIONS}) + monthly stock trend+news options (£${STOCK_PREMIUM_GBP[mode]}/position, ${MIN_DTE}-${MAX_DTE}d, max ${STOCK_MONTHLY_MAX_POSITIONS}) — AI-confirmed entries on all four, exits monitored every ${FAST_MONITOR_MS / 60_000}min`);
  void poll(mode);
  void stockPoll(mode);
  void fastPositionMonitor(mode);
  return { ok: true };
}

export function stopIgOptionsBot(mode: IgMode): { ok: boolean } {
  const s = st(mode);
  s.running = false;
  saveRunningFlag(mode, false);
  if (s.pollTimer)        { clearTimeout(s.pollTimer);        s.pollTimer        = null; }
  if (s.stockPollTimer)   { clearTimeout(s.stockPollTimer);   s.stockPollTimer   = null; }
  if (s.fastMonitorTimer) { clearTimeout(s.fastMonitorTimer); s.fastMonitorTimer = null; }
  addLog(mode, 'info', '—', 'IG options bot stopped');
  return { ok: true };
}

export async function getIgOptionsBotStatus(mode: IgMode): Promise<{
  running: boolean; underlyings: string[]; log: LogEntry[];
  nextRunMs: number | null; lastPollTs: string | null;
  tracked: Record<string, Tracked>; positions?: FullPosition[];
}> {
  const s = st(mode);
  let positions: FullPosition[] | undefined;
  if (s.session) {
    try {
      const all = await fetchFullPositions(s.session);
      const dealIds = new Set(Object.values(s.tracked).map(t => t.dealId));
      positions = all.filter(p => dealIds.has(p.dealId));
    } catch { /* best-effort */ }
  }
  return {
    running: s.running,
    underlyings: [...UNDERLYINGS.map(u => u.name), ...STOCK_UNDERLYINGS.map(u => `${u.name} (weekly)`), ...STOCK_DAILY_UNDERLYINGS.map(u => `${u.name} (daily)`), ...STOCK_MONTHLY_UNDERLYINGS.map(u => `${u.name} (monthly)`)],
    log: s.log, nextRunMs: s.nextRunMs, lastPollTs: s.lastPollTs, tracked: s.tracked, positions,
  };
}

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
// Daily (DO.D.*) same-day-expiry options exist too and are deliberately NOT
// traded — a same-day expiry is nearly all theta with no room for a
// multi-day trend thesis to play out, the exact mistake the 2026-08-21
// Alpaca rebuild removed (its expiry window was widened 7-21d → 21-45d for
// this reason; same numbers reused here).
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
import { askIgConfirmStockTrade, askMrSafety } from './openai';
import { fetchAllHeadlines } from './newsFetch';
import { fetchBarsWithFallback } from './yahooFetch';
import { isScannerQuietWeekend, msUntilWeekendReopen, isNYSEOpen, hoursUntilNYSEClose } from './alpacaApi';
import { edgeSizing } from './quant';

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

// ── Daily STOCK options (second strategy, added same day per explicit
// request — "part of the reason I wanted it setup on IG [was] to create
// stock option positions"). Confirmed by live probe: IG's stock options
// exist ONLY as same-day-expiry dailies (DO.D.AAPL.* etc., OPT_SHARES) —
// no weekly/monthly chains at all — so the index strategy's weeks-long
// trend thesis is structurally impossible here. Instead these run the
// momentum+news idea already proven on the T212 momentum port: a real move
// today, with news the AI judges supportive, expressed as a same-day
// call/put whose premium is the whole risk. Entries only during the US
// session with ≥2h of runway; always force-closed ~20min before the close
// (a daily option not closed just settles at expiry — usually the worst
// possible exit). Own journal key so /performance judges it separately.
const STOCK_UNDERLYINGS = [
  { shareEpic: 'UA.D.AAPL.CASH.IP',  name: 'Apple',  searchName: 'Daily Apple Inc',      finnhub: 'AAPL', strikeStep: 500 },
  { shareEpic: 'UD.D.TSLA.DAILY.IP', name: 'Tesla',  searchName: 'Daily Tesla Motors Inc', finnhub: 'TSLA', strikeStep: 500 },
  { shareEpic: 'UC.D.NVDA.DAILY.IP', name: 'NVIDIA', searchName: 'Daily NVIDIA Corp',    finnhub: 'NVDA', strikeStep: 500 },
  { shareEpic: 'UA.D.AMZN.CASH.IP',  name: 'Amazon', searchName: 'Daily Amazon.com Inc', finnhub: 'AMZN', strikeStep: 500 },
];
const STOCK_STRATEGY = 'ig_options_daily_momentum';
// Per-mode premium budgets — demo runs big deliberately (per explicit
// request 2026-08-31, "its running on demo for now so put more on the
// line": demo money exists to generate meaningful P&L data, and tiny
// positions make even a good run look like noise). Live keeps the
// conservative figures automatically — going live must never inherit demo
// sizing by accident.
// Demo raised again same day: confirmed live the ITM strikes (where the real
// liquidity actually is — ATM/OTM dailies quoted a flat 0 bid, a dead
// market, not just a wide one) cost £350-450 minimum at IG's own minimum
// deal size, comfortably over the original £150 budget. Every rejection
// logged as "over budget", never as illiquid, once ITM-first ordering was
// in place — the budget itself was the last blocker to real fills.
const STOCK_PREMIUM_GBP: Record<IgMode, number> = { demo: 600, live: 30 }; // smaller than the index budget — same-day theta is the riskiest product in the fleet
const STOCK_MAX_POSITIONS   = 2;
const STOCK_MIN_MOVE_PCT    = 1.5;  // today's move must be a real one before the AI is even asked
const STOCK_POLL_MS         = 15 * 60_000; // momentum is stale within hours — can't share the index loop's hourly cadence
const STOCK_MIN_RUNWAY_H    = 2;    // don't open with less than this left in the session
const STOCK_CLOSE_BUFFER_H  = 0.33; // force-close this close to the bell rather than let it settle

// Premium budget per position — the literal maximum £ this trade can lose
// (bought option, loss capped at premium × stake by construction). Live is
// sized in the same league as the CFD bots' £20 risk/trade but slightly
// higher since, unlike a CFD stop, this cap physically cannot slip or gap.
// Demo runs bigger — see STOCK_PREMIUM_GBP's comment above.
const INDEX_PREMIUM_GBP: Record<IgMode, number> = { demo: 250, live: 60 };
const MAX_POSITIONS   = 2;        // across all underlyings; one per underlying enforced separately
const MIN_CONFIRM_CONFIDENCE = 70; // same AI bar as every other confirmed entry in this codebase
const POLL_MS = 60 * 60_000;       // hourly — the signal only changes on daily bars
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
function strategyFor(tr: { kind?: 'index' | 'stock' }): string { return tr.kind === 'stock' ? STOCK_STRATEGY : STRATEGY; }

type Tracked = {
  dealId: string; epic: string; underlyingEpic: string; name: string;
  optionType: 'call' | 'put'; strike: number; expiry: string; expiryMs: number;
  premium: number; size: number; enteredAt: number; peakPlPct: number;
  lastAiCheckAt?: number; // daily severe-news safety check — see manageExits
  kind?: 'index' | 'stock'; // absent = index (positions tracked before the stock strategy existed)
};

type LogEntry = { id: string; ts: string; type: 'info' | 'enter' | 'exit' | 'wait' | 'error'; epic: string; msg: string };

type BotState = {
  running: boolean;
  session: IGSession | null;
  tracked: Record<string, Tracked>; // keyed by underlying epic — one option position per underlying
  log: LogEntry[];
  pollTimer: ReturnType<typeof setTimeout> | null;
  stockPollTimer: ReturnType<typeof setTimeout> | null; // faster loop for the daily stock strategy
  nextRunMs: number | null;
  lastPollTs: string | null;
  // One momentum entry per stock per day, even after that entry has closed —
  // re-chasing the same move after banking/stopping it is how a daily-theta
  // product churns premium away. In-memory only: worst case a restart allows
  // one repeat entry, still AI-gated.
  lastStockEntryDay: Record<string, string>;
  // What the AI was actually shown last time this stock was evaluated —
  // headline set + roughly-rounded day-change. See scanStockEntries' own
  // comment: confirmed live the AI call re-asked on IDENTICAL facts every
  // 15min oscillates HOLD/SKIP with no new information, and the trade that
  // eventually fires is whichever side of that noise it happened to land on,
  // not a real signal. In-memory only, resets on restart (worst case one
  // extra AI call per stock, not a correctness issue).
  lastStockEvalKey: Record<string, string>;
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
    s = { running: false, session: null, tracked: loadTracked(mode), log: [], pollTimer: null, stockPollTimer: null, nextRunMs: null, lastPollTs: null, lastStockEntryDay: {}, lastStockEvalKey: {} };
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
    let closeReason: string | null = null;
    if (tr.kind === 'stock') {
      // Same-day option — timeline is hours, not weeks. Never allowed to
      // reach settlement: force-closed near the bell regardless of P&L.
      // null = outside NYSE hours, i.e. already past the bell somehow
      // (restart gap) — close immediately rather than ride into settlement.
      const runwayH = hoursUntilNYSEClose();
      if (runwayH === null || runwayH <= STOCK_CLOSE_BUFFER_H) closeReason = `~${Math.round((runwayH ?? 0) * 60)}min to the close — closing rather than settling at expiry (${plPct >= 0 ? '+' : ''}${plPct.toFixed(1)}%)`;
      else if (plPct >= 60) closeReason = `Profit target hit: +${plPct.toFixed(1)}% on premium`;
      else if (tr.peakPlPct >= 25 && plPct > 0 && (tr.peakPlPct - plPct) / tr.peakPlPct >= 0.4) {
        closeReason = `Momentum stalling — gave back ${(((tr.peakPlPct - plPct) / tr.peakPlPct) * 100).toFixed(0)}% of its +${tr.peakPlPct.toFixed(1)}% peak, locking in +${plPct.toFixed(1)}%`;
      }
      else if (plPct <= -50) closeReason = `Premium stop hit: ${plPct.toFixed(1)}%`;
    }
    else if (dte <= EXIT_DTE) closeReason = `${dte.toFixed(1)} days to expiry — closing to avoid settlement/theta endgame`;
    else if (plPct >= 75) closeReason = `Profit target hit: +${plPct.toFixed(1)}% on premium`;
    else if (tr.peakPlPct >= 30 && plPct > 0 && (tr.peakPlPct - plPct) / tr.peakPlPct >= 0.4) {
      closeReason = `Stalling — gave back ${(((tr.peakPlPct - plPct) / tr.peakPlPct) * 100).toFixed(0)}% of its +${tr.peakPlPct.toFixed(1)}% peak, locking in +${plPct.toFixed(1)}%`;
    }
    else if (plPct <= -50) closeReason = `Premium stop hit: ${plPct.toFixed(1)}%`;

    // Daily severe-news safety check — the ONE exit power the AI keeps, and
    // only where it has real information the mechanical rules can't see:
    // headlines. severe=true means a genuine emergency (crash-grade macro
    // news against the position's thesis), the same deliberately-narrow bar
    // as mean_reversion_stocks' own daily check — NOT a "close or hold?"
    // chart judgment, which was removed account-wide 2026-08-31 after
    // confirmed live flip-flopping (Exxon, Silver). Catches the slow
    // bleed-on-real-news case where exiting at -15% beats riding the
    // mechanical -50% premium stop; the fast/gap case is already capped by
    // the premium itself. Only underlyings with a news proxy (US 500 → SPY,
    // Wall Street → DIA) get real input; the rest skip — an empty headline
    // list can't detect anything, so the call isn't worth spending.
    if (!closeReason) {
      // Index positions only — a same-day stock position's whole life is
      // shorter than this check's cadence, and its entry already weighed
      // today's news minutes-to-hours ago.
      const u = tr.kind === 'stock' ? undefined : UNDERLYINGS.find(x => x.epic === tr.underlyingEpic);
      if (u?.newsTicker && Date.now() - (tr.lastAiCheckAt ?? 0) >= 20 * 3_600_000) {
        tr.lastAiCheckAt = Date.now();
        saveTracked(mode, s.tracked);
        try {
          const headlines = await fetchAllHeadlines(u.newsTicker, 8, u.name);
          if (headlines.length) {
            const verdict = await askMrSafety({
              instrumentName: `${u.name} index (holding a bought ${tr.optionType.toUpperCase()} option)`,
              direction: tr.optionType === 'call' ? 'BUY' : 'SELL',
              entryLevel: tr.premium, currentLevel: bid ?? tr.premium,
              uplGbp: p.upl, heldDays: (Date.now() - tr.enteredAt) / 86_400_000, headlines,
            });
            addLog(mode, 'info', tr.name, `[Safety check] severe=${verdict.severe} — ${verdict.reason} (${verdict.engine})`);
            if (verdict.severe) closeReason = `AI safety override — ${verdict.reason}`;
          }
        } catch (e) {
          addLog(mode, 'error', tr.name, `Safety check failed: ${e instanceof Error ? e.message : String(e)}`);
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
function countKind(s: BotState, kind: 'index' | 'stock'): number {
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

// ── Daily stock options — momentum entries ──────────────────────────────────
async function scanStockEntries(mode: IgMode, session: IGSession): Promise<void> {
  const s = st(mode);
  if (countKind(s, 'stock') >= STOCK_MAX_POSITIONS) return;
  const runwayH = hoursUntilNYSEClose();
  if (!isNYSEOpen() || runwayH === null || runwayH < STOCK_MIN_RUNWAY_H) return;

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
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${u.finnhub}&token=${apiKey}`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) continue;
      const q = await res.json() as { c: number; dp: number };
      if (!q.c || q.dp === undefined || q.dp === null) continue;
      dp = q.dp;
      usdPrice = q.c;
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
    if (s.lastStockEvalKey[u.finnhub] === evalKey) continue;
    s.lastStockEvalKey[u.finnhub] = evalKey;

    const verdict = await askIgConfirmStockTrade({
      instrumentName: `${u.name} (same-day ${side.toUpperCase()} option expiring at today's close)`,
      suggestedDir: side === 'call' ? 'BUY' : 'SELL',
      ruleReasoning: `Moving ${dp >= 0 ? '+' : ''}${dp.toFixed(1)}% today — momentum-continuation bet into the close, hours not weeks`,
      ruleConfidence: Math.max(1, Math.min(10, Math.round(Math.abs(dp) * 2))),
      price: usdPrice, rsi: null, macdHist: null, lastCandles: [],
      headlines, dayChangePercent: dp,
      horizon: 'intraday',
    });
    addLog(mode, 'info', u.name, `[Daily] ${dp >= 0 ? '+' : ''}${dp.toFixed(1)}% today → ${side.toUpperCase()} candidate → AI: ${verdict.direction} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);
    if (verdict.engine === 'passthrough' || verdict.direction === 'SKIP' || verdict.confidence < MIN_CONFIRM_CONFIDENCE) continue;

    let premiumBudget = STOCK_PREMIUM_GBP[mode];
    const edge = edgeSizing(journalMode(mode), STOCK_STRATEGY);
    if (edge.skip) { addLog(mode, 'wait', u.name, `[Daily] Skipped — ${edge.reason}`); continue; }
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
      // Must genuinely be today's daily — a stale/next-session chain would
      // break the whole force-close-before-the-bell exit model.
      if (expiryMs === null || expiryMs - Date.now() >= 36 * 3_600_000) continue;
      anyFound = true;
      const opt = { epic: m.epic, name: m.name, strike, expiry: m.expiry, expiryMs };

      const optDetails = (await fetchMarketDetails(session, [opt.epic])).get(opt.epic);
      const optBid   = typeof optDetails?.bid   === 'number' ? optDetails.bid   : null;
      const optOffer = typeof optDetails?.offer === 'number' ? optDetails.offer : null;
      if (!optDetails || optOffer === null || optOffer <= 0 || optDetails.marketStatus !== 'TRADEABLE') continue;
      if (optBid !== null && (optOffer - optBid) / optOffer > STOCK_SPREAD_CAP) {
        addLog(mode, 'wait', opt.name, `[Daily] Spread too wide (${optBid}/${optOffer}) — trying next strike`);
        continue;
      }

      const minDeal = optDetails.minDealSize || 0.1;
      let stake = Math.max(minDeal, Math.floor((premiumBudget / optOffer) * 100) / 100);
      stake = Math.round(stake * 100) / 100;
      if (optOffer * stake > premiumBudget * 1.25) {
        addLog(mode, 'wait', opt.name, `[Daily] Minimum stake costs £${(optOffer * stake).toFixed(0)} premium — over budget, trying next strike`);
        continue;
      }

      entered = await placeStockDailyOrder(mode, session, s, u, opt, side, stake, optOffer, dp, verdict.confidence, verdict.reason, today);
      if (entered) break;
    }
    if (!entered && !anyFound) addLog(mode, 'wait', u.name, `[Daily] No same-day ${side} found near ${spot.toFixed(0)}`);
  }
}

async function placeStockDailyOrder(
  mode: IgMode, session: IGSession, s: BotState,
  u: typeof STOCK_UNDERLYINGS[number],
  opt: { epic: string; name: string; strike: number; expiry: string; expiryMs: number },
  side: 'call' | 'put', stake: number, optOffer: number, dp: number,
  confidence: number, aiReason: string, today: string,
): Promise<boolean> {
  try {
    const result = await placeMarketOrder(session, opt.epic, 'BUY', stake, undefined, undefined, 'GBP', false, opt.expiry, optOffer);
    const premium = result.level || optOffer;
    s.lastStockEntryDay[u.finnhub] = today;
    s.tracked[u.shareEpic] = {
      dealId: result.dealId, epic: opt.epic, underlyingEpic: u.shareEpic, name: opt.name,
      optionType: side, strike: opt.strike, expiry: opt.expiry, expiryMs: opt.expiryMs,
      premium, size: stake, enteredAt: Date.now(), peakPlPct: 0, kind: 'stock',
    };
    saveTracked(mode, s.tracked);
    recordJournalEvent({
      mode: journalMode(mode), event: 'entry', symbol: opt.name, strategy: STOCK_STRATEGY,
      side: 'long', qty: stake, price: premium,
      reason: `${dp >= 0 ? '+' : ''}${dp.toFixed(1)}% today, momentum continuation · AI ${confidence}%`, confidence,
    });
    addLog(mode, 'enter', opt.name, `[Daily] BUY ${side.toUpperCase()} @ ${premium.toFixed(1)} premium · ${stake}/pt · max loss £${(premium * stake).toFixed(2)} · closes before today's bell — ${aiReason}`);
    return true;
  } catch (e) {
    addLog(mode, 'error', opt.name, `[Daily] Order failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// Faster loop for the same-day strategy — momentum is stale within hours,
// and the force-close-before-the-bell exit needs sub-hourly checks. Entries
// AND exits for stock-kind positions both live here; the hourly poll()
// below still covers everything as a backstop via the shared manageExits.
async function stockPoll(mode: IgMode): Promise<void> {
  const s = st(mode);
  if (!s.running) return;

  if (!isScannerQuietWeekend() && isNYSEOpen()) {
    try {
      const session = await getOrAuthSession(mode);
      if (session) {
        s.session = session;
        const positions = await fetchFullPositions(session);
        await manageExits(mode, session, positions);
        await scanStockEntries(mode, session);
      }
    } catch (e) {
      addLog(mode, 'error', '—', `[Daily] Poll failed: ${e instanceof Error ? e.message : String(e)}`);
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
        await scanEntries(mode, session);
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

export function startIgOptionsBot(mode: IgMode): { ok: boolean; error?: string } {
  const creds = resolveCredentials(mode);
  if (!creds.apiKey) return { ok: false, error: `IG ${mode} credentials not configured` };
  const s = st(mode);
  if (s.pollTimer)      clearTimeout(s.pollTimer);
  if (s.stockPollTimer) clearTimeout(s.stockPollTimer);
  s.running = true;
  saveRunningFlag(mode, true);
  addLog(mode, 'info', '—', `IG options bot started — trend-following index options (${UNDERLYINGS.map(u => u.name).join(', ')}, £${INDEX_PREMIUM_GBP[mode]}/position, ${MIN_DTE}-${MAX_DTE}d) + same-day stock momentum options (${STOCK_UNDERLYINGS.map(u => u.name).join(', ')}, £${STOCK_PREMIUM_GBP[mode]}/position, closed before the bell) — AI-confirmed entries on both`);
  void poll(mode);
  void stockPoll(mode);
  return { ok: true };
}

export function stopIgOptionsBot(mode: IgMode): { ok: boolean } {
  const s = st(mode);
  s.running = false;
  saveRunningFlag(mode, false);
  if (s.pollTimer)      { clearTimeout(s.pollTimer);      s.pollTimer      = null; }
  if (s.stockPollTimer) { clearTimeout(s.stockPollTimer); s.stockPollTimer = null; }
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
    underlyings: [...UNDERLYINGS.map(u => u.name), ...STOCK_UNDERLYINGS.map(u => `${u.name} (daily)`)],
    log: s.log, nextRunMs: s.nextRunMs, lastPollTs: s.lastPollTs, tracked: s.tracked, positions,
  };
}

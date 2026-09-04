// ── RSI(2) mean-reversion bot — three independent instances ─────────────────
// Built 2026-08-28, deliberately rules-only (no AI entry gate) for 'fx' and
// 'japan225' — see meanReversionStrategy.ts's own comment for why this
// specific approach earned that treatment (real evidence trail, not a guess).
// 'stocks' gets a light-touch AI safety net on open positions ONLY (never an
// entry gate) per explicit request — individual stocks carry idiosyncratic
// risk (fraud, delisting, halts) that a purely mechanical system has no way
// to see coming, unlike a major FX pair or index.
//
// All three share one engine (meanReversionStrategy.ts) and one orchestrator
// (this file) — they differ only in which epics they scan and whether the
// AI safety check is switched on, keyed by `instance`.
import * as fs from 'fs';
import * as path from 'path';
import {
  authenticate, getSession, fetchFullPositions, fetchAccountFunds,
  placeMarketOrder, closePosition as igClosePos, fetchMarketDetails, fetchClosedTransactions,
  type IGSession, type FullPosition,
} from './igApi';
import { getMeanReversionSignal, trendStillIntact, hadBigAdverseCandleToday, type MrBar, type MrSignal, MAX_HOLD_DAYS } from './meanReversionStrategy';
import { emaCrossoverSignal, donchianBreakoutSignal, type PositionSide } from './alpacaStrategies';
import { epicName } from './igStrategyScanner';
import { resolveCredentials, calcStake, type IgMode } from './igStrategyBot';
import { recordJournalEvent, type JournalMode } from './tradeJournal';
import { askMrSafety } from './openai';
import { fetchAllHeadlines } from './newsFetch';
import { EPIC_TO_ALPACA, fetchBarsWithFallback } from './yahooFetch';
import { isScannerQuietWeekend, msUntilWeekendReopen, type AlpacaBar, type Timeframe } from './alpacaApi';
import { edgeSizing } from './quant';

export type MrInstance = 'fx' | 'stocks' | 'japan225';

// Every epic below is one already individually verified live elsewhere in
// this codebase (igStrategyScanner.ts's IG_EPICS) — this file deliberately
// does not introduce a single new, unverified epic code, given how often a
// guessed one has turned out silently wrong (see that file's own comments).
const INSTANCE_EPICS: Record<MrInstance, string[]> = {
  fx: [
    'CS.D.GBPUSD.TODAY.IP', 'CS.D.EURUSD.TODAY.IP', 'CS.D.USDJPY.TODAY.IP',
    'CS.D.EURGBP.TODAY.IP', 'CS.D.AUDUSD.TODAY.IP',
    'IX.D.FTSE.DAILY.IP', 'IX.D.SPTRD.DAILY.IP', 'IX.D.NASDAQ.CASH.IP',
    'IX.D.DAX.DAILY.IP', 'IX.D.DOW.DAILY.IP',
    'CS.D.USCSI.TODAY.IP', 'CC.D.LCO.USS.IP',
  ],
  // Expanded 2026-09-03 (26 -> ~56 names) per explicit request, using ONLY
  // epics already individually verified live elsewhere in this codebase
  // (igStrategyScanner.ts's IG_EPICS — see that file's own comments for how
  // each one was confirmed) — no new guessed epic introduced here, same
  // discipline as the original 26. Paired with batching the per-poll market-
  // details fetch (see scanEntries' own comment) specifically so this
  // expansion doesn't scale up IG allowance use anywhere near proportionally.
  stocks: [
    'UA.D.AAPL.CASH.IP', 'UC.D.MSFT.DAILY.IP', 'UC.D.NVDA.DAILY.IP', 'UA.D.AMZN.CASH.IP',
    'UB.D.GOOGL.DAILY.IP', 'UB.D.FB.DAILY.IP', 'UD.D.TSLA.DAILY.IP', 'UC.D.NFLX.DAILY.IP',
    'SD.D.JPM.DAILY.IP', 'SH.D.VUS.DAILY.IP', 'SH.D.UNH.DAILY.IP', 'SH.D.XOM.DAILY.IP',
    'SA.D.AMD.DAILY.IP', 'UA.D.AVGO.DAILY.IP', 'UB.D.INTC.DAILY.IP', 'UC.D.QCOM.DAILY.IP',
    'UC.D.MU.DAILY.IP', 'SG.D.TSM.DAILY.IP', 'SC.D.F.DAILY.IP',
    'KA.D.BARC.DAILY.IP', 'KA.D.BP.DAILY.IP', 'KA.D.HSBA.DAILY.IP', 'KA.D.AZN.DAILY.IP',
    'SD.D.JNJ.DAILY.IP', 'SE.D.PFE.DAILY.IP', 'SD.D.LLY.DAILY.IP',
    // Memory/storage + enterprise/legacy tech
    'UD.D.SNDKUS.DAILY.IP', 'UD.D.STX.DAILY.IP', 'UC.D.MRVL.DAILY.IP', 'UD.D.SKHYUS.DAILY.IP',
    'UD.D.WDC.DAILY.IP', 'SB.D.DELLUS.DAILY.IP', 'UC.D.RIMM.DAILY.IP', 'EC.D.NOKIAFP.DAILY.IP',
    // More UK stocks
    'KA.D.SHELLN.DAILY.IP', 'KA.D.GSK.DAILY.IP', 'KA.D.LLOY.DAILY.IP',
    // Consumer / crypto-adjacent
    'UA.D.COINUS.DAILY.IP', 'UC.D.RIVNUS.DAILY.IP', 'SH.D.UBERUS.DAILY.IP',
    // Healthcare/pharma + consumer/retail
    'UC.D.MRNAUS.DAILY.IP', 'SE.D.NKE.DAILY.IP', 'SE.D.MCD.DAILY.IP', 'SH.D.WMT.DAILY.IP', 'UA.D.COST.DAILY.IP',
    // Industrials
    'SA.D.BA.DAILY.IP', 'SB.D.CAT.DAILY.IP', 'SC.D.HON.DAILY.IP',
    // Media/communication + utilities
    'SB.D.DIS.DAILY.IP', 'SG.D.T.DAILY.IP', 'SC.D.FPL.DAILY.IP',
    // More AI/semiconductors
    'UA.D.ASML.DAILY.IP', 'UC.D.ONNN.DAILY.IP',
    // Growth tech
    'SE.D.PLTRUS.DAILY.IP', 'SG.D.SHOPUS.DAILY.IP', 'UC.D.PYPLVUS.DAILY.IP',
  ],
  japan225: ['IX.D.NIKKEI.DAILY.IP'],
};

const AI_MONITORED: Record<MrInstance, boolean> = { fx: false, stocks: true, japan225: false };

// Instances running the lighter EMA9/21 crossover trend-follow instead of
// RSI(2)+EMA200 mean-reversion — stocks switched 2026-09-01 per explicit
// request after watching japan225 (briefly on this same approach,
// 2026-08-31) pick up a real signal almost immediately. 'fx' stays on real
// mean-reversion — not asked for, and this account already has real
// evidence mean-reversion works there specifically (see
// meanReversionStrategy.ts's own header comment on the Japan 225 backtest
// origin). Centralized here so every spot that branches on "which signal
// does this instance use" — scanEntries, the trend-invalidation exit,
// journal/edgeSizing keys, the startup log — stays in sync from one place.
// japan225 itself moved on again the same day — see INTRADAY_INSTANCES.
const EMA_TREND_INSTANCES = new Set<MrInstance>(['stocks']);

// Japan225 only, added 2026-09-01, now running Donchian breakout instead of
// EMA crossover — the EMA-crossover-on-30min version (same day, earlier)
// was a genuine improvement in reaction speed but is still fundamentally a
// LAGGING confirmation (a crossover can only fire after two averages have
// already been dragged by a move that's already happened) — confirmed live
// the same day: both real entries opened well into an already-large morning
// move, and the user manually closed both rather than risk it. A breakout
// signal (donchianBreakoutSignal, alpacaStrategies.ts — same function
// donchian_breakout/donchian_hourly already use elsewhere in this codebase)
// answers this more directly: it enters the moment price makes a genuine
// new extreme relative to a recent window, which is closer to "the start of
// a move" than "confirmation two averages have crossed." Still can't
// predict a top/bottom — no mechanical signal can — but reacts to a
// breakout immediately rather than waiting for a lagging average to catch
// up. Periods (24 bars entry / 12 bars exit — 12h/6h on 30-min bars) reuse
// donchian_hourly's own already-validated 2:1 entry:exit ratio rather than
// inventing new untested numbers, just on a finer timeframe. Exit works the
// same way emaCrossoverSignal's did: re-consulted every poll via its own
// inPosition branch, closing the moment price breaks the OPPOSITE side of
// the (shorter) exit channel — symmetric, whether that's cutting a loss or
// banking a gain ("errors to be fixed and positives to be taken"). This is
// the PRIMARY exit for this instance; the wide ATR/percentage-capped stop
// set at entry stays attached broker-side purely as a backstop. Scoped to
// japan225 only — not asked for on 'stocks' too, and 26 stocks re-scanned
// this often would be a much bigger step up in call volume than one index.
const INTRADAY_INSTANCES = new Set<MrInstance>(['japan225']);
const DONCHIAN_ENTRY_PERIOD_INTRADAY = 24; // 12h of 30-min bars
const DONCHIAN_EXIT_PERIOD_INTRADAY  = 12; // 6h of 30-min bars
function barFetchParamsFor(instance: MrInstance): { range: string; alpacaTimeframe: Timeframe; yahooInterval: '30m' | '1d' } {
  return INTRADAY_INSTANCES.has(instance)
    ? { range: '1mo', alpacaTimeframe: '30Min', yahooInterval: '30m' } // Yahoo's 30m interval only covers ~60 days back — 1mo comfortably fits, same reasoning as gemini_opinion's own identical params in igStrategyBot.ts
    : { range: '2y',  alpacaTimeframe: '1Day',  yahooInterval: '1d' };
}

// Raised 2026-08-31 per explicit request — £5 against these strategies' real
// (ATR-based, often several-hundred-point) stops was sizing wins as small as
// £0.54 even on a full run to take-profit. £20 matches what ig-bot's own
// mean_reversion_swing strategy already risks per trade on the identical
// signal/stop framework — no reason this standalone instance should run at
// 1/4 the size for the same setup. See edgeSizing below for the per-position
// scaling on top of this base.
const MAX_RISK_GBP  = 20;  // £ risked per trade (base, before edgeSizing scales it)
const MAX_POSITIONS = 3;   // per instance, not shared across instances
// Lowered from hourly to 15min per explicit request 2026-08-31 — the daily-
// bar signal itself still only changes once a real day closes, so this
// doesn't create new signals faster; what it does buy is reacting sooner
// once a signal is already valid (previously could sit unentered for up to
// an hour after qualifying) and catching a position needing management
// sooner. Cheap to run this often: rules-only, no AI call in the loop
// (AI_MONITORED gates only the once-daily safety check on 'stocks'), so this
// is just more frequent Yahoo/IG market-detail fetches, not more AI spend.
const POLL_MS        = 15 * 60_000;
const AI_CHECK_EVERY_MS = 20 * 3_600_000; // ~once/day per open position, deliberately low-frequency

type Tracked = {
  dealId: string; epic: string; direction: 'BUY' | 'SELL';
  entryLevel: number; size: number; enteredAt: number;
  lastAiCheckAt?: number;
};

type LogEntry = { id: string; ts: string; type: 'info' | 'enter' | 'exit' | 'wait' | 'error'; epic: string; msg: string };

type InstanceState = {
  running: boolean;
  session: IGSession | null;
  tracked: Record<string, Tracked>; // keyed by epic
  lastEntryDay: Record<string, string>; // epic -> yyyy-mm-dd of the last entry taken on it, see its own comment below
  log: LogEntry[];
  pollTimer: ReturnType<typeof setTimeout> | null;
  nextRunMs: number | null;
  lastPollTs: string | null;
};

const states = new Map<string, InstanceState>();
function stateKey(instance: MrInstance, mode: IgMode): string { return `${instance}:${mode}`; }

function trackedFile(instance: MrInstance, mode: IgMode): string {
  return path.join(__dirname, '..', `mr-${instance}-tracked-${mode}.json`);
}
function loadTracked(instance: MrInstance, mode: IgMode): Record<string, Tracked> {
  try { return JSON.parse(fs.readFileSync(trackedFile(instance, mode), 'utf8')) as Record<string, Tracked>; }
  catch { return {}; }
}
function saveTracked(instance: MrInstance, mode: IgMode, tracked: Record<string, Tracked>): void {
  try { fs.writeFileSync(trackedFile(instance, mode), JSON.stringify(tracked), 'utf8'); } catch {}
}

// One entry per epic per calendar day — added 2026-09-03 after a live
// incident: emaCrossoverSignal's "crossedAbove" check compares YESTERDAY's
// close-based EMA relationship to TODAY's still-forming one, which stays
// true on every single poll for the whole day (not just the moment it first
// crosses) as long as today hasn't rolled over into a new bar yet. Meta got
// manually closed by the user specifically to stop the position, and the
// very next poll re-entered it — same epic, same direction, same signal —
// because nothing remembered "we already acted on this crossover today."
// Persisted (not just in-memory) so a restart doesn't reset the throttle
// and immediately reopen everything that was deliberately closed that day.
function lastEntryDayFile(instance: MrInstance, mode: IgMode): string {
  return path.join(__dirname, '..', `mr-${instance}-last-entry-day-${mode}.json`);
}
function loadLastEntryDay(instance: MrInstance, mode: IgMode): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(lastEntryDayFile(instance, mode), 'utf8')) as Record<string, string>; }
  catch { return {}; }
}
function saveLastEntryDay(instance: MrInstance, mode: IgMode, days: Record<string, string>): void {
  try { fs.writeFileSync(lastEntryDayFile(instance, mode), JSON.stringify(days), 'utf8'); } catch {}
}

function runningFlagFile(instance: MrInstance, mode: IgMode): string {
  return path.join(__dirname, '..', `mr-${instance}-running-${mode}.json`);
}
export function wasMeanReversionBotRunning(instance: MrInstance, mode: IgMode): boolean {
  try { return (JSON.parse(fs.readFileSync(runningFlagFile(instance, mode), 'utf8')) as { running: boolean }).running; }
  catch { return false; }
}
function saveRunningFlag(instance: MrInstance, mode: IgMode, running: boolean): void {
  try { fs.writeFileSync(runningFlagFile(instance, mode), JSON.stringify({ running }), 'utf8'); } catch {}
}

function ms(instance: MrInstance, mode: IgMode): InstanceState {
  const key = stateKey(instance, mode);
  let s = states.get(key);
  if (!s) {
    s = { running: false, session: null, tracked: loadTracked(instance, mode), lastEntryDay: loadLastEntryDay(instance, mode), log: [], pollTimer: null, nextRunMs: null, lastPollTs: null };
    states.set(key, s);
  }
  return s;
}

function addLog(instance: MrInstance, mode: IgMode, type: LogEntry['type'], epic: string, msg: string): void {
  const s = ms(instance, mode);
  const entry: LogEntry = { id: Math.random().toString(36).slice(2, 9), ts: new Date().toLocaleTimeString('en-GB', { hour12: false }), type, epic, msg };
  s.log.unshift(entry);
  if (s.log.length > 200) s.log.length = 200;
  console.log(`[mr:${instance}:${mode}] [${type.toUpperCase()}] [${epic}] ${msg}`);
}

function journalMode(mode: IgMode): JournalMode { return mode === 'live' ? 'ig-live' : 'ig-demo'; }
// Distinct key for EMA-trend instances so edgeSizing/EDGE_STATS_CUTOFF judge
// the new strategy on its own track record rather than inheriting (or
// polluting) mean-reversion's — see EMA_TREND_INSTANCES above.
function strategyKey(instance: MrInstance): string {
  if (INTRADAY_INSTANCES.has(instance)) return `donchian_intraday_${instance}`;
  return EMA_TREND_INSTANCES.has(instance) ? `ema_trend_${instance}` : `mean_reversion_${instance}`;
}

// Extended-move screen for EMA-trend entries — ported from t212Bot.ts's own
// isExtendedMove, added 2026-09-03 after a live Meta BUY crossed EMA9/21
// well after what looked like the bulk of its move had already happened.
// A crossover can only ever fire after price has already moved enough to
// drag the fast average through the slow one — that's unavoidable
// regardless of period length (a faster pair doesn't catch the move
// earlier, it just reacts to a smaller prior move and whipsaws far more on
// ordinary chop, the exact "choppy market" risk this was raised about). The
// actual fix isn't speed, it's this: skip a crossover that's arrived after
// the stock has ALREADY made a large run and is sitting right at its
// extreme — the easy part of the move is already priced in and
// mean-reversion risk is elevated. Applied symmetrically to the short side
// (already fallen a long way, sitting near its low) since this instance
// trades both directions, unlike the long-only ISA bot this was ported from.
const EXTENDED_TREND_12W_PCT    = 40; // % — a run this large already reflects a major re-rating
const EXTENDED_NEAR_EXTREME_PCT = 4;  // % off the 52-week high/low counts as "sitting at the extreme" of that move
const EXTENDED_TREND_52W_PCT    = 80; // % — already roughly doubled (or halved, short side) over the past year
function isExtendedMove(bars: MrBar[], direction: 'BUY' | 'SELL'): boolean {
  if (bars.length < 60) return false;
  const closes = bars.map(b => b.close);
  const last   = closes[closes.length - 1];
  const idx12w = Math.max(0, closes.length - 1 - 60);
  const trend12w = closes[idx12w] > 0 ? ((last - closes[idx12w]) / closes[idx12w]) * 100 : 0;
  const idx52w   = Math.max(0, closes.length - 1 - 252);
  const trend52w = closes[idx52w] > 0 ? ((last - closes[idx52w]) / closes[idx52w]) * 100 : 0;
  const window = closes.slice(Math.max(0, closes.length - 252));
  if (direction === 'BUY') {
    const high52w = Math.max(...window);
    const pctBelowHigh = high52w > 0 ? ((high52w - last) / high52w) * 100 : 0;
    if (trend12w >= EXTENDED_TREND_12W_PCT && pctBelowHigh < EXTENDED_NEAR_EXTREME_PCT) return true;
    return trend52w >= EXTENDED_TREND_52W_PCT;
  }
  const low52w = Math.min(...window);
  const pctAboveLow = low52w > 0 ? ((last - low52w) / low52w) * 100 : 0;
  if (trend12w <= -EXTENDED_TREND_12W_PCT && pctAboveLow < EXTENDED_NEAR_EXTREME_PCT) return true;
  return trend52w <= -EXTENDED_TREND_52W_PCT;
}

// Shared session with every other IG bot in this account (igStrategyBot.ts,
// fxScalperBot.ts, geminiWatch.ts all use the same 'igstrat:<mode>' key) —
// one login, not a fifth separate one.
async function getOrAuthSession(mode: IgMode): Promise<IGSession | null> {
  const sessionKey = `igstrat:${mode}`;
  const existing = getSession(sessionKey);
  if (existing && Date.now() < existing.expiresAt - 2 * 60_000) return existing;
  const creds = resolveCredentials(mode);
  if (!creds.apiKey || !creds.username || !creds.password) return null;
  try { return await authenticate(creds.apiKey, creds.username, creds.password, creds.env, sessionKey); }
  catch { return null; }
}

function toMrBars(bars: AlpacaBar[]): MrBar[] {
  return bars.map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c }));
}

// Recovers a position that vanished from /positions without this file's own
// close code ever running — same pattern as igStrategyBot.ts's
// journalSilentCloses. Originally assumed this always meant "a real
// stop/take-profit hit at the broker," since a fixed ATR-based stop/TP means
// most exits here do happen exactly this way — but confirmed live
// 2026-09-01 that's not the only cause: the user closed two Japan 225
// positions manually via IG's own app (saw the price already gone against
// the direction they wanted, closed rather than risk it), and this function
// had no way to tell that apart from a real stop/TP hit, journaling both
// identically. Reworded to not claim a mechanism it can't actually verify —
// still recovers the real P&L/level correctly (that part comes straight
// from IG's own closed-transaction record), just doesn't guess why.
async function recoverSilentClose(instance: MrInstance, mode: IgMode, session: IGSession, tr: Tracked): Promise<void> {
  const name = epicName(tr.epic);
  try {
    const since = new Date(tr.enteredAt - 3600_000).toISOString();
    const txns = await fetchClosedTransactions(session, since);
    const candidates = txns.filter(t => t.instrumentName === name);
    const match = candidates.length === 1 ? candidates[0]
      : candidates.find(t => t.openLevel !== undefined && Math.abs(t.openLevel - tr.entryLevel) < Math.max(1, tr.entryLevel * 0.005));
    const plUsd = match?.profitAndLoss ?? 0;
    const notional = tr.entryLevel * tr.size;
    recordJournalEvent({
      mode: journalMode(mode), event: 'exit', symbol: name, strategy: strategyKey(instance),
      side: tr.direction === 'BUY' ? 'long' : 'short', qty: tr.size, price: match?.closeLevel ?? tr.entryLevel,
      reason: 'Closed outside this bot\'s own code — broker-side stop/TP, or closed manually/elsewhere',
      plUsd, plPct: notional > 0 ? (plUsd / notional) * 100 : 0,
    });
    addLog(instance, mode, 'exit', name, `Closed elsewhere — £${plUsd.toFixed(2)} (${tr.entryLevel.toFixed(2)} → ${(match?.closeLevel ?? tr.entryLevel).toFixed(2)})`);
  } catch (e) {
    addLog(instance, mode, 'error', name, `Silent-close recovery failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function manageExits(instance: MrInstance, mode: IgMode, session: IGSession, positions: FullPosition[]): Promise<void> {
  const s = ms(instance, mode);
  const openByEpic = new Map(positions.map(p => [p.epic, p]));
  const aiOn = AI_MONITORED[instance];

  for (const [epic, tr] of Object.entries(s.tracked)) {
    const p = openByEpic.get(epic);
    if (!p) {
      await recoverSilentClose(instance, mode, session, tr);
      delete s.tracked[epic];
      saveTracked(instance, mode, s.tracked);
      continue;
    }

    const heldDays = (Date.now() - tr.enteredAt) / 86_400_000;
    if (heldDays >= MAX_HOLD_DAYS) {
      try {
        await igClosePos(session, p.dealId, p.direction, p.size);
        const notional = p.level * p.size;
        recordJournalEvent({
          mode: journalMode(mode), event: 'exit', symbol: epicName(epic), strategy: strategyKey(instance),
          side: p.direction === 'BUY' ? 'long' : 'short', qty: p.size, price: p.level,
          reason: `Max hold ${MAX_HOLD_DAYS} days reached — closing as a backstop, not a target`,
          plUsd: p.upl, plPct: notional > 0 ? (p.upl / notional) * 100 : 0,
        });
        addLog(instance, mode, 'exit', epicName(epic), `Max hold ${MAX_HOLD_DAYS}d reached — closed, £${p.upl.toFixed(2)}`);
        delete s.tracked[epic];
        saveTracked(instance, mode, s.tracked);
        continue;
      } catch (e) {
        addLog(instance, mode, 'error', epicName(epic), `Max-hold close failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Shared bar fetch for both checks below — trend-invalidation (mean-
    // reversion instances only) and the same-day big-adverse-candle exit
    // (every instance — thesis-agnostic, pure price action). Bug fixed
    // 2026-09-01: these two used to share one `if (!EMA_TREND_INSTANCES...)`
    // gate, which accidentally also skipped the big-candle exit for
    // japan225/stocks even though its reasoning has nothing to do with the
    // mean-reversion thesis — confirmed by user question after a Japan 225
    // SELL opened right after what looked like an already-happened big move,
    // exactly the scenario this exit exists to catch.
    let mrBars: MrBar[] | null = null;
    let rawBars: AlpacaBar[] | null = null;
    try {
      const isAlpacaCovered = epic in EPIC_TO_ALPACA;
      const igMid = typeof p.bid === 'number' && typeof p.offer === 'number' ? (p.bid + p.offer) / 2 : undefined;
      const { range, alpacaTimeframe, yahooInterval } = barFetchParamsFor(instance);
      const raw = await fetchBarsWithFallback(epic, range, {
        alpacaTimeframe, yahooInterval,
        liveReferenceLevel: !isAlpacaCovered ? igMid : undefined,
      });
      rawBars = raw ?? null;
      mrBars = raw?.length ? toMrBars(raw) : null;
    } catch (e) {
      addLog(instance, mode, 'error', epicName(epic), `Trend/candle bar fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Trend-invalidation exit — closes immediately once price has
    // decisively broken the SAME 200-day trend line that justified this
    // position's entry (a BUY only ever fires when price > EMA200, a SELL
    // only when price < EMA200 — see meanReversionStrategy.ts's own
    // trendStillIntact comment). Per explicit request 2026-09-01: "a red
    // candle... is more a case you need to stop a loss rather than waiting
    // for something to bounce back into profit" — some red candles really
    // do mean the thesis has failed, not just an ordinary bad day to sit
    // through. Skipped for EMA_TREND_INSTANCES, which don't run
    // mean-reversion (switched to EMA crossover trend-follow — no 200-day
    // thesis to invalidate). Note this also stops applying to any position
    // still open from BEFORE an instance switched over (e.g. stocks'
    // existing NVIDIA/Netflix/Intel positions, opened under the old
    // mean-reversion thesis) — acceptable: they keep the wide ATR stop, the
    // same-day big-candle exit, and the AI safety check regardless, just
    // lose this one specific layer once the instance itself has moved on.
    // Only implemented here, not also in igStrategyBot.ts's account-wide
    // exit loop — this file already tracks each position's own entry
    // direction and has the correctly-scaled bar-fetch machinery ready from
    // entry time; duplicating it there would risk both bots racing to close
    // the same position (same reasoning as not porting the profit-lock
    // trail there).
    if (!EMA_TREND_INSTANCES.has(instance) && !INTRADAY_INSTANCES.has(instance) && mrBars) {
      try {
        const intact = trendStillIntact(mrBars, tr.direction);
        if (intact === false) {
          await igClosePos(session, p.dealId, p.direction, p.size);
          const notional = p.level * p.size;
          recordJournalEvent({
            mode: journalMode(mode), event: 'exit', symbol: epicName(epic), strategy: strategyKey(instance),
            side: p.direction === 'BUY' ? 'long' : 'short', qty: p.size, price: p.level,
            reason: 'Trend invalidated — price closed on the wrong side of its own 200-day average, the same line that justified this entry',
            plUsd: p.upl, plPct: notional > 0 ? (p.upl / notional) * 100 : 0,
          });
          addLog(instance, mode, 'exit', epicName(epic), `⚠️ Trend invalidated — closed, £${p.upl.toFixed(2)} (price broke back across its own 200-day average)`);
          delete s.tracked[epic];
          saveTracked(instance, mode, s.tracked);
          continue;
        }
      } catch (e) {
        addLog(instance, mode, 'error', epicName(epic), `Trend check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Same-day large-adverse-move exit — applies to EVERY instance,
    // including EMA-trend ones (see the bug-fix comment above). Per
    // explicit follow-up: news alone doesn't catch a genuinely bad day with
    // no news behind it at all (confirmed live: this exact gap forced a
    // manual close on Intel), and "the realtime price will be necessary" —
    // uses IG's own live quote, not a possibly-stale daily bar field. See
    // hadBigAdverseCandleToday's own comment for the ATR-scaled reasoning
    // (ruling out a flat-percentage threshold, which is what made the old
    // weak-open guard fire on ordinary noise). Only acts when the position
    // is ALSO currently at a loss — a big move still in its favor is not a
    // reason to panic out of it. This is also the direct answer to "the
    // large red candle already happened, isn't entering now risky" — a
    // crossover signal is inherently a LAGGING confirmation (it can only
    // fire after the move that caused it), so yes, some of the move is
    // already priced in by the time it triggers; this exit is what actually
    // protects against having entered right as an already-large move
    // exhausts and reverses, rather than the wide ATR stop alone.
    // Excludes INTRADAY_INSTANCES — "yesterday's close vs today's worst
    // point" doesn't translate cleanly to 30-min bars (most recent bars are
    // ALL "today"), and these instances get the faster, more direct live
    // crossover-reversal exit just below instead, which supersedes this as
    // the fast-acting protection for them.
    if (p.upl < 0 && mrBars && !INTRADAY_INSTANCES.has(instance)) {
      try {
        const livePrice = p.direction === 'BUY' ? p.bid : p.offer;
        const bigMove = hadBigAdverseCandleToday(mrBars, tr.direction, livePrice);
        if (bigMove === true) {
          await igClosePos(session, p.dealId, p.direction, p.size);
          const notional = p.level * p.size;
          recordJournalEvent({
            mode: journalMode(mode), event: 'exit', symbol: epicName(epic), strategy: strategyKey(instance),
            side: p.direction === 'BUY' ? 'long' : 'short', qty: p.size, price: p.level,
            reason: 'Unusually large adverse move today (well outside this instrument\'s normal daily range) — cutting the loss rather than waiting for the wide stop',
            plUsd: p.upl, plPct: notional > 0 ? (p.upl / notional) * 100 : 0,
          });
          addLog(instance, mode, 'exit', epicName(epic), `⚠️ Big adverse move today — closed, £${p.upl.toFixed(2)} (well outside its normal daily range)`);
          delete s.tracked[epic];
          saveTracked(instance, mode, s.tracked);
          continue;
        }
      } catch (e) {
        addLog(instance, mode, 'error', epicName(epic), `Big-candle check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Live breakout-channel-reversal exit — INTRADAY_INSTANCES only
    // (japan225). Per explicit request 2026-09-01: carry the position as
    // long as the trend holds, but reconsider and close on any real sign
    // it's turning — whether that's cutting a loss or banking a gain.
    // Re-runs the exact same donchianBreakoutSignal function used at entry,
    // this time via its own inPosition branch: CLOSE_LONG when price breaks
    // below the shorter exit channel's low, CLOSE_SHORT when it breaks
    // above the exit channel's high. This is the PRIMARY, actively-managed
    // exit for this instance now — the wide ATR/percentage-capped stop/TP
    // attached at entry remains only as a broker-side backstop for a move
    // too fast for a 15min poll to catch in time.
    if (INTRADAY_INSTANCES.has(instance) && rawBars?.length) {
      try {
        const side: PositionSide = tr.direction === 'BUY' ? 'long' : 'short';
        const donchExit = donchianBreakoutSignal(rawBars, true, side, DONCHIAN_ENTRY_PERIOD_INTRADAY, DONCHIAN_EXIT_PERIOD_INTRADAY, '30min');
        if (donchExit.action === 'CLOSE_LONG' || donchExit.action === 'CLOSE_SHORT') {
          await igClosePos(session, p.dealId, p.direction, p.size);
          const notional = p.level * p.size;
          recordJournalEvent({
            mode: journalMode(mode), event: 'exit', symbol: epicName(epic), strategy: strategyKey(instance),
            side: p.direction === 'BUY' ? 'long' : 'short', qty: p.size, price: p.level,
            reason: `Trend reversed — ${donchExit.reason}`,
            plUsd: p.upl, plPct: notional > 0 ? (p.upl / notional) * 100 : 0,
          });
          addLog(instance, mode, 'exit', epicName(epic), `${p.upl >= 0 ? '💰' : '⚠️'} Trend reversed — closed, £${p.upl.toFixed(2)} (${donchExit.reason})`);
          delete s.tracked[epic];
          saveTracked(instance, mode, s.tracked);
          continue;
        }
      } catch (e) {
        addLog(instance, mode, 'error', epicName(epic), `Crossover-exit check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Light-touch AI safety net — 'stocks' only, at most once/day per
    // position, never an entry gate. See buildMrSafetyPrompt's own comment.
    if (aiOn && Date.now() - (tr.lastAiCheckAt ?? 0) >= AI_CHECK_EVERY_MS) {
      tr.lastAiCheckAt = Date.now();
      saveTracked(instance, mode, s.tracked);
      const ticker = EPIC_TO_ALPACA[epic];
      let headlines: string[] = [];
      try { if (ticker) headlines = await fetchAllHeadlines(ticker, 5, epicName(epic)); } catch {}
      try {
        const verdict = await askMrSafety({
          instrumentName: epicName(epic), direction: p.direction, entryLevel: p.level,
          currentLevel: p.direction === 'BUY' ? p.bid : p.offer, uplGbp: p.upl, heldDays, headlines,
        });
        addLog(instance, mode, 'info', epicName(epic), `[Safety check] severe=${verdict.severe} — ${verdict.reason} (${verdict.engine})`);
        if (verdict.severe) {
          await igClosePos(session, p.dealId, p.direction, p.size);
          const notional = p.level * p.size;
          recordJournalEvent({
            mode: journalMode(mode), event: 'exit', symbol: epicName(epic), strategy: strategyKey(instance),
            side: p.direction === 'BUY' ? 'long' : 'short', qty: p.size, price: p.level,
            reason: `AI safety override — ${verdict.reason}`,
            plUsd: p.upl, plPct: notional > 0 ? (p.upl / notional) * 100 : 0,
          });
          addLog(instance, mode, 'exit', epicName(epic), `AI safety override — closed, £${p.upl.toFixed(2)} (${verdict.reason})`);
          delete s.tracked[epic];
          saveTracked(instance, mode, s.tracked);
        }
      } catch (e) {
        addLog(instance, mode, 'error', epicName(epic), `Safety check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

async function scanEntries(instance: MrInstance, mode: IgMode, session: IGSession, positions: FullPosition[]): Promise<void> {
  const s = ms(instance, mode);
  const openEpics = new Set(positions.map(p => p.epic));
  const trackedCount = Object.keys(s.tracked).length;
  if (trackedCount >= MAX_POSITIONS) return;
  let slotsLeft = MAX_POSITIONS - trackedCount;

  // Batched once per poll rather than once per epic — added 2026-09-03 when
  // 'stocks' grew from 26 to ~56 names (see INSTANCE_EPICS' own comment):
  // this was firing one real IG API call per epic, every single poll,
  // unconditionally (unlike the bars/trend fetch below, which is
  // Yahoo/Alpaca and free) — the actual allowance-sensitive part of this
  // loop. fetchMarketDetails already batches internally at IG's own 50-epic
  // cap, so one call here costs at most 2 requests for the whole universe
  // instead of up to 56 individual ones.
  let detailsMap: Awaited<ReturnType<typeof fetchMarketDetails>>;
  try {
    detailsMap = await fetchMarketDetails(session, INSTANCE_EPICS[instance]);
  } catch (e) {
    addLog(instance, mode, 'error', '—', `Market details batch failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  for (const epic of INSTANCE_EPICS[instance]) {
    if (slotsLeft <= 0) break;
    if (s.tracked[epic] || openEpics.has(epic)) continue; // already have a position here — including one this bot doesn't own, to avoid doubling up on the same instrument
    const today = new Date().toISOString().slice(0, 10);
    if (s.lastEntryDay[epic] === today) continue; // already entered this epic today — see lastEntryDayFile's own comment

    const d = detailsMap.get(epic);
    const igMid = typeof d?.bid === 'number' && typeof d?.offer === 'number' ? (d.bid + d.offer) / 2 : undefined;

    let bars: MrBar[];
    let raw: AlpacaBar[] | null = null;
    try {
      // Yahoo/Alpaca, not IG's own historical-data endpoint — confirmed
      // live 2026-08-28 that firing ~250-bar candle requests across every
      // epic in all three instances at once blew straight through IG's own
      // API-key allowance (error.public-api.exceeded-api-key-allowance),
      // the same allowance every other IG bot on this account shares. Free,
      // unlimited alternative already used by this codebase's other
      // daily-bar strategies (igStrategyScanner.ts's YAHOO_SCAN_STRATEGIES)
      // for exactly this reason.
      //
      // liveReferenceLevel only for non-Alpaca-covered epics (FX/indices/
      // commodities) — confirmed live 2026-08-28 this was a real, serious
      // bug without it: Yahoo returns these in raw price terms (EUR/USD
      // ~1.16) while IG spread-bets them in its own points scale (~11622,
      // ~10000x here, a different ratio per instrument) — the ATR-derived
      // stop/TP distances came out in the wrong scale entirely (a real
      // EUR/USD position went out with a TP of 0.0 points and no stop
      // actually attached). Alpaca-covered epics are skipped here because
      // fetchBarsWithFallback already auto-applies its own correct ×100
      // share scaling for spread-bet epics by default — confirmed live this
      // path produced correctly-scaled stop/TP (exactly 2:1 as configured)
      // without any extra help.
      const isAlpacaCovered = epic in EPIC_TO_ALPACA;
      const { range, alpacaTimeframe, yahooInterval } = barFetchParamsFor(instance);
      raw = await fetchBarsWithFallback(epic, range, {
        alpacaTimeframe, yahooInterval,
        liveReferenceLevel: !isAlpacaCovered ? igMid : undefined,
      });
      if (!raw?.length) continue;
      bars = toMrBars(raw);
    } catch (e) {
      addLog(instance, mode, 'error', epicName(epic), `Candle fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // INTRADAY_INSTANCES (japan225) get a Donchian breakout entry instead —
    // see that Set's own comment for why (breakout reacts to a genuine new
    // extreme, closer to "the start of a move" than a lagging crossover
    // confirmation). EMA_TREND_INSTANCES (stocks) get the lighter, more
    // permissive EMA9/21 crossover instead of RSI(2)+EMA200 mean-reversion —
    // switched 2026-09-01 after watching japan225's own (now-superseded)
    // EMA-crossover swap pick up a real signal almost immediately. Both
    // reuse validated functions from alpacaStrategies.ts as-is rather than
    // inventing new logic; both convert stopPrice/takeProfitPrice (absolute
    // levels) into point distances to match MrSignal's shape, which
    // everything downstream (calcStake, the conviction-scaled floor,
    // journaling) already expects. Once open, a mean-reversion position is
    // managed by fixed broker-side stop/TP + MAX_HOLD_DAYS only — its own
    // signal is never re-checked. EMA-trend/intraday positions ARE
    // re-checked every poll (see manageExits' own reversal-exit blocks).
    // 'stocks' keeps its same 26-name watchlist — only the signal changed,
    // not the universe — and any already-open positions there (opened under
    // the old mean-reversion thesis) keep being managed by every other
    // mechanism unaffected by this (stop/TP, big-candle exit, AI safety,
    // max-hold).
    let signal: MrSignal;
    if (INTRADAY_INSTANCES.has(instance)) {
      const donchSig = donchianBreakoutSignal(raw!, false, undefined, DONCHIAN_ENTRY_PERIOD_INTRADAY, DONCHIAN_EXIT_PERIOD_INTRADAY, '30min');
      if (donchSig.action !== 'BUY' && donchSig.action !== 'SELL') continue;
      const lastClose  = raw![raw!.length - 1].c;
      const stopPoints = donchSig.stopPrice       !== undefined ? Math.abs(lastClose - donchSig.stopPrice)       : lastClose * 0.015;
      const tpPoints   = donchSig.takeProfitPrice !== undefined ? Math.abs(donchSig.takeProfitPrice - lastClose) : lastClose * 0.10;
      signal = { action: donchSig.action, reason: `[Donchian] ${donchSig.reason}`, stopPoints, tpPoints, conviction: (donchSig.confidence ?? 50) / 100 };
    } else if (EMA_TREND_INSTANCES.has(instance)) {
      // Standard EMA9/21 (emaCrossoverSignal's own default) — considered a
      // faster EMA5/13 pair 2026-09-01 but decided against it: the daily AI
      // safety check already covers the "is something actually wrong"
      // question, so there's less need for the entry signal itself to react
      // faster, and 9/21 avoids the extra whipsaw a shorter pair invites.
      const emaSig = emaCrossoverSignal(raw!, false);
      if (emaSig.action !== 'BUY' && emaSig.action !== 'SELL') continue;
      if (isExtendedMove(bars, emaSig.action)) {
        addLog(instance, mode, 'wait', epicName(epic), `[EMA trend] ${emaSig.reason} — but the move already looks spent (12w/52w trend + sitting near its extreme), skipping`);
        continue;
      }
      const lastClose  = raw![raw!.length - 1].c;
      const stopPoints = emaSig.stopPrice       !== undefined ? Math.abs(lastClose - emaSig.stopPrice)       : lastClose * 0.02;
      const tpPoints   = emaSig.takeProfitPrice !== undefined ? Math.abs(emaSig.takeProfitPrice - lastClose) : lastClose * 0.05;
      signal = { action: emaSig.action, reason: `[EMA trend] ${emaSig.reason}`, stopPoints, tpPoints, conviction: (emaSig.confidence ?? 50) / 100 };
    } else {
      signal = getMeanReversionSignal(bars);
      if (signal.action === 'HOLD') continue;
    }

    try {
      const minDeal = d?.minDealSize || 0.1;
      const minStop = d?.minStopDist || 1;
      const stopDist = Math.max(signal.stopPoints, minStop);
      let   stake    = calcStake(MAX_RISK_GBP, stopDist, minDeal);

      // Per-position sizing on top of the flat risk figure above — per
      // explicit request ("i want the bot to decide per position"), not a
      // hand-picked floor. Same mechanism T212's ISA bot already uses
      // (quant.ts, built 2026-08-24): scales size toward what this specific
      // instance's own closed-trade history actually supports, and skips
      // outright once there's a real (30+ trade) sample showing a clear
      // negative edge. Neutral (1x) until 15+ closed trades exist — this
      // instance is too new for that yet, so it starts unchanged and adapts
      // as real results accumulate, not on a single trade's own confidence.
      const edge = edgeSizing(journalMode(mode), strategyKey(instance));
      if (edge.skip) { addLog(instance, mode, 'wait', epicName(epic), `Skipped — ${edge.reason}`); continue; }
      if (edge.multiplier !== 1) {
        addLog(instance, mode, 'info', epicName(epic), edge.reason);
        stake = Math.max(minDeal, Math.round(stake * edge.multiplier * 100) / 100);
      }

      // Minimum £/pt floor, conviction-scaled — this bot (mr:stocks:live),
      // not igStrategyBot.ts's mean_reversion_swing, turned out to be the one
      // actually placing these trades (confirmed live 2026-08-31: UnitedHealth/
      // NVIDIA/Netflix entries all logged under this file's own [mr:stocks:live]
      // tag). calcStake = risk ÷ stopDist, so a wide-ATR name (UnitedHealth's
      // real stop here is ~1460pt) eats most of the £20 risk budget into a
      // wider stop rather than a bigger stake — confirmed live this produced a
      // real 0.01/pt NVIDIA position, too small for even a real move to
      // matter. Scaled by signal.conviction (0-1, meanReversionStrategy.ts's
      // own mechanical RSI(2)-extremity + trend-strength score, not AI) rather
      // than a flat number — same reasoning and same 0.02-0.06 range as the
      // identical fix already deployed on igStrategyBot.ts's mean_reversion_swing.
      // Extended to fx/japan225 too, 2026-08-31, per explicit request — applies
      // to all three instances now rather than 'stocks' only. FX stops are
      // typically tight enough that calcStake already clears this floor
      // unaided most of the time (so it rarely changes anything there), but
      // japan225's single-index stop is wide in the same way a stock's is,
      // so the same reasoning applies there for real.
      //
      // Split by instance 2026-09-04 per explicit request: japan225 and
      // stocks should always get the larger £/pt (and so the larger margin
      // commitment), fx/other-index trades size off whatever margin is left
      // over. Raising ONLY the floor (not MAX_RISK_GBP itself, which stays
      // one shared risk-per-trade figure) is what actually controls this —
      // £/pt is what margin is computed from, not the risk target — and
      // since all three instances draw from the same account margin pool,
      // a genuinely bigger floor here means japan225/stocks commit more of
      // it up front; the existing margin-affordability fallback below
      // already shrinks fx's own sizing to fit whatever's left rather than
      // failing outright, giving exactly the "remaining margin" behaviour
      // asked for without needing new cross-instance coordination.
      {
        const isLargerMarginInstance = instance === 'stocks' || instance === 'japan225';
        const MIN_STAKE_LOW  = isLargerMarginInstance ? 0.04 : 0.02;
        const MIN_STAKE_HIGH = isLargerMarginInstance ? 0.10 : 0.06;
        // Rounded to 2dp — IG rejects a stake with more decimal places than
        // that (confirmed live: validation.number.too-many-decimal-places),
        // and the raw floating-point arithmetic above can produce something
        // like 0.039999999999999994 for what's meant to be a clean 0.04.
        const minStakePerPoint = Math.round((MIN_STAKE_LOW + Math.max(0, Math.min(signal.conviction, 1)) * (MIN_STAKE_HIGH - MIN_STAKE_LOW)) * 100) / 100;
        if (stake < minStakePerPoint) {
          addLog(instance, mode, 'info', epicName(epic),
            `Stake raised to the £${minStakePerPoint.toFixed(3)}/pt floor for this ${(signal.conviction * 100).toFixed(0)}%-conviction setup (was £${stake}/pt) — real max loss now £${(minStakePerPoint * stopDist).toFixed(2)}, above the £${MAX_RISK_GBP} risk target`);
          stake = minStakePerPoint;
        }

        // Same downstream safety check as igStrategyBot.ts's version — the
        // floor above overrides risk-proportional sizing, so without a cap
        // a genuinely extreme wide-stop name could produce a real loss many
        // multiples of the nominal target with no bound at all. Ceiling
        // scales with conviction (3x target at a routine setup, up to 6x at
        // maximum conviction) rather than a flat number, same as the ig-bot
        // version — skip rather than silently accept an outsized real risk.

        // Structural-floor risk scaling — same fix already proven in
        // igStrategyBot.ts for the identical problem: a wide-ATR-stop
        // instrument can push even the FLOOR stake's own real loss above the
        // flat £20 target's ceiling, which would then skip every single
        // setup on that instrument forever, not just an occasional
        // oversized one. Confirmed live 2026-09-01: Japan 225's ATR stop
        // (~2400pt) pushed the floor stake's real loss to ~£96 against a
        // flat-target 3x ceiling of £60 — skipped repeatedly with no way to
        // ever open. Scales the effective target used for the ceiling
        // (not the stake itself — the floor above already set that)
        // up to comfortably clear THIS trade's own structural minimum loss,
        // capped at 6x the base target so a genuinely extreme instrument
        // still can't balloon the ceiling without bound.
        let effectiveRiskGbp = MAX_RISK_GBP;
        const structuralMinLoss = minStakePerPoint * stopDist;
        if (structuralMinLoss > effectiveRiskGbp) {
          const scaledForFloor = Math.min(MAX_RISK_GBP * 6, structuralMinLoss * 1.15);
          if (scaledForFloor > effectiveRiskGbp) {
            effectiveRiskGbp = scaledForFloor;
            addLog(instance, mode, 'info', epicName(epic),
              `Risk target scaled to £${effectiveRiskGbp.toFixed(0)} for sizing purposes — this instrument's own stop/floor combination produces at least £${structuralMinLoss.toFixed(0)} real loss regardless of conviction`);
          }
        }

        const confidence  = signal.conviction * 100;
        const ceilingMult = 3 + Math.max(0, Math.min(confidence, 100) - 60) / 40 * 3;
        const actualMaxLoss = stake * stopDist;
        const lossCeiling   = effectiveRiskGbp * ceilingMult;
        if (actualMaxLoss > lossCeiling) {
          addLog(instance, mode, 'wait', epicName(epic),
            `Skipped — sizing works out to £${actualMaxLoss.toFixed(0)} max loss (stake £${stake}/pt × ${stopDist.toFixed(0)}pt stop), above the £${lossCeiling.toFixed(0)} ceiling (${ceilingMult.toFixed(1)}× target)`);
          continue;
        }
      }

      // IG's own live quote, not the free-source bar close — the latter can
      // be on a completely different scale for FX/shares (IG points-scales
      // these, Yahoo doesn't), which would make this margin estimate
      // nonsense. See yahooFetch.ts's own extensive comments on this exact
      // mismatch.
      const igLevel = signal.action === 'BUY' ? d?.offer : d?.bid;
      if (d?.marginFactorPct !== undefined && typeof igLevel === 'number') {
        const { available } = await fetchAccountFunds(session);
        const requiredMargin = stake * igLevel * (d.marginFactorPct / 100);
        if (requiredMargin > available) {
          // Scale the stake down to whatever margin is actually available,
          // rather than skipping outright — per explicit request 2026-09-03
          // ("find an optimal solution to allow japan225 positions to open
          // at least occasionally"). This account's live balance is shared
          // across several bots running concurrently (mean-reversion
          // stocks/fx, ig-bot's own account-wide watchlist) all drawing on
          // the same margin pool, so the conviction-scaled "ideal" stake
          // genuinely often doesn't fit — confirmed live: Japan225 skipped
          // twice in a row needing £161/£129 margin against only £35/£106
          // available. Waiting for the full ideal size to become affordable
          // could mean this rarely or never opens at all on a tight shared
          // pool. Opening smaller still gets its own real stop/TP and the
          // same reversal-exit management as a full-size position — smaller
          // real risk, not no protection. 5% haircut below the literal
          // available figure so this doesn't shave so close that a normal
          // price tick between the check and the actual order still fails.
          const affordableStake = Math.floor((available * 0.95 / (igLevel * (d.marginFactorPct / 100))) * 100) / 100;
          if (affordableStake < minDeal) {
            addLog(instance, mode, 'wait', epicName(epic), `Skipped — needs £${requiredMargin.toFixed(0)} margin, only £${available.toFixed(0)} available (even the minimum size doesn't fit)`);
            continue;
          }
          addLog(instance, mode, 'info', epicName(epic), `Stake reduced to £${affordableStake}/pt to fit available margin (was £${stake}/pt needing £${requiredMargin.toFixed(0)}, only £${available.toFixed(0)} available)`);
          stake = affordableStake;
        }
      }

      // wantGuaranteedStop=false — confirmed live 2026-08-28 that requesting
      // a guaranteed stop on FX (EUR/USD, GBP/USD) came back ACCEPTED with
      // no rejection logged anywhere, yet the resulting live position showed
      // controlledRisk:false and stopLevel:null — genuinely naked, not the
      // already-known ~71s reporting-lag quirk (this didn't resolve after
      // several minutes). Real stock entries (TSLA/XOM/BP) that fell back to
      // a NORMAL stop in the same session came back with a real, populated
      // stopLevel every time — that path is the one actually verified
      // working here, so this uses it directly rather than routing through
      // a guaranteed-stop attempt with an unexplained silent-failure mode.
      // Worth real investigation later; not blocking this bot on it now.
      const result = await placeMarketOrder(session, epic, signal.action, stake, stopDist, signal.tpPoints, 'GBP', false);
      s.tracked[epic] = { dealId: result.dealId, epic, direction: signal.action, entryLevel: result.level, size: stake, enteredAt: Date.now() };
      saveTracked(instance, mode, s.tracked);
      s.lastEntryDay[epic] = new Date().toISOString().slice(0, 10);
      saveLastEntryDay(instance, mode, s.lastEntryDay);
      // No longer auto-exempted from geminiWatch as of 2026-09-03 — this
      // used to protect a position from free-form AI judgment that could
      // flip-flop (Exxon/Silver), but that free-form judgment doesn't exist
      // on that path any more: geminiWatch.ts now does nothing at all on a
      // loss (mechanical stop only, same protection this exemption used to
      // give) and a deterministic momentum-based lock-in on a gain — the
      // exact mechanism explicitly requested for these positions too. Per
      // explicit request/catch: this bot's own positions (confirmed live as
      // the one actually placing trades, Meta's EMA-trend entry included)
      // were silently skipping that entire new mechanism via this old
      // auto-exemption. The manual per-position toggle (markNoAiClose/
      // unmarkNoAiClose, exposed in the UI) still exists for anyone who
      // wants to opt a specific position out.
      recordJournalEvent({
        mode: journalMode(mode), event: 'entry', symbol: epicName(epic), strategy: strategyKey(instance),
        side: signal.action === 'BUY' ? 'long' : 'short', qty: stake, price: result.level, reason: signal.reason,
      });
      addLog(instance, mode, 'enter', epicName(epic), `${signal.action} @ ${result.level.toFixed(2)} · stake ${stake}/pt · stop ${stopDist.toFixed(1)}pt TP ${signal.tpPoints.toFixed(1)}pt${result.guaranteedStop ? ' (guaranteed)' : ''} — ${signal.reason}`);
      if (!result.protectionOk) addLog(instance, mode, 'error', epicName(epic), `UNPROTECTED — stop/TP attach failed: ${result.protectionError ?? 'unknown'}`);
      slotsLeft--;
    } catch (e) {
      addLog(instance, mode, 'error', epicName(epic), `Order failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// How much longer than the normal cadence counts as "this bot was actually
// down/delayed" rather than just ordinary jitter (a slightly slow API call,
// a few seconds of drift). 3x the normal interval means at least two full
// cycles were missed outright — not a borderline judgment call.
const STALE_GAP_MULTIPLE = 3;

async function poll(instance: MrInstance, mode: IgMode): Promise<void> {
  const s = ms(instance, mode);
  if (!s.running) return;
  // Added 2026-09-03 per explicit request, after a real outage (IG's API
  // allowance got exhausted from a stretch of restarts) — when a bot comes
  // back after a gap, this decides whether it's still safe to trust
  // whatever signal it now sees. A crossover/breakout signal is recomputed
  // fresh every poll (this file never persists a queue of "things to still
  // do" — there's nothing to "replay"), but that freshness guarantee breaks
  // down after a long gap: today's price may have moved a lot further
  // during the outage than a normal 15-min cycle would ever see, so the
  // signal this poll finds could really be several hours stale even though
  // it's being read live right now. Rather than trust it immediately, this
  // cycle only runs manageExits (existing positions stay fully protected,
  // no delay there) and skips scanEntries entirely — the NEXT cycle, back
  // on normal cadence with a confirmed-current picture, is what actually
  // gets to act on it. Not a queue-and-replay-later — the opposite: forget
  // whatever might have applied during the gap and require it to still look
  // right on a fresh, undelayed read before anything opens.
  const previousPollTs = s.lastPollTs;
  const gapMs = previousPollTs ? Date.now() - new Date(previousPollTs).getTime() : 0;
  const recoveringFromGap = gapMs > POLL_MS * STALE_GAP_MULTIPLE;
  s.lastPollTs = new Date().toISOString();

  // Mixed FX/index/stock universe (see INSTANCE_EPICS above) — same quiet
  // window the Alpaca scanner uses (Sat all day through Sun 22:00 UTC),
  // rather than the NYSE-only Monday-open boundary, since fx/japan225 both
  // reopen before Monday. Ungated, this hourly loop would still re-auth IG,
  // fetch positions, and run the AI safety check all weekend for nothing.
  if (isScannerQuietWeekend()) {
    addLog(instance, mode, 'info', '—', 'Weekend — markets closed, skipping poll');
  } else {
    try {
      const session = await getOrAuthSession(mode);
      if (!session) { addLog(instance, mode, 'error', '—', 'No IG session — check credentials'); }
      else {
        s.session = session;
        const positions = await fetchFullPositions(session);
        await manageExits(instance, mode, session, positions);
        if (recoveringFromGap) {
          addLog(instance, mode, 'info', '—', `Back after a ${(gapMs / 60_000).toFixed(0)}min gap (normal cadence is ${(POLL_MS / 60_000).toFixed(0)}min) — skipping new entries this cycle so nothing fires on a stale signal; will scan fresh next cycle`);
        } else {
          const stillOpen = await fetchFullPositions(session); // re-fetch — manageExits may have closed some
          await scanEntries(instance, mode, session, stillOpen);
        }
      }
    } catch (e) {
      addLog(instance, mode, 'error', '—', `Poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (s.running) {
    const delayMs = isScannerQuietWeekend() ? msUntilWeekendReopen() : POLL_MS;
    s.nextRunMs = Date.now() + delayMs;
    s.pollTimer = setTimeout(() => { void poll(instance, mode); }, delayMs);
  }
}

export function startMeanReversionBot(instance: MrInstance, mode: IgMode): { ok: boolean; error?: string } {
  const creds = resolveCredentials(mode);
  if (!creds.apiKey) return { ok: false, error: `IG ${mode} credentials not configured` };
  const s = ms(instance, mode);
  if (s.pollTimer) clearTimeout(s.pollTimer);
  s.running = true;
  saveRunningFlag(instance, mode, true);
  const signalDesc = INTRADAY_INSTANCES.has(instance) ? 'Donchian breakout (30-min, intraday)'
    : EMA_TREND_INSTANCES.has(instance) ? 'EMA9/21 crossover trend-follow' : 'RSI(2)+EMA200 mean-reversion';
  addLog(instance, mode, 'info', '—', `Mean-reversion bot (${instance}) started — ${signalDesc}, rules-only${AI_MONITORED[instance] ? ' + daily AI safety check on open positions' : ', no AI at all'} — £${MAX_RISK_GBP} risk/trade, max ${MAX_POSITIONS} positions, ${INSTANCE_EPICS[instance].length} epic(s) watched`);
  void poll(instance, mode);
  return { ok: true };
}

export function stopMeanReversionBot(instance: MrInstance, mode: IgMode): { ok: boolean } {
  const s = ms(instance, mode);
  s.running = false;
  saveRunningFlag(instance, mode, false);
  if (s.pollTimer) { clearTimeout(s.pollTimer); s.pollTimer = null; }
  addLog(instance, mode, 'info', '—', `Mean-reversion bot (${instance}) stopped`);
  return { ok: true };
}

export async function getMeanReversionBotStatus(instance: MrInstance, mode: IgMode): Promise<{
  running: boolean; aiMonitored: boolean; epics: string[]; log: LogEntry[];
  nextRunMs: number | null; lastPollTs: string | null;
  tracked: Record<string, Tracked>; positions?: FullPosition[];
}> {
  const s = ms(instance, mode);
  let positions: FullPosition[] | undefined;
  if (s.session) { try { positions = await fetchFullPositions(s.session); } catch { /* best-effort */ } }
  return {
    running: s.running, aiMonitored: AI_MONITORED[instance], epics: INSTANCE_EPICS[instance],
    log: s.log, nextRunMs: s.nextRunMs, lastPollTs: s.lastPollTs, tracked: s.tracked, positions,
  };
}

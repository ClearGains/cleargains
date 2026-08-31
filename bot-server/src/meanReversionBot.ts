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
import { getMeanReversionSignal, type MrBar, MAX_HOLD_DAYS } from './meanReversionStrategy';
import { epicName } from './igStrategyScanner';
import { resolveCredentials, calcStake, type IgMode } from './igStrategyBot';
import { recordJournalEvent, type JournalMode } from './tradeJournal';
import { askMrSafety } from './openai';
import { fetchAllHeadlines } from './newsFetch';
import { EPIC_TO_ALPACA, fetchBarsWithFallback } from './yahooFetch';
import { isScannerQuietWeekend, msUntilWeekendReopen, type AlpacaBar } from './alpacaApi';
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
  stocks: [
    'UA.D.AAPL.CASH.IP', 'UC.D.MSFT.DAILY.IP', 'UC.D.NVDA.DAILY.IP', 'UA.D.AMZN.CASH.IP',
    'UB.D.GOOGL.DAILY.IP', 'UB.D.FB.DAILY.IP', 'UD.D.TSLA.DAILY.IP', 'UC.D.NFLX.DAILY.IP',
    'SD.D.JPM.DAILY.IP', 'SH.D.VUS.DAILY.IP', 'SH.D.UNH.DAILY.IP', 'SH.D.XOM.DAILY.IP',
    'SA.D.AMD.DAILY.IP', 'UA.D.AVGO.DAILY.IP', 'UB.D.INTC.DAILY.IP', 'UC.D.QCOM.DAILY.IP',
    'UC.D.MU.DAILY.IP', 'SG.D.TSM.DAILY.IP', 'SC.D.F.DAILY.IP',
    'KA.D.BARC.DAILY.IP', 'KA.D.BP.DAILY.IP', 'KA.D.HSBA.DAILY.IP', 'KA.D.AZN.DAILY.IP',
    'SD.D.JNJ.DAILY.IP', 'SE.D.PFE.DAILY.IP', 'SD.D.LLY.DAILY.IP',
  ],
  japan225: ['IX.D.NIKKEI.DAILY.IP'],
};

const AI_MONITORED: Record<MrInstance, boolean> = { fx: false, stocks: true, japan225: false };

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
    s = { running: false, session: null, tracked: loadTracked(instance, mode), log: [], pollTimer: null, nextRunMs: null, lastPollTs: null };
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
function strategyKey(instance: MrInstance): string { return `mean_reversion_${instance}`; }

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
// close code ever running (a real stop/take-profit hit at the broker) — same
// pattern as igStrategyBot.ts's journalSilentCloses, since a fixed ATR-based
// stop/TP means MOST exits here happen exactly this way, not via any code in
// this file deciding to close.
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
      reason: 'Closed by broker-side stop/take-profit (real ATR-based level hit)',
      plUsd, plPct: notional > 0 ? (plUsd / notional) * 100 : 0,
    });
    addLog(instance, mode, 'exit', name, `Stop/TP hit — £${plUsd.toFixed(2)} (${tr.entryLevel.toFixed(2)} → ${(match?.closeLevel ?? tr.entryLevel).toFixed(2)})`);
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

  for (const epic of INSTANCE_EPICS[instance]) {
    if (slotsLeft <= 0) break;
    if (s.tracked[epic] || openEpics.has(epic)) continue; // already have a position here — including one this bot doesn't own, to avoid doubling up on the same instrument

    // Market details fetched BEFORE the bars — needed not just for sizing
    // but to rescale non-share bars to IG's own points level (see below).
    let d;
    try { d = (await fetchMarketDetails(session, [epic])).get(epic); }
    catch (e) { addLog(instance, mode, 'error', epicName(epic), `Market details failed: ${e instanceof Error ? e.message : String(e)}`); continue; }
    const igMid = typeof d?.bid === 'number' && typeof d?.offer === 'number' ? (d.bid + d.offer) / 2 : undefined;

    let bars: MrBar[];
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
      const raw = await fetchBarsWithFallback(epic, '2y', {
        alpacaTimeframe: '1Day', yahooInterval: '1d',
        liveReferenceLevel: !isAlpacaCovered ? igMid : undefined,
      });
      if (!raw?.length) continue;
      bars = toMrBars(raw);
    } catch (e) {
      addLog(instance, mode, 'error', epicName(epic), `Candle fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const signal = getMeanReversionSignal(bars);
    if (signal.action === 'HOLD') continue;

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
      // uniformly to all three instances now rather than 'stocks' only. FX
      // stops are typically tight enough that calcStake already clears this
      // floor unaided most of the time (so it rarely changes anything there),
      // but japan225's single-index stop is wide in the same way a stock's is,
      // so the same reasoning applies there for real.
      {
        const MIN_STAKE_LOW = 0.02, MIN_STAKE_HIGH = 0.06;
        const minStakePerPoint = MIN_STAKE_LOW + Math.max(0, Math.min(signal.conviction, 1)) * (MIN_STAKE_HIGH - MIN_STAKE_LOW);
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
        const confidence  = signal.conviction * 100;
        const ceilingMult = 3 + Math.max(0, Math.min(confidence, 100) - 60) / 40 * 3;
        const actualMaxLoss = stake * stopDist;
        const lossCeiling   = MAX_RISK_GBP * ceilingMult;
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
          addLog(instance, mode, 'wait', epicName(epic), `Skipped — needs £${requiredMargin.toFixed(0)} margin, only £${available.toFixed(0)} available`);
          continue;
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
      // Exempt from ig-bot's discretionary AI watch — see markNoAiClose's own
      // comment. This position's own stop/TP above is the only exit that
      // should touch it (plus the 'stocks' instance's own severe-news check,
      // a separate mechanism from geminiWatch entirely). Dynamic import
      // avoids a circular dependency (geminiWatch imports from igStrategyBot,
      // which this file also imports from).
      try { const { markNoAiClose } = await import('./geminiWatch'); markNoAiClose(mode, result.dealId); } catch {}
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

async function poll(instance: MrInstance, mode: IgMode): Promise<void> {
  const s = ms(instance, mode);
  if (!s.running) return;
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
        const stillOpen = await fetchFullPositions(session); // re-fetch — manageExits may have closed some
        await scanEntries(instance, mode, session, stillOpen);
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
  addLog(instance, mode, 'info', '—', `Mean-reversion bot (${instance}) started — RSI(2)+EMA200, rules-only${AI_MONITORED[instance] ? ' + daily AI safety check on open positions' : ', no AI at all'} — £${MAX_RISK_GBP} risk/trade, max ${MAX_POSITIONS} positions, ${INSTANCE_EPICS[instance].length} epic(s) watched`);
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

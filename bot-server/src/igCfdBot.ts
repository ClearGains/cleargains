import * as fs from 'fs';
import * as path from 'path';
import {
  authenticateOAuth, refreshOAuthSession, logoutOAuth,
  fetchFullPositions, fetchAccountFunds, fetchMarketDetails,
  placeMarketOrder, closePosition,
  type IGOAuthSession,
} from './igOAuthApi';
import {
  rsiMeanReversionSignal, emaCrossoverSignal, vwapSignal, donchianBreakoutSignal, macdCrossoverSignal, pivotPointsSignal,
  ruleBasedAnalysisSignal,
  STRATEGY_META, type StrategyName, type StrategySignal,
} from './alpacaStrategies';
import { fetchBarsWithFallback } from './yahooFetch';
import type { Timeframe } from './alpacaApi';
import { resolveCredentials, type IgMode } from './igStrategyBot';
import { IG_EPICS, FX_EPICS, isIndexEpic, RULE_BASED_ANALYSIS_CONFIRMED_EPICS } from './igStrategyScanner';

// ── Persistent, server-side IG CFD bot ──────────────────────────────────────
// Distinct from components/ig/IGCfdAutoTrader.tsx (the browser-resident
// version — same account/product type, deliberately stops when its tab
// closes). This one runs on the VM via PM2 like every other persistent bot
// here, 24/7 regardless of any browser being open.
//
// Uses igOAuthApi.ts (OAuth, Version 3) rather than igApi.ts's legacy
// CST/X-SECURITY-TOKEN session — verified live before this was built that a
// legacy session (what igStrategyBot.ts/fxScalperBot.ts and Lightstreamer
// already depend on) and an OAuth session on the same account coexist
// without colliding, so this runs as a genuinely independent login,
// concurrently with those, rather than needing to share their session or
// risk IG's real "second concurrent session" rejection.
//
// Rules-only — no Gemini call site, matching the original scope decision
// for the browser CFD bot this mirrors (save AI calls until explicitly
// asked to add them). Reuses the same broker-agnostic strategy functions
// from alpacaStrategies.ts every other bot here already uses.
//
// Bars come from free Yahoo/Alpaca data (fetchBarsWithFallback, same as
// every other bot here) rather than IG's own allowance-limited candle API.
// Only live prices (via fetchMarketDetails, not allowance-limited) and
// order execution itself touch IG directly.

export type CfdMode = IgMode;

export type CfdLogEntry = {
  id:   string;
  ts:   string;
  type: 'info' | 'enter' | 'exit' | 'hold' | 'wait' | 'error';
  epic: string;
  msg:  string;
};

// CFD trading here is primarily about stocks. IG_EPICS (igStrategyScanner.ts,
// shared with the spread-bet bots) was originally reused as-is on the
// assumption share epics aren't account-type exclusive — that assumption
// was WRONG for most names and was caught live via a real demo stress test:
// every order on a ".DAILY.IP" epic (IG_EPICS' convention for most stocks,
// correct for spread betting) came back "Deal REJECTED: UNKNOWN" from the
// CFD account, even though /markets/{epic} deceptively reports that same
// epic as TRADEABLE with valid dealing rules under the CFD account. IG
// actually runs a separate, genuinely CFD-dealable ".CASH.IP" product for
// most of these names — confirmed live with a real order+close on every
// entry below (only Apple/Amazon/Applied Materials already used .CASH.IP
// in IG_EPICS and needed no change). A handful of names (JPMorgan, Visa,
// UnitedHealth, ExxonMobil, TSMC, Dell) have no CFD-dealable share product
// on this account at all — searched IG directly, nothing but leveraged
// ETPs/options came back — so they're excluded here entirely rather than
// silently failing every cycle; they still trade fine on the spread-bet bot.
// UK names (Barclays/BP/HSBC/Shell/GSK/AstraZeneca/Lloyds, BlackBerry,
// Nokia) got a clean MARKET_CLOSED_WITH_EDITS/MARKET_OFFLINE rejection
// during the verification pass (run outside their home exchange's hours) —
// that's a legitimate, informative rejection reason, unlike the generic
// UNKNOWN from a wrong epic, so treat these as verified-correct even though
// the live test itself couldn't get to ACCEPTED at that hour.
const CFD_STOCK_EPIC_OVERRIDES: Record<string, string> = {
  'UC.D.MSFT.DAILY.IP':   'UC.D.MSFT.CASH.IP',
  'UC.D.NVDA.DAILY.IP':   'UC.D.NVDA.CASH.IP',
  'UB.D.GOOGL.DAILY.IP':  'UB.D.GOOGL.CASH.IP',
  'UB.D.FB.DAILY.IP':     'UB.D.FB.CASH.IP',
  'UD.D.TSLA.DAILY.IP':   'UD.D.TSLA.CASH.IP',
  'UC.D.NFLX.DAILY.IP':   'UC.D.NFLX.CASH.IP',
  'SA.D.AMD.DAILY.IP':    'SA.D.AMD.CASH.IP',
  'UA.D.AVGO.DAILY.IP':   'UA.D.AVGO.CASH.IP',
  'UB.D.INTC.DAILY.IP':   'UB.D.INTC.CASH.IP',
  'UC.D.QCOM.DAILY.IP':   'UC.D.QCOM.CASH.IP',
  'UC.D.MU.DAILY.IP':     'UC.D.MU.CASH.IP',
  'UD.D.SNDKUS.DAILY.IP': 'UD.D.SNDKUS.CASH.IP',
  'UD.D.STX.DAILY.IP':    'UD.D.STX.CASH.IP',
  'UC.D.MRVL.DAILY.IP':   'UC.D.MRVL.CASH.IP',
  'UD.D.WDC.DAILY.IP':    'UD.D.WDC.CASH.IP',
  'UC.D.RIMM.DAILY.IP':   'UC.D.RIMM.CASH.IP',
  'EC.D.NOKIAFP.DAILY.IP': 'EC.D.NOKIAFP.CASH.IP',
  'KA.D.BARC.DAILY.IP':   'KA.D.BARC.CASH.IP',
  'KA.D.BP.DAILY.IP':     'KA.D.BP.CASH.IP',
  'KA.D.HSBA.DAILY.IP':   'KA.D.HSBA.CASH.IP',
  'KA.D.SHELLN.DAILY.IP': 'KA.D.SHELLN.CASH.IP',
  'KA.D.GSK.DAILY.IP':    'KA.D.GSK.CASH.IP',
  'KA.D.AZN.DAILY.IP':    'KA.D.AZN.CASH.IP',
  'KA.D.LLOY.DAILY.IP':   'KA.D.LLOY.CASH.IP',
};
// No CFD-dealable share product exists for these on this account (verified
// via a live IG market search — only leveraged ETPs/options came back).
const CFD_UNAVAILABLE_EPICS = new Set([
  'SD.D.JPM.DAILY.IP',    // JPMorgan
  'SH.D.VUS.DAILY.IP',    // Visa
  'SH.D.UNH.DAILY.IP',    // UnitedHealth
  'SH.D.XOM.DAILY.IP',    // ExxonMobil
  'SG.D.TSM.DAILY.IP',    // TSMC
  'SB.D.DELLUS.DAILY.IP', // Dell
  // Not "unavailable" on IG's side — the real product (SK hynix Inc - ADR,
  // USD) is fine. Excluded because this bot's free-data fallback for it
  // (000660.KS, the KRW-priced Korea Exchange primary listing — no Alpaca
  // coverage, no USD ADR ticker on Yahoo either) is a genuinely different
  // instrument in a different currency, not just a different scale.
  // igStrategyBot.ts can safely use the same Yahoo data because it always
  // fetches IG's live price first and passes it as a rescale reference;
  // this bot fetches bars before it ever touches IG's live price, so it
  // has no reference level to rescale against. Fixing that would mean an
  // extra IG API call every poll cycle for every instrument just to cover
  // this one name — not worth it for a single stock. Simpler to exclude.
  'UD.D.SKHYUS.DAILY.IP', // SK Hynix
]);

type CfdInstrument = { name: string; epic: string };
const STOCK_INSTRUMENTS: CfdInstrument[] = IG_EPICS
  .filter(e => !FX_EPICS.has(e.epic) && !isIndexEpic(e.epic) && !CFD_UNAVAILABLE_EPICS.has(e.epic))
  .map(e => ({ name: e.name, epic: CFD_STOCK_EPIC_OVERRIDES[e.epic] ?? e.epic }));

const INSTRUMENTS: CfdInstrument[] = [
  { name: 'FTSE 100', epic: 'IX.D.FTSE.CFD.IP' },
  { name: 'GBP/USD',  epic: 'CS.D.GBPUSD.CFD.IP' },
  { name: 'Applied Materials', epic: 'UA.D.AMAT.CASH.IP' },
  ...STOCK_INSTRUMENTS,
];

// Free-data fetch params per strategy's own barPeriod (STRATEGY_META) —
// matches FREE_DATA_PARAMS's equivalent mapping in igStrategyBot.ts.
// Getting this wrong is silent and easy to miss: rsi_mean_reversion reads
// as "supported" either way, just quietly evaluated on the wrong-resolution
// bars (its own RSI/MACD math tuned for 5-min bars) if this isn't mapped
// per-strategy correctly.
const FREE_DATA_PARAMS: Partial<Record<StrategyName, { range: string; alpacaTimeframe: Timeframe; yahooInterval: '1m' | '5m' | '1h' | '1d' }>> = {
  rsi_mean_reversion: { range: '1mo', alpacaTimeframe: '5Min', yahooInterval: '5m' },
  vwap:               { range: '5d',  alpacaTimeframe: '1Min', yahooInterval: '1m' },
  donchian_hourly:    { range: '1mo', alpacaTimeframe: '1Hour', yahooInterval: '1h' },
  ema_crossover:       { range: '6mo', alpacaTimeframe: '1Day', yahooInterval: '1d' },
  donchian_breakout:   { range: '6mo', alpacaTimeframe: '1Day', yahooInterval: '1d' },
  macd_crossover:      { range: '6mo', alpacaTimeframe: '1Day', yahooInterval: '1d' },
  pivot_points:        { range: '6mo', alpacaTimeframe: '1Day', yahooInterval: '1d' },
  // Needs ~250 daily bars for its SMA200 trend filter — every other daily
  // strategy's 6mo (~126 trading days) isn't enough. See STRATEGY_META.rule_based_analysis.
  rule_based_analysis: { range: '2y', alpacaTimeframe: '1Day', yahooInterval: '1d' },
};

export type CfdStartParams = {
  strategy?:     StrategyName;
  maxRiskGbp?:   number;
  maxPositions?: number;
  allowShorts?:  boolean;
};

export type CfdPositionStatus = {
  dealId: string; epic: string; instrumentName: string;
  direction: 'BUY' | 'SELL'; size: number; level: number; upl: number;
  estimated?: boolean;  // upl computed from free Yahoo/Alpaca data, not IG's own live quote — IG had no bid/offer (market closed) when this was fetched
};

export type CfdStatus = {
  mode:         CfdMode;
  running:      boolean;
  paused:       boolean;
  strategy:     StrategyName;
  maxRiskGbp:   number;
  maxPositions: number;
  allowShorts:  boolean;
  balance:      number;
  available:    number;
  positions:    CfdPositionStatus[];
  log:          CfdLogEntry[];
  sessionOk:    boolean;
  nextRunMs:    number | null;
  lastPollTs:   string | null;
};

export type CfdHandle = {
  start:         (params: CfdStartParams) => Promise<{ ok: boolean; error?: string }>;
  stop:          () => void;
  pause:         () => void;
  resume:        () => void;
  status:        () => CfdStatus;
  closePosition: (dealId: string) => Promise<{ ok: boolean; error?: string }>;
};

// ── Constants ────────────────────────────────────────────────────────────────

const SEVERE_LOSS_MULT = 5;
const PROFIT_LOCK_MULT = 1.5;
const TOKEN_REFRESH_MS = 20 * 60_000; // access tokens last 30min (confirmed live) — refresh with headroom
// The per-trade severe-loss ceiling only limits a single position's own
// loss — it says nothing about how much of the account's total margin is
// still free. A run of several leveraged positions can each individually
// stay under that ceiling while collectively leaving the account one bad
// print away from a margin call. Block new entries once available margin
// drops below this fraction of balance, regardless of any single
// position's own P&L — this is the actual leverage-blowup guard, not the
// per-trade loss cap.
const MARGIN_BUFFER_MIN_PCT = 0.15;

// User call (2026-08-15): give this bot a genuine break every weekend
// instead of scanning the whole universe every cycle for two straight days
// — during Sat/Sun almost every entry attempt was getting rejected anyway
// (real exchanges and most "24 Hours" CFD share products aren't reliably
// dealable then), which was just burning IG's API allowance and filling
// the log with noise for nothing. Quiet window is Saturday through Sunday,
// resuming Monday 00:00 UTC — position management (severe-loss/profit-lock
// on anything already open) stays active throughout; only new-entry
// scanning pauses. Different boundary than alpacaApi.ts's
// isScannerQuietWeekend() (Sunday 22:00 UTC) — that one's tuned for the
// live spread-bet bot; this is what was actually asked for here.
function isCfdQuietWeekend(): boolean {
  const day = new Date().getUTCDay(); // 0=Sun, 6=Sat
  return day === 6 || day === 0;
}

function uid(): string { return Math.random().toString(36).slice(2, 9); }
function ts(): string { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }
function epicName(epic: string): string { return epic.split('.').slice(0, 3).join('.'); }

// ── Persistence ──────────────────────────────────────────────────────────────

type PersistedParams = { strategy: StrategyName; maxRiskGbp: number; maxPositions: number; allowShorts: boolean };

function stateFile(mode: CfdMode): string { return path.join(__dirname, '..', `ig-cfd-state-${mode}.json`); }
function saveStartState(mode: CfdMode, params: PersistedParams): void {
  try { fs.writeFileSync(stateFile(mode), JSON.stringify(params), 'utf8'); } catch {}
}
function clearStartState(mode: CfdMode): void {
  try { fs.unlinkSync(stateFile(mode)); } catch {}
}
export function loadSavedCfdState(mode: CfdMode): PersistedParams | null {
  try { return JSON.parse(fs.readFileSync(stateFile(mode), 'utf8')) as PersistedParams; } catch { return null; }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createIgCfdBot(mode: CfdMode): CfdHandle {
  const tag = `ig-cfd:${mode}`;

  let session:      IGOAuthSession | null = null;
  let running       = false;
  let paused        = false;
  let strategy:     StrategyName = 'donchian_breakout';
  let maxRiskGbp    = 10;
  let maxPositions  = 3;
  let allowShorts   = true;
  let lastKnownBalance = 0, lastKnownAvailable = 0;
  let weekendNoticeLogged = false;
  let lastKnownPositions: CfdPositionStatus[] = [];
  const log: CfdLogEntry[] = [];
  // Some names in the shared spread-bet epic list aren't entitled for CFD
  // dealing on this account (IG returns 403 insufficient view permissions)
  // — that's a permanent per-account condition, not a transient error, so
  // skip them for the rest of this run instead of re-erroring every cycle.
  const permissionBlockedEpics = new Set<string>();

  let pollTimer:    ReturnType<typeof setInterval> | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let lastPollTs: string | null = null;
  let nextRunMs:  number | null = null;

  function addLog(type: CfdLogEntry['type'], epic: string, msg: string): void {
    const entry: CfdLogEntry = { id: uid(), ts: ts(), type, epic, msg };
    log.unshift(entry);
    if (log.length > 300) log.splice(300);
    console[type === 'error' ? 'error' : 'log'](`[${tag}] [${type.toUpperCase()}] [${epic}] ${msg}`);
  }

  async function doTokenRefresh(): Promise<void> {
    if (!session) return;
    try {
      session = await refreshOAuthSession(session);
    } catch (e) {
      addLog('error', '—', `Token refresh failed: ${e instanceof Error ? e.message : String(e)} — session may drop soon`);
    }
  }

  async function evaluateOne(inst: CfdInstrument, currentPositions: CfdPositionStatus[], openCount: number): Promise<void> {
    if (!session) return;
    const name = epicName(inst.epic);
    const held = currentPositions.find(p => p.epic === inst.epic);
    const inPosition = !!held;
    const side: 'long' | 'short' | undefined = held ? (held.direction === 'BUY' ? 'long' : 'short') : undefined;

    // rule_based_analysis: restrict new entries to only the instruments its
    // own backtest confirmed profitable (RULE_BASED_ANALYSIS_CONFIRMED_EPICS
    // in igStrategyScanner.ts) — this bot iterates its whole fixed
    // INSTRUMENTS list every cycle regardless of strategy, unlike
    // igStrategyBot.ts's dynamic scanner, so the restriction has to live
    // here instead. Doesn't affect managing anything already held (e.g. a
    // leftover position from a different strategy) — only blocks fresh
    // entries. No log line — silent skip, not worth spamming ~15 exclusions
    // every single poll cycle.
    if (!inPosition && strategy === 'rule_based_analysis' && !RULE_BASED_ANALYSIS_CONFIRMED_EPICS.has(inst.epic)) return;

    if (!inPosition && openCount >= maxPositions) {
      addLog('wait', name, `Max positions (${maxPositions}) reached`);
      return;
    }

    const freeParams = FREE_DATA_PARAMS[strategy] ?? { range: '6mo', alpacaTimeframe: '1Day' as Timeframe, yahooInterval: '1d' as const };
    const bars = await fetchBarsWithFallback(inst.epic, freeParams.range, { ...freeParams, rawShares: true });
    if (!bars?.length || bars.length < 20) { addLog('wait', name, 'Not enough bar data yet'); return; }
    const last = bars[bars.length - 1];

    let signal: StrategySignal;
    switch (strategy) {
      case 'rsi_mean_reversion': signal = rsiMeanReversionSignal(bars, inPosition, side); break;
      case 'ema_crossover':      signal = emaCrossoverSignal(bars, inPosition, side); break;
      case 'vwap':               signal = vwapSignal(bars, last.c, inPosition, side); break;
      case 'donchian_breakout':  signal = donchianBreakoutSignal(bars, inPosition, side); break;
      case 'donchian_hourly':    signal = donchianBreakoutSignal(bars, inPosition, side, 24, 12, 'hour'); break;
      case 'macd_crossover':     signal = macdCrossoverSignal(bars, inPosition, side); break;
      case 'pivot_points':       signal = pivotPointsSignal(bars, inPosition, side); break;
      case 'rule_based_analysis': signal = ruleBasedAnalysisSignal(bars, inPosition, side); break;
      default: signal = { action: 'HOLD', reason: 'unsupported strategy' };
    }

    if (signal.action === 'HOLD') { addLog('wait', name, signal.reason); return; }

    if ((signal.action === 'CLOSE_LONG' || signal.action === 'CLOSE_SHORT') && held) {
      addLog('exit', name, signal.reason);
      try {
        await closePosition(session, held.dealId, held.direction, held.size);
      } catch (e) { addLog('error', name, `Exit failed: ${e instanceof Error ? e.message : String(e)}`); }
      return;
    }

    if ((signal.action === 'BUY' || signal.action === 'SELL') && !inPosition) {
      if (paused) { addLog('wait', name, '⏸ Paused — skipping entry'); return; }
      if (signal.action === 'SELL' && !allowShorts) { addLog('wait', name, 'Shorts disabled'); return; }
      if (permissionBlockedEpics.has(inst.epic)) { addLog('wait', name, 'Not entitled for CFD dealing on this account — skipping'); return; }
      if (lastKnownBalance > 0 && lastKnownAvailable / lastKnownBalance < MARGIN_BUFFER_MIN_PCT) {
        addLog('wait', name, `⚠ Margin buffer low (${(lastKnownAvailable / lastKnownBalance * 100).toFixed(0)}% available) — skipping new entries until it recovers`);
        return;
      }

      let livePrice = last.c;
      let minDeal = 0.1, minStop = 1, marginFactorPct: number | undefined, currencyCode = 'GBP';
      try {
        const details = await fetchMarketDetails(session, [inst.epic]);
        const d = details.get(inst.epic);
        // `!== undefined` isn't enough — IG returns bid/offer as null (not
        // missing) when the market has no live quote right now, and
        // `null !== undefined` is true in JS. That let `(null + null) / 2`
        // silently evaluate to 0, wiping livePrice out entirely and making
        // every stop distance blow out to roughly the full price level
        // (|0 - signal.stopPrice| = signal.stopPrice) — confirmed live on
        // a real GSK entry: stop logged as 1870.48pt on an ~£1817 entry.
        // Same null-vs-undefined class of bug as the P&L fix earlier
        // tonight, just in the entry-sizing path instead of the display.
        if (typeof d?.bid === 'number' && typeof d?.offer === 'number') livePrice = (d.bid + d.offer) / 2;
        if (d) { minDeal = d.minDealSize; minStop = d.minStopDist; marginFactorPct = d.marginFactorPct; }
        if (d?.currencyCode) currencyCode = d.currencyCode;
        if (d?.marketStatus && d.marketStatus !== 'TRADEABLE') { addLog('wait', name, `Market not tradeable (${d.marketStatus})`); return; }
      } catch { /* fall back to last bar close + defaults */ }

      const stopDist = Math.max(signal.stopPrice ? Math.abs(livePrice - signal.stopPrice) : livePrice * 0.02, minStop);
      const profitDist = signal.takeProfitPrice ? Math.abs(livePrice - signal.takeProfitPrice) : undefined;

      // Margin-proportional risk target — CFDs are inherently leveraged
      // (marginFactorPct is the real fraction of notional exposure IG
      // actually requires as margin, e.g. 20% = 5x leverage), so sizing
      // purely off the flat maxRiskGbp badly under-uses that leverage on
      // higher-priced-per-point names — the minimum viable stake alone can
      // tie up far more margin than a small flat risk target ever reflects.
      // Same pattern already proven live in igStrategyBot.ts for spread
      // betting: scale the effective risk target up toward a fraction of
      // the margin the minimum stake ties up regardless, floored at the
      // user's own flat target and capped at 5x it so a single extreme
      // instrument can't balloon sizing without bound.
      const RISK_TO_MARGIN_RATIO = 0.15;
      let effectiveRiskGbp = maxRiskGbp;
      if (marginFactorPct !== undefined) {
        const minMargin = minDeal * livePrice * (marginFactorPct / 100);
        effectiveRiskGbp = Math.min(maxRiskGbp * 5, Math.max(maxRiskGbp, minMargin * RISK_TO_MARGIN_RATIO));
        if (effectiveRiskGbp > maxRiskGbp) {
          addLog('info', name, `Risk target scaled to £${effectiveRiskGbp.toFixed(0)} (from £${maxRiskGbp}) — minimum stake here ties up ~£${minMargin.toFixed(0)} margin regardless (${marginFactorPct}% factor)`);
        }
      }

      // Share CFDs (unlike FX/index CFDs) reject fractional deal sizes
      // outright — confirmed live tonight: every fractional-sized share
      // order (NVDA 73.96/59.17/40.68, Seagate 9.3-9.6, GSK 5.0-9.2, Netflix
      // 117-213) got REJECTED with the generic UNKNOWN, while every
      // whole-number size on the exact same instruments (size 1, and a
      // manual test ramping 1 through 70) succeeded. GBP/USD's fractional
      // 68.75 got a real, specific INSUFFICIENT_FUNDS instead — IG actually
      // validated that one, so FX/index CFDs genuinely do allow fractional
      // sizing; shares just don't, and round to whole numbers before
      // sending rather than silently producing an invalid order.
      const isShare = !FX_EPICS.has(inst.epic) && !isIndexEpic(inst.epic);
      const rawSize = Math.max(minDeal, effectiveRiskGbp / stopDist);
      const size = isShare ? Math.max(1, Math.round(rawSize)) : Math.round(rawSize * 100) / 100;

      addLog('enter', name, `${signal.action} — ${signal.reason} (size ${size}, stop ${stopDist.toFixed(2)}pt)`);
      try {
        const result = await placeMarketOrder(session, inst.epic, signal.action, size, stopDist, profitDist, currencyCode);
        addLog('info', name, `Deal confirmed @ ${result.level.toFixed(2)}${result.protectionOk ? '' : ' — ⚠ SL/TP attach failed: ' + (result.protectionError ?? 'unknown')}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('insufficient view permissions') || msg.includes('403')) permissionBlockedEpics.add(inst.epic);
        addLog('error', name, `Entry failed: ${msg}`);
      }
    }
  }

  async function pollCycle(): Promise<void> {
    if (!running || !session) return;
    lastPollTs = new Date().toISOString();
    try {
      const rawPositions = await fetchFullPositions(session);
      // IG reports no bid/offer (upl=0) whenever a market is currently
      // closed — true for every "24 Hours" CFD stock outside its real
      // exchange hours, which is most of the day for this bot's universe.
      // Rather than show a flat £0.00 that reads as "flat" when we simply
      // don't know, fall back to the same free Yahoo/Alpaca price this bot
      // already pulls for signal generation — same raw-dollar scale as IG's
      // own CFD share pricing (confirmed live, no ×100 conversion needed
      // here unlike the spread-bet bot). Marked `estimated: true` so the
      // UI can show it's not IG's own live tick.
      const positions: CfdPositionStatus[] = await Promise.all(rawPositions.map(async p => {
        if (p.hasLiveQuote) {
          return { dealId: p.dealId, epic: p.epic, instrumentName: p.instrumentName, direction: p.direction, size: p.size, level: p.level, upl: p.upl };
        }
        try {
          const fallbackBars = await fetchBarsWithFallback(p.epic, '5d', { alpacaTimeframe: '1Day', yahooInterval: '1d', rawShares: true });
          const lastClose = fallbackBars?.length ? fallbackBars[fallbackBars.length - 1].c : undefined;
          if (lastClose === undefined) throw new Error('no fallback price');
          const estimatedUpl = (p.direction === 'BUY' ? lastClose - p.level : p.level - lastClose) * p.size;
          return { dealId: p.dealId, epic: p.epic, instrumentName: p.instrumentName, direction: p.direction, size: p.size, level: p.level, upl: estimatedUpl, estimated: true };
        } catch {
          return { dealId: p.dealId, epic: p.epic, instrumentName: p.instrumentName, direction: p.direction, size: p.size, level: p.level, upl: 0 };
        }
      }));
      lastKnownPositions = positions;
      try {
        const funds = await fetchAccountFunds(session);
        lastKnownBalance = funds.balance;
        lastKnownAvailable = funds.available;
      } catch { /* keep last known values */ }

      const severeLossCeiling = maxRiskGbp * SEVERE_LOSS_MULT;
      const profitLockFloor   = maxRiskGbp * PROFIT_LOCK_MULT;
      for (const p of positions) {
        // Estimated (Yahoo/Alpaca-derived) P&L is for display only — never
        // auto-close off a number that isn't IG's own live quote. This is
        // deliberately conservative after tonight's exact failure mode: a
        // wrong/stale inferred P&L silently triggering these same guards.
        if (p.estimated) continue;
        if (p.upl <= -severeLossCeiling || p.upl >= profitLockFloor) {
          const reason = p.upl <= -severeLossCeiling ? `🚨 Severe loss £${p.upl.toFixed(2)}` : `💰 Profit lock £${p.upl.toFixed(2)}`;
          addLog('exit', epicName(p.epic), `${reason} — closing`);
          try { await closePosition(session, p.dealId, p.direction, p.size); }
          catch (e) { addLog('error', epicName(p.epic), `Close failed: ${e instanceof Error ? e.message : String(e)}`); }
        }
      }

      if (isCfdQuietWeekend()) {
        if (!weekendNoticeLogged) { addLog('wait', '—', '😴 Weekend — pausing new-entry scanning until Monday 00:00 UTC (open positions still managed)'); weekendNoticeLogged = true; }
      } else {
        weekendNoticeLogged = false;
        const openCount = positions.length;
        for (const inst of INSTRUMENTS) {
          if (!running) break;
          await evaluateOne(inst, positions, openCount);
          await new Promise(r => setTimeout(r, 300)); // light throttle across instruments
        }
      }
    } catch (e) {
      addLog('error', '—', `Poll cycle failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function start(params: CfdStartParams): Promise<{ ok: boolean; error?: string }> {
    stop();
    const creds = resolveCredentials(mode);
    if (!creds.apiKey || !creds.username || !creds.password) {
      const varPrefix = mode === 'live' ? 'IG_LIVE_' : 'IG_DEMO_';
      return { ok: false, error: `${varPrefix}API_KEY / USERNAME / PASSWORD env vars not set` };
    }

    strategy     = params.strategy     ?? 'donchian_breakout';
    maxRiskGbp   = params.maxRiskGbp   ?? 10;
    maxPositions = params.maxPositions ?? 3;
    allowShorts  = params.allowShorts  ?? true;

    try {
      session = await authenticateOAuth(creds.apiKey, creds.username, creds.password, creds.env, 'CFD');
      running = true;
      paused  = false;

      addLog('info', '—', `Started — ${strategy} on ${INSTRUMENTS.map(i => i.name).join(', ')} | £${maxRiskGbp} risk/trade | ${mode} CFD account (OAuth)`);

      const pollMs = STRATEGY_META[strategy].pollMs;
      void pollCycle();
      pollTimer    = setInterval(() => { void pollCycle(); }, pollMs);
      refreshTimer = setInterval(() => { void doTokenRefresh(); }, TOKEN_REFRESH_MS);
      nextRunMs = Date.now() + pollMs;

      saveStartState(mode, { strategy, maxRiskGbp, maxPositions, allowShorts });
      return { ok: true };
    } catch (e) {
      running = false;
      const msg = e instanceof Error ? e.message : String(e);
      addLog('error', '—', `Start failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  function stop(): void {
    running = false;
    paused  = false;
    if (pollTimer)    { clearInterval(pollTimer);    pollTimer    = null; }
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (session) { void logoutOAuth(session); session = null; }
    clearStartState(mode);
    if (log.length) addLog('info', '—', 'IG CFD bot stopped');
  }

  function pause(): void {
    if (!running) return;
    paused = true;
    addLog('info', '—', '⏸ Paused — monitoring open positions, no new entries');
  }

  function resume(): void {
    if (!running) return;
    paused = false;
    addLog('info', '—', '▶ Resumed — will enter on next qualifying signal');
  }

  function status(): CfdStatus {
    return {
      mode, running, paused, strategy, maxRiskGbp, maxPositions, allowShorts,
      balance: lastKnownBalance, available: lastKnownAvailable,
      positions: lastKnownPositions,
      log: log.slice(0, 100),
      sessionOk: !!session && Date.now() < session.expiresAt,
      nextRunMs, lastPollTs,
    };
  }

  async function closePositionByDealId(dealId: string): Promise<{ ok: boolean; error?: string }> {
    if (!session) return { ok: false, error: 'No active session — start the bot first' };
    // lastKnownPositions can be up to a poll cycle stale (e.g. an hour for
    // Donchian) — refetch live rather than trust it for a user-triggered
    // close, same discipline as everywhere else tonight.
    let held: CfdPositionStatus | undefined;
    try {
      const live = await fetchFullPositions(session);
      held = live.find(p => p.dealId === dealId);
    } catch (e) {
      return { ok: false, error: `Couldn't confirm current positions: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!held) return { ok: false, error: 'Position not found — it may already be closed' };
    try {
      await closePosition(session, dealId, held.direction, held.size);
      addLog('exit', epicName(held.epic), `Manually closed by user — ${held.direction} ${held.size} @ ${held.level}`);
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog('error', epicName(held.epic), `Manual close failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  return { start, stop, pause, resume, status, closePosition: closePositionByDealId };
}

// ── Singleton instances ───────────────────────────────────────────────────────
export const igCfdDemo = createIgCfdBot('demo');
export const igCfdLive = createIgCfdBot('live');

export function getIgCfdBot(mode: CfdMode): CfdHandle {
  return mode === 'live' ? igCfdLive : igCfdDemo;
}

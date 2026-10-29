// ── Opus portfolio manager ──────────────────────────────────────────────────
// Added 2026-10-21, per explicit request: Claude Opus 5.5 runs the trading on
// IG demo, Alpaca paper and (small) T212 live for a month — chooses what to
// trade, opens, monitors and closes positions as it sees fit, and may change
// its own approach (persistent notes + watchlist), capped at ~£120 of API
// spend for the month.
//
// Division of labour (each a deliberate rule from this account's history):
//   • Every number Opus sees — price, today's volume vs normal, trend, RSI,
//     ATR — is computed in CODE from Alpaca market data. The model never
//     estimates or judges volume itself (explicit request, 2026-10-21).
//   • Opus decides; code enforces hard limits it can't override (stops,
//     sizes, per-account caps, volume-in-direction, anti-churn, budget).
//   • Opus only manages positions it opened. Every other bot is told to
//     leave them alone (positionOwnership.ts for IG, alpacaBot's position
//     watch for Alpaca; T212's bots only ever manage their own entries).

import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import {
  getBars, getAccount, getPositions as getAlpacaPositions, placeOrder as alpacaPlaceOrder,
  closePosition as alpacaClosePosition, cancelOrdersForSymbol, getOrders as alpacaGetOrders, cancelOrder as alpacaCancelOrder, getFillsSince, getOptionChain, getOptionQuote, getOrder as alpacaGetOrder, type AlpacaBar,
} from './alpacaApi';
import { calcRsi, calcAtr, dailyVolumeRatio } from './alpacaStrategies';
import { fetchAllHeadlines } from './newsFetch';
import {
  authenticate, fetchFullPositions, fetchPositions, updatePositionLevels, fetchClosedTransactions, placeMarketOrder as igPlaceOrder, closePosition as igClosePosition,
  fetchMarketDetails, fetchAccountFunds, type IGSession,
} from './igApi';
import { resolveCredentials, calcStake } from './igStrategyBot';
import { EPIC_TO_ALPACA, fetchBarsWithFallback } from './yahooFetch';
import {
  getPortfolio, getCash, resolveT212Ticker, placeMarketOrder as t212PlaceOrder,
  placeStopLimitOrder, cancelOrder as t212CancelOrder,
} from './t212Api';
import { getGbpUsd } from './t212Bot';
import { runRuleBacktest, INDICATORS, type BacktestSpec } from './ruleBacktest';
import { getIgSentiment } from './igSentiment';
import { getCot } from './cot';
import { getOptionsFlow, describeFlow } from './optionsFlow';
import {
  buildConfirmStockTradePrompt, parseConfirmStockTradeResponse, buildIsaThesisPrompt, parseIsaThesisResponse,
  type StockConfirmSignal, type StockConfirmVerdict, type IsaThesisRequest, type IsaThesisVerdict,
} from './gemini';

// ── Config / state ──────────────────────────────────────────────────────────

export type OpusAccount = 'alpaca_paper' | 'ig_demo' | 't212_live';

// Selectable from the dashboard (2026-10-21, per explicit request to test the
// stronger models on real results). Prices per million tokens, Claude API.
export const MODELS = {
  'claude-fable-5-1':  { label: 'Claude Fable 5.1',  input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-opus-5-5':   { label: 'Claude Opus 5.5',   input: 4,  output: 20, cacheRead: 0.20, cacheWrite: 5 },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', input: 2,  output: 10, cacheRead: 0.20, cacheWrite: 2.5 },
} as const;
export type OpusModel = keyof typeof MODELS;

export type OpusConfig = {
  enabled:              boolean;
  model:                OpusModel;          // the model that trades
  routineModel:         OpusModel | null;   // cheaper model for routine check-ins; entries escalate to `model` (2026-10-29)
  researchModel:        OpusModel | null;   // model for the daily research session, if different from `model` (2026-10-29)
  changeGate:           boolean;            // skip scheduled sessions when nothing material changed (2026-10-29)
  quietMaxHoursUs:      number;             // ...but always run at least this often in US hours
  quietMaxHoursOff:     number;             // ...and outside them
  gateMovePct:          number;             // a market move since the last session that counts as material
  shadowModel:          OpusModel | null;   // optional second model: same briefing, decisions logged, never executed
  accounts:             Record<OpusAccount, boolean>;
  monthlyCapUsd:        number;   // hard stop on API spend for the calendar month
  cycleMinutes:         number;   // how often Opus reviews the book during the US session
  offHoursMinutes:      number;   // outside US hours, review IG markets this often on weekdays (0 = off)
  alpacaEveryMinutes:   number;   // Alpaca is long-term: consider new Alpaca entries only this often
  tradingviewCharts:    boolean;  // offer the tradingview_chart tool (needs TV_GATE_HOST and a logged-in chart server)
  effort:               'low' | 'medium' | 'high' | 'xhigh';
  alpacaMaxPositionUsd: number;
  alpacaMaxPositions:   number;
  igMaxRiskGbp:         number;   // £ lost if the stop is hit (floor)
  igMinRiskGbp:         number;   // smallest £ at risk per IG trade, probes included (owner, 2026-10-29)
  igStakePerPoint:      number;   // fixed IG stake £/pt for new trades, 0 = size by risk (owner, 2026-10-29)
  igShareMaxRiskPct:    number;   // risk cap for IG US-share spread bets, % of balance (owner wants IG share bets, 2026-10-29)
  igMaxRiskPct:         number;   // …or this % of the IG balance, whichever is larger
  igMaxPositions:       number;
  t212MaxPositionGbp:   number;
  t212MaxTotalGbp:      number;
  t212MaxPositions:     number;
  minConviction:        number;   // matches the 65% entry bar used everywhere else
  probeMinConviction:   number;   // paper/demo only: conviction from here up to minConviction opens a small PROBE
  probeSizePct:         number;   // probe size as % of the normal size cap
  alpacaStocks:         boolean;  // false = Alpaca is options-only for new entries (owner, 2026-10-29)
  oldOptionsBot:        boolean;  // the old Alpaca options bot keeps finding entries; Opus vets each one (owner, 2026-10-29)
  optionVetsPerDay:     number;   // cap on Opus vetting calls for the old bot per day
  optionMaxPremiumUsd:  number;   // max premium paid per option position
  optionMaxTotalUsd:    number;   // max premium across all open option positions
  optionMaxPositions:   number;
  optionMinDte:         number;   // shortest expiry allowed at entry (days)
  optionCloseDte:       number;   // code closes an option this close to expiry
  webResearch:          boolean;  // give the model web search/fetch for its own research
  searchesPerSession:   number;   // web searches allowed in a normal session
  researchSearches:     number;   // web searches allowed in the daily research session
  cacheOneHour:         boolean;  // 1-hour prompt cache on the fixed prefix in US hours (2026-10-29)
  minHoldHours:         number;   // no discretionary close sooner than this (stops still fire)
  reentryCooldownHours: number;   // after closing a symbol, no new position in it for this long
};

const DEFAULT_CONFIG: OpusConfig = {
  enabled: false,
  model: 'claude-opus-5-5',
  routineModel: 'claude-sonnet-5-5',
  researchModel: null,
  changeGate: true,
  quietMaxHoursUs: 3,
  quietMaxHoursOff: 8,
  gateMovePct: 1,
  shadowModel: null,
  accounts: { alpaca_paper: true, ig_demo: true, t212_live: true },
  monthlyCapUsd: 150,          // ≈ £120
  cycleMinutes: 30,
  offHoursMinutes: 120,
  alpacaEveryMinutes: 180,
  tradingviewCharts: false,
  effort: 'medium',
  alpacaMaxPositionUsd: 5_000,
  alpacaMaxPositions: 8,
  igMaxRiskGbp: 10,
  igMinRiskGbp: 20,
  igStakePerPoint: 1,
  igShareMaxRiskPct: 2,
  igMaxRiskPct: 1,
  igMaxPositions: 6,
  t212MaxPositionGbp: 100,
  t212MaxTotalGbp: 300,
  t212MaxPositions: 3,
  minConviction: 65,
  probeMinConviction: 55,
  probeSizePct: 33,
  alpacaStocks: false,
  oldOptionsBot: true,
  optionVetsPerDay: 8,
  optionMaxPremiumUsd: 3_000,
  optionMaxTotalUsd: 10_000,
  optionMaxPositions: 5,
  optionMinDte: 45,
  optionCloseDte: 7,
  minHoldHours: 4,
  reentryCooldownHours: 24,
  webResearch: true,
  searchesPerSession: 2,
  researchSearches: 8,
  cacheOneHour: true,
};

export type OpusPosition = {
  id:          string;
  account:     OpusAccount;
  symbol:      string;         // US ticker (the key Opus thinks in)
  brokerRef:   string;         // IG dealId | Alpaca symbol | T212 ticker
  epic?:       string;         // IG only
  direction:   'BUY' | 'SELL';
  size:        number;         // IG £/pt · Alpaca shares · T212 shares
  entryPrice:  number;         // in the broker's own units
  stopPrice:   number;         // same units as entryPrice
  stopOrderId?: string;        // T212 stop-limit order
  openedAt:    number;
  conviction:  number;
  probe?:      boolean;   // opened as a small probe (conviction below minConviction)
  lastPl?:     number | null;   // last P&L seen at the broker (fallback when it closes between reviews)
  reason:      string;
  exitPlan?:   string;        // target, invalidation, when to tighten, reward:risk (2026-10-23)
  // Alpaca option (2026-10-29): brokerRef is the OCC contract, symbol the
  // underlying, size the number of contracts, entry/stop are premium per share.
  // The stop is watched by code (Alpaca has no option stop orders).
  option?:     { type: 'call' | 'put'; strike: number; expiry: string };
};

type ClosedRecord = OpusPosition & { closedAt: number; closeReason: string; plApprox: number | null };

export type TvAlert = { ts: string; symbol: string; signal: string; timeframe: string | null; price: number | null; note: string | null };

type OpusState = {
  positions:      OpusPosition[];
  closed:         ClosedRecord[];       // newest last, trimmed
  notes:          string;               // Opus's own running strategy notes
  watchlistExtra: string[];             // symbols Opus added
  lastClosedAt:   Record<string, number>; // `${account}:${symbol}` → ts
  tvAlerts:       TvAlert[];            // TradingView webhook alerts, newest last
  lastResearchDay: string;              // NY date of the last daily research session
  lastScheduledAt?: number;             // last scheduled session start (survives restarts)
  lastSessionAt?: number;               // last session of any kind
  priceSnap?: Record<string, number>;   // prices at the last session, for the change gate
  lastAlpacaReviewAt?: number;          // last session in which Alpaca entries were considered
};

type SpendState = { month: string; usd: number; requests: number; cycles: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

type LogEntry = { id: string; ts: string; type: 'info' | 'enter' | 'exit' | 'wait' | 'error' | 'think'; msg: string };

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'opus-config.json');
const STATE_FILE  = path.join(ROOT, 'opus-state.json');
const SPEND_FILE  = path.join(ROOT, 'opus-spend.json');
const LOG_FILE    = path.join(ROOT, 'opus-log.json');

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
function writeJson(file: string, data: unknown): void {
  try { fs.writeFileSync(file, JSON.stringify(data), 'utf8'); } catch { /* best-effort */ }
}

let config: OpusConfig = { ...DEFAULT_CONFIG, ...readJson<Partial<OpusConfig>>(CONFIG_FILE, {}) };
config.accounts = { ...DEFAULT_CONFIG.accounts, ...(config.accounts ?? {}) };
let state: OpusState = { positions: [], closed: [], notes: '', watchlistExtra: [], lastClosedAt: {}, tvAlerts: [], lastResearchDay: '',
  ...readJson<Partial<OpusState>>(STATE_FILE, {}) };
let log: LogEntry[] = readJson<LogEntry[]>(LOG_FILE, []);

function thisMonth(): string { return new Date().toISOString().slice(0, 7); }
function loadSpend(): SpendState {
  const s = readJson<SpendState | null>(SPEND_FILE, null);
  if (s && s.month === thisMonth()) return s;
  return { month: thisMonth(), usd: 0, requests: 0, cycles: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
let spend = loadSpend();

const saveState  = () => writeJson(STATE_FILE, state);
const saveConfig = () => writeJson(CONFIG_FILE, config);
const saveSpend  = () => writeJson(SPEND_FILE, spend);

function addLog(type: LogEntry['type'], msg: string): void {
  const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: new Date().toISOString(), type, msg };
  log.unshift(entry);
  if (log.length > 400) log = log.slice(0, 400);
  writeJson(LOG_FILE, log);
  console.log(`[opus] [${type.toUpperCase()}] ${msg}`);
}

// ── Ownership (consumed by the other bots) ──────────────────────────────────

export function opusOwnedIgDealIds(): Set<string> {
  return new Set(state.positions.filter(p => p.account === 'ig_demo').map(p => p.brokerRef));
}
export function opusOwnedAlpacaSymbols(): Set<string> {
  return new Set(state.positions.filter(p => p.account === 'alpaca_paper').map(p => p.brokerRef));
}

// ── Spend tracking ──────────────────────────────────────────────────────────

// Priced at the requested model's rates. A server-side fallback (rare) bills
// at the fallback model's own rates, so this is an estimate in that case —
// the Anthropic console's own spend limit is the backstop.
// Web search is billed per search on top of tokens ($10 per 1,000).
const WEB_SEARCH_USD = 0.01;
function recordUsage(model: OpusModel, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; server_tool_use?: { web_search_requests?: number | null } | null }): number {
  const price = MODELS[model];
  const cr = u.cache_read_input_tokens ?? 0, cw = u.cache_creation_input_tokens ?? 0;
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  const usd = (u.input_tokens * price.input + u.output_tokens * price.output + cr * price.cacheRead + cw * price.cacheWrite) / 1_000_000
    + searches * WEB_SEARCH_USD;
  if (spend.month !== thisMonth()) spend = loadSpend();
  spend.usd += usd; spend.requests++;
  spend.inputTokens += u.input_tokens; spend.outputTokens += u.output_tokens;
  spend.cacheReadTokens += cr; spend.cacheWriteTokens += cw;
  saveSpend();
  return usd;
}
function budgetLeftUsd(): number {
  if (spend.month !== thisMonth()) spend = loadSpend();
  return config.monthlyCapUsd - spend.usd;
}

// ── Market data (code-computed — never by the model) ────────────────────────

const BASE_UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'AMD', 'META', 'GOOGL', 'AMZN', 'TSLA', 'AVGO', 'MU', 'INTC', 'PLTR',
  'COIN', 'MRVL', 'WDC', 'STX', 'DELL', 'UBER', 'RIVN', 'F', 'JNJ', 'HON', 'CAT', 'MCD', 'XOM',
  'JPM', 'BAC', 'V', 'NFLX', 'LLY', 'UNH', 'COST', 'ORCL', 'CRM', 'SPY', 'QQQ', 'IWM', 'XLE', 'XLF',
];

// US ticker → IG cash epic (first mapping wins)
const TICKER_TO_EPIC: Record<string, string> = {};
for (const [epic, ticker] of Object.entries(EPIC_TO_ALPACA)) if (!TICKER_TO_EPIC[ticker]) TICKER_TO_EPIC[ticker] = epic;

// IG-only markets — indices, FX, commodities (2026-10-22, per explicit request
// that Opus cover IG properly). Daily bars from Yahoo via fetchBarsWithFallback;
// these have no real exchange volume on IG, so the volume rule doesn't apply.
// Japan 225 was this account's best-performing index on live (31 trades, +£221).
export const IG_MARKETS: Record<string, { epic: string; name: string }> = {
  JP225:     { epic: 'IX.D.NIKKEI.DAILY.IP', name: 'Japan 225' },
  USTECH100: { epic: 'IX.D.NASDAQ.CASH.IP',  name: 'US Tech 100' },
  US500:     { epic: 'IX.D.SPTRD.DAILY.IP',  name: 'US 500' },
  WALLST:    { epic: 'IX.D.DOW.DAILY.IP',    name: 'Wall Street' },
  DE40:      { epic: 'IX.D.DAX.DAILY.IP',    name: 'Germany 40' },
  UK100:     { epic: 'IX.D.FTSE.DAILY.IP',   name: 'FTSE 100' },
  EU50:      { epic: 'IX.D.STXE.CASH.IP',    name: 'EU Stocks 50' },
  GBPUSD:    { epic: 'CS.D.GBPUSD.TODAY.IP', name: 'GBP/USD' },
  EURUSD:    { epic: 'CS.D.EURUSD.TODAY.IP', name: 'EUR/USD' },
  USDJPY:    { epic: 'CS.D.USDJPY.TODAY.IP', name: 'USD/JPY' },
  AUDUSD:    { epic: 'CS.D.AUDUSD.TODAY.IP', name: 'AUD/USD' },
  SILVER:    { epic: 'CS.D.USCSI.TODAY.IP',  name: 'Silver' },
  BRENT:     { epic: 'CC.D.LCO.USS.IP',      name: 'Brent Crude' },
  NATGAS:    { epic: 'CC.D.NG.USS.IP',       name: 'Natural Gas' },
};
for (const [sym, m] of Object.entries(IG_MARKETS)) TICKER_TO_EPIC[sym] = m.epic;
const isIgOnly = (symbol: string) => symbol in IG_MARKETS;

// Epics another bot on the IG demo account currently owns (the commodities
// mean-reversion instance) — Opus leaves those to it.
// The Momentum Testbot (2026-10-29, ~/ig-momentum-bot, Python, own process)
// trades the same IG demo account. Its deal history is its own record of
// every deal it opened; Opus must never adopt or touch those.
export const MOMENTUM_HISTORY_FILE = path.join(os.homedir(), 'ig-momentum-bot', 'deal_history.json');
export type MomentumDeal = { dealId: string; market: string; epic: string; direction: string; size: number; level: number | null; opened_utc: string };
export function momentumBotDeals(): MomentumDeal[] {
  try { return JSON.parse(fs.readFileSync(MOMENTUM_HISTORY_FILE, 'utf8')) as MomentumDeal[]; } catch { return []; }
}
function momentumBotDealIds(): string[] { return momentumBotDeals().map(d => d.dealId); }

async function igEpicsOwnedElsewhere(): Promise<Set<string>> {
  try { const mr = await import('./meanReversionBot'); return mr.meanReversionOwnedEpics(); }
  catch { return new Set(); }
}

type Metrics = {
  symbol: string; price: number; dayChgPct: number; aboveOpen: boolean | null; volToday: number | null;
  sma20: number; sma50: number; trend12wPct: number | null; rsi14: number | null; atrPct: number | null;
  offHigh52wPct: number;
};

async function metricsFor(symbol: string): Promise<Metrics | null> {
  let bars: AlpacaBar[] | undefined | null;
  if (isIgOnly(symbol)) {
    try { bars = await fetchBarsWithFallback(IG_MARKETS[symbol].epic, '2y'); } catch { return null; }
  } else {
    try { bars = (await getBars([symbol], '1Day', 260, 'paper'))[symbol]; } catch { return null; }
  }
  if (!bars || bars.length < 60) return null;
  const c = bars.map(b => b.c), last = bars[bars.length - 1];
  const avg = (n: number) => c.slice(-n).reduce((s, x) => s + x, 0) / n;
  const atr = calcAtr(bars);
  return {
    symbol, price: last.c,
    dayChgPct: ((last.c - c[c.length - 2]) / c[c.length - 2]) * 100,
    aboveOpen: last.c > last.o ? true : last.c < last.o ? false : null,
    volToday: isIgOnly(symbol) ? null : dailyVolumeRatio(bars, 'US'),
    sma20: avg(20), sma50: avg(50),
    trend12wPct: c.length > 60 ? ((last.c - c[c.length - 61]) / c[c.length - 61]) * 100 : null,
    rsi14: calcRsi(bars),
    atrPct: atr !== null ? (atr / last.c) * 100 : null,
    offHigh52wPct: ((Math.max(...c) - last.c) / Math.max(...c)) * 100,
    // keep bars out of the briefing — too many tokens
  };
}

function isUsSessionOpen(now = new Date()): boolean {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const g = (t: string) => p.find(x => x.type === t)?.value ?? '';
  if (g('weekday') === 'Sat' || g('weekday') === 'Sun') return false;
  const m = Number(g('hour')) * 60 + Number(g('minute'));
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

// IG's indices/FX/commodities trade nearly round the clock on weekdays
// (Sunday ~22:00 to Friday ~21:00 UK). Japan 225 moves mostly overnight UK
// time and FX trades 24h, so a US-hours-only Opus would sleep through most of
// the action in the IG markets it now trades (2026-10-21).
function isIgWindowOpen(now = new Date()): boolean {
  const day = now.getUTCDay(), h = now.getUTCHours();
  if (day === 6) return false;
  if (day === 0) return h >= 22;
  if (day === 5) return h < 20;
  return true;
}
const offHours = () => !isUsSessionOpen() && isIgWindowOpen() && config.accounts.ig_demo && config.offHoursMinutes > 0;

// ── Broker adapters ─────────────────────────────────────────────────────────

let igSession: IGSession | null = null;
let igSessionAt = 0;
async function ig(): Promise<IGSession> {
  if (igSession && Date.now() - igSessionAt < 4 * 3_600_000) return igSession;
  const c = resolveCredentials('demo');
  igSession = await authenticate(c.apiKey, c.username, c.password, 'demo', 'opus');
  igSessionAt = Date.now();
  return igSession;
}

type LivePos = { pl: number | null; current: number | null; exists: boolean };

async function livePositionView(): Promise<Map<string, LivePos>> {
  const view = new Map<string, LivePos>();
  const need = (a: OpusAccount) => state.positions.some(p => p.account === a);
  if (need('alpaca_paper')) {
    try {
      const ps = await getAlpacaPositions('paper');
      for (const p of state.positions.filter(x => x.account === 'alpaca_paper')) {
        const lp = ps.find(x => x.symbol === p.brokerRef);
        view.set(p.id, lp ? { pl: parseFloat(lp.unrealized_pl), current: parseFloat(lp.current_price), exists: true } : { pl: null, current: null, exists: false });
        if (lp) p.lastPl = parseFloat(lp.unrealized_pl);
      }
    } catch { /* leave unknown */ }
  }
  if (need('ig_demo')) {
    try {
      const ps = await fetchFullPositions(await ig());
      for (const p of state.positions.filter(x => x.account === 'ig_demo')) {
        const lp = ps.find(x => x.dealId === p.brokerRef);
        view.set(p.id, lp ? { pl: lp.upl, current: p.direction === 'BUY' ? lp.bid : lp.offer, exists: true } : { pl: null, current: null, exists: false });
        if (lp) p.lastPl = lp.upl;
      }
    } catch { /* leave unknown */ }
  }
  if (need('t212_live')) {
    try {
      const ps = await getPortfolio('live', { fresh: true });
      for (const p of state.positions.filter(x => x.account === 't212_live')) {
        const lp = ps.find(x => x.ticker === p.brokerRef);
        view.set(p.id, lp ? { pl: lp.ppl ?? null, current: lp.currentPrice ?? null, exists: true } : { pl: null, current: null, exists: false });
      }
    } catch { /* leave unknown */ }
  }
  return view;
}

// Positions that vanished at the broker (stop hit, closed by hand) → closed.
async function reconcile(view: Map<string, LivePos>): Promise<void> {
  for (const p of [...state.positions]) {
    const v = view.get(p.id);
    if (v && !v.exists) {
      // Grace for a just-placed order that hasn't shown up yet.
      if (Date.now() - p.openedAt < 10 * 60_000) continue;
      const real = await realisedPl(p).catch(() => null);
      markClosed(p, `Closed at the broker (stop-loss hit, profit target, or closed outside Opus)${real ? '' : ' — P&L is the last value seen before it closed'}`, real ?? p.lastPl ?? null);
    }
  }
}

// The broker's own P&L for a position that closed between reviews
// (2026-10-23: these were booked with no P&L, which hid the stop-outs Opus
// most needs to learn from). IG: transaction history matched on open time.
// Alpaca: the closing fills after the position opened.
async function realisedPl(p: OpusPosition): Promise<number | null> {
  if (p.account === 'ig_demo') {
    const tx = await fetchClosedTransactions(await ig(), new Date(p.openedAt - 3_600_000).toISOString());
    const t = tx.find(x => x.openDateUtc && Math.abs(Date.parse(x.openDateUtc + 'Z') - p.openedAt) < 5 * 60_000 && Math.abs((x.openLevel ?? 0) - p.entryPrice) < Math.max(1, p.entryPrice * 0.002));
    return t ? t.profitAndLoss : null;
  }
  if (p.account === 'alpaca_paper') {
    const fills = (await getFillsSince('paper', new Date(p.openedAt).toISOString())).filter(x => x.symbol === p.brokerRef && x.side === (p.direction === 'BUY' ? 'sell' : 'buy'));
    let qty = 0, value = 0;
    for (const x of fills) { const q = Math.min(parseFloat(x.qty), p.size - qty); if (q <= 0) break; qty += q; value += q * parseFloat(x.price); }
    if (qty < p.size - 1e-9) return null;
    const exit = value / qty;
    return Math.round((p.direction === 'BUY' ? exit - p.entryPrice : p.entryPrice - exit) * p.size * (p.option ? 100 : 1) * 100) / 100;
  }
  return null;
}

function markClosed(p: OpusPosition, reason: string, pl: number | null): void {
  state.positions = state.positions.filter(x => x.id !== p.id);
  state.closed.push({ ...p, closedAt: Date.now(), closeReason: reason, plApprox: pl });
  if (state.closed.length > 300) state.closed = state.closed.slice(-300);
  state.lastClosedAt[`${p.account}:${p.symbol}`] = Date.now();
  saveState();
  addLog('exit', `${p.account} ${p.symbol} ${p.direction} closed — ${reason}${pl !== null ? ` (P&L ≈ ${pl.toFixed(2)})` : ''}`);
}

// ── Tools ───────────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'open_position',
    description: 'Open a new position. Code enforces hard limits and will reject (with the reason) anything outside them. size: alpaca_paper = USD to invest; ig_demo = GBP you are willing to lose if the stop is hit (stake is derived from it); t212_live = GBP to invest (BUY only, real money).',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        account:       { type: 'string', enum: ['alpaca_paper', 'ig_demo', 't212_live'] },
        symbol:        { type: 'string', description: 'US ticker from the briefing' },
        direction:     { type: 'string', enum: ['BUY', 'SELL'] },
        size:          { type: 'number' },
        stop_loss_pct: { type: 'number', description: 'Stop distance from entry, % of price (2-15)' },
        conviction:    { type: 'integer', description: '0-100, your honest confidence this trade works over your intended holding period' },
        reason:        { type: 'string', description: 'Why, in 1-3 sentences — the thesis you will judge the position against later' },
        exit_plan:     { type: 'string', description: 'Target level, what would prove you wrong before the stop, when you will tighten the stop to lock in profit, and rough reward:risk. 1-3 sentences.' },
      },
      required: ['account', 'symbol', 'direction', 'size', 'stop_loss_pct', 'conviction', 'reason', 'exit_plan'],
      additionalProperties: false,
    },
  },
  {
    name: 'option_chain',
    description: 'Look up Alpaca option contracts for a US stock or ETF in the briefing: live bid/ask, delta and implied volatility for strikes around the current price, at a few expiries. Use it before open_option. Read-only.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        symbol:  { type: 'string', description: 'Underlying US ticker from the briefing' },
        type:    { type: 'string', enum: ['call', 'put'] },
        min_dte: { type: 'integer', description: 'Shortest days to expiry to show (code minimum applies)' },
        max_dte: { type: 'integer', description: 'Longest days to expiry to show' },
      },
      required: ['symbol', 'type', 'min_dte', 'max_dte'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_option',
    description: 'Buy to open an option contract on alpaca_paper (long calls or puts only, so the most it can lose is the premium paid). Use a contract symbol from option_chain. Fills at the current ask with a limit order or not at all. The stop is on the option\'s own price and is watched by code every 5 minutes in US hours; code also sells it a week before expiry.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        contract:      { type: 'string', description: 'OCC option symbol from option_chain, e.g. AAPL270115C00250000' },
        contracts:     { type: 'integer', description: 'Number of contracts (each is 100 shares)' },
        stop_loss_pct: { type: 'number', description: 'Sell if the option\'s bid falls this % below what you paid (20-70)' },
        conviction:    { type: 'integer', description: '0-100, your honest confidence this trade works over your intended holding period' },
        reason:        { type: 'string', description: 'Why, in 1-3 sentences: the thesis you will judge the position against later' },
        exit_plan:     { type: 'string', description: 'Target (underlying level or option price), what would prove you wrong, when you will tighten the stop, and rough reward:risk. 1-3 sentences.' },
        news_and_macro:{ type: 'string', description: 'The news/catalyst and macro backdrop (rates and the Fed, sector flows, upcoming events such as earnings or CPI) that support this trade, from research done in this session. 1-3 sentences.' },
      },
      required: ['contract', 'contracts', 'stop_loss_pct', 'conviction', 'reason', 'exit_plan', 'news_and_macro'],
      additionalProperties: false,
    },
  },
  {
    name: 'escalate',
    description: 'Routine check-ins only (run on a cheaper model): hand over to Opus when you see a new entry worth taking or something that needs deeper judgment. Opus runs a full session straight after this one, with your note.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'What you saw and why it needs Opus, 1-2 sentences' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_position',
    description: 'Close one of your open positions by its id from the briefing.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        position_id: { type: 'string' },
        reason:      { type: 'string' },
      },
      required: ['position_id', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'tighten_stop',
    description: 'Move an open position\'s broker stop-loss to lock in profit or cut risk, e.g. to break-even or a profit floor once a trade has run. Tighten only: a long\'s stop can only move UP and a short\'s only DOWN, and it must stay on the losing side of the current price. Allowed any time (no minimum hold). The new stop is placed at the broker, so it works between your reviews.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        position_id: { type: 'string' },
        new_stop:    { type: 'number', description: 'New stop level, in the same units as the position\'s entry/stop in the briefing (IG points for ig_demo)' },
        reason:      { type: 'string' },
      },
      required: ['position_id', 'new_stop', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_backtest',
    description: 'Test a rule-based strategy idea on real, split-adjusted daily history before relying on it. Signals are read at a close and entered at the next open; stops/targets checked on later highs/lows. Returns trade count, win rate, average/median return, best/worst, hold time, exit reasons, and buy-and-hold for comparison. No trading happens. Limited per session.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        symbols:          { type: 'array', items: { type: 'string' }, description: '1-15 US tickers' },
        direction:        { type: 'string', enum: ['long', 'short'] },
        entry_conditions: { type: 'array', description: 'All must hold on the signal day', items: {
          type: 'object',
          properties: {
            indicator: { type: 'string', enum: [...INDICATORS] },
            op:        { type: 'string', enum: ['>', '<', '>=', '<='] },
            value:     { type: 'number' },
          },
          required: ['indicator', 'op', 'value'], additionalProperties: false,
        } },
        exit_conditions:  { type: 'array', description: 'Any true at a close exits (can be empty)', items: {
          type: 'object',
          properties: {
            indicator: { type: 'string', enum: [...INDICATORS] },
            op:        { type: 'string', enum: ['>', '<', '>=', '<='] },
            value:     { type: 'number' },
          },
          required: ['indicator', 'op', 'value'], additionalProperties: false,
        } },
        stop_loss_pct:    { type: 'number' },
        take_profit_pct:  { type: 'number', description: '0 = no take-profit' },
        max_hold_days:    { type: 'integer' },
        lookback_days:    { type: 'integer', description: 'Trading days of history, 120-750' },
      },
      required: ['symbols', 'direction', 'entry_conditions', 'exit_conditions', 'stop_loss_pct', 'take_profit_pct', 'max_hold_days', 'lookback_days'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_exit_plan',
    description: 'Record or revise the exit plan for one of your open positions (target, what would prove you wrong, when to tighten the stop, reward:risk). Use it for positions that have no plan yet, or when something material changed. Changes nothing at the broker.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        position_id: { type: 'string' },
        exit_plan:   { type: 'string' },
      },
      required: ['position_id', 'exit_plan'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_notes',
    description: 'Replace your persistent strategy notes (max ~3000 chars). Shown to you at the start of every session — record what is working, what is not, and the approach you are following, so you can adapt between sessions.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { notes: { type: 'string' } },
      required: ['notes'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_watchlist_extra',
    description: 'Replace the list of extra US tickers (max 20) added to your briefing universe from the next session.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { symbols: { type: 'array', items: { type: 'string' } } },
      required: ['symbols'],
      additionalProperties: false,
    },
  },
];

// ── TradingView chart (2026-10-21) ─────────────────────────────────────────
// A TradingView web chart runs on a separate ARM server (tradingview/
// setup-tv-server.sh). This server reaches it over SSH with a key whose only
// permitted command is tradingview/tv-gate.mjs ("chart <SYMBOL> <TF> [shot]"),
// so the link can read charts and nothing else. Off unless TV_GATE_HOST is set.
const TV_GATE_HOST = process.env.TV_GATE_HOST ?? '';
const TV_GATE_KEY = process.env.TV_GATE_KEY ?? path.join(os.homedir(), '.ssh', 'tv_gate');
const MAX_CHARTS_PER_SESSION = 6;
const tvChartsOn = () => Boolean(TV_GATE_HOST) && config.tradingviewCharts;
const MAX_SCREENSHOTS_PER_SESSION = 3;

const TV_TOOL: Anthropic.Beta.BetaTool = {
  name: 'tradingview_chart',
  description: 'Look at a live TradingView chart. Switches the chart to the symbol and timeframe and returns the latest quote, a 100-bar summary (change, range, average volume, last 5 bars) and the values of the indicators on the chart; with screenshot=true you also get an image of the chart to read the structure yourself (trend, support/resistance, patterns). Use TradingView symbols with an exchange prefix, e.g. NASDAQ:AAPL, NYSE:JPM for US shares; for IG markets use the FOREX.com CFD feeds, which are live and trade nearly round the clock like IG: FOREXCOM:JP225 (Japan 225), FOREXCOM:NAS100, FOREXCOM:SPX500, FOREXCOM:US30 (Wall Street), FOREXCOM:GER40, FOREXCOM:UK100, FOREXCOM:EU50, FOREXCOM:GBPUSD, FOREXCOM:EURUSD, FOREXCOM:USDJPY, FOREXCOM:AUDUSD, FOREXCOM:UKOIL (Brent), FOREXCOM:XAGUSD (silver), PEPPERSTONE:NATGAS. Slow (20-40s) and limited per session — use it on open positions and your strongest candidates, not to scan.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      symbol:     { type: 'string', description: 'TradingView symbol with exchange prefix' },
      timeframe:  { type: 'string', enum: ['15', '60', '240', 'D', 'W'], description: 'Bar size: minutes, D = daily, W = weekly' },
      screenshot: { type: 'boolean' },
    },
    required: ['symbol', 'timeframe', 'screenshot'],
    additionalProperties: false,
  },
};

type TvBar = { time: number; open: number; high: number; low: number; close: number; volume?: number };
async function tradingviewChart(input: Record<string, unknown>, allowShot: boolean): Promise<{ text: string; image?: string }> {
  const sym = String(input.symbol ?? '').toUpperCase().trim();
  const tf = String(input.timeframe ?? 'D');
  if (!/^[A-Z0-9_!.]{1,20}(:[A-Z0-9_!.]{1,24})?$/.test(sym)) return { text: `REJECTED: "${sym}" is not a valid TradingView symbol.` };
  const shot = input.screenshot === true && allowShot;
  const stdout = await new Promise<string>((resolve, reject) => execFile('ssh',
    ['-i', TV_GATE_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', TV_GATE_HOST, `chart ${sym} ${tf}${shot ? ' shot' : ''}`],
    { timeout: 120_000, maxBuffer: 20 * 1024 * 1024 },
    (err, out) => (err && !out ? reject(err) : resolve(out))));
  const r = JSON.parse(stdout);
  if (r.error) return { text: `FAILED: ${r.error}` };
  const q = r.quote ?? {}, sm = r.summary ?? {};
  const when = (t: number) => new Date(t * 1000).toISOString().slice(0, tf === 'D' || tf === 'W' ? 10 : 16).replace('T', ' ');
  const bars = (sm.last_5_bars ?? []) as TvBar[];
  const studies = ((r.indicators?.studies ?? []) as { name: string; values?: Record<string, unknown> }[])
    .map(st => `${st.name}: ${Object.entries(st.values ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  const lines = [
    `TradingView ${q.symbol} (${q.description ?? ''}), timeframe ${tf}: last ${q.last}; current bar O ${q.open} H ${q.high} L ${q.low}.`,
    `Last ${sm.bar_count} bars: change ${sm.change_pct}, low ${sm.low}, high ${sm.high}, average volume ${sm.avg_volume ?? 'n/a'}.`,
    `Last 5 bars (time o/h/l/c vol): ${bars.map(b => `${when(b.time)} ${b.open}/${b.high}/${b.low}/${b.close} ${b.volume ?? ''}`).join('; ')}`,
    `Indicators on chart: ${studies.join(' | ') || 'none'}`,
  ];
  if (input.screenshot === true && !allowShot) lines.push(`(No screenshot: limit of ${MAX_SCREENSHOTS_PER_SESSION} per session reached.)`);
  if (r.screenshot_error) lines.push(`(Screenshot failed: ${r.screenshot_error})`);
  return { text: lines.join('\n'), image: shot ? r.screenshot_png_base64 : undefined };
}

const TV_PROMPT = `

TradingView: you can look at live TradingView charts with the tradingview_chart tool — any timeframe, with a screenshot when the picture matters (trend structure, levels, patterns). It is a second view alongside the briefing's computed numbers; how much weight to give it is your call. The chart carries a visible-range volume profile: horizontal bars on the right showing how much volume traded at each price over the bars on screen. The longest bar (point of control) and the high-volume zones tend to act as support and resistance, and thin zones are where price can move fast. It only shows on screenshots, so take one when those levels matter (entries, stop placement). Index and FX CFD feeds carry tick volume, not exchange volume, so for those it shows activity rather than true volume.`;

const SYSTEM_PROMPT = `You are the portfolio manager for a small trading operation, running in a test period that is being reviewed after about a month. Each session you receive a briefing and act through tools. Your goal is risk-adjusted profit over weeks to months, not activity. Don't rush trades to show a result inside the test: a sound position still open at the review counts by its open P&L.

Accounts you control:
- alpaca_paper: paper money (USD). The owner wants this account trading OPTIONS (as it did before you took it over), not stocks: new entries are long calls or puts only, via option_chain then open_option. Stock positions you already hold there stay yours to manage until you close them.
- ig_demo: UK spread bets, demo money (GBP) — US shares plus indices, FX and commodities (see the IG markets table). Long or short. You size by £ at risk; code derives the stake.
- t212_live: Trading 212 ISA, REAL money (GBP). Long only, small sizes. Be most selective here.

YOU OWN THE STRATEGY (the owner's decision, 2026-10-22): the owner wants all trading logic in your hands, with no rules of theirs or the code's second-guessing your strategy. Read the market regime yourself (trending up or down, ranging, high-volatility, risk-off, event-driven) and choose the approach that fits: trend-following, buying pullbacks, fading extremes, shorting, hedging, or staying flat. Switch approaches when conditions change. Write your current playbook and the regime you think you're in into your notes, and revise both as your results come in. Nothing below is an instruction about how to trade; it's evidence for you to weigh.

Evidence from this account's history (weigh it, don't obey it):
- Short holds lost money here: across 57 closed option trades, those held under a week went 2 wins / 44 trades; a week or longer went 8 / 13. The owner prefers holds of weeks to months on Alpaca, and days to about a week on IG spread bets, and dislikes churn.
- In a 3-year backtest on 15 US large caps (exit on a close below the 50-day, 10% stop): buying a breakout (above both averages, 12-week gain ≥ 8%, normal-or-better volume, up on the day) averaged +3.5% a trade over 169 trades; buying a pullback to the 20-day that turned up averaged +3.2% over 116 trades, with smaller losses. Both trailed simply holding in a strong market. Index and FX moves are much smaller than single-stock moves, so stock thresholds don't transfer to them.
- Re-asking the same question on unchanged inputs gave unstable answers. Change your mind about a position when something material changed, not because the session repeated.
- The owner's view on natural gas (2026-10-23): it's worth more of your attention than its share of the market list suggests. Its patterns (trend breakouts, seasonal and inventory-driven swings) tend to be clearer than most markets', and trades here have done well when the entry was chosen carefully and the profit was locked in. Don't take the short you adopted from the old breakout bot as proof of this, though: the owner thinks its entry logic was crude and that it's in profit mostly because the market happened to move its way. Judge that position on your own reading of the chart, not on its P&L so far. Natural gas is also very volatile, with sharp reversals after big runs, so the gain depends on where you set and tighten the stop. Look at it closely every session and trade it when you see a setup you'd take. This is a pointer about where to look, not an instruction to trade it or a reason to lower your bar.

OPTIONS ON ALPACA (the owner's decision, 2026-10-29): you only buy calls (to profit from a rise) or puts (from a fall), so the most a position can lose is the premium paid. Pick the underlying from the briefing's US shares and the direction from your own read, then use option_chain to choose the contract and open_option to buy it. How you choose strike and expiry is your call; things to weigh:
- Time: an option loses value every day (faster in its last weeks), so the move has to come before expiry. Your holds are weeks to months; expiries well beyond your intended hold give the idea room. Code won't buy under 45 days to expiry and sells a week before expiry.
- Strike: near-the-money (delta ~0.4-0.6) behaves most like the stock; far out-of-the-money is cheap but needs a big move and often expires worthless.
- Price: implied volatility (IV) is what you're paying for expected movement; high IV (e.g. just before earnings) makes options dear and they deflate after the event.
- Cost: wide bid/ask spreads cost you on the way in and out; code refuses spreads over 15%.
- News and macro (the owner's rule): chart data alone isn't enough for an option. Before buying one, search this session for the company's latest news and catalysts and for the macro backdrop (rates and the Fed, where money is rotating, upcoming events like earnings or CPI that could move it), and summarise them in news_and_macro. Code rejects an option entry if you haven't researched in the session.
- Stops: your stop is on the option's own price (stop_loss_pct of what you paid) and code checks it every 5 minutes in US hours. Option prices swing far more than the stock's, so a tight stop gets hit by noise.
- History here (weigh it): the old options bot lost about $13k on this account, mostly on short-dated contracts and quick in-and-out trades. Holds of a week or more did much better than shorter ones.

Data you get: every number in the briefing is computed by code from market data (price, day change, whether today is above its open, today's volume vs a normal day (1.0 = normal, pro-rated for time of day), 20/50-day averages, 12-week trend, RSI(14), ATR% (typical daily range), distance off the 52-week high, headlines). The "setup (code)" column flags BREAKOUT/PULLBACK patterns as a convenience; use it, ignore it or define your own setups. You can test any idea with run_backtest (indicators: ${INDICATORS.join(', ')}). Judge it against buy-and-hold on enough trades; costs aren't modelled. When live results disagree with a backtest, trust the live results.

KEEP LEARNING (the owner's standing request, 2026-10-23): you're expected to get better over the test, above all from your mistakes. Your track record is in every briefing. After a trade closes at a loss, or stops out, write a one-line post-mortem in your notes: what you expected, what actually happened, and what you'll do differently. In each daily research session, look across your recent closes for patterns (which setups, markets, regimes, holding times and conviction levels win or lose, and probes vs full size) and change your playbook to match. Keep the notes compact: merge old lessons into rules rather than piling up entries. Don't repeat a mistake your notes already describe.

Plan the exit when you enter: every open_position needs an exit_plan saying where you expect the trade to go (a target level), what would prove you wrong before the stop is hit, at what point you'll tighten the stop to lock in profit, and the rough reward-to-risk (target distance ÷ stop distance). The plan is shown with the position in every briefing; at each review, check the trade against it rather than re-deciding from scratch, and act when it says to. If the plan needs changing because something material changed, say so in your notes. A trade whose realistic target is barely further away than its stop usually isn't worth taking.

Locking in profit: you can move a position's broker stop with tighten_stop (tighten only, so it never adds risk; it works between your reviews). Whether, when and where to use it is your call, ideally decided in the exit plan. History here: an older automatic "profit floor" closed 16 trades, all in profit (about £1,490 total), but on the ones with a recorded peak it kept only about half the peak gain. Your stops otherwise stay where they started until you close the trade.

Things that quietly cost money:
- Related positions are one bet. Indices, the euro and European shares, oil and energy shares, or several tech names tend to move together. Before adding a position, ask what all your positions together lose if the market turns against them at once, and size or skip accordingly.
- Trading costs. Every IG spread bet pays the spread on entry and exit, and a daily-funded bet is charged overnight funding (very roughly the base rate plus about 2.5% a year of the position's value, for each night held). On a tight stop or a small target the spread is a big share of the trade. Backtests here leave costs out, so they look better than live trading will.
- Stops inside normal noise. A stop closer than a market's usual daily range (ATR% in the briefing) tends to get hit by ordinary swings before the idea has had a chance to play out. Volatile markets such as natural gas need room, and you should size them smaller to fit.

TEST PERIOD, PROBES: the owner is testing whether this makes money, which needs trades to measure. On alpaca_paper and ig_demo, a conviction between the probe minimum and the full minimum opens at a fraction of normal size (code sizes it). When you have a real idea that falls short of full conviction, take it as a probe rather than sitting out. Don't invent ideas to have something to trade, and never inflate conviction. t212_live is real money: no probes.

Safety limits enforced by code (the only rules; they're risk controls, not strategy): every position needs a stop-loss of 2-15%; conviction at least the probe minimum (full size needs the full minimum); per-account position and size caps; Alpaca only during US market hours (orders are never queued for the open); no discretionary close within the minimum hold window, and no re-entry into a symbol within the cooldown after closing it (both guard against churn; stops still fire anytime).

How to work a session:
1. Review your open positions against the thesis and exit plan you recorded for each. Close or tighten when the plan says to or something material changed.
2. Look for new entries: full size where the setup is genuinely good, a probe where it's a real but less certain idea. When nothing qualifies, doing nothing is the right outcome; many sessions will be like that.
3. If you learned something, update your notes. Keep them short and concrete.
4. End with a brief plain-text summary of what you did and why (2-4 sentences).`;

function fmt(n: number | null, d = 1): string { return n === null || !isFinite(n) ? '—' : n.toFixed(d); }

async function buildBriefing(view: Map<string, LivePos>): Promise<{ text: string; metrics: Map<string, Metrics> }> {
  const universe = [...new Set([...BASE_UNIVERSE, ...(config.accounts.ig_demo ? Object.keys(IG_MARKETS) : []), ...state.watchlistExtra, ...state.positions.map(p => p.symbol)])];
  const ownedElsewhere = await igEpicsOwnedElsewhere();
  const metrics = new Map<string, Metrics>();
  for (const s of universe) { const m = await metricsFor(s); if (m) metrics.set(s, m); }

  // Account balances (best-effort)
  const lines: string[] = [];
  lines.push(`Session: ${new Date().toISOString().slice(0, 16)} UTC. Monthly API budget left: $${budgetLeftUsd().toFixed(2)} of $${config.monthlyCapUsd}.`);
  lines.push('');
  lines.push('## Accounts');
  if (config.accounts.alpaca_paper) {
    try { const a = await getAccount('paper'); const optOpen = state.positions.filter(p => p.option);
      const optSpent = optOpen.reduce((t, p) => t + p.entryPrice * p.size * 100, 0);
      lines.push(`- alpaca_paper: equity $${parseFloat(a.equity).toFixed(0)}, cash $${parseFloat(a.cash).toFixed(0)}. ${config.alpacaStocks ? `Stocks: ≤$${config.alpacaMaxPositionUsd}/position, ≤${config.alpacaMaxPositions} positions. ` : 'New entries: OPTIONS ONLY (no new stock positions). '}Options: ≤$${config.optionMaxPremiumUsd} premium/position, ≤$${config.optionMaxTotalUsd} total ($${optSpent.toFixed(0)} in use), ≤${config.optionMaxPositions} positions (${optOpen.length} open), expiry ≥${config.optionMinDte} days at entry, auto-sold ${config.optionCloseDte} days before expiry.`); }
    catch { lines.push('- alpaca_paper: balance unavailable'); }
  }
  if (config.accounts.ig_demo) {
    try {
      const f = await fetchAccountFunds(await ig());
      const cap = Math.max(config.igMaxRiskGbp, f.balance * config.igMaxRiskPct / 100);
      const tradeable = Object.keys(TICKER_TO_EPIC).filter(t => metrics.has(t) && !ownedElsewhere.has(TICKER_TO_EPIC[t]));
      const skipped = Object.keys(IG_MARKETS).filter(t => ownedElsewhere.has(IG_MARKETS[t].epic));
      lines.push(`- ig_demo: balance £${f.balance.toFixed(0)}, available £${f.available.toFixed(0)}. ${config.igStakePerPoint > 0 ? `Stake: fixed at £${config.igStakePerPoint}/pt for every new trade (the owner's choice; your size field is ignored here), so the £ lost if the stop is hit = stop distance in points × £${config.igStakePerPoint}. If that would exceed £${cap.toFixed(0)}, code lowers the stake to fit, so choose the stop with this in mind.` : `Risk per position: at least £${config.igMinRiskGbp}, at most £${cap.toFixed(0)}.`} ≤${config.igMaxPositions} of your positions. US shares are tradeable here too as spread bets (the owner wants these used): IG quotes them in cents, so 1 point = 1 cent and a stake of £1/pt = £100 per $1 move. For shares the stake is sized from your size field (£ at risk, at least £${config.igMinRiskGbp}), not the fixed £/pt, with a cap of £${Math.max(config.igMaxRiskGbp, f.balance * config.igShareMaxRiskPct / 100).toFixed(0)} (${config.igShareMaxRiskPct}% of balance). IG's minimum stake is about 0.24/pt, so the smallest bet is already sizeable: a 5% stop on a $350 share risks ~£420 (fits), an 8% stop on it ~£670 (rejected). Higher-priced shares need tighter stops; cheaper ones leave more room. Share spread bets hold days to weeks like the rest of IG; overnight funding applies. Tradeable: ${tradeable.join(', ')}.${skipped.length ? ` Managed by another bot, leave alone: ${skipped.join(', ')}.` : ''}`);
    }
    catch { lines.push('- ig_demo: balance unavailable'); }
  }
  if (config.accounts.t212_live) {
    try { const c = await getCash('live', { fresh: true }); lines.push(`- t212_live (REAL money): free cash £${c.free.toFixed(0)}. Caps: ≤£${config.t212MaxPositionGbp}/position, ≤£${config.t212MaxTotalGbp} total across your T212 positions, ≤${config.t212MaxPositions} positions, BUY only.`); }
    catch { lines.push('- t212_live: balance unavailable'); }
  }
  const disabled = (Object.keys(config.accounts) as OpusAccount[]).filter(a => !config.accounts[a]);
  if (disabled.length) lines.push(`- Disabled this session (don't use): ${disabled.join(', ')}`);

  lines.push('');
  lines.push('## Your open positions');
  if (!state.positions.length) lines.push('(none)');
  for (const p of state.positions) {
    const v = view.get(p.id);
    const heldH = (Date.now() - p.openedAt) / 3_600_000;
    if (p.option) {
      const dte = Math.round((Date.parse(p.option.expiry + 'T21:00:00Z') - Date.now()) / 86_400_000);
      lines.push(`- id=${p.id} ${p.account} OPTION long ${p.symbol} ${p.option.type.toUpperCase()} strike ${p.option.strike} exp ${p.option.expiry} (${dte}d left) contract=${p.brokerRef} contracts=${p.size} paid=${p.entryPrice} stop=${p.stopPrice} (option price, code-watched) now=${fmt(v?.current ?? null, 2)} P&L=${fmt(v?.pl ?? null, 2)} underlying=${fmt(metrics.get(p.symbol)?.price ?? null, 2)} held=${heldH.toFixed(1)}h conviction=${p.conviction} thesis: ${p.reason} — exit plan: ${p.exitPlan ?? '(none recorded yet; set one with set_exit_plan)'}`);
      continue;
    }
    lines.push(`- id=${p.id} ${p.account} ${p.direction} ${p.symbol} size=${p.size} entry=${p.entryPrice} stop=${p.stopPrice} now=${fmt(v?.current ?? null, 2)} P&L=${fmt(v?.pl ?? null, 2)} held=${heldH.toFixed(1)}h conviction=${p.conviction} thesis: ${p.reason} — exit plan: ${p.exitPlan ?? '(none recorded yet; set one with set_exit_plan)'}`);
  }

  const recent = state.closed.slice(-10);
  if (recent.length) {
    const known = state.closed.filter(c => c.plApprox !== null);
    const score = (xs: ClosedRecord[]) => `${xs.length} closed, ${xs.filter(c => (c.plApprox ?? 0) > 0).length} won, net ${fmt(xs.reduce((t, c) => t + (c.plApprox ?? 0), 0), 2)}`;
    lines.push('');
    lines.push('## Your track record (learn from it — especially the losers)');
    lines.push(`Overall: ${score(known)} · full-size: ${score(known.filter(c => !c.probe))} · probes: ${score(known.filter(c => c.probe))}. (Mixed currencies: alpaca $, ig £.)`);
    lines.push('Recent closes, most recent last — what you expected vs what happened:');
    for (const c of recent) lines.push(`- ${new Date(c.closedAt).toISOString().slice(0, 10)} ${c.account} ${c.direction} ${c.symbol}${c.probe ? ' [probe]' : ''} entry ${c.entryPrice}, stop ${c.stopPrice}, held ${((c.closedAt - c.openedAt) / 86_400_000).toFixed(1)}d, P&L ${fmt(c.plApprox, 2)} — closed: ${c.closeReason} — your thesis was: ${c.reason.slice(0, 110)}${c.exitPlan ? ` — your exit plan was: ${c.exitPlan.slice(0, 110)}` : ''}`);
  }

  lines.push('');
  lines.push('## Market (daily bars; price USD)');
  lines.push('symbol | setup (code) | price | day% | vs open | vol (1.0=normal day) | >20d | >50d | 12w% | RSI | ATR% | off 52w high%');
  // Trimmed (2026-10-29, token cost): full rows only for shares that matter
  // this session. When Alpaca entries are in scope: held, watchlist extras,
  // any code setup, a move of 2%+, heavy volume or a stretched RSI. Otherwise
  // (Alpaca not reviewed, or US closed): held names and code setups only.
  // The rest are listed by name so Opus knows they were checked.
  const held = new Set(state.positions.map(p => p.symbol));
  const shares = [...metrics.values()].filter(x => !isIgOnly(x.symbol));
  const notable = (m: Metrics) => held.has(m.symbol) || setupOf(m, 'BUY') !== null || setupOf(m, 'SELL') !== null
    || (alpacaInScope && (state.watchlistExtra.includes(m.symbol) || Math.abs(m.dayChgPct) >= 2 || (m.volToday ?? 0) >= 1.5 || (m.rsi14 ?? 50) >= 75 || (m.rsi14 ?? 50) <= 30));
  const quiet = shares.filter(m => !notable(m)).map(m => m.symbol);
  for (const m of shares.filter(notable)) {
    lines.push(`${m.symbol} | ${setupLabel(m)} | ${fmt(m.price, 2)} | ${fmt(m.dayChgPct)} | ${m.aboveOpen === null ? '=' : m.aboveOpen ? 'above' : 'below'} | ${fmt(m.volToday, 2)} | ${m.price > m.sma20 ? 'Y' : 'N'} | ${m.price > m.sma50 ? 'Y' : 'N'} | ${fmt(m.trend12wPct)} | ${fmt(m.rsi14, 0)} | ${fmt(m.atrPct)} | ${fmt(m.offHigh52wPct)}`);
  }

  if (quiet.length) lines.push(`Not shown (no code setup${alpacaInScope ? ', no big move or volume' : ''}): ${quiet.join(', ')}`);

  const igOnly = [...metrics.values()].filter(x => isIgOnly(x.symbol));
  if (igOnly.length) {
    lines.push('');
    lines.push('## IG markets — indices, FX, commodities (ig_demo only; daily bars, prices in market units — IG quotes some in its own points, e.g. FX ×10,000; no exchange volume, so no volume rule; the 8%/12-week stock threshold does NOT apply here — a setup label means the trend test passed)');
    // IG client sentiment (2026-10-29): crowd positioning, shown as data.
    const sent = new Map((await getIgSentiment(IG_MARKETS).catch(() => [])).map(r => [r.key, r.longPct]));
    lines.push('IG clients long% = share of IG clients long that market. These are retail traders: small, mostly short-term, and they barely move these markets next to institutions. Treat it as minor background at most (an extreme reading is a tie-breaker, never a reason on its own to open, close or flip a trade). The institutional positioning further down (CFTC) carries far more weight.');
    lines.push('symbol (name) | setup (code) | price | day% | vs open | >20d | >50d | 12w% | RSI | ATR% | off 52w high% | IG clients long%');
    for (const m of igOnly) lines.push(`${m.symbol} (${IG_MARKETS[m.symbol].name}) | ${setupLabel(m)} | ${fmt(m.price, 4)} | ${fmt(m.dayChgPct)} | ${m.aboveOpen === null ? '=' : m.aboveOpen ? 'above' : 'below'} | ${m.price > m.sma20 ? 'Y' : 'N'} | ${m.price > m.sma50 ? 'Y' : 'N'} | ${fmt(m.trend12wPct)} | ${fmt(m.rsi14, 0)} | ${fmt(m.atrPct)} | ${fmt(m.offHigh52wPct)} | ${sent.has(m.symbol) ? sent.get(m.symbol)!.toFixed(0) : '—'}`);
  }

  // Headlines: open positions + the most active names today (keeps tokens bounded)
  const active = [...metrics.values()].filter(m => m.volToday !== null)
    .sort((a, b) => Math.abs(b.dayChgPct) * (b.volToday ?? 0) - Math.abs(a.dayChgPct) * (a.volToday ?? 0))
    .slice(0, alpacaInScope ? 6 : 3).map(m => m.symbol);
  const newsFor = [...new Set([...state.positions.map(p => p.symbol), ...active])].slice(0, 10);
  lines.push('');
  lines.push('## Recent headlines');
  for (const s of newsFor) {
    let h: string[] = [];
    try { h = await fetchAllHeadlines(s, 2); } catch { /* none */ }
    if (h.length) lines.push(`${s}: ${h.map(x => x.slice(0, 120)).join(' | ')}`);
  }

  lines.push('');
  // Big-speculator positioning from the CFTC (2026-10-29), weekly.
  const cotRows = await getCot().catch(() => [] as Awaited<ReturnType<typeof getCot>>);
  if (cotRows.length) {
    lines.push('');
    lines.push(`## Big-speculator positioning (CFTC Commitments of Traders, weekly, positions as of ${cotRows[0].reportDate})`);
    lines.push('Where the big players are positioned in the US futures behind each IG market. Indices and FX: ASSET MANAGERS (pensions, mutual funds: slow, real money) first, then hedge funds (faster, trend-following money). Commodities and silver: large speculators (funds). Each shows % of positions long, net contracts and the change over the week. This is where the big money is positioned, so it matters far more than the retail IG numbers above, and the weekly change shows which way it is moving. It is still slow context, not a timing signal: weigh it with price, trend and news, and note that very lopsided positioning can unwind sharply.');
    const sg = (n: number) => `${n >= 0 ? '+' : ''}${n.toLocaleString('en-US')}`;
    for (const c of cotRows) lines.push(c.source === 'tff'
      ? `- ${c.key} (${c.market}): asset managers ${c.specLongPct}% long (net ${sg(c.specNet)}, week ${sg(c.netChangeWeek)}); hedge funds ${c.hfLongPct}% long (week ${sg(c.hfNetChangeWeek ?? 0)})${c.note ? ` (${c.note})` : ''}`
      : `- ${c.key} (${c.market}): large speculators ${c.specLongPct}% long (net ${sg(c.specNet)}, week ${sg(c.netChangeWeek)})${c.note ? ` (${c.note})` : ''}`);
  }

  const tvRecent = state.tvAlerts.filter(a => Date.now() - new Date(a.ts).getTime() < 24 * 3_600_000);
  lines.push('## TradingView alerts (last 24h, newest last)');
  if (!tvRecent.length) lines.push('(none)');
  for (const a of tvRecent.slice(-12)) lines.push(`- ${a.ts.slice(5, 16).replace('T', ' ')} ${a.symbol} ${a.signal}${a.timeframe ? ` [${a.timeframe}]` : ''}${a.price !== null ? ` @ ${a.price}` : ''}${a.note ? ` — ${a.note}` : ''}`);
  lines.push('');
  lines.push('## Your strategy notes');
  lines.push(state.notes || '(none yet)');
  lines.push(`Extra watchlist: ${state.watchlistExtra.join(', ') || '(none)'}`);
  state.priceSnap = Object.fromEntries([...metrics.values()].map(m => [m.symbol, m.price]));
  return { text: lines.join('\n'), metrics };
}

function newId(): string { return Math.random().toString(36).slice(2, 8); }
const round2 = (n: number) => Math.round(n * 100) / 100;

// Set per session: whether new Alpaca entries are in scope (2026-10-21 — the
// owner treats Alpaca as long-term, so it needn't be re-thought every 30 min;
// IG/spread bets keep the full cadence). Alpaca stops stay at the broker.
let alpacaInScope = true;

async function openPosition(inp: { account: OpusAccount; symbol: string; direction: 'BUY' | 'SELL'; size: number; stop_loss_pct: number; conviction: number; reason: string; exit_plan?: string },
  metrics: Map<string, Metrics>): Promise<string> {
  const symbol = inp.symbol.toUpperCase().trim();
  if (!config.accounts[inp.account]) return `REJECTED: ${inp.account} is disabled.`;
  // Probes (2026-10-21, at the owner's request for this test period: "we need
  // it to trade even at a small position"). On the paper/demo accounts, a
  // conviction between probeMinConviction and minConviction still opens, at
  // probeSizePct of the normal size. Every hard rule still applies, and real
  // money (t212_live) never probes. Positions are tagged probe vs full so the
  // two can be compared once results are in.
  const probe = inp.conviction < config.minConviction;
  if (probe && (inp.account === 't212_live' || inp.conviction < config.probeMinConviction)) {
    return inp.account === 't212_live'
      ? `REJECTED: conviction ${inp.conviction} is below the ${config.minConviction} minimum (t212_live is real money, so there are no probes there).`
      : `REJECTED: conviction ${inp.conviction} is below the ${config.probeMinConviction} probe minimum.`;
  }
  const sizeFactor = probe ? config.probeSizePct / 100 : 1;
  const tag = probe ? ' [PROBE]' : '';
  if (!(inp.stop_loss_pct >= 2 && inp.stop_loss_pct <= 15)) return 'REJECTED: stop_loss_pct must be between 2 and 15.';
  if (!(inp.size > 0)) return 'REJECTED: size must be positive.';
  // Alpaca/T212 only in US hours; IG whenever IG itself says the market is
  // dealable (checked against its live marketStatus below) — per the owner,
  // IG trades can be round the clock, only Alpaca is tied to US hours.
  if (inp.account === 'alpaca_paper' && !alpacaInScope) return `REJECTED: Alpaca isn't reviewed this session (long-term account, considered every ${config.alpacaEveryMinutes} min) — next Alpaca review around ${new Date((state.lastAlpacaReviewAt ?? 0) + config.alpacaEveryMinutes * 60_000).toISOString().slice(11, 16)} UTC.`;
  if (!isUsSessionOpen() && inp.account === 'alpaca_paper') return `REJECTED: ${inp.account} only trades during US market hours — use ig_demo, or wait for the open.`;
  const m = metrics.get(symbol);
  if (!m) return `REJECTED: no market data for ${symbol} this session.`;
  // Volume in the trade's direction — enforced in code, never by the model.
  if (isIgOnly(symbol) && inp.account !== 'ig_demo') return `REJECTED: ${symbol} is an IG-only market — use ig_demo.`;
  // No strategy gate here (2026-10-22, owner's decision): the volume /
  // today-direction / pullback rules used to be enforced in code. They're now
  // shown to Opus as data and the entry decision is entirely its own. Only
  // the safety limits in this function remain.
  const cool = state.lastClosedAt[`${inp.account}:${symbol}`];
  if (cool && Date.now() - cool < config.reentryCooldownHours * 3_600_000) return `REJECTED: closed ${symbol} on ${inp.account} ${((Date.now() - cool) / 3_600_000).toFixed(1)}h ago — cooldown is ${config.reentryCooldownHours}h.`;
  if (inp.account === 'alpaca_paper' && !config.alpacaStocks) return 'REJECTED: alpaca_paper is for options now (the owner\'s decision, 2026-10-29). Use option_chain and open_option.';
  if (state.positions.some(p => p.account === inp.account && p.symbol === symbol && !p.option)) return `REJECTED: you already hold ${symbol} on ${inp.account}.`;
  const mine = state.positions.filter(p => p.account === inp.account);

  try {
    if (inp.account === 'alpaca_paper') {
      if (mine.length >= config.alpacaMaxPositions) return `REJECTED: already at ${config.alpacaMaxPositions} alpaca_paper positions.`;
      const usd = Math.min(inp.size, config.alpacaMaxPositionUsd) * sizeFactor;
      const qty = Math.floor(usd / m.price);
      if (qty < 1) return `REJECTED: $${usd} buys less than one share at $${m.price.toFixed(2)}.`;
      const stop = round2(inp.direction === 'BUY' ? m.price * (1 - inp.stop_loss_pct / 100) : m.price * (1 + inp.stop_loss_pct / 100));
      await alpacaPlaceOrder('paper', {
        symbol, qty, side: inp.direction === 'BUY' ? 'buy' : 'sell', type: 'market', time_in_force: 'gtc', // OTO legs inherit this — 'day' made the stop expire at the close
        order_class: 'oto', stop_loss: { stop_price: stop }, client_order_id: `opus-${symbol}-${Date.now()}`,
      });
      const p: OpusPosition = { id: newId(), account: 'alpaca_paper', symbol, brokerRef: symbol, direction: inp.direction, size: qty,
        entryPrice: m.price, stopPrice: stop, openedAt: Date.now(), conviction: inp.conviction, reason: inp.reason, exitPlan: inp.exit_plan, probe };
      state.positions.push(p); saveState();
      addLog('enter', `alpaca_paper${tag} ${inp.direction} ${qty} ${symbol} @~$${m.price.toFixed(2)} stop $${stop} (conviction ${inp.conviction}) — ${inp.reason}`);
      return `OPENED id=${p.id}: ${inp.direction} ${qty} ${symbol} @~$${m.price.toFixed(2)}, stop $${stop}.`;
    }

    if (inp.account === 'ig_demo') {
      if (mine.length >= config.igMaxPositions) return `REJECTED: already at ${config.igMaxPositions} ig_demo positions.`;
      const epic = TICKER_TO_EPIC[symbol];
      if (epic && (await igEpicsOwnedElsewhere()).has(epic)) return `REJECTED: ${symbol} is managed by another bot on this account.`;
      if (!epic) return `REJECTED: ${symbol} has no IG market mapping.`;
      const session = await ig();
      const d = (await fetchMarketDetails(session, [epic])).get(epic);
      const px = inp.direction === 'BUY' ? d?.offer : d?.bid;
      if (d?.marketStatus && d.marketStatus !== 'TRADEABLE') return `REJECTED: IG says ${symbol} is ${d.marketStatus} right now.`;
      if (typeof px !== 'number' || !(px > 0)) return `REJECTED: no live IG quote for ${symbol} right now.`;
      const minStop = d?.minStopDist || 1, minDeal = d?.minDealSize || 0.5;
      const stopDist = Math.max(minStop, px * inp.stop_loss_pct / 100);
      // US shares (2026-10-29): IG quotes them in cents, so £1/pt = £100 per $1
      // move and IG's minimum stake (~0.24/pt) already risks a few hundred pounds
      // on a normal stop. Shares are sized by risk under their own, wider cap; the
      // fixed £/pt stake applies to indices, FX and commodities only.
      const isShare = !isIgOnly(symbol);
      const bal = (await fetchAccountFunds(session).catch(() => ({ balance: 0 }))).balance;
      const igCap = Math.max(config.igMaxRiskGbp, bal * (isShare ? config.igShareMaxRiskPct : config.igMaxRiskPct) / 100);
      // Floor at igMinRiskGbp (2026-10-29: probes were going on at ~0.05/pt,
      // too small to show anything; the Momentum Testbot risks ~£20 a trade).
      const riskGbp = Math.min(igCap, Math.max(config.igMinRiskGbp, Math.min(inp.size, igCap) * sizeFactor));
      // Owner, 2026-10-29: open IG trades at a fixed £/pt (like the Testbot's
      // GBP/USD at £1/pt) rather than tiny risk-sized stakes. If that stake with
      // this stop would risk more than the cap, it is lowered to fit the cap.
      const stake = config.igStakePerPoint > 0 && !isShare
        ? Math.max(minDeal, Math.min(config.igStakePerPoint, Math.floor(igCap / stopDist * 100) / 100))
        : Math.max(minDeal, calcStake(riskGbp, stopDist, minDeal));
      if (stake * stopDist > igCap * (isShare ? 1 : 1.5)) return `REJECTED: IG's minimum stake (${minDeal}/pt) with a ${inp.stop_loss_pct}% stop risks £${(stake * stopDist).toFixed(0)}, above the £${igCap.toFixed(0)} cap — try a tighter stop or another market.`;
      let r: { dealId: string; level: number };
      try {
        r = await igPlaceOrder(session, epic, inp.direction, stake, stopDist, undefined, 'GBP', false);
      } catch (e) {
        // 2026-10-22: IG answered "Deal REJECTED: unknown" for an EU Stocks 50
        // order that had in fact opened. Opus retried smaller and ended up with
        // two shorts, one untracked. Before treating a rejection as final,
        // check whether a matching deal appeared in the last two minutes.
        await new Promise(res => setTimeout(res, 2500));
        // Never mistake the Momentum Testbot's deal (same account) for this one.
        const known = new Set([...state.positions.map(p => p.brokerRef), ...momentumBotDealIds()]);
        const fresh = (await fetchPositions(session).catch(() => [])).find(x => x.epic === epic && x.direction === inp.direction && !known.has(x.dealId) && x.size === stake
          && (!x.createdUtc || Date.now() - Date.parse(x.createdUtc + 'Z') < 120_000));
        if (!fresh) throw e;
        addLog('info', `IG reported "${e instanceof Error ? e.message : String(e)}" but deal ${fresh.dealId} did open — tracking it instead of re-ordering`);
        r = { dealId: fresh.dealId, level: fresh.level };
      }
      const stop = inp.direction === 'BUY' ? r.level - stopDist : r.level + stopDist;
      const p: OpusPosition = { id: newId(), account: 'ig_demo', symbol, brokerRef: r.dealId, epic, direction: inp.direction, size: stake,
        entryPrice: r.level, stopPrice: round2(stop), openedAt: Date.now(), conviction: inp.conviction, reason: inp.reason, exitPlan: inp.exit_plan, probe };
      state.positions.push(p); saveState();
      addLog('enter', `ig_demo${tag} ${inp.direction} ${symbol} £${stake}/pt @ ${r.level} stop ${round2(stop)} (risk ≈ £${(stake * stopDist).toFixed(2)}, conviction ${inp.conviction}) — ${inp.reason}`);
      return `OPENED id=${p.id}: ${inp.direction} ${symbol} £${stake}/pt @ ${r.level} (IG points), stop ${round2(stop)}, risk ≈ £${(stake * stopDist).toFixed(2)}.`;
    }

    // t212_live — real money, long only
    if (inp.direction !== 'BUY') return 'REJECTED: t212_live is long only (ISA).';
    if (mine.length >= config.t212MaxPositions) return `REJECTED: already at ${config.t212MaxPositions} t212_live positions.`;
    const gbp = Math.min(inp.size, config.t212MaxPositionGbp);
    const committed = mine.reduce((s, p) => s + (p.size * p.entryPrice), 0); // in instrument currency (USD) — converted below
    const gbpUsd = await getGbpUsd();
    if (committed / gbpUsd + gbp > config.t212MaxTotalGbp) return `REJECTED: would take your T212 total above £${config.t212MaxTotalGbp}.`;
    const cash = await getCash('live', { fresh: true });
    if (cash.free < gbp) return `REJECTED: only £${cash.free.toFixed(0)} free cash on T212.`;
    const ticker = await resolveT212Ticker('live', symbol);
    if (!ticker) return `REJECTED: ${symbol} isn't tradeable on T212.`;
    const qty = Math.floor(((gbp * gbpUsd) / m.price) * 10000) / 10000;
    if (!(qty > 0)) return 'REJECTED: size too small.';
    await t212PlaceOrder('live', ticker, qty);
    const stop = round2(m.price * (1 - inp.stop_loss_pct / 100));
    let stopOrderId: string | undefined;
    try { const o = await placeStopLimitOrder('live', ticker, -qty, stop, round2(stop * 0.97)); stopOrderId = o.id !== undefined ? String(o.id) : undefined; }
    catch (e) { addLog('error', `t212_live ${symbol} stop-limit failed (position open without a broker stop until retried): ${e instanceof Error ? e.message : String(e)}`); }
    const p: OpusPosition = { id: newId(), account: 't212_live', symbol, brokerRef: ticker, direction: 'BUY', size: qty,
      entryPrice: m.price, stopPrice: stop, stopOrderId, openedAt: Date.now(), conviction: inp.conviction, reason: inp.reason, exitPlan: inp.exit_plan };
    state.positions.push(p); saveState();
    addLog('enter', `t212_live BUY ${qty} ${symbol} (£${gbp}) @~$${m.price.toFixed(2)} stop $${stop} (conviction ${inp.conviction}) — ${inp.reason}`);
    return `OPENED id=${p.id}: BUY ${qty} ${symbol} (£${gbp}) on T212 (real money), stop $${stop}.`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    addLog('error', `${inp.account} ${symbol} open failed: ${msg}`);
    return `FAILED at the broker: ${msg}`;
  }
}

// ── Entry setups (2026-10-21) ───────────────────────────────────────────────
// Per the owner's request for entries that come before a move, not after it.
// Two setups are computed by code, never by the AI:
//   breakout: the existing style. The trend is up, price is above its 20-day
//             average, and today is a with-trend day (for shares, also at
//             least a normal day's volume).
//   pullback: the trend is up, but price has dipped back into the zone around
//             its 20-day average (between 1.5 ATR below and 0.5 ATR above),
//             RSI is below 55, and today is turning back up (above the open).
// Shorts mirror both. Backtest (2026-10-21, 15 large caps, 3y, exit below the
// 50-day, 10% stop): breakout 169 trades averaging +3.5% (avg loss −4.4%);
// pullback-turning-up 116 trades averaging +3.2% (avg loss −3.6%). Per trade
// the edge is similar, but the pullbacks are mostly different days, so they
// add entry opportunities rather than replacing the breakout.
// The "trend" part: for shares, 12-week change ≥ +8% (≤ −8% for shorts) and
// price beyond the 50-day. FX and index ranges are smaller, so the IG-only
// markets use the 20-day vs 50-day average ordering instead.
type Setup = 'breakout' | 'pullback';
function setupOf(m: Metrics, dir: 'BUY' | 'SELL'): Setup | null {
  const long = dir === 'BUY';
  const ig = isIgOnly(m.symbol);
  const beyond50 = long ? m.price > m.sma50 : m.price < m.sma50;
  const trendOk = beyond50 && (ig
    ? (long ? m.sma20 > m.sma50 : m.sma20 < m.sma50)
    : (m.trend12wPct !== null && (long ? m.trend12wPct >= 8 : m.trend12wPct <= -8)));
  if (!trendOk) return null;
  const withTrendToday = m.aboveOpen === (long ? true : false);
  if (!withTrendToday) return null;
  const atr = m.atrPct !== null ? m.price * m.atrPct / 100 : m.price * 0.02;
  const inZone = long
    ? m.price >= m.sma20 - 1.5 * atr && m.price <= m.sma20 + 0.5 * atr
    : m.price <= m.sma20 + 1.5 * atr && m.price >= m.sma20 - 0.5 * atr;
  const rsiOk = m.rsi14 !== null && (long ? m.rsi14 < 55 : m.rsi14 > 45);
  if (inZone && rsiOk) return 'pullback';
  const past20 = long ? m.price > m.sma20 : m.price < m.sma20;
  const volOk = ig || (m.volToday !== null && m.volToday >= 1.0);
  if (past20 && volOk) return 'breakout';
  return null;
}
const setupLabel = (m: Metrics): string => {
  const l = setupOf(m, 'BUY'), sh = setupOf(m, 'SELL');
  return l ? `${l === 'breakout' ? 'BREAKOUT' : 'PULLBACK'} long` : sh ? `${sh === 'breakout' ? 'BREAKOUT' : 'PULLBACK'} short` : '-';
};

function todayAgainstFromMetrics(m: Metrics, dir: 'BUY' | 'SELL'): boolean {
  if (m.aboveOpen === null) return true;  // flat vs open = no directional confirmation
  return dir === 'BUY' ? !m.aboveOpen : m.aboveOpen;
}

// ── Options on Alpaca (2026-10-29, owner: Alpaca should trade options) ──────

function dteOf(expiry: string): number { return Math.round((Date.parse(expiry + 'T21:00:00Z') - Date.now()) / 86_400_000); }

async function optionChainTool(input: Record<string, unknown>): Promise<string> {
  const symbol = String(input.symbol ?? '').toUpperCase().trim();
  const type = input.type === 'put' ? 'put' : 'call';
  if (isIgOnly(symbol) || !/^[A-Z.]{1,6}$/.test(symbol)) return 'REJECTED: option chains are for US stocks/ETFs only.';
  const m = await metricsFor(symbol);
  if (!m) return `REJECTED: no market data for ${symbol}.`;
  const minDte = Math.max(config.optionMinDte, Number(input.min_dte) || config.optionMinDte);
  const maxDte = Math.max(minDte + 7, Math.min(400, Number(input.max_dte) || 180));
  const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  let rows;
  try { rows = await getOptionChain(symbol, type, day(minDte), day(maxDte), m.price * 0.85, m.price * 1.15, 'paper'); }
  catch (e) { return `FAILED: ${e instanceof Error ? e.message : String(e)}`; }
  rows = rows.filter(r => r.ask > 0);
  if (!rows.length) return `No quoted ${type}s for ${symbol} between ${minDte} and ${maxDte} days.`;
  // Up to 4 expiries spread across the window, 7 strikes nearest the money each.
  const expiries = [...new Set(rows.map(r => r.expiry))].sort();
  const pick = expiries.length <= 4 ? expiries : [0, 1, 2, 3].map(i => expiries[Math.round(i * (expiries.length - 1) / 3)]);
  const flowText = await getOptionsFlow(symbol, m.price).then(describeFlow).catch(() => '(options positioning unavailable)');
  const out = [flowText, '', `${symbol} ${type}s, underlying $${m.price.toFixed(2)} (contract = 100 shares; cost = ask × 100):`, 'contract | expiry (days) | strike | bid | ask | spread% | delta | IV'];
  for (const e of [...new Set(pick)]) {
    const near = rows.filter(r => r.expiry === e).sort((a, b) => Math.abs(a.strike - m.price) - Math.abs(b.strike - m.price)).slice(0, 7).sort((a, b) => a.strike - b.strike);
    for (const r of near) {
      const mid = (r.bid + r.ask) / 2;
      out.push(`${r.symbol} | ${r.expiry} (${dteOf(r.expiry)}) | ${r.strike} | ${r.bid.toFixed(2)} | ${r.ask.toFixed(2)} | ${mid > 0 ? ((r.ask - r.bid) / mid * 100).toFixed(0) : '—'} | ${r.delta !== null ? r.delta.toFixed(2) : '—'} | ${r.iv !== null ? (r.iv * 100).toFixed(0) + '%' : '—'}`);
    }
  }
  return out.join('\n');
}

async function openOption(inp: { contract: string; contracts: number; stop_loss_pct: number; conviction: number; reason: string; exit_plan: string; news_and_macro?: string }, metrics: Map<string, Metrics>): Promise<string> {
  if (!config.accounts.alpaca_paper) return 'REJECTED: alpaca_paper is disabled.';
  // Owner, 2026-10-29: chart analysis alone isn't enough for options; each
  // entry needs news and macro backing from research done this session.
  if (config.webResearch && sessionResearchUsed < 1) return 'REJECTED: option entries need news and macro backing. Search this session for the company\'s latest news/catalysts and the macro backdrop first, then try again.';
  if (!inp.news_and_macro || inp.news_and_macro.trim().length < 40) return 'REJECTED: news_and_macro must summarise the news catalyst and macro backdrop behind this trade.';
  if (!alpacaInScope) return `REJECTED: Alpaca isn't reviewed this session (considered every ${config.alpacaEveryMinutes} min).`;
  if (!isUsSessionOpen()) return 'REJECTED: options only trade during US market hours.';
  const occ = String(inp.contract ?? '').toUpperCase().trim();
  const mm = occ.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!mm) return 'REJECTED: contract must be an OCC symbol from option_chain.';
  const underlying = mm[1], expiry = `20${mm[2]}-${mm[3]}-${mm[4]}`, type = mm[5] === 'C' ? 'call' as const : 'put' as const, strike = parseInt(mm[6], 10) / 1000;
  if (inp.conviction < config.probeMinConviction) return `REJECTED: conviction ${inp.conviction} is below the minimum (${config.probeMinConviction}).`;
  const probe = inp.conviction < config.minConviction;
  const sizeFactor = probe ? config.probeSizePct / 100 : 1;
  if (!(inp.stop_loss_pct >= 20 && inp.stop_loss_pct <= 70)) return 'REJECTED: stop_loss_pct for an option must be between 20 and 70.';
  if (!(Number.isInteger(inp.contracts) && inp.contracts >= 1)) return 'REJECTED: contracts must be a whole number ≥ 1.';
  const dte = dteOf(expiry);
  if (dte < config.optionMinDte) return `REJECTED: ${dte} days to expiry; the minimum is ${config.optionMinDte}.`;
  if (!metrics.get(underlying) && !(await metricsFor(underlying))) return `REJECTED: no market data for ${underlying}.`;
  const optOpen = state.positions.filter(p => p.option);
  if (optOpen.length >= config.optionMaxPositions) return `REJECTED: already at ${config.optionMaxPositions} option positions.`;
  if (optOpen.some(p => p.brokerRef === occ)) return 'REJECTED: you already hold that contract.';
  const cool = state.lastClosedAt[`alpaca_paper:${occ}`];
  if (cool && Date.now() - cool < config.reentryCooldownHours * 3_600_000) return `REJECTED: closed that contract ${((Date.now() - cool) / 3_600_000).toFixed(1)}h ago; cooldown is ${config.reentryCooldownHours}h.`;
  const q = await getOptionQuote(occ, 'paper');
  if (!q || !(q.ask > 0)) return 'REJECTED: no live quote for that contract.';
  const mid = (q.ask + q.bid) / 2;
  if (!(q.bid > 0) || (q.ask - q.bid) / mid > 0.15) return `REJECTED: too illiquid to trade fairly (bid ${q.bid}, ask ${q.ask}; spread over 15% of the price). Pick a contract with a tighter spread.`;
  const cap = config.optionMaxPremiumUsd * sizeFactor;
  const perContract = q.ask * 100;
  const spent = optOpen.reduce((t, p) => t + p.entryPrice * p.size * 100, 0);
  const qty = Math.min(inp.contracts, Math.floor(cap / perContract), Math.floor((config.optionMaxTotalUsd - spent) / perContract));
  if (qty < 1) return `REJECTED: one contract costs $${perContract.toFixed(0)}; the limit allows $${Math.min(cap, config.optionMaxTotalUsd - spent).toFixed(0)}${probe ? ' (probe size)' : ''}. Pick a cheaper contract.`;
  try {
    const order = await alpacaPlaceOrder('paper', { symbol: occ, qty, side: 'buy', type: 'limit', limit_price: q.ask, time_in_force: 'day', client_order_id: `opus-opt-${occ}-${Date.now()}` });
    let o = order;
    for (let i = 0; i < 8 && o.status !== 'filled'; i++) { await new Promise(r => setTimeout(r, 1500)); o = await alpacaGetOrder('paper', order.id); }
    const filled = parseFloat(o.filled_qty || '0');
    if (o.status !== 'filled') await alpacaCancelOrder('paper', order.id).catch(() => undefined);
    if (!(filled >= 1)) return `REJECTED: not filled at the ask ($${q.ask}) within 12s; order cancelled. The price may have moved; try again later or another contract.`;
    const paid = parseFloat(o.filled_avg_price ?? String(q.ask));
    const stop = round2(paid * (1 - inp.stop_loss_pct / 100));
    const p: OpusPosition = { id: newId(), account: 'alpaca_paper', symbol: underlying, brokerRef: occ, direction: 'BUY', size: filled,
      entryPrice: paid, stopPrice: stop, openedAt: Date.now(), conviction: inp.conviction, reason: `${inp.reason} | News/macro: ${inp.news_and_macro}`, exitPlan: inp.exit_plan, probe,
      option: { type, strike, expiry } };
    state.positions.push(p); saveState();
    const tag = probe ? ' [PROBE]' : '';
    addLog('enter', `alpaca_paper${tag} OPTION bought ${filled} × ${underlying} ${expiry} ${strike} ${type} (${occ}) @ $${paid} = $${(paid * filled * 100).toFixed(0)}, stop $${stop} (conviction ${inp.conviction}) — ${inp.reason}`);
    return `OPENED id=${p.id}: ${filled} × ${occ} @ $${paid} ($${(paid * filled * 100).toFixed(0)} total), stop $${stop} on the option price, ${dte} days to expiry.`;
  } catch (e) {
    return `FAILED at the broker: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// Code-watched option stops and the pre-expiry sale. Alpaca has no stop
// orders for options, so this checks every 5 minutes in US hours. A stop
// needs two checks in a row at or below it, so one bad quote can't trigger it.
const optionStopHits = new Map<string, number>();
let optionWatchTimer: ReturnType<typeof setInterval> | null = null;
async function watchOptions(): Promise<void> {
  if (!running || busy || !isUsSessionOpen()) return;
  const opts = state.positions.filter(p => p.option);
  if (!opts.length) return;
  const view = await livePositionView().catch(() => new Map<string, LivePos>());
  for (const p of opts) {
    const dte = dteOf(p.option!.expiry);
    if (dte <= config.optionCloseDte) {
      const r = await closePosition(p.id, `[code] ${dte} days to expiry: sold before the final week`, view, true);
      addLog('exit', `Option ${p.brokerRef}: ${r}`);
      continue;
    }
    const q = await getOptionQuote(p.brokerRef, 'paper').catch(() => null);
    if (!q || !(q.bid > 0)) continue;
    if (q.bid <= p.stopPrice) {
      const hits = (optionStopHits.get(p.id) ?? 0) + 1;
      optionStopHits.set(p.id, hits);
      if (hits >= 2) {
        const r = await closePosition(p.id, `[code stop] option bid $${q.bid} at or below the stop $${p.stopPrice}`, view, true);
        addLog('exit', `Option ${p.brokerRef}: ${r}`);
        optionStopHits.delete(p.id);
      }
    } else optionStopHits.delete(p.id);
  }
}

// Opus's lock-in-profit tool (2026-10-23, owner: "lock in profit" for winners,
// decided by Opus rather than an automatic floor). Code only checks the stop
// moves in the safe direction and stays on the losing side of the price.
async function tightenStop(id: string, newStop: number, reason: string, view: Map<string, LivePos>): Promise<string> {
  const p = state.positions.find(x => x.id === id);
  if (!p) return `REJECTED: no open position with id ${id}.`;
  if (!(newStop > 0)) return 'REJECTED: new_stop must be a positive price.';
  const long = p.direction === 'BUY';
  if (long ? newStop <= p.stopPrice : newStop >= p.stopPrice) return `REJECTED: that would loosen the stop (now ${p.stopPrice}); stops can only be tightened.`;
  const now = view.get(id)?.current ?? null;
  if (now !== null && (long ? newStop >= now : newStop <= now)) return `REJECTED: a stop at ${newStop} is already through the current price (${now}), so it would close the position at once. Use close_position instead.`;
  const stop = round2(newStop);
  if (p.option) {
    const prevO = p.stopPrice;
    p.stopPrice = stop; saveState();
    addLog('info', `Option stop tightened: ${p.brokerRef} ${prevO} → ${stop} — ${reason}`);
    return `OK: ${p.brokerRef} stop moved ${prevO} → ${stop} (option price; code sells if the bid reaches it).`;
  }
  try {
    if (p.account === 'ig_demo') {
      const session = await ig();
      const x = (await fetchPositions(session)).find(q => q.dealId === p.brokerRef);
      if (!x) return 'REJECTED: the position is no longer open at IG.';
      await updatePositionLevels(session, p.brokerRef, stop, x.limitLevel ?? null);   // keep any profit target
    } else if (p.account === 'alpaca_paper') {
      if (!isUsSessionOpen()) return 'REJECTED: the US market is closed. Alpaca stops can be moved in market hours (the current stop stays active).';
      const old = (await alpacaGetOrders('paper', 'open')).filter(o => o.symbol === p.brokerRef && o.side === (long ? 'sell' : 'buy') && /stop/.test(o.type));
      for (const o of old) await alpacaCancelOrder('paper', o.id);
      await alpacaPlaceOrder('paper', { symbol: p.brokerRef, qty: p.size, side: long ? 'sell' : 'buy', type: 'stop', stop_price: stop, time_in_force: 'gtc', client_order_id: `opus-stop-${p.brokerRef}-${Date.now()}` });
    } else {
      // t212_live (real money): replace the stop-limit order.
      if (p.stopOrderId) await t212CancelOrder('live', p.stopOrderId).catch(() => undefined);
      const o = await placeStopLimitOrder('live', p.brokerRef, -p.size, stop, round2(stop * 0.97));
      p.stopOrderId = o.id !== undefined ? String(o.id) : undefined;
    }
  } catch (e) {
    return `FAILED: couldn't move the stop at the broker (${e instanceof Error ? e.message : String(e)}). The old stop is still in place.`;
  }
  const prev = p.stopPrice;
  p.stopPrice = stop; saveState();
  addLog('info', `Stop tightened: ${p.account} ${p.symbol} ${prev} → ${stop} — ${reason}`);
  return `OK: ${p.symbol} stop moved ${prev} → ${stop} at the broker.`;
}

async function closePosition(id: string, reason: string, view: Map<string, LivePos>, manual = false): Promise<string> {
  const p = state.positions.find(x => x.id === id);
  if (!p) return `REJECTED: no open position with id ${id}.`;
  const heldH = (Date.now() - p.openedAt) / 3_600_000;
  if (!manual && heldH < config.minHoldHours) return `REJECTED: held ${heldH.toFixed(1)}h — minimum hold is ${config.minHoldHours}h (the stop still protects it).`;
  // Alpaca closes only while the US market is open (2026-10-21; T212 trades
  // round the clock, per the owner, so it isn't restricted). Off
  // hours this would cancel the protective stop and leave a market sell queued
  // for the open, whatever happened overnight. Re-decide in session instead.
  if (p.account === 'alpaca_paper' && !isUsSessionOpen()) return `REJECTED: the US market is closed — ${p.account} positions can only be closed in market hours (the broker stop still protects it). Re-check this at the open.`;
  const pl = view.get(id)?.pl ?? null;
  try {
    if (p.account === 'alpaca_paper') {
      await cancelOrdersForSymbol('paper', p.brokerRef).catch(() => 0);
      await alpacaClosePosition('paper', p.brokerRef);
    } else if (p.account === 'ig_demo') {
      await igClosePosition(await ig(), p.brokerRef, p.direction, p.size);
    } else {
      if (p.stopOrderId) await t212CancelOrder('live', p.stopOrderId).catch(() => undefined);
      await t212PlaceOrder('live', p.brokerRef, -p.size);
    }
    markClosed(p, `${manual ? '[manual] ' : ''}${reason}`, pl);
    return `CLOSED ${p.symbol} on ${p.account}${pl !== null ? ` (P&L ≈ ${pl.toFixed(2)})` : ''}.`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    addLog('error', `${p.account} ${p.symbol} close failed: ${msg}`);
    return `FAILED at the broker: ${msg}`;
  }
}

// ── Session loop ────────────────────────────────────────────────────────────

let client: Anthropic | null = null;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let nextRunAt: number | null = null;
let lastRunAt: string | null = null;
let busy = false;
// Per-session flags (2026-10-29): routine check-ins run on the cheaper model
// and can't open trades (they escalate to Opus); option entries need research
// done in the same session.
let routineSession = false;
let escalateReason: string | null = null;
let sessionResearchUsed = 0;

const MAX_TURNS = 10;
const MAX_BACKTESTS_PER_SESSION = 4;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// One model call. Server-side fallback ("default") is on: if the model
// declines for policy reasons, the API re-runs the request on a suitable
// substitute inside the same call instead of the session just stopping.
function toolsFor(searches: number): Anthropic.Beta.BetaToolUnion[] {
  const base: Anthropic.Beta.BetaToolUnion[] = tvChartsOn() ? [...TOOLS, TV_TOOL] : TOOLS;
  if (!config.webResearch || searches <= 0) return base;
  // Fixed per-request ceiling (not the session allowance): a different max_uses
  // would change the tool definitions and miss the cache.
  searches = Math.max(config.researchSearches, config.searchesPerSession);
  return [
    ...base,
    // Anthropic-hosted research tools (2026-10-21, per explicit request that
    // Opus do its own research). max_uses caps cost per request.
    { type: 'web_search_20260209', name: 'web_search', max_uses: searches },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: searches },
  ];
}

// 1-hour cache on the fixed prefix (tools + system, ~12k tokens) when the next
// session is due within the hour; off-hours sessions are hours apart, where a
// 1-hour write (2× price) would expire unused, so those keep 5 minutes.
function cacheTtl(): '1h' | '5m' {
  return config.cacheOneHour && isUsSessionOpen() && scheduleMinutes() < 60 ? '1h' : '5m';
}

async function callModel(model: OpusModel, system: string, messages: Anthropic.Beta.BetaMessageParam[], searches = 0, ttl: '1h' | '5m' = '5m'): Promise<Anthropic.Beta.BetaMessage> {
  client ??= new Anthropic();
  return client.beta.messages.create({
    model,
    max_tokens: 16000,
    output_config: { effort: config.effort },
    // Caching (2026-10-29, usage was too high: cache writes were 3.5× reads).
    // The system breakpoint covers tools + system; the top-level marker moves
    // to the end of the conversation each turn, so the briefing and earlier
    // turns are read from cache instead of re-sent at full price.
    cache_control: { type: 'ephemeral' },
    system: [{ type: 'text', text: system, cache_control: ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' } }],
    tools: toolsFor(searches),
    messages,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
  });
}

// ── Shadow model ────────────────────────────────────────────────────────────
// Same briefing, one turn, nothing executed — its intended actions are logged
// with the price at decision time so the two models can be compared on what
// actually happened next (2026-10-21, per explicit request).

const SHADOW_FILE = path.join(ROOT, 'opus-shadow.json');
type ShadowDecision = { ts: string; model: OpusModel; tool: string; input: Record<string, unknown>; priceAtDecision: number | null };

async function runShadow(model: OpusModel, briefing: string, metrics: Map<string, Metrics>): Promise<number> {
  const system = `${SYSTEM_PROMPT}

SHADOW MODE: you are being evaluated alongside another manager on the same briefing. Your tool calls are recorded but NOT executed and you will not see their results — decide exactly as you would if they were real, in one response.`;
  const resp = await callModel(model, system, [{ role: 'user', content: briefing }]);
  const usd = recordUsage(model, resp.usage);
  const decisions = readJson<ShadowDecision[]>(SHADOW_FILE, []);
  let n = 0;
  for (const b of resp.content) {
    if (b.type !== 'tool_use') continue;
    const input = b.input as Record<string, unknown>;
    const sym = typeof input.symbol === 'string' ? input.symbol.toUpperCase() : null;
    decisions.push({ ts: new Date().toISOString(), model, tool: b.name, input, priceAtDecision: sym ? metrics.get(sym)?.price ?? null : null });
    n++;
    if (b.name === 'open_position') addLog('think', `[shadow ${MODELS[model].label}] would ${input.direction} ${input.symbol} on ${input.account} (conviction ${input.conviction}) — ${input.reason}`);
    else if (b.name === 'close_position') addLog('think', `[shadow ${MODELS[model].label}] would close ${input.position_id} — ${input.reason}`);
  }
  writeJson(SHADOW_FILE, decisions.slice(-1000));
  addLog('info', `[shadow ${MODELS[model].label}] ${n} intended action(s), cost $${usd.toFixed(3)}`);
  return usd;
}

function nyDate(d = new Date()): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d); }

const RESEARCH_PROMPT = `

DAILY RESEARCH SESSION: this is your first session of the trading day. You have a larger web research allowance. Use it on what matters most: material news, earnings dates, guidance or analyst changes for your open positions, then your strongest candidates. Prefer primary or reputable sources. Record the conclusions you want to carry through the day in your notes (concisely), then manage positions as usual.`;

export async function runOpusSession(trigger: 'scheduled' | 'manual' | 'tradingview' | 'escalated' = 'scheduled', why = ''): Promise<{ ok: boolean; error?: string }> {
  if (busy) return { ok: false, error: 'A session is already running' };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: 'ANTHROPIC_API_KEY is not set on the server' };
  if (budgetLeftUsd() <= 0.25) { addLog('wait', `Monthly cap reached ($${spend.usd.toFixed(2)} of $${config.monthlyCapUsd}) — no sessions until next month or a higher cap`); return { ok: false, error: 'Monthly budget reached' }; }
  busy = true;
  const started = Date.now();
  let model = config.model;
  let sessionUsd = 0;
  routineSession = false; escalateReason = null; sessionResearchUsed = 0;
  try {
    const view = await livePositionView();
    await reconcile(view);
    const research = config.webResearch && isUsSessionOpen() && nyDate() !== state.lastResearchDay;
    // Routine scheduled check-ins run on the cheaper model; research, TradingView
    // alerts, manual runs and escalations get the full model.
    if (trigger === 'scheduled' && !research && config.routineModel && config.routineModel !== config.model) { model = config.routineModel; routineSession = true; }
    // Owner, 2026-10-29: Sonnet for everything except the daily research session.
    if (research && config.researchModel && config.researchModel in MODELS) model = config.researchModel;
    state.lastSessionAt = Date.now();
    alpacaInScope = config.accounts.alpaca_paper && isUsSessionOpen()
      && (research || trigger === 'manual' || Date.now() - (state.lastAlpacaReviewAt ?? 0) >= config.alpacaEveryMinutes * 60_000 - 60_000);
    const { text, metrics } = await buildBriefing(view);
    spend.cycles++; saveSpend();
    if (research) { state.lastResearchDay = nyDate(); saveState(); }
    if (alpacaInScope) { state.lastAlpacaReviewAt = Date.now(); saveState(); }
    const searches = research ? config.researchSearches : config.searchesPerSession;
    // The system prompt and tool list are byte-identical across sessions so the
    // 1-hour cache carries over (2026-10-29). Anything session-specific (research
    // day, allowance, scope) goes in the user message instead.
    const system = SYSTEM_PROMPT + (tvChartsOn() ? TV_PROMPT : '');
    const allowanceNote = config.webResearch && searches > 0 ? `\n\nWEB RESEARCH ALLOWANCE THIS SESSION: ${searches} searches/fetches in total. Stay within it.` : '';
    if (trigger === 'scheduled') { lastScheduledAt = Date.now(); state.lastScheduledAt = lastScheduledAt; saveState(); }
    addLog('info', `Session started (${trigger}${research ? ', daily research' : ''}${config.accounts.alpaca_paper && isUsSessionOpen() ? (alpacaInScope ? ', incl. Alpaca' : ', IG only') : ''}, ${MODELS[model].label}, effort ${config.effort}) — ${metrics.size} symbols, ${state.positions.length} open positions${config.webResearch ? `, up to ${searches} web searches` : ''}`);
    const alpacaNote = alpacaInScope || !config.accounts.alpaca_paper || !isUsSessionOpen() ? '' : `

ALPACA NOT IN SCOPE THIS SESSION: Alpaca is the long-term account and is reviewed every ${config.alpacaEveryMinutes} minutes, not every session. Don't analyse Alpaca entries now (they'd be rejected); its positions keep their broker stops. Only close an Alpaca position if something material broke its thesis. Focus on ig_demo.`;
    const offNote = isUsSessionOpen() ? alpacaNote : `\n\nOFF-HOURS SESSION: the US market is closed. US-share figures above are from the last session. Alpaca can't trade now; ig_demo can trade any market IG has open (indices, FX and commodities nearly round the clock; IG's US shares only when IG offers them out of hours — an order on a closed market is rejected). Manage open IG positions as usual.`;
    const whyNote = why ? `\n\nWHY THIS SESSION: ${why}` : '';
    const routineNote = routineSession ? `\n\nROUTINE CHECK-IN (you are ${MODELS[model].label}, the cheaper model): manage open positions (close, tighten stops, set exit plans, update notes) as usual. You can't open new trades in this session: if you see an entry worth taking, or anything needing deeper judgment, call escalate with the reason and Opus will run a full session straight after.` : '';
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: text + offNote + (research ? RESEARCH_PROMPT : '') + allowanceNote + whyNote + routineNote }];
    let backtestsLeft = MAX_BACKTESTS_PER_SESSION;
    let researchUsed = 0, researchCapNoted = false;
    const tok = { fresh: 0, read: 0, write: 0 };
    let chartsLeft = MAX_CHARTS_PER_SESSION, shotsLeft = MAX_SCREENSHOTS_PER_SESSION;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (budgetLeftUsd() <= 0.25) { addLog('wait', 'Budget ran out mid-session — stopping here'); break; }
      // Same tools on every turn: changing the tool list (it used to drop the
      // web tools after turn 1) invalidates the whole cache. The per-session
      // allowance is enforced by telling the model once it's used up.
      const resp = await callModel(model, system, messages, searches, cacheTtl());
      sessionUsd += recordUsage(model, resp.usage);
      tok.fresh += resp.usage.input_tokens; tok.read += resp.usage.cache_read_input_tokens ?? 0; tok.write += resp.usage.cache_creation_input_tokens ?? 0;
      sessionResearchUsed += (resp.usage.server_tool_use?.web_search_requests ?? 0) + (resp.usage.server_tool_use?.web_fetch_requests ?? 0);
      researchUsed += (resp.usage.server_tool_use?.web_search_requests ?? 0) + (resp.usage.server_tool_use?.web_fetch_requests ?? 0);
      if (resp.model !== model) addLog('info', `Served by fallback model ${resp.model} this turn`);
      if (resp.stop_reason === 'refusal') { addLog('error', 'The model declined this session (refusal, fallback included)'); break; }

      for (const b of resp.content) {
        if (b.type === 'server_tool_use' && b.name !== 'code_execution') {
          const q = (b.input as Record<string, unknown>)?.query ?? (b.input as Record<string, unknown>)?.url;
          addLog('info', `[research] ${b.name}: ${String(q ?? '').slice(0, 200)}`);
        }
      }
      // A long server-side research turn can pause; hand it back to continue.
      if (resp.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: resp.content }); continue; }
      const toolUses = resp.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      for (const b of resp.content) if (b.type === 'text' && b.text.trim()) addLog('think', b.text.trim().slice(0, 1500));
      if (resp.stop_reason === 'max_tokens') { addLog('error', 'Response hit max_tokens — tool inputs may be truncated, not running them'); break; }
      if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) break;

      messages.push({ role: 'assistant', content: resp.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const t of toolUses) {
        let out: string;
        let image: string | undefined;
        const input = t.input as Record<string, unknown>;
        try {
          if (t.name === 'open_position') out = await openPosition(input as Parameters<typeof openPosition>[0], metrics);
          else if (t.name === 'close_position') out = await closePosition(String(input.position_id), String(input.reason), view);
          else if (routineSession && (t.name === 'open_position' || t.name === 'open_option')) out = 'REJECTED: this is a routine check-in on a cheaper model; new entries are decided by Opus. If this is a real entry, call escalate with the reason and Opus will look at it straight after.';
          else if (t.name === 'escalate') {
            if (!routineSession) out = 'Not needed: this is already a full Opus session.';
            else { escalateReason = String(input.reason ?? '').slice(0, 500); addLog('info', `Escalated to Opus: ${escalateReason}`); out = 'OK: Opus will run a full session right after this one.'; }
          }
          else if (t.name === 'option_chain') out = await optionChainTool(input);
          else if (t.name === 'open_option') out = await openOption(input as Parameters<typeof openOption>[0], metrics);
          else if (t.name === 'set_exit_plan') {
            const p = state.positions.find(x => x.id === String(input.position_id));
            if (!p) out = 'No open position with that id.';
            else { p.exitPlan = String(input.exit_plan).slice(0, 600); saveState(); addLog('info', `Exit plan for ${p.symbol}: ${p.exitPlan}`); out = 'Exit plan saved.'; }
          }
          else if (t.name === 'tighten_stop') out = await tightenStop(String(input.position_id), Number(input.new_stop), String(input.reason), view);
          else if (t.name === 'run_backtest') {
            if (backtestsLeft <= 0) out = `REJECTED: backtest limit for this session (${MAX_BACKTESTS_PER_SESSION}) reached.`;
            else {
              backtestsLeft--;
              const spec = input as unknown as BacktestSpec;
              out = await runRuleBacktest(spec);
              addLog('info', `[backtest] ${spec.direction} ${(spec.symbols ?? []).slice(0, 6).join(',')}${(spec.symbols?.length ?? 0) > 6 ? '…' : ''} — ${out.split('\n')[1] ?? out.split('\n')[0]}`);
            }
          }
          else if (t.name === 'tradingview_chart') {
            if (chartsLeft <= 0) out = `REJECTED: chart limit for this session (${MAX_CHARTS_PER_SESSION}) reached.`;
            else {
              chartsLeft--;
              const r = await tradingviewChart(input, shotsLeft > 0);
              out = r.text; image = r.image;
              if (image) shotsLeft--;
              addLog('info', `[tradingview] ${input.symbol} ${input.timeframe}${image ? ' + screenshot' : ''} — ${out.split('\n')[out.startsWith('TradingView') ? 1 : 0].slice(0, 200)}`);
            }
          }
          else if (t.name === 'update_notes') { state.notes = String(input.notes).slice(0, 3000); saveState(); addLog('info', 'Updated its strategy notes'); out = 'Notes saved.'; }
          else if (t.name === 'set_watchlist_extra') {
            const syms = (Array.isArray(input.symbols) ? input.symbols : []).map(s => String(s).toUpperCase().trim()).filter(s => /^[A-Z.]{1,6}$/.test(s)).slice(0, 20);
            state.watchlistExtra = syms; saveState(); addLog('info', `Watchlist extras: ${syms.join(', ') || '(none)'}`); out = `Saved ${syms.length} symbols.`;
          } else out = `Unknown tool ${t.name}`;
        } catch (e) { out = `ERROR: ${e instanceof Error ? e.message : String(e)}`; }
        if (out.startsWith('REJECTED')) addLog('wait', `${t.name}: ${out}`);
        const content: Anthropic.Beta.BetaToolResultBlockParam['content'] = image
          ? [{ type: 'text', text: out }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }]
          : out;
        results.push({ type: 'tool_result', tool_use_id: t.id, content, ...(out.startsWith('REJECTED') || out.startsWith('FAILED') ? { is_error: true } : {}) });
      }
      const userContent: Anthropic.Beta.BetaContentBlockParam[] = [...results];
      if (searches > 0 && researchUsed >= searches && !researchCapNoted) {
        researchCapNoted = true;
        userContent.push({ type: 'text', text: `(Your web research allowance for this session, ${searches}, is used up. Don't search or fetch again this session.)` });
      }
      messages.push({ role: 'user', content: userContent });
    }

    if (config.shadowModel && config.shadowModel !== model && budgetLeftUsd() > 1) {
      try { sessionUsd += await runShadow(config.shadowModel, text, metrics); }
      catch (e) { addLog('error', `Shadow run failed: ${e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : String(e)}`); }
    }

    addLog('info', `Session done in ${((Date.now() - started) / 1000).toFixed(0)}s — cost $${sessionUsd.toFixed(3)} (input tokens: ${tok.read} from cache, ${tok.write} written to cache, ${tok.fresh} uncached), month $${spend.usd.toFixed(2)} of $${config.monthlyCapUsd}`);
    lastRunAt = new Date().toISOString();
    if (escalateReason && trigger !== 'escalated') {
      const r = escalateReason;
      setTimeout(() => { void runOpusSession('escalated', `escalated by the routine check-in: ${r}`); }, 3000);
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Anthropic.APIError ? `Anthropic API ${e.status}: ${e.message}` : e instanceof Error ? e.message : String(e);
    addLog('error', `Session failed: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    busy = false;
  }
}

// TradingView webhook alerts (2026-10-21). Stored for the briefing; a fresh
// alert also triggers a review during the US session, at most every 15min.
let lastTvTriggeredAt = 0;
// TradingView's names for the IG-only markets → Opus symbols.
const TV_TO_OPUS: Record<string, string> = {
  NI225: 'JP225', JP225: 'JP225', NKY: 'JP225', NKD1: 'JP225', 'NKD1!': 'JP225',
  NDX: 'USTECH100', 'NQ1!': 'USTECH100', SPX: 'US500', 'ES1!': 'US500', DJI: 'WALLST', 'YM1!': 'WALLST',
  DAX: 'DE40', DE40: 'DE40', GER40: 'DE40', UKX: 'UK100', UK100: 'UK100', SX5E: 'EU50', EU50: 'EU50',
  GBPUSD: 'GBPUSD', EURUSD: 'EURUSD', USDJPY: 'USDJPY', AUDUSD: 'AUDUSD',
  SILVER: 'SILVER', XAGUSD: 'SILVER', 'SI1!': 'SILVER', UKOIL: 'BRENT', BRENT: 'BRENT', 'BRN1!': 'BRENT',
  'NG1!': 'NATGAS', NATGAS: 'NATGAS', NATURALGAS: 'NATGAS',
  // Broker CFD feeds (FOREX.com / OANDA / Pepperstone) — free, live and
  // trading nearly round the clock like IG, unlike the cash indices.
  JP225USD: 'JP225', JPN225: 'JP225', NAS100: 'USTECH100', NAS100USD: 'USTECH100', USTEC: 'USTECH100',
  SPX500: 'US500', SPX500USD: 'US500', US500: 'US500', US30: 'WALLST', US30USD: 'WALLST',
  DE30EUR: 'DE40', DE40EUR: 'DE40', GER30: 'DE40', UK100GBP: 'UK100', EU50EUR: 'EU50', STOXX50: 'EU50',
  BCOUSD: 'BRENT', XBRUSD: 'BRENT', NATGASUSD: 'NATGAS',
};

export function ingestTradingViewAlert(body: Record<string, unknown>): { ok: boolean; error?: string } {
  const secret = process.env.TRADINGVIEW_SECRET;
  if (!secret || body.secret !== secret) return { ok: false, error: 'bad secret' };
  const rawSym = String(body.symbol ?? body.ticker ?? '').toUpperCase().replace(/^[A-Z0-9_]+:/, '').trim();
  const symbol = TV_TO_OPUS[rawSym] ?? rawSym;
  if (!/^[A-Z0-9.!]{1,12}$/.test(symbol)) return { ok: false, error: 'symbol required' };
  const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : null; };
  const alert: TvAlert = {
    ts: new Date().toISOString(), symbol,
    signal: String(body.signal ?? body.action ?? 'alert').slice(0, 40),
    timeframe: body.timeframe !== undefined ? String(body.timeframe).slice(0, 10) : null,
    price: num(body.price ?? body.close),
    note: body.note !== undefined ? String(body.note).slice(0, 300) : null,
  };
  state.tvAlerts.push(alert);
  if (state.tvAlerts.length > 300) state.tvAlerts = state.tvAlerts.slice(-300);
  saveState();
  addLog('info', `[TradingView] ${symbol} ${alert.signal}${alert.timeframe ? ` [${alert.timeframe}]` : ''}${alert.price !== null ? ` @ ${alert.price}` : ''}`);
  const igRelevant = isIgOnly(symbol) || state.positions.some(p => p.account === 'ig_demo' && p.symbol === symbol);
  const canAct = isUsSessionOpen() || (isIgWindowOpen() && config.accounts.ig_demo && igRelevant);
  // An exit signal only matters early if Opus holds that market; otherwise it
  // just shows in the next briefing (keeps alert-driven sessions/cost down).
  const held = state.positions.some(p => p.symbol === symbol);
  const worthWaking = !/EXIT/i.test(alert.signal) || held;
  if (running && !busy && canAct && worthWaking && Date.now() - lastTvTriggeredAt > 15 * 60_000) {
    lastTvTriggeredAt = Date.now();
    void runOpusSession('tradingview');
  }
  return { ok: true };
}

let lastScheduledAt = 0;

// With the 1-hour cache on, a 60-minute cycle runs at 57 so the next session
// lands inside the cache window (the timer starts after a session ends).
function scheduleMinutes(): number {
  return config.cacheOneHour && config.cycleMinutes >= 57 && config.cycleMinutes <= 60 ? 57 : config.cycleMinutes;
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  if (!running) { nextRunAt = null; return; }
  // Off-hours the tick still fires on the US cadence (so the US open is never
  // missed) but only runs a session once offHoursMinutes have passed.
  let delay = scheduleMinutes() * 60_000;
  // If the US market opens before the next tick, run at the open (+3 min, so
  // opening prices exist) instead: Alpaca options/stocks can only trade then,
  // and a tick just before the open would otherwise push the first US session
  // ~an hour late (2026-10-29).
  const now = Date.now();
  if (!isUsSessionOpen(new Date(now))) {
    for (let m = 1; m * 60_000 < delay; m++) {
      if (isUsSessionOpen(new Date(now + m * 60_000))) { delay = (m + 3) * 60_000; break; }
    }
  }
  nextRunAt = now + delay;
  timer = setTimeout(() => { void tick(); }, delay);
}

async function tick(): Promise<void> {
  if (!running) return;
  const due = isUsSessionOpen() || (offHours() && Date.now() - lastScheduledAt >= config.offHoursMinutes * 60_000 - 60_000);
  if (due) {
    const why = await materialChange().catch(e => `change check failed (${e instanceof Error ? e.message : String(e)}), running anyway`);
    if (why) await runOpusSession('scheduled', why);
    else addLog('info', 'Check-in skipped: nothing material changed since the last session (no AI call)');
  }
  schedule();
}

// The change gate (2026-10-29, owner: usage vs effect on a demo). Plain code,
// no AI: a scheduled session only runs when one of these is true. TradingView
// alerts and manual runs bypass it.
const gateNotified = new Map<string, number>();
async function materialChange(): Promise<string | null> {
  if (!config.changeGate) return 'change gate off';
  const us = isUsSessionOpen();
  if (us && config.webResearch && nyDate() !== state.lastResearchDay) return 'first US session of the day (daily research)';
  if (us && config.accounts.alpaca_paper && Date.now() - (state.lastAlpacaReviewAt ?? 0) >= config.alpacaEveryMinutes * 60_000 - 60_000) return 'Alpaca review due';
  const quietH = (Date.now() - (state.lastSessionAt ?? 0)) / 3_600_000;
  if (quietH >= (us ? config.quietMaxHoursUs : config.quietMaxHoursOff)) return `no session for ${quietH.toFixed(1)}h`;
  const view = await livePositionView();
  for (const p of state.positions) {
    const v = view.get(p.id);
    if (v && !v.exists && Date.now() - p.openedAt > 10 * 60_000) return `${p.symbol} is no longer open at the broker`;
    const cur = v?.current;
    if (cur == null) continue;
    const risk = Math.abs(p.entryPrice - p.stopPrice);
    if (!(risk > 0)) continue;
    const toStop = Math.abs(cur - p.stopPrice) / risk;
    const gain = (p.direction === 'BUY' ? cur - p.entryPrice : p.entryPrice - cur) / risk;
    // Each fires once per position per level, so a position sitting near its
    // stop or in profit doesn't wake the model every hour.
    const stopKey = `${p.id}:stop`;
    if (toStop < 0.35 && Date.now() - (gateNotified.get(stopKey) ?? 0) > 6 * 3_600_000) { gateNotified.set(stopKey, Date.now()); return `${p.symbol} is close to its stop`; }
    const level = Math.floor(gain * 2) / 2;   // 1.5R, 2R, 2.5R ...
    if (level >= 1.5 && level > (gateNotified.get(`${p.id}:gain`) ?? 0)) { gateNotified.set(`${p.id}:gain`, level); return `${p.symbol} is well in profit (${gain.toFixed(1)}× its risk): consider locking in`; }
  }
  const snap = state.priceSnap ?? {};
  const watch = [...new Set([...Object.keys(IG_MARKETS), ...state.positions.map(p => p.symbol)])].filter(sym => snap[sym]);
  for (const sym of watch) {
    if (!us && !isIgOnly(sym)) continue;
    const m = await metricsFor(sym);
    if (!m) continue;
    const move = (m.price / snap[sym] - 1) * 100;
    if (Math.abs(move) >= config.gateMovePct) return `${sym} moved ${move >= 0 ? '+' : ''}${move.toFixed(1)}% since the last session`;
  }
  return null;
}

export async function startOpus(): Promise<{ ok: boolean; error?: string }> {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: 'ANTHROPIC_API_KEY is not set on the server' };
  running = true;
  config.enabled = true; saveConfig();
  // One decision-maker per account: the existing bots stop opening trades on
  // accounts Opus manages (their existing positions keep their own exits).
  try {
    if (config.accounts.ig_demo) { const m = await import('./igStrategyBot'); m.pauseIgStrategyBot('demo'); }
    // The old options bot keeps running when Opus vets its entries (2026-10-29).
    if (config.accounts.alpaca_paper && !config.oldOptionsBot) { const m = await import('./alpacaBot'); m.pauseAlpacaBot('paper'); }
  } catch (e) { addLog('error', `Couldn't pause an existing bot: ${e instanceof Error ? e.message : String(e)}`); }
  addLog('info', `Opus started — reviewing every ${config.cycleMinutes}min during the US session${config.offHoursMinutes > 0 && config.accounts.ig_demo ? ` and every ${config.offHoursMinutes}min outside it for IG markets (weekdays)` : ''}; existing IG demo bot paused for new entries${config.oldOptionsBot ? '; the Alpaca options bot keeps running with Opus vetting its entries' : ' and Alpaca paper bot paused'}`);
  // Run straight away only if a session is actually due (2026-10-29: every
  // restart used to start one, ~$0.12 each, even minutes after the last).
  lastScheduledAt = state.lastScheduledAt ?? 0;
  const since = Date.now() - lastScheduledAt;
  const due = isUsSessionOpen() ? since >= scheduleMinutes() * 60_000 - 60_000 : offHours() && since >= config.offHoursMinutes * 60_000 - 60_000;
  if (due) void runOpusSession('scheduled');
  schedule();
  if (optionWatchTimer) clearInterval(optionWatchTimer);
  optionWatchTimer = setInterval(() => { watchOptions().catch(e => addLog('error', `Option watch failed: ${e instanceof Error ? e.message : String(e)}`)); }, 5 * 60_000);
  return { ok: true };
}

export function stopOpus(): { ok: boolean } {
  running = false;
  config.enabled = false; saveConfig();
  if (timer) clearTimeout(timer);
  timer = null; nextRunAt = null;
  if (optionWatchTimer) clearInterval(optionWatchTimer);
  optionWatchTimer = null;
  addLog('info', 'Opus stopped — its open positions stay open with their broker stops; resume the other bots from their own pages if wanted');
  return { ok: true };
}

export function wasOpusRunning(): boolean { return config.enabled; }

// Opus's closed trades, for labelling the brokers' closed-positions lists.
export function opusClosedRefs(): Array<{ account: OpusAccount; symbol: string; openedAt: number; closedAt: number; probe?: boolean }> {
  return [...state.closed, ...state.positions.map(p => ({ ...p, closedAt: 0 }))].map(c => ({ account: c.account, symbol: c.brokerRef && c.account === 'alpaca_paper' ? c.brokerRef : c.symbol, openedAt: c.openedAt, closedAt: c.closedAt, probe: c.probe }));
}

// Hand an existing IG demo position to Opus (2026-10-22): used when a market
// moves to Opus from another bot, or for a deal opened outside Opus's records.
// Opus then manages it like its own, with its real broker stop and open time.
export async function adoptIgPosition(dealId: string, note: string): Promise<{ ok: boolean; message: string }> {
  if (state.positions.some(p => p.brokerRef === dealId)) return { ok: false, message: 'Opus already tracks that deal.' };
  const session = await ig();
  const x = (await fetchPositions(session)).find(p => p.dealId === dealId);
  if (!x) return { ok: false, message: `No open IG demo position with deal ${dealId}.` };
  const symbol = Object.keys(TICKER_TO_EPIC).find(t => TICKER_TO_EPIC[t] === x.epic);
  if (!symbol) return { ok: false, message: `${x.epic} isn't one of Opus's IG markets.` };
  const stop = x.stopLevel ?? (x.direction === 'BUY' ? x.level * 0.95 : x.level * 1.05);
  const p: OpusPosition = { id: newId(), account: 'ig_demo', symbol, brokerRef: x.dealId, epic: x.epic, direction: x.direction, size: x.size,
    entryPrice: x.level, stopPrice: round2(stop), openedAt: x.createdUtc ? Date.parse(x.createdUtc + 'Z') : Date.now(),
    conviction: 0, reason: `INHERITED (not opened by you): ${note} Decide whether it fits your view; hold, or close it with a reason.` };
  state.positions.push(p); saveState();
  addLog('info', `Adopted IG demo ${symbol} ${x.direction} ${x.size}/pt @ ${x.level} (stop ${round2(stop)}) — ${note}`);
  return { ok: true, message: `Opus now manages ${symbol} ${x.direction} ${x.size}/pt (id ${p.id}).` };
}

// Opus's closed trades in journal shape, for the Bot Performance tab
// (2026-10-22). Opus keeps its own records rather than writing to the shared
// trade journal. Full-size and probe trades are separate strategies so the
// test can compare them.
export function opusClosedForPerformance(): Array<{ mode: 'paper' | 'ig-demo' | 't212-live'; row: import('./tradeJournal').JournalEvent }> {
  const modeOf = { alpaca_paper: 'paper', ig_demo: 'ig-demo', t212_live: 't212-live' } as const;
  return state.closed.filter(c => c.plApprox !== null).map(c => {
    const mode = modeOf[c.account];
    const notional = c.account === 'ig_demo' ? 0 : c.entryPrice * c.size;
    return { mode, row: {
      id: `opus-${c.id}`, ts: new Date(c.closedAt).toISOString(), mode, event: 'exit' as const, symbol: c.symbol,
      strategy: c.probe ? 'opus (probe)' : 'opus (full)', side: c.direction === 'BUY' ? 'long' as const : 'short' as const,
      qty: c.size, price: c.entryPrice, reason: c.closeReason, confidence: c.conviction,
      plUsd: c.plApprox ?? 0, plPct: notional > 0 ? ((c.plApprox ?? 0) / notional) * 100 : 0,
    } };
  });
}

// Whether Opus is (or is about to be, on auto-resume) the decision-maker for
// an account. Used at bot start-up so an older bot that comes back after
// Opus has already started is paused straight away (2026-10-21: on restart
// Opus started a few seconds before the Alpaca bot, so its pause found
// nothing to pause and the Alpaca bot ran unpaused alongside it).
export function opusManagesAccount(account: OpusAccount): boolean { return config.enabled && config.accounts[account]; }

export function updateOpusConfig(patch: Partial<OpusConfig>): { ok: boolean; config: OpusConfig; error?: string } {
  const next: OpusConfig = { ...config, ...patch, accounts: { ...config.accounts, ...(patch.accounts ?? {}) } };
  // Sanity bounds so a typo in the UI can't remove the guard rails.
  if (!(next.monthlyCapUsd > 0 && next.monthlyCapUsd <= 500)) return { ok: false, config, error: 'monthlyCapUsd must be 1-500' };
  if (!(next.cycleMinutes >= 15 && next.cycleMinutes <= 240)) return { ok: false, config, error: 'cycleMinutes must be 15-240' };
  if (!(next.alpacaEveryMinutes >= 30 && next.alpacaEveryMinutes <= 390)) return { ok: false, config, error: 'alpacaEveryMinutes must be 30-390' };
  if (!(next.offHoursMinutes === 0 || (next.offHoursMinutes >= 30 && next.offHoursMinutes <= 480))) return { ok: false, config, error: 'offHoursMinutes must be 0 (off) or 30-480' };
  if (!(next.t212MaxPositionGbp > 0 && next.t212MaxPositionGbp <= 1000)) return { ok: false, config, error: 't212MaxPositionGbp must be 1-1000' };
  if (!(next.t212MaxTotalGbp >= next.t212MaxPositionGbp && next.t212MaxTotalGbp <= 3000)) return { ok: false, config, error: 't212MaxTotalGbp must be ≥ per-position and ≤ 3000' };
  if (!(next.minConviction >= 50 && next.minConviction <= 95)) return { ok: false, config, error: 'minConviction must be 50-95' };
  if (!(next.probeMinConviction >= 40 && next.probeMinConviction <= next.minConviction)) return { ok: false, config, error: 'probeMinConviction must be 40 to minConviction (set equal to turn probes off)' };
  if (!(next.probeSizePct >= 10 && next.probeSizePct <= 100)) return { ok: false, config, error: 'probeSizePct must be 10-100' };
  if (!['low', 'medium', 'high', 'xhigh'].includes(next.effort)) return { ok: false, config, error: 'effort must be low/medium/high/xhigh' };
  if (!(next.searchesPerSession >= 0 && next.searchesPerSession <= 10)) return { ok: false, config, error: 'searchesPerSession must be 0-10' };
  if (!(next.researchSearches >= 0 && next.researchSearches <= 20)) return { ok: false, config, error: 'researchSearches must be 0-20' };
  if (!(next.igMaxRiskPct >= 0 && next.igMaxRiskPct <= 5)) return { ok: false, config, error: 'igMaxRiskPct must be 0-5' };
  if (!(next.model in MODELS)) return { ok: false, config, error: `model must be one of ${Object.keys(MODELS).join(', ')}` };
  if (next.shadowModel !== null && !(next.shadowModel in MODELS)) return { ok: false, config, error: 'shadowModel must be a known model or null' };
  if (next.routineModel !== null && !(next.routineModel in MODELS)) return { ok: false, config, error: 'routineModel must be a known model or null' };
  if (next.researchModel !== null && !(next.researchModel in MODELS)) return { ok: false, config, error: 'researchModel must be a known model or null' };
  const cycleChanged = next.cycleMinutes !== config.cycleMinutes;
  config = next; saveConfig();
  addLog('info', `Settings changed: ${Object.keys(patch).join(', ')}`);
  if (cycleChanged && running) schedule();
  return { ok: true, config };
}

export async function closeOpusPositionManually(id: string): Promise<{ ok: boolean; message: string }> {
  const view = await livePositionView();
  const msg = await closePosition(id, 'Closed from the dashboard', view, true);
  return { ok: msg.startsWith('CLOSED'), message: msg };
}

// ── One-off entry checks for the T212 bots (2026-10-22) ────────────────────
// Per explicit request: the T212 ISA and Momentum bots keep running their own
// strategies, but each new entry gets a single Opus check (replacing the
// OpenAI/Gemini/xAI verdicts — OpenAI's credit had run out and the logged
// comparison showed Gemini's BUYs with no edge). Same prompts as before, so
// the question is unchanged; only the judge is. Returns null when Opus can't
// answer (no key, budget spent, API error) so the caller falls back to its
// previous AI rather than stalling.
async function opusText(prompt: string): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY || budgetLeftUsd() <= 0.25) return null;
  try {
    client ??= new Anthropic();
    const resp = await client.beta.messages.create({
      model: config.model, max_tokens: 4000, output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: prompt }],
      betas: [FALLBACK_BETA], fallbacks: 'default',
    });
    recordUsage(config.model, resp.usage);
    if (resp.stop_reason === 'refusal') return null;
    const text = resp.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map(b => b.text).join('').trim();
    return text || null;
  } catch (e) {
    addLog('error', `T212 entry check failed: ${e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ── Vetting the old Alpaca options bot's entries (2026-10-29) ───────────────
// The owner: keep the old options bot finding trades, with Opus on top, and
// "for options plain analysis isn't good enough, there needs to be news and
// macro backing". One Opus call per signal, with web search; fails closed.
export function opusVetsOldOptionsBot(): boolean { return config.enabled && config.accounts.alpaca_paper && config.oldOptionsBot; }

const VET_TOOL: Anthropic.Beta.BetaTool = {
  name: 'verdict',
  description: 'Your decision on the proposed option entry. Call it exactly once, at the end.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      approve:        { type: 'boolean' },
      conviction:     { type: 'integer', description: '0-100: confidence the underlying moves the proposed way enough over the next 1-3 months' },
      news_and_macro: { type: 'string', description: 'The news/catalysts and macro backdrop you found, and how they bear on this trade. 2-4 sentences.' },
      reason:         { type: 'string', description: 'Why approve or reject, 1-2 sentences' },
    },
    required: ['approve', 'conviction', 'news_and_macro', 'reason'],
    additionalProperties: false,
  },
};

let vetDay = '', vetCount = 0;
export async function opusVetOptionEntry(req: {
  symbol: string; direction: 'BUY' | 'SELL'; price: number; changePct: number; signal: string; headlines: string[];
}): Promise<{ approve: boolean; conviction: number; reason: string; newsAndMacro: string } | null> {
  if (!opusVetsOldOptionsBot() || !process.env.ANTHROPIC_API_KEY || budgetLeftUsd() <= 0.5) return null;
  if (vetDay !== nyDate()) { vetDay = nyDate(); vetCount = 0; }
  if (vetCount >= config.optionVetsPerDay) return { approve: false, conviction: 0, reason: `daily vetting limit (${config.optionVetsPerDay}) reached`, newsAndMacro: '' };
  vetCount++;
  const kind = req.direction === 'BUY' ? 'CALL (betting it rises)' : 'PUT (betting it falls)';
  const m = await metricsFor(req.symbol).catch(() => null);
  const flowText = await getOptionsFlow(req.symbol, req.price).then(describeFlow).catch(() => '(options positioning unavailable)');
  const prompt = `You vet option entries proposed by a rules-based trend bot on the owner's Alpaca PAPER account. The bot buys near-the-money contracts 90-180 days out and holds them at least a month (only its -50% stop or the 21-days-to-expiry rule can close one sooner), so judge the next 1-3 months, not today.

The owner's rule: chart analysis alone isn't enough for an option. Approve only with news AND macro backing. Use web_search (a few searches) to check:
1. The company's latest news and catalysts, and whether earnings or another big event falls before expiry (and which way it's likely to cut).
2. The macro backdrop: rates and the Fed, the dollar, where money is rotating (sectors), market risk appetite, and scheduled data (CPI, jobs, FOMC) that could swing it.
Also weigh the options positioning below (where the big open interest and today's fresh money sit) and the volume: buying should be heavy on up days for a call (selling heavy on down days for a put); a big move on thin volume is weaker. Then decide. Approve only if news and macro support the direction and your conviction is at least 65. Reject when they conflict, when a binary event makes it a coin flip, or when you can't find enough to judge.

Proposed: BUY a ${kind} on ${req.symbol}.
Bot's signal: ${req.signal}
Price ${req.price.toFixed(2)}, today ${req.changePct >= 0 ? '+' : ''}${req.changePct.toFixed(2)}%${m ? `, today's volume ${fmt(m.volToday, 2)}× a normal day (pro-rated), today ${m.aboveOpen === null ? 'flat' : m.aboveOpen ? 'above' : 'below'} its open (heavy volume only confirms a move in its own direction), 20d avg ${m.sma20.toFixed(2)}, 50d avg ${m.sma50.toFixed(2)}, 12-week ${fmt(m.trend12wPct)}%, RSI ${fmt(m.rsi14, 0)}, ATR ${fmt(m.atrPct)}%, ${fmt(m.offHigh52wPct)}% off the 52-week high` : ''}.
Headlines the bot saw: ${req.headlines.slice(0, 8).join(' | ') || '(none)'}

${flowText}

Finish by calling verdict.`;
  try {
    client ??= new Anthropic();
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: prompt }];
    for (let turn = 0; turn < 4; turn++) {
      const resp = await client.beta.messages.create({
        model: config.model, max_tokens: 8000, output_config: { effort: 'medium' },
        tools: [VET_TOOL, { type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
        messages, betas: [FALLBACK_BETA], fallbacks: 'default',
      });
      const usd = recordUsage(config.model, resp.usage);
      if (resp.stop_reason === 'refusal') return null;
      const v = resp.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use' && b.name === 'verdict');
      if (v) {
        const x = v.input as { approve: boolean; conviction: number; news_and_macro: string; reason: string };
        const approve = x.approve && x.conviction >= 65;
        addLog(approve ? 'enter' : 'wait', `[Options bot vet] ${req.symbol} ${req.direction === 'BUY' ? 'call' : 'put'}: ${approve ? 'APPROVED' : 'rejected'} (${x.conviction}) — ${x.reason} | News/macro: ${x.news_and_macro} ($${usd.toFixed(3)})`);
        return { approve, conviction: x.conviction, reason: x.reason, newsAndMacro: x.news_and_macro };
      }
      if (resp.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: resp.content });
    }
    return null;
  } catch (e) {
    addLog('error', `Options vet failed: ${e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function opusConfirmStockTrade(req: StockConfirmSignal): Promise<StockConfirmVerdict | null> {
  const text = await opusText(buildConfirmStockTradePrompt(req));
  if (!text) return null;
  try {
    const v = { ...parseConfirmStockTradeResponse(text, req, 'gemini'), engine: 'opus' as const };
    addLog('info', `[T212 Momentum check] ${req.instrumentName}: ${v.direction} ${v.confidence}% — ${v.reason}`);
    return v;
  } catch { return null; }
}

export async function opusIsaThesis(req: IsaThesisRequest): Promise<IsaThesisVerdict | null> {
  const { prompt, fallbackAction } = buildIsaThesisPrompt(req);
  const text = await opusText(prompt);
  if (!text) return null;
  try {
    const v = parseIsaThesisResponse(text, req.action, fallbackAction, 'opus');
    addLog('info', `[T212 ISA check] ${req.instrumentName}: ${v.action} ${v.confidence}% — ${v.reason}`);
    return v;
  } catch { return null; }
}

// The exact briefing Opus would receive right now — no API call, no cost.
export async function previewOpusBriefing(): Promise<{ ok: boolean; briefing: string }> {
  const view = await livePositionView();
  const { text } = await buildBriefing(view);
  return { ok: true, briefing: text };
}

export async function getOpusStatus() {
  if (spend.month !== thisMonth()) spend = loadSpend();
  let view = new Map<string, LivePos>();
  try { view = await livePositionView(); } catch { /* best-effort */ }
  return {
    running, busy, apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY, tradingviewConfigured: !!process.env.TRADINGVIEW_SECRET,
    // Shown on the password-protected dashboard so it can be pasted into the Pine script.
    tradingviewSecret: process.env.TRADINGVIEW_SECRET ?? null,
    tvAlerts: state.tvAlerts.slice(-30).reverse(),
    usSessionOpen: isUsSessionOpen(), nextRunAt, lastRunAt,
    config, spend, budgetLeftUsd: budgetLeftUsd(), models: MODELS,
    positions: state.positions.map(p => ({ ...p, livePl: view.get(p.id)?.pl ?? null, liveCurrent: view.get(p.id)?.current ?? null })),
    closed: state.closed.slice(-50).reverse(),
    notes: state.notes, watchlistExtra: state.watchlistExtra,
    log: log.slice(0, 200),
  };
}

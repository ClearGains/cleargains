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
  closePosition as alpacaClosePosition, cancelOrdersForSymbol, type AlpacaBar,
} from './alpacaApi';
import { calcRsi, calcAtr, dailyVolumeRatio } from './alpacaStrategies';
import { fetchAllHeadlines } from './newsFetch';
import {
  authenticate, fetchFullPositions, placeMarketOrder as igPlaceOrder, closePosition as igClosePosition,
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
  igMaxRiskPct:         number;   // …or this % of the IG balance, whichever is larger
  igMaxPositions:       number;
  t212MaxPositionGbp:   number;
  t212MaxTotalGbp:      number;
  t212MaxPositions:     number;
  minConviction:        number;   // matches the 65% entry bar used everywhere else
  probeMinConviction:   number;   // paper/demo only: conviction from here up to minConviction opens a small PROBE
  probeSizePct:         number;   // probe size as % of the normal size cap
  webResearch:          boolean;  // give the model web search/fetch for its own research
  searchesPerSession:   number;   // web searches allowed in a normal session
  researchSearches:     number;   // web searches allowed in the daily research session
  minHoldHours:         number;   // no discretionary close sooner than this (stops still fire)
  reentryCooldownHours: number;   // after closing a symbol, no new position in it for this long
};

const DEFAULT_CONFIG: OpusConfig = {
  enabled: false,
  model: 'claude-opus-5-5',
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
  igMaxRiskPct: 1,
  igMaxPositions: 6,
  t212MaxPositionGbp: 100,
  t212MaxTotalGbp: 300,
  t212MaxPositions: 3,
  minConviction: 65,
  probeMinConviction: 55,
  probeSizePct: 33,
  minHoldHours: 4,
  reentryCooldownHours: 24,
  webResearch: true,
  searchesPerSession: 2,
  researchSearches: 8,
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
  reason:      string;
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
const IG_MARKETS: Record<string, { epic: string; name: string }> = {
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
      }
    } catch { /* leave unknown */ }
  }
  if (need('ig_demo')) {
    try {
      const ps = await fetchFullPositions(await ig());
      for (const p of state.positions.filter(x => x.account === 'ig_demo')) {
        const lp = ps.find(x => x.dealId === p.brokerRef);
        view.set(p.id, lp ? { pl: lp.upl, current: p.direction === 'BUY' ? lp.bid : lp.offer, exists: true } : { pl: null, current: null, exists: false });
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
      markClosed(p, 'Closed at the broker (stop-loss hit or closed outside Opus)', null);
    }
  }
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
      },
      required: ['account', 'symbol', 'direction', 'size', 'stop_loss_pct', 'conviction', 'reason'],
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

TradingView: you can look at live TradingView charts with the tradingview_chart tool — any timeframe, with a screenshot when the picture matters (trend structure, levels, patterns). It is a second view alongside the briefing's computed numbers; how much weight to give it is your call.`;

const SYSTEM_PROMPT = `You are the portfolio manager for a small trading operation, running a one-month trial. Each session you receive a briefing and act through tools. Your goal is risk-adjusted profit over weeks to months — not activity.

Accounts you control:
- alpaca_paper: US stocks/ETFs, paper money (USD). Long or short.
- ig_demo: UK spread bets, demo money (GBP) — US shares plus indices, FX and commodities (see the IG markets table). Long or short. You size by £ at risk; code derives the stake.
- t212_live: Trading 212 ISA, REAL money (GBP). Long only, small sizes. Be most selective here.

YOU OWN THE STRATEGY (the owner's decision, 2026-10-22): the owner wants all trading logic in your hands, with no rules of theirs or the code's second-guessing your strategy. Read the market regime yourself (trending up or down, ranging, high-volatility, risk-off, event-driven) and choose the approach that fits: trend-following, buying pullbacks, fading extremes, shorting, hedging, or staying flat. Switch approaches when conditions change. Write your current playbook and the regime you think you're in into your notes, and revise both as your results come in. Nothing below is an instruction about how to trade; it's evidence for you to weigh.

Evidence from this account's history (weigh it, don't obey it):
- Short holds lost money here: across 57 closed option trades, those held under a week went 2 wins / 44 trades; a week or longer went 8 / 13. The owner prefers holds of weeks to months on Alpaca, and days to about a week on IG spread bets, and dislikes churn.
- In a 3-year backtest on 15 US large caps (exit on a close below the 50-day, 10% stop): buying a breakout (above both averages, 12-week gain ≥ 8%, normal-or-better volume, up on the day) averaged +3.5% a trade over 169 trades; buying a pullback to the 20-day that turned up averaged +3.2% over 116 trades, with smaller losses. Both trailed simply holding in a strong market. Index and FX moves are much smaller than single-stock moves, so stock thresholds don't transfer to them.
- Re-asking the same question on unchanged inputs gave unstable answers. Change your mind about a position when something material changed, not because the session repeated.
- Today's lesson (2026-10-22): a long on the Nasdaq 100 opened overnight was hit the next day by a broad US sell-off (−2.6%). It was based on a wrong data feed (since fixed), but it's also a reminder to check the wider market's direction and the event calendar (megacap earnings week) before buying index dips.

Data you get: every number in the briefing is computed by code from market data (price, day change, whether today is above its open, today's volume vs a normal day (1.0 = normal, pro-rated for time of day), 20/50-day averages, 12-week trend, RSI(14), ATR% (typical daily range), distance off the 52-week high, headlines). The "setup (code)" column flags BREAKOUT/PULLBACK patterns as a convenience; use it, ignore it or define your own setups. You can test any idea with run_backtest (indicators: ${INDICATORS.join(', ')}). Judge it against buy-and-hold on enough trades; costs aren't modelled. When live results disagree with a backtest, trust the live results.

TEST PERIOD, PROBES: the owner is testing whether this makes money, which needs trades to measure. On alpaca_paper and ig_demo, a conviction between the probe minimum and the full minimum opens at a fraction of normal size (code sizes it). Take reasonable ideas as probes rather than sitting out; skip when you see a real reason against. Never inflate conviction. t212_live is real money: no probes.

Safety limits enforced by code (the only rules; they're risk controls, not strategy): every position needs a stop-loss of 2-15%; conviction at least the probe minimum (full size needs the full minimum); per-account position and size caps; Alpaca only during US market hours (orders are never queued for the open); no discretionary close within the minimum hold window, and no re-entry into a symbol within the cooldown after closing it (both guard against churn; stops still fire anytime).

How to work a session:
1. Review your open positions against the thesis you recorded for each. Close only with a real reason.
2. Consider new entries only where the setup is genuinely good. Doing nothing is a fine outcome — most sessions should be.
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
    try { const a = await getAccount('paper'); lines.push(`- alpaca_paper: equity $${parseFloat(a.equity).toFixed(0)}, cash $${parseFloat(a.cash).toFixed(0)}. Caps: ≤$${config.alpacaMaxPositionUsd}/position, ≤${config.alpacaMaxPositions} of your positions.`); }
    catch { lines.push('- alpaca_paper: balance unavailable'); }
  }
  if (config.accounts.ig_demo) {
    try {
      const f = await fetchAccountFunds(await ig());
      const cap = Math.max(config.igMaxRiskGbp, f.balance * config.igMaxRiskPct / 100);
      const tradeable = Object.keys(TICKER_TO_EPIC).filter(t => metrics.has(t) && !ownedElsewhere.has(TICKER_TO_EPIC[t]));
      const skipped = Object.keys(IG_MARKETS).filter(t => ownedElsewhere.has(IG_MARKETS[t].epic));
      lines.push(`- ig_demo: balance £${f.balance.toFixed(0)}, available £${f.available.toFixed(0)}. Caps: ≤£${cap.toFixed(0)} at risk/position, ≤${config.igMaxPositions} of your positions. IG's minimum stakes are large on US shares (wide stops won't fit the cap); indices, FX and commodities usually size better. Tradeable: ${tradeable.join(', ')}.${skipped.length ? ` Managed by another bot, leave alone: ${skipped.join(', ')}.` : ''}`);
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
    lines.push(`- id=${p.id} ${p.account} ${p.direction} ${p.symbol} size=${p.size} entry=${p.entryPrice} stop=${p.stopPrice} now=${fmt(v?.current ?? null, 2)} P&L=${fmt(v?.pl ?? null, 2)} held=${heldH.toFixed(1)}h conviction=${p.conviction} thesis: ${p.reason}`);
  }

  const recent = state.closed.slice(-12);
  if (recent.length) {
    lines.push('');
    lines.push('## Your recent closes (most recent last)');
    for (const c of recent) lines.push(`- ${new Date(c.closedAt).toISOString().slice(0, 10)} ${c.account} ${c.direction} ${c.symbol} held ${((c.closedAt - c.openedAt) / 86_400_000).toFixed(1)}d P&L≈${fmt(c.plApprox, 2)} — ${c.closeReason}`);
  }

  lines.push('');
  lines.push('## Market (daily bars; price USD)');
  lines.push('symbol | setup (code) | price | day% | vs open | vol (1.0=normal day) | >20d | >50d | 12w% | RSI | ATR% | off 52w high%');
  for (const m of [...metrics.values()].filter(x => !isIgOnly(x.symbol))) {
    lines.push(`${m.symbol} | ${setupLabel(m)} | ${fmt(m.price, 2)} | ${fmt(m.dayChgPct)} | ${m.aboveOpen === null ? '=' : m.aboveOpen ? 'above' : 'below'} | ${fmt(m.volToday, 2)} | ${m.price > m.sma20 ? 'Y' : 'N'} | ${m.price > m.sma50 ? 'Y' : 'N'} | ${fmt(m.trend12wPct)} | ${fmt(m.rsi14, 0)} | ${fmt(m.atrPct)} | ${fmt(m.offHigh52wPct)}`);
  }

  const igOnly = [...metrics.values()].filter(x => isIgOnly(x.symbol));
  if (igOnly.length) {
    lines.push('');
    lines.push('## IG markets — indices, FX, commodities (ig_demo only; daily bars, prices in market units — IG quotes some in its own points, e.g. FX ×10,000; no exchange volume, so no volume rule; the 8%/12-week stock threshold does NOT apply here — a setup label means the trend test passed)');
    lines.push('symbol (name) | setup (code) | price | day% | vs open | >20d | >50d | 12w% | RSI | ATR% | off 52w high%');
    for (const m of igOnly) lines.push(`${m.symbol} (${IG_MARKETS[m.symbol].name}) | ${setupLabel(m)} | ${fmt(m.price, 4)} | ${fmt(m.dayChgPct)} | ${m.aboveOpen === null ? '=' : m.aboveOpen ? 'above' : 'below'} | ${m.price > m.sma20 ? 'Y' : 'N'} | ${m.price > m.sma50 ? 'Y' : 'N'} | ${fmt(m.trend12wPct)} | ${fmt(m.rsi14, 0)} | ${fmt(m.atrPct)} | ${fmt(m.offHigh52wPct)}`);
  }

  // Headlines: open positions + the most active names today (keeps tokens bounded)
  const active = [...metrics.values()].filter(m => m.volToday !== null)
    .sort((a, b) => Math.abs(b.dayChgPct) * (b.volToday ?? 0) - Math.abs(a.dayChgPct) * (a.volToday ?? 0))
    .slice(0, 8).map(m => m.symbol);
  const newsFor = [...new Set([...state.positions.map(p => p.symbol), ...active])].slice(0, 12);
  lines.push('');
  lines.push('## Recent headlines');
  for (const s of newsFor) {
    let h: string[] = [];
    try { h = await fetchAllHeadlines(s, 3); } catch { /* none */ }
    if (h.length) lines.push(`${s}: ${h.map(x => x.slice(0, 140)).join(' | ')}`);
  }

  lines.push('');
  const tvRecent = state.tvAlerts.filter(a => Date.now() - new Date(a.ts).getTime() < 24 * 3_600_000);
  lines.push('## TradingView alerts (last 24h, newest last)');
  if (!tvRecent.length) lines.push('(none)');
  for (const a of tvRecent.slice(-25)) lines.push(`- ${a.ts.slice(5, 16).replace('T', ' ')} ${a.symbol} ${a.signal}${a.timeframe ? ` [${a.timeframe}]` : ''}${a.price !== null ? ` @ ${a.price}` : ''}${a.note ? ` — ${a.note}` : ''}`);
  lines.push('');
  lines.push('## Your strategy notes');
  lines.push(state.notes || '(none yet)');
  lines.push(`Extra watchlist: ${state.watchlistExtra.join(', ') || '(none)'}`);
  return { text: lines.join('\n'), metrics };
}

function newId(): string { return Math.random().toString(36).slice(2, 8); }
const round2 = (n: number) => Math.round(n * 100) / 100;

// Set per session: whether new Alpaca entries are in scope (2026-10-21 — the
// owner treats Alpaca as long-term, so it needn't be re-thought every 30 min;
// IG/spread bets keep the full cadence). Alpaca stops stay at the broker.
let alpacaInScope = true;

async function openPosition(inp: { account: OpusAccount; symbol: string; direction: 'BUY' | 'SELL'; size: number; stop_loss_pct: number; conviction: number; reason: string },
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
  if (state.positions.some(p => p.account === inp.account && p.symbol === symbol)) return `REJECTED: you already hold ${symbol} on ${inp.account}.`;
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
        entryPrice: m.price, stopPrice: stop, openedAt: Date.now(), conviction: inp.conviction, reason: inp.reason, probe };
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
      const igCap = Math.max(config.igMaxRiskGbp, (await fetchAccountFunds(session).catch(() => ({ balance: 0 }))).balance * config.igMaxRiskPct / 100);
      const riskGbp = Math.min(inp.size, igCap) * sizeFactor;
      const stake = Math.max(minDeal, calcStake(riskGbp, stopDist, minDeal));
      if (stake * stopDist > igCap * 1.5) return `REJECTED: IG's minimum stake (${minDeal}/pt) with a ${inp.stop_loss_pct}% stop risks £${(stake * stopDist).toFixed(0)}, above the £${igCap.toFixed(0)} cap — try a tighter stop or another market.`;
      const r = await igPlaceOrder(session, epic, inp.direction, stake, stopDist, undefined, 'GBP', false);
      const stop = inp.direction === 'BUY' ? r.level - stopDist : r.level + stopDist;
      const p: OpusPosition = { id: newId(), account: 'ig_demo', symbol, brokerRef: r.dealId, epic, direction: inp.direction, size: stake,
        entryPrice: r.level, stopPrice: round2(stop), openedAt: Date.now(), conviction: inp.conviction, reason: inp.reason, probe };
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
      entryPrice: m.price, stopPrice: stop, stopOrderId, openedAt: Date.now(), conviction: inp.conviction, reason: inp.reason };
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

const MAX_TURNS = 10;
const MAX_BACKTESTS_PER_SESSION = 4;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// One model call. Server-side fallback ("default") is on: if the model
// declines for policy reasons, the API re-runs the request on a suitable
// substitute inside the same call instead of the session just stopping.
function toolsFor(searches: number): Anthropic.Beta.BetaToolUnion[] {
  const base: Anthropic.Beta.BetaToolUnion[] = tvChartsOn() ? [...TOOLS, TV_TOOL] : TOOLS;
  if (!config.webResearch || searches <= 0) return base;
  return [
    ...base,
    // Anthropic-hosted research tools (2026-10-21, per explicit request that
    // Opus do its own research). max_uses caps cost per request.
    { type: 'web_search_20260209', name: 'web_search', max_uses: searches },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: searches },
  ];
}

async function callModel(model: OpusModel, system: string, messages: Anthropic.Beta.BetaMessageParam[], searches = 0): Promise<Anthropic.Beta.BetaMessage> {
  client ??= new Anthropic();
  return client.beta.messages.create({
    model,
    max_tokens: 16000,
    output_config: { effort: config.effort },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
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

export async function runOpusSession(trigger: 'scheduled' | 'manual' | 'tradingview' = 'scheduled'): Promise<{ ok: boolean; error?: string }> {
  if (busy) return { ok: false, error: 'A session is already running' };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: 'ANTHROPIC_API_KEY is not set on the server' };
  if (budgetLeftUsd() <= 0.25) { addLog('wait', `Monthly cap reached ($${spend.usd.toFixed(2)} of $${config.monthlyCapUsd}) — no sessions until next month or a higher cap`); return { ok: false, error: 'Monthly budget reached' }; }
  busy = true;
  const started = Date.now();
  const model = config.model;
  let sessionUsd = 0;
  try {
    const view = await livePositionView();
    await reconcile(view);
    const { text, metrics } = await buildBriefing(view);
    spend.cycles++; saveSpend();
    const research = config.webResearch && isUsSessionOpen() && nyDate() !== state.lastResearchDay;
    if (research) { state.lastResearchDay = nyDate(); saveState(); }
    const searches = research ? config.researchSearches : config.searchesPerSession;
    const system = SYSTEM_PROMPT + (tvChartsOn() ? TV_PROMPT : '') + (research ? RESEARCH_PROMPT : '');
    if (trigger === 'scheduled') lastScheduledAt = Date.now();
    addLog('info', `Session started (${trigger}${research ? ', daily research' : ''}${config.accounts.alpaca_paper && isUsSessionOpen() ? (alpacaInScope ? ', incl. Alpaca' : ', IG only') : ''}, ${MODELS[model].label}, effort ${config.effort}) — ${metrics.size} symbols, ${state.positions.length} open positions${config.webResearch ? `, up to ${searches} web searches` : ''}`);

    alpacaInScope = config.accounts.alpaca_paper && isUsSessionOpen()
      && (research || trigger === 'manual' || Date.now() - (state.lastAlpacaReviewAt ?? 0) >= config.alpacaEveryMinutes * 60_000 - 60_000);
    if (alpacaInScope) { state.lastAlpacaReviewAt = Date.now(); saveState(); }
    const alpacaNote = alpacaInScope || !config.accounts.alpaca_paper || !isUsSessionOpen() ? '' : `

ALPACA NOT IN SCOPE THIS SESSION: Alpaca is the long-term account and is reviewed every ${config.alpacaEveryMinutes} minutes, not every session. Don't analyse Alpaca entries now (they'd be rejected); its positions keep their broker stops. Only close an Alpaca position if something material broke its thesis. Focus on ig_demo.`;
    const offNote = isUsSessionOpen() ? alpacaNote : `\n\nOFF-HOURS SESSION: the US market is closed. US-share figures above are from the last session. Alpaca can't trade now; ig_demo can trade any market IG has open (indices, FX and commodities nearly round the clock; IG's US shares only when IG offers them out of hours — an order on a closed market is rejected). Manage open IG positions as usual.`;
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: text + offNote }];
    let backtestsLeft = MAX_BACKTESTS_PER_SESSION;
    let chartsLeft = MAX_CHARTS_PER_SESSION, shotsLeft = MAX_SCREENSHOTS_PER_SESSION;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (budgetLeftUsd() <= 0.25) { addLog('wait', 'Budget ran out mid-session — stopping here'); break; }
      // Only the first turn gets the research allowance, so the cap holds per session.
      const resp = await callModel(model, system, messages, turn === 0 ? searches : 0);
      sessionUsd += recordUsage(model, resp.usage);
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
      messages.push({ role: 'user', content: results });
    }

    if (config.shadowModel && config.shadowModel !== model && budgetLeftUsd() > 1) {
      try { sessionUsd += await runShadow(config.shadowModel, text, metrics); }
      catch (e) { addLog('error', `Shadow run failed: ${e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : String(e)}`); }
    }

    addLog('info', `Session done in ${((Date.now() - started) / 1000).toFixed(0)}s — cost $${sessionUsd.toFixed(3)}, month $${spend.usd.toFixed(2)} of $${config.monthlyCapUsd}`);
    lastRunAt = new Date().toISOString();
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

function schedule(): void {
  if (timer) clearTimeout(timer);
  if (!running) { nextRunAt = null; return; }
  // Off-hours the tick still fires on the US cadence (so the US open is never
  // missed) but only runs a session once offHoursMinutes have passed.
  const delay = config.cycleMinutes * 60_000;
  nextRunAt = Date.now() + delay;
  timer = setTimeout(() => { void tick(); }, delay);
}

async function tick(): Promise<void> {
  if (!running) return;
  if (isUsSessionOpen()) await runOpusSession('scheduled');
  else if (offHours() && Date.now() - lastScheduledAt >= config.offHoursMinutes * 60_000 - 60_000) await runOpusSession('scheduled');
  schedule();
}

export async function startOpus(): Promise<{ ok: boolean; error?: string }> {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: 'ANTHROPIC_API_KEY is not set on the server' };
  running = true;
  config.enabled = true; saveConfig();
  // One decision-maker per account: the existing bots stop opening trades on
  // accounts Opus manages (their existing positions keep their own exits).
  try {
    if (config.accounts.ig_demo) { const m = await import('./igStrategyBot'); m.pauseIgStrategyBot('demo'); }
    if (config.accounts.alpaca_paper) { const m = await import('./alpacaBot'); m.pauseAlpacaBot('paper'); }
  } catch (e) { addLog('error', `Couldn't pause an existing bot: ${e instanceof Error ? e.message : String(e)}`); }
  addLog('info', `Opus started — reviewing every ${config.cycleMinutes}min during the US session${config.offHoursMinutes > 0 && config.accounts.ig_demo ? ` and every ${config.offHoursMinutes}min outside it for IG markets (weekdays)` : ''}; existing IG demo / Alpaca paper bots paused for new entries`);
  if (isUsSessionOpen() || offHours()) void runOpusSession('scheduled');
  schedule();
  return { ok: true };
}

export function stopOpus(): { ok: boolean } {
  running = false;
  config.enabled = false; saveConfig();
  if (timer) clearTimeout(timer);
  timer = null; nextRunAt = null;
  addLog('info', 'Opus stopped — its open positions stay open with their broker stops; resume the other bots from their own pages if wanted');
  return { ok: true };
}

export function wasOpusRunning(): boolean { return config.enabled; }

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

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
import { EPIC_TO_ALPACA } from './yahooFetch';
import {
  getPortfolio, getCash, resolveT212Ticker, placeMarketOrder as t212PlaceOrder,
  placeStopLimitOrder, cancelOrder as t212CancelOrder,
} from './t212Api';
import { getGbpUsd } from './t212Bot';

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
  effort:               'low' | 'medium' | 'high' | 'xhigh';
  alpacaMaxPositionUsd: number;
  alpacaMaxPositions:   number;
  igMaxRiskGbp:         number;   // £ lost if the stop is hit
  igMaxPositions:       number;
  t212MaxPositionGbp:   number;
  t212MaxTotalGbp:      number;
  t212MaxPositions:     number;
  minConviction:        number;   // matches the 65% entry bar used everywhere else
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
  effort: 'medium',
  alpacaMaxPositionUsd: 5_000,
  alpacaMaxPositions: 8,
  igMaxRiskGbp: 10,
  igMaxPositions: 6,
  t212MaxPositionGbp: 100,
  t212MaxTotalGbp: 300,
  t212MaxPositions: 3,
  minConviction: 65,
  minHoldHours: 4,
  reentryCooldownHours: 24,
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
  reason:      string;
};

type ClosedRecord = OpusPosition & { closedAt: number; closeReason: string; plApprox: number | null };

type OpusState = {
  positions:      OpusPosition[];
  closed:         ClosedRecord[];       // newest last, trimmed
  notes:          string;               // Opus's own running strategy notes
  watchlistExtra: string[];             // symbols Opus added
  lastClosedAt:   Record<string, number>; // `${account}:${symbol}` → ts
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
let state: OpusState = { positions: [], closed: [], notes: '', watchlistExtra: [], lastClosedAt: {},
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
function recordUsage(model: OpusModel, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  const price = MODELS[model];
  const cr = u.cache_read_input_tokens ?? 0, cw = u.cache_creation_input_tokens ?? 0;
  const usd = (u.input_tokens * price.input + u.output_tokens * price.output + cr * price.cacheRead + cw * price.cacheWrite) / 1_000_000;
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

type Metrics = {
  symbol: string; price: number; dayChgPct: number; aboveOpen: boolean | null; volToday: number | null;
  sma20: number; sma50: number; trend12wPct: number | null; rsi14: number | null; atrPct: number | null;
  offHigh52wPct: number;
};

async function metricsFor(symbol: string): Promise<Metrics | null> {
  let bars: AlpacaBar[] | undefined;
  try { bars = (await getBars([symbol], '1Day', 260, 'paper'))[symbol]; } catch { return null; }
  if (!bars || bars.length < 60) return null;
  const c = bars.map(b => b.c), last = bars[bars.length - 1];
  const avg = (n: number) => c.slice(-n).reduce((s, x) => s + x, 0) / n;
  const atr = calcAtr(bars);
  return {
    symbol, price: last.c,
    dayChgPct: ((last.c - c[c.length - 2]) / c[c.length - 2]) * 100,
    aboveOpen: last.c > last.o ? true : last.c < last.o ? false : null,
    volToday: dailyVolumeRatio(bars, 'US'),
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

const SYSTEM_PROMPT = `You are the portfolio manager for a small trading operation, running a one-month trial. Each session you receive a briefing and act through tools. Your goal is risk-adjusted profit over weeks to months — not activity.

Accounts you control:
- alpaca_paper: US stocks/ETFs, paper money (USD). Long or short.
- ig_demo: UK spread bets on US shares, demo money (GBP). Long or short. You size by £ at risk; code derives the stake.
- t212_live: Trading 212 ISA, REAL money (GBP). Long only, small sizes. Be most selective here.

What is known about this account from its own history (treat as evidence, not dogma — you may revise it in your notes when your own results say otherwise):
- Short holds lost money: across 57 closed option trades, those held under a week went 2 wins / 44 trades; a week or longer went 8 / 13. The owner wants positions held for weeks to a few months. Don't trade around noise.
- A one-day volume/price move on its own did not predict the next 20 days. Price above both its 20- and 50-day averages with a 12-week gain of 8%+ was the best long-hold entry in a 2-year backtest; strong stocks kept going (an "extended" filter made results worse). This was a strong market on names partly chosen for having done well.
- Re-asking the same question on unchanged inputs produces unstable answers. Change your mind about an open position only when something material changed (price through a level, news, thesis broken) — not because the session repeated.

Data you get: every number in the briefing is computed by code from market data — price, day change, whether today trades above its open, today's volume vs that stock's normal day (vol1.0 = normal day, pro-rated for time of day), 20/50-day averages, 12-week trend, RSI(14), ATR% (typical daily range), distance off the 52-week high, plus recent headlines for some symbols. Do not estimate or second-guess the volume figures; code already enforces the volume rule.

Hard rules enforced by code (an order outside them is rejected and you'll see why): every position needs a stop-loss of 2-15%; conviction must be at least the configured minimum; a new stock entry needs today's volume ≥ a normal day AND today trading on the trade's side of its open; per-account position and size caps; no discretionary close within the minimum hold window (stops still fire); no re-entry into a symbol within the cooldown after closing it.

How to work a session:
1. Review your open positions against the thesis you recorded for each. Close only with a real reason.
2. Consider new entries only where the setup is genuinely good. Doing nothing is a fine outcome — most sessions should be.
3. If you learned something, update your notes. Keep them short and concrete.
4. End with a brief plain-text summary of what you did and why (2-4 sentences).`;

function fmt(n: number | null, d = 1): string { return n === null || !isFinite(n) ? '—' : n.toFixed(d); }

async function buildBriefing(view: Map<string, LivePos>): Promise<{ text: string; metrics: Map<string, Metrics> }> {
  const universe = [...new Set([...BASE_UNIVERSE, ...state.watchlistExtra, ...state.positions.map(p => p.symbol)])];
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
    try { const f = await fetchAccountFunds(await ig()); lines.push(`- ig_demo: balance £${f.balance.toFixed(0)}, available £${f.available.toFixed(0)}. Caps: ≤£${config.igMaxRiskGbp} at risk/position, ≤${config.igMaxPositions} of your positions. Tradeable: ${Object.keys(TICKER_TO_EPIC).filter(t => metrics.has(t)).join(', ')}.`); }
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
  lines.push('symbol | price | day% | vs open | vol (1.0=normal day) | >20d | >50d | 12w% | RSI | ATR% | off 52w high%');
  for (const m of metrics.values()) {
    lines.push(`${m.symbol} | ${fmt(m.price, 2)} | ${fmt(m.dayChgPct)} | ${m.aboveOpen === null ? '=' : m.aboveOpen ? 'above' : 'below'} | ${fmt(m.volToday, 2)} | ${m.price > m.sma20 ? 'Y' : 'N'} | ${m.price > m.sma50 ? 'Y' : 'N'} | ${fmt(m.trend12wPct)} | ${fmt(m.rsi14, 0)} | ${fmt(m.atrPct)} | ${fmt(m.offHigh52wPct)}`);
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
  lines.push('## Your strategy notes');
  lines.push(state.notes || '(none yet)');
  lines.push(`Extra watchlist: ${state.watchlistExtra.join(', ') || '(none)'}`);
  return { text: lines.join('\n'), metrics };
}

function newId(): string { return Math.random().toString(36).slice(2, 8); }
const round2 = (n: number) => Math.round(n * 100) / 100;

async function openPosition(inp: { account: OpusAccount; symbol: string; direction: 'BUY' | 'SELL'; size: number; stop_loss_pct: number; conviction: number; reason: string },
  metrics: Map<string, Metrics>): Promise<string> {
  const symbol = inp.symbol.toUpperCase().trim();
  if (!config.accounts[inp.account]) return `REJECTED: ${inp.account} is disabled.`;
  if (inp.conviction < config.minConviction) return `REJECTED: conviction ${inp.conviction} is below the ${config.minConviction} minimum.`;
  if (!(inp.stop_loss_pct >= 2 && inp.stop_loss_pct <= 15)) return 'REJECTED: stop_loss_pct must be between 2 and 15.';
  if (!(inp.size > 0)) return 'REJECTED: size must be positive.';
  const m = metrics.get(symbol);
  if (!m) return `REJECTED: no market data for ${symbol} this session.`;
  // Volume in the trade's direction — enforced in code, never by the model.
  if (m.volToday === null || m.volToday < 1.0) return `REJECTED: today's volume is ${fmt(m.volToday, 2)}x a normal day; the rule needs at least 1.0x.`;
  if (todayAgainstFromMetrics(m, inp.direction)) return `REJECTED: today is trading ${inp.direction === 'BUY' ? 'below' : 'above'} its open — today's volume is on the other side.`;
  const cool = state.lastClosedAt[`${inp.account}:${symbol}`];
  if (cool && Date.now() - cool < config.reentryCooldownHours * 3_600_000) return `REJECTED: closed ${symbol} on ${inp.account} ${((Date.now() - cool) / 3_600_000).toFixed(1)}h ago — cooldown is ${config.reentryCooldownHours}h.`;
  if (state.positions.some(p => p.account === inp.account && p.symbol === symbol)) return `REJECTED: you already hold ${symbol} on ${inp.account}.`;
  const mine = state.positions.filter(p => p.account === inp.account);

  try {
    if (inp.account === 'alpaca_paper') {
      if (mine.length >= config.alpacaMaxPositions) return `REJECTED: already at ${config.alpacaMaxPositions} alpaca_paper positions.`;
      const usd = Math.min(inp.size, config.alpacaMaxPositionUsd);
      const qty = Math.floor(usd / m.price);
      if (qty < 1) return `REJECTED: $${usd} buys less than one share at $${m.price.toFixed(2)}.`;
      const stop = round2(inp.direction === 'BUY' ? m.price * (1 - inp.stop_loss_pct / 100) : m.price * (1 + inp.stop_loss_pct / 100));
      await alpacaPlaceOrder('paper', {
        symbol, qty, side: inp.direction === 'BUY' ? 'buy' : 'sell', type: 'market', time_in_force: 'day',
        order_class: 'oto', stop_loss: { stop_price: stop }, client_order_id: `opus-${symbol}-${Date.now()}`,
      });
      const p: OpusPosition = { id: newId(), account: 'alpaca_paper', symbol, brokerRef: symbol, direction: inp.direction, size: qty,
        entryPrice: m.price, stopPrice: stop, openedAt: Date.now(), conviction: inp.conviction, reason: inp.reason };
      state.positions.push(p); saveState();
      addLog('enter', `alpaca_paper ${inp.direction} ${qty} ${symbol} @~$${m.price.toFixed(2)} stop $${stop} (conviction ${inp.conviction}) — ${inp.reason}`);
      return `OPENED id=${p.id}: ${inp.direction} ${qty} ${symbol} @~$${m.price.toFixed(2)}, stop $${stop}.`;
    }

    if (inp.account === 'ig_demo') {
      if (mine.length >= config.igMaxPositions) return `REJECTED: already at ${config.igMaxPositions} ig_demo positions.`;
      const epic = TICKER_TO_EPIC[symbol];
      if (!epic) return `REJECTED: ${symbol} has no IG market mapping.`;
      const session = await ig();
      const d = (await fetchMarketDetails(session, [epic])).get(epic);
      const px = inp.direction === 'BUY' ? d?.offer : d?.bid;
      if (typeof px !== 'number' || !(px > 0)) return `REJECTED: no live IG quote for ${symbol} right now.`;
      const minStop = d?.minStopDist || 1, minDeal = d?.minDealSize || 0.5;
      const stopDist = Math.max(minStop, px * inp.stop_loss_pct / 100);
      const riskGbp = Math.min(inp.size, config.igMaxRiskGbp);
      const stake = Math.max(minDeal, calcStake(riskGbp, stopDist, minDeal));
      if (stake * stopDist > config.igMaxRiskGbp * 1.5) return `REJECTED: IG's minimum stake (${minDeal}/pt) with a ${inp.stop_loss_pct}% stop risks £${(stake * stopDist).toFixed(0)}, above the £${config.igMaxRiskGbp} cap — try a tighter stop or another market.`;
      const r = await igPlaceOrder(session, epic, inp.direction, stake, stopDist, undefined, 'GBP', false);
      const stop = inp.direction === 'BUY' ? r.level - stopDist : r.level + stopDist;
      const p: OpusPosition = { id: newId(), account: 'ig_demo', symbol, brokerRef: r.dealId, epic, direction: inp.direction, size: stake,
        entryPrice: r.level, stopPrice: round2(stop), openedAt: Date.now(), conviction: inp.conviction, reason: inp.reason };
      state.positions.push(p); saveState();
      addLog('enter', `ig_demo ${inp.direction} ${symbol} £${stake}/pt @ ${r.level} stop ${round2(stop)} (risk ≈ £${(stake * stopDist).toFixed(2)}, conviction ${inp.conviction}) — ${inp.reason}`);
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

function todayAgainstFromMetrics(m: Metrics, dir: 'BUY' | 'SELL'): boolean {
  if (m.aboveOpen === null) return true;  // flat vs open = no directional confirmation
  return dir === 'BUY' ? !m.aboveOpen : m.aboveOpen;
}

async function closePosition(id: string, reason: string, view: Map<string, LivePos>, manual = false): Promise<string> {
  const p = state.positions.find(x => x.id === id);
  if (!p) return `REJECTED: no open position with id ${id}.`;
  const heldH = (Date.now() - p.openedAt) / 3_600_000;
  if (!manual && heldH < config.minHoldHours) return `REJECTED: held ${heldH.toFixed(1)}h — minimum hold is ${config.minHoldHours}h (the stop still protects it).`;
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

const MAX_TURNS = 8;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// One model call. Server-side fallback ("default") is on: if the model
// declines for policy reasons, the API re-runs the request on a suitable
// substitute inside the same call instead of the session just stopping.
async function callModel(model: OpusModel, system: string, messages: Anthropic.Beta.BetaMessageParam[]): Promise<Anthropic.Beta.BetaMessage> {
  client ??= new Anthropic();
  return client.beta.messages.create({
    model,
    max_tokens: 16000,
    output_config: { effort: config.effort },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools: TOOLS,
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

export async function runOpusSession(trigger: 'scheduled' | 'manual' = 'scheduled'): Promise<{ ok: boolean; error?: string }> {
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
    addLog('info', `Session started (${trigger}, ${MODELS[model].label}, effort ${config.effort}) — ${metrics.size} symbols, ${state.positions.length} open positions`);

    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: text }];
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (budgetLeftUsd() <= 0.25) { addLog('wait', 'Budget ran out mid-session — stopping here'); break; }
      const resp = await callModel(model, SYSTEM_PROMPT, messages);
      sessionUsd += recordUsage(model, resp.usage);
      if (resp.model !== model) addLog('info', `Served by fallback model ${resp.model} this turn`);
      if (resp.stop_reason === 'refusal') { addLog('error', 'The model declined this session (refusal, fallback included)'); break; }

      const toolUses = resp.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      for (const b of resp.content) if (b.type === 'text' && b.text.trim()) addLog('think', b.text.trim().slice(0, 1500));
      if (resp.stop_reason === 'max_tokens') { addLog('error', 'Response hit max_tokens — tool inputs may be truncated, not running them'); break; }
      if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) break;

      messages.push({ role: 'assistant', content: resp.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const t of toolUses) {
        let out: string;
        const input = t.input as Record<string, unknown>;
        try {
          if (t.name === 'open_position') out = await openPosition(input as Parameters<typeof openPosition>[0], metrics);
          else if (t.name === 'close_position') out = await closePosition(String(input.position_id), String(input.reason), view);
          else if (t.name === 'update_notes') { state.notes = String(input.notes).slice(0, 3000); saveState(); addLog('info', 'Updated its strategy notes'); out = 'Notes saved.'; }
          else if (t.name === 'set_watchlist_extra') {
            const syms = (Array.isArray(input.symbols) ? input.symbols : []).map(s => String(s).toUpperCase().trim()).filter(s => /^[A-Z.]{1,6}$/.test(s)).slice(0, 20);
            state.watchlistExtra = syms; saveState(); addLog('info', `Watchlist extras: ${syms.join(', ') || '(none)'}`); out = `Saved ${syms.length} symbols.`;
          } else out = `Unknown tool ${t.name}`;
        } catch (e) { out = `ERROR: ${e instanceof Error ? e.message : String(e)}`; }
        if (out.startsWith('REJECTED')) addLog('wait', `${t.name}: ${out}`);
        results.push({ type: 'tool_result', tool_use_id: t.id, content: out, ...(out.startsWith('REJECTED') || out.startsWith('FAILED') ? { is_error: true } : {}) });
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

function schedule(): void {
  if (timer) clearTimeout(timer);
  if (!running) { nextRunAt = null; return; }
  const delay = config.cycleMinutes * 60_000;
  nextRunAt = Date.now() + delay;
  timer = setTimeout(() => { void tick(); }, delay);
}

async function tick(): Promise<void> {
  if (!running) return;
  if (isUsSessionOpen()) await runOpusSession('scheduled');
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
  addLog('info', `Opus started — reviewing every ${config.cycleMinutes}min during the US session; existing IG demo / Alpaca paper bots paused for new entries`);
  if (isUsSessionOpen()) void runOpusSession('scheduled');
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

export function updateOpusConfig(patch: Partial<OpusConfig>): { ok: boolean; config: OpusConfig; error?: string } {
  const next: OpusConfig = { ...config, ...patch, accounts: { ...config.accounts, ...(patch.accounts ?? {}) } };
  // Sanity bounds so a typo in the UI can't remove the guard rails.
  if (!(next.monthlyCapUsd > 0 && next.monthlyCapUsd <= 500)) return { ok: false, config, error: 'monthlyCapUsd must be 1-500' };
  if (!(next.cycleMinutes >= 15 && next.cycleMinutes <= 240)) return { ok: false, config, error: 'cycleMinutes must be 15-240' };
  if (!(next.t212MaxPositionGbp > 0 && next.t212MaxPositionGbp <= 1000)) return { ok: false, config, error: 't212MaxPositionGbp must be 1-1000' };
  if (!(next.t212MaxTotalGbp >= next.t212MaxPositionGbp && next.t212MaxTotalGbp <= 3000)) return { ok: false, config, error: 't212MaxTotalGbp must be ≥ per-position and ≤ 3000' };
  if (!(next.minConviction >= 50 && next.minConviction <= 95)) return { ok: false, config, error: 'minConviction must be 50-95' };
  if (!['low', 'medium', 'high', 'xhigh'].includes(next.effort)) return { ok: false, config, error: 'effort must be low/medium/high/xhigh' };
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
    running, busy, apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY,
    usSessionOpen: isUsSessionOpen(), nextRunAt, lastRunAt,
    config, spend, budgetLeftUsd: budgetLeftUsd(), models: MODELS,
    positions: state.positions.map(p => ({ ...p, livePl: view.get(p.id)?.pl ?? null, liveCurrent: view.get(p.id)?.current ?? null })),
    closed: state.closed.slice(-50).reverse(),
    notes: state.notes, watchlistExtra: state.watchlistExtra,
    log: log.slice(0, 200),
  };
}

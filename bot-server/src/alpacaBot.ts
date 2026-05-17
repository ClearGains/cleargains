import {
  getAccount, getPositions, getBars, getLatestBars, placeOrder, closePosition,
  cancelAllOrders, isNYSEOpen, isInOpeningRange, isNearClose,
  isDailyCheckTime, isWeeklyCheckTime,
  type AccountMode, type AlpacaPosition,
} from './alpacaApi';
import {
  rsiMeanReversionSignal, emaCrossoverSignal, orbSignal,
  vwapSignal, weeklyMomentumSignal,
  STRATEGY_META,
  type StrategyName, type StrategySignal,
} from './alpacaStrategies';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AlpacaBotConfig = {
  mode:             AccountMode;
  strategy:         StrategyName;
  symbols:          string[];
  positionSizeUsd:  number;    // notional $ per position (supports fractional shares)
  maxPositions:     number;
  allowShorts:      boolean;
};

export type AlpacaLogEntry = {
  id:     string;
  ts:     string;
  type:   'info' | 'enter' | 'exit' | 'wait' | 'error';
  symbol: string;
  msg:    string;
};

export type AlpacaBotStatus = {
  running:     boolean;
  paused:      boolean;
  mode:        AccountMode;
  strategy:    StrategyName;
  symbols:     string[];
  equity:      string;
  cash:        string;
  positions:   AlpacaPosition[];
  log:         AlpacaLogEntry[];
  nextRunMs:   number | null;
  orbState:    Record<string, OrbState>;
  lastPollTs:  string | null;
};

type OrbState = { high: number; low: number; established: boolean };

// ── State ─────────────────────────────────────────────────────────────────────

let running        = false;
let paused         = false;
let config: AlpacaBotConfig | null = null;

const log: AlpacaLogEntry[] = [];
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let nextRunMs: number | null = null;
let lastPollTs: string | null = null;

const orbState: Record<string, OrbState> = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid()  { return Math.random().toString(36).slice(2, 8); }
function now()  { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

function addLog(type: AlpacaLogEntry['type'], symbol: string, msg: string) {
  const entry: AlpacaLogEntry = { id: uid(), ts: now(), type, symbol, msg };
  log.unshift(entry);
  if (log.length > 400) log.splice(400);
  const level = type === 'error' ? 'error' : 'log';
  console[level](`[alpaca] [${entry.ts}] [${type.toUpperCase()}] [${symbol}] ${msg}`);
}

// ── ORB range builder ─────────────────────────────────────────────────────────

function resetOrbState(symbols: string[]) {
  for (const sym of symbols) {
    orbState[sym] = { high: 0, low: 0, established: false };
  }
}

async function buildOrbRange(symbols: string[], mode: AccountMode) {
  addLog('info', '—', 'Building Opening Range (first 30 min)…');
  try {
    const barsMap = await getBars(symbols, '1Min', 60, mode);
    for (const sym of symbols) {
      const bars = barsMap[sym] ?? [];
      if (!bars.length) continue;
      const orbBars = bars.slice(-30);   // last 30 1-min bars = 30 minutes
      const high = Math.max(...orbBars.map(b => b.h));
      const low  = Math.min(...orbBars.map(b => b.l));
      orbState[sym] = { high, low, established: true };
      addLog('info', sym, `ORB established: ${low.toFixed(2)}–${high.toFixed(2)}`);
    }
  } catch (e) {
    addLog('error', '—', `ORB build failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Signal dispatch ───────────────────────────────────────────────────────────

async function evaluateSymbol(
  sym:       string,
  positions: AlpacaPosition[],
  cfg:       AlpacaBotConfig,
): Promise<void> {
  const openPos    = positions.find(p => p.symbol === sym);
  const inPosition = !!openPos;
  const side       = openPos?.side;
  const meta       = STRATEGY_META[cfg.strategy];

  let bars;
  try {
    const barsMap = await getBars([sym], meta.barPeriod, meta.barsNeeded, cfg.mode);
    bars = barsMap[sym] ?? [];
  } catch (e) {
    addLog('error', sym, `Failed to fetch bars: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (!bars.length) {
    addLog('wait', sym, 'No bar data returned');
    return;
  }

  let signal: StrategySignal;

  switch (cfg.strategy) {
    case 'rsi_mean_reversion':
      signal = rsiMeanReversionSignal(bars, inPosition, side);
      break;

    case 'ema_crossover':
      signal = emaCrossoverSignal(bars, inPosition, side);
      break;

    case 'orb': {
      const orb = orbState[sym] ?? { high: 0, low: 0, established: false };
      if (!orb.established) {
        addLog('wait', sym, 'ORB not established yet');
        return;
      }
      const latestBars = await getLatestBars([sym], cfg.mode).catch(() => ({} as Record<string, typeof bars[0]>));
      const price      = latestBars[sym]?.c ?? bars[bars.length - 1].c;
      signal = orbSignal(orb.high, orb.low, price, inPosition, side);
      break;
    }

    case 'vwap': {
      const latestBars = await getLatestBars([sym], cfg.mode).catch(() => ({} as Record<string, typeof bars[0]>));
      const price      = latestBars[sym]?.c ?? bars[bars.length - 1].c;
      signal = vwapSignal(bars, price, inPosition, side);
      break;
    }

    case 'weekly_momentum': {
      let dailyBars: import('./alpacaApi').AlpacaBar[] = [];
      try {
        const daily = await getBars([sym], '1Day', 30, cfg.mode);
        dailyBars = daily[sym] ?? [];
      } catch {
        dailyBars = [];
      }
      signal = weeklyMomentumSignal(bars, dailyBars, inPosition, side);
      break;
    }

    default:
      return;
  }

  await executeSignal(sym, signal, openPos ?? null, cfg);
}

// ── Order execution ───────────────────────────────────────────────────────────

async function executeSignal(
  sym:     string,
  signal:  StrategySignal,
  openPos: AlpacaPosition | null,
  cfg:     AlpacaBotConfig,
): Promise<void> {
  const { action, reason, stopPrice, takeProfitPrice, trailPercent, orderType } = signal;

  if (action === 'HOLD') {
    addLog('wait', sym, reason);
    return;
  }

  if (action === 'CLOSE_LONG' || action === 'CLOSE_SHORT') {
    if (!openPos) return;
    addLog('exit', sym, `Closing position — ${reason}`);
    try {
      await closePosition(cfg.mode, sym);
      addLog('exit', sym, `Position closed`);
    } catch (e) {
      addLog('error', sym, `Close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  // BUY or SELL — check guards before opening
  if (paused) {
    addLog('wait', sym, `⏸ Paused — skipping ${action} signal`);
    return;
  }

  if (action === 'SELL' && !cfg.allowShorts) {
    addLog('wait', sym, 'Short selling disabled — skipping SELL signal');
    return;
  }

  if (openPos) {
    addLog('wait', sym, `Already in position (${openPos.side}) — skipping ${action}`);
    return;
  }

  if (isNearClose()) {
    addLog('wait', sym, '⏸ Market closing in <15 min — no new entries');
    return;
  }

  const orderSide = action === 'BUY' ? 'buy' : 'sell';

  addLog('enter', sym, `${action} signal — ${reason}`);
  if (stopPrice)       addLog('info', sym, `Stop: ${stopPrice.toFixed(4)}`);
  if (takeProfitPrice) addLog('info', sym, `TP:   ${takeProfitPrice.toFixed(4)}`);

  try {
    const order = await placeOrder(cfg.mode, {
      symbol:       sym,
      notional:     cfg.positionSizeUsd,
      side:         orderSide,
      type:         orderType === 'trailing_stop' ? 'trailing_stop' : 'market',
      time_in_force: 'day',
      ...(trailPercent ? { trail_percent: trailPercent } : {}),
    });

    addLog('enter', sym, `Order placed — id ${order.id} status ${order.status}`);

    // Place stop-loss bracket order if we have a stop price (separate order)
    if (stopPrice && orderType !== 'trailing_stop') {
      try {
        await placeOrder(cfg.mode, {
          symbol:       sym,
          qty:          parseFloat(order.filled_qty || '0') || undefined,
          notional:     !parseFloat(order.filled_qty || '0') ? cfg.positionSizeUsd : undefined,
          side:         orderSide === 'buy' ? 'sell' : 'buy',
          type:         'stop',
          time_in_force: 'gtc',
          stop_price:   stopPrice,
        });
        addLog('info', sym, `Stop order placed at ${stopPrice.toFixed(4)}`);
      } catch {
        addLog('info', sym, 'Stop order skipped (will manage manually)');
      }
    }
  } catch (e) {
    addLog('error', sym, `Order failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function poll() {
  if (!running || !config) return;

  const cfg  = config;
  const meta = STRATEGY_META[cfg.strategy];
  lastPollTs = new Date().toISOString();

  // Intraday strategies: skip when market is closed
  if (meta.timeframe === 'intraday' && !isNYSEOpen()) {
    addLog('wait', '—', 'Market closed — skipping poll');
    schedule(cfg);
    return;
  }

  // Daily strategy: only run once at close time
  if (meta.timeframe === 'daily' && !isDailyCheckTime()) {
    schedule(cfg);
    return;
  }

  // Weekly strategy: only run once on Monday
  if (meta.timeframe === 'weekly' && !isWeeklyCheckTime()) {
    schedule(cfg);
    return;
  }

  // ORB: build range during opening window, then trade
  if (cfg.strategy === 'orb') {
    if (isInOpeningRange()) {
      await buildOrbRange(cfg.symbols, cfg.mode);
      schedule(cfg);
      return;
    }
  }

  // Fetch account + positions
  let positions: AlpacaPosition[] = [];
  try {
    const account = await getAccount(cfg.mode);
    positions     = await getPositions(cfg.mode);
    // Quietly update equity in log periodically
    if (Math.random() < 0.1) {
      addLog('info', '—', `Equity: $${parseFloat(account.equity).toFixed(2)} | Cash: $${parseFloat(account.cash).toFixed(2)} | Positions: ${positions.length}`);
    }
  } catch (e) {
    addLog('error', '—', `Account fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    schedule(cfg);
    return;
  }

  // Enforce max positions guard
  const openCount = positions.length;

  // Evaluate each symbol
  for (const sym of cfg.symbols) {
    if (!running) break;
    const inPos = positions.find(p => p.symbol === sym);
    if (!inPos && openCount >= cfg.maxPositions) {
      addLog('wait', sym, `Max positions (${cfg.maxPositions}) reached — skipping`);
      continue;
    }
    await evaluateSymbol(sym, positions, cfg);
  }

  schedule(cfg);
}

function schedule(cfg: AlpacaBotConfig) {
  if (!running) return;
  const delay = STRATEGY_META[cfg.strategy].pollMs;
  nextRunMs   = Date.now() + delay;
  pollTimer   = setTimeout(() => { void poll(); }, delay);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function startAlpacaBot(cfg: AlpacaBotConfig): Promise<{ ok: boolean; error?: string }> {
  if (running) stopAlpacaBot();

  try {
    // Validate credentials by fetching account
    const account = await getAccount(cfg.mode);
    if (account.trading_blocked) {
      return { ok: false, error: 'Account trading is blocked' };
    }
    addLog('info', '—', `Alpaca ${cfg.mode} account connected — equity $${parseFloat(account.equity).toFixed(2)}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Alpaca auth failed: ${msg}` };
  }

  config  = cfg;
  running = true;
  paused  = false;

  if (cfg.strategy === 'orb') resetOrbState(cfg.symbols);

  addLog('info', '—', `Bot started — strategy: ${STRATEGY_META[cfg.strategy].label} | mode: ${cfg.mode} | symbols: ${cfg.symbols.join(', ')}`);
  addLog('info', '—', `Position size: $${cfg.positionSizeUsd} | max positions: ${cfg.maxPositions} | shorts: ${cfg.allowShorts ? 'allowed' : 'disabled'}`);

  void poll();
  return { ok: true };
}

export function stopAlpacaBot(): void {
  running = false;
  paused  = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  nextRunMs  = null;
  lastPollTs = null;
  addLog('info', '—', 'Alpaca bot stopped');
}

export function pauseAlpacaBot(): void {
  if (!running) return;
  paused = true;
  addLog('info', '—', '⏸ Alpaca bot paused — monitoring positions, no new entries');
}

export function resumeAlpacaBot(): void {
  if (!running) return;
  paused = false;
  addLog('info', '—', '▶ Alpaca bot resumed');
}

export async function getAlpacaBotStatus(mode: AccountMode): Promise<AlpacaBotStatus> {
  let positions: AlpacaPosition[] = [];
  let equity = '0', cash = '0';

  if (running && config) {
    try {
      const [acct, pos] = await Promise.all([getAccount(mode), getPositions(mode)]);
      positions = pos;
      equity    = acct.equity;
      cash      = acct.cash;
    } catch {}
  }

  return {
    running,
    paused,
    mode:       config?.mode      ?? mode,
    strategy:   config?.strategy  ?? 'rsi_mean_reversion',
    symbols:    config?.symbols   ?? [],
    equity,
    cash,
    positions,
    log:        log.slice(0, 100),
    nextRunMs,
    orbState:   { ...orbState },
    lastPollTs,
  };
}

export async function emergencyStop(mode: AccountMode): Promise<{ ok: boolean; error?: string }> {
  stopAlpacaBot();
  try {
    await cancelAllOrders(mode);
    addLog('info', '—', 'Emergency stop: all orders cancelled');
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    addLog('error', '—', `Emergency stop error: ${msg}`);
    return { ok: false, error: msg };
  }
}

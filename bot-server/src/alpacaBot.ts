import {
  getAccount, getPositions, getBars, getLatestBars, placeOrder, closePosition,
  cancelAllOrders, isNYSEOpen, isInOpeningRange, isNearClose,
  isDailyCheckTime, isWeeklyCheckTime, isWeekend, msUntilMondayOpen,
  type AccountMode, type AlpacaPosition,
} from './alpacaApi';
import { scanForBestSymbols } from './alpacaScanner';
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
  symbols:          string[];   // populated by scanner — do not set manually
  positionSizeUsd:  number;
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

// ── Per-mode state ────────────────────────────────────────────────────────────

type ModeState = {
  running:    boolean;
  paused:     boolean;
  config:     AlpacaBotConfig | null;
  log:        AlpacaLogEntry[];
  pollTimer:  ReturnType<typeof setTimeout> | null;
  nextRunMs:  number | null;
  lastPollTs: string | null;
  orbState:   Record<string, OrbState>;
};

function makeModeState(): ModeState {
  return {
    running: false, paused: false, config: null,
    log: [], pollTimer: null, nextRunMs: null, lastPollTs: null,
    orbState: {},
  };
}

const modeStates = new Map<AccountMode, ModeState>([
  ['paper', makeModeState()],
  ['live',  makeModeState()],
]);

function s(mode: AccountMode): ModeState {
  return modeStates.get(mode)!;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 8); }
function now() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

function addLog(mode: AccountMode, type: AlpacaLogEntry['type'], symbol: string, msg: string) {
  const st    = s(mode);
  const entry: AlpacaLogEntry = { id: uid(), ts: now(), type, symbol, msg };
  st.log.unshift(entry);
  if (st.log.length > 400) st.log.splice(400);
  const level = type === 'error' ? 'error' : 'log';
  console[level](`[alpaca:${mode}] [${entry.ts}] [${type.toUpperCase()}] [${symbol}] ${msg}`);
}

// ── ORB range builder ─────────────────────────────────────────────────────────

function resetOrbState(mode: AccountMode, symbols: string[]) {
  const st = s(mode);
  for (const sym of symbols) {
    st.orbState[sym] = { high: 0, low: 0, established: false };
  }
}

async function buildOrbRange(mode: AccountMode, symbols: string[]) {
  addLog(mode, 'info', '—', 'Building Opening Range (first 30 min)…');
  try {
    const barsMap = await getBars(symbols, '1Min', 60, mode);
    const st      = s(mode);
    for (const sym of symbols) {
      const bars    = barsMap[sym] ?? [];
      if (!bars.length) continue;
      const orbBars = bars.slice(-30);
      const high    = Math.max(...orbBars.map(b => b.h));
      const low     = Math.min(...orbBars.map(b => b.l));
      st.orbState[sym] = { high, low, established: true };
      addLog(mode, 'info', sym, `ORB established: ${low.toFixed(2)}–${high.toFixed(2)}`);
    }
  } catch (e) {
    addLog(mode, 'error', '—', `ORB build failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Signal dispatch ───────────────────────────────────────────────────────────

async function evaluateSymbol(
  mode:      AccountMode,
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
    const barsMap = await getBars([sym], meta.barPeriod, meta.barsNeeded, mode);
    bars = barsMap[sym] ?? [];
  } catch (e) {
    addLog(mode, 'error', sym, `Failed to fetch bars: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (!bars.length) {
    addLog(mode, 'wait', sym, 'No bar data returned');
    return;
  }

  let signal: StrategySignal;
  const st = s(mode);

  switch (cfg.strategy) {
    case 'rsi_mean_reversion':
      signal = rsiMeanReversionSignal(bars, inPosition, side);
      break;

    case 'ema_crossover':
      signal = emaCrossoverSignal(bars, inPosition, side);
      break;

    case 'orb': {
      const orb = st.orbState[sym] ?? { high: 0, low: 0, established: false };
      if (!orb.established) {
        addLog(mode, 'wait', sym, 'ORB not established yet');
        return;
      }
      const latestBars = await getLatestBars([sym], mode).catch(() => ({} as Record<string, typeof bars[0]>));
      const price      = latestBars[sym]?.c ?? bars[bars.length - 1].c;
      signal = orbSignal(orb.high, orb.low, price, inPosition, side);
      break;
    }

    case 'vwap': {
      const latestBars = await getLatestBars([sym], mode).catch(() => ({} as Record<string, typeof bars[0]>));
      const price      = latestBars[sym]?.c ?? bars[bars.length - 1].c;
      signal = vwapSignal(bars, price, inPosition, side);
      break;
    }

    case 'weekly_momentum': {
      let dailyBars: import('./alpacaApi').AlpacaBar[] = [];
      try {
        const daily = await getBars([sym], '1Day', 30, mode);
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

  await executeSignal(mode, sym, signal, openPos ?? null, cfg);
}

// ── Order execution ───────────────────────────────────────────────────────────

async function executeSignal(
  mode:    AccountMode,
  sym:     string,
  signal:  StrategySignal,
  openPos: AlpacaPosition | null,
  cfg:     AlpacaBotConfig,
): Promise<void> {
  const { action, reason, stopPrice, takeProfitPrice, trailPercent, orderType } = signal;
  const st = s(mode);

  if (action === 'HOLD') {
    addLog(mode, 'wait', sym, reason);
    return;
  }

  if (action === 'CLOSE_LONG' || action === 'CLOSE_SHORT') {
    if (!openPos) return;
    addLog(mode, 'exit', sym, `Closing position — ${reason}`);
    try {
      await closePosition(mode, sym);
      addLog(mode, 'exit', sym, 'Position closed');

      // Find replacement symbol for the freed slot
      void (async () => {
        try {
          const current = st.config?.symbols ?? [];
          const held    = (await getPositions(mode)).map(p => p.symbol);
          const exclude = [...new Set([...current, ...held])].filter(s => s !== sym);
          const picks   = await scanForBestSymbols(
            cfg.strategy, mode, exclude, 1,
            msg => addLog(mode, 'info', '—', msg),
          );
          if (picks[0] && st.config) {
            const idx = st.config.symbols.indexOf(sym);
            if (idx !== -1) st.config.symbols[idx] = picks[0];
            else st.config.symbols.push(picks[0]);
            addLog(mode, 'info', '—', `Slot replacement: ${sym} → ${picks[0]}`);
          }
        } catch (e) {
          addLog(mode, 'info', '—', `Replacement scan failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    } catch (e) {
      addLog(mode, 'error', sym, `Close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (st.paused) {
    addLog(mode, 'wait', sym, `⏸ Paused — skipping ${action} signal`);
    return;
  }

  if (action === 'SELL' && !cfg.allowShorts) {
    addLog(mode, 'wait', sym, 'Short selling disabled — skipping SELL signal');
    return;
  }

  if (openPos) {
    addLog(mode, 'wait', sym, `Already in position (${openPos.side}) — skipping ${action}`);
    return;
  }

  if (isNearClose()) {
    addLog(mode, 'wait', sym, '⏸ Market closing in <15 min — no new entries');
    return;
  }

  const orderSide = action === 'BUY' ? 'buy' : 'sell';

  addLog(mode, 'enter', sym, `${action} signal — ${reason}`);
  if (stopPrice)       addLog(mode, 'info', sym, `Stop: ${stopPrice.toFixed(4)}`);
  if (takeProfitPrice) addLog(mode, 'info', sym, `TP:   ${takeProfitPrice.toFixed(4)}`);

  try {
    const order = await placeOrder(mode, {
      symbol:        sym,
      notional:      cfg.positionSizeUsd,
      side:          orderSide,
      type:          orderType === 'trailing_stop' ? 'trailing_stop' : 'market',
      time_in_force: 'day',
      ...(trailPercent ? { trail_percent: trailPercent } : {}),
    });

    addLog(mode, 'enter', sym, `Order placed — id ${order.id} status ${order.status}`);

    if (stopPrice && orderType !== 'trailing_stop') {
      try {
        await placeOrder(mode, {
          symbol:        sym,
          qty:           parseFloat(order.filled_qty || '0') || undefined,
          notional:      !parseFloat(order.filled_qty || '0') ? cfg.positionSizeUsd : undefined,
          side:          orderSide === 'buy' ? 'sell' : 'buy',
          type:          'stop',
          time_in_force: 'gtc',
          stop_price:    stopPrice,
        });
        addLog(mode, 'info', sym, `Stop order placed at ${stopPrice.toFixed(4)}`);
      } catch {
        addLog(mode, 'info', sym, 'Stop order skipped (will manage manually)');
      }
    }
  } catch (e) {
    addLog(mode, 'error', sym, `Order failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function poll(mode: AccountMode) {
  const st = s(mode);
  if (!st.running || !st.config) return;

  const cfg  = st.config;
  const meta = STRATEGY_META[cfg.strategy];
  st.lastPollTs = new Date().toISOString();

  // Weekend — markets closed globally, sleep until Monday 13:00 UTC
  if (isWeekend()) {
    const sleepMs = msUntilMondayOpen();
    addLog(mode, 'wait', '—', `Weekend — markets closed. Sleeping until Monday open (~${Math.round(sleepMs / 3_600_000)}h)`);
    st.nextRunMs = Date.now() + sleepMs;
    st.pollTimer = setTimeout(() => { void poll(mode); }, sleepMs);
    return;
  }

  if (meta.timeframe === 'intraday' && !isNYSEOpen()) {
    addLog(mode, 'wait', '—', 'Market closed — skipping poll');
    schedule(mode, cfg);
    return;
  }

  if (meta.timeframe === 'daily' && !isDailyCheckTime()) {
    schedule(mode, cfg);
    return;
  }

  if (meta.timeframe === 'weekly' && !isWeeklyCheckTime()) {
    schedule(mode, cfg);
    return;
  }

  if (cfg.strategy === 'orb') {
    if (isInOpeningRange()) {
      await buildOrbRange(mode, cfg.symbols);
      schedule(mode, cfg);
      return;
    }
  }

  let positions: AlpacaPosition[] = [];
  try {
    const account = await getAccount(mode);
    positions     = await getPositions(mode);
    if (Math.random() < 0.1) {
      addLog(mode, 'info', '—', `Equity: $${parseFloat(account.equity).toFixed(2)} | Cash: $${parseFloat(account.cash).toFixed(2)} | Positions: ${positions.length}`);
    }
  } catch (e) {
    addLog(mode, 'error', '—', `Account fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    schedule(mode, cfg);
    return;
  }

  const openCount = positions.length;

  for (const sym of cfg.symbols) {
    if (!st.running) break;
    const inPos = positions.find(p => p.symbol === sym);
    if (!inPos && openCount >= cfg.maxPositions) {
      addLog(mode, 'wait', sym, `Max positions (${cfg.maxPositions}) reached — skipping`);
      continue;
    }
    await evaluateSymbol(mode, sym, positions, cfg);
  }

  schedule(mode, cfg);
}

function schedule(mode: AccountMode, cfg: AlpacaBotConfig) {
  const st = s(mode);
  if (!st.running) return;
  const delay   = STRATEGY_META[cfg.strategy].pollMs;
  st.nextRunMs  = Date.now() + delay;
  st.pollTimer  = setTimeout(() => { void poll(mode); }, delay);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function startAlpacaBot(cfg: AlpacaBotConfig): Promise<{ ok: boolean; error?: string }> {
  const mode = cfg.mode;
  stopAlpacaBot(mode);  // stop this mode only, leave the other intact

  try {
    const account = await getAccount(mode);
    if (account.trading_blocked) {
      return { ok: false, error: 'Account trading is blocked' };
    }
    addLog(mode, 'info', '—', `Alpaca ${mode} account connected — equity $${parseFloat(account.equity).toFixed(2)}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Alpaca auth failed: ${msg}` };
  }

  const st    = s(mode);
  st.config   = cfg;
  st.running  = true;
  st.paused   = false;

  // Always scan for best symbols before first poll
  addLog(mode, 'info', '—', 'Scanning market for best symbols…');
  try {
    const best = await scanForBestSymbols(
      cfg.strategy, mode, [], cfg.maxPositions + 2,
      msg => addLog(mode, 'info', '—', msg),
    );
    cfg.symbols = best;
  } catch (e) {
    addLog(mode, 'info', '—', `Symbol scan failed — using fallback: ${e instanceof Error ? e.message : String(e)}`);
    cfg.symbols = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA'];
  }

  if (cfg.strategy === 'orb') resetOrbState(mode, cfg.symbols);

  addLog(mode, 'info', '—', `Bot started — strategy: ${STRATEGY_META[cfg.strategy].label} | mode: ${mode} | symbols: ${cfg.symbols.join(', ')}`);
  addLog(mode, 'info', '—', `Position size: $${cfg.positionSizeUsd} | max positions: ${cfg.maxPositions} | shorts: ${cfg.allowShorts ? 'allowed' : 'disabled'}`);

  void poll(mode);
  return { ok: true };
}

export function stopAlpacaBot(mode: AccountMode): void {
  const st    = s(mode);
  st.running  = false;
  st.paused   = false;
  if (st.pollTimer) { clearTimeout(st.pollTimer); st.pollTimer = null; }
  st.nextRunMs  = null;
  st.lastPollTs = null;
  addLog(mode, 'info', '—', `Alpaca ${mode} bot stopped`);
}

export function pauseAlpacaBot(mode: AccountMode): void {
  const st = s(mode);
  if (!st.running) return;
  st.paused = true;
  addLog(mode, 'info', '—', '⏸ Alpaca bot paused — monitoring positions, no new entries');
}

export function resumeAlpacaBot(mode: AccountMode): void {
  const st = s(mode);
  if (!st.running) return;
  st.paused = false;
  addLog(mode, 'info', '—', '▶ Alpaca bot resumed');
}

export async function getAlpacaBotStatus(mode: AccountMode): Promise<AlpacaBotStatus> {
  const st = s(mode);
  let positions: AlpacaPosition[] = [];
  let equity = '0', cash = '0';

  if (st.running && st.config) {
    try {
      const [acct, pos] = await Promise.all([getAccount(mode), getPositions(mode)]);
      positions = pos;
      equity    = acct.equity;
      cash      = acct.cash;
    } catch {}
  }

  return {
    running:   st.running,
    paused:    st.paused,
    mode:      st.config?.mode     ?? mode,
    strategy:  st.config?.strategy ?? 'rsi_mean_reversion',
    symbols:   st.config?.symbols  ?? [],
    equity,
    cash,
    positions,
    log:       st.log.slice(0, 100),
    nextRunMs: st.nextRunMs,
    orbState:  { ...st.orbState },
    lastPollTs: st.lastPollTs,
  };
}

export async function emergencyStop(mode: AccountMode): Promise<{ ok: boolean; error?: string }> {
  stopAlpacaBot(mode);
  try {
    await cancelAllOrders(mode);
    addLog(mode, 'info', '—', 'Emergency stop: all orders cancelled');
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    addLog(mode, 'error', '—', `Emergency stop error: ${msg}`);
    return { ok: false, error: msg };
  }
}

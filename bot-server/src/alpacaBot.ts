import {
  getAccount, getPositions, getBars, getLatestBars, placeOrder, closePosition,
  cancelAllOrders, cancelOrdersForSymbol, isNYSEOpen, isInOpeningRange, isNearClose,
  sessionStartUtcMs,
  isDailyCheckTime, isWeeklyCheckTime, isWeekend, msUntilMondayOpen,
  selectOptionsContract,
  type AccountMode, type AlpacaPosition,
} from './alpacaApi';
import { scanForBestSymbols } from './alpacaScanner';
import { recordJournalEvent } from './tradeJournal';
import { hasImminentEarnings } from './earningsGuard';
import {
  rsiMeanReversionSignal, emaCrossoverSignal, orbSignal,
  vwapSignal, weeklyMomentumSignal, optionsDirectionalSignal,
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
  allow24h:         boolean;    // skip NYSE hours gate — trade Mon-Fri around the clock
  maxDailyLossPct?: number;     // circuit breaker: no new entries after equity drops this % from day start (default 3)
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
  lossLock:    boolean;   // daily-loss circuit breaker engaged
};

// tradedLong/tradedShort: one breakout entry per direction per day — without
// this the bot re-enters every poll while price sits beyond the range
type OrbState = { high: number; low: number; established: boolean; tradedLong?: boolean; tradedShort?: boolean };

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
  // Daily-loss circuit breaker
  dayKey:         string;   // UTC date the equity baseline belongs to
  dayStartEquity: number;
  lossLock:       boolean;  // true = no new entries until the next trading day
};

function makeModeState(): ModeState {
  return {
    running: false, paused: false, config: null,
    log: [], pollTimer: null, nextRunMs: null, lastPollTs: null,
    orbState: {},
    dayKey: '', dayStartEquity: 0, lossLock: false,
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
    const sessionStart = sessionStartUtcMs();
    for (const sym of symbols) {
      const bars    = barsMap[sym] ?? [];
      if (!bars.length) continue;
      // Only bars inside the 30-min opening window — slice(-30) could include
      // pre-market or the previous session's bars
      const windowBars = bars.filter(b => {
        const t = new Date(b.t).getTime();
        return t >= sessionStart && t < sessionStart + 30 * 60_000;
      });
      const orbBars = windowBars.length ? windowBars : bars.slice(-30);
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

// Returns true when a new position was opened.
async function evaluateSymbol(
  mode:      AccountMode,
  sym:       string,
  positions: AlpacaPosition[],
  cfg:       AlpacaBotConfig,
): Promise<boolean> {
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
    return false;
  }

  if (!bars.length) {
    addLog(mode, 'wait', sym, 'No bar data returned');
    return false;
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
        return false;
      }
      const latestBars = await getLatestBars([sym], mode).catch(() => ({} as Record<string, typeof bars[0]>));
      const price      = latestBars[sym]?.c ?? bars[bars.length - 1].c;
      signal = orbSignal(orb.high, orb.low, price, inPosition, side);
      // One breakout trade per direction per day
      if (signal.action === 'BUY'  && orb.tradedLong)  { addLog(mode, 'wait', sym, 'ORB long already traded today'); return false; }
      if (signal.action === 'SELL' && orb.tradedShort) { addLog(mode, 'wait', sym, 'ORB short already traded today'); return false; }
      const opened = await executeSignal(mode, sym, signal, openPos ?? null, cfg, price);
      if (opened && signal.action === 'BUY')  orb.tradedLong  = true;
      if (opened && signal.action === 'SELL') orb.tradedShort = true;
      return opened;
    }

    case 'vwap': {
      const latestBars = await getLatestBars([sym], mode).catch(() => ({} as Record<string, typeof bars[0]>));
      const price      = latestBars[sym]?.c ?? bars[bars.length - 1].c;
      // Anchor VWAP to today's session — a rolling-60-min VWAP is a different
      // (noisier) reference. Overnight/24-5 mode falls back to the rolling window.
      const sessionStart = sessionStartUtcMs();
      const sessionBars  = bars.filter(b => new Date(b.t).getTime() >= sessionStart);
      signal = vwapSignal(sessionBars.length >= 5 ? sessionBars : bars, price, inPosition, side);
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

    case 'options_directional': {
      // Check for an existing options position on this underlying (OCC symbols start with underlying ticker)
      const occRegex = new RegExp(`^${sym}\\d{6}[CP]`);
      const optPos   = positions.find(p => occRegex.test(p.symbol));

      if (optPos) {
        // We hold an options contract — evaluate exit conditions
        const plPct  = parseFloat(optPos.unrealized_plpc) * 100;
        const yymmdd = optPos.symbol.slice(sym.length, sym.length + 6);
        const expiry = new Date(`20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`);
        const dte    = Math.ceil((expiry.getTime() - Date.now()) / 86_400_000);
        const exitSig = optionsDirectionalSignal(bars, true, plPct, dte);
        if (exitSig.action !== 'HOLD') {
          await executeSignal(mode, optPos.symbol, exitSig, optPos, cfg);
        } else {
          addLog(mode, 'wait', sym, exitSig.reason);
        }
        return false;
      }

      // No position — check entry
      const entrySig = optionsDirectionalSignal(bars, false);
      if (entrySig.action === 'BUY') {
        const currentPrice = bars[bars.length - 1].c;
        const optType      = entrySig.optionType ?? 'call';
        const contract     = await selectOptionsContract(sym, optType, currentPrice, mode);
        if (!contract) {
          addLog(mode, 'wait', sym, `No tradable ATM ${optType} contract found`);
          return false;
        }
        const contractPrice = parseFloat(contract.close_price ?? '2');
        const qty = Math.max(1, Math.floor(cfg.positionSizeUsd / (contractPrice * 100)));
        entrySig.optionContract = contract.symbol;
        entrySig.optionQty      = qty;
        return executeSignal(mode, sym, entrySig, null, cfg);
      }
      addLog(mode, 'wait', sym, entrySig.reason);
      return false;
    }

    default:
      return false;
  }

  return executeSignal(mode, sym, signal, openPos ?? null, cfg, bars[bars.length - 1].c);
}

// ── Order execution ───────────────────────────────────────────────────────────

// Returns true when a NEW position was opened (used to enforce maxPositions).
async function executeSignal(
  mode:         AccountMode,
  sym:          string,
  signal:       StrategySignal,
  openPos:      AlpacaPosition | null,
  cfg:          AlpacaBotConfig,
  currentPrice?: number,
): Promise<boolean> {
  const { action, reason, stopPrice, takeProfitPrice, trailPercent, orderType } = signal;
  const st = s(mode);

  if (action === 'HOLD') {
    addLog(mode, 'wait', sym, reason);
    return false;
  }

  if (action === 'CLOSE_LONG' || action === 'CLOSE_SHORT') {
    if (!openPos) return false;
    addLog(mode, 'exit', sym, `Closing position — ${reason}`);
    try {
      // Cancel bracket legs / stops first — Alpaca rejects a close while
      // shares are held for open orders, and orphaned GTC stops would later
      // fill into an unwanted reverse position.
      const cancelled = await cancelOrdersForSymbol(mode, sym).catch(() => 0);
      if (cancelled) addLog(mode, 'info', sym, `Cancelled ${cancelled} open order(s) before close`);
      await closePosition(mode, sym);
      addLog(mode, 'exit', sym, 'Position closed');

      recordJournalEvent({
        mode, event: 'exit', symbol: sym, strategy: cfg.strategy,
        side:  openPos.side,
        qty:   Math.abs(parseFloat(openPos.qty) || 0),
        price: parseFloat(openPos.current_price) || 0,
        reason,
        plUsd: parseFloat(openPos.unrealized_pl) || 0,
        plPct: (parseFloat(openPos.unrealized_plpc) || 0) * 100,
      });

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
    return false;
  }

  if (st.paused) {
    addLog(mode, 'wait', sym, `⏸ Paused — skipping ${action} signal`);
    return false;
  }

  if (st.lossLock) {
    addLog(mode, 'wait', sym, `🛑 Daily-loss limit hit — skipping ${action} signal (entries resume next day)`);
    return false;
  }

  if (action === 'SELL' && !cfg.allowShorts) {
    addLog(mode, 'wait', sym, 'Short selling disabled — skipping SELL signal');
    return false;
  }

  if (openPos) {
    addLog(mode, 'wait', sym, `Already in position (${openPos.side}) — skipping ${action}`);
    return false;
  }

  if (isNearClose()) {
    addLog(mode, 'wait', sym, '⏸ Market closing in <15 min — no new entries');
    return false;
  }

  // Skip entries within 2 days of an earnings report (no-op without FINNHUB_API_KEY)
  if (await hasImminentEarnings(sym)) {
    addLog(mode, 'wait', sym, '📊 Earnings within 2 days — skipping entry');
    return false;
  }

  const orderSide = action === 'BUY' ? 'buy' : 'sell';

  // ── Options entry — contract symbol with qty, no notional ────────────────
  if (signal.optionContract) {
    const qty         = signal.optionQty ?? 1;
    const optionType  = signal.optionType ?? 'call';
    addLog(mode, 'enter', sym, `${reason}`);
    addLog(mode, 'info',  sym, `Ordering ${qty}x ${signal.optionContract} (${optionType}) — $${cfg.positionSizeUsd} budget`);
    try {
      const order = await placeOrder(mode, {
        symbol:        signal.optionContract,
        qty,
        side:          'buy',
        type:          'market',
        time_in_force: 'day',
      });
      addLog(mode, 'enter', sym, `Options order placed — ${signal.optionContract} id ${order.id}`);
      recordJournalEvent({
        mode, event: 'entry', symbol: signal.optionContract, strategy: cfg.strategy,
        side: 'long', qty, price: currentPrice ?? 0, reason,
      });
      return true;
    } catch (e) {
      addLog(mode, 'error', sym, `Options order failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  // ── Stock entry — whole-share qty so bracket TP/SL legs are accepted ─────
  const price = currentPrice ?? 0;
  const qty   = price > 0 ? Math.floor(cfg.positionSizeUsd / price) : 0;
  if (qty < 1) {
    addLog(mode, 'wait', sym, `Position size $${cfg.positionSizeUsd} < 1 share at $${price.toFixed(2)} — skipping`);
    return false;
  }

  const round2 = (v: number) => Math.round(v * 100) / 100;
  // Sanity: bracket legs must be on the correct side of the market or Alpaca rejects them
  const validStop = stopPrice !== undefined &&
    (orderSide === 'buy' ? stopPrice < price : stopPrice > price);
  const validTp   = takeProfitPrice !== undefined &&
    (orderSide === 'buy' ? takeProfitPrice > price : takeProfitPrice < price);
  const useBracket = validStop && validTp && !trailPercent;

  addLog(mode, 'enter', sym, `${action} signal — ${reason}`);
  if (stopPrice)       addLog(mode, 'info', sym, `Stop: ${round2(stopPrice).toFixed(2)}`);
  if (takeProfitPrice) addLog(mode, 'info', sym, `TP:   ${round2(takeProfitPrice).toFixed(2)}`);

  try {
    const order = await placeOrder(mode, {
      symbol:        sym,
      qty,
      side:          orderSide,
      type:          'market',
      time_in_force: useBracket ? 'gtc' : 'day',
      ...(useBracket ? {
        order_class: 'bracket' as const,
        take_profit: { limit_price: round2(takeProfitPrice!) },
        stop_loss:   { stop_price:  round2(stopPrice!) },
      } : {}),
    });

    addLog(mode, 'enter', sym, `Order placed — ${qty} shares, id ${order.id} status ${order.status}${useBracket ? ' (bracket TP+SL attached)' : ''}`);

    recordJournalEvent({
      mode, event: 'entry', symbol: sym, strategy: cfg.strategy,
      side: orderSide === 'buy' ? 'long' : 'short',
      qty, price, reason,
    });

    // Trailing-stop exit (weekly momentum): attach after the market entry
    if (trailPercent && orderType !== 'trailing_stop') {
      try {
        await placeOrder(mode, {
          symbol:        sym,
          qty,
          side:          orderSide === 'buy' ? 'sell' : 'buy',
          type:          'trailing_stop',
          time_in_force: 'gtc',
          trail_percent: trailPercent,
        });
        addLog(mode, 'info', sym, `Trailing stop attached — ${trailPercent}%`);
      } catch (e) {
        addLog(mode, 'error', sym, `Trailing stop failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return true;
  } catch (e) {
    addLog(mode, 'error', sym, `Order failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
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

  if (meta.timeframe === 'intraday' && !isNYSEOpen() && !cfg.allow24h) {
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

    // ── Daily-loss circuit breaker ──────────────────────────────────────────
    const equity = parseFloat(account.equity);
    const today  = new Date().toISOString().slice(0, 10);
    if (st.dayKey !== today) {
      st.dayKey = today;
      st.dayStartEquity = equity;
      if (st.lossLock) addLog(mode, 'info', '—', 'New trading day — daily-loss lock reset');
      st.lossLock = false;
    }
    const maxLossPct = cfg.maxDailyLossPct ?? 3;
    if (!st.lossLock && st.dayStartEquity > 0 && equity > 0) {
      const ddPct = (st.dayStartEquity - equity) / st.dayStartEquity * 100;
      if (ddPct >= maxLossPct) {
        st.lossLock = true;
        addLog(mode, 'error', '—',
          `🛑 Daily loss ${ddPct.toFixed(2)}% ≥ ${maxLossPct}% limit — no new entries today (exits still managed)`);
      }
    }
  } catch (e) {
    addLog(mode, 'error', '—', `Account fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    schedule(mode, cfg);
    return;
  }

  let openCount = positions.length;

  for (const sym of cfg.symbols) {
    if (!st.running) break;
    const inPos = positions.find(p => p.symbol === sym);
    if (!inPos && openCount >= cfg.maxPositions) {
      addLog(mode, 'wait', sym, `Max positions (${cfg.maxPositions}) reached — skipping`);
      continue;
    }
    const opened = await evaluateSymbol(mode, sym, positions, cfg);
    if (opened) openCount++;
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
  addLog(mode, 'info', '—', `Position size: $${cfg.positionSizeUsd} | max positions: ${cfg.maxPositions} | shorts: ${cfg.allowShorts ? 'allowed' : 'disabled'} | 24/5: ${cfg.allow24h ? 'on' : 'off'}`);

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
    lossLock:  st.lossLock,
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

import {
  authenticate, openPosition, closePosition,
  getSession,
} from './igApi';

export type StrategyMarket = {
  epic:        string;
  name:        string;
  yahooSymbol: string;
  marketType:  'INDEX' | 'FOREX' | 'COMMODITY' | 'CRYPTO' | 'SHARES';
};

export type StrategyRunnerConfig = {
  markets:        StrategyMarket[];
  minStrength:    number;   // 0-100
  betSize:        number;   // £/pt per trade
  scanIntervalMs: number;   // default 5 min
};

type RunnerLog = { id: string; ts: string; type: string; msg: string };
type OpenTrade = { dealId: string; epic: string; direction: 'BUY' | 'SELL' };

let running     = false;
let config:     StrategyRunnerConfig | null = null;
let scanTimer:  ReturnType<typeof setInterval> | null = null;
const openTrades = new Map<string, OpenTrade>();  // keyed by epic
const runLog:   RunnerLog[] = [];

function uid() { return Math.random().toString(36).slice(2, 9); }

function addLog(type: string, msg: string) {
  const entry: RunnerLog = {
    id:   uid(),
    ts:   new Date().toLocaleTimeString('en-GB', { hour12: false }),
    type, msg,
  };
  runLog.unshift(entry);
  if (runLog.length > 200) runLog.splice(200);
  console.log(`[strategyRunner] [${type.toUpperCase()}] ${msg}`);
}

function calibrateSignal(
  changePercent: number,
  mType: StrategyMarket['marketType'],
): { direction: 'BUY' | 'SELL' | 'HOLD'; strength: number } {
  const pct = Math.abs(changePercent);
  const dir: 'BUY' | 'SELL' | 'HOLD' =
    changePercent > 0.3 ? 'BUY' : changePercent < -0.3 ? 'SELL' : 'HOLD';

  let strength: number;
  switch (mType) {
    case 'INDEX':
      strength = pct >= 1.0 ? 85 : pct >= 0.5 ? 75 : pct >= 0.3 ? 65 : Math.round((pct / 0.3) * 60);
      break;
    case 'FOREX':
      strength = pct >= 0.3 ? 85 : pct >= 0.2 ? 75 : pct >= 0.1 ? 65 : Math.round((pct / 0.1) * 60);
      break;
    case 'COMMODITY':
      strength = pct >= 2.0 ? 85 : pct >= 1.0 ? 75 : pct >= 0.5 ? 65 : Math.round((pct / 0.5) * 60);
      break;
    case 'CRYPTO':
      strength = pct >= 3.0 ? 85 : pct >= 2.0 ? 75 : pct >= 1.0 ? 65 : Math.round((pct / 1.0) * 60);
      break;
    default:
      strength = pct >= 2.0 ? 85 : pct >= 1.0 ? 75 : pct >= 0.5 ? 65 : Math.round((pct / 0.5) * 60);
      break;
  }
  return { direction: dir, strength: Math.min(99, Math.max(0, strength)) };
}

async function fetchPrice(market: StrategyMarket): Promise<{ price: number; changePercent: number } | null> {
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(market.yahooSymbol)}`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTrade/1.0)', 'Accept': 'application/json' },
        signal:  AbortSignal.timeout(8_000),
      }
    );
    if (!r.ok) return null;
    const data = await r.json() as {
      quoteResponse?: { result?: Array<{ regularMarketPrice?: number; regularMarketChangePercent?: number }> };
    };
    const q = data.quoteResponse?.result?.[0];
    if (!q) return null;
    return {
      price:         q.regularMarketPrice         ?? 0,
      changePercent: q.regularMarketChangePercent ?? 0,
    };
  } catch {
    return null;
  }
}

function calcStopAndLimit(price: number, mType: StrategyMarket['marketType']): { stopDist: number; limitDist: number } {
  const pct = mType === 'FOREX' ? 0.002 : mType === 'INDEX' ? 0.005 : 0.01;
  const stopDist  = Math.max(0.0001, price * pct);
  const limitDist = stopDist * 1.5;
  return { stopDist, limitDist };
}

async function runScan() {
  if (!config || !running) return;

  let session = getSession();
  if (!session) {
    // Try to authenticate using env vars
    const apiKey   = process.env.IG_API_KEY   ?? '';
    const username = process.env.IG_USERNAME  ?? '';
    const password = process.env.IG_PASSWORD  ?? '';
    const env      = (process.env.IG_ENV ?? 'demo') as 'demo' | 'live';
    if (!apiKey || !username || !password) {
      addLog('error', 'No IG session and env vars not set — cannot scan');
      return;
    }
    try {
      session = await authenticate(apiKey, username, password, env);
      addLog('info', 'Authenticated to IG for strategy runner');
    } catch (e) {
      addLog('error', `Auth failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  }

  addLog('info', `Scanning ${config.markets.length} market(s)...`);

  for (const market of config.markets) {
    if (!running) break;

    const snap = await fetchPrice(market);
    if (!snap) {
      addLog('error', `${market.name}: price fetch failed`);
      continue;
    }

    const { direction, strength } = calibrateSignal(snap.changePercent, market.marketType);
    const pctStr = `${snap.changePercent >= 0 ? '+' : ''}${snap.changePercent.toFixed(2)}%`;

    if (direction === 'HOLD' || strength < config.minStrength) {
      addLog('info', `${market.name}: ${pctStr} — ${direction} ${strength}% (below ${config.minStrength}%)`);
      continue;
    }

    const existing = openTrades.get(market.epic);

    // Close opposing position if signal reversed
    if (existing && existing.direction !== direction) {
      addLog('info', `${market.name}: signal reversed → ${direction}, closing ${existing.direction}`);
      try {
        await closePosition(session, existing.dealId, existing.direction, config.betSize);
        openTrades.delete(market.epic);
        addLog('info', `${market.name}: closed ${existing.direction} deal ${existing.dealId}`);
      } catch (e) {
        addLog('error', `${market.name}: close failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Skip if already in same direction
    if (existing && existing.direction === direction) {
      addLog('info', `${market.name}: already ${direction} — holding`);
      continue;
    }

    // Open new position
    const { stopDist, limitDist } = calcStopAndLimit(snap.price, market.marketType);
    const stopLevel  = direction === 'BUY' ? snap.price - stopDist : snap.price + stopDist;
    const limitLevel = direction === 'BUY' ? snap.price + limitDist : snap.price - limitDist;

    try {
      addLog('info', `${market.name}: → ${direction} @ ${snap.price.toFixed(2)} (${pctStr} ${strength}%) stop±${stopDist.toFixed(4)} tp±${limitDist.toFixed(4)}`);
      const { dealId, level } = await openPosition(session, market.epic, config.betSize, direction, stopLevel, limitLevel);
      openTrades.set(market.epic, { dealId, epic: market.epic, direction });
      addLog('info', `${market.name}: ✓ ${direction} deal ${dealId} @ ${level}`);
    } catch (e) {
      addLog('error', `${market.name}: open failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export function startStrategyRunner(cfg: StrategyRunnerConfig): { ok: boolean; error?: string } {
  stopStrategyRunner();

  config  = cfg;
  running = true;
  openTrades.clear();
  runLog.length = 0;

  addLog('info', `Started — ${cfg.markets.length} market(s), min ${cfg.minStrength}% strength, £${cfg.betSize}/pt, scan every ${cfg.scanIntervalMs / 60_000}min`);

  void runScan();
  scanTimer = setInterval(() => { void runScan(); }, cfg.scanIntervalMs);

  return { ok: true };
}

export function stopStrategyRunner() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (running) addLog('info', 'Stopped');
  running = false;
  config  = null;
}

export function getStrategyRunnerStatus() {
  return {
    running,
    config,
    log:        runLog.slice(0, 100),
    openTrades: [...openTrades.values()],
  };
}

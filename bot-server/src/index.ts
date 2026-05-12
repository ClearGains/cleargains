import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { startBot, stopBot, getBotStatus, loadSavedState, pauseBot, resumeBot } from './bot';
import { startStrategyRunner, stopStrategyRunner, getStrategyRunnerStatus, type StrategyRunnerConfig } from './strategyRunner';
import { demoBot, liveBot, getAccountBot, type AccountKey } from './botAccount';
import { getStockBot, type StockBotStartParams } from './stockBot';
import { calcRsi, calcMacdHist, calcAtr } from './scalperStrategy';

const app    = express();
const PORT   = parseInt(process.env.PORT ?? '3001', 10);
const SECRET = process.env.BOT_SECRET ?? '';

if (!SECRET) {
  console.warn('[bot-server] WARNING: BOT_SECRET not set — all requests will be rejected. Set it in your .env file.');
}

app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────────────────────
function auth(req: Request, res: Response, next: NextFunction) {
  if (!SECRET || req.headers['x-bot-secret'] !== SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// ── Public health check ───────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok:   true,
    ts:   new Date().toISOString(),
    demo: demoBot.status().running,
    live: liveBot.status().running,
  });
});

// ── Multi-account routes (/accounts/:account/*) ───────────────────────────────

// GET /accounts — status of both accounts
app.get('/accounts', auth, (_req: Request, res: Response) => {
  res.json({
    demo: demoBot.status(),
    live: liveBot.status(),
  });
});

function resolveBot(req: Request, res: Response): ReturnType<typeof getAccountBot> | null {
  const key = req.params.account as AccountKey;
  if (key !== 'demo' && key !== 'live') {
    res.status(400).json({ ok: false, error: 'account must be "demo" or "live"' });
    return null;
  }
  return getAccountBot(key);
}

// GET /accounts/:account/status
app.get('/accounts/:account/status', auth, (req: Request, res: Response) => {
  const bot = resolveBot(req, res);
  if (!bot) return;
  res.json(bot.status());
});

// POST /accounts/:account/start
app.post('/accounts/:account/start', auth, (req: Request, res: Response) => {
  const bot = resolveBot(req, res);
  if (!bot) return;

  const { epics, config } = req.body as { epics?: string[]; config?: Record<string, number> };
  if (!Array.isArray(epics) || !epics.length) {
    res.status(400).json({ ok: false, error: 'epics array is required' });
    return;
  }

  void bot.start({ epics, config }).then(result => res.status(result.ok ? 200 : 500).json(result));
});

// POST /accounts/:account/stop
app.post('/accounts/:account/stop', auth, (req: Request, res: Response) => {
  const bot = resolveBot(req, res);
  if (!bot) return;
  bot.stop();
  res.json({ ok: true });
});

// POST /accounts/:account/pause
app.post('/accounts/:account/pause', auth, (req: Request, res: Response) => {
  const bot = resolveBot(req, res);
  if (!bot) return;
  bot.pause();
  res.json({ ok: true });
});

// POST /accounts/:account/resume
app.post('/accounts/:account/resume', auth, (req: Request, res: Response) => {
  const bot = resolveBot(req, res);
  if (!bot) return;
  bot.resume();
  res.json({ ok: true });
});

// /accounts/:account/inject removed — bot no longer executes trades

// GET /prices — real-time bid + session change + technical indicators for all tracked epics
app.get('/prices', auth, (_req: Request, res: Response) => {
  type PriceEntry = {
    bid: number; mid: number; changePercent: number; candleCount: number;
    rsi: number | null; macd: number | null; atr: number | null;
    signal: 'BUY' | 'SELL' | 'NEUTRAL'; signalState: string;
    consecutiveReds: number; consecutiveGreens: number;
    trend5m: 'UP' | 'DOWN' | 'NEUTRAL';
  };
  const prices: Record<string, PriceEntry> = {};

  for (const bot of [demoBot, liveBot]) {
    const st         = bot.status();
    const allCandles = bot.candles();
    for (const [epic, candles] of Object.entries(allCandles)) {
      if (prices[epic]) continue; // demo takes priority
      const bid = st.epicStatuses[epic]?.lastPrice
               ?? (candles.length ? candles[candles.length - 1].bidClose : 0);
      if (!bid && !candles.length) continue;

      let changePercent = 0;
      if (candles.length >= 2) {
        const firstOpen = candles[0].open;
        const lastClose = candles[candles.length - 1].close;
        if (firstOpen > 0) changePercent = (lastClose - firstOpen) / firstOpen * 100;
      }

      const rsi  = candles.length >= 14 ? calcRsi(candles)      : null;
      const macd = candles.length >= 26 ? calcMacdHist(candles) : null;
      const atr  = candles.length >= 14 ? calcAtr(candles)      : null;

      // Count consecutive same-direction closed candles (momentum streaks)
      let consRed = 0, consGreen = 0;
      for (let i = candles.length - 1; i >= 0; i--) {
        const c = candles[i];
        if (c.close < c.open) {        // red candle
          if (consGreen > 0) break;
          consRed++;
        } else {                       // green candle
          if (consRed > 0) break;
          consGreen++;
        }
        if (consRed + consGreen >= 6) break;
      }

      // Momentum signal — 5-minute candles, so requirements are stricter than before.
      // Strong signal: 3+ same-direction candles + RSI in the right zone + MACD confirming.
      // Moderate signal: 2+ candles + MACD confirming + RSI not extreme.
      // No signal on a single candle — that's noise even at 5-min resolution.
      let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
      const rsiBuyZone  = rsi === null || (rsi >= 38 && rsi < 65);   // recovering, not extended
      const rsiSellZone = rsi === null || (rsi > 35 && rsi <= 62);   // rolling over, not oversold
      if (consGreen >= 3 && rsiBuyZone  && (macd === null || macd > 0)) {
        signal = 'BUY';
      } else if (consRed >= 3 && rsiSellZone && (macd === null || macd < 0)) {
        signal = 'SELL';
      } else if (consGreen >= 2 && macd !== null && macd > 0 && rsiBuyZone) {
        signal = 'BUY';
      } else if (consRed >= 2 && macd !== null && macd < 0 && rsiSellZone) {
        signal = 'SELL';
      }

      // 25-minute trend: compare avg close of last 5 candles vs previous 5
      // (5 × 5-min = 25min each window, so comparing the last 25min vs prior 25min)
      let trend5m: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
      if (candles.length >= 10) {
        const last5 = candles.slice(-5).reduce((s, c) => s + c.close, 0) / 5;
        const prev5 = candles.slice(-10, -5).reduce((s, c) => s + c.close, 0) / 5;
        if (last5 > prev5 * 1.0003) trend5m = 'UP';       // tighter threshold for 5-min candles
        else if (last5 < prev5 * 0.9997) trend5m = 'DOWN';
      }

      prices[epic] = {
        bid, mid: bid, changePercent, candleCount: candles.length,
        rsi, macd, atr, signal,
        signalState: st.epicStatuses[epic]?.state ?? 'FLAT',
        consecutiveReds: consRed, consecutiveGreens: consGreen,
        trend5m,
      };
    }
  }

  res.json({ ok: true, prices, ts: new Date().toISOString() });
});

// ── Legacy single-account routes (backward compat — delegate to demo bot) ─────

app.get('/status', auth, (_req: Request, res: Response) => {
  res.json(getBotStatus());
});

app.post('/start', auth, (req: Request, res: Response) => {
  const { epics, config } = req.body as { epics: string[]; config?: Record<string, number> };
  if (!Array.isArray(epics) || !epics.length) {
    res.status(400).json({ ok: false, error: 'epics array is required' });
    return;
  }
  void startBot({ epics, config }).then(result => res.json(result));
});

app.post('/stop', auth, (_req: Request, res: Response) => { stopBot(); res.json({ ok: true }); });
app.post('/pause', auth, (_req: Request, res: Response) => { pauseBot(); res.json({ ok: true }); });
app.post('/resume', auth, (_req: Request, res: Response) => { resumeBot(); res.json({ ok: true }); });

// /debug/inject removed — bot no longer executes trades

// ── Stock bot routes (/accounts/:account/stock/*) ────────────────────────────

app.get('/accounts/:account/stock/status', auth, (req: Request, res: Response) => {
  const key = req.params.account as AccountKey;
  if (key !== 'demo' && key !== 'live') { res.status(400).json({ ok: false, error: 'account must be demo or live' }); return; }
  res.json(getStockBot(key).status());
});

app.post('/accounts/:account/stock/start', auth, (req: Request, res: Response) => {
  const key = req.params.account as AccountKey;
  if (key !== 'demo' && key !== 'live') { res.status(400).json({ ok: false, error: 'account must be demo or live' }); return; }
  const params = req.body as StockBotStartParams;
  if (!Array.isArray(params.tickers) || !params.tickers.length) {
    res.status(400).json({ ok: false, error: 'tickers array is required' }); return;
  }
  void getStockBot(key).start(params).then(r => res.status(r.ok ? 200 : 500).json(r));
});

app.post('/accounts/:account/stock/stop', auth, (req: Request, res: Response) => {
  const key = req.params.account as AccountKey;
  if (key !== 'demo' && key !== 'live') { res.status(400).json({ ok: false, error: 'account must be demo or live' }); return; }
  getStockBot(key).stop();
  res.json({ ok: true });
});

app.post('/accounts/:account/stock/pause', auth, (req: Request, res: Response) => {
  const key = req.params.account as AccountKey;
  if (key !== 'demo' && key !== 'live') { res.status(400).json({ ok: false, error: 'account must be demo or live' }); return; }
  getStockBot(key).pause();
  res.json({ ok: true });
});

app.post('/accounts/:account/stock/resume', auth, (req: Request, res: Response) => {
  const key = req.params.account as AccountKey;
  if (key !== 'demo' && key !== 'live') { res.status(400).json({ ok: false, error: 'account must be demo or live' }); return; }
  getStockBot(key).resume();
  res.json({ ok: true });
});

// ── Strategy runner routes ────────────────────────────────────────────────────
app.post('/strategy/start', auth, (req: Request, res: Response) => {
  const cfg = req.body as StrategyRunnerConfig;
  if (!cfg.markets?.length) {
    res.status(400).json({ ok: false, error: 'markets array is required' });
    return;
  }
  const result = startStrategyRunner(cfg);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/strategy/stop', auth, (_req: Request, res: Response) => { stopStrategyRunner(); res.json({ ok: true }); });
app.get('/strategy/status', auth, (_req: Request, res: Response) => { res.json(getStrategyRunnerStatus()); });

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[bot-server] Listening on 0.0.0.0:${PORT}`);
  console.log(`[bot-server] Multi-account mode: demo + live`);

  // Auto-resume legacy single-account bot if it was running before restart
  const saved = loadSavedState();
  if (saved) {
    console.log(`[bot-server] Auto-resuming legacy bot with ${saved.epics.length} epic(s)...`);
    void startBot(saved).then(r => {
      if (r.ok) console.log('[bot-server] Auto-resume successful');
      else console.error(`[bot-server] Auto-resume failed: ${r.error}`);
    });
  }
});

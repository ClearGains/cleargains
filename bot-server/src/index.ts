import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { startBot, stopBot, getBotStatus, loadSavedState, pauseBot, resumeBot } from './bot';
import { startStrategyRunner, stopStrategyRunner, getStrategyRunnerStatus, type StrategyRunnerConfig } from './strategyRunner';
import { demoBot, liveBot, getAccountBot, type AccountKey } from './botAccount';
import { getStockBot, type StockBotStartParams } from './stockBot';
import { calcRsi, calcMacdHist, calcAtr } from './scalperStrategy';
import {
  startAlpacaBot, stopAlpacaBot, pauseAlpacaBot, resumeAlpacaBot,
  getAlpacaBotStatus, emergencyStop, loadSavedAlpacaState, setPositionWatchEnabled,
  type AlpacaBotConfig,
} from './alpacaBot';
import {
  startIgStrategyBot, stopIgStrategyBot, pauseIgStrategyBot, resumeIgStrategyBot,
  getIgStrategyBotStatus, loadSavedIgStrategyState, startRecommendationRefresh,
  refreshRecommendations, refreshDailyPick, openRecommendation,
  getPausedEpics, pauseEpic, resumeEpic,
  releaseDeal, holdDeal, updateMaxDailyLossPct, updateDailyProfitTargetGbp,
  setStrategyAiPaused,
  type IgMode, type IgStrategyConfig,
} from './igStrategyBot';
import { IG_EPICS, RULE_BASED_ANALYSIS_CONFIRMED_EPICS, FX_EPICS } from './igStrategyScanner';
import { getJournal } from './tradeJournal';
import { computeTradeAttribution } from './tradeAttribution';
import { startLeaderboardSchedule, getLeaderboardState, runLeaderboardSweep } from './leaderboard';
import { startGeminiWatch, getWatchedDealIds, getWatchNotes, addToWatch, setWatchNote, removeFromWatch, isWatchAiPaused, setWatchAiPaused, getNoAiCloseDealIds, markNoAiClose, unmarkNoAiClose } from './geminiWatch';
import { fetchFullPositions, getSession } from './igApi';
import { getFxScalperBot, loadSavedFxScalperState, type FxScalperStartParams } from './fxScalperBot';
import { getIgCfdBot, loadSavedCfdState, type CfdStartParams } from './igCfdBot';
import { startAlpacaNewsStream, isNewsStreamEnabled, setNewsStreamEnabled } from './alpacaNewsStream';
import { startT212Bot, stopT212Bot, getT212BotStatus, wasT212BotRunning, setT212AiPaused, setT212PositionAiPaused, isMomentumAiGateEnabled, setMomentumAiGateEnabled, setT212BudgetChecked, setMomentumBudgetChecked } from './t212Bot';
import { startMeanReversionBot, stopMeanReversionBot, getMeanReversionBotStatus, wasMeanReversionBotRunning, type MrInstance } from './meanReversionBot';
import { startIgOptionsBot, stopIgOptionsBot, getIgOptionsBotStatus, wasIgOptionsBotRunning, executeOverride, dismissOverride, closePositionManually } from './igOptionsBot';
import { getPerformanceSummary } from './performance';
import type { T212Mode } from './t212Api';
import { scanCfdIdeas } from './cfdIdeas';

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
  // Respond immediately — IG auth takes 3–8s and would exceed Vercel's proxy timeout
  res.json({ ok: true });
  void getStockBot(key).start(params).catch((e: unknown) => console.error('[stock-start]', e));
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

// ── Alpaca bot routes (/alpaca/*) ─────────────────────────────────────────────

function resolveAlpacaMode(req: Request, res: Response): 'paper' | 'live' | null {
  const mode = (req.params.mode ?? req.query.mode) as string;
  if (mode !== 'paper' && mode !== 'live') {
    res.status(400).json({ ok: false, error: 'mode must be "paper" or "live"' });
    return null;
  }
  return mode;
}

// GET /alpaca/:mode/status
app.get('/alpaca/:mode/status', auth, (req: Request, res: Response) => {
  const mode = resolveAlpacaMode(req, res);
  if (!mode) return;
  void getAlpacaBotStatus(mode).then(status => res.json(status));
});

// Per-position AI watch on/off — mirrors the IG bot's own Watch button.
app.post('/alpaca/:mode/watch/:symbol', auth, (req: Request, res: Response) => {
  const mode = resolveAlpacaMode(req, res);
  if (!mode) return;
  res.json(setPositionWatchEnabled(mode, decodeURIComponent(req.params.symbol), true));
});
app.delete('/alpaca/:mode/watch/:symbol', auth, (req: Request, res: Response) => {
  const mode = resolveAlpacaMode(req, res);
  if (!mode) return;
  res.json(setPositionWatchEnabled(mode, decodeURIComponent(req.params.symbol), false));
});

// ── T212 Stocks ISA bot ──────────────────────────────────────────────────
function resolveT212Mode(req: Request, res: Response): T212Mode | null {
  const mode = (req.params.mode ?? req.query.mode) as string;
  if (mode !== 'live' && mode !== 'demo') {
    res.status(400).json({ ok: false, error: 'mode must be "live" or "demo"' });
    return null;
  }
  return mode;
}
app.post('/t212/:mode/start', auth, (req: Request, res: Response) => {
  const mode = resolveT212Mode(req, res);
  if (!mode) return;
  void startT212Bot(mode).then(r => res.json(r));
});
app.post('/t212/:mode/stop', auth, (req: Request, res: Response) => {
  const mode = resolveT212Mode(req, res);
  if (!mode) return;
  res.json(stopT212Bot(mode));
});
app.get('/t212/:mode/status', auth, (req: Request, res: Response) => {
  const mode = resolveT212Mode(req, res);
  if (!mode) return;
  void getT212BotStatus(mode).then(status => res.json(status));
});
app.post('/t212/:mode/ai-pause', auth, (req: Request, res: Response) => {
  const mode = resolveT212Mode(req, res);
  if (!mode) return;
  setT212AiPaused(mode, !!req.body?.paused);
  res.json({ ok: true });
});
app.post('/t212/:mode/positions/:ticker/ai-pause', auth, (req: Request, res: Response) => {
  const mode = resolveT212Mode(req, res);
  if (!mode) return;
  res.json(setT212PositionAiPaused(mode, req.params.ticker, !!req.body?.paused));
});
// Momentum-strategy-only fallback — see isMomentumAiGateEnabled's own
// comment in t212Bot.ts. Independent of the ai-pause routes above (those
// stop entries on both strategies entirely; this one keeps momentum
// entries running, just without the AI confirm step).
app.get('/t212/:mode/momentum/ai-gate', auth, (req: Request, res: Response) => {
  const mode = resolveT212Mode(req, res);
  if (!mode) return;
  res.json({ enabled: isMomentumAiGateEnabled(mode) });
});
app.post('/t212/:mode/momentum/ai-gate', auth, (req: Request, res: Response) => {
  const mode = resolveT212Mode(req, res);
  if (!mode) return;
  setMomentumAiGateEnabled(mode, !!req.body?.enabled);
  res.json({ ok: true });
});
// Runtime-adjustable total budgets — per explicit request to let more
// positions have funds without a redeploy. Validated server-side against
// the account's own live balance at the time of the request (see
// setT212BudgetChecked's own comment) — the client only needs to pass the
// desired £ figure.
app.post('/t212/:mode/budget', auth, (req: Request, res: Response) => {
  const mode = resolveT212Mode(req, res);
  if (!mode) return;
  void setT212BudgetChecked(mode, Number(req.body?.gbp)).then(r => res.status(r.ok ? 200 : 400).json(r));
});
app.post('/t212/:mode/momentum/budget', auth, (req: Request, res: Response) => {
  const mode = resolveT212Mode(req, res);
  if (!mode) return;
  void setMomentumBudgetChecked(mode, Number(req.body?.gbp)).then(r => res.status(r.ok ? 200 : 400).json(r));
});

// ── Mean-reversion bot (RSI(2)+EMA200) — three independent instances ───────
function resolveMrInstance(req: Request, res: Response): MrInstance | null {
  const instance = req.params.instance;
  if (instance !== 'fx' && instance !== 'stocks' && instance !== 'japan225') {
    res.status(400).json({ ok: false, error: 'instance must be "fx", "stocks", or "japan225"' });
    return null;
  }
  return instance;
}
app.post('/mean-reversion/:instance/:mode/start', auth, (req: Request, res: Response) => {
  const instance = resolveMrInstance(req, res); if (!instance) return;
  const mode = resolveIgMode(req, res); if (!mode) return;
  res.json(startMeanReversionBot(instance, mode));
});
app.post('/mean-reversion/:instance/:mode/stop', auth, (req: Request, res: Response) => {
  const instance = resolveMrInstance(req, res); if (!instance) return;
  const mode = resolveIgMode(req, res); if (!mode) return;
  res.json(stopMeanReversionBot(instance, mode));
});
app.get('/mean-reversion/:instance/:mode/status', auth, (req: Request, res: Response) => {
  const instance = resolveMrInstance(req, res); if (!instance) return;
  const mode = resolveIgMode(req, res); if (!mode) return;
  void getMeanReversionBotStatus(instance, mode).then(status => res.json(status));
});

// ── Cross-bot performance summary (all journals rolled up) ──────────────────
app.get('/performance', auth, (_req: Request, res: Response) => {
  res.json(getPerformanceSummary());
});

// ── IG index-options bot (trend-following monthly options) ─────────────────
app.post('/ig-options/:mode/start', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res); if (!mode) return;
  res.json(startIgOptionsBot(mode));
});
app.post('/ig-options/:mode/stop', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res); if (!mode) return;
  res.json(stopIgOptionsBot(mode));
});
app.get('/ig-options/:mode/status', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res); if (!mode) return;
  void getIgOptionsBotStatus(mode).then(status => res.json(status));
});
app.post('/ig-options/:mode/overrides/:id/approve', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res); if (!mode) return;
  void executeOverride(mode, req.params.id).then(r => res.json(r));
});
app.delete('/ig-options/:mode/overrides/:id', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res); if (!mode) return;
  dismissOverride(mode, req.params.id);
  res.json({ ok: true });
});
app.post('/ig-options/:mode/positions/:dealId/close', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res); if (!mode) return;
  void closePositionManually(mode, req.params.dealId).then(r => res.json(r));
});

// POST /alpaca/:mode/start
app.post('/alpaca/:mode/start', auth, (req: Request, res: Response) => {
  const mode = resolveAlpacaMode(req, res);
  if (!mode) return;

  const body = req.body as Partial<AlpacaBotConfig>;

  const cfg: AlpacaBotConfig = {
    mode,
    strategy:        body.strategy        ?? 'rsi_mean_reversion',
    symbols:         [],   // always filled by scanner at start
    positionSizeUsd: body.positionSizeUsd ?? 500,
    maxPositions:    body.maxPositions    ?? 3,
    allowShorts:     body.allowShorts     ?? false,
    allow24h:        body.allow24h        ?? false,
  };

  res.json({ ok: true, message: 'Bot starting…' });
  void startAlpacaBot(cfg).then(result => {
    if (!result.ok) console.error(`[alpaca] Start failed: ${result.error}`);
  });
});

// POST /alpaca/:mode/stop
app.post('/alpaca/:mode/stop', auth, (req: Request, res: Response) => {
  const mode = resolveAlpacaMode(req, res);
  if (!mode) return;
  stopAlpacaBot(mode);
  res.json({ ok: true });
});

// POST /alpaca/:mode/pause
app.post('/alpaca/:mode/pause', auth, (req: Request, res: Response) => {
  const mode = resolveAlpacaMode(req, res);
  if (!mode) return;
  pauseAlpacaBot(mode);
  res.json({ ok: true });
});

// POST /alpaca/:mode/resume
app.post('/alpaca/:mode/resume', auth, (req: Request, res: Response) => {
  const mode = resolveAlpacaMode(req, res);
  if (!mode) return;
  resumeAlpacaBot(mode);
  res.json({ ok: true });
});

// POST /alpaca/:mode/emergency-stop — cancel all open orders without closing positions
app.post('/alpaca/:mode/emergency-stop', auth, (req: Request, res: Response) => {
  const mode = resolveAlpacaMode(req, res);
  if (!mode) return;
  void emergencyStop(mode).then(result => res.status(result.ok ? 200 : 500).json(result));
});

// GET /alpaca/:mode/journal — persisted trade history + per-strategy aggregates
app.get('/alpaca/:mode/journal', auth, (req: Request, res: Response) => {
  const mode = resolveAlpacaMode(req, res);
  if (!mode) return;
  const limit = Math.min(parseInt(String(req.query.limit ?? '500'), 10) || 500, 2000);
  res.json(getJournal(mode, limit));
});

// ── Backtest leaderboard (/leaderboard) ──────────────────────────────────────
// Runs every strategy against the full IG-tradable universe on a schedule
// (see leaderboard.ts) so results are available without needing a browser
// tab open — GET returns whatever the last completed sweep found.

app.get('/leaderboard', auth, (_req: Request, res: Response) => {
  res.json(getLeaderboardState());
});

app.post('/leaderboard/run', auth, (_req: Request, res: Response) => {
  res.json({ ok: true, message: 'Sweep starting…' });
  void runLeaderboardSweep().catch(e => console.error('[leaderboard] Manual run failed:', e));
});

// ── IG Strategy bot routes (/ig-strategy/:mode/*) ────────────────────────────

function resolveIgMode(req: Request, res: Response): IgMode | null {
  const mode = req.params.mode as string;
  if (mode !== 'demo' && mode !== 'live') {
    res.status(400).json({ ok: false, error: 'mode must be "demo" or "live"' });
    return null;
  }
  return mode;
}

app.get('/ig-strategy/:mode/status', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  void getIgStrategyBotStatus(mode).then(status => res.json(status));
});

// GET /ig-strategy/:mode/journal — persisted trade history + per-strategy
// aggregates, same shape as /alpaca/:mode/journal above. Mirrors that route,
// mapped onto the IG bot's own journal mode values (see tradeJournal.ts).
app.get('/ig-strategy/:mode/journal', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  const limit = Math.min(parseInt(String(req.query.limit ?? '500'), 10) || 500, 2000);
  res.json(getJournal(mode === 'live' ? 'ig-live' : 'ig-demo', limit));
});

// GET /ig-strategy/:mode/attribution — bot-vs-manual P&L split via a fuzzy
// join between IG's activity (real dealId+channel, but only ~2-3 days deep)
// and transaction (real £P&L, no usable join key of its own) endpoints —
// see tradeAttribution.ts for why this is fuzzy-matched rather than exact.
app.get('/ig-strategy/:mode/attribution', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  void computeTradeAttribution(mode).then(result => res.json(result));
});

// Powers the "pin to Gemini instead" picker for rule_based_analysis on the
// Start Bot form — the instruments its own scan won't pick up on its own
// (not in RULE_BASED_ANALYSIS_CONFIRMED_EPICS) but are still available via
// epicStrategyOverrides. FX excluded — fxScalperBot.ts owns FX trading
// exclusively regardless of which strategy this bot is running.
app.get('/ig-strategy/override-candidates', auth, (_req: Request, res: Response) => {
  const candidates = IG_EPICS
    .filter(e => !FX_EPICS.has(e.epic) && !RULE_BASED_ANALYSIS_CONFIRMED_EPICS.has(e.epic))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ ok: true, candidates });
});

app.post('/ig-strategy/:mode/start', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;

  const body = req.body as Partial<IgStrategyConfig>;
  const cfg: IgStrategyConfig = {
    mode,
    strategy:               body.strategy               ?? 'rsi_mean_reversion',
    epics:                  [],                // filled by scanner
    epicStrategyOverrides:  body.epicStrategyOverrides,
    maxRiskGbp:             body.maxRiskGbp             ?? 20,
    maxPositions:           body.maxPositions           ?? 6,
    allowShorts:            body.allowShorts            ?? false,
    maxDailyLossPct:        body.maxDailyLossPct        ?? 3,
  };

  res.json({ ok: true, message: 'IG bot starting…' });
  void startIgStrategyBot(cfg).then(r => {
    if (!r.ok) console.error(`[ig-strategy] Start failed: ${r.error}`);
  });
});

app.post('/ig-strategy/:mode/stop', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  stopIgStrategyBot(mode);
  res.json({ ok: true });
});

// Live override for the daily-loss circuit breaker — takes effect on the
// bot's next poll cycle without a restart, and clears an active lock right
// away (see updateMaxDailyLossPct's own comment for why that's safe).
app.post('/ig-strategy/:mode/max-daily-loss', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  const pct = Number((req.body as { maxDailyLossPct?: unknown }).maxDailyLossPct);
  const r = updateMaxDailyLossPct(mode, pct);
  res.json(r);
});

// Live override for the daily-profit lock — same shape as max-daily-loss above.
app.post('/ig-strategy/:mode/daily-profit-target', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  const gbp = Number((req.body as { dailyProfitTargetGbp?: unknown }).dailyProfitTargetGbp);
  const r = updateDailyProfitTargetGbp(mode, gbp);
  res.json(r);
});

app.post('/ig-strategy/:mode/pause', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  pauseIgStrategyBot(mode);
  res.json({ ok: true });
});

app.post('/ig-strategy/:mode/resume', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  resumeIgStrategyBot(mode);
  res.json({ ok: true });
});

// ── FX scalper — dedicated, Lightstreamer-driven, real execution ───────────
app.get('/fx-scalper/:mode/status', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  res.json(getFxScalperBot(mode).status());
});

app.post('/fx-scalper/:mode/start', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  const body = req.body as FxScalperStartParams;

  res.json({ ok: true, message: 'FX scalper starting…' });
  void getFxScalperBot(mode).start(body).then(r => {
    if (!r.ok) console.error(`[fx-scalper] Start failed: ${r.error}`);
  });
});

app.post('/fx-scalper/:mode/stop', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  getFxScalperBot(mode).stop();
  res.json({ ok: true });
});

app.post('/fx-scalper/:mode/pause', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  getFxScalperBot(mode).pause();
  res.json({ ok: true });
});

app.post('/fx-scalper/:mode/resume', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  getFxScalperBot(mode).resume();
  res.json({ ok: true });
});

app.post('/fx-scalper/:mode/max-risk', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  const riskGbp = Number((req.body as { maxRiskGbp?: unknown }).maxRiskGbp);
  res.json(getFxScalperBot(mode).setMaxRisk(riskGbp));
});

app.post('/fx-scalper/:mode/max-positions', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  const n = Number((req.body as { maxConcurrentPositions?: unknown }).maxConcurrentPositions);
  res.json(getFxScalperBot(mode).setMaxConcurrentPositions(n));
});

// ── IG CFD bot — persistent server-side, OAuth session (see igCfdBot.ts) ────
app.get('/ig-cfd/:mode/status', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  res.json(getIgCfdBot(mode).status());
});

app.post('/ig-cfd/:mode/start', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  const body = req.body as CfdStartParams;

  res.json({ ok: true, message: 'IG CFD bot starting…' });
  void getIgCfdBot(mode).start(body).then(r => {
    if (!r.ok) console.error(`[ig-cfd] Start failed: ${r.error}`);
  });
});

app.post('/ig-cfd/:mode/stop', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  getIgCfdBot(mode).stop();
  res.json({ ok: true });
});

app.post('/ig-cfd/:mode/pause', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  getIgCfdBot(mode).pause();
  res.json({ ok: true });
});

app.post('/ig-cfd/:mode/resume', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  getIgCfdBot(mode).resume();
  res.json({ ok: true });
});

app.post('/ig-cfd/:mode/close', auth, async (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  const { dealId } = req.body as { dealId?: string };
  if (!dealId) { res.status(400).json({ ok: false, error: 'dealId required' }); return; }
  const result = await getIgCfdBot(mode).closePosition(dealId);
  res.json(result);
});

// ── Gemini position watch ─────────────────────────────────────────────────────
// Lists all currently open IG positions for the account (however they were
// opened — manually, via the strategy bot, anywhere) alongside which ones are
// flagged for Gemini to periodically review and potentially close.
app.get('/ig-strategy/:mode/watch', auth, async (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  const session = getSession(`igstrat:${mode}`);
  if (!session) { res.json({ ok: true, positions: [], watchedDealIds: getWatchedDealIds(mode), watchNotes: getWatchNotes(mode), aiPaused: isWatchAiPaused(mode), noAiCloseDealIds: getNoAiCloseDealIds(mode) }); return; }
  try {
    const positions = await fetchFullPositions(session);
    res.json({ ok: true, positions, watchedDealIds: getWatchedDealIds(mode), watchNotes: getWatchNotes(mode), aiPaused: isWatchAiPaused(mode), noAiCloseDealIds: getNoAiCloseDealIds(mode) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// Per-position AI-exemption toggle — added 2026-09-03 so a position that
// was automatically exempted at entry (every mean-reversion-family trade)
// can have that turned back on if the user actually wants Gemini watching
// it, and so the UI can show which positions are exempt in the first place
// rather than displaying the same generic "Watching" badge for both.
app.post('/ig-strategy/:mode/watch/:dealId/ai-exempt', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  if (req.body?.exempt) markNoAiClose(mode, req.params.dealId);
  else unmarkNoAiClose(mode, req.params.dealId);
  res.json({ ok: true });
});

app.post('/ig-strategy/:mode/watch/:dealId', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  const note = typeof req.body?.note === 'string' ? req.body.note : '';
  addToWatch(mode, req.params.dealId, note);
  res.json({ ok: true });
});

app.post('/ig-strategy/:mode/watch/:dealId/note', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  const note = typeof req.body?.note === 'string' ? req.body.note : '';
  setWatchNote(mode, req.params.dealId, note);
  res.json({ ok: true });
});

app.delete('/ig-strategy/:mode/watch/:dealId', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  removeFromWatch(mode, req.params.dealId);
  res.json({ ok: true });
});

// Manual Gemini kill-switches — see isStrategyAiPaused/isWatchAiPaused's
// own comments for why these exist separately from stop/start.
app.post('/ig-strategy/:mode/ai-pause', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  setStrategyAiPaused(mode, !!req.body?.paused);
  res.json({ ok: true });
});

app.post('/ig-strategy/:mode/watch/ai-pause', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  setWatchAiPaused(mode, !!req.body?.paused);
  res.json({ ok: true });
});

// Alpaca real-time news stream — opt-in, off by default, mode-independent
// (it's a shared background connection, not per-account). See
// alpacaNewsStream.ts for why this needs to be trivially toggleable.
app.get('/alpaca-news-stream', auth, (_req: Request, res: Response) => {
  res.json({ ok: true, enabled: isNewsStreamEnabled() });
});
app.post('/alpaca-news-stream', auth, (req: Request, res: Response) => {
  setNewsStreamEnabled(!!req.body?.enabled);
  res.json({ ok: true, enabled: isNewsStreamEnabled() });
});

// T212 CFD ideas — on-demand only (no scheduled scan, no persistence, no
// T212 connection at all: their CFD account has no API). User triggers a
// fresh scan when they open the tab; this just runs it and returns the
// result. See cfdIdeas.ts for why this is a separate module rather than
// reusing igStrategyBot.ts's own recommendations (IG's levels are in
// spread-bet points, not real prices).
app.get('/cfd-ideas', auth, async (_req: Request, res: Response) => {
  try {
    const ideas = await scanCfdIdeas();
    res.json({ ok: true, ideas, scannedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// Manual trigger for allowance-blocked recommendation refresh, bypassing the
// normal 6h cooldown — otherwise waits for the hourly background check.
app.post('/ig-strategy/:mode/refresh-recommendations', auth, async (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  await refreshRecommendations(mode, true);
  res.json({ ok: true });
});

// "Send it through" — opens a currently-listed recommendation as a real
// order with one click, using the stop/TP it already carries.
app.post('/ig-strategy/:mode/recommendations/:epic/open', auth, async (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  const result = await openRecommendation(mode, decodeURIComponent(req.params.epic));
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/ig-strategy/:mode/refresh-daily-pick', auth, async (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  await refreshDailyPick(mode);
  res.json({ ok: true });
});

// ── Manual pause/resume — user-chosen instruments excluded from scanning
// and new entries until resumed. No auto-expiry.
app.get('/ig-strategy/:mode/paused', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  res.json({ ok: true, pausedEpics: getPausedEpics(mode) });
});

app.post('/ig-strategy/:mode/paused/:epic', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  pauseEpic(mode, req.params.epic);
  res.json({ ok: true });
});

app.delete('/ig-strategy/:mode/paused/:epic', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  resumeEpic(mode, req.params.epic);
  res.json({ ok: true });
});

// ── Manual position protection — positions the bot didn't open itself are
// left alone by default (see botOpenedDeals/releasedDeals in igStrategyBot.ts).
// Release lets the bot manage/close it; hold pulls it back under protection
// (also usable on a bot-opened position you want to keep past its own exit
// signal).
app.post('/ig-strategy/:mode/deals/:dealId/release', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  releaseDeal(mode, req.params.dealId);
  res.json({ ok: true });
});

app.post('/ig-strategy/:mode/deals/:dealId/hold', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  holdDeal(mode, req.params.dealId);
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[bot-server] Listening on 0.0.0.0:${PORT}`);
  console.log(`[bot-server] Multi-account mode: demo + live`);

  startLeaderboardSchedule();
  startGeminiWatch();
  startRecommendationRefresh();
  startAlpacaNewsStream(); // no-op unless previously toggled on — see alpacaNewsStream.ts

  // Auto-resume legacy single-account bot if it was running before restart
  const saved = loadSavedState();
  if (saved) {
    const igKey  = process.env.IG_API_KEY  ?? '';
    const igUser = process.env.IG_USERNAME ?? '';
    const igPass = process.env.IG_PASSWORD ?? '';
    if (!igKey || !igUser || !igPass) {
      console.warn('[bot-server] Skipping auto-resume — IG_API_KEY / IG_USERNAME / IG_PASSWORD not set');
    } else {
      console.log(`[bot-server] Auto-resuming legacy bot with ${saved.epics.length} epic(s)...`);
      void startBot(saved).then(r => {
        if (r.ok) console.log('[bot-server] Auto-resume successful');
        else console.error(`[bot-server] Auto-resume failed: ${r.error}`);
      });
    }
  }

  // Auto-resume Alpaca strategy bots (paper/live) if either was running before restart.
  // Without this, a PM2 restart while a bot held open positions leaves them
  // un-monitored — no exits, no daily-loss circuit breaker — until a human
  // notices and restarts it manually via the UI.
  for (const mode of ['paper', 'live'] as const) {
    const savedAlpaca = loadSavedAlpacaState(mode);
    if (!savedAlpaca) continue;
    const hasKeys = mode === 'live'
      ? !!(process.env.ALPACA_LIVE_KEY  ?? process.env.ALPACA_API_KEY)
      : !!(process.env.ALPACA_PAPER_KEY ?? process.env.ALPACA_API_KEY);
    if (!hasKeys) {
      console.warn(`[bot-server] Skipping Alpaca ${mode} auto-resume — credentials not set`);
      continue;
    }
    console.log(`[bot-server] Auto-resuming Alpaca ${mode} bot (${savedAlpaca.strategy})...`);
    void startAlpacaBot(savedAlpaca).then(r => {
      if (r.ok) console.log(`[bot-server] Alpaca ${mode} auto-resume successful`);
      else console.error(`[bot-server] Alpaca ${mode} auto-resume failed: ${r.error}`);
    });
  }

  // Auto-resume IG strategy bots (demo/live) if either was running before restart.
  for (const mode of ['demo', 'live'] as const) {
    const savedIg = loadSavedIgStrategyState(mode);
    if (!savedIg) continue;
    const hasCreds = mode === 'live'
      ? !!(process.env.IG_LIVE_API_KEY)
      : !!(process.env.IG_DEMO_API_KEY ?? process.env.IG_API_KEY);
    if (!hasCreds) {
      console.warn(`[bot-server] Skipping IG strategy ${mode} auto-resume — credentials not set`);
      continue;
    }
    console.log(`[bot-server] Auto-resuming IG strategy ${mode} bot (${savedIg.strategy})...`);
    void startIgStrategyBot(savedIg).then(r => {
      if (r.ok) console.log(`[bot-server] IG strategy ${mode} auto-resume successful`);
      else console.error(`[bot-server] IG strategy ${mode} auto-resume failed: ${r.error}`);
    });
  }

  // Auto-resume the FX scalper (demo/live) if it was running before restart —
  // same rationale as the other auto-resumes: without this, any position it
  // still holds goes unmanaged (no exits, no maintenance sweep) until someone
  // notices and restarts it by hand.
  for (const mode of ['demo', 'live'] as const) {
    const savedFx = loadSavedFxScalperState(mode);
    if (!savedFx) continue;
    const hasCreds = mode === 'live'
      ? !!(process.env.IG_LIVE_API_KEY)
      : !!(process.env.IG_DEMO_API_KEY ?? process.env.IG_API_KEY);
    if (!hasCreds) {
      console.warn(`[bot-server] Skipping FX scalper ${mode} auto-resume — credentials not set`);
      continue;
    }
    console.log(`[bot-server] Auto-resuming FX scalper ${mode} bot (${savedFx.epics.length} epic(s))...`);
    void getFxScalperBot(mode).start(savedFx).then(r => {
      if (r.ok) console.log(`[bot-server] FX scalper ${mode} auto-resume successful`);
      else console.error(`[bot-server] FX scalper ${mode} auto-resume failed: ${r.error}`);
    });
  }

  // Auto-resume the T212 ISA bot (demo/live) if it was running before
  // restart — same rationale as every other bot's auto-resume.
  for (const mode of ['demo', 'live'] as const) {
    if (!wasT212BotRunning(mode)) continue;
    console.log(`[bot-server] Auto-resuming T212 ${mode} bot...`);
    void startT212Bot(mode).then(r => {
      if (r.ok) console.log(`[bot-server] T212 ${mode} auto-resume successful`);
      else console.error(`[bot-server] T212 ${mode} auto-resume failed: ${r.error}`);
    });
  }

  // Auto-resume the mean-reversion bot's three instances (demo/live each) —
  // same rationale as every other bot's auto-resume.
  for (const instance of ['fx', 'stocks', 'japan225'] as const) {
    for (const mode of ['demo', 'live'] as const) {
      if (!wasMeanReversionBotRunning(instance, mode)) continue;
      console.log(`[bot-server] Auto-resuming mean-reversion ${instance} ${mode} bot...`);
      const r = startMeanReversionBot(instance, mode);
      if (r.ok) console.log(`[bot-server] Mean-reversion ${instance} ${mode} auto-resume successful`);
      else console.error(`[bot-server] Mean-reversion ${instance} ${mode} auto-resume failed: ${r.error}`);
    }
  }

  // Auto-resume the IG options bot (demo/live) if it was running before
  // restart — same rationale as every other bot's auto-resume.
  for (const mode of ['demo', 'live'] as const) {
    if (!wasIgOptionsBotRunning(mode)) continue;
    console.log(`[bot-server] Auto-resuming IG options ${mode} bot...`);
    const r = startIgOptionsBot(mode);
    if (r.ok) console.log(`[bot-server] IG options ${mode} auto-resume successful`);
    else console.error(`[bot-server] IG options ${mode} auto-resume failed: ${r.error}`);
  }

  // Auto-resume the IG CFD bot (demo/live) if it was running before restart —
  // same rationale as every other auto-resume above.
  for (const mode of ['demo', 'live'] as const) {
    const savedCfd = loadSavedCfdState(mode);
    if (!savedCfd) continue;
    const hasCreds = mode === 'live'
      ? !!(process.env.IG_LIVE_API_KEY)
      : !!(process.env.IG_DEMO_API_KEY ?? process.env.IG_API_KEY);
    if (!hasCreds) {
      console.warn(`[bot-server] Skipping IG CFD ${mode} auto-resume — credentials not set`);
      continue;
    }
    console.log(`[bot-server] Auto-resuming IG CFD ${mode} bot (${savedCfd.strategy})...`);
    void getIgCfdBot(mode).start(savedCfd).then(r => {
      if (r.ok) console.log(`[bot-server] IG CFD ${mode} auto-resume successful`);
      else console.error(`[bot-server] IG CFD ${mode} auto-resume failed: ${r.error}`);
    });
  }
});

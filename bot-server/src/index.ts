import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { startBot, stopBot, getBotStatus, loadSavedState, pauseBot, resumeBot } from './bot';
import { startStrategyRunner, stopStrategyRunner, getStrategyRunnerStatus, type StrategyRunnerConfig } from './strategyRunner';
import { demoBot, liveBot, getAccountBot, type AccountKey } from './botAccount';
import { getStockBot, type StockBotStartParams } from './stockBot';
import { calcRsi, calcMacdHist, calcAtr } from './scalperStrategy';
import {
  startAlpacaBot, stopAlpacaBot, pauseAlpacaBot, resumeAlpacaBot,
  getAlpacaBotStatus, emergencyStop, loadSavedAlpacaState,
  type AlpacaBotConfig,
} from './alpacaBot';
import {
  startIgStrategyBot, stopIgStrategyBot, pauseIgStrategyBot, resumeIgStrategyBot,
  getIgStrategyBotStatus, loadSavedIgStrategyState, startRecommendationRefresh,
  refreshRecommendations, refreshDailyPick, openRecommendation,
  getPausedEpics, pauseEpic, resumeEpic,
  releaseDeal, holdDeal, updateMaxDailyLossPct,
  type IgMode, type IgStrategyConfig,
} from './igStrategyBot';
import { getJournal } from './tradeJournal';
import { startLeaderboardSchedule, getLeaderboardState, runLeaderboardSweep } from './leaderboard';
import { startGeminiWatch, getWatchedDealIds, addToWatch, removeFromWatch } from './geminiWatch';
import { fetchFullPositions, getSession } from './igApi';
import { getFxScalperBot, loadSavedFxScalperState, type FxScalperStartParams } from './fxScalperBot';

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

app.post('/ig-strategy/:mode/start', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;

  const body = req.body as Partial<IgStrategyConfig>;
  const cfg: IgStrategyConfig = {
    mode,
    strategy:          body.strategy          ?? 'rsi_mean_reversion',
    epics:             [],                // filled by scanner
    maxRiskGbp:        body.maxRiskGbp        ?? 20,
    maxStockPositions: body.maxStockPositions ?? 3,
    maxIndexPositions: body.maxIndexPositions ?? 3,
    allowShorts:       body.allowShorts       ?? false,
    maxDailyLossPct:   body.maxDailyLossPct   ?? 3,
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

// ── Gemini position watch ─────────────────────────────────────────────────────
// Lists all currently open IG positions for the account (however they were
// opened — manually, via the strategy bot, anywhere) alongside which ones are
// flagged for Gemini to periodically review and potentially close.
app.get('/ig-strategy/:mode/watch', auth, async (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  const session = getSession(`igstrat:${mode}`);
  if (!session) { res.json({ ok: true, positions: [], watchedDealIds: getWatchedDealIds(mode) }); return; }
  try {
    const positions = await fetchFullPositions(session);
    res.json({ ok: true, positions, watchedDealIds: getWatchedDealIds(mode) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/ig-strategy/:mode/watch/:dealId', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  addToWatch(mode, req.params.dealId);
  res.json({ ok: true });
});

app.delete('/ig-strategy/:mode/watch/:dealId', auth, (req: Request, res: Response) => {
  const mode = resolveIgMode(req, res);
  if (!mode) return;
  removeFromWatch(mode, req.params.dealId);
  res.json({ ok: true });
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
});

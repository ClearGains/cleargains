import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { startBot, stopBot, getBotStatus, loadSavedState, injectPosition, pauseBot, resumeBot, type InjectParams } from './bot';
import { startStrategyRunner, stopStrategyRunner, getStrategyRunnerStatus, type StrategyRunnerConfig } from './strategyRunner';
import { demoBot, liveBot, getAccountBot, type AccountKey } from './botAccount';

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

// POST /accounts/:account/inject
app.post('/accounts/:account/inject', auth, (req: Request, res: Response) => {
  const bot = resolveBot(req, res);
  if (!bot) return;

  const body = req.body as Partial<InjectParams>;
  const { epic, dealId, direction, size, entryPrice, stopPoints, tpPoints } = body;
  if (!epic || !dealId || !direction || !size || !entryPrice || !stopPoints || !tpPoints) {
    res.status(400).json({ ok: false, error: 'Required: epic, dealId, direction, size, entryPrice, stopPoints, tpPoints' });
    return;
  }
  if (direction !== 'BUY' && direction !== 'SELL') {
    res.status(400).json({ ok: false, error: 'direction must be BUY or SELL' });
    return;
  }
  const result = bot.inject({ epic, dealId, direction, size, entryPrice, stopPoints, tpPoints });
  res.status(result.ok ? 200 : 400).json(result);
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

app.post('/debug/inject', auth, (req: Request, res: Response) => {
  const body = req.body as Partial<InjectParams>;
  const { epic, dealId, direction, size, entryPrice, stopPoints, tpPoints } = body;
  if (!epic || !dealId || !direction || !size || !entryPrice || !stopPoints || !tpPoints) {
    res.status(400).json({ ok: false, error: 'Required: epic, dealId, direction, size, entryPrice, stopPoints, tpPoints' });
    return;
  }
  if (direction !== 'BUY' && direction !== 'SELL') {
    res.status(400).json({ ok: false, error: 'direction must be BUY or SELL' });
    return;
  }
  const result = injectPosition({ epic, dealId, direction, size, entryPrice, stopPoints, tpPoints });
  res.status(result.ok ? 200 : 400).json(result);
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

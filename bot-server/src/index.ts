import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { startBot, stopBot, getBotStatus, loadSavedState, injectPosition, type InjectParams } from './bot';
import { startStrategyRunner, stopStrategyRunner, getStrategyRunnerStatus, type StrategyRunnerConfig } from './strategyRunner';

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

// ── Routes ────────────────────────────────────────────────────────────────────

// Public health check — no auth required (used by Vercel to check if VM is reachable)
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), running: getBotStatus().running });
});

// GET /status — full bot status
app.get('/status', auth, (_req, res) => {
  res.json(getBotStatus());
});

// POST /start — start the bot
app.post('/start', auth, (req: Request, res: Response) => {
  const { epics, config } = req.body as {
    epics: string[];
    config?: Record<string, number>;
  };

  if (!Array.isArray(epics) || epics.length === 0) {
    res.status(400).json({ ok: false, error: 'epics array is required' });
    return;
  }

  void startBot({ epics, config }).then(result => res.json(result));
});

// POST /stop — stop the bot
app.post('/stop', auth, (_req, res) => {
  stopBot();
  res.json({ ok: true });
});

// POST /debug/inject — inject a manually-opened position into bot state for testing exit logic
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

// POST /strategy/start — start server-side strategy runner
app.post('/strategy/start', auth, (req: Request, res: Response) => {
  const cfg = req.body as StrategyRunnerConfig;
  if (!cfg.markets?.length) {
    res.status(400).json({ ok: false, error: 'markets array is required' });
    return;
  }
  const result = startStrategyRunner(cfg);
  res.status(result.ok ? 200 : 400).json(result);
});

// POST /strategy/stop — stop strategy runner
app.post('/strategy/stop', auth, (_req, res) => {
  stopStrategyRunner();
  res.json({ ok: true });
});

// GET /strategy/status — strategy runner status + log
app.get('/strategy/status', auth, (_req, res) => {
  res.json(getStrategyRunnerStatus());
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[bot-server] Listening on 0.0.0.0:${PORT}`);
  console.log(`[bot-server] IG env: ${process.env.IG_ENV ?? 'demo'}`);

  // Auto-resume if bot was running before process restart
  const saved = loadSavedState();
  if (saved) {
    console.log(`[bot-server] Auto-resuming bot with ${saved.epics.length} epic(s)...`);
    void startBot(saved).then(r => {
      if (r.ok) console.log('[bot-server] Auto-resume successful');
      else console.error(`[bot-server] Auto-resume failed: ${r.error}`);
    });
  }
});

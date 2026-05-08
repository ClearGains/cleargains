import express, { Request, Response, NextFunction } from 'express';
import { startBot, stopBot, getBotStatus, loadSavedState } from './bot';

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

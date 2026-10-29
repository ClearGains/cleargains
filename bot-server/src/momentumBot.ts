// ── Momentum Testbot controls (2026-10-29) ───────────────────────────────────
// The Testbot is a separate Python process (systemd service ig-momentum-bot,
// ~/ig-momentum-bot). This module only reads its files and flips the switches
// in its .env, which it re-reads every scan; it never trades on its own except
// for the owner's "close its positions" button, which closes only deals the
// bot recorded as its own.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { authenticate, fetchFullPositions, closePosition } from './igApi';
import { resolveCredentials } from './igStrategyBot';

const DIR = path.join(os.homedir(), 'ig-momentum-bot');
const ENV_FILE = path.join(DIR, '.env');
const OWN_FILE = path.join(DIR, 'own_deals.json');
const LOG_FILE = path.join(DIR, 'ig_momentum_bot.log');
const GUARD_FILE = path.join(DIR, 'chop_guard.json');
const TRADES_CSV = path.join(DIR, 'trades.csv');
const SERVICE = 'ig-momentum-bot';

type OwnDeal = { market: string; epic: string; direction: 'BUY' | 'SELL'; size: number; level: number | null; opened_utc: string };

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    // Settings only: never send a login value anywhere.
    if (m && !/USERNAME|PASSWORD|API_KEY/.test(m[1])) out[m[1]] = m[2].trim();
  }
  return out;
}

function setEnvFlag(key: 'KILL_SWITCH' | 'DRY_RUN', value: boolean): void {
  let text = fs.readFileSync(ENV_FILE, 'utf8');
  const line = `${key}=${value ? 'true' : 'false'}`;
  text = new RegExp(`^${key}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line) : `${text.trimEnd()}\n${line}\n`;
  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 });
}

function systemctl(action: 'start' | 'stop' | 'is-active'): Promise<string> {
  const args = action === 'is-active' ? ['is-active', SERVICE] : ['-n', 'systemctl', action, SERVICE];
  const cmd = action === 'is-active' ? 'systemctl' : 'sudo';
  return new Promise(resolve => execFile(cmd, args, { timeout: 20_000 }, (err, out, errOut) =>
    resolve((out || errOut || (err ? err.message : '')).trim())));
}

function tailLines(file: string, n: number): string[] {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trimEnd().split('\n').slice(-n);
  } catch { return []; }
}

export async function momentumStatus() {
  const env = readEnv();
  const own = readJson<Record<string, OwnDeal>>(OWN_FILE, {});
  let live: Array<OwnDeal & { dealId: string; upl: number | null; current: number | null; stopLevel: number | null; limitLevel: number | null }> = [];
  let ig_error: string | null = null;
  if (Object.keys(own).length) {
    try {
      const c = resolveCredentials('demo');
      const s = await authenticate(c.apiKey, c.username, c.password, 'demo', 'momentum-ui');
      const pos = await fetchFullPositions(s);
      live = Object.entries(own).map(([dealId, d]) => {
        const p = pos.find(x => x.dealId === dealId);
        return { dealId, ...d, upl: p?.upl ?? null, current: p ? (d.direction === 'BUY' ? p.bid : p.offer) : null,
          stopLevel: p?.stopLevel ?? null, limitLevel: p?.limitLevel ?? null };
      });
    } catch (e) {
      ig_error = e instanceof Error ? e.message : String(e);
      live = Object.entries(own).map(([dealId, d]) => ({ dealId, ...d, upl: null, current: null, stopLevel: null, limitLevel: null }));
    }
  }
  const guard = readJson<{ date?: string; markets?: Record<string, { losses: number; last_loss: number }> }>(GUARD_FILE, {});
  const today = new Date().toISOString().slice(0, 10);
  const trades = tailLines(TRADES_CSV, 400).slice(1);
  return {
    service: await systemctl('is-active'),
    paused: /^(1|true|yes)$/i.test(env.KILL_SWITCH ?? ''),
    dryRun: /^(1|true|yes)$/i.test(env.DRY_RUN ?? 'true'),
    settings: {
      riskPerTradeGbp: Number(env.RISK_PER_TRADE_GBP ?? 20),
      minStrength: Number(env.MIN_STRENGTH ?? 60),
      cooldownMinutes: Number(env.COOLDOWN_MINUTES ?? 60),
      maxLossesPerDay: Number(env.MAX_LOSSES_PER_DAY ?? 2),
      scanSeconds: Number(env.SCAN_INTERVAL_SECONDS ?? 300),
    },
    positions: live,
    igError: ig_error,
    guard: guard.date === today ? guard.markets ?? {} : {},
    opensToday: trades.filter(l => l.startsWith(today) && l.includes(',OPEN,') && l.includes('ACCEPTED')).length,
    log: tailLines(LOG_FILE, 40),
  };
}

export async function momentumControl(action: string): Promise<{ ok: boolean; message: string }> {
  switch (action) {
    case 'pause':      setEnvFlag('KILL_SWITCH', true);  return { ok: true, message: 'Paused: no new trades from its next scan (open trades keep their stops).' };
    case 'resume':     setEnvFlag('KILL_SWITCH', false); return { ok: true, message: 'Resumed: it trades again from its next scan.' };
    case 'dry-run-on': setEnvFlag('DRY_RUN', true);      return { ok: true, message: 'Dry run on: it logs trades without placing them.' };
    case 'dry-run-off':setEnvFlag('DRY_RUN', false);     return { ok: true, message: 'Dry run off: it places real demo trades.' };
    case 'stop':  { const r = await systemctl('stop');  const s = await systemctl('is-active'); return { ok: s !== 'active', message: s !== 'active' ? 'Stopped. Open trades keep their stops at IG.' : `Stop failed: ${r}` }; }
    case 'start': { const r = await systemctl('start'); const s = await systemctl('is-active'); return { ok: s === 'active', message: s === 'active' ? 'Started.' : `Start failed: ${r}` }; }
    case 'close-all': return closeAllOwn();
    default: return { ok: false, message: `Unknown action ${action}` };
  }
}

// A Testbot deal closed from the IG tab's own Close button (2026-10-29):
// drop it from the bot's list and record it, so the bot doesn't count it as a
// stop-out. Returns false if the deal isn't the Testbot's.
export function forgetMomentumDeal(dealId: string, reason: string): boolean {
  const own = readJson<Record<string, OwnDeal>>(OWN_FILE, {});
  const d = own[dealId];
  if (!d) return false;
  delete own[dealId];
  fs.writeFileSync(OWN_FILE, JSON.stringify(own, null, 1));
  fs.appendFileSync(TRADES_CSV, `${new Date().toISOString().slice(0, 19)}+00:00,CLOSE_UI,${d.market},${d.epic},${d.direction},${d.size},,,,,,ACCEPTED,${reason},${dealId}\n`);
  return true;
}
export function isMomentumDeal(dealId: string): boolean {
  return dealId in readJson<Record<string, OwnDeal>>(OWN_FILE, {});
}

// Closes only the deals the Testbot recorded as its own, then removes them from
// its list so it doesn't count them as stop-outs.
async function closeAllOwn(): Promise<{ ok: boolean; message: string }> {
  const own = readJson<Record<string, OwnDeal>>(OWN_FILE, {});
  const ids = Object.keys(own);
  if (!ids.length) return { ok: true, message: 'It has no open trades.' };
  setEnvFlag('KILL_SWITCH', true);   // stop it reopening straight away
  const c = resolveCredentials('demo');
  const s = await authenticate(c.apiKey, c.username, c.password, 'demo', 'momentum-ui');
  const open = new Set((await fetchFullPositions(s)).map(p => p.dealId));
  const done: string[] = [], failed: string[] = [];
  for (const id of ids) {
    const d = own[id];
    try {
      if (open.has(id)) await closePosition(s, id, d.direction, d.size);
      done.push(d.market);
      const cur = readJson<Record<string, OwnDeal>>(OWN_FILE, {});
      delete cur[id];
      fs.writeFileSync(OWN_FILE, JSON.stringify(cur, null, 1));
      fs.appendFileSync(TRADES_CSV, `${new Date().toISOString().slice(0, 19)}+00:00,CLOSE_UI,${d.market},${d.epic},${d.direction},${d.size},,,,,,ACCEPTED,closed from the website,${id}\n`);
    } catch (e) {
      failed.push(`${d.market}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: !failed.length, message: `Closed ${done.length} trade(s)${done.length ? ` (${done.join(', ')})` : ''} and paused it.${failed.length ? ` Failed: ${failed.join('; ')}` : ''}` };
}

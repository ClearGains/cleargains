// ── Momentum Testbot controls (2026-10-29) ───────────────────────────────────
// The Testbot is a separate Python process. Two copies run (2026-10-30):
//   demo: systemd ig-momentum-bot,      ~/ig-momentum-bot      (IG demo)
//   live: systemd ig-momentum-bot-live, ~/ig-momentum-bot-live (IG LIVE, real money)
// This module only reads their files and flips the switches in their .env,
// which they re-read every scan; it never trades on its own except for the
// owner's "close its positions" button, which closes only deals that copy
// recorded as its own.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { authenticate, fetchFullPositions, closePosition } from './igApi';
import { resolveCredentials } from './igStrategyBot';

export type MomentumInstance = 'demo' | 'live';

function paths(inst: MomentumInstance) {
  const dir = path.join(os.homedir(), inst === 'live' ? 'ig-momentum-bot-live' : 'ig-momentum-bot');
  return {
    env: path.join(dir, '.env'),
    own: path.join(dir, 'own_deals.json'),
    log: path.join(dir, 'ig_momentum_bot.log'),
    guard: path.join(dir, 'chop_guard.json'),
    trades: path.join(dir, 'trades.csv'),
    history: path.join(dir, 'deal_history.json'),
    service: inst === 'live' ? 'ig-momentum-bot-live' : 'ig-momentum-bot',
  };
}

type OwnDeal = { market: string; epic: string; direction: 'BUY' | 'SELL'; size: number; level: number | null; opened_utc: string };

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

function readEnv(inst: MomentumInstance): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(paths(inst).env, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    // Settings only: never send a login value anywhere.
    if (m && !/USERNAME|PASSWORD|API_KEY/.test(m[1])) out[m[1]] = m[2].trim();
  }
  return out;
}

function setEnvFlag(inst: MomentumInstance, key: 'KILL_SWITCH' | 'DRY_RUN', value: boolean): void {
  const file = paths(inst).env;
  let text = fs.readFileSync(file, 'utf8');
  const line = `${key}=${value ? 'true' : 'false'}`;
  text = new RegExp(`^${key}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line) : `${text.trimEnd()}\n${line}\n`;
  fs.writeFileSync(file, text, { mode: 0o600 });
}

function systemctl(inst: MomentumInstance, action: 'start' | 'stop' | 'is-active'): Promise<string> {
  const service = paths(inst).service;
  const args = action === 'is-active' ? ['is-active', service] : ['-n', 'systemctl', action, service];
  const cmd = action === 'is-active' ? 'systemctl' : 'sudo';
  return new Promise(resolve => execFile(cmd, args, { timeout: 20_000 }, (err, out, errOut) =>
    resolve((out || errOut || (err ? err.message : '')).trim())));
}

function tailLines(file: string, n: number): string[] {
  try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n); } catch { return []; }
}

async function igSession(inst: MomentumInstance) {
  const c = resolveCredentials(inst);
  return authenticate(c.apiKey, c.username, c.password, inst, `momentum-ui:${inst}`);
}

// Every deal a copy ever opened (labels its trades in closed-positions lists).
export function momentumHistory(inst: MomentumInstance): Array<{ dealId: string; market: string; epic: string; direction: string; size: number; level: number | null; opened_utc: string }> {
  return readJson(paths(inst).history, []);
}

export async function momentumStatus(inst: MomentumInstance = 'demo') {
  const p = paths(inst);
  const env = readEnv(inst);
  const own = readJson<Record<string, OwnDeal>>(p.own, {});
  let open: Array<OwnDeal & { dealId: string; upl: number | null; current: number | null; stopLevel: number | null; limitLevel: number | null }> = [];
  let igError: string | null = null;
  if (Object.keys(own).length) {
    try {
      const pos = await fetchFullPositions(await igSession(inst));
      open = Object.entries(own).map(([dealId, d]) => {
        const x = pos.find(q => q.dealId === dealId);
        return { dealId, ...d, upl: x?.upl ?? null, current: x ? (d.direction === 'BUY' ? x.bid : x.offer) : null,
          stopLevel: x?.stopLevel ?? null, limitLevel: x?.limitLevel ?? null };
      });
    } catch (e) {
      igError = e instanceof Error ? e.message : String(e);
      open = Object.entries(own).map(([dealId, d]) => ({ dealId, ...d, upl: null, current: null, stopLevel: null, limitLevel: null }));
    }
  }
  const guard = readJson<{ date?: string; markets?: Record<string, { losses: number; last_loss: number }> }>(p.guard, {});
  const today = new Date().toISOString().slice(0, 10);
  const trades = tailLines(p.trades, 400).slice(1);
  return {
    instance: inst,
    service: await systemctl(inst, 'is-active'),
    paused: /^(1|true|yes)$/i.test(env.KILL_SWITCH ?? ''),
    dryRun: /^(1|true|yes)$/i.test(env.DRY_RUN ?? 'true'),
    settings: {
      riskPerTradeGbp: Number(env.STOP_GBP ?? env.RISK_PER_TRADE_GBP ?? 20),
      minStrength: Number(env.MIN_STRENGTH ?? 60),
      cooldownMinutes: Number(env.COOLDOWN_MINUTES ?? 60),
      maxLossesPerDay: Number(env.MAX_LOSSES_PER_DAY ?? 2),
      scanSeconds: Number(env.SCAN_INTERVAL_SECONDS ?? 300),
    },
    positions: open,
    igError,
    guard: guard.date === today ? guard.markets ?? {} : {},
    opensToday: trades.filter(l => l.startsWith(today) && l.includes(',OPEN,') && l.includes('ACCEPTED')).length,
    log: tailLines(p.log, 40),
  };
}

export async function momentumControl(action: string, inst: MomentumInstance = 'demo'): Promise<{ ok: boolean; message: string }> {
  const acct = inst === 'live' ? 'LIVE (real money)' : 'demo';
  switch (action) {
    case 'pause':      setEnvFlag(inst, 'KILL_SWITCH', true);  return { ok: true, message: 'Paused: no new trades from its next scan (open trades keep their stops).' };
    case 'resume':     setEnvFlag(inst, 'KILL_SWITCH', false); return { ok: true, message: 'Resumed: it trades again from its next scan.' };
    case 'dry-run-on': setEnvFlag(inst, 'DRY_RUN', true);      return { ok: true, message: 'Dry run on: it logs trades without placing them.' };
    case 'dry-run-off':setEnvFlag(inst, 'DRY_RUN', false);     return { ok: true, message: `Dry run off: it places real ${acct} trades.` };
    case 'stop':  { const r = await systemctl(inst, 'stop');  const s = await systemctl(inst, 'is-active'); return { ok: s !== 'active', message: s !== 'active' ? 'Stopped. Open trades keep their stops at IG.' : `Stop failed: ${r}` }; }
    case 'start': { const r = await systemctl(inst, 'start'); const s = await systemctl(inst, 'is-active'); return { ok: s === 'active', message: s === 'active' ? 'Started.' : `Start failed: ${r}` }; }
    case 'close-all': return closeAllOwn(inst);
    default: return { ok: false, message: `Unknown action ${action}` };
  }
}

// A Testbot deal closed from the IG tab's own Close button (2026-10-29):
// drop it from that copy's list and record it, so it isn't counted as a
// stop-out. Returns false if the deal isn't the Testbot's.
export function forgetMomentumDeal(dealId: string, reason: string, inst: MomentumInstance = 'demo'): boolean {
  const p = paths(inst);
  const own = readJson<Record<string, OwnDeal>>(p.own, {});
  const d = own[dealId];
  if (!d) return false;
  delete own[dealId];
  fs.writeFileSync(p.own, JSON.stringify(own, null, 1));
  fs.appendFileSync(p.trades, `${new Date().toISOString().slice(0, 19)}+00:00,CLOSE_UI,${d.market},${d.epic},${d.direction},${d.size},,,,,,ACCEPTED,${reason},${dealId}\n`);
  return true;
}
export function isMomentumDeal(dealId: string, inst: MomentumInstance = 'demo'): boolean {
  return dealId in readJson<Record<string, OwnDeal>>(paths(inst).own, {});
}

// Closes only the deals that copy recorded as its own, then removes them from
// its list so it doesn't count them as stop-outs.
async function closeAllOwn(inst: MomentumInstance): Promise<{ ok: boolean; message: string }> {
  const p = paths(inst);
  const own = readJson<Record<string, OwnDeal>>(p.own, {});
  const ids = Object.keys(own);
  if (!ids.length) return { ok: true, message: 'It has no open trades.' };
  setEnvFlag(inst, 'KILL_SWITCH', true);   // stop it reopening straight away
  const s = await igSession(inst);
  const open = new Set((await fetchFullPositions(s)).map(x => x.dealId));
  const done: string[] = [], failed: string[] = [];
  for (const id of ids) {
    const d = own[id];
    try {
      if (open.has(id)) await closePosition(s, id, d.direction, d.size);
      done.push(d.market);
      const cur = readJson<Record<string, OwnDeal>>(p.own, {});
      delete cur[id];
      fs.writeFileSync(p.own, JSON.stringify(cur, null, 1));
      fs.appendFileSync(p.trades, `${new Date().toISOString().slice(0, 19)}+00:00,CLOSE_UI,${d.market},${d.epic},${d.direction},${d.size},,,,,,ACCEPTED,closed from the website,${id}\n`);
    } catch (e) {
      failed.push(`${d.market}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: !failed.length, message: `Closed ${done.length} trade(s)${done.length ? ` (${done.join(', ')})` : ''} and paused it.${failed.length ? ` Failed: ${failed.join('; ')}` : ''}` };
}

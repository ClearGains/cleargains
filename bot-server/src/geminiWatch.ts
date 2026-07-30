import * as fs from 'fs';
import * as path from 'path';
import {
  authenticate, getSession, fetchFullPositions, closePosition, updatePositionLevels,
  type FullPosition, type IGSession,
} from './igApi';
import { resolveCredentials, addLog, type IgMode } from './igStrategyBot';
import { askGeminiPositionVerdict } from './gemini';

// ── Gemini position watch — for positions opened outside the strategy bot
// (manually via IG's own app, the Demo Trader panel, or anywhere else) that
// the user explicitly flags for Gemini to review periodically and close if
// it judges that's warranted. Independent of any running strategy — works
// whether or not the Donchian bot itself is active.

function watchFile(mode: IgMode): string {
  return path.join(__dirname, '..', `gemini-watch-${mode}.json`);
}

function loadWatch(mode: IgMode): Set<string> {
  try { return new Set(JSON.parse(fs.readFileSync(watchFile(mode), 'utf8')) as string[]); }
  catch { return new Set(); }
}

function saveWatch(mode: IgMode, ids: Set<string>): void {
  try { fs.writeFileSync(watchFile(mode), JSON.stringify([...ids]), 'utf8'); } catch {}
}

const watched = new Map<IgMode, Set<string>>([
  ['demo', loadWatch('demo')],
  ['live', loadWatch('live')],
]);

export function getWatchedDealIds(mode: IgMode): string[] {
  return [...(watched.get(mode) ?? new Set())];
}

export function isWatched(mode: IgMode, dealId: string): boolean {
  return watched.get(mode)?.has(dealId) ?? false;
}

export function addToWatch(mode: IgMode, dealId: string): void {
  const set = watched.get(mode)!;
  set.add(dealId);
  saveWatch(mode, set);
}

export function removeFromWatch(mode: IgMode, dealId: string): void {
  const set = watched.get(mode)!;
  set.delete(dealId);
  saveWatch(mode, set);
  lastReview.delete(dealId);
}

// Throttle — a position that hasn't moved meaningfully since its last actual
// Gemini call gets skipped rather than re-asked every single 15-min cycle
// for no new information. In-memory only (not persisted): worst case after
// a restart, every watched position gets one extra call it might not have
// strictly needed, which is a fine tradeoff against added persisted state.
const lastReview = new Map<string, { upl: number; at: number }>();
const MOVE_THRESHOLD_GBP = 3;          // re-ask once P&L has moved at least this much since the last call
const MAX_SILENCE_MS     = 45 * 60_000; // ...or at least this long has passed, even if flat

// Reuses the strategy bot's own session if one's already authenticated
// (same sessionKey pattern, 'igstrat:<mode>') rather than logging in twice —
// authenticates fresh only if no live session exists yet.
async function getOrAuthSession(mode: IgMode): Promise<IGSession | null> {
  const sessionKey = `igstrat:${mode}`;
  const existing = getSession(sessionKey);
  if (existing && Date.now() < existing.expiresAt - 2 * 60_000) return existing;

  const creds = resolveCredentials(mode);
  if (!creds.apiKey || !creds.username || !creds.password) return null;
  try {
    return await authenticate(creds.apiKey, creds.username, creds.password, creds.env, sessionKey);
  } catch {
    return null;
  }
}

async function reviewOne(mode: IgMode, session: IGSession, p: FullPosition): Promise<void> {
  const name = p.instrumentName;

  // Hard backstop, independent of Gemini's judgment — a watched position
  // must always have a real IG-side stop. If Gemini is down, rate-limited,
  // or just wrong, this is what actually bounds the loss, same 3%-of-price
  // fallback the strategy bot's own self-heal uses.
  if (p.stopLevel === undefined) {
    const fallbackDist = Math.max(1, p.level * 0.03);
    const fallbackStop = p.direction === 'BUY' ? p.level - fallbackDist : p.level + fallbackDist;
    try {
      await updatePositionLevels(session, p.dealId, fallbackStop, p.limitLevel ?? null);
      addLog(mode, 'info', name, `[Gemini watch] Attached missing stop (was naked) — ${fallbackStop.toFixed(2)}`);
    } catch (e) {
      addLog(mode, 'error', name, `[Gemini watch] 🚨 UNPROTECTED — failed to attach stop: ${e instanceof Error ? e.message : String(e)}. Monitor manually.`);
    }
  }

  const heldHours    = p.openedAt ? (Date.now() - new Date(p.openedAt).getTime()) / 3_600_000 : 0;
  const currentLevel = p.direction === 'BUY' ? p.bid : p.offer;

  const last  = lastReview.get(p.dealId);
  const moved = !last || Math.abs(p.upl - last.upl) >= MOVE_THRESHOLD_GBP;
  const stale = !last || (Date.now() - last.at) >= MAX_SILENCE_MS;
  if (!moved && !stale) return;  // nothing meaningful changed since the last actual call — skip it

  lastReview.set(p.dealId, { upl: p.upl, at: Date.now() });

  const verdict = await askGeminiPositionVerdict({
    instrumentName: name,
    direction:      p.direction,
    entryLevel:     p.level,
    currentLevel,
    uplGbp:         p.upl,
    heldHours,
    stopLevel:      p.stopLevel,
    limitLevel:     p.limitLevel,
  });

  addLog(mode, 'info', name, `[Gemini watch] ${verdict.action} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);

  if (verdict.action === 'CLOSE') {
    try {
      await closePosition(session, p.dealId, p.direction, p.size);
      addLog(mode, 'exit', name, `[Gemini watch] Closed — ${verdict.reason}`);
      removeFromWatch(mode, p.dealId);
    } catch (e) {
      addLog(mode, 'error', name, `[Gemini watch] Close failed, still watching: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function pollAll(): Promise<void> {
  for (const mode of ['demo', 'live'] as const) {
    const ids = getWatchedDealIds(mode);
    if (!ids.length) continue;

    const session = await getOrAuthSession(mode);
    if (!session) { addLog(mode, 'error', '—', '[Gemini watch] No IG session available — skipping this cycle'); continue; }

    let positions: FullPosition[];
    try {
      positions = await fetchFullPositions(session);
    } catch (e) {
      addLog(mode, 'error', '—', `[Gemini watch] Position fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    for (const dealId of ids) {
      const p = positions.find(pos => pos.dealId === dealId);
      if (!p) { removeFromWatch(mode, dealId); continue; }  // closed elsewhere already
      await reviewOne(mode, session, p);
    }
  }
}

const POLL_MS = 15 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startGeminiWatch(): void {
  if (timer) return;
  timer = setInterval(() => { void pollAll(); }, POLL_MS);
  void pollAll();
}

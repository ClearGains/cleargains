import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';
import { EPIC_TO_ALPACA } from './yahooFetch';

// ── Alpaca real-time news stream ─────────────────────────────────────────────
// Opt-in, off by default (2026-08-19) — persisted so a toggle survives a
// restart, and toggleable at runtime via the /alpaca-news-stream routes with
// no redeploy needed, per explicit request: build it, but make it trivial to
// turn off if it ever causes a problem on this VM (956MB RAM, a known-fragile
// box — see the swap-file/allowance-exhaustion incidents earlier this
// session). This is a background WebSocket connection with its own failure
// modes (bad reconnect loop, silent disconnect), so it stays fully inert
// unless explicitly switched on, and switching it off tears the connection
// down immediately rather than just stopping new reconnects.
//
// Doesn't feed the Gemini prompt directly — a real headline's actual text
// still comes from fetchAllHeadlines (Finnhub) inside geminiWatch.ts's own
// reviewOne, same as before. All this does is flag "something just happened
// for this symbol" so reviewOne's own throttle doesn't silently skip a
// review just because price hasn't moved yet — same bypass category as a
// sharp dip or a green-to-red reversal, not a new data source in its own
// right.

function enabledFile(): string {
  return path.join(__dirname, '..', 'alpaca-news-stream-enabled.json');
}
function loadEnabled(): boolean {
  try { return (JSON.parse(fs.readFileSync(enabledFile(), 'utf8')) as { enabled: boolean }).enabled; }
  catch { return false; } // default OFF
}
function saveEnabled(value: boolean): void {
  try { fs.writeFileSync(enabledFile(), JSON.stringify({ enabled: value }), 'utf8'); } catch {}
}

let enabled = loadEnabled();
export function isNewsStreamEnabled(): boolean {
  return enabled;
}

// Long enough to reliably survive to the next Position Watch poll (15min
// cycle) even if the news lands moments after one just ran, short enough
// that a months-old flag can't linger and force a pointless extra review.
const BREAKING_NEWS_TTL_MS = 30 * 60_000;
const breakingNews = new Map<string, number>(); // Alpaca symbol -> expiresAt

export function hasBreakingNews(alpacaSymbol: string): boolean {
  const exp = breakingNews.get(alpacaSymbol);
  if (exp === undefined) return false;
  if (Date.now() > exp) { breakingNews.delete(alpacaSymbol); return false; }
  return true;
}

// Only subscribe to symbols actually reachable by something this account
// trades — no reason to pay attention (or add noise) to headlines for
// instruments nothing here ever touches.
const RELEVANT_SYMBOLS = [...new Set(Object.values(EPIC_TO_ALPACA))];

let socket: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let intentionallyClosed = false;

function connect(): void {
  if (!enabled) return;
  const key    = process.env.ALPACA_API_KEY    ?? process.env.ALPACA_PAPER_KEY;
  const secret = process.env.ALPACA_SECRET_KEY ?? process.env.ALPACA_PAPER_SECRET;
  if (!key || !secret) {
    console.warn('[alpacaNewsStream] No Alpaca credentials configured — staying off');
    return;
  }

  intentionallyClosed = false;
  socket = new WebSocket('wss://stream.data.alpaca.markets/v1beta1/news');

  socket.on('open', () => {
    reconnectAttempt = 0;
    socket?.send(JSON.stringify({ action: 'auth', key, secret }));
  });

  socket.on('message', raw => {
    let msgs: Array<Record<string, unknown>>;
    try { msgs = JSON.parse(raw.toString()) as Array<Record<string, unknown>>; }
    catch { return; }
    for (const msg of msgs) {
      if (msg.T === 'success' && msg.msg === 'authenticated') {
        socket?.send(JSON.stringify({ action: 'subscribe', news: RELEVANT_SYMBOLS }));
        console.log(`[alpacaNewsStream] Authenticated — subscribed to ${RELEVANT_SYMBOLS.length} symbols`);
      } else if (msg.T === 'n') {
        const symbols  = (msg.symbols as string[] | undefined) ?? [];
        const headline = msg.headline as string | undefined;
        for (const sym of symbols) {
          if (!RELEVANT_SYMBOLS.includes(sym)) continue;
          breakingNews.set(sym, Date.now() + BREAKING_NEWS_TTL_MS);
          console.log(`[alpacaNewsStream] ${sym}: ${headline ?? '(no headline text)'}`);
        }
      } else if (msg.T === 'error') {
        console.warn('[alpacaNewsStream] Stream error:', msg.msg);
      }
    }
  });

  socket.on('close', () => {
    if (intentionallyClosed) return;
    scheduleReconnect();
  });

  socket.on('error', (err: Error) => {
    console.warn('[alpacaNewsStream] Connection error:', err.message);
  });
}

// Capped, growing backoff — never hammers Alpaca on a persistent outage,
// never gives up permanently either.
function scheduleReconnect(): void {
  if (!enabled) return;
  reconnectAttempt++;
  const delay = Math.min(30_000 * reconnectAttempt, 5 * 60_000);
  reconnectTimer = setTimeout(connect, delay);
}

function disconnect(): void {
  intentionallyClosed = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempt = 0;
  if (socket) { socket.close(); socket = null; }
}

export function setNewsStreamEnabled(next: boolean): void {
  enabled = next;
  saveEnabled(next);
  if (next) connect(); else disconnect();
}

// Called once at server boot — only actually opens a connection if the
// persisted toggle was already on from a previous session.
export function startAlpacaNewsStream(): void {
  if (enabled) connect();
}

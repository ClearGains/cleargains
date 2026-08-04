import * as fs from 'fs';
import * as path from 'path';
import {
  authenticate, getSession, fetchFullPositions, closePosition, updatePositionLevels, fetchCandleHistory,
  type FullPosition, type IGSession, type CandleBar,
} from './igApi';
import { resolveCredentials, addLog, type IgMode } from './igStrategyBot';
import { askGeminiPositionVerdict } from './gemini';
import { EPIC_TO_ALPACA, EPIC_TO_YAHOO, fetchBarsWithFallback } from './yahooFetch';
import { fetchCompanyHeadlines } from './newsFetch';
import { isNYSEOpen, type AlpacaBar } from './alpacaApi';

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
  peakUpl.delete(dealId);
}

// Throttle — a position that hasn't moved meaningfully since its last actual
// Gemini call gets skipped rather than re-asked every single 15-min cycle
// for no new information. In-memory only (not persisted): worst case after
// a restart, every watched position gets one extra call it might not have
// strictly needed, which is a fine tradeoff against added persisted state.
// Also doubles as the confidence tracker for gemini_opinion's position-
// rotation logic — "how convinced are we in holding this right now" is the
// same information this throttle already needs, just also read externally.
const lastReview = new Map<string, { upl: number; at: number; confidence: number }>();
const MOVE_THRESHOLD_GBP = 3;          // re-ask once P&L has moved at least this much since the last call
const MAX_SILENCE_MS     = 45 * 60_000; // ...or at least this long has passed, even if flat

// High-water mark of unrealized P&L per watched position, updated every poll
// regardless of throttle — lets a swing from meaningfully-in-profit to
// in-loss be recognized as a distinct "reversedToRed" risk signal (see
// reviewOne), not just folded into the ordinary move-threshold check.
// In-memory only, same tradeoff as lastReview: worst case after a restart is
// one missed reversal detection on an already-reversed position, not a
// silent failure to protect it (the hard stop still applies regardless).
const peakUpl = new Map<string, number>();

// Seeds a freshly-opened gemini_opinion position with its entry confidence,
// so there's an immediate baseline to compare against rather than an
// arbitrary default until the first real Position Watch review lands. `at:
// 0` guarantees that first review isn't throttled away — it always runs on
// the very next watch cycle regardless of how little the position has
// moved, so the baseline gets refreshed with real judgment quickly.
export function recordEntryConfidence(dealId: string, confidence: number): void {
  if (!lastReview.has(dealId)) lastReview.set(dealId, { upl: 0, at: 0, confidence });
}

// Weakest-conviction currently-held position, for gemini_opinion's swap
// check — a dealId never yet reviewed defaults to 60 (the same bar an
// entry itself has to clear), a neutral assumption rather than treating an
// unreviewed position as automatically weak or automatically safe.
export function getWeakestConfidence(dealIds: string[]): { dealId: string; confidence: number } | null {
  if (!dealIds.length) return null;
  let weakest: { dealId: string; confidence: number } | null = null;
  for (const dealId of dealIds) {
    const confidence = lastReview.get(dealId)?.confidence ?? 60;
    if (!weakest || confidence < weakest.confidence) weakest = { dealId, confidence };
  }
  return weakest;
}

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

function igBarToAlpacaBar(b: CandleBar): AlpacaBar {
  return {
    t: b.snapshotTime,
    o: b.openPrice.mid  ?? b.openPrice.bid,
    h: b.highPrice.mid  ?? b.highPrice.bid,
    l: b.lowPrice.mid   ?? b.lowPrice.bid,
    c: b.closePrice.mid ?? b.closePrice.bid,
    v: 0,
  };
}

// Alpaca goes quiet outside NYSE hours (no new bars once the exchange
// closes — expected, not broken), which leaves US-stock positions with no
// day-change/sharp-dip context for most of the day. IG prices these CFDs
// continuously even when the underlying exchange is shut, so its own candle
// history is genuinely fresher during that window — reused here as a
// fallback, always via the shared demo session (same pattern as the FX
// scalper's data feed) specifically so this never touches live's own
// allowance, which the rest of this account's traffic already leans on.
async function fetchIgOffHoursBars(epic: string): Promise<AlpacaBar[] | null> {
  const key = 'igstrat:demo';
  let session = getSession(key);
  if (!session || Date.now() >= session.expiresAt - 2 * 60_000) {
    const creds = resolveCredentials('demo');
    if (!creds.apiKey) return null;
    try { session = await authenticate(creds.apiKey, creds.username, creds.password, creds.env, key); }
    catch { return null; }
  }
  try {
    const bars = await fetchCandleHistory(session, epic, 'HOUR', 48);
    return bars.length ? bars.map(igBarToAlpacaBar) : null;
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

  const last = lastReview.get(p.dealId);

  // High-water mark of this position's P&L, updated every poll regardless of
  // throttle — a swing from meaningfully-in-profit to in-loss is a distinct
  // risk signal (a real reversal, not just "P&L is down") worth flagging to
  // Gemini even when news hasn't caught up to explain it yet.
  const priorPeak = peakUpl.get(p.dealId) ?? p.upl;
  const peak = Math.max(priorPeak, p.upl);
  peakUpl.set(p.dealId, peak);
  const GREEN_TO_RED_THRESHOLD_GBP = 2; // "meaningfully" in profit at some point — not just noise around zero
  const reversedToRed = peak >= GREEN_TO_RED_THRESHOLD_GBP && p.upl < 0;
  // Edge-triggered version for the throttle bypass below — reversedToRed
  // alone would force a fresh Gemini call every single poll for as long as
  // the position stays red after ever having been green, which could burn
  // through the daily call cap fast on a position left to sit. Only force
  // the bypass the first time this shows up since Gemini's last actual look
  // (i.e. it was still green, or unreviewed, as of the last real call) —
  // once Gemini has seen it, the ordinary £3-move / 45-min throttle governs
  // follow-up calls same as anything else.
  const justTurnedRed = reversedToRed && (!last || last.upl >= 0);

  // Best-effort — [] if no Alpaca ticker mapping or Finnhub unavailable,
  // same pattern as the entry-confirmation flow. Lets Gemini weigh whether
  // today's news/volatility could reverse this position, not just P&L and
  // hold time alone. Headlines specifically need a real company ticker
  // (Finnhub's company-news endpoint) — FX/indices have no such thing, so
  // this stays Alpaca-only regardless of what bars are available below.
  const ticker = EPIC_TO_ALPACA[p.epic];

  // Bars, by contrast, are available far more broadly — EPIC_TO_YAHOO covers
  // the full IG_EPICS universe (FX, indices, UK stocks included), not just
  // Alpaca's US-shares-only set. Gating this on the Alpaca ticker alone was
  // silently leaving every FX (and index/UK-stock) position out of the
  // sharp-dip and day-change checks below even though free bar data for them
  // was available the whole time — fetchBarsWithFallback already falls
  // through to Yahoo internally, this just stops refusing to call it.
  const hasBarSource = ticker !== undefined || p.epic in EPIC_TO_YAHOO;

  // Fetched every poll (not just when the throttle would otherwise allow a
  // real call) so a sudden sharp dip against the position can be detected
  // promptly rather than waiting on the ordinary £3-move / 45-min throttle —
  // Alpaca/Yahoo bars are free, unlike the Gemini call itself below, which
  // still respects the throttle (and the daily cap) as before.
  let dayChangePercent: number | undefined;
  let sharpDipPercent:  number | undefined;
  if (hasBarSource) {
    try {
      let bars = await fetchBarsWithFallback(p.epic, '5d', { alpacaTimeframe: '1Hour', yahooInterval: '1h' });

      // Alpaca-covered US stocks go quiet the moment NYSE closes — the bars
      // above are then correctly "yesterday's close", not broken, but stale
      // for review purposes. IG's own price for these keeps moving 24h, so
      // its candle history is a genuinely fresher source specifically for
      // this window — try it, and use it in place of Alpaca's frozen bars
      // if it comes back with something newer. Never touches live's own
      // allowance (always the shared demo session — see fetchIgOffHoursBars).
      if (ticker !== undefined && !isNYSEOpen()) {
        const igBars = await fetchIgOffHoursBars(p.epic);
        const igIsNewer = igBars?.length && (!bars?.length
          || new Date(igBars[igBars.length - 1].t).getTime() > new Date(bars[bars.length - 1].t).getTime());
        if (igIsNewer) bars = igBars;
      }

      // fetchBarsWithFallback only applies its known ×100 shares scaling to
      // Alpaca-covered epics — everything else it can now reach through this
      // wider gate (FX, indices, UK stocks, all via Yahoo) comes back raw,
      // and there's no one common ratio to IG's own quote the way shares'
      // confirmed ×100 works. Confirmed live: IG quotes GBP/USD at ~13425
      // vs Yahoo's raw ~1.3425 — a ×10000 ratio, not ×100, and not
      // necessarily uniform across every pair either (JPY crosses use a
      // different pip convention). Rather than hardcode a guessed factor
      // per instrument, derive it from the one already-trusted reference
      // point available: IG's own live currentLevel against Yahoo's most
      // recent close, taken at essentially the same moment.
      if (bars?.length && ticker === undefined) {
        const lastRaw = bars[bars.length - 1].c;
        if (lastRaw > 0 && currentLevel > 0) {
          const scale = currentLevel / lastRaw;
          bars = bars.map(b => ({ ...b, o: b.o * scale, h: b.h * scale, l: b.l * scale, c: b.c * scale }));
        } else {
          bars = null; // can't safely scale — proceed without day-change/sharp-dip context rather than risk garbage numbers
        }
      }

      if (bars?.length) {
        const latestBarAgeMs = Date.now() - new Date(bars[bars.length - 1].t).getTime();
        // 20h, not 6h — confirmed live 6h was tripping on completely
        // ordinary overnight closure (NYSE closed ~17.5h, LSE ~15.5h
        // between sessions), losing day-change/sharp-dip context for most
        // of every day rather than catching an actually-stuck feed. This
        // still comfortably catches the case it was built for: Alpaca's
        // paper-account bars for INTC were once stuck ~3 *weeks* stale
        // despite the fetch succeeding with no error, and the old fallback
        // here (oldest bar in the whole 5-day window when nothing matched
        // "today") produced a nonsense "-27% today" figure that got a
        // genuinely fine position closed for a fabricated reason. No
        // fallback to an older bar anymore — if the feed's stale, or
        // nothing matches today, this just stays unset. No day-change
        // context beats a wrong one.
        const STALE_DATA_MS  = 20 * 60 * 60_000;
        if (latestBarAgeMs <= STALE_DATA_MS) {
          const todayUtc   = new Date().toISOString().slice(0, 10);
          const todaysBars = bars.filter(b => b.t.slice(0, 10) === todayUtc);
          const dayOpen     = todaysBars[0]?.o;
          if (dayOpen) dayChangePercent = ((currentLevel - dayOpen) / dayOpen) * 100;

          // Adverse move against the position's direction within just the
          // last few bars — distinct from dayChangePercent, since a position
          // can look unremarkable on the day as a whole while a fast reversal
          // is happening right now within it.
          const RECENT_BARS = Math.min(4, bars.length);
          const window      = bars.slice(-RECENT_BARS);
          if (p.direction === 'BUY') {
            const recentHigh = Math.max(...window.map(b => b.h));
            if (recentHigh > 0) sharpDipPercent = ((recentHigh - currentLevel) / recentHigh) * 100;
          } else {
            const recentLow = Math.min(...window.map(b => b.l));
            if (recentLow > 0) sharpDipPercent = ((currentLevel - recentLow) / recentLow) * 100;
          }
        }
      }
    } catch { /* best-effort — proceed without it */ }
  }

  // FX naturally oscillates more within what's still "normal" than a stock
  // does — a same-size move that would be a real warning sign for a stock
  // (news-driven, directional) is often just ordinary short-term noise for
  // a currency pair. Give FX more room before treating a move as alarming.
  const isFx = p.epic.startsWith('CS.');
  const SHARP_DIP_THRESHOLD_PCT = isFx ? 2.5 : 1.5;
  const sharpDip = sharpDipPercent !== undefined && sharpDipPercent >= SHARP_DIP_THRESHOLD_PCT;

  const moved = !last || Math.abs(p.upl - last.upl) >= MOVE_THRESHOLD_GBP;
  const stale = !last || (Date.now() - last.at) >= MAX_SILENCE_MS;
  // A sharp dip or a just-turned-red reversal always gets a fresh Gemini call
  // this cycle even if the ordinary throttle would otherwise skip it — these
  // are exactly the situations where sitting on stale judgment for up to
  // another 45 minutes is the wrong tradeoff.
  if (!moved && !stale && !sharpDip && !justTurnedRed) return;

  const headlines = ticker ? await fetchCompanyHeadlines(ticker, 5, name) : [];

  const verdict = await askGeminiPositionVerdict({
    instrumentName: name,
    headlines,
    direction:      p.direction,
    entryLevel:     p.level,
    currentLevel,
    uplGbp:         p.upl,
    heldHours,
    stopLevel:      p.stopLevel,
    limitLevel:     p.limitLevel,
    dayChangePercent,
    sharpDipPercent,
    reversedToRed,
    isFx,
  });

  addLog(mode, 'info', name, `[Gemini watch] ${verdict.action} ${verdict.confidence}% — ${verdict.reason} (${verdict.engine})`);

  // Only update the tracked confidence on a real verdict — a Gemini outage
  // (passthrough) shouldn't silently make a healthy position look weak in
  // the rotation comparison, so it keeps whatever the last real reading was.
  lastReview.set(p.dealId, {
    upl: p.upl, at: Date.now(),
    confidence: verdict.engine === 'gemini' ? verdict.confidence : (last?.confidence ?? 60),
  });

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

// ── Meme coin hype bot — paper trading only ─────────────────────────────────
// Built 2026-09-05 per explicit request: trade brand-new, social-hype-driven
// Solana tokens (pump.fun-style launches), starting paper-only since there's
// no synthetic demo mode anywhere for this — the "market" is a real
// on-chain liquidity pool, not a broker's simulated order book. Every
// simulated fill (entry AND exit) goes through a live Jupiter quote for the
// exact size involved — never a reference/last-trade price — so a dead or
// draining pool shows up here exactly as it would in reality: a failed
// quote, not an invented price. See jupiterApi.ts's own comment for why
// this matters; it's the whole point of building this rather than just
// trusting DexScreener's displayed price.
//
// No wallet, no live mode, no real transactions anywhere in this file —
// paper only, by design, until this has run long enough to be trusted.

import * as fs from 'fs';
import * as path from 'path';
import { getBoostedSolanaTokens, getTokenPairs, passesOrganicMomentumFilter, type DexPair } from './dexscreenerApi';
import { getQuote, solToLamports, lamportsToSol, WSOL_MINT } from './jupiterApi';
import { checkTokenSafety } from './rugSafety';
import { getHypeScore } from './lunarcrushApi';
import { getMentionCount } from './redditApi';
import { recordJournalEvent } from './tradeJournal';

export type Mode = 'paper'; // live intentionally not supported yet — see header comment

const STRATEGY = 'meme_coin_hype';

// ── Tunables ─────────────────────────────────────────────────────────────
// Scaled up 2026-09-06 per explicit request — the initial 10 SOL (~£/$~1,000)
// bankroll was only ever meant to prove the pipeline works, not to answer
// "is this worth running on real money." 193 SOL (~$20,000 @ ~$104/SOL at
// the time this was set) with the SAME 5% per-trade ratio as before (was
// 0.5/10) is what actually stress-tests that question: a real $20k-scale
// position size (~$1,000/trade) against these pools' real depth is exactly
// the thing MAX_ENTRY_PRICE_IMPACT_PCT below is there to catch — if most
// candidates start failing that check at this size, that itself is the
// answer (these pools can't absorb real money, however good the signal
// is). MAX_POSITIONS raised too, purely to accumulate a meaningful sample
// of trades faster, not because the risk profile changed.
const STARTING_BALANCE_SOL     = 193;
const POSITION_SIZE_SOL        = 9.5;   // ~5% of bankroll, same ratio as the original 10 SOL test run
const MAX_POSITIONS            = 5;
const ENTRY_SLIPPAGE_BPS       = 300;   // 3% — wide enough for a young pool, still a real bound
const MAX_ENTRY_PRICE_IMPACT_PCT = 5;   // a signal that only "works" at a size the real pool can't absorb isn't a real signal
const EXIT_SLIPPAGE_BPS        = 500;   // wider on the way out — getting out matters more than the exact price
// Floor-trail — same shape as the IG spread-bet/options rebuilds the same
// week (geminiWatch.ts, igOptionsBot.ts): once a position clears this real
// gain, that floor is protected and it runs completely free above it, only
// closing on a retrace back down to the floor. Set far higher than the
// stock/options equivalents (10-30%) because meme coin swings of that size
// are ordinary noise, not a real move worth protecting.
const PROFIT_LOCK_FLOOR_PCT    = 50;
const MAX_HOLD_HOURS           = 48;   // a token that hasn't gone anywhere in 2 days isn't the hype play it looked like
const HYPE_MIN_GALAXY_SCORE    = 60;   // only enforced when LunarCrush is actually configured — see entry logic
// A sell quote that fails outright, or clears only at a catastrophic price
// impact, this many consecutive fast-poll checks in a row is treated as a
// real rug (liquidity gone), not a blip — one bad poll could just be a
// transient RPC/Jupiter hiccup.
const RUG_CONFIRM_STRIKES      = 2;
const RUG_PRICE_IMPACT_PCT     = 40;

const FAST_POLL_MS = 20_000;   // exits — these tokens move in minutes, not the 15-30min cadence other bots use
const SCAN_POLL_MS = 90_000;   // entries/discovery

export type TrackedPosition = {
  mint: string; symbol: string; pairAddress: string; chainId: string;
  costSol: number;        // what was paid, in SOL
  qtyRaw: string;         // raw base-unit token amount held (string — can exceed Number precision)
  enteredAt: number;
  peakPlPct: number;
  rugStrikes: number;
  entryReason: string;
};

type LogEntry = { id: string; ts: string; type: 'info' | 'enter' | 'exit' | 'wait' | 'error'; symbol: string; msg: string };

type BotState = {
  running: boolean;
  balanceSol: number;
  tracked: Record<string, TrackedPosition>; // keyed by mint
  log: LogEntry[];
  scanTimer: ReturnType<typeof setTimeout> | null;
  exitTimer: ReturnType<typeof setTimeout> | null;
  nextScanMs: number | null;
  lastScanTs: string | null;
};

const state: BotState = {
  running: false, balanceSol: STARTING_BALANCE_SOL, tracked: {}, log: [],
  scanTimer: null, exitTimer: null, nextScanMs: null, lastScanTs: null,
};

function stateFile(): string { return path.join(__dirname, '..', 'meme-coin-state.json'); }
function loadState(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as { balanceSol: number; tracked: Record<string, TrackedPosition> };
    state.balanceSol = raw.balanceSol;
    state.tracked = raw.tracked;
  } catch { /* fresh start */ }
}
function saveState(): void {
  try { fs.writeFileSync(stateFile(), JSON.stringify({ balanceSol: state.balanceSol, tracked: state.tracked }), 'utf8'); } catch {}
}
loadState();

function runningFlagFile(): string { return path.join(__dirname, '..', 'meme-coin-running.json'); }
export function wasMemeCoinBotRunning(): boolean {
  try { return (JSON.parse(fs.readFileSync(runningFlagFile(), 'utf8')) as { running: boolean }).running; }
  catch { return false; }
}
function saveRunningFlag(running: boolean): void {
  try { fs.writeFileSync(runningFlagFile(), JSON.stringify({ running }), 'utf8'); } catch {}
}

function addLog(type: LogEntry['type'], symbol: string, msg: string): void {
  const entry: LogEntry = { id: Math.random().toString(36).slice(2, 9), ts: new Date().toLocaleTimeString('en-GB', { hour12: false }), type, symbol, msg };
  state.log.unshift(entry);
  if (state.log.length > 300) state.log.length = 300;
  console.log(`[meme-coin] [${type.toUpperCase()}] [${symbol}] ${msg}`);
}

// ── Entry scan ───────────────────────────────────────────────────────────
async function scan(): Promise<void> {
  if (!state.running) return;
  state.lastScanTs = new Date().toISOString();

  if (Object.keys(state.tracked).length >= MAX_POSITIONS) {
    addLog('wait', '—', `At max positions (${MAX_POSITIONS}) — skipping scan`);
  } else if (state.balanceSol < POSITION_SIZE_SOL) {
    addLog('wait', '—', `Paper balance ${state.balanceSol.toFixed(3)} SOL below position size — skipping scan`);
  } else {
    try {
      const seeds = await getBoostedSolanaTokens();
      for (const seed of seeds) {
        if (Object.keys(state.tracked).length >= MAX_POSITIONS) break;
        if (state.tracked[seed.tokenAddress]) continue; // already held

        const pairs = await getTokenPairs('solana', seed.tokenAddress);
        if (!pairs.length) continue;
        const pair = pairs.reduce((best, p) => (p.volume?.h1 ?? 0) > (best.volume?.h1 ?? 0) ? p : best, pairs[0]);
        if (!passesOrganicMomentumFilter(pair)) continue;

        await evaluateCandidate(pair);
      }
    } catch (e) {
      addLog('error', '—', `Scan failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (state.running) {
    state.nextScanMs = Date.now() + SCAN_POLL_MS;
    state.scanTimer = setTimeout(() => { void scan(); }, SCAN_POLL_MS);
  }
}

async function evaluateCandidate(pair: DexPair): Promise<void> {
  const symbol = pair.baseToken.symbol;
  const mint = pair.baseToken.address;

  const safety = await checkTokenSafety(mint);
  if (!safety.safe) {
    addLog('wait', symbol, `Safety veto — ${safety.reasons.join('; ')}`);
    return;
  }

  const hype = await getHypeScore(symbol);
  if (hype.source === 'lunarcrush' && hype.score !== null && hype.score < HYPE_MIN_GALAXY_SCORE) {
    addLog('wait', symbol, `LunarCrush galaxy score ${hype.score} below ${HYPE_MIN_GALAXY_SCORE} — skipping`);
    return;
  }

  // Reddit — supplementary only, never a gate on its own (see redditApi.ts's
  // own comment on why: meme coin culture lives on Twitter/Telegram far more
  // than Reddit, so a low/zero count here isn't meaningful evidence against
  // a candidate that already cleared the real on-chain momentum filter).
  const reddit = await getMentionCount(symbol);

  const quote = await getQuote(WSOL_MINT, mint, solToLamports(POSITION_SIZE_SOL), ENTRY_SLIPPAGE_BPS);
  if (!quote) {
    addLog('wait', symbol, 'No Jupiter route for entry size — pool too illiquid, skipping');
    return;
  }
  if (quote.priceImpactPct > MAX_ENTRY_PRICE_IMPACT_PCT) {
    addLog('wait', symbol, `Entry price impact ${quote.priceImpactPct.toFixed(1)}% exceeds ${MAX_ENTRY_PRICE_IMPACT_PCT}% — pool can't absorb this size, skipping`);
    return;
  }

  const hypeNote = hype.source === 'lunarcrush' ? `LunarCrush ${hype.score}` : `DexScreener volume/txns (no LunarCrush key)`;
  const redditNote = reddit.source === 'reddit' ? `, Reddit ${reddit.count} mentions/24h` : '';
  const reason = `Organic momentum (vol/h1 $${(pair.volume?.h1 ?? 0).toFixed(0)}, ${(pair.txns?.h1?.buys ?? 0) + (pair.txns?.h1?.sells ?? 0)} txns/h1) + safety clear + ${hypeNote}${redditNote}`;

  state.tracked[mint] = {
    mint, symbol, pairAddress: pair.pairAddress, chainId: pair.chainId,
    costSol: POSITION_SIZE_SOL, qtyRaw: quote.outAmount,
    enteredAt: Date.now(), peakPlPct: 0, rugStrikes: 0, entryReason: reason,
  };
  state.balanceSol -= POSITION_SIZE_SOL;
  saveState();

  recordJournalEvent({
    mode: 'meme-paper', event: 'entry', symbol, strategy: STRATEGY,
    side: 'long', qty: Number(quote.outAmount), price: POSITION_SIZE_SOL / Number(quote.outAmount),
    reason, confidence: hype.score ?? 50,
  });
  addLog('enter', symbol, `BUY ${POSITION_SIZE_SOL} SOL — ${reason} — impact ${quote.priceImpactPct.toFixed(2)}%`);
}

// ── Exit monitor — fast cadence, real quotes only ───────────────────────
async function monitorExits(): Promise<void> {
  if (!state.running) return;

  for (const [mint, tr] of Object.entries(state.tracked)) {
    try {
      const sellQuote = await getQuote(mint, WSOL_MINT, tr.qtyRaw, EXIT_SLIPPAGE_BPS);

      if (!sellQuote || sellQuote.priceImpactPct > RUG_PRICE_IMPACT_PCT) {
        tr.rugStrikes += 1;
        const why = !sellQuote ? 'no route' : `${sellQuote.priceImpactPct.toFixed(0)}% price impact`;
        addLog('error', tr.symbol, `⚠️ Liquidity check failed (${why}) — strike ${tr.rugStrikes}/${RUG_CONFIRM_STRIKES}`);
        if (tr.rugStrikes >= RUG_CONFIRM_STRIKES) {
          // Confirmed — liquidity is genuinely gone, not a transient hiccup.
          // No real sale is possible, so this is recorded honestly as a
          // total loss rather than inventing a phantom exit price — the
          // whole point of gating every fill through a live quote.
          const reason = `Rug confirmed — no sellable liquidity after ${tr.rugStrikes} consecutive checks (last: ${why})`;
          recordJournalEvent({
            mode: 'meme-paper', event: 'exit', symbol: tr.symbol, strategy: STRATEGY,
            side: 'long', qty: Number(tr.qtyRaw), price: 0,
            reason, plUsd: -tr.costSol, plPct: -100,
          });
          addLog('exit', tr.symbol, `${reason} — total loss of ${tr.costSol} SOL`);
          delete state.tracked[mint];
          saveState();
        }
        continue;
      }
      if (tr.rugStrikes > 0) { tr.rugStrikes = 0; saveState(); }

      const currentValueSol = lamportsToSol(sellQuote.outAmount);
      const plPct = tr.costSol > 0 ? ((currentValueSol - tr.costSol) / tr.costSol) * 100 : 0;
      if (plPct > tr.peakPlPct) { tr.peakPlPct = plPct; saveState(); }

      const heldHours = (Date.now() - tr.enteredAt) / 3_600_000;
      let closeReason: string | null = null;
      if (heldHours >= MAX_HOLD_HOURS) {
        closeReason = `Max hold reached (${heldHours.toFixed(1)}h) with no real move — freeing capital`;
      } else if (tr.peakPlPct >= PROFIT_LOCK_FLOOR_PCT && plPct <= PROFIT_LOCK_FLOOR_PCT) {
        closeReason = `Retraced from +${tr.peakPlPct.toFixed(0)}% peak back down to the ${PROFIT_LOCK_FLOOR_PCT}% floor — banking +${plPct.toFixed(0)}%`;
      }

      if (!closeReason) {
        addLog('wait', tr.symbol, `Holding — ${plPct >= 0 ? '+' : ''}${plPct.toFixed(0)}% (peak +${tr.peakPlPct.toFixed(0)}%), ${heldHours.toFixed(1)}h held`);
        continue;
      }

      const plSol = currentValueSol - tr.costSol;
      state.balanceSol += currentValueSol;
      recordJournalEvent({
        mode: 'meme-paper', event: 'exit', symbol: tr.symbol, strategy: STRATEGY,
        side: 'long', qty: Number(tr.qtyRaw), price: currentValueSol / Number(tr.qtyRaw),
        reason: closeReason, plUsd: plSol, plPct,
      });
      addLog('exit', tr.symbol, `${closeReason} (${plSol >= 0 ? '+' : ''}${plSol.toFixed(3)} SOL)`);
      delete state.tracked[mint];
      saveState();
    } catch (e) {
      addLog('error', tr.symbol, `Exit check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (state.running) state.exitTimer = setTimeout(() => { void monitorExits(); }, FAST_POLL_MS);
}

// ── Public API ───────────────────────────────────────────────────────────
export function startMemeCoinBot(): { ok: boolean; error?: string } {
  if (state.scanTimer) clearTimeout(state.scanTimer);
  if (state.exitTimer) clearTimeout(state.exitTimer);
  state.running = true;
  saveRunningFlag(true);
  addLog('info', '—', `Meme coin hype bot started (PAPER ONLY) — ${POSITION_SIZE_SOL} SOL/position, max ${MAX_POSITIONS}, ${state.balanceSol.toFixed(2)} SOL balance`);
  setTimeout(() => { void scan(); }, 5_000);
  setTimeout(() => { void monitorExits(); }, 8_000);
  return { ok: true };
}

export function stopMemeCoinBot(): { ok: boolean } {
  state.running = false;
  saveRunningFlag(false);
  if (state.scanTimer) { clearTimeout(state.scanTimer); state.scanTimer = null; }
  if (state.exitTimer) { clearTimeout(state.exitTimer); state.exitTimer = null; }
  addLog('info', '—', 'Meme coin hype bot stopped');
  return { ok: true };
}

export function getMemeCoinBotStatus(): {
  running: boolean; balanceSol: number; tracked: Record<string, TrackedPosition>;
  log: LogEntry[]; nextScanMs: number | null; lastScanTs: string | null;
  lunarcrushConfigured: boolean; redditConfigured: boolean;
} {
  return {
    running: state.running, balanceSol: state.balanceSol, tracked: state.tracked,
    log: state.log.slice(0, 100), nextScanMs: state.nextScanMs, lastScanTs: state.lastScanTs,
    lunarcrushConfigured: !!process.env.LUNARCRUSH_API_KEY,
    redditConfigured: !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET),
  };
}

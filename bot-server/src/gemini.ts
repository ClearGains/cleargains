import * as fs from 'fs';
import * as path from 'path';

// A large API like this load-balances requests across many backend
// instances behind the scenes — a client never sees or chooses which one it
// lands on. Confirmed live: failures come back as a mix of our own timeout
// and Google's own 503, with no consistent pattern by instrument, while an
// identical call moments later often succeeds — the classic signature of
// hitting one degraded backend instance among many healthy ones, not a
// genuine outage or anything wrong with the request itself. One retry after
// a short delay routes to a fresh connection, likely a different instance,
// and often just works. Doesn't reserve a second call against the daily cap
// — this is still one logical attempt at an answer, not two.
async function fetchGeminiWithRetry(url: string, options: RequestInit): Promise<Response> {
  // AbortSignal.timeout() starts counting at creation, not per fetch() call —
  // reusing the caller's signal on a retry would mean a request that failed
  // *because* it timed out retries with an already-expired signal, aborting
  // instantly and defeating the retry entirely for the single most common
  // failure case. Each attempt gets its own fresh 20s window instead.
  const attempt = () => fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  try {
    const res = await attempt();
    if (res.ok || res.status < 500) return res; // success, or a real error (bad request, auth) — retrying won't help
    await new Promise(r => setTimeout(r, 1_500));
    return await attempt();
  } catch {
    await new Promise(r => setTimeout(r, 1_500));
    return await attempt();
  }
}

// ── Hard daily call cap ──────────────────────────────────────────────────────
// Google Cloud billing budgets are alert-only by default, not an automatic
// stop — this is the real backstop against runaway cost, enforced locally
// and instantly rather than depending on a billing alert's latency. Shared
// across every Gemini call site (entry verdicts + position watch) and both
// demo/live, since they all bill against the one project/key. Originally set
// to 150/day based on a single-bot estimate (~25-40/day for VWAP); confirmed
// live on 2026-07-31 that with the stock bot (entry checks + position watch)
// and the FX scalper all running concurrently, combined usage paces at
// ~190-200/day, exhausting 150 by mid-afternoon and leaving live positions
// on stop-loss-only for the rest of the day. Raised to 300/day, but
// confirmed live on 2026-08-03 that's still not enough — 300 was exhausted
// by 21:07 UTC (~21h into the UTC day), meaning the last ~3h ran on
// stop-loss-only again. That pace works out to ~343 calls for a full 24h
// day, which was itself partly inflated by gemini_opinion scanning indices
// (since removed — indices now belong exclusively to the FX swing bot) and
// a 30-min recommendation re-check that also called Gemini (since removed
// too), so real usage going forward should run well under that peak. Set to
// 1000/day, not another incremental bump — checked Google's own AI Studio
// usage dashboard directly: the actual account ceiling is 10,000
// requests/day, and our worst day ever only hit ~380, so this is a one-time
// generous ceiling meant to stop needing revisiting, not a number to keep
// nudging up. Gemini Flash is cheap enough (low pence/day even at this
// volume) that the real risk was always under-provisioning AI review on
// live positions, not overspend.
const GEMINI_DAILY_CAP = 1000;
const CALL_COUNT_FILE  = path.join(__dirname, '..', 'gemini-daily-calls.json');

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

type CallCountState = { date: string; count: number };

function loadCallState(): CallCountState {
  try {
    const parsed = JSON.parse(fs.readFileSync(CALL_COUNT_FILE, 'utf8')) as CallCountState;
    return parsed.date === todayUtc() ? parsed : { date: todayUtc(), count: 0 };
  } catch {
    return { date: todayUtc(), count: 0 };
  }
}

let callState = loadCallState();

// Call before every actual Gemini fetch (not before the free rules-only
// paths) — returns false once today's cap is hit, callers fall back to
// their existing passthrough/rules verdict exactly as they already do on
// any other Gemini failure.
function reserveGeminiCall(): boolean {
  const today = todayUtc();
  if (callState.date !== today) callState = { date: today, count: 0 };
  if (callState.count >= GEMINI_DAILY_CAP) return false;
  callState.count++;
  try { fs.writeFileSync(CALL_COUNT_FILE, JSON.stringify(callState)); } catch {}
  return true;
}

export type GeminiVerdict = {
  direction:        'BUY' | 'SELL' | 'SKIP';
  confidence:       number;   // 0-100
  reason:           string;
  stopPoints:       number;   // points away for stop loss
  takeProfitPoints: number;   // points away for take profit
  betSize:          number;   // £/pt — auto-sized by Gemini based on volatility
  engine:           'gemini' | 'fallback';
  // Only set when 'fallback' is actually due to no AI capacity (missing key
  // or daily cap reached) — NOT set for the routine, expected case where the
  // rules pre-filter itself said SKIP and Gemini was never even attempted.
  // Callers should use this (not just engine === 'fallback') to decide
  // whether something is actually wrong worth surfacing as a warning.
  noCapacityReason?: 'missing-key' | 'cap-reached';
};

export type EntrySignal = {
  instrumentName: string;
  epic:           string;
  rsi:            number | null;
  macd:           number | null;
  atr:            number | null;
  greenCount:     number;
  lastCandles:    Array<{ open: number; high: number; low: number; close: number }>;
  suggestedDir:   'BUY' | 'SELL';  // technical suggestion
};

function fallbackVerdict(signal: EntrySignal): GeminiVerdict {
  const { rsi, macd, greenCount, atr, suggestedDir } = signal;
  let score = 0;

  if (suggestedDir === 'BUY') {
    if (rsi !== null) { if (rsi < 40) score += 2; else if (rsi < 55) score += 1; else if (rsi > 65) score -= 2; }
    if (macd !== null) { if (macd > 0) score += 1; else score -= 1; }
    if (greenCount >= 3) score += 1; else if (greenCount <= 1) score -= 1;
  } else {
    if (rsi !== null) { if (rsi > 60) score += 2; else if (rsi > 45) score += 1; else if (rsi < 35) score -= 2; }
    if (macd !== null) { if (macd < 0) score += 1; else score -= 1; }
    const redCount = 5 - greenCount;
    if (redCount >= 3) score += 1; else if (redCount <= 1) score -= 1;
  }

  const lastPrice = signal.lastCandles[signal.lastCandles.length - 1]?.close ?? 100;
  const atrVal    = atr ?? lastPrice * 0.003;  // fallback: 0.3% of price
  // Use percentage-based minimum so forex (price ~1) gets sensible stops, not rounded-to-zero
  const stopPts   = Math.max(lastPrice * 0.001, atrVal * 1.5);   // min 0.1% of price
  const tpPts     = Math.max(lastPrice * 0.0015, atrVal * 2.0);  // min 0.15% of price
  const atrPct    = lastPrice > 0 ? (atrVal / lastPrice) * 100 : 1;
  const betSize   = atrPct > 0.5 ? 0.5 : atrPct > 0.2 ? 1.0 : 1.5;

  if (score < 1) {
    return { direction: 'SKIP', confidence: 40, reason: `Rules score ${score} — insufficient signal`, stopPoints: stopPts, takeProfitPoints: tpPts, betSize: 0.5, engine: 'fallback' };
  }

  return {
    direction:        suggestedDir,
    confidence:       Math.min(90, 50 + score * 10),
    reason:           `Rules: RSI=${rsi?.toFixed(0) ?? 'N/A'} MACD=${macd !== null ? (macd > 0 ? '+' : '') + macd.toFixed(4) : 'N/A'} score=${score}`,
    stopPoints:       stopPts,
    takeProfitPoints: tpPts,
    betSize,
    engine:           'fallback',
  };
}

export async function askGemini(signal: EntrySignal): Promise<GeminiVerdict> {
  const apiKey = process.env.GEMINI_API_KEY;

  // Stage 1: rules filter — always runs first
  const rules = fallbackVerdict(signal);
  if (rules.direction === 'SKIP') return rules;
  if (!apiKey) return { ...rules, noCapacityReason: 'missing-key' };

  if (!reserveGeminiCall()) {
    console.warn('[gemini] Daily call cap reached — using rules verdict');
    return { ...rules, noCapacityReason: 'cap-reached' };
  }

  // Stage 2: Gemini second opinion — only reached if rules say enter

  const candleStr = signal.lastCandles.map((c, i) =>
    `  [${i + 1}] O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)} ${c.close >= c.open ? '▲' : '▼'}`
  ).join('\n');

  const atrVal = signal.atr ?? 0;

  const lastPrice = signal.lastCandles[signal.lastCandles.length - 1]?.close ?? 0;
  const atrPct    = lastPrice > 0 ? (atrVal / lastPrice * 100).toFixed(3) : 'N/A';

  const prompt = `You are a second-opinion filter for a 1-minute spread betting scalper.
A rules engine already approved a ${rules.direction} signal. Confirm, override to the other direction, or SKIP if the setup looks poor.
Instrument: ${signal.instrumentName} — current price ~${lastPrice.toFixed(2)}

Last 5 closed 1-minute candles (oldest first):
${candleStr}
RSI(14): ${signal.rsi?.toFixed(1) ?? 'N/A'}
MACD histogram: ${signal.macd !== null ? (signal.macd > 0 ? '+' : '') + signal.macd.toFixed(5) : 'N/A'} (positive=bullish)
ATR(14): ${atrVal.toFixed(2)} pts (${atrPct}% of price) — volatility measure
Technical suggestion: ${signal.suggestedDir}

Guidelines:
- BUY on clear upward momentum, SELL on clear downward momentum, SKIP if choppy/unclear
- stopPoints: stop distance in SAME price units as current price (e.g. price=8000 → stopPoints=40; price=1.08 → stopPoints=0.0012; price=0.84 → stopPoints=0.0008)
- takeProfitPoints: same price units, aim for ≥1.3:1 reward/risk vs stop
- betSize: £/pt stake — use 0.5 if volatile (ATR% > 0.5%), 1.0 if moderate, 1.5 if calm and high confidence

Respond with JSON only, no markdown:
{"direction":"BUY","confidence":72,"reason":"max 12 words","stopPoints":0.0012,"takeProfitPoints":0.0018,"betSize":0.5}`;

  try {
    const res = await fetchGeminiWithRetry(
      // "latest" alias, not a pinned dated model — gemini-2.0-flash was
      // retired outright (confirmed live: free-tier quota set to 0), and
      // pinning a specific version again would just repeat that failure
      // whenever Google retires this one too. The alias is Google's own
      // responsibility to keep pointing at a working current model.
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // No thinkingConfig — the "latest" alias resolves to a reasoning
          // model (gemini-3.6-flash) that rejects thinkingBudget outright
          // (confirmed live: {"thinkingConfig":{"thinkingBudget":0}} gets a
          // flat 400 INVALID_ARGUMENT, breaking every call). Thinking stays
          // on instead — cheap regardless — with maxOutputTokens raised to
          // 1500: 400 wasn't enough either, confirmed live — a longer
          // prompt (with news headlines added) pushed thinking to 381
          // tokens, hit MAX_TOKENS, and truncated the JSON mid-word before
          // the visible answer finished. Thinking-token usage isn't
          // something this can control precisely, so headroom needs to be
          // generous rather than tightly tuned.
          generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
        }),
        signal: AbortSignal.timeout(20_000),
      }
    );

    if (!res.ok) {
      console.warn(`[gemini] API error ${res.status} — using rules verdict`);
      return rules;
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text    = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed  = JSON.parse(cleaned) as {
      direction: string; confidence: number; reason: string;
      stopPoints: number; takeProfitPoints: number; betSize?: number;
    };

    const dir = (['BUY', 'SELL', 'SKIP'].includes(parsed.direction)) ? parsed.direction as GeminiVerdict['direction'] : 'SKIP';
    const rawSize = parsed.betSize ?? 0.5;
    const betSize = Math.min(2.0, Math.max(0.5, rawSize));

    return {
      direction:        dir,
      confidence:       Math.max(0, Math.min(100, parsed.confidence ?? 50)),
      reason:           parsed.reason ?? '',
      stopPoints:       Math.max(1, parsed.stopPoints ?? Math.round(atrVal * 1.5)),
      takeProfitPoints: Math.max(1, parsed.takeProfitPoints ?? Math.round(atrVal * 2)),
      betSize,
      engine:           'gemini',
    };
  } catch (e) {
    console.warn(`[gemini] Failed — using rules verdict. ${e instanceof Error ? e.message : String(e)}`);
    return rules;
  }
}

// ── FX/index swing second opinion ────────────────────────────────────────────
// fxScalperBot.ts used to route its hourly-bar swing entries through
// askGemini() above — a prompt that explicitly tells the model it's
// reviewing "a 1-minute spread betting scalper", leftover from before this
// bot was rewritten from 5-min scalping to hourly-bar, hours-scale swing
// holds. Same confirm/override/skip role as askGemini, but framed for what
// this actually is: a trend-continuation swing trade expected to run for
// hours, not minutes, with real hourly candle shape instead of five
// scalp-scale ones. Doesn't size the trade (stopPoints/takeProfitPoints) —
// the caller already derives those from 1H ATR, this only confirms
// direction/confidence, same division of labor askGemini already had.

export type FxSwingEntrySignal = {
  instrumentName: string;
  trend:          'UP' | 'DOWN';
  rsi:            number | null;
  macd:           number | null;
  atr:            number | null;
  suggestedDir:   'BUY' | 'SELL';
  // Last several closed 1-hour candles, oldest first — real recent shape,
  // not just a derived RSI/MACD number.
  lastCandles:    Array<{ open: number; high: number; low: number; close: number }>;
  // Every other USD-involving pair this bot also trades, each pair's own
  // current hourly trend translated into what it implies for USD
  // specifically (a pair trending "UP" means USD strengthening if USD is
  // the base currency, e.g. USD/JPY, but USD weakening if USD is the
  // quote, e.g. GBP/USD) — lets Gemini tell a genuine broad-dollar move
  // apart from something isolated to just this one pair. Confirmed this
  // was previously completely invisible: the bot traded each FX pair off
  // only its own chart, with zero awareness of what the dollar was doing
  // anywhere else.
  usdContext?: Array<{ pair: string; usdTrend: 'UP' | 'DOWN' | 'FLAT' }>;
  // Each currency actually in THIS pair's own equity-index proxy (both
  // sides where one exists, not a single fixed reference regardless of
  // the pair — GBP/USD gets UK 100 as well as Wall St, EUR/USD gets
  // Germany 40 as the closest available eurozone proxy as well as Wall
  // St). Informational only, not a rule: equities and a currency don't
  // move in lockstep, so this is one more input to weigh, not something
  // that should mechanically block or force a direction.
  equityContext?: Array<{ currency: string; indexLabel: string; trend: 'UP' | 'DOWN' | 'FLAT' }>;
  // Real recent/upcoming high-impact macro events (rate decisions, CPI,
  // employment, GDP) for whichever currencies are actually in this pair —
  // see macroCalendar.ts. This is what actually drives FX medium-term, far
  // more than an hourly chart — a technically clean setup running straight
  // into a rate decision or inflation print is a materially different bet
  // than the same setup with no major catalyst nearby.
  macroEvents?: string[];
};

export type FxSwingVerdict = {
  direction:  'BUY' | 'SELL' | 'SKIP';
  confidence: number;
  reason:     string;
  engine:     'gemini' | 'passthrough';
};

export async function askGeminiFxSwing(signal: FxSwingEntrySignal): Promise<FxSwingVerdict> {
  const apiKey = process.env.GEMINI_API_KEY;
  // No key, cap reached, or any API failure below — passthrough on the
  // technical signal rather than SKIP, same as askGeminiDailyVerdict.
  // fxSwingStrategy.ts's own EMA/RSI/MACD agreement already qualified this
  // setup before Gemini was ever asked; losing Gemini shouldn't mean losing
  // every entry. 65% clears the default 60% minConfidence threshold with a
  // little headroom, without claiming a confidence this function can't
  // actually back up.
  const passthrough = (reason: string): FxSwingVerdict =>
    ({ direction: signal.suggestedDir, confidence: 65, reason, engine: 'passthrough' });

  if (!apiKey) return passthrough('No Gemini key configured — trading on the technical signal alone');
  if (!reserveGeminiCall()) return passthrough('Daily Gemini call cap reached — trading on the technical signal alone');

  const candleStr = signal.lastCandles.map((c, i) =>
    `  [${i + 1}] O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)} ${c.close >= c.open ? '▲' : '▼'}`
  ).join('\n');

  const usdLabel = (t: 'UP' | 'DOWN' | 'FLAT') => t === 'UP' ? 'strengthening' : t === 'DOWN' ? 'weakening' : 'flat';
  const usdContextBlock = signal.usdContext?.length
    ? `\nWhat the dollar is doing elsewhere right now, per this bot's other watched USD pairs (use this to tell a genuine broad-dollar move apart from something isolated to just this one pair — if every USD pair agrees, that's a real macro move; if they disagree, this pair's move may be idiosyncratic to it alone):\n${signal.usdContext.map(c => `- ${c.pair}: implies USD ${usdLabel(c.usdTrend)}`).join('\n')}\n`
    : '';
  const equityContextBlock = signal.equityContext?.length
    ? `\nEquity-market context for the currencies actually in this pair (current hourly trend of each currency's own index proxy — equities and a currency don't always move together, so treat this as one more input on risk appetite, not a rule that should mechanically decide the trade):\n${signal.equityContext.map(c => `- ${c.currency} (${c.indexLabel}): ${c.trend}`).join('\n')}\n`
    : '';
  const macroBlock = signal.macroEvents?.length
    ? `\nReal macro/rate events for the currencies in this pair — "past" already happened and may already explain recent price action; "upcoming" hasn't happened yet and is a real risk to any position still open when it lands (this is what actually drives FX medium-term, more than the chart alone):\n${signal.macroEvents.map(e => `- ${e}`).join('\n')}\n`
    : '';

  const prompt = `You are a second-opinion filter for an hourly-bar FX/index swing trade — NOT a scalp. Positions here are typically held for several hours (up to ~11h) while a trend plays out, and are managed by their own stop/take-profit and a stall-detection exit, not closed on the next tick.

A trend-following rules engine already qualified a ${signal.suggestedDir} setup here: price is trading with the ${signal.trend === 'UP' ? 'uptrend (EMA20>EMA50), above EMA20' : 'downtrend (EMA20<EMA50), below EMA20'}, with RSI and MACD both already confirming that direction. Your job is not to re-derive the setup — it's to judge whether this trend genuinely has enough room left to keep running for the next several hours, or whether it's already largely played out.

Instrument: ${signal.instrumentName}

Last ${signal.lastCandles.length} closed 1-hour candles (oldest first — use this to judge the actual shape of the move: still accelerating, or already stalling?):
${candleStr}
RSI(14): ${signal.rsi?.toFixed(1) ?? 'N/A'}
MACD histogram: ${signal.macd !== null ? (signal.macd > 0 ? '+' : '') + signal.macd.toFixed(5) : 'N/A'} (positive=bullish)
ATR(14): ${signal.atr?.toFixed(2) ?? 'N/A'} pts — hourly volatility measure
${usdContextBlock}${equityContextBlock}${macroBlock}
Confirm, override to the other direction, or SKIP if this trend looks exhausted rather than continuing. Treat "RSI overbought/oversold" the same way you would any other momentum reading in an intact trend — strong recent demand often keeps pushing price further in the near term rather than reversing immediately; only let it count against the trade if the candle shape above is already showing real stalling (small bodies, failed pushes, reversal wicks), not just an extended reading in an otherwise clean trend. If a genuinely major event (rate decision, CPI) is listed as "upcoming" and could land while this position is still open, weigh that as real event risk — lower confidence or SKIP rather than ignoring it, even if the technical setup itself looks clean.

Respond with JSON only, no markdown:
{"direction":"BUY","confidence":72,"reason":"max 15 words"}`;

  try {
    const res = await fetchGeminiWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
        }),
        signal: AbortSignal.timeout(20_000),
      }
    );

    if (!res.ok) return passthrough(`Gemini ${res.status} — trading on the technical signal alone`);

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text    = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed  = JSON.parse(cleaned) as { direction: string; confidence: number; reason: string };

    const dir = (['BUY', 'SELL', 'SKIP'].includes(parsed.direction)) ? parsed.direction as FxSwingVerdict['direction'] : 'SKIP';

    return {
      direction:  dir,
      confidence: Math.max(0, Math.min(100, parsed.confidence ?? 50)),
      reason:     parsed.reason ?? '',
      engine:     'gemini',
    };
  } catch (e) {
    return passthrough(`Gemini failed — trading on the technical signal alone (${e instanceof Error ? e.message : String(e)})`);
  }
}

// ── Daily-timeframe second opinion ───────────────────────────────────────────
// Same role as the Demo Trader tab's /api/gemini/verdict route (confirm/override/
// skip a signal already produced by a daily-timeframe strategy), ported here so
// the persistent bot gets the same check instead of running unchecked.

export type DailyVerdictRequest = {
  instrumentName: string;
  direction:      'BUY' | 'SELL';
  strength:       number;
  price:          number;
  changePercent:  number;
  stopPoints:     number;
  tpPoints:       number;
  headlines?:     string[];  // recent real news for this instrument, if available — see newsFetch.ts
};

export type DailyVerdict = {
  direction:  'BUY' | 'SELL' | 'SKIP';
  confidence: number;
  reason:     string;
  engine:     'gemini' | 'passthrough';
};

export async function askGeminiDailyVerdict(req: DailyVerdictRequest): Promise<DailyVerdict> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { direction: req.direction, confidence: req.strength, reason: 'No Gemini key — using signal strength', engine: 'passthrough' };
  }
  if (!reserveGeminiCall()) {
    return { direction: req.direction, confidence: req.strength, reason: 'Daily Gemini call cap reached — using signal strength', engine: 'passthrough' };
  }

  const rrRatio = req.stopPoints > 0 ? (req.tpPoints / req.stopPoints).toFixed(1) : '?';
  const pctStr  = `${req.changePercent >= 0 ? '+' : ''}${req.changePercent.toFixed(2)}%`;
  const headlineBlock = req.headlines?.length
    ? `\nRecent news (last 7 days, dated — use the dates to judge how a story has developed, not just whether it exists):\n${req.headlines.map(h => `- ${h}`).join('\n')}\n`
    : '';

  const prompt = `You are a second-opinion filter for a spread betting strategy.
Signal: ${req.direction} ${req.instrumentName}
Price: ${req.price.toFixed(2)}, Daily change: ${pctStr}
Signal strength: ${req.strength}%
Stop: ${req.stopPoints}pts, TP: ${req.tpPoints}pts (${rrRatio}:1 R:R)
${headlineBlock}
Should we take this trade? Consider the technical signal AND whether the recent news supports or contradicts it (e.g. don't confirm a SELL right after clearly positive news, or a BUY right after clearly negative news) — if no news is listed above, judge on the technicals alone. Confirm, override, or SKIP if the setup looks poor.
Respond with JSON only, no markdown:
{"direction":"BUY","confidence":72,"reason":"max 15 words"}`;

  try {
    const res = await fetchGeminiWithRetry(
      // "latest" alias, not a pinned dated model — gemini-2.0-flash was
      // retired outright (confirmed live: free-tier quota set to 0), and
      // pinning a specific version again would just repeat that failure
      // whenever Google retires this one too. The alias is Google's own
      // responsibility to keep pointing at a working current model.
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents:         [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
        }),
        signal: AbortSignal.timeout(20_000),
      }
    );

    if (!res.ok) {
      return { direction: req.direction, confidence: req.strength, reason: `Gemini ${res.status}`, engine: 'passthrough' };
    }

    const data    = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text    = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed  = JSON.parse(cleaned) as { direction: string; confidence: number; reason: string };

    const dir = (['BUY', 'SELL', 'SKIP'].includes(parsed.direction)) ? parsed.direction as DailyVerdict['direction'] : 'SKIP';

    return {
      direction:  dir,
      confidence: Math.max(0, Math.min(100, parsed.confidence ?? req.strength)),
      reason:     parsed.reason ?? '',
      engine:     'gemini',
    };
  } catch {
    return { direction: req.direction, confidence: req.strength, reason: 'Gemini failed — using signal', engine: 'passthrough' };
  }
}

// ── Open-position review (hold/close) ────────────────────────────────────────
// Distinct from the entry-confirmation verdicts above — this reviews a
// position that's already open (manually opened or otherwise flagged for
// watching) and decides whether to close it now or keep holding. Always
// defaults to HOLD on any failure — a real IG stop is attached independently
// of this at watch-time, so "do nothing" on a Gemini outage is the safe
// default, not a silent risk.

export type PositionVerdict = {
  action:     'HOLD' | 'CLOSE';
  confidence: number;
  reason:     string;
  engine:     'gemini' | 'passthrough';
};

export type PositionReviewRequest = {
  instrumentName: string;
  direction:      'BUY' | 'SELL';
  entryLevel:     number;
  currentLevel:   number;
  uplGbp:         number;
  heldHours:      number;
  stopLevel?:     number;
  limitLevel?:    number;
  headlines?:     string[];  // recent real news for this instrument, if available — see newsFetch.ts
  // How far the instrument has already moved today (independent of this
  // position's own entry/current levels) — confirmed live this matters:
  // Micron was bought after it had already run ~17% that day, essentially
  // at the top of the move, and neither the entry decision nor a hold
  // review had any way to know how extended the day's move already was
  // without this.
  dayChangePercent?: number;
  // Adverse move against the position's direction within just the last few
  // hours (independent of dayChangePercent) — a position can look fine on a
  // day-change basis while a fast reversal is happening right now. Distinct
  // signal worth flagging on its own, not folded into dayChangePercent.
  sharpDipPercent?: number;
  // Position was meaningfully in profit at some point while watched and has
  // since gone negative — a stronger, more specific signal than P&L simply
  // being down, since it means favorability actually reversed rather than
  // just never having been favorable yet.
  reversedToRed?: boolean;
  // FX oscillates more within what's still normal short-term noise than a
  // stock does — the same-size sharp-move/reversal signal above deserves a
  // higher bar of evidence for FX than for a stock. Deliberately doesn't
  // hide sharpDipPercent/reversedToRed below some cutoff when this is true
  // (that would strip Gemini of information it might still need — e.g. a
  // small move plus genuinely bad news is still worth closing over) —
  // instead this only adjusts how much weight to give the signal alone.
  isFx?: boolean;
};

export async function askGeminiPositionVerdict(req: PositionReviewRequest): Promise<PositionVerdict> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { action: 'HOLD', confidence: 0, reason: 'No Gemini key configured — holding, stop still protects the position', engine: 'passthrough' };
  }
  if (!reserveGeminiCall()) {
    return { action: 'HOLD', confidence: 0, reason: 'Daily Gemini call cap reached — holding, stop still protects the position', engine: 'passthrough' };
  }

  const pctMove = req.entryLevel > 0 ? (req.currentLevel - req.entryLevel) / req.entryLevel * 100 : 0;
  const signedPct = req.direction === 'BUY' ? pctMove : -pctMove;  // positive = favorable regardless of side

  const headlineBlock = req.headlines?.length
    ? `\nRecent news (last 7 days, dated — use the dates to judge how a story has developed, not just whether it exists):\n${req.headlines.map(h => `- ${h}`).join('\n')}\n`
    : '';

  const prompt = `You are reviewing an already-open spread bet position to decide whether to close it now or keep holding.

Instrument: ${req.instrumentName}
Direction: ${req.direction}
Entry level: ${req.entryLevel.toFixed(2)}
Current level: ${req.currentLevel.toFixed(2)} (${signedPct >= 0 ? '+' : ''}${signedPct.toFixed(2)}% favorable move)
Unrealized P/L: £${req.uplGbp.toFixed(2)}
Held for: ${req.heldHours.toFixed(1)} hours
${req.dayChangePercent !== undefined ? `Instrument's overall move today (independent of this position's own entry): ${req.dayChangePercent >= 0 ? '+' : ''}${req.dayChangePercent.toFixed(1)}%` : ''}
${req.sharpDipPercent !== undefined ? `⚠ SUDDEN MOVE: ${req.sharpDipPercent.toFixed(2)}% against this position in just the last few hours (independent of the day's overall move above). Treat a fast, sharp move against the position as a meaningful warning sign in its own right, not noise to smooth over — a real reversal often starts exactly like this, before news or the wider day's figures catch up to it.` : ''}
${req.reversedToRed ? `⚠ REVERSAL: this position was meaningfully in profit at an earlier point and has now swung into a loss. Even if the news below looks positive or is silent, a green-to-red reversal like this can mean a sell-off is already underway that hasn't been reported yet — weigh the reversal itself as a real reason to lean toward closing rather than assuming the fundamentals still hold just because nothing bad has been printed about it.` : ''}
${req.isFx ? `Note: this is an FX pair. Currency pairs oscillate more within what's still ordinary short-term noise than a stock does — a move under roughly 2-3% is often just normal chop, not a genuine reversal. Apply a higher bar of evidence than you would for a stock before leaning toward closing over any sharp-move or reversal signal above: look for a clearly larger and/or sustained move, or real corroborating news, rather than the move alone.` : ''}
${req.stopLevel !== undefined ? `Stop-loss already attached at: ${req.stopLevel.toFixed(2)}` : 'No stop currently attached'}
${req.limitLevel !== undefined ? `Take-profit already attached at: ${req.limitLevel.toFixed(2)}` : 'No take-profit currently set'}
${headlineBlock}
A hard stop-loss protects this position independent of your decision — you are not the only thing standing between this trade and a loss, and a real take-profit only pays off if the position is actually left open long enough to reach it. Decide only: is there a clear reason to close now — lock in a healthy gain, cut a loss before it likely gets worse, genuine news/volatility that could reverse this position's favorability, or the instrument already being significantly extended today (e.g. a large % move already behind it, meaning limited further room and real pullback risk even if the entry thesis was sound) — or is holding for the stop/take-profit to do its job still reasonable? A sharp-move or green-to-red-reversal flag above is a prompt to look closer, not a verdict by itself — HOLD is still the right call if the move has no independent thesis behind it (no real news, no MACD/momentum actually turning, nothing beyond "it moved"). Only close on one of these flags when you'd also point to something concrete beyond the move itself — otherwise it's just the ordinary noise a stop-loss already exists to catch, and cutting it early only guarantees giving up the take-profit without actually avoiding the loss the stop would have capped anyway. If no news is listed above, judge on price action and technicals alone.

Respond with JSON only, no markdown:
{"action":"HOLD","confidence":72,"reason":"max 15 words"}`;

  try {
    const res = await fetchGeminiWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          contents:         [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!res.ok) {
      return { action: 'HOLD', confidence: 0, reason: `Gemini ${res.status} — holding, stop still protects the position`, engine: 'passthrough' };
    }

    const data    = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text    = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed  = JSON.parse(cleaned) as { action: string; confidence: number; reason: string };

    return {
      action:     parsed.action === 'CLOSE' ? 'CLOSE' : 'HOLD',
      confidence: Math.max(0, Math.min(100, parsed.confidence ?? 50)),
      reason:     parsed.reason ?? '',
      engine:     'gemini',
    };
  } catch (e) {
    return {
      action:     'HOLD',
      confidence: 0,
      reason:     `Gemini failed — holding, stop still protects the position (${e instanceof Error ? e.message : String(e)})`,
      engine:     'passthrough',
    };
  }
}

// ── Gemini-native trade idea (experimental "gemini_opinion" strategy) ───────
// Distinct from every verdict above — those all confirm/veto a signal a
// technical rule already generated. This one has no rule behind it at all:
// Gemini decides BUY/SELL/HOLD from scratch each cycle off price/technical
// context and real news, and supplies its own stop/TP distances. Fails
// closed like everything else — no key, cap reached, or any error all
// return HOLD/engine:'passthrough', and the caller (igStrategyBot.ts) never
// trades on a passthrough result here, since there's no underlying rule to
// fall back to the way VWAP falls back to its own technicals.

export type TradeIdeaRequest = {
  instrumentName: string;
  price:          number;
  rsi:            number | null;
  macdHist:       number | null;
  atr:            number | null;
  headlines:      string[];
  // How far the instrument has already moved today, independent of
  // RSI/MACD — confirmed live this matters: Micron got bought after it had
  // already run ~17% that day, essentially at the top of the move. RSI/MACD
  // on hourly bars don't reliably surface how extended a move already is,
  // and without this the model has no way to weigh "how much room is
  // actually left" versus "how good does this look right now."
  dayChangePercent?: number;
  // Trend over a wider window than just today — confirmed live this
  // matters: a "post-earnings selloff reversing" thesis was bought using
  // only ~40h of price history to judge it, and the selloff was still
  // actively continuing at the multi-day level. Distinguishes a genuine
  // pullback-within-an-uptrend from a stock still mid-selloff, which
  // today's-move-alone can't do.
  multiDayTrendPercent?:  number;
  multiDayTrendSpanDays?: number;
  // Gap at today's open vs yesterday's close, and relative volume vs the
  // recent average — two distinct "something is actually happening here"
  // signals, separate from how far price has moved intraday since open.
  gapPercent?:          number;
  volumeSurgeMultiple?: number;
  // What Gemini Watch said the last time a position on this instrument got
  // cut, if recent — confirmed live this matters: Seagate got re-entered
  // on a bullish AI-demand thesis 8 times in one day, and 7 of 8 exits
  // separately cited memory-sector cooling as the reason, with neither
  // side of that ever informing the other. Without this, the entry
  // decision has no way to know its own recent history on this exact name.
  recentExitContext?: string;
  // Last several 30-min bars, oldest first — actual recent price *shape*,
  // not just a single RSI/MACD/ATR snapshot derived from the tail of a much
  // longer window. This is a leveraged spread bet, not a buy-and-hold: how
  // price has actually been moving over the last several hours matters as
  // much as where it ended up.
  recentCandles?: Array<{ open: number; high: number; low: number; close: number }>;
  // Hours left in today's regular NYSE session, only set for a US-listed
  // share (NYSE hours are meaningless for a UK/other-listed one). Not a
  // rule to block entries — a genuine multi-day thesis is fine holding
  // overnight — but a same-day breakout thesis deserves less confidence
  // the less real session time is left for it to actually prove out.
  // Confirmed live this was missing: Intel got bought on a fresh breakout
  // thesis ~1h before NYSE close with identical confidence to the same
  // setup at 10am with a full session ahead of it.
  sessionHoursRemaining?: number;
  // Which part of the NYSE session's real, data-verified volatility shape
  // right now — see nyseVolatilityRegime in alpacaApi.ts. Same US-listed-
  // only gating as sessionHoursRemaining.
  volatilityRegime?: 'post-open' | 'afternoon-lull' | 'closing-window';
  // Set only for the weekend/overnight gap before real exchange trading has
  // resumed — no real trades exist anywhere in that window (confirmed live:
  // even IG's own Lightstreamer candle feed goes quiet then, despite the
  // raw dealing quote staying live), so rsi/macdHist/atr/recentCandles/
  // dayChangePercent/etc are all genuinely unavailable rather than just
  // omitted, and `price` is IG's live quote, not a confirmed trade. Adds an
  // explicit warning so Gemini calibrates for having only news + one price
  // to go on, instead of silently reasoning as if the missing fields just
  // happened not to apply.
  noTechnicalData?: boolean;
};

export type TradeIdeaVerdict = {
  action:           'BUY' | 'SELL' | 'HOLD';
  confidence:       number;
  reason:           string;
  stopPoints:       number;
  takeProfitPoints: number;
  engine:           'gemini' | 'passthrough';
};

export async function askGeminiTradeIdea(req: TradeIdeaRequest): Promise<TradeIdeaVerdict> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { action: 'HOLD', confidence: 0, reason: 'No Gemini key configured', stopPoints: 0, takeProfitPoints: 0, engine: 'passthrough' };
  }
  if (!reserveGeminiCall()) {
    return { action: 'HOLD', confidence: 0, reason: 'Daily Gemini call cap reached', stopPoints: 0, takeProfitPoints: 0, engine: 'passthrough' };
  }

  const headlineBlock = req.headlines.length
    ? `\nRecent news (last 7 days, dated — use the dates to judge how a story has developed, not just whether it exists; weigh today's/yesterday's headlines far more heavily than one from 5-6 days ago, which is likely already priced in):\n${req.headlines.map(h => `- ${h}`).join('\n')}\n`
    : '\nNo recent company-specific news found.\n';

  const candleBlock = req.recentCandles?.length
    ? `\nLast ${req.recentCandles.length} closed 30-min candles (oldest first, so you can see the actual recent shape of the move, not just where it ended up):\n${req.recentCandles.map((c, i) =>
        `  [${i + 1}] O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)} ${c.close >= c.open ? '▲' : '▼'}`
      ).join('\n')}\n`
    : '';

  const prompt = `You are deciding, entirely on your own judgment, whether to open a spread bet position on this instrument right now — there is no pre-existing technical signal to confirm or veto, you are the primary decision-maker.

This is leveraged spread betting, not a long-term investment — positions here are opened and typically resolved within the same day or so, not held for weeks. That means two things should weigh heavily on your decision: (1) genuinely fresh, near-daily news — a headline from today or yesterday matters far more than one from most of a week ago, which the market has likely already absorbed — and (2) the instrument's actual recent movement at a fine (30-minute) resolution, not just a single indicator snapshot summarizing a much longer window. Use the candle sequence below to judge whether the move is accelerating, stalling, or reversing right now, not only whether an indicator crossed some threshold.

Instrument: ${req.instrumentName}
Current price: ${req.price.toFixed(2)}
${req.noTechnicalData ? `\n⚠ No technical data is available for this decision. This is being evaluated during the weekend/overnight gap before real exchange trading has resumed — there are no real trades happening anywhere right now, so RSI/MACD/ATR, recent candle shape, today's move, and trend context are all genuinely unavailable, not just omitted. The price above is IG's own live quoted price, not a confirmed exchange trade. You have ONLY the news below and this single price to go on, with no way to technically confirm or contradict it. Because of that, only recommend BUY/SELL for a genuinely clear, specific, high-conviction catalyst — a concrete, material headline, not a marginal or speculative case you'd otherwise rate a moderate confidence. Default to HOLD unless the news is decisive.\n` : ''}
${req.dayChangePercent !== undefined ? `Move so far today: ${req.dayChangePercent >= 0 ? '+' : ''}${req.dayChangePercent.toFixed(1)}%` : ''}
${req.sessionHoursRemaining !== undefined ? `Time left in today's regular NYSE session: ~${req.sessionHoursRemaining.toFixed(1)}h. This isn't a reason to avoid a genuine multi-day thesis (fine to hold overnight into tomorrow) — but a same-day breakout/continuation thesis specifically needs real time left for it to actually play out; the later in the session it starts, the less conviction it deserves purely on "room left today" grounds, independent of how clean the setup itself looks.` : ''}
${req.volatilityRegime === 'post-open' ? `Time-of-day volatility context (checked against real historical data, US session): still within the post-NYSE-open volatile window — moves right now are historically larger than typical in either direction. A clean breakout here has real weight behind it, but so does a false start that fades once this window passes.` : ''}${req.volatilityRegime === 'afternoon-lull' ? `Time-of-day volatility context (checked against real historical data, US session): the historically calmer mid-to-late-afternoon stretch — moves here are typically smaller and more prone to fading than during the open or the close. A fresh breakout thesis starting now deserves a bit more scrutiny than the identical setup during a genuinely active window, though a real catalyst can absolutely still work here.` : ''}${req.volatilityRegime === 'closing-window' ? `Time-of-day volatility context (checked against real historical data, US session): activity historically picks back up heading into the close — this can mean a genuine late-day move or just position-squaring noise as day traders flatten. Use the actual candle shape above to judge which this looks like, not the time of day alone.` : ''}
${req.multiDayTrendPercent !== undefined ? `Trend over the last ${req.multiDayTrendSpanDays} days: ${req.multiDayTrendPercent >= 0 ? '+' : ''}${req.multiDayTrendPercent.toFixed(1)}% — use this to tell a genuine pullback within an intact uptrend apart from a stock still mid-selloff. A bullish "buy the dip" thesis needs the multi-day trend to actually still be up (or at least flat) — buying because today looks oversold while the multi-day trend is sharply down is catching a falling knife, not a dip, unless you have a genuinely strong, specific reason the selloff itself is over (not just "RSI is low").` : ''}
${req.gapPercent !== undefined && req.gapPercent >= 2 ? `Gapped ${req.gapPercent.toFixed(1)}% at today's open vs yesterday's close — a real gap like this usually means genuine news/sentiment shifted overnight, not routine noise; worth weighing whether that gap has already fully played out or still has room.` : ''}
${req.volumeSurgeMultiple !== undefined && req.volumeSurgeMultiple >= 2.5 ? `Volume running ~${req.volumeSurgeMultiple.toFixed(1)}x the recent average — unusually high participation, which lends more weight to whatever the price action is currently doing (a move on genuinely elevated volume is more likely to mean something than the same move on ordinary volume).` : ''}
RSI (14h lookback): ${req.rsi?.toFixed(1) ?? 'N/A'}
MACD histogram (12h/26h/9h): ${req.macdHist !== null ? (req.macdHist > 0 ? '+' : '') + req.macdHist.toFixed(5) : 'N/A'}
ATR (14h lookback): ${req.atr?.toFixed(2) ?? 'N/A'} — volatility measure, use this to size a sensible stop
${candleBlock}${headlineBlock}
${req.recentExitContext ? `⚠ Recent history on this instrument/sector: ${req.recentExitContext}\n` : ''}
So what matters most isn't just what already happened, it's your own expectation of where this goes from here: given the setup, the recent candle-by-candle shape, the news, and the trend context above, do you actually expect this instrument to keep moving in your chosen direction for the rest of today (and into the next day or so if held), or is the move already largely played out? Your confidence score should reflect how strongly you believe that expected forward move will actually happen — not a mechanical pass/fail on the indicators. A technically clean setup you have no real view on what happens next should score low confidence or HOLD; a setup with a clear, specific reason to expect continued movement deserves genuine conviction even if one indicator looks mixed.

Decide BUY, SELL, or HOLD. Only pick BUY/SELL if you have genuine conviction — HOLD is the right answer most of the time when the picture is mixed or unclear. Consider both the technicals and the news together; don't recommend a direction the news directly contradicts. If the instrument has already moved significantly today, that is NOT by itself a reason to hold off — a big move already behind it is only one input, and real conviction (a strong, still-intact catalyst, technicals still confirming, news that hasn't fully played out) can absolutely justify entering after a large move. Only let the day's move count against the trade when your actual reasoning would be pure momentum-chasing — i.e. "it's up a lot so I'll follow it" with no independent thesis of its own. Don't default to HOLD just because the move is large; default to HOLD when the conviction itself is weak.

Treat "overbought"/"oversold" RSI the same way, not as an automatic reversal signal. A high RSI means strong recent demand — that demand often keeps pushing price further in the short term rather than reversing immediately, especially while the catalyst behind it is still fresh and unresolved. Don't SELL (or avoid a BUY) on "RSI is overbought" alone with no other reasoning — that's betting against the trend with no real thesis for why it stops now. Only let RSI extension count against a trade when you also see the catalyst genuinely exhausted (news fully priced in, momentum actually turning on MACD, no fresh reason left to keep buying) — extension alone, in an otherwise intact setup, is not a sell signal.

stopPoints: stop distance in the SAME price units as current price (e.g. price=15000 → stopPoints=150 for a 1% stop; price=1.08 → stopPoints=0.01)
takeProfitPoints: same units, aim for at least 1.5:1 reward/risk vs your stop

Respond with JSON only, no markdown:
{"action":"BUY","confidence":70,"reason":"max 20 words","stopPoints":150,"takeProfitPoints":300}`;

  try {
    const res = await fetchGeminiWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          contents:         [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1500 },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!res.ok) {
      return { action: 'HOLD', confidence: 0, reason: `Gemini ${res.status}`, stopPoints: 0, takeProfitPoints: 0, engine: 'passthrough' };
    }

    const data    = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text    = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed  = JSON.parse(cleaned) as {
      action: string; confidence: number; reason: string;
      stopPoints: number; takeProfitPoints: number;
    };

    const action = (['BUY', 'SELL', 'HOLD'].includes(parsed.action)) ? parsed.action as TradeIdeaVerdict['action'] : 'HOLD';

    return {
      action,
      confidence:       Math.max(0, Math.min(100, parsed.confidence ?? 0)),
      reason:           parsed.reason ?? '',
      stopPoints:       Math.max(0, parsed.stopPoints ?? 0),
      takeProfitPoints: Math.max(0, parsed.takeProfitPoints ?? 0),
      engine:           'gemini',
    };
  } catch (e) {
    return {
      action: 'HOLD', confidence: 0,
      reason: `Gemini failed (${e instanceof Error ? e.message : String(e)})`,
      stopPoints: 0, takeProfitPoints: 0, engine: 'passthrough',
    };
  }
}

export type GeminiVerdict = {
  direction:        'BUY' | 'SELL' | 'SKIP';
  confidence:       number;   // 0-100
  reason:           string;
  stopPoints:       number;   // points away for stop loss
  takeProfitPoints: number;   // points away for take profit
  betSize:          number;   // £/pt — auto-sized by Gemini based on volatility
  engine:           'gemini' | 'fallback';
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
  if (!apiKey || rules.direction === 'SKIP') return rules;

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
    const res = await fetch(
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
          // thinkingBudget: 0 — the "latest" alias now resolves to a reasoning
          // model; without this, hidden thinking tokens can eat the whole
          // maxOutputTokens budget before the visible JSON answer is
          // generated, leaving an empty response that fails to parse and
          // silently falls back — the same class of silent failure as the
          // dead-model bug, just via a different mechanism. Not needed for
          // a plain structured classification like this anyway.
          generationConfig: { temperature: 0.2, maxOutputTokens: 150, thinkingConfig: { thinkingBudget: 0 } },
        }),
        signal: AbortSignal.timeout(8_000),
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

  const rrRatio = req.stopPoints > 0 ? (req.tpPoints / req.stopPoints).toFixed(1) : '?';
  const pctStr  = `${req.changePercent >= 0 ? '+' : ''}${req.changePercent.toFixed(2)}%`;

  const prompt = `You are a second-opinion filter for a spread betting strategy.
Signal: ${req.direction} ${req.instrumentName}
Price: ${req.price.toFixed(2)}, Daily change: ${pctStr}
Signal strength: ${req.strength}%
Stop: ${req.stopPoints}pts, TP: ${req.tpPoints}pts (${rrRatio}:1 R:R)

Should we take this trade? Confirm, override, or SKIP if the setup looks poor.
Respond with JSON only, no markdown:
{"direction":"BUY","confidence":72,"reason":"max 12 words"}`;

  try {
    const res = await fetch(
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
          generationConfig: { temperature: 0.2, maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } },
        }),
        signal: AbortSignal.timeout(8_000),
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
};

export async function askGeminiPositionVerdict(req: PositionReviewRequest): Promise<PositionVerdict> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { action: 'HOLD', confidence: 0, reason: 'No Gemini key configured — holding, stop still protects the position', engine: 'passthrough' };
  }

  const pctMove = req.entryLevel > 0 ? (req.currentLevel - req.entryLevel) / req.entryLevel * 100 : 0;
  const signedPct = req.direction === 'BUY' ? pctMove : -pctMove;  // positive = favorable regardless of side

  const prompt = `You are reviewing an already-open spread bet position to decide whether to close it now or keep holding.

Instrument: ${req.instrumentName}
Direction: ${req.direction}
Entry level: ${req.entryLevel.toFixed(2)}
Current level: ${req.currentLevel.toFixed(2)} (${signedPct >= 0 ? '+' : ''}${signedPct.toFixed(2)}% favorable move)
Unrealized P/L: £${req.uplGbp.toFixed(2)}
Held for: ${req.heldHours.toFixed(1)} hours
${req.stopLevel !== undefined ? `Stop-loss already attached at: ${req.stopLevel.toFixed(2)}` : 'No stop currently attached'}
${req.limitLevel !== undefined ? `Take-profit already attached at: ${req.limitLevel.toFixed(2)}` : 'No take-profit currently set'}

A hard stop-loss protects this position independent of your decision — you are not the only thing standing between this trade and a loss. Decide only: is there a clear reason to close now (lock in a gain, or cut a loss before it likely gets worse), or is holding for the stop/take-profit to do its job still reasonable?

Respond with JSON only, no markdown:
{"action":"HOLD","confidence":72,"reason":"max 15 words"}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          contents:         [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } },
        }),
        signal: AbortSignal.timeout(8_000),
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

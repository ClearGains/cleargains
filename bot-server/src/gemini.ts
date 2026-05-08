export type GeminiVerdict = {
  direction:        'BUY' | 'SELL' | 'SKIP';
  confidence:       number;   // 0-100
  reason:           string;
  stopPoints:       number;   // points away for stop loss
  takeProfitPoints: number;   // points away for take profit
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

  const atrVal    = atr ?? 5;
  const stopPts   = Math.max(2, Math.round(atrVal * 1.5));
  const tpPts     = Math.max(3, Math.round(atrVal * 2.0));

  if (score < 1) {
    return { direction: 'SKIP', confidence: 40, reason: `Rules score ${score} — insufficient signal`, stopPoints: stopPts, takeProfitPoints: tpPts, engine: 'fallback' };
  }

  return {
    direction:        suggestedDir,
    confidence:       Math.min(90, 50 + score * 10),
    reason:           `Rules: RSI=${rsi?.toFixed(0) ?? 'N/A'} MACD=${macd !== null ? (macd > 0 ? '+' : '') + macd.toFixed(4) : 'N/A'} score=${score}`,
    stopPoints:       stopPts,
    takeProfitPoints: tpPts,
    engine:           'fallback',
  };
}

export async function askGemini(signal: EntrySignal): Promise<GeminiVerdict> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fallbackVerdict(signal);

  const candleStr = signal.lastCandles.map((c, i) =>
    `  [${i + 1}] O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)} ${c.close >= c.open ? '▲' : '▼'}`
  ).join('\n');

  const atrVal = signal.atr ?? 0;

  const prompt = `You are an autonomous spread betting signal engine for 1-minute scalping.
Analyse the data and decide whether to go LONG (BUY), SHORT (SELL), or SKIP this trade.
This is a ${signal.instrumentName} spread bet. Trades last 1–5 minutes typically.

Last 5 closed 1-minute candles (oldest first):
${candleStr}
RSI(14): ${signal.rsi?.toFixed(1) ?? 'N/A'}
MACD histogram: ${signal.macd !== null ? (signal.macd > 0 ? '+' : '') + signal.macd.toFixed(5) : 'N/A'} (positive=bullish)
ATR(14): ${atrVal.toFixed(2)} points (average candle range)
Technical suggestion: ${signal.suggestedDir}

Rules: enter BUY on upward momentum, SELL on downward momentum, SKIP if unclear or choppy.
Set stopPoints = how many price points away for stop loss (use ATR as guide, be realistic).
Set takeProfitPoints = points away for take profit (aim for at least 1.3:1 reward/risk ratio).

Respond with JSON only, no markdown, no explanation outside JSON:
{"direction":"BUY","confidence":72,"reason":"brief reason max 15 words","stopPoints":12,"takeProfitPoints":18}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 150 },
        }),
        signal: AbortSignal.timeout(8_000),
      }
    );

    if (!res.ok) {
      console.warn(`[gemini] API error ${res.status} — using fallback`);
      return fallbackVerdict(signal);
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text    = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed  = JSON.parse(cleaned) as {
      direction: string; confidence: number; reason: string;
      stopPoints: number; takeProfitPoints: number;
    };

    const dir = (['BUY', 'SELL', 'SKIP'].includes(parsed.direction)) ? parsed.direction as GeminiVerdict['direction'] : 'SKIP';

    return {
      direction:        dir,
      confidence:       Math.max(0, Math.min(100, parsed.confidence ?? 50)),
      reason:           parsed.reason ?? '',
      stopPoints:       Math.max(1, parsed.stopPoints ?? Math.round(atrVal * 1.5)),
      takeProfitPoints: Math.max(1, parsed.takeProfitPoints ?? Math.round(atrVal * 2)),
      engine:           'gemini',
    };
  } catch (e) {
    console.warn(`[gemini] Failed — fallback. ${e instanceof Error ? e.message : String(e)}`);
    return fallbackVerdict(signal);
  }
}

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

  const atrVal    = atr ?? 5;
  const stopPts   = Math.max(2, Math.round(atrVal * 1.5));
  const tpPts     = Math.max(3, Math.round(atrVal * 2.0));
  // Auto-size: smaller bet when volatile (high ATR), larger when calm
  const lastPrice = signal.lastCandles[signal.lastCandles.length - 1]?.close ?? 100;
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
  if (!apiKey) return fallbackVerdict(signal);

  const candleStr = signal.lastCandles.map((c, i) =>
    `  [${i + 1}] O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)} ${c.close >= c.open ? '▲' : '▼'}`
  ).join('\n');

  const atrVal = signal.atr ?? 0;

  const lastPrice = signal.lastCandles[signal.lastCandles.length - 1]?.close ?? 0;
  const atrPct    = lastPrice > 0 ? (atrVal / lastPrice * 100).toFixed(3) : 'N/A';

  const prompt = `You are an autonomous spread betting signal engine for 1-minute scalping.
Decide: go LONG (BUY), SHORT (SELL), or SKIP. Also set position size and levels.
Instrument: ${signal.instrumentName} — current price ~${lastPrice.toFixed(2)}

Last 5 closed 1-minute candles (oldest first):
${candleStr}
RSI(14): ${signal.rsi?.toFixed(1) ?? 'N/A'}
MACD histogram: ${signal.macd !== null ? (signal.macd > 0 ? '+' : '') + signal.macd.toFixed(5) : 'N/A'} (positive=bullish)
ATR(14): ${atrVal.toFixed(2)} pts (${atrPct}% of price) — volatility measure
Technical suggestion: ${signal.suggestedDir}

Guidelines:
- BUY on clear upward momentum, SELL on clear downward momentum, SKIP if choppy/unclear
- stopPoints: realistic stop loss in price points (1.5×ATR is a good baseline)
- takeProfitPoints: aim for ≥1.3:1 reward/risk vs stop
- betSize: £/pt stake — use 0.5 if volatile (ATR% > 0.5%), 1.0 if moderate, 1.5 if calm and high confidence

Respond with JSON only, no markdown:
{"direction":"BUY","confidence":72,"reason":"max 12 words","stopPoints":12,"takeProfitPoints":18,"betSize":0.5}`;

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
    console.warn(`[gemini] Failed — fallback. ${e instanceof Error ? e.message : String(e)}`);
    return fallbackVerdict(signal);
  }
}

export type GeminiVerdict = {
  decision:   'YES' | 'NO';
  confidence: number;   // 0-100
  reason:     string;
  engine:     'gemini' | 'fallback';
};

export type EntrySignal = {
  instrumentName: string;
  epic:           string;
  rsi:            number | null;
  macd:           number | null;  // MACD histogram — positive = bullish
  atr:            number | null;
  greenCount:     number;         // green candles in last 5
  lastCandles:    Array<{ open: number; high: number; low: number; close: number }>;
};

// Simple fallback when Gemini unavailable — mirrors old RSI-only logic
function fallbackVerdict(signal: EntrySignal): GeminiVerdict {
  const { rsi, macd, greenCount } = signal;

  let score = 0;
  if (rsi !== null) {
    if (rsi < 40)       score += 2;
    else if (rsi < 55)  score += 1;
    else if (rsi > 65)  score -= 2;
  }
  if (macd !== null) {
    if (macd > 0)  score += 1;
    else           score -= 1;
  }
  if (greenCount >= 3) score += 1;
  if (greenCount <= 1) score -= 1;

  const decision = score >= 1 ? 'YES' : 'NO';
  return {
    decision,
    confidence: Math.min(90, 50 + score * 10),
    reason:     `Rules: RSI=${rsi?.toFixed(0) ?? 'N/A'} MACD=${macd !== null ? (macd > 0 ? '+' : '') + macd.toFixed(4) : 'N/A'} greens=${greenCount}/5 score=${score}`,
    engine:     'fallback',
  };
}

export async function askGemini(signal: EntrySignal): Promise<GeminiVerdict> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fallbackVerdict(signal);

  const candleStr = signal.lastCandles.slice(-5).map((c, i) =>
    `  Candle -${signal.lastCandles.slice(-5).length - i}: O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)} ${c.close >= c.open ? '▲' : '▼'}`
  ).join('\n');

  const prompt = `You are a short-term trading signal validator for a 1-minute scalping bot.
The bot is considering entering a BUY position on ${signal.instrumentName}.

Technical data:
${candleStr}
RSI(14): ${signal.rsi !== null ? signal.rsi.toFixed(1) : 'insufficient data'}
MACD histogram: ${signal.macd !== null ? (signal.macd > 0 ? '+' : '') + signal.macd.toFixed(4) : 'insufficient data'} (positive = bullish momentum)
ATR(14): ${signal.atr !== null ? signal.atr.toFixed(2) : 'N/A'} (volatility measure)
Green candles in last 5: ${signal.greenCount}/5

The last candle just closed GREEN. The bot enters on green candle closes and exits on red candles or ≥0.5% loss.
Trades are typically held for 1-5 minutes.

Should the bot enter a BUY now? Consider momentum, RSI level, and whether this looks like a genuine upward move vs a false breakout.

Respond with JSON only, no markdown:
{"decision":"YES","confidence":75,"reason":"brief one-line reason"}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 120 },
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

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    // Strip markdown code fences if present
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed  = JSON.parse(cleaned) as { decision: string; confidence: number; reason: string };

    return {
      decision:   parsed.decision === 'YES' ? 'YES' : 'NO',
      confidence: Math.max(0, Math.min(100, parsed.confidence ?? 50)),
      reason:     parsed.reason ?? '',
      engine:     'gemini',
    };
  } catch (e) {
    console.warn(`[gemini] Failed — using fallback. Error: ${e instanceof Error ? e.message : String(e)}`);
    return fallbackVerdict(signal);
  }
}

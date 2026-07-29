import { NextRequest, NextResponse } from 'next/server';

type VerdictRequest = {
  instrumentName: string;
  direction:      'BUY' | 'SELL';
  strength:       number;
  price:          number;
  changePercent:  number;
  stopPoints:     number;
  tpPoints:       number;
  marketType:     string;
};

type GeminiVerdict = {
  direction:  'BUY' | 'SELL' | 'SKIP';
  confidence: number;
  reason:     string;
  engine:     'gemini' | 'passthrough';
};

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  const body   = await req.json() as VerdictRequest;

  if (!apiKey) {
    return NextResponse.json<GeminiVerdict>({
      direction:  body.direction,
      confidence: body.strength,
      reason:     'No Gemini key — using signal strength',
      engine:     'passthrough',
    });
  }

  const rrRatio = body.stopPoints > 0 ? (body.tpPoints / body.stopPoints).toFixed(1) : '?';
  const pctStr  = `${body.changePercent >= 0 ? '+' : ''}${body.changePercent.toFixed(2)}%`;

  const prompt = `You are a second-opinion filter for a spread betting strategy.
Signal: ${body.direction} ${body.instrumentName}
Price: ${body.price.toFixed(2)}, Daily change: ${pctStr}
Market type: ${body.marketType}
Signal strength: ${body.strength}%
Stop: ${body.stopPoints}pts, TP: ${body.tpPoints}pts (${rrRatio}:1 R:R)

Should we take this trade? Confirm, override, or SKIP if the setup looks poor.
Respond with JSON only, no markdown:
{"direction":"BUY","confidence":72,"reason":"max 12 words"}`;

  try {
    const res = await fetch(
      // "latest" alias, not a pinned dated model — gemini-2.0-flash was
      // retired outright (confirmed live: free-tier quota set to 0).
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents:         [{ parts: [{ text: prompt }] }],
          // No thinkingConfig — the alias resolves to a reasoning model that
          // rejects thinkingBudget outright (confirmed live: flat 400
          // INVALID_ARGUMENT). maxOutputTokens raised for headroom.
          generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
        }),
        signal: AbortSignal.timeout(8_000),
      }
    );

    if (!res.ok) {
      return NextResponse.json<GeminiVerdict>({ direction: body.direction, confidence: body.strength, reason: `Gemini ${res.status}`, engine: 'passthrough' });
    }

    const data    = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text    = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed  = JSON.parse(cleaned) as { direction: string; confidence: number; reason: string };

    const dir = (['BUY', 'SELL', 'SKIP'].includes(parsed.direction)) ? parsed.direction as GeminiVerdict['direction'] : 'SKIP';

    return NextResponse.json<GeminiVerdict>({
      direction:  dir,
      confidence: Math.max(0, Math.min(100, parsed.confidence ?? body.strength)),
      reason:     parsed.reason ?? '',
      engine:     'gemini',
    });
  } catch {
    return NextResponse.json<GeminiVerdict>({ direction: body.direction, confidence: body.strength, reason: 'Gemini failed — using signal', engine: 'passthrough' });
  }
}

import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 30;

export interface NewsHeadline {
  headline: string;
  source: string;
  datetime: string | number;
  url?: string;
}

export interface NewsSignal {
  headline: string;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number;
  affectedAssets: string[];
  action: 'CLOSE_LONG' | 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE_SHORT' | 'HOLD' | 'NONE';
  reasoning: string;
  urgency: 'HIGH' | 'MEDIUM' | 'LOW';
  url?: string;
}

export async function POST(request: Request) {
  try {
    const { headlines, openPositions, watchlist } = await request.json() as {
      headlines: NewsHeadline[];
      openPositions: { symbol: string; direction: string; size: number }[];
      watchlist: string[];
    };

    if (!headlines?.length) {
      return Response.json({ analysis: [], success: true });
    }

    const client = new Anthropic();

    const prompt = `You are a professional trading analyst. Analyse these news headlines and determine their impact on the following open positions and watchlist assets.

Open Positions: ${JSON.stringify(openPositions)}
Watchlist: ${JSON.stringify(watchlist)}

Headlines:
${headlines.slice(0, 30).map((h) => `- ${h.headline} (${h.source}, ${h.datetime})`).join('\n')}

For each headline that is relevant to any position or watchlist asset, respond with a JSON array:
[
  {
    "headline": "headline text",
    "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
    "confidence": 0-100,
    "affectedAssets": ["AAPL", "S&P 500"],
    "action": "CLOSE_LONG" | "OPEN_LONG" | "OPEN_SHORT" | "CLOSE_SHORT" | "HOLD" | "NONE",
    "reasoning": "brief explanation under 20 words",
    "urgency": "HIGH" | "MEDIUM" | "LOW"
  }
]

Rules:
- Only include headlines with confidence above 60%
- Only recommend CLOSE actions if confidence is above 75%
- Only recommend OPEN actions if confidence is above 70%
- HIGH urgency = immediate market-moving event (Fed decision, earnings, major geopolitical)
- Respond ONLY with the JSON array, no other text`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '[]';

    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

    try {
      const analysis = JSON.parse(cleaned) as NewsSignal[];
      return Response.json({ analysis: Array.isArray(analysis) ? analysis : [], success: true });
    } catch {
      return Response.json({ analysis: [], success: false, error: 'Failed to parse AI response' });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ analysis: [], success: false, error: msg }, { status: 500 });
  }
}

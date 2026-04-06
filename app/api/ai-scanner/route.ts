import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { ScanResult } from '@/lib/types';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { query } = body as { query: string };

  if (!query) {
    return NextResponse.json({ error: 'query is required' }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 503 });
  }

  const prompt = `Search for the very latest news about this stock or company: "${query}"

If given a company name (e.g. "Tesla", "Vodafone"), resolve it to the correct ticker symbol first.
For UK-listed stocks, use the .L suffix format (e.g. VOD.L, LLOY.L, BARC.L).

Search for recent news, earnings, analyst ratings, and market sentiment about this stock.

Then respond with ONLY a valid JSON object — no markdown, no explanation outside the JSON:

{
  "ticker": "exact ticker symbol (e.g. AAPL, VOD.L)",
  "companyName": "Full official company name",
  "signal": "BUY" or "SELL" or "HOLD",
  "confidence": <integer 0-100>,
  "riskScore": <integer 0-100, where 100 = highest risk>,
  "verdict": "PROCEED" or "CAUTION" or "REJECT",
  "reasoning": "2-3 sentence plain English explanation of why this signal was generated, referencing specific news",
  "market": "US" or "UK" or "OTHER",
  "articles": [
    {
      "headline": "Exact article headline",
      "source": "Publication name",
      "date": "YYYY-MM-DD or approximate date",
      "summary": "One sentence explaining why this article is relevant to the signal"
    }
  ],
  "timestamp": "${new Date().toISOString()}"
}

Rules:
- verdict must be PROCEED when signal=BUY and confidence>=60
- verdict must be REJECT when signal=SELL and confidence>=60
- verdict must be CAUTION in all other cases
- Include 3-5 of the most recent and relevant articles in the articles array
- For UK stocks and companies, use UK market context (LSE, FTSE, GBP)
- riskScore should reflect: market volatility + news sentiment negativity + company-specific risks`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      tools: [
        {
          type: 'web_search_20250305' as const,
          name: 'web_search',
          max_uses: 5,
        },
      ],
      messages: [{ role: 'user', content: prompt }],
    });

    // Extract the final text block
    let jsonText = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        jsonText = block.text;
      }
    }

    // Parse JSON — strip any markdown fences if present
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');

    const result: ScanResult = JSON.parse(jsonMatch[0]);

    // Enforce verdict logic in case model got it wrong
    if (result.signal === 'BUY' && result.confidence >= 60) result.verdict = 'PROCEED';
    else if (result.signal === 'SELL' && result.confidence >= 60) result.verdict = 'REJECT';
    else result.verdict = 'CAUTION';

    return NextResponse.json(result);
  } catch (err) {
    console.error('[scanner] error:', err);
    return NextResponse.json(
      { error: `Scan failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}

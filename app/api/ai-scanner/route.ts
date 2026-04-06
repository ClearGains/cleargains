import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { Signal } from '@/lib/types';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { ticker, country = 'GB' } = body as { ticker: string; country: string };

  if (!ticker) {
    return NextResponse.json({ error: 'ticker is required' }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    // Return mock signal for demo
    const mockSignal: Signal = {
      ticker: ticker.toUpperCase(),
      signal: 'HOLD',
      riskScore: 55,
      confidence: 40,
      reasoning:
        'ANTHROPIC_API_KEY not configured. This is a simulated signal for demonstration purposes only. Please configure your API key to get real AI analysis.',
      sources: ['ClearGains Simulation'],
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(mockSignal);
  }

  try {
    const systemPrompt = `You are a professional stock analyst providing educational analysis for ClearGains, a simulation tool.
You must always emphasise that your analysis is for educational purposes only and not financial advice.
Analyse stocks objectively using available information and provide structured assessments.
Always respond with valid JSON matching the Signal type exactly.`;

    const userPrompt = `Analyse the stock ticker "${ticker.toUpperCase()}" for a ${country} investor and provide:
1. A BUY, SELL, or HOLD signal
2. A risk score from 0-100 (0=lowest risk, 100=highest risk)
3. A confidence percentage (0-100)
4. A clear reasoning paragraph (2-3 sentences)
5. List of news/data sources you referenced

Search for recent news about ${ticker.toUpperCase()} including:
- Latest earnings results
- Recent analyst ratings
- News headlines from the past 30 days
- Technical chart signals

Respond ONLY with a JSON object in this exact format:
{
  "ticker": "${ticker.toUpperCase()}",
  "signal": "BUY" | "SELL" | "HOLD",
  "riskScore": <number 0-100>,
  "confidence": <number 0-100>,
  "reasoning": "<2-3 sentence analysis>",
  "sources": ["<source1>", "<source2>", ...],
  "timestamp": "${new Date().toISOString()}"
}`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      tools: [
        {
          type: 'web_search_20250305' as const,
          name: 'web_search',
          max_uses: 3,
        },
      ],
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // Extract the text content from the response
    let jsonText = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        jsonText = block.text;
        break;
      }
    }

    // Extract JSON from the response
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in AI response');
    }

    const signal: Signal = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (!signal.ticker || !signal.signal || typeof signal.riskScore !== 'number') {
      throw new Error('Invalid signal structure from AI');
    }

    return NextResponse.json(signal);
  } catch (err) {
    console.error('AI scanner error:', err);

    // Return a fallback signal on error
    const fallbackSignal: Signal = {
      ticker: ticker.toUpperCase(),
      signal: 'HOLD',
      riskScore: 50,
      confidence: 30,
      reasoning: `Analysis unavailable at this time. Error: ${err instanceof Error ? err.message : 'Unknown error'}. Please try again later.`,
      sources: [],
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(fallbackSignal, { status: 200 });
  }
}

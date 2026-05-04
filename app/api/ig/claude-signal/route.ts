import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { calcIndicators, type Candle } from '@/lib/indicators';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type AISignal = {
  signal:          'BUY' | 'SELL' | 'HOLD' | 'WATCH';
  confidence:      number;
  timeframe:       string;
  entry_point:     number;
  take_profit:     number;
  stop_loss:       number;
  risk_reward_ratio: number;
  reasoning:       string;
  risk_level:      'LOW' | 'MEDIUM' | 'HIGH';
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      epic:           string;
      instrumentName: string;
      candles:        Candle[];
      bid:            number;
      offer:          number;
      percentageChange?: number;
      currency:       string;
    };

    if (!body.candles?.length || body.candles.length < 20) {
      return NextResponse.json({ ok: false, error: 'Need at least 20 candles for analysis' }, { status: 400 });
    }

    const ind = calcIndicators(body.candles);
    const latest = ind.latest;
    const last90 = body.candles.slice(-90);
    const mid = (body.bid + body.offer) / 2;
    const spreadPct = ((body.offer - body.bid) / mid * 100).toFixed(3);

    const prompt = `You are a professional financial analyst. Analyse the following spread-bet market data and return ONLY a JSON object — no markdown, no explanation outside the JSON.

Instrument: ${body.instrumentName} (${body.epic})
Currency: ${body.currency}
Current Price: bid=${body.bid}, offer=${body.offer}, mid=${mid.toFixed(4)}
Spread: ${spreadPct}%
Today's Change: ${body.percentageChange?.toFixed(2) ?? 'N/A'}%

Technical Indicators (last calculated):
- RSI(14): ${latest.rsi?.toFixed(2) ?? 'N/A'} [${latest.rsiZone ?? 'N/A'}]
- MACD Line: ${latest.macdLine?.toFixed(4) ?? 'N/A'}
- MACD Signal: ${latest.macdSignal?.toFixed(4) ?? 'N/A'}
- MACD Histogram: ${latest.macdHist?.toFixed(4) ?? 'N/A'} [${latest.macdZone ?? 'N/A'}]
- SMA20: ${latest.sma20?.toFixed(4) ?? 'N/A'}
- SMA50: ${latest.sma50?.toFixed(4) ?? 'N/A'}
- SMA Cross: ${latest.smaCross}
- Bollinger Upper: ${latest.bbUpper?.toFixed(4) ?? 'N/A'}
- Bollinger Mid: ${latest.bbMid?.toFixed(4) ?? 'N/A'}
- Bollinger Lower: ${latest.bbLower?.toFixed(4) ?? 'N/A'}
- Price vs BB: ${latest.bbPosition ?? 'N/A'}

Last 90 days OHLCV (most recent last):
${last90.map(c => `${c.time.slice(0,10)} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`).join('\n')}

Return ONLY this JSON (no other text):
{
  "signal": "BUY" | "SELL" | "HOLD" | "WATCH",
  "confidence": <1-10>,
  "timeframe": "short-term (days)" | "medium-term (weeks)",
  "entry_point": <number>,
  "take_profit": <number>,
  "stop_loss": <number>,
  "risk_reward_ratio": <number>,
  "reasoning": "<2-3 sentence explanation>",
  "risk_level": "LOW" | "MEDIUM" | "HIGH"
}`;

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
    // Strip any markdown fences
    const clean = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const signal = JSON.parse(clean) as AISignal;

    return NextResponse.json({ ok: true, signal });
  } catch (err) {
    console.error('[claude-signal]', err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

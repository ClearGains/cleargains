import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { summarizeIndicators, type LWCandle } from '@/lib/chartIndicators';
import { calcSupportResistance } from '@/lib/supportResistance';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type TradeRec = {
  timeframe: 'scalp' | 'swing';
  direction: 'LONG' | 'SHORT' | 'FLAT';
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskReward: number;
  confidence: number;
  reasoning: string;
  invalidation: string;
};

export type AnalysisResult = {
  ticker: string;
  price: number;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  summary: string;
  keyLevels: { label: string; price: number; type: 'support' | 'resistance' }[];
  scalp: TradeRec;
  swing: TradeRec;
  risks: string[];
  catalysts: string[];
};

export async function POST(req: NextRequest) {
  try {
    const { ticker, candles, resolution } = await req.json() as {
      ticker: string;
      candles: LWCandle[];
      resolution: string;
    };

    if (!candles?.length || candles.length < 20) {
      return NextResponse.json({ error: 'Need at least 20 candles' }, { status: 400 });
    }

    const ind    = summarizeIndicators(candles);
    const sr     = calcSupportResistance(candles);
    const last   = candles[candles.length - 1];
    const price  = Number(last.close);

    const srText = sr.length
      ? sr.map(z => `${z.type.toUpperCase()} @ ${z.price.toFixed(4)} (${z.strength} touches)`).join('\n')
      : 'Insufficient data';

    const prompt = `You are an experienced prop trader. Analyse the following technical data and produce structured trade setups.

TICKER: ${ticker}  |  RESOLUTION: ${resolution}  |  CURRENT PRICE: ${price}

=== INDICATORS ===
RSI(14): ${ind.rsi?.toFixed(2) ?? 'N/A'} [${ind.rsiTrend}]
MACD: line=${ind.macdValue.toFixed(4)} signal=${ind.macdSignal.toFixed(4)} hist=${ind.macdHist.toFixed(4)} [${ind.macdCross} cross]
SMA20: ${ind.sma20?.toFixed(4) ?? 'N/A'}  SMA50: ${ind.sma50?.toFixed(4) ?? 'N/A'}  SMA200: ${ind.sma200?.toFixed(4) ?? 'N/A'}
BB: upper=${ind.bbUpper?.toFixed(4) ?? 'N/A'} mid=${ind.bbMid?.toFixed(4) ?? 'N/A'} lower=${ind.bbLower?.toFixed(4) ?? 'N/A'} width=${ind.bbWidth?.toFixed(2) ?? 'N/A'}%
Price vs BB: ${ind.priceVsBB ?? 'N/A'}

=== SUPPORT / RESISTANCE ===
${srText}

Return ONLY valid JSON with this exact shape (no markdown, no extra text):
{
  "bias": "BULLISH" | "BEARISH" | "NEUTRAL",
  "summary": "<2-3 sentence market structure summary>",
  "keyLevels": [{ "label": "<label>", "price": <number>, "type": "support" | "resistance" }],
  "scalp": {
    "timeframe": "scalp",
    "direction": "LONG" | "SHORT" | "FLAT",
    "entry": <number>,
    "stopLoss": <number>,
    "takeProfit1": <number>,
    "takeProfit2": <number>,
    "riskReward": <number>,
    "confidence": <1-10>,
    "reasoning": "<concise reasoning>",
    "invalidation": "<what invalidates this setup>"
  },
  "swing": {
    "timeframe": "swing",
    "direction": "LONG" | "SHORT" | "FLAT",
    "entry": <number>,
    "stopLoss": <number>,
    "takeProfit1": <number>,
    "takeProfit2": <number>,
    "riskReward": <number>,
    "confidence": <1-10>,
    "reasoning": "<concise reasoning>",
    "invalidation": "<what invalidates this setup>"
  },
  "risks": ["<risk1>", "<risk2>", "<risk3>"],
  "catalysts": ["<catalyst1>", "<catalyst2>"]
}`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Claude returned no JSON. Raw response: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(match[0]) as Omit<AnalysisResult, 'ticker' | 'price'>;

    return NextResponse.json({ ticker: ticker.toUpperCase(), price, ...parsed });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

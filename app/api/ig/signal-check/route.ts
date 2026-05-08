import { NextRequest, NextResponse } from 'next/server';
import { calcIndicators, type Candle, type IndicatorResult } from '@/lib/indicators';

type RawSignal = 'BUY' | 'SELL' | 'HOLD' | 'WATCH';

interface CheckResult {
  signal:      RawSignal;
  confidence:  number;
  shouldClose: boolean;
  reasoning:   string;
  checkedAt:   string;
}

// 15-minute server cache per epic — reduces IG price API calls
const cache = new Map<string, { result: CheckResult; expiresAt: number }>();
const CACHE_TTL = 15 * 60_000;

function igHdr(apiKey: string, cst: string, token: string, v = '3') {
  return { 'X-IG-API-KEY': apiKey, 'CST': cst, 'X-SECURITY-TOKEN': token, 'Accept': 'application/json; charset=UTF-8', 'Version': v };
}

function shouldClose(signal: RawSignal, confidence: number, openDir: 'BUY' | 'SELL'): boolean {
  if (confidence < 7) return false;
  if (openDir === 'BUY'  && signal === 'SELL') return true;
  if (openDir === 'SELL' && signal === 'BUY')  return true;
  return false;
}

// ── Rule-based signal (free — no LLM needed) ─────────────────────────────────
// Uses the same technical indicators that were previously fed to Claude Haiku.
// Score accumulates from multiple indicators; magnitude → confidence.
function ruleSignal(ind: IndicatorResult, bid: number, offer: number): {
  signal: RawSignal; confidence: number; reasoning: string;
} {
  const l = ind.latest;
  let score = 0;
  const reasons: string[] = [];

  // RSI — strongest reversal signal
  if (l.rsi !== null && l.rsi !== undefined) {
    if      (l.rsi >= 78) { score -= 3;   reasons.push(`RSI ${l.rsi.toFixed(0)} — strongly overbought`); }
    else if (l.rsi >= 68) { score -= 1.5; reasons.push(`RSI ${l.rsi.toFixed(0)} — overbought`); }
    else if (l.rsi <= 22) { score += 3;   reasons.push(`RSI ${l.rsi.toFixed(0)} — strongly oversold`); }
    else if (l.rsi <= 32) { score += 1.5; reasons.push(`RSI ${l.rsi.toFixed(0)} — oversold`); }
    else if (l.rsi >= 55) { score -= 0.5; }
    else if (l.rsi <= 45) { score += 0.5; }
  }

  // MACD — trend / momentum (compare last two histogram bars to detect divergence)
  if (l.macdHist !== null && l.macdHist !== undefined &&
      l.macdLine !== null && l.macdLine !== undefined &&
      l.macdSignal !== null && l.macdSignal !== undefined) {
    const hist      = l.macdHist;
    const prevBar   = ind.macd.at(-2);
    const prevHist  = prevBar?.hist ?? hist;
    const expanding = Math.abs(hist) > Math.abs(prevHist ?? 0);
    if (hist > 0 && l.macdLine > l.macdSignal) {
      score += expanding ? 2 : 1;
      reasons.push(`MACD bullish${expanding ? ' & expanding' : ''}`);
    } else if (hist < 0 && l.macdLine < l.macdSignal) {
      score -= expanding ? 2 : 1;
      reasons.push(`MACD bearish${expanding ? ' & expanding' : ''}`);
    } else if (hist > 0 && !expanding) {
      score -= 0.5; reasons.push('MACD bullish but diverging (momentum fading)');
    } else if (hist < 0 && !expanding) {
      score += 0.5; reasons.push('MACD bearish but diverging (momentum fading)');
    }
  }

  // Bollinger Bands — mean-reversion
  const mid = (bid + offer) / 2;
  if (l.bbUpper != null && l.bbLower != null) {
    if      (mid > l.bbUpper * 1.002) { score -= 2;   reasons.push('Price above upper BB (overextended)'); }
    else if (mid > l.bbUpper)          { score -= 1;   reasons.push('Price at upper BB'); }
    else if (mid < l.bbLower * 0.998) { score += 2;   reasons.push('Price below lower BB (overextended)'); }
    else if (mid < l.bbLower)          { score += 1;   reasons.push('Price at lower BB'); }
  }

  // SMA trend
  if (l.sma20 != null && l.sma50 != null) {
    if      (l.smaCross === 'bullish') { score += 1;   reasons.push('SMA20 > SMA50 (uptrend)'); }
    else if (l.smaCross === 'bearish') { score -= 1;   reasons.push('SMA20 < SMA50 (downtrend)'); }
    if (mid > l.sma20 * 1.01)         { score -= 0.5; }
    else if (mid < l.sma20 * 0.99)    { score += 0.5; }
  }

  // Map score → signal
  const abs = Math.abs(score);
  let signal: RawSignal;
  if      (score >=  3.0) signal = 'BUY';
  else if (score <= -3.0) signal = 'SELL';
  else if (abs    >=  1.5) signal = 'WATCH';
  else                     signal = 'HOLD';

  // Confidence: 1–10 scaled from score magnitude
  const confidence = Math.min(10, Math.max(1, Math.round(3 + abs * 1.4)));

  const dir = score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral';
  const reasoning = reasons.length
    ? reasons.slice(0, 3).join('; ')
    : `Mixed signals — ${dir} lean with score ${score.toFixed(1)}`;

  return { signal, confidence, reasoning };
}

export async function POST(request: NextRequest) {
  try {
    const cst   = request.headers.get('x-ig-cst') ?? '';
    const token = request.headers.get('x-ig-security-token') ?? '';
    const key   = request.headers.get('x-ig-api-key') ?? '';
    const env   = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

    if (!cst || !token || !key) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }

    const body = await request.json() as { epic: string; direction: 'BUY' | 'SELL'; instrumentName?: string };
    const { epic, direction, instrumentName } = body;
    if (!epic || !direction) {
      return NextResponse.json({ ok: false, error: 'epic and direction required' }, { status: 400 });
    }

    // Return cached result if still fresh
    const cacheKey = `${env}:${epic}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return NextResponse.json({
        ok: true,
        ...hit.result,
        shouldClose: shouldClose(hit.result.signal, hit.result.confidence, direction),
        cached: true,
      });
    }

    const base = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    // ── Fetch hourly candles ──────────────────────────────────────────────────
    const priceRes = await fetch(
      `${base}/prices/${encodeURIComponent(epic)}?resolution=HOUR&max=100&pageSize=100&pageNumber=1`,
      { headers: igHdr(key, cst, token, '3') },
    );
    if (!priceRes.ok) {
      const t = await priceRes.text();
      return NextResponse.json({ ok: false, error: `IG prices ${priceRes.status}: ${t.slice(0, 200)}` }, { status: 502 });
    }
    const priceData = await priceRes.json() as {
      prices?: Array<{
        snapshotTimeUTC?: string; snapshotTime: string;
        openPrice:  { bid: number; ask: number };
        highPrice:  { bid: number; ask: number };
        lowPrice:   { bid: number; ask: number };
        closePrice: { bid: number; ask: number };
        lastTradedVolume: number;
      }>;
    };
    const candles: Candle[] = (priceData.prices ?? []).map(p => ({
      time:   p.snapshotTimeUTC ?? p.snapshotTime,
      open:   (p.openPrice.bid  + p.openPrice.ask)  / 2,
      high:   (p.highPrice.bid  + p.highPrice.ask)  / 2,
      low:    (p.lowPrice.bid   + p.lowPrice.ask)   / 2,
      close:  (p.closePrice.bid + p.closePrice.ask) / 2,
      volume: p.lastTradedVolume,
    }));

    if (candles.length < 20) {
      return NextResponse.json({ ok: false, error: 'Insufficient candle data (need ≥ 20 bars)' }, { status: 422 });
    }

    // ── Fetch live bid/offer ──────────────────────────────────────────────────
    let bid   = candles[candles.length - 1].close;
    let offer = bid;
    try {
      const snapRes = await fetch(`${base}/markets/${encodeURIComponent(epic)}`, {
        headers: igHdr(key, cst, token, '3'),
        signal: AbortSignal.timeout(5_000),
      });
      if (snapRes.ok) {
        const snap = await snapRes.json() as { snapshot?: { bid: number; offer: number } };
        if (snap.snapshot) { bid = snap.snapshot.bid; offer = snap.snapshot.offer; }
      }
    } catch { /* fall back to last close */ }

    const ind  = calcIndicators(candles);
    const l    = ind.latest;
    const mid  = (bid + offer) / 2;
    const last90 = candles.slice(-90);

    // ── Gemini Flash (free tier) — used when GEMINI_API_KEY is set ─────────────
    // Falls back to rule-based engine when key is absent or Gemini errors.
    let signal:    RawSignal = 'HOLD';
    let confidence = 5;
    let reasoning  = '';
    let usedEngine = 'rules';

    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const prompt = `You are a financial analyst deciding whether to EXIT an open spread-bet position.

Instrument: ${instrumentName ?? epic}
Current: bid=${bid}, offer=${offer}, mid=${mid.toFixed(4)}, spread=${((offer - bid) / mid * 100).toFixed(3)}%

Indicators:
RSI(14)=${l.rsi?.toFixed(2) ?? 'N/A'} [${l.rsiZone ?? 'N/A'}]
MACD line=${l.macdLine?.toFixed(4) ?? 'N/A'} signal=${l.macdSignal?.toFixed(4) ?? 'N/A'} hist=${l.macdHist?.toFixed(4) ?? 'N/A'} [${l.macdZone ?? 'N/A'}]
SMA20=${l.sma20?.toFixed(4) ?? 'N/A'} SMA50=${l.sma50?.toFixed(4) ?? 'N/A'} cross=${l.smaCross}
BB upper=${l.bbUpper?.toFixed(4) ?? 'N/A'} lower=${l.bbLower?.toFixed(4) ?? 'N/A'} position=${l.bbPosition ?? 'N/A'}

Last 90 hourly bars (most recent last):
${last90.map(c => `${c.time.slice(0, 16)} O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)}`).join('\n')}

Return ONLY this JSON (no markdown, no other text):
{"signal":"BUY"|"SELL"|"HOLD"|"WATCH","confidence":<1-10>,"reasoning":"<2 sentences on current direction and momentum>"}`;

        const gRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 256, temperature: 0.1 },
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );

        if (gRes.ok) {
          const gData = await gRes.json() as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const raw   = gData.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
          const clean = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
          const parsed = JSON.parse(clean) as { signal?: string; confidence?: number; reasoning?: string };
          signal     = (parsed.signal ?? 'HOLD') as RawSignal;
          confidence = Math.min(10, Math.max(1, parsed.confidence ?? 5));
          reasoning  = parsed.reasoning ?? '';
          usedEngine = 'gemini-2.0-flash';
        }
      } catch {
        // Gemini failed — fall through to rule-based
      }
    }

    // Rule-based fallback (or primary when no Gemini key)
    if (usedEngine === 'rules') {
      const r = ruleSignal(ind, bid, offer);
      signal     = r.signal;
      confidence = r.confidence;
      reasoning  = r.reasoning;
    }

    const result: CheckResult = {
      signal,
      confidence,
      shouldClose: shouldClose(signal, confidence, direction),
      reasoning,
      checkedAt: new Date().toISOString(),
    };

    cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL });

    return NextResponse.json({ ok: true, ...result, engine: usedEngine, cached: false });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

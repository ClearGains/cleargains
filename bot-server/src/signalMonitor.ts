import { fetchPositions, closePosition, getSession, type IGSession, type IGPosition } from './igApi';
import { calcRsi, calcMacdHist, calcAtr, isRed, isGreen, type CandleTick } from './scalperStrategy';
import { askGemini } from './gemini';

// Candle accumulator for ALL monitored epics (scalper + external positions)
export const monitorCandles = new Map<string, CandleTick[]>();

export function feedCandle(epic: string, tick: CandleTick) {
  if (!tick.candleClosed) return;
  const arr = monitorCandles.get(epic) ?? [];
  arr.push(tick);
  if (arr.length > 40) arr.splice(0, arr.length - 40);
  monitorCandles.set(epic, arr);
}

type LogFn = (type: 'info' | 'exit' | 'error' | 'wait', epic: string, msg: string) => void;

export async function runSignalCheck(
  scalperManagedEpics: string[],
  addLog: LogFn,
  sessionOverride?: IGSession | null,
): Promise<string[]> {
  const session = sessionOverride ?? getSession();
  if (!session) return [];

  let positions: IGPosition[];
  try { positions = await fetchPositions(session); }
  catch { return []; }

  if (positions.length === 0) return [];

  const newEpics: string[] = [];

  for (const pos of positions) {
    const { epic, direction, dealId, size } = pos;
    const shortName = epic.split('.').slice(0, 3).join('.');

    // If scalper manages this epic, skip — it already handles exits
    if (scalperManagedEpics.includes(epic)) continue;

    // Ensure we're subscribed to this epic's candles
    if (!monitorCandles.has(epic)) {
      newEpics.push(epic);
      continue;  // need to accumulate data first
    }

    const candles = monitorCandles.get(epic)!;
    if (candles.length < 15) {
      addLog('info', shortName, `⏳ Signal monitor: accumulating data (${candles.length}/15 candles)`);
      continue;
    }

    const rsi  = calcRsi(candles);
    const macd = calcMacdHist(candles);
    const atr  = calcAtr(candles);
    const last5GreenCount = candles.slice(-5).filter(isGreen).length;
    const last = candles[candles.length - 1];

    const isLong = direction === 'BUY';

    // Signal scoring — same logic as the app's signal-check route
    let score = 0;
    let reasons: string[] = [];

    if (isLong) {
      // Looking for reasons to EXIT a long
      if (rsi !== null && rsi > 68)  { score++; reasons.push(`RSI overbought ${rsi.toFixed(0)}`); }
      if (rsi !== null && rsi > 75)  { score++; reasons.push(`RSI very overbought`); }
      if (macd !== null && macd < 0) { score++; reasons.push(`MACD histogram bearish`); }
      if (last5GreenCount <= 1)      { score++; reasons.push(`only ${last5GreenCount}/5 green candles`); }
      if (isRed(last))               { score++; reasons.push(`last candle red`); }
    } else {
      // Looking for reasons to EXIT a short
      if (rsi !== null && rsi < 32)  { score++; reasons.push(`RSI oversold ${rsi.toFixed(0)}`); }
      if (rsi !== null && rsi < 25)  { score++; reasons.push(`RSI very oversold`); }
      if (macd !== null && macd > 0) { score++; reasons.push(`MACD histogram bullish`); }
      if (last5GreenCount >= 4)      { score++; reasons.push(`${last5GreenCount}/5 green candles`); }
      if (isGreen(last))             { score++; reasons.push(`last candle green`); }
    }

    if (score < 2) continue;  // not enough signal to bother Gemini

    addLog('info', shortName, `🔍 Signal monitor: ${isLong ? 'LONG' : 'SHORT'} — ${reasons.join(', ')} (score ${score})`);

    // Ask Gemini to confirm
    const closeDir = isLong ? 'SELL' : 'BUY';
    const verdict = await askGemini({
      instrumentName: shortName,
      epic,
      rsi, macd, atr,
      greenCount:  last5GreenCount,
      suggestedDir: closeDir,
      lastCandles: candles.slice(-5).map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close })),
    });

    addLog('info', shortName,
      `🤖 Signal monitor Gemini: ${verdict.direction} ${verdict.confidence}% — ${verdict.reason}`
    );

    const geminiAgrees = verdict.direction === closeDir && verdict.confidence >= 60;
    if (!geminiAgrees) {
      addLog('wait', shortName, `✋ Gemini not convinced — holding ${isLong ? 'LONG' : 'SHORT'}`);
      continue;
    }

    // Close the position
    try {
      await closePosition(session, dealId, direction, size);
      addLog('exit', shortName, `✓ Signal monitor closed ${direction} position (deal ${dealId}) — ${reasons[0]}`);
    } catch (e) {
      addLog('error', shortName, `✗ Signal monitor close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return [...new Set(newEpics)];
}

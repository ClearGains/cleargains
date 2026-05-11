import { calcRsi, calcMacdHist, calcAtr, isRed, isGreen, type CandleTick } from './scalperStrategy';
// fetchPositions / closePosition / getSession intentionally removed — data-only mode.

// Candle accumulator for ALL monitored epics
export const monitorCandles = new Map<string, CandleTick[]>();

export function feedCandle(epic: string, tick: CandleTick) {
  if (!tick.candleClosed) return;
  const arr = monitorCandles.get(epic) ?? [];
  arr.push(tick);
  if (arr.length > 40) arr.splice(0, arr.length - 40);
  monitorCandles.set(epic, arr);
}

type LogFn = (type: 'info' | 'exit' | 'error' | 'wait', epic: string, msg: string) => void;

// runSignalCheck is kept for API compatibility but no longer closes positions.
// It returns indicator analysis only — actual closes happen in the frontend.
export async function runSignalCheck(
  scalperManagedEpics: string[],
  addLog: LogFn,
): Promise<string[]> {
  const newEpics: string[] = [];

  for (const [epic, candles] of monitorCandles) {
    if (scalperManagedEpics.includes(epic)) continue;
    if (candles.length < 15) continue;

    const shortName = epic.split('.').slice(0, 3).join('.');
    const rsi  = calcRsi(candles);
    const macd = calcMacdHist(candles);
    const last = candles[candles.length - 1];
    const last5GreenCount = candles.slice(-5).filter(isGreen).length;

    let score = 0;
    const reasons: string[] = [];
    if (rsi !== null && rsi > 68) { score++; reasons.push(`RSI overbought ${rsi.toFixed(0)}`); }
    if (macd !== null && macd < 0) { score++; reasons.push(`MACD bearish`); }
    if (last5GreenCount <= 1) { score++; reasons.push(`${last5GreenCount}/5 green`); }
    if (isRed(last)) { score++; reasons.push(`red candle`); }

    if (score >= 2) addLog('info', shortName, `📊 Monitor: ${reasons.join(', ')} (score ${score}) — no action, data only`);
  }

  void calcAtr; // keep import used
  return newEpics;
}

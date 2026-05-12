"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.monitorCandles = void 0;
exports.feedCandle = feedCandle;
exports.runSignalCheck = runSignalCheck;
const scalperStrategy_1 = require("./scalperStrategy");
// fetchPositions / closePosition / getSession intentionally removed — data-only mode.
// Candle accumulator for ALL monitored epics
exports.monitorCandles = new Map();
function feedCandle(epic, tick) {
    if (!tick.candleClosed)
        return;
    const arr = exports.monitorCandles.get(epic) ?? [];
    arr.push(tick);
    if (arr.length > 40)
        arr.splice(0, arr.length - 40);
    exports.monitorCandles.set(epic, arr);
}
// runSignalCheck is kept for API compatibility but no longer closes positions.
// It returns indicator analysis only — actual closes happen in the frontend.
async function runSignalCheck(scalperManagedEpics, addLog) {
    const newEpics = [];
    for (const [epic, candles] of exports.monitorCandles) {
        if (scalperManagedEpics.includes(epic))
            continue;
        if (candles.length < 15)
            continue;
        const shortName = epic.split('.').slice(0, 3).join('.');
        const rsi = (0, scalperStrategy_1.calcRsi)(candles);
        const macd = (0, scalperStrategy_1.calcMacdHist)(candles);
        const last = candles[candles.length - 1];
        const last5GreenCount = candles.slice(-5).filter(scalperStrategy_1.isGreen).length;
        let score = 0;
        const reasons = [];
        if (rsi !== null && rsi > 68) {
            score++;
            reasons.push(`RSI overbought ${rsi.toFixed(0)}`);
        }
        if (macd !== null && macd < 0) {
            score++;
            reasons.push(`MACD bearish`);
        }
        if (last5GreenCount <= 1) {
            score++;
            reasons.push(`${last5GreenCount}/5 green`);
        }
        if ((0, scalperStrategy_1.isRed)(last)) {
            score++;
            reasons.push(`red candle`);
        }
        if (score >= 2)
            addLog('info', shortName, `📊 Monitor: ${reasons.join(', ')} (score ${score}) — no action, data only`);
    }
    void scalperStrategy_1.calcAtr; // keep import used
    return newEpics;
}

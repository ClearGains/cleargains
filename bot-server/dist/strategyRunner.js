"use strict";
// strategyRunner — DATA-ONLY mode.
// openPosition / closePosition removed. This file generates signals only;
// all trade execution is handled by the frontend IG Spread Bet tab.
Object.defineProperty(exports, "__esModule", { value: true });
exports.startStrategyRunner = startStrategyRunner;
exports.stopStrategyRunner = stopStrategyRunner;
exports.getStrategyRunnerStatus = getStrategyRunnerStatus;
let running = false;
let config = null;
let scanTimer = null;
const runLog = [];
function uid() { return Math.random().toString(36).slice(2, 9); }
function addLog(type, msg) {
    const entry = {
        id: uid(),
        ts: new Date().toLocaleTimeString('en-GB', { hour12: false }),
        type, msg,
    };
    runLog.unshift(entry);
    if (runLog.length > 200)
        runLog.splice(200);
    console.log(`[strategyRunner] [${type.toUpperCase()}] ${msg}`);
}
function calibrateSignal(changePercent, mType) {
    const pct = Math.abs(changePercent);
    const dir = changePercent > 0.3 ? 'BUY' : changePercent < -0.3 ? 'SELL' : 'HOLD';
    let strength;
    switch (mType) {
        case 'INDEX':
            strength = pct >= 1.0 ? 85 : pct >= 0.5 ? 75 : pct >= 0.3 ? 65 : Math.round((pct / 0.3) * 60);
            break;
        case 'FOREX':
            strength = pct >= 0.3 ? 85 : pct >= 0.2 ? 75 : pct >= 0.1 ? 65 : Math.round((pct / 0.1) * 60);
            break;
        case 'COMMODITY':
            strength = pct >= 2.0 ? 85 : pct >= 1.0 ? 75 : pct >= 0.5 ? 65 : Math.round((pct / 0.5) * 60);
            break;
        case 'CRYPTO':
            strength = pct >= 3.0 ? 85 : pct >= 2.0 ? 75 : pct >= 1.0 ? 65 : Math.round((pct / 1.0) * 60);
            break;
        default:
            strength = pct >= 2.0 ? 85 : pct >= 1.0 ? 75 : pct >= 0.5 ? 65 : Math.round((pct / 0.5) * 60);
            break;
    }
    return { direction: dir, strength: Math.min(99, Math.max(0, strength)) };
}
async function fetchPrice(market) {
    try {
        const r = await fetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(market.yahooSymbol)}`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: AbortSignal.timeout(8_000) });
        if (!r.ok)
            return null;
        const data = await r.json();
        const q = data.quoteResponse?.result?.[0];
        if (!q)
            return null;
        return { price: q.regularMarketPrice ?? 0, changePercent: q.regularMarketChangePercent ?? 0 };
    }
    catch {
        return null;
    }
}
async function runScan() {
    if (!config || !running)
        return;
    addLog('info', `Scanning ${config.markets.length} market(s) — signal only, no orders`);
    for (const market of config.markets) {
        if (!running)
            break;
        const snap = await fetchPrice(market);
        if (!snap) {
            addLog('error', `${market.name}: price fetch failed`);
            continue;
        }
        const { direction, strength } = calibrateSignal(snap.changePercent, market.marketType);
        const pctStr = `${snap.changePercent >= 0 ? '+' : ''}${snap.changePercent.toFixed(2)}%`;
        if (direction === 'HOLD' || strength < config.minStrength) {
            addLog('info', `${market.name}: ${pctStr} — ${direction} ${strength}% (below ${config.minStrength}%)`);
            continue;
        }
        addLog('info', `${market.name}: ↑ SIGNAL ${direction} ${strength}% @ ${snap.price.toFixed(2)} (${pctStr}) — no order placed`);
    }
}
function startStrategyRunner(cfg) {
    stopStrategyRunner();
    config = cfg;
    running = true;
    runLog.length = 0;
    addLog('info', `Started (signal-only) — ${cfg.markets.length} market(s), min ${cfg.minStrength}%, scan every ${cfg.scanIntervalMs / 60_000}min`);
    void runScan();
    scanTimer = setInterval(() => { void runScan(); }, cfg.scanIntervalMs);
    return { ok: true };
}
function stopStrategyRunner() {
    if (scanTimer) {
        clearInterval(scanTimer);
        scanTimer = null;
    }
    if (running)
        addLog('info', 'Stopped');
    running = false;
    config = null;
}
function getStrategyRunnerStatus() {
    return { running, config, log: runLog.slice(0, 100), openTrades: [] };
}

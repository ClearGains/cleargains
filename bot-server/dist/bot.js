"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadSavedState = loadSavedState;
exports.startBot = startBot;
exports.stopBot = stopBot;
exports.pauseBot = pauseBot;
exports.resumeBot = resumeBot;
exports.injectPosition = injectPosition;
exports.getBotStatus = getBotStatus;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const igApi_1 = require("./igApi");
// openPosition / closePosition intentionally removed — this bot is data-only.
// All trade execution is handled by the frontend IG Spread Bet tab.
const igStream_1 = require("./igStream");
const scalperStrategy_1 = require("./scalperStrategy");
const marketHours_1 = require("./marketHours");
const gemini_1 = require("./gemini");
const signalMonitor_1 = require("./signalMonitor");
const STATE_FILE = path.join(__dirname, '..', 'bot-state.json');
// ── State ────────────────────────────────────────────────────────────────────
const MAX_CONCURRENT_POSITIONS = 3;
let running = false;
let paused = false;
let epicStates = {};
let pendingEpics = new Set();
let currentEpics = [];
let currentConfig = { ...scalperStrategy_1.DEFAULT_CONFIG };
let recentLosses = 0; // tracks consecutive losing trades to auto-scale cooldown
let sessionRefreshTimer = null;
let signalMonitorTimer = null;
const log = [];
function uid() { return Math.random().toString(36).slice(2, 9); }
function ts() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }
function saveState(params) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(params), 'utf8');
    }
    catch { }
}
function clearState() {
    try {
        fs.unlinkSync(STATE_FILE);
    }
    catch { }
}
function loadSavedState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    catch {
        return null;
    }
}
function addLog(type, epic, msg) {
    const entry = { id: uid(), ts: ts(), type, epic, msg };
    log.unshift(entry);
    if (log.length > 300)
        log.splice(300);
    const level = type === 'error' ? 'error' : 'log';
    console[level](`[${entry.ts}] [${type.toUpperCase()}] [${epic}] ${msg}`);
}
function startSignalMonitor() {
    if (signalMonitorTimer)
        clearInterval(signalMonitorTimer);
    // Run every 5 minutes — checks ALL open positions, not just scalper ones
    signalMonitorTimer = setInterval(() => {
        void (0, signalMonitor_1.runSignalCheck)(currentEpics, addLog).then(newEpics => {
            if (newEpics.length > 0) {
                // Add newly discovered position epics to the Lightstreamer subscription
                const session = (0, igApi_1.getSession)();
                if (session) {
                    const merged = [...new Set([...currentEpics, ...newEpics])];
                    addLog('info', '—', `Signal monitor: adding ${newEpics.length} new epic(s) to stream`);
                    (0, igStream_1.connect)(session, merged, handleTick, '5MINUTE');
                }
            }
        });
    }, 5 * 60_000);
    addLog('info', '—', 'Signal monitor started — checks all open positions every 5 min');
}
function stopSignalMonitor() {
    if (signalMonitorTimer) {
        clearInterval(signalMonitorTimer);
        signalMonitorTimer = null;
    }
}
// ── Session refresh ──────────────────────────────────────────────────────────
function scheduleSessionRefresh(session) {
    if (sessionRefreshTimer)
        clearTimeout(sessionRefreshTimer);
    const msUntilRefresh = session.expiresAt - Date.now() - 5 * 60_000; // 5 min before expiry
    if (msUntilRefresh <= 0) {
        void refreshSession();
        return;
    }
    sessionRefreshTimer = setTimeout(() => { void refreshSession(); }, msUntilRefresh);
    console.log(`[bot] Session refresh scheduled in ${Math.round(msUntilRefresh / 60_000)} min`);
}
async function refreshSession() {
    const apiKey = process.env.IG_API_KEY ?? '';
    const username = process.env.IG_USERNAME ?? '';
    const password = process.env.IG_PASSWORD ?? '';
    const env = (process.env.IG_ENV ?? 'demo');
    try {
        addLog('info', '—', 'Refreshing IG session...');
        const session = await (0, igApi_1.authenticate)(apiKey, username, password, env);
        addLog('info', '—', `Session refreshed — expires ${new Date(session.expiresAt).toLocaleTimeString()}`);
        if (running) {
            // Reconnect Lightstreamer with new credentials
            (0, igStream_1.connect)(session, currentEpics, handleTick, '5MINUTE');
        }
        scheduleSessionRefresh(session);
    }
    catch (e) {
        addLog('error', '—', `Session refresh failed: ${e instanceof Error ? e.message : String(e)}`);
        // Retry in 5 minutes
        sessionRefreshTimer = setTimeout(() => { void refreshSession(); }, 5 * 60_000);
    }
}
// ── Tick handler ─────────────────────────────────────────────────────────────
function handleTick(tick) {
    if (!running)
        return;
    // Feed all ticks into signal monitor candle store
    (0, signalMonitor_1.feedCandle)(tick.epic, tick);
    const st = epicStates[tick.epic];
    if (!st)
        return;
    if (pendingEpics.has(tick.epic))
        return;
    const decision = (0, scalperStrategy_1.processTick)(st, tick, currentConfig);
    // Update status (tracked in epicStates for status endpoint)
    // Only act on candle close or immediate exits
    if (decision.action === 'HOLD' && !tick.candleClosed)
        return;
    if (decision.action === 'WAIT' && !tick.candleClosed)
        return;
    if (decision.action === 'COOLDOWN' && !tick.candleClosed)
        return;
    const name = tick.epic.split('.').slice(0, 3).join('.');
    switch (decision.action) {
        case 'ENTER': {
            // Paused — skip new entries but still process exits
            if (paused) {
                if (tick.candleClosed)
                    addLog('wait', name, '⏸ Paused — skipping entry');
                break;
            }
            // Market hours check
            const mkt = (0, marketHours_1.isMarketOpen)(tick.epic);
            if (!mkt.open) {
                st.state = 'FLAT';
                addLog('wait', name, `⏸ Market closed — ${mkt.reason}`);
                break;
            }
            if ((0, marketHours_1.isClosingSoon)(tick.epic)) {
                st.state = 'FLAT';
                addLog('wait', name, `⏸ Market closing in <30min — no new entries`);
                break;
            }
            // Max concurrent positions guard
            const activePositions = Object.values(epicStates).filter(s => s.state === 'IN_POSITION').length + pendingEpics.size;
            if (activePositions >= MAX_CONCURRENT_POSITIONS) {
                st.state = 'FLAT';
                addLog('wait', name, `⏸ Max positions (${MAX_CONCURRENT_POSITIONS}) reached — skipping`);
                break;
            }
            addLog('info', name, `📊 Signal ${decision.direction} — ${decision.reason}`);
            pendingEpics.add(tick.epic);
            const session = (0, igApi_1.getSession)();
            if (!session) {
                addLog('error', name, '✗ No session — cannot open position');
                st.state = 'FLAT';
                pendingEpics.delete(tick.epic);
                break;
            }
            const entrySignal = {
                instrumentName: name,
                epic: tick.epic,
                rsi: decision.indicators.rsi,
                macd: decision.indicators.macd,
                atr: decision.indicators.atr,
                greenCount: decision.indicators.greenCount,
                suggestedDir: decision.direction,
                lastCandles: st.closedCandles.slice(-5).map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close })),
            };
            void (0, gemini_1.askGemini)(entrySignal).then(async (verdict) => {
                addLog('info', name, `🤖 Gemini (${verdict.engine}): ${verdict.direction} ${verdict.confidence}% — ${verdict.reason}`);
                if (verdict.direction === 'SKIP' || verdict.confidence < currentConfig.minConfidence) {
                    st.state = 'FLAT';
                    addLog('wait', name, `✋ Skipped (${verdict.direction}, confidence ${verdict.confidence}%)`);
                    pendingEpics.delete(tick.epic);
                    return;
                }
                // Gemini may override technical direction
                st.direction = verdict.direction;
                // DATA-ONLY: log the signal but do not place any order.
                (0, scalperStrategy_1.recordFill)(st, tick.bidClose, verdict.stopPoints, verdict.takeProfitPoints);
                st.dealId = `sig-${Math.random().toString(36).slice(2, 9)}`;
                st.size = 0;
                addLog('enter', name, `↑ SIGNAL ${verdict.direction} @ ${tick.bidClose.toFixed(1)} | stop −${verdict.stopPoints}pts | TP +${verdict.takeProfitPoints}pts (no order placed)`);
                pendingEpics.delete(tick.epic);
            });
            break;
        }
        case 'EXIT': {
            const urgencyTag = decision.urgency === 'immediate' ? ' [IMMEDIATE]' : '';
            addLog('exit', name, `↓ EXIT${urgencyTag} — ${decision.reason}`);
            // Track losses to auto-scale cooldown
            const isLoss = decision.reason.includes('stop') || decision.reason.includes('Stop') ||
                decision.reason.includes('reversal') || decision.reason.includes('red');
            if (isLoss) {
                recentLosses++;
                // Auto-scale cooldown: 15min → 30min → 60min after repeated losses
                const autoCooldown = recentLosses >= 3 ? 60 * 60_000 : recentLosses >= 2 ? 30 * 60_000 : 15 * 60_000;
                if (autoCooldown !== currentConfig.cooldownMs) {
                    currentConfig = { ...currentConfig, cooldownMs: autoCooldown };
                    addLog('info', name, `⚙ Auto-cooldown adjusted to ${autoCooldown / 60_000} min (${recentLosses} recent losses)`);
                }
            }
            else {
                recentLosses = 0; // reset on profitable exit
            }
            // DATA-ONLY: reset virtual state, no real close sent to IG.
            st.dealId = '';
            st.size = 0;
            addLog('exit', name, `↓ SIGNAL EXIT — ${decision.reason} (no order placed)`);
            break;
        }
        case 'HOLD':
            if (tick.candleClosed)
                addLog('hold', name, `→ HOLD — ${decision.reason}`);
            break;
        case 'WAIT':
            if (tick.candleClosed)
                addLog('wait', name, `… WAIT — ${decision.reason}`);
            break;
        case 'COOLDOWN':
            break;
    }
}
// ── Candle pre-warmer ─────────────────────────────────────────────────────────
function barToTick(epic, bar) {
    return {
        epic,
        time: bar.snapshotTime,
        open: bar.openPrice.mid ?? bar.openPrice.bid,
        high: bar.highPrice.mid ?? bar.highPrice.bid,
        low: bar.lowPrice.mid ?? bar.lowPrice.bid,
        close: bar.closePrice.mid ?? bar.closePrice.bid,
        bidClose: bar.closePrice.bid,
        offerClose: bar.closePrice.ask,
        candleClosed: true,
    };
}
async function prewarmCandles(session, epics) {
    addLog('info', '—', `Pre-warming 5-min candles for ${epics.length} epic(s)…`);
    let warmed = 0;
    for (const epic of epics) {
        try {
            const bars = await (0, igApi_1.fetchCandleHistory)(session, epic, 'MINUTE_5', 35);
            if (!bars.length)
                continue;
            const st = epicStates[epic];
            if (!st)
                continue;
            for (const bar of bars) {
                const tick = barToTick(epic, bar);
                (0, signalMonitor_1.feedCandle)(tick.epic, tick);
                (0, scalperStrategy_1.processTick)(st, tick, currentConfig);
            }
            warmed++;
            const name = epic.split('.').slice(0, 3).join('.');
            addLog('info', name, `Pre-warmed ${bars.length} candles — ${st.closedCandles.length} closed, RSI ready: ${st.closedCandles.length >= 14}`);
        }
        catch (e) {
            const name = epic.split('.').slice(0, 3).join('.');
            addLog('info', name, `Pre-warm skipped: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    addLog('info', '—', `Pre-warm done — ${warmed}/${epics.length} epic(s) ready`);
}
// ── Public API ───────────────────────────────────────────────────────────────
async function startBot(params) {
    if (running)
        stopBot();
    const apiKey = process.env.IG_API_KEY ?? '';
    const username = process.env.IG_USERNAME ?? '';
    const password = process.env.IG_PASSWORD ?? '';
    const env = (process.env.IG_ENV ?? 'demo');
    if (!apiKey || !username || !password) {
        return { ok: false, error: 'IG_API_KEY, IG_USERNAME, IG_PASSWORD env vars not set' };
    }
    try {
        addLog('info', '—', `Starting bot — epics: ${params.epics.join(', ')} | fully automated sizing`);
        const session = await (0, igApi_1.authenticate)(apiKey, username, password, env);
        currentEpics = params.epics;
        recentLosses = 0;
        currentConfig = { ...scalperStrategy_1.DEFAULT_CONFIG, ...(params.config ?? {}) };
        epicStates = {};
        for (const epic of params.epics) {
            epicStates[epic] = (0, scalperStrategy_1.initEpicState)(epic);
        }
        await prewarmCandles(session, params.epics);
        running = true;
        (0, igStream_1.connect)(session, params.epics, handleTick, '5MINUTE');
        startSignalMonitor();
        scheduleSessionRefresh(session);
        saveState(params);
        addLog('info', '—', `Bot started — ${params.epics.length} instrument(s). Session expires ${new Date(session.expiresAt).toLocaleTimeString()}`);
        return { ok: true };
    }
    catch (e) {
        running = false;
        const msg = e instanceof Error ? e.message : String(e);
        addLog('error', '—', `Bot start failed: ${msg}`);
        return { ok: false, error: msg };
    }
}
function stopBot() {
    running = false;
    paused = false;
    (0, igStream_1.disconnect)();
    stopSignalMonitor();
    if (sessionRefreshTimer) {
        clearTimeout(sessionRefreshTimer);
        sessionRefreshTimer = null;
    }
    (0, igApi_1.clearSession)();
    clearState();
    addLog('info', '—', 'Bot stopped');
}
function pauseBot() {
    if (!running)
        return;
    paused = true;
    addLog('info', '—', '⏸ Bot paused — monitoring open positions, no new entries');
}
function resumeBot() {
    if (!running)
        return;
    paused = false;
    addLog('info', '—', '▶ Bot resumed — will enter new positions on next signal');
}
function injectPosition(params) {
    if (!running)
        return { ok: false, error: 'Bot is not running' };
    const { epic, dealId, direction, size, entryPrice, stopPoints, tpPoints } = params;
    if (!epicStates[epic]) {
        epicStates[epic] = (0, scalperStrategy_1.initEpicState)(epic);
        // Also subscribe to this epic's stream if not already watching it
        const session = (0, igApi_1.getSession)();
        if (session && !currentEpics.includes(epic)) {
            currentEpics = [...currentEpics, epic];
            (0, igStream_1.connect)(session, currentEpics, handleTick, '5MINUTE');
        }
    }
    const st = epicStates[epic];
    st.state = 'IN_POSITION';
    st.direction = direction;
    st.dealId = dealId;
    st.size = size;
    (0, scalperStrategy_1.recordFill)(st, entryPrice, stopPoints, tpPoints);
    const name = epic.split('.').slice(0, 3).join('.');
    addLog('info', name, `[DEBUG] Injected ${direction} position — dealId=${dealId} entry=${entryPrice} stop±${stopPoints} tp±${tpPoints}`);
    return { ok: true };
}
function getBotStatus() {
    const session = (0, igApi_1.getSession)();
    const statuses = {};
    for (const [epic, st] of Object.entries(epicStates)) {
        const tick = st.formingCandle;
        statuses[epic] = {
            state: st.state,
            entryPrice: st.entryPrice,
            lastPrice: tick?.bidClose ?? 0,
            reds: st.consecutiveReds,
            formingIsRed: tick ? tick.close < tick.open : null,
            pnlPct: st.entryPrice > 0 && (tick?.bidClose ?? 0) > 0
                ? (tick.bidClose - st.entryPrice) / st.entryPrice * 100
                : null,
        };
    }
    return {
        running,
        paused,
        streamConnected: (0, igStream_1.isConnected)(),
        epics: currentEpics,
        recentLosses,
        config: currentConfig,
        epicStatuses: statuses,
        log: log.slice(0, 100),
        sessionOk: !!session && Date.now() < session.expiresAt,
        sessionExpiry: session ? new Date(session.expiresAt).toISOString() : null,
    };
}

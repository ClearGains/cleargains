"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.liveBot = exports.demoBot = void 0;
exports.createAccountBot = createAccountBot;
exports.getAccountBot = getAccountBot;
const igApi_1 = require("./igApi");
const igStream_1 = require("./igStream");
const scalperStrategy_1 = require("./scalperStrategy");
const marketHours_1 = require("./marketHours");
const gemini_1 = require("./gemini");
function resolveCredentials(accountKey) {
    if (accountKey === 'live') {
        return {
            apiKey: process.env.IG_LIVE_API_KEY ?? '',
            username: process.env.IG_LIVE_USERNAME ?? '',
            password: process.env.IG_LIVE_PASSWORD ?? '',
            env: 'live',
        };
    }
    return {
        apiKey: process.env.IG_DEMO_API_KEY ?? process.env.IG_API_KEY ?? '',
        username: process.env.IG_DEMO_USERNAME ?? process.env.IG_USERNAME ?? '',
        password: process.env.IG_DEMO_PASSWORD ?? process.env.IG_PASSWORD ?? '',
        env: 'demo',
    };
}
const MAX_CONCURRENT = 3;
function createAccountBot(accountKey) {
    const tag = `bot:${accountKey}`;
    const stream = (0, igStream_1.createStreamManager)(`igStream:${accountKey}`);
    // ── Per-instance state ─────────────────────────────────────────────────────
    let session = null;
    let running = false;
    let paused = false;
    let recentLosses = 0;
    let currentEpics = [];
    let currentConfig = { ...scalperStrategy_1.DEFAULT_CONFIG };
    let epicStates = {};
    const log = [];
    const monitorCandles = new Map();
    let sessionRefreshTimer = null;
    // ── Helpers ────────────────────────────────────────────────────────────────
    function uid() { return Math.random().toString(36).slice(2, 9); }
    function ts() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }
    function addLog(type, epic, msg) {
        const entry = { id: uid(), ts: ts(), type, epic, msg };
        log.unshift(entry);
        if (log.length > 300)
            log.splice(300);
        const level = type === 'error' ? 'error' : 'log';
        console[level](`[${tag}] [${type.toUpperCase()}] [${epic}] ${msg}`);
    }
    // ── Candle accumulator ─────────────────────────────────────────────────────
    function feedCandle(epic, tick) {
        if (!tick.candleClosed)
            return;
        const arr = monitorCandles.get(epic) ?? [];
        arr.push(tick);
        if (arr.length > 60)
            arr.splice(0, arr.length - 60);
        monitorCandles.set(epic, arr);
    }
    // ── Session refresh ────────────────────────────────────────────────────────
    function scheduleRefresh(sess) {
        if (sessionRefreshTimer)
            clearTimeout(sessionRefreshTimer);
        const delay = sess.expiresAt - Date.now() - 5 * 60_000;
        if (delay <= 0) {
            void doRefresh();
            return;
        }
        sessionRefreshTimer = setTimeout(() => { void doRefresh(); }, delay);
        console.log(`[${tag}] Session refresh in ${Math.round(delay / 60_000)} min`);
    }
    async function doRefresh() {
        const creds = resolveCredentials(accountKey);
        if (!creds.apiKey)
            return;
        try {
            addLog('info', '—', 'Refreshing IG session...');
            session = await (0, igApi_1.authenticate)(creds.apiKey, creds.username, creds.password, creds.env, accountKey);
            addLog('info', '—', `Session refreshed — expires ${new Date(session.expiresAt).toLocaleTimeString()}`);
            if (running)
                stream.connect(session, currentEpics, handleTick, '5MINUTE');
            scheduleRefresh(session);
        }
        catch (e) {
            addLog('error', '—', `Session refresh failed: ${e instanceof Error ? e.message : String(e)}`);
            sessionRefreshTimer = setTimeout(() => { void doRefresh(); }, 5 * 60_000);
        }
    }
    // ── Tick handler — signal generation only, no trade execution ─────────────
    function handleTick(tick) {
        if (!running)
            return;
        feedCandle(tick.epic, tick);
        const st = epicStates[tick.epic];
        if (!st)
            return;
        const decision = (0, scalperStrategy_1.processTick)(st, tick, currentConfig);
        if (decision.action === 'HOLD' && !tick.candleClosed)
            return;
        if (decision.action === 'WAIT' && !tick.candleClosed)
            return;
        if (decision.action === 'COOLDOWN' && !tick.candleClosed)
            return;
        const name = tick.epic.split('.').slice(0, 3).join('.');
        switch (decision.action) {
            case 'ENTER': {
                if (paused) {
                    if (tick.candleClosed)
                        addLog('wait', name, 'Paused — skipping signal');
                    break;
                }
                const mkt = (0, marketHours_1.isMarketOpen)(tick.epic);
                if (!mkt.open) {
                    st.state = 'FLAT';
                    addLog('wait', name, `Market closed — ${mkt.reason}`);
                    break;
                }
                if ((0, marketHours_1.isClosingSoon)(tick.epic)) {
                    st.state = 'FLAT';
                    addLog('wait', name, `Market closing in <30min — no new entries`);
                    break;
                }
                const active = Object.values(epicStates).filter(s => s.state === 'IN_POSITION').length;
                if (active >= MAX_CONCURRENT) {
                    st.state = 'FLAT';
                    addLog('wait', name, `Max active signals (${MAX_CONCURRENT}) reached`);
                    break;
                }
                // Compute ATR-based stop/TP as initial estimate
                const atr = decision.indicators.atr ?? 20;
                const stopPts = Math.max(5, Math.round(atr * currentConfig.atrStopMult));
                const tpPts = Math.round(stopPts * 2);
                const rsiStr = decision.indicators.rsi?.toFixed(0) ?? '—';
                addLog('info', name, `Strategy: ${decision.direction} · RSI ${rsiStr} · ${decision.reason} — asking Gemini…`);
                // Optimistic virtual fill to block duplicate signals while Gemini responds
                (0, scalperStrategy_1.recordFill)(st, tick.bidClose, stopPts, tpPts);
                st.dealId = `sig-${uid()}`;
                st.size = 0;
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
                void (0, gemini_1.askGemini)(entrySignal).then(verdict => {
                    addLog('info', name, `Gemini (${verdict.engine}): ${verdict.direction} ${verdict.confidence}% — ${verdict.reason}`);
                    if (verdict.direction === 'SKIP' || verdict.confidence < currentConfig.minConfidence) {
                        st.state = 'FLAT';
                        st.dealId = '';
                        addLog('wait', name, `Gemini skipped signal (${verdict.direction}, ${verdict.confidence}%)`);
                        return;
                    }
                    // Refine virtual fill with Gemini's validated stop/TP
                    (0, scalperStrategy_1.recordFill)(st, tick.bidClose, verdict.stopPoints, verdict.takeProfitPoints);
                    st.direction = verdict.direction;
                    addLog('enter', name, `↑ SIGNAL ${verdict.direction} @ ${tick.bidClose.toFixed(1)} · Gemini ${verdict.confidence}% · stop ${verdict.stopPoints}pt TP ${verdict.takeProfitPoints}pt`);
                });
                break;
            }
            case 'EXIT': {
                const isLoss = /stop|reversal|red/i.test(decision.reason);
                if (isLoss) {
                    recentLosses++;
                    const autoCooldown = recentLosses >= 3 ? 60 * 60_000 : recentLosses >= 2 ? 30 * 60_000 : 15 * 60_000;
                    if (autoCooldown !== currentConfig.cooldownMs) {
                        currentConfig = { ...currentConfig, cooldownMs: autoCooldown };
                        addLog('info', name, `Auto-cooldown → ${autoCooldown / 60_000} min (${recentLosses} losses)`);
                    }
                }
                else {
                    recentLosses = 0;
                }
                st.dealId = '';
                st.size = 0;
                addLog('exit', name, `↓ EXIT${decision.urgency === 'immediate' ? ' [immediate]' : ''} — ${decision.reason}`);
                break;
            }
            case 'HOLD':
                if (tick.candleClosed)
                    addLog('hold', name, `HOLD — ${decision.reason}`);
                break;
            case 'WAIT':
                if (tick.candleClosed)
                    addLog('wait', name, `WAIT — ${decision.reason}`);
                break;
            case 'COOLDOWN': break;
        }
    }
    // ── Candle pre-warmer ──────────────────────────────────────────────────────
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
    async function prewarmCandles(sess, epics) {
        addLog('info', '—', `Pre-warming 5-min candles for ${epics.length} epic(s)…`);
        let warmed = 0;
        for (const epic of epics) {
            try {
                const bars = await (0, igApi_1.fetchCandleHistory)(sess, epic, 'MINUTE_5', 35);
                if (!bars.length)
                    continue;
                const st = epicStates[epic];
                if (!st)
                    continue;
                for (const bar of bars) {
                    const tick = barToTick(epic, bar);
                    feedCandle(epic, tick);
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
    // ── Public API ─────────────────────────────────────────────────────────────
    async function start(params) {
        stop();
        const creds = resolveCredentials(accountKey);
        if (!creds.apiKey || !creds.username || !creds.password) {
            const varPrefix = accountKey === 'live' ? 'IG_LIVE_' : 'IG_DEMO_';
            return { ok: false, error: `${varPrefix}API_KEY / USERNAME / PASSWORD env vars not set` };
        }
        try {
            addLog('info', '—', `Starting ${accountKey} data stream — epics: ${params.epics.join(', ')}`);
            // Reuse an existing valid session (e.g. from the legacy bot) — avoids a fresh
            // IG auth request that can 500 when the IP is rate-limited from rapid logins.
            const existing = (0, igApi_1.getSession)(accountKey);
            if (existing && Date.now() < existing.expiresAt - 2 * 60_000) {
                session = existing;
                addLog('info', '—', `Reusing existing ${accountKey} session — expires ${new Date(session.expiresAt).toLocaleTimeString()}`);
            }
            else {
                session = await (0, igApi_1.authenticate)(creds.apiKey, creds.username, creds.password, creds.env, accountKey);
            }
            currentEpics = params.epics;
            recentLosses = 0;
            currentConfig = { ...scalperStrategy_1.DEFAULT_CONFIG, ...(params.config ?? {}) };
            epicStates = {};
            monitorCandles.clear();
            for (const epic of params.epics)
                epicStates[epic] = (0, scalperStrategy_1.initEpicState)(epic);
            await prewarmCandles(session, params.epics);
            running = true;
            stream.connect(session, params.epics, handleTick, '5MINUTE');
            scheduleRefresh(session);
            addLog('info', '—', `Stream started — ${params.epics.length} instrument(s). Session expires ${new Date(session.expiresAt).toLocaleTimeString()}`);
            return { ok: true };
        }
        catch (e) {
            running = false;
            const msg = e instanceof Error ? e.message : String(e);
            addLog('error', '—', `Start failed: ${msg}`);
            return { ok: false, error: msg };
        }
    }
    function stop() {
        running = false;
        paused = false;
        stream.disconnect();
        if (sessionRefreshTimer) {
            clearTimeout(sessionRefreshTimer);
            sessionRefreshTimer = null;
        }
        session = null;
        if (log.length)
            addLog('info', '—', `${accountKey} stream stopped`);
    }
    function pause() {
        if (!running)
            return;
        paused = true;
        addLog('info', '—', 'Paused — monitoring candles, signals suppressed');
    }
    function resume() {
        if (!running)
            return;
        paused = false;
        addLog('info', '—', 'Resumed — will emit signals on next trigger');
    }
    function candles(epic) {
        if (epic) {
            const arr = monitorCandles.get(epic);
            return arr ? { [epic]: arr } : {};
        }
        const result = {};
        for (const [k, v] of monitorCandles)
            result[k] = v;
        return result;
    }
    function status() {
        const statuses = {};
        for (const [epic, st] of Object.entries(epicStates)) {
            const tick = st.formingCandle;
            statuses[epic] = {
                state: st.state,
                entryPrice: st.entryPrice,
                lastPrice: tick?.bidClose ?? 0,
                reds: st.consecutiveReds,
                formingIsRed: tick ? tick.close < tick.open : null,
                pnlPct: null, // signal-only: no real P&L
            };
        }
        return {
            accountKey,
            running,
            paused,
            streamConnected: stream.isConnected(),
            epics: currentEpics,
            recentLosses,
            config: currentConfig,
            epicStatuses: statuses,
            log: log.slice(0, 100),
            sessionOk: !!session && Date.now() < session.expiresAt,
            sessionExpiry: session ? new Date(session.expiresAt).toISOString() : null,
        };
    }
    return { start, stop, pause, resume, status, candles };
}
// ── Singleton instances ───────────────────────────────────────────────────────
exports.demoBot = createAccountBot('demo');
exports.liveBot = createAccountBot('live');
function getAccountBot(key) {
    return key === 'live' ? exports.liveBot : exports.demoBot;
}

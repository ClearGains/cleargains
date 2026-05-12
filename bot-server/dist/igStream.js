"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isConnected = exports.disconnect = exports.connect = void 0;
exports.createStreamManager = createStreamManager;
const lightstreamer_client_node_1 = require("lightstreamer-client-node");
const FOREX_BATCH_SIZE = 3;
const INDEX_BATCH_SIZE = 6;
function createStreamManager(label = 'igStream') {
    let client = null;
    let subs = [];
    let _connected = false;
    function disconnect() {
        try {
            if (client) {
                for (const s of subs) {
                    try {
                        client.unsubscribe(s);
                    }
                    catch { }
                }
            }
        }
        catch { }
        try {
            client?.disconnect();
        }
        catch { }
        client = null;
        subs = [];
        _connected = false;
        console.log(`[${label}] Disconnected`);
    }
    function connect(session, epics, onTick, resolution = '1MINUTE') {
        disconnect();
        const ls = new lightstreamer_client_node_1.LightstreamerClient(session.lightstreamerEndpoint, 'DEFAULT');
        ls.connectionDetails.setUser(session.accountId);
        ls.connectionDetails.setPassword(`CST-${session.cst}|XST-${session.securityToken}`);
        ls.addListener({
            onStatusChange(status) {
                _connected = status.startsWith('CONNECTED');
                console.log(`[${label}] status: ${status}`);
            },
            onServerError(code, msg) {
                console.error(`[${label}] server error ${code}: ${msg}`);
            },
        });
        ls.connect();
        client = ls;
        const fields = ['UTM', 'BID_OPEN', 'BID_HIGH', 'BID_LOW', 'BID_CLOSE', 'OFR_OPEN', 'OFR_HIGH', 'OFR_LOW', 'OFR_CLOSE', 'CONS_END'];
        const forexEpics = epics.filter(e => e.startsWith('CS.D.'));
        const indexEpics = epics.filter(e => e.startsWith('IX.D.'));
        function subscribeBatches(batchEpics, batchSize) {
            for (let i = 0; i < batchEpics.length; i += batchSize) {
                const batch = batchEpics.slice(i, i + batchSize);
                const items = batch.map(e => `CHART:${e}:${resolution}`);
                const subscription = new lightstreamer_client_node_1.Subscription('MERGE', items, fields);
                subscription.addListener({
                    onItemUpdate(update) {
                        const epic = update.getItemName().split(':')[1] ?? '';
                        const g = (f) => parseFloat(update.getValue(f) ?? '0') || 0;
                        const bidOpen = g('BID_OPEN');
                        const bidClose = g('BID_CLOSE');
                        const ofrOpen = g('OFR_OPEN');
                        const ofrClose = g('OFR_CLOSE');
                        const utmMs = parseFloat(update.getValue('UTM') ?? '0') || Date.now();
                        const tick = {
                            epic,
                            time: new Date(utmMs).toISOString(),
                            open: (bidOpen + ofrOpen) / 2,
                            high: (g('BID_HIGH') + g('OFR_HIGH')) / 2,
                            low: (g('BID_LOW') + g('OFR_LOW')) / 2,
                            close: (bidClose + ofrClose) / 2,
                            bidClose,
                            offerClose: ofrClose,
                            candleClosed: update.getValue('CONS_END') === '1',
                        };
                        onTick(tick);
                    },
                });
                ls.subscribe(subscription);
                subs.push(subscription);
            }
        }
        // Forex and index epics in separate subscriptions — mixing causes silent data loss
        subscribeBatches(forexEpics, FOREX_BATCH_SIZE);
        subscribeBatches(indexEpics, INDEX_BATCH_SIZE);
        console.log(`[${label}] Subscribed to ${epics.length} epic(s): ${forexEpics.length} forex in ${Math.ceil(forexEpics.length / FOREX_BATCH_SIZE)} sub(s), ${indexEpics.length} indices in ${Math.ceil(indexEpics.length / INDEX_BATCH_SIZE)} sub(s)`);
    }
    return { connect, disconnect, isConnected: () => _connected };
}
// ── Backward-compat singleton ─────────────────────────────────────────────────
const _singleton = createStreamManager('igStream');
const connect = (...a) => _singleton.connect(...a);
exports.connect = connect;
const disconnect = () => _singleton.disconnect();
exports.disconnect = disconnect;
const isConnected = () => _singleton.isConnected();
exports.isConnected = isConnected;

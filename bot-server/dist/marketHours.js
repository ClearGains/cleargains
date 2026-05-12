"use strict";
// Market trading hours in UTC. Bot won't enter new positions outside these windows.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isClosingSoon = isClosingSoon;
exports.isMarketOpen = isMarketOpen;
const INDEX_SESSIONS = {
    // UK indices
    'IX.D.FTSE.DAILY.IP': { openH: 8, openM: 0, closeH: 16, closeM: 30 },
    // US indices
    'IX.D.SPTRD.DAILY.IP': { openH: 14, openM: 30, closeH: 21, closeM: 0 },
    'IX.D.NASDAQ.CASH.IP': { openH: 14, openM: 30, closeH: 21, closeM: 0 },
    'IX.D.DOW.DAILY.IP': { openH: 14, openM: 30, closeH: 21, closeM: 0 },
    // European indices
    'IX.D.DAX.DAILY.IP': { openH: 8, openM: 0, closeH: 22, closeM: 0 },
    // Asian indices (overnight UTC — next calendar day open)
    'IX.D.NIKKEI.DAILY.IP': { openH: 23, openM: 0, closeH: 6, closeM: 0 },
    'IX.D.ASX.DAILY.IP': { openH: 23, openM: 50, closeH: 6, closeM: 30 },
};
// CS.D.*.TODAY.IP forex/commodity spread bet epics — open Sun 22:00 to Fri 22:00 UTC
const FOREX_EPICS = new Set([
    'CS.D.GBPUSD.TODAY.IP',
    'CS.D.EURUSD.TODAY.IP',
    'CS.D.USDJPY.TODAY.IP',
    'CS.D.EURGBP.TODAY.IP',
    'CS.D.AUDUSD.TODAY.IP',
]);
function minutesSinceMidnightUTC() {
    const now = new Date();
    return now.getUTCHours() * 60 + now.getUTCMinutes();
}
function dayOfWeekUTC() {
    return new Date().getUTCDay(); // 0=Sun, 6=Sat
}
function isClosingSoon(epic, bufferMins = 30) {
    const day = dayOfWeekUTC();
    const mins = minutesSinceMidnightUTC();
    if (FOREX_EPICS.has(epic)) {
        // Forex closes Fri 22:00 UTC
        if (day === 5 && mins >= (22 * 60 - bufferMins))
            return true;
        return false;
    }
    if (day === 0 || day === 6)
        return false;
    const session = INDEX_SESSIONS[epic];
    if (!session)
        return false;
    const closeMins = session.closeH * 60 + session.closeM;
    const openMins = session.openH * 60 + session.openM;
    // Overnight session — "closing soon" means approaching the daytime close
    if (openMins > closeMins) {
        return mins >= closeMins - bufferMins && mins < closeMins;
    }
    return mins >= closeMins - bufferMins && mins < closeMins;
}
function isMarketOpen(epic) {
    const day = dayOfWeekUTC();
    const mins = minutesSinceMidnightUTC();
    // Forex: open Sun 22:00 – Fri 22:00 UTC
    if (FOREX_EPICS.has(epic)) {
        // Saturday always closed
        if (day === 6)
            return { open: false, reason: `${epic} — weekend (Saturday)` };
        // Sunday: only open after 22:00
        if (day === 0 && mins < 22 * 60)
            return { open: false, reason: `${epic} — Sunday before 22:00 UTC` };
        // Friday: closes at 22:00
        if (day === 5 && mins >= 22 * 60)
            return { open: false, reason: `${epic} — Friday after 22:00 UTC` };
        return { open: true, reason: `${epic} forex session` };
    }
    // Weekend — all index markets closed
    if (day === 0 || day === 6) {
        return { open: false, reason: `Weekend — market closed (day=${day})` };
    }
    // Index sessions
    const session = INDEX_SESSIONS[epic];
    if (!session)
        return { open: true, reason: 'Unknown instrument — allowing' };
    const openMins = session.openH * 60 + session.openM;
    const closeMins = session.closeH * 60 + session.closeM;
    // Overnight session (e.g. Nikkei 23:00–06:00)
    if (openMins > closeMins) {
        const open = mins >= openMins || mins < closeMins;
        return open
            ? { open: true, reason: `${epic} overnight session` }
            : { open: false, reason: `${epic} outside session (${session.openH}:${String(session.openM).padStart(2, '0')}–${session.closeH}:${String(session.closeM).padStart(2, '0')} UTC)` };
    }
    const open = mins >= openMins && mins < closeMins;
    return open
        ? { open: true, reason: `${epic} within session` }
        : { open: false, reason: `${epic} outside session (${session.openH}:${String(session.openM).padStart(2, '0')}–${session.closeH}:${String(session.closeM).padStart(2, '0')} UTC)` };
}

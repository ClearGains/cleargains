// Market trading hours in UTC. Bot won't enter new positions outside these windows.

type Session = { openH: number; openM: number; closeH: number; closeM: number };

const SESSIONS: Record<string, Session> = {
  // UK indices
  'IX.D.FTSE.DAILY.IP':   { openH: 8,  openM: 0,  closeH: 16, closeM: 30 },
  // US indices
  'IX.D.SPTRD.DAILY.IP':  { openH: 14, openM: 30, closeH: 21, closeM: 0  },
  'IX.D.NASDAQ.DAILY.IP': { openH: 14, openM: 30, closeH: 21, closeM: 0  },
  'IX.D.DOW.DAILY.IP':    { openH: 14, openM: 30, closeH: 21, closeM: 0  },
  // European indices
  'IX.D.DAX.DAILY.IP':    { openH: 8,  openM: 0,  closeH: 22, closeM: 0  },
  // Asian indices (overnight UTC — next calendar day open)
  'IX.D.NIKKEI.DAILY.IP': { openH: 23, openM: 0,  closeH: 6,  closeM: 0  },
  'IX.D.ASX.DAILY.IP':    { openH: 23, openM: 50, closeH: 6,  closeM: 30 },
};

// Forex, commodities, crypto: trade Mon–Fri 22:00 UTC Sunday open, 22:00 UTC Friday close
const FOREX_EPICS = new Set([
  'CS.D.GBPUSD.TODAY.IP', 'CS.D.EURUSD.TODAY.IP', 'CS.D.USDJPY.TODAY.IP',
  'CS.D.EURGBP.TODAY.IP', 'CS.D.AUDUSD.TODAY.IP', 'CS.D.USDCHF.TODAY.IP',
  'CS.D.GOLD.TODAY.IP',   'CS.D.SILVER.TODAY.IP',  'CS.D.CRUDE.TODAY.IP',
  'CS.D.NATGAS.TODAY.IP',
]);

// Bitcoin: 24/7
const CRYPTO_EPICS = new Set(['CS.D.BITCOIN.TODAY.IP']);

function minutesSinceMidnightUTC(): number {
  const now = new Date();
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

function dayOfWeekUTC(): number {
  return new Date().getUTCDay(); // 0=Sun, 6=Sat
}

export function isMarketOpen(epic: string): { open: boolean; reason: string } {
  const day = dayOfWeekUTC();
  const mins = minutesSinceMidnightUTC();

  // Crypto — always open
  if (CRYPTO_EPICS.has(epic)) return { open: true, reason: '24/7' };

  // Weekend — all non-crypto markets closed
  if (day === 0 || day === 6) {
    // Forex/commodities: Sunday opens at 22:00 UTC
    if (FOREX_EPICS.has(epic) && day === 0 && mins >= 22 * 60) {
      return { open: true, reason: 'Forex/commodity Sunday evening open' };
    }
    return { open: false, reason: `Weekend — market closed (day=${day})` };
  }

  // Friday close at 22:00 UTC for forex/commodities
  if (FOREX_EPICS.has(epic)) {
    if (day === 5 && mins >= 22 * 60) return { open: false, reason: 'Forex/commodity Friday close' };
    return { open: true, reason: 'Forex/commodity 24/5' };
  }

  // Index sessions
  const session = SESSIONS[epic];
  if (!session) return { open: true, reason: 'Unknown instrument — allowing' };

  const openMins  = session.openH  * 60 + session.openM;
  const closeMins = session.closeH * 60 + session.closeM;

  // Overnight session (e.g. Nikkei 23:00–06:00)
  if (openMins > closeMins) {
    const open = mins >= openMins || mins < closeMins;
    return open
      ? { open: true,  reason: `${epic} overnight session` }
      : { open: false, reason: `${epic} outside session (${session.openH}:${String(session.openM).padStart(2,'0')}–${session.closeH}:${String(session.closeM).padStart(2,'0')} UTC)` };
  }

  const open = mins >= openMins && mins < closeMins;
  return open
    ? { open: true,  reason: `${epic} within session` }
    : { open: false, reason: `${epic} outside session (${session.openH}:${String(session.openM).padStart(2,'0')}–${session.closeH}:${String(session.closeM).padStart(2,'0')} UTC)` };
}

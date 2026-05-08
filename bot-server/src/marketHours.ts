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

  // Weekend — all index markets closed
  if (day === 0 || day === 6) {
    return { open: false, reason: `Weekend — market closed (day=${day})` };
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

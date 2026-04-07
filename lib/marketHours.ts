export type MarketStatus = 'open' | 'pre-post' | 'closed';
export type ForexSession = 'sydney' | 'tokyo' | 'london' | 'new-york';

function getETTime(): { day: number; hour: number; minute: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);

  const day = parts.find(p => p.type === 'weekday')?.value ?? '';
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);

  const dayNum = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day);
  return { day: dayNum, hour, minute };
}

export function getMarketStatus(): { status: MarketStatus; nextOpenStr: string | null } {
  const { day, hour, minute } = getETTime();
  const isWeekday = day >= 1 && day <= 5;
  const timeInMins = hour * 60 + minute;

  const marketOpen = 9 * 60 + 30;   // 9:30am
  const marketClose = 16 * 60;       // 4:00pm
  const preOpen = 4 * 60;            // 4:00am
  const postClose = 20 * 60;         // 8:00pm

  if (isWeekday) {
    if (timeInMins >= marketOpen && timeInMins < marketClose) {
      return { status: 'open', nextOpenStr: null };
    }
    if ((timeInMins >= preOpen && timeInMins < marketOpen) ||
        (timeInMins >= marketClose && timeInMins < postClose)) {
      return { status: 'pre-post', nextOpenStr: null };
    }
  }

  // Calculate next open
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  let daysUntilOpen = 0;
  let nextDay = day;

  if (isWeekday && timeInMins < marketOpen) {
    daysUntilOpen = 0;
    nextDay = day;
  } else {
    // Find next weekday
    let d = (day + 1) % 7;
    let count = 1;
    while (d === 0 || d === 6) {
      d = (d + 1) % 7;
      count++;
    }
    daysUntilOpen = count;
    nextDay = d;
  }

  const nextOpenStr = daysUntilOpen === 0 ? `Today 9:30am ET` : `${dayNames[nextDay]} 9:30am ET`;
  return { status: 'closed', nextOpenStr };
}

export function getActiveForexSessions(): ForexSession[] {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const sessions: ForexSession[] = [];

  // Sydney: 21:00–06:00 UTC
  if (utcHour >= 21 || utcHour < 6) sessions.push('sydney');
  // Tokyo: 00:00–09:00 UTC
  if (utcHour >= 0 && utcHour < 9) sessions.push('tokyo');
  // London: 07:00–16:00 UTC
  if (utcHour >= 7 && utcHour < 16) sessions.push('london');
  // New York: 12:00–21:00 UTC
  if (utcHour >= 12 && utcHour < 21) sessions.push('new-york');

  return sessions;
}

export function formatNextOpen(nextOpenStr: string | null): string {
  return nextOpenStr ?? '';
}

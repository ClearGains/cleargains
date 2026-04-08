import { NextResponse } from 'next/server';

export type EconEvent = {
  id: string;
  event: string;
  country: string;
  flag: string;
  date: string;
  time: string;
  impact: 'high' | 'medium' | 'low';
  prev: string;
  estimate: string;
  unit: string;
};

const COUNTRY_FLAGS: Record<string, string> = {
  US: '🇺🇸', GB: '🇬🇧', EU: '🇪🇺', DE: '🇩🇪', FR: '🇫🇷',
  JP: '🇯🇵', CN: '🇨🇳', AU: '🇦🇺', CA: '🇨🇦', CH: '🇨🇭',
  NZ: '🇳🇿', IT: '🇮🇹', ES: '🇪🇸', KR: '🇰🇷', IN: '🇮🇳',
};

// Sample high-impact events for when Finnhub key is missing or API fails
const SAMPLE_EVENTS: EconEvent[] = [
  { id: 's1', event: 'US CPI m/m', country: 'US', flag: '🇺🇸', date: '', time: '13:30', impact: 'high', prev: '0.3%', estimate: '0.2%', unit: '%' },
  { id: 's2', event: 'FOMC Meeting Minutes', country: 'US', flag: '🇺🇸', date: '', time: '19:00', impact: 'high', prev: '—', estimate: '—', unit: '' },
  { id: 's3', event: 'UK GDP m/m', country: 'GB', flag: '🇬🇧', date: '', time: '07:00', impact: 'high', prev: '0.1%', estimate: '0.2%', unit: '%' },
  { id: 's4', event: 'ECB Interest Rate Decision', country: 'EU', flag: '🇪🇺', date: '', time: '13:15', impact: 'high', prev: '4.5%', estimate: '4.25%', unit: '%' },
  { id: 's5', event: 'US Non-Farm Payrolls', country: 'US', flag: '🇺🇸', date: '', time: '13:30', impact: 'high', prev: '256K', estimate: '180K', unit: 'K' },
  { id: 's6', event: 'BoE Rate Decision', country: 'GB', flag: '🇬🇧', date: '', time: '12:00', impact: 'high', prev: '5.25%', estimate: '5.0%', unit: '%' },
  { id: 's7', event: 'Japan BoJ Rate Decision', country: 'JP', flag: '🇯🇵', date: '', time: '03:00', impact: 'high', prev: '0.1%', estimate: '0.1%', unit: '%' },
];

export async function GET() {
  const key = process.env.FINNHUB_API_KEY;
  const today = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

  if (!key) {
    // Return sample events with approximate dates spread over next 7 days
    const events = SAMPLE_EVENTS.map((e, i) => ({
      ...e,
      date: new Date(Date.now() + (i + 1) * 86_400_000).toISOString().slice(0, 10),
    }));
    return NextResponse.json({ events, isSample: true, timestamp: new Date().toISOString() });
  }

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/calendar/economic?from=${today}&to=${nextWeek}&token=${key}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json() as {
      economicCalendar?: Array<{
        event: string; country: string; time: string;
        impact: string; prev: number | null; estimate: number | null; unit: string;
      }>
    };

    const cal = data.economicCalendar ?? [];
    const events: EconEvent[] = cal
      .filter(e => e.event && e.country)
      .slice(0, 60)
      .map((e, i) => ({
        id: `ev-${i}`,
        event: e.event,
        country: e.country,
        flag: COUNTRY_FLAGS[e.country] ?? '🌐',
        date: (e.time ?? '').slice(0, 10),
        time: (e.time ?? '').slice(11, 16) || '—',
        impact: (['high', 'medium', 'low'].includes(e.impact) ? e.impact : 'low') as EconEvent['impact'],
        prev: e.prev != null ? `${e.prev}${e.unit ?? ''}` : '—',
        estimate: e.estimate != null ? `${e.estimate}${e.unit ?? ''}` : '—',
        unit: e.unit ?? '',
      }));

    return NextResponse.json({ events, isSample: false, timestamp: new Date().toISOString() });
  } catch {
    // Fallback to sample events
    const events = SAMPLE_EVENTS.map((e, i) => ({
      ...e,
      date: new Date(Date.now() + (i + 1) * 86_400_000).toISOString().slice(0, 10),
    }));
    return NextResponse.json({ events, isSample: true, timestamp: new Date().toISOString() });
  }
}

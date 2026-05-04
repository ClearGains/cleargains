import type { Candle } from './indicators';
import type { AISignal } from '@/app/api/ig/claude-signal/route';

export type { AISignal };

export async function fetchAISignal(params: {
  epic:           string;
  instrumentName: string;
  candles:        Candle[];
  bid:            number;
  offer:          number;
  percentageChange?: number;
  currency:       string;
}): Promise<AISignal> {
  const res = await fetch('/api/ig/claude-signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json() as { ok: boolean; signal?: AISignal; error?: string };
  if (!data.ok || !data.signal) throw new Error(data.error ?? 'Signal generation failed');
  return data.signal;
}

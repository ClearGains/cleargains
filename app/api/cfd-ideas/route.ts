import { NextResponse } from 'next/server';

const BOT_URL    = process.env.BOT_SERVER_URL ?? '';
const BOT_SECRET = process.env.BOT_SECRET     ?? '';

// A full scan runs ~80 sequential Alpaca bar fetches plus a Gemini
// confirmation call for each one that qualifies — realistically well past
// the 20s timeout every other bot-server proxy route here uses. This is
// user-triggered on demand (no polling), so a longer wait is fine.
const SCAN_TIMEOUT_MS = 180_000;

export async function GET(): Promise<NextResponse> {
  if (!BOT_URL) {
    return NextResponse.json({ ok: false, error: 'BOT_SERVER_URL not configured.' }, { status: 503 });
  }
  try {
    const res = await fetch(`${BOT_URL}/cfd-ideas`, {
      headers: { 'x-bot-secret': BOT_SECRET },
      signal:  AbortSignal.timeout(SCAN_TIMEOUT_MS),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `Bot server unreachable: ${msg}` }, { status: 502 });
  }
}

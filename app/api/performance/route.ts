import { NextResponse } from 'next/server';

const BOT_URL    = process.env.BOT_SERVER_URL ?? '';
const BOT_SECRET = process.env.BOT_SECRET     ?? '';

export async function GET() {
  if (!BOT_URL) {
    return NextResponse.json(
      { ok: false, error: 'BOT_SERVER_URL not configured. Add it to Vercel environment variables.' },
      { status: 503 },
    );
  }
  try {
    const res = await fetch(`${BOT_URL}/performance`, {
      headers: { 'x-bot-secret': BOT_SECRET },
      signal:  AbortSignal.timeout(15_000),
      cache:   'no-store',
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `Bot server unreachable: ${msg}` }, { status: 502 });
  }
}

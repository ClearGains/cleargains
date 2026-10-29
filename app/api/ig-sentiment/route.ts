import { NextResponse } from 'next/server';

// Proxies the bot server's IG client sentiment (share of IG clients long vs
// short) for the markets the bots trade.
const BOT_URL    = process.env.BOT_SERVER_URL ?? '';
const BOT_SECRET = process.env.BOT_SECRET     ?? '';

export async function GET() {
  if (!BOT_URL) return NextResponse.json({ ok: false, error: 'BOT_SERVER_URL not configured' }, { status: 503 });
  try {
    const res = await fetch(`${BOT_URL}/ig/sentiment`, {
      headers: { 'x-bot-secret': BOT_SECRET }, signal: AbortSignal.timeout(30_000), cache: 'no-store',
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Bot server unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}

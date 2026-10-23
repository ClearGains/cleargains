import { NextRequest, NextResponse } from 'next/server';

// Proxies the bot server's /closed-positions (brokers' own trade records).
const BOT_URL    = process.env.BOT_SERVER_URL ?? '';
const BOT_SECRET = process.env.BOT_SECRET     ?? '';

export async function GET(req: NextRequest) {
  if (!BOT_URL) return NextResponse.json({ ok: false, error: 'BOT_SERVER_URL not configured' }, { status: 503 });
  const q = req.nextUrl.searchParams;
  const params = new URLSearchParams({
    broker: q.get('broker') === 'ig' ? 'ig' : 'alpaca',
    mode:   q.get('mode') ?? '',
    days:   String(Math.min(Math.max(Number(q.get('days')) || 7, 1), 60)),
  });
  try {
    const res = await fetch(`${BOT_URL}/closed-positions?${params}`, {
      headers: { 'x-bot-secret': BOT_SECRET }, signal: AbortSignal.timeout(30_000), cache: 'no-store',
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Bot server unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}

import { NextRequest, NextResponse } from 'next/server';

// Proxies the bot server's options positioning (calls vs puts, biggest
// strikes, fresh money today). No symbols = the options held on Alpaca paper.
const BOT_URL    = process.env.BOT_SERVER_URL ?? '';
const BOT_SECRET = process.env.BOT_SECRET     ?? '';

export async function GET(req: NextRequest) {
  if (!BOT_URL) return NextResponse.json({ ok: false, error: 'BOT_SERVER_URL not configured' }, { status: 503 });
  const symbols = (req.nextUrl.searchParams.get('symbols') ?? '').toUpperCase().replace(/[^A-Z.,]/g, '').slice(0, 60);
  try {
    const res = await fetch(`${BOT_URL}/options/flow?symbols=${encodeURIComponent(symbols)}`, {
      headers: { 'x-bot-secret': BOT_SECRET }, signal: AbortSignal.timeout(60_000), cache: 'no-store',
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Bot server unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}

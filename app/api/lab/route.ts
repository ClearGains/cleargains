import { NextRequest, NextResponse } from 'next/server';

// Proxies the bot server's Strategy Lab (sandbox backtests and prediction
// training). GET ?path=meta|runs|runs/<id>|predict|predict/<id>;
// POST ?path=run|predict with a JSON body.
export const maxDuration = 60;
const BOT_URL    = process.env.BOT_SERVER_URL ?? '';
const BOT_SECRET = process.env.BOT_SECRET     ?? '';
const GET_PATHS  = /^(meta|runs|runs\/[a-z0-9]{1,12}|predict|predict\/[a-z0-9]{1,12})$/;
const POST_PATHS = /^(run|predict)$/;

async function proxy(path: string, init?: RequestInit) {
  if (!BOT_URL) return NextResponse.json({ ok: false, error: 'BOT_SERVER_URL not configured' }, { status: 503 });
  try {
    const res = await fetch(`${BOT_URL}/lab/${path}`, {
      ...init, headers: { 'x-bot-secret': BOT_SECRET, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000), cache: 'no-store',
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Bot server unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get('path') ?? '';
  if (!GET_PATHS.test(path)) return NextResponse.json({ ok: false, error: 'bad path' }, { status: 400 });
  return proxy(path);
}

export async function POST(req: NextRequest) {
  const path = req.nextUrl.searchParams.get('path') ?? '';
  if (!POST_PATHS.test(path)) return NextResponse.json({ ok: false, error: 'bad path' }, { status: 400 });
  const body = await req.text();
  return proxy(path, { method: 'POST', body });
}

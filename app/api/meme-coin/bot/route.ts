import { NextRequest, NextResponse } from 'next/server';

const BOT_URL    = process.env.BOT_SERVER_URL ?? '';
const BOT_SECRET = process.env.BOT_SECRET     ?? '';

function missingConfig() {
  return NextResponse.json(
    { ok: false, error: 'BOT_SERVER_URL not configured. Add it to Vercel environment variables.' },
    { status: 503 },
  );
}

async function proxyTo(path: string, method: string): Promise<NextResponse> {
  if (!BOT_URL) return missingConfig();
  try {
    const res = await fetch(`${BOT_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      signal:  AbortSignal.timeout(20_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `Bot server unreachable: ${msg}` }, { status: 502 });
  }
}

export async function GET() {
  return proxyTo('/meme-coin/status', 'GET');
}

export async function POST(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action');
  if (action !== 'start' && action !== 'stop') return NextResponse.json({ ok: false, error: 'action must be "start" or "stop"' }, { status: 400 });
  return proxyTo(`/meme-coin/${action}`, 'POST');
}

import { NextRequest, NextResponse } from 'next/server';

const BOT_URL    = process.env.BOT_SERVER_URL ?? '';
const BOT_SECRET = process.env.BOT_SECRET     ?? '';

async function proxyTo(path: string, method: string, body?: unknown, timeoutMs = 20_000): Promise<NextResponse> {
  if (!BOT_URL) {
    return NextResponse.json({ ok: false, error: 'BOT_SERVER_URL not configured. Add it to Vercel environment variables.' }, { status: 503 });
  }
  try {
    const res = await fetch(`${BOT_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      body:    body === undefined ? undefined : JSON.stringify(body),
      signal:  AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `Bot server unreachable: ${msg}` }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  // The briefing preview fetches market data for ~40 symbols — give it longer.
  if (req.nextUrl.searchParams.get('view') === 'briefing') return proxyTo('/opus/briefing', 'GET', undefined, 120_000);
  return proxyTo('/opus/status', 'GET');
}

export async function POST(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action');
  switch (action) {
    case 'start':  return proxyTo('/opus/start', 'POST');
    case 'stop':   return proxyTo('/opus/stop', 'POST');
    case 'run':    return proxyTo('/opus/run-now', 'POST');
    case 'config': return proxyTo('/opus/config', 'POST', await req.json().catch(() => ({})));
    case 'close': {
      const id = req.nextUrl.searchParams.get('id');
      if (!id || !/^[a-z0-9]{1,16}$/.test(id)) return NextResponse.json({ ok: false, error: 'valid id required' }, { status: 400 });
      return proxyTo(`/opus/positions/${id}/close`, 'POST');
    }
    default:
      return NextResponse.json({ ok: false, error: 'action must be start, stop, run, config or close' }, { status: 400 });
  }
}

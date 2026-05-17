import { NextRequest, NextResponse } from 'next/server';

const BOT_URL    = process.env.BOT_SERVER_URL ?? '';
const BOT_SECRET = process.env.BOT_SECRET     ?? '';

function missingConfig(): NextResponse {
  return NextResponse.json(
    { ok: false, error: 'BOT_SERVER_URL not configured. Add it to environment variables.' },
    { status: 503 },
  );
}

async function proxyTo(path: string, method: string, body?: unknown): Promise<NextResponse> {
  if (!BOT_URL) return missingConfig();
  try {
    const res = await fetch(`${BOT_URL}${path}`, {
      method,
      headers: {
        'Content-Type':  'application/json',
        'x-bot-secret':  BOT_SECRET,
      },
      body:   body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `Bot server unreachable: ${msg}` }, { status: 502 });
  }
}

function validMode(m: string | null): m is 'paper' | 'live' {
  return m === 'paper' || m === 'live';
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const mode   = req.nextUrl.searchParams.get('mode') ?? 'paper';
  const action = req.nextUrl.searchParams.get('action') ?? 'status';

  if (!validMode(mode)) {
    return NextResponse.json({ ok: false, error: 'mode must be paper or live' }, { status: 400 });
  }

  if (action === 'status') return proxyTo(`/alpaca/${mode}/status`, 'GET');

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const mode   = req.nextUrl.searchParams.get('mode') ?? 'paper';
  const action = req.nextUrl.searchParams.get('action') ?? 'start';

  if (!validMode(mode)) {
    return NextResponse.json({ ok: false, error: 'mode must be paper or live' }, { status: 400 });
  }

  // No-body actions
  if (action === 'stop')           return proxyTo(`/alpaca/${mode}/stop`,           'POST');
  if (action === 'pause')          return proxyTo(`/alpaca/${mode}/pause`,          'POST');
  if (action === 'resume')         return proxyTo(`/alpaca/${mode}/resume`,         'POST');
  if (action === 'emergency-stop') return proxyTo(`/alpaca/${mode}/emergency-stop`, 'POST');

  // Body-required actions
  if (action === 'start') {
    const body = await req.json() as unknown;
    return proxyTo(`/alpaca/${mode}/start`, 'POST', body);
  }

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}

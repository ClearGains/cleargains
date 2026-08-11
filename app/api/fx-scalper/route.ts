import { NextRequest, NextResponse } from 'next/server';

const BOT_URL    = process.env.BOT_SERVER_URL ?? '';
const BOT_SECRET = process.env.BOT_SECRET     ?? '';

function missingConfig() {
  return NextResponse.json(
    { ok: false, error: 'BOT_SERVER_URL not configured. Add it to Vercel environment variables.' },
    { status: 503 },
  );
}

async function proxyTo(path: string, method: string, body?: unknown): Promise<NextResponse> {
  if (!BOT_URL) return missingConfig();
  try {
    const res = await fetch(`${BOT_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      body:    body !== undefined ? JSON.stringify(body) : undefined,
      signal:  AbortSignal.timeout(12_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `Bot server unreachable: ${msg}` }, { status: 502 });
  }
}

function validMode(mode: string | null): mode is 'demo' | 'live' {
  return mode === 'demo' || mode === 'live';
}

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode');
  if (!validMode(mode)) return NextResponse.json({ ok: false, error: 'mode must be "demo" or "live"' }, { status: 400 });
  return proxyTo(`/fx-scalper/${mode}/status`, 'GET');
}

export async function POST(req: NextRequest) {
  const mode   = req.nextUrl.searchParams.get('mode');
  const action = req.nextUrl.searchParams.get('action') ?? 'start';
  if (!validMode(mode)) return NextResponse.json({ ok: false, error: 'mode must be "demo" or "live"' }, { status: 400 });
  if (!['start', 'stop', 'pause', 'resume', 'max-risk'].includes(action)) {
    return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
  }

  if (action === 'start' || action === 'max-risk') {
    const body = await req.json() as unknown;
    return proxyTo(`/fx-scalper/${mode}/${action}`, 'POST', body);
  }
  return proxyTo(`/fx-scalper/${mode}/${action}`, 'POST');
}

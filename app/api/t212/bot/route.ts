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
      signal:  AbortSignal.timeout(15_000),
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
  return proxyTo(`/t212/${mode}/status`, 'GET');
}

export async function POST(req: NextRequest) {
  const mode   = req.nextUrl.searchParams.get('mode');
  const action = req.nextUrl.searchParams.get('action');
  const ticker = req.nextUrl.searchParams.get('ticker');
  if (!validMode(mode)) return NextResponse.json({ ok: false, error: 'mode must be "demo" or "live"' }, { status: 400 });
  if (action === 'ai-pause') {
    const body = await req.json() as { paused?: boolean };
    return proxyTo(`/t212/${mode}/ai-pause`, 'POST', body);
  }
  if (action === 'position-ai-pause') {
    if (!ticker) return NextResponse.json({ ok: false, error: 'ticker is required' }, { status: 400 });
    const body = await req.json() as { paused?: boolean };
    return proxyTo(`/t212/${mode}/positions/${encodeURIComponent(ticker)}/ai-pause`, 'POST', body);
  }
  if (action !== 'start' && action !== 'stop') {
    return NextResponse.json({ ok: false, error: 'action must be "start", "stop", "ai-pause", or "position-ai-pause"' }, { status: 400 });
  }
  return proxyTo(`/t212/${mode}/${action}`, 'POST');
}

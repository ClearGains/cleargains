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

function validMode(mode: string | null): mode is 'demo' | 'live' {
  return mode === 'demo' || mode === 'live';
}

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode');
  if (!validMode(mode)) return NextResponse.json({ ok: false, error: 'mode must be "demo" or "live"' }, { status: 400 });
  return proxyTo(`/ig-options/${mode}/status`, 'GET');
}

export async function POST(req: NextRequest) {
  const mode   = req.nextUrl.searchParams.get('mode');
  const action = req.nextUrl.searchParams.get('action');
  if (!validMode(mode)) return NextResponse.json({ ok: false, error: 'mode must be "demo" or "live"' }, { status: 400 });
  if (action === 'approve-override') {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
    return proxyTo(`/ig-options/${mode}/overrides/${encodeURIComponent(id)}/approve`, 'POST');
  }
  if (action !== 'start' && action !== 'stop') return NextResponse.json({ ok: false, error: 'action must be "start" or "stop"' }, { status: 400 });
  return proxyTo(`/ig-options/${mode}/${action}`, 'POST');
}

export async function DELETE(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode');
  const id   = req.nextUrl.searchParams.get('id');
  if (!validMode(mode)) return NextResponse.json({ ok: false, error: 'mode must be "demo" or "live"' }, { status: 400 });
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  return proxyTo(`/ig-options/${mode}/overrides/${encodeURIComponent(id)}`, 'DELETE');
}

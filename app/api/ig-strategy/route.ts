import { NextRequest, NextResponse } from 'next/server';

const BOT_URL    = process.env.BOT_SERVER_URL ?? '';
const BOT_SECRET = process.env.BOT_SECRET     ?? '';

function missingConfig(): NextResponse {
  return NextResponse.json(
    { ok: false, error: 'BOT_SERVER_URL not configured.' },
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
      signal:  AbortSignal.timeout(20_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `Bot server unreachable: ${msg}` }, { status: 502 });
  }
}

function validMode(m: string | null): m is 'demo' | 'live' {
  return m === 'demo' || m === 'live';
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const mode   = req.nextUrl.searchParams.get('mode') ?? 'demo';
  const action = req.nextUrl.searchParams.get('action') ?? 'status';

  if (action === 'override-candidates') return proxyTo(`/ig-strategy/override-candidates`, 'GET');

  if (!validMode(mode)) return NextResponse.json({ ok: false, error: 'mode must be demo or live' }, { status: 400 });
  if (action === 'status') return proxyTo(`/ig-strategy/${mode}/status`, 'GET');
  if (action === 'watch')  return proxyTo(`/ig-strategy/${mode}/watch`,  'GET');
  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const mode   = req.nextUrl.searchParams.get('mode') ?? 'demo';
  const action = req.nextUrl.searchParams.get('action') ?? '';
  const dealId = req.nextUrl.searchParams.get('dealId') ?? '';

  if (!validMode(mode)) return NextResponse.json({ ok: false, error: 'mode must be demo or live' }, { status: 400 });
  if (action === 'watch' && dealId) return proxyTo(`/ig-strategy/${mode}/watch/${encodeURIComponent(dealId)}`, 'DELETE');

  const epic = req.nextUrl.searchParams.get('epic') ?? '';
  if (action === 'pause-epic' && epic) return proxyTo(`/ig-strategy/${mode}/paused/${encodeURIComponent(epic)}`, 'DELETE');

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const mode   = req.nextUrl.searchParams.get('mode') ?? 'demo';
  const action = req.nextUrl.searchParams.get('action') ?? 'start';

  if (!validMode(mode)) return NextResponse.json({ ok: false, error: 'mode must be demo or live' }, { status: 400 });

  if (action === 'stop')   return proxyTo(`/ig-strategy/${mode}/stop`,   'POST');
  if (action === 'pause')  return proxyTo(`/ig-strategy/${mode}/pause`,  'POST');
  if (action === 'resume') return proxyTo(`/ig-strategy/${mode}/resume`, 'POST');

  if (action === 'start') {
    const body = await req.json() as unknown;
    return proxyTo(`/ig-strategy/${mode}/start`, 'POST', body);
  }

  if (action === 'watch') {
    const { dealId, note } = await req.json() as { dealId?: string; note?: string };
    if (!dealId) return NextResponse.json({ ok: false, error: 'dealId required' }, { status: 400 });
    return proxyTo(`/ig-strategy/${mode}/watch/${encodeURIComponent(dealId)}`, 'POST', { note });
  }

  if (action === 'watch-note') {
    const { dealId, note } = await req.json() as { dealId?: string; note?: string };
    if (!dealId) return NextResponse.json({ ok: false, error: 'dealId required' }, { status: 400 });
    return proxyTo(`/ig-strategy/${mode}/watch/${encodeURIComponent(dealId)}/note`, 'POST', { note });
  }

  if (action === 'watch-ai-exempt') {
    const { dealId, exempt } = await req.json() as { dealId?: string; exempt?: boolean };
    if (!dealId) return NextResponse.json({ ok: false, error: 'dealId required' }, { status: 400 });
    return proxyTo(`/ig-strategy/${mode}/watch/${encodeURIComponent(dealId)}/ai-exempt`, 'POST', { exempt });
  }

  if (action === 'open-recommendation') {
    const { epic } = await req.json() as { epic?: string };
    if (!epic) return NextResponse.json({ ok: false, error: 'epic required' }, { status: 400 });
    return proxyTo(`/ig-strategy/${mode}/recommendations/${encodeURIComponent(epic)}/open`, 'POST');
  }

  if (action === 'refresh-recommendations') return proxyTo(`/ig-strategy/${mode}/refresh-recommendations`, 'POST');
  if (action === 'refresh-daily-pick')      return proxyTo(`/ig-strategy/${mode}/refresh-daily-pick`,      'POST');

  if (action === 'max-daily-loss') {
    const body = await req.json() as { maxDailyLossPct?: number };
    return proxyTo(`/ig-strategy/${mode}/max-daily-loss`, 'POST', body);
  }

  if (action === 'daily-profit-target') {
    const body = await req.json() as { dailyProfitTargetGbp?: number };
    return proxyTo(`/ig-strategy/${mode}/daily-profit-target`, 'POST', body);
  }

  if (action === 'pause-epic') {
    const { epic } = await req.json() as { epic?: string };
    if (!epic) return NextResponse.json({ ok: false, error: 'epic required' }, { status: 400 });
    return proxyTo(`/ig-strategy/${mode}/paused/${encodeURIComponent(epic)}`, 'POST');
  }

  if (action === 'release-deal') {
    const { dealId } = await req.json() as { dealId?: string };
    if (!dealId) return NextResponse.json({ ok: false, error: 'dealId required' }, { status: 400 });
    return proxyTo(`/ig-strategy/${mode}/deals/${encodeURIComponent(dealId)}/release`, 'POST');
  }

  if (action === 'hold-deal') {
    const { dealId } = await req.json() as { dealId?: string };
    if (!dealId) return NextResponse.json({ ok: false, error: 'dealId required' }, { status: 400 });
    return proxyTo(`/ig-strategy/${mode}/deals/${encodeURIComponent(dealId)}/hold`, 'POST');
  }

  if (action === 'ai-pause') {
    const body = await req.json() as { paused?: boolean };
    return proxyTo(`/ig-strategy/${mode}/ai-pause`, 'POST', body);
  }

  if (action === 'watch-ai-pause') {
    const body = await req.json() as { paused?: boolean };
    return proxyTo(`/ig-strategy/${mode}/watch/ai-pause`, 'POST', body);
  }

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}

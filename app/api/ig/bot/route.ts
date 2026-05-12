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

function validAccount(account: string | null): account is 'demo' | 'live' {
  return account === 'demo' || account === 'live';
}

export async function GET(req: NextRequest) {
  const action  = req.nextUrl.searchParams.get('action') ?? 'status';
  const account = req.nextUrl.searchParams.get('account');

  if (action === 'health')          return proxyTo('/health',    'GET');
  if (action === 'accounts')        return proxyTo('/accounts',  'GET');
  if (action === 'strategy-status') return proxyTo('/strategy/status', 'GET');
  if (action === 'prices')          return proxyTo('/prices',    'GET');

  // Per-account status
  if (action === 'account-status' && validAccount(account)) {
    return proxyTo(`/accounts/${account}/status`, 'GET');
  }

  // Stock bot status
  if (action === 'stock-status' && validAccount(account)) {
    return proxyTo(`/accounts/${account}/stock/status`, 'GET');
  }

  return proxyTo('/status', 'GET');
}

export async function POST(req: NextRequest) {
  const action  = req.nextUrl.searchParams.get('action') ?? 'start';
  const account = req.nextUrl.searchParams.get('account');

  // Legacy single-account routes
  if (action === 'stop')           return proxyTo('/stop',   'POST');
  if (action === 'pause')          return proxyTo('/pause',  'POST');
  if (action === 'resume')         return proxyTo('/resume', 'POST');
  if (action === 'strategy-stop')  return proxyTo('/strategy/stop', 'POST');

  const body = await req.json() as unknown;
  if (action === 'strategy-start') return proxyTo('/strategy/start', 'POST', body);
  if (action === 'inject')         return proxyTo('/debug/inject',   'POST', body);

  // Per-account routes
  if (validAccount(account)) {
    if (action === 'account-start')  return proxyTo(`/accounts/${account}/start`,  'POST', body);
    if (action === 'account-stop')   return proxyTo(`/accounts/${account}/stop`,   'POST');
    if (action === 'account-pause')  return proxyTo(`/accounts/${account}/pause`,  'POST');
    if (action === 'account-resume') return proxyTo(`/accounts/${account}/resume`, 'POST');
    // Stock bot
    if (action === 'stock-start')  return proxyTo(`/accounts/${account}/stock/start`,  'POST', body);
    if (action === 'stock-stop')   return proxyTo(`/accounts/${account}/stock/stop`,   'POST');
    if (action === 'stock-pause')  return proxyTo(`/accounts/${account}/stock/pause`,  'POST');
    if (action === 'stock-resume') return proxyTo(`/accounts/${account}/stock/resume`, 'POST');
  }

  return proxyTo('/start', 'POST', body);
}

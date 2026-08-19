import { NextRequest, NextResponse } from 'next/server';

const BOT_URL    = process.env.BOT_SERVER_URL ?? '';
const BOT_SECRET = process.env.BOT_SECRET     ?? '';

function missingConfig(): NextResponse {
  return NextResponse.json(
    { ok: false, error: 'BOT_SERVER_URL not configured.' },
    { status: 503 },
  );
}

async function proxyTo(method: string, body?: unknown): Promise<NextResponse> {
  if (!BOT_URL) return missingConfig();
  try {
    const res = await fetch(`${BOT_URL}/alpaca-news-stream`, {
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

export async function GET(): Promise<NextResponse> {
  return proxyTo('GET');
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { enabled } = await req.json() as { enabled?: boolean };
  return proxyTo('POST', { enabled: !!enabled });
}

import { NextRequest, NextResponse } from 'next/server';

const BOT_URL    = process.env.BOT_SERVER_URL ?? '';
const BOT_SECRET = process.env.BOT_SECRET     ?? '';

function missingConfig(): NextResponse {
  return NextResponse.json(
    { ok: false, error: 'BOT_SERVER_URL not configured.' },
    { status: 503 },
  );
}

async function proxyTo(path: string, method: string): Promise<NextResponse> {
  if (!BOT_URL) return missingConfig();
  try {
    const res = await fetch(`${BOT_URL}${path}`, {
      method,
      headers: { 'x-bot-secret': BOT_SECRET },
      signal:  AbortSignal.timeout(20_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `Bot server unreachable: ${msg}` }, { status: 502 });
  }
}

// GET — latest completed sweep from the Oracle server (runs on its own schedule)
export async function GET(_req: NextRequest): Promise<NextResponse> {
  return proxyTo('/leaderboard', 'GET');
}

// POST — trigger an immediate sweep instead of waiting for the schedule
export async function POST(_req: NextRequest): Promise<NextResponse> {
  return proxyTo('/leaderboard/run', 'POST');
}

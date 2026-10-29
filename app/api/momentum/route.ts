import { NextRequest, NextResponse } from 'next/server';

// Proxies the bot server's Momentum Testbot status (GET) and switches (POST).
const BOT_URL    = process.env.BOT_SERVER_URL ?? '';
const BOT_SECRET = process.env.BOT_SECRET     ?? '';

const ACTIONS = new Set(['pause', 'resume', 'dry-run-on', 'dry-run-off', 'stop', 'start', 'close-all']);

export async function GET() {
  if (!BOT_URL) return NextResponse.json({ ok: false, error: 'BOT_SERVER_URL not configured' }, { status: 503 });
  try {
    const res = await fetch(`${BOT_URL}/momentum/status`, {
      headers: { 'x-bot-secret': BOT_SECRET }, signal: AbortSignal.timeout(30_000), cache: 'no-store',
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Bot server unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  if (!BOT_URL) return NextResponse.json({ ok: false, message: 'BOT_SERVER_URL not configured' }, { status: 503 });
  const { action } = await req.json().catch(() => ({ action: '' })) as { action?: string };
  if (!action || !ACTIONS.has(action)) return NextResponse.json({ ok: false, message: 'Unknown action' }, { status: 400 });
  try {
    const res = await fetch(`${BOT_URL}/momentum/control`, {
      method: 'POST', headers: { 'x-bot-secret': BOT_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }), signal: AbortSignal.timeout(60_000), cache: 'no-store',
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (e) {
    return NextResponse.json({ ok: false, message: `Bot server unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}

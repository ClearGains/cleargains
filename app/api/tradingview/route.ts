import { NextRequest, NextResponse } from 'next/server';

// Public endpoint for TradingView webhook alerts (TradingView can only post to
// ports 80/443, so it can't reach the bot server directly). Exempt from the
// site password in proxy.ts — instead every alert body must carry the
// TRADINGVIEW_SECRET, which the bot server checks.

const BOT_URL    = process.env.BOT_SERVER_URL ?? '';
const BOT_SECRET = process.env.BOT_SECRET     ?? '';

export async function POST(req: NextRequest) {
  if (!BOT_URL) return NextResponse.json({ ok: false, error: 'BOT_SERVER_URL not configured' }, { status: 503 });
  let body: unknown;
  try {
    // TradingView sends the alert message as the raw body; it's JSON when the
    // message template is JSON (see tradingview/opus_signals.pine).
    body = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ ok: false, error: 'alert message must be JSON' }, { status: 400 });
  }
  try {
    const res = await fetch(`${BOT_URL}/tradingview/webhook`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Bot server unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}

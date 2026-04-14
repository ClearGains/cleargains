import { NextRequest, NextResponse } from 'next/server';

/**
 * Thin wrapper — delegates to /api/t212/live-order with env='demo'.
 * Kept for backward compatibility; prefer calling live-order directly with env param.
 */
export async function POST(request: NextRequest) {
  const encoded = request.headers.get('x-t212-auth');
  if (!encoded) {
    return NextResponse.json({ ok: false, error: 'Missing x-t212-auth header.' }, { status: 400 });
  }

  const body = await request.json() as { ticker: string; quantity: number };

  // Forward to the unified live-order route with env=demo
  const url = new URL('/api/t212/live-order', request.url);
  return fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-t212-auth': encoded,
    },
    body: JSON.stringify({ ...body, env: 'demo' }),
  }).then(r => r.json()).then(data => NextResponse.json(data));
}

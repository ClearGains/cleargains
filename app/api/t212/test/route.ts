import { NextRequest, NextResponse } from 'next/server';

function describeT212Error(status: number, rawBody: string): string {
  if (status === 401) {
    if (!rawBody || rawBody.trim() === '') {
      return 'Trading 212 returned 401 with empty response - this usually means the API key format is incorrect or the key was generated on the wrong account type';
    }
    return `Trading 212 returned 401 — ${rawBody}`;
  }
  if (status === 403) {
    return `Trading 212 returned 403 Forbidden - your key may not have the required permissions${rawBody ? ` — ${rawBody}` : ''}`;
  }
  return `Trading 212 returned HTTP ${status} — ${rawBody || '(empty body)'}`;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { apiKey, apiSecret } = body as { apiKey: string; apiSecret: string };

  const key = (apiKey ?? '').trim();
  const secret = (apiSecret ?? '').trim();

  console.log('[T212 test] apiKey present:', !!key, '| first 4 chars:', key ? key.slice(0, 4) : 'none');
  console.log('[T212 test] apiSecret present:', !!secret);

  if (!key || !secret) {
    return NextResponse.json(
      { ok: false, error: 'API key and secret must not be empty.' },
      { status: 400 }
    );
  }

  const authHeader = 'Basic ' + Buffer.from(key + ':' + secret).toString('base64');
  const url = 'https://live.trading212.com/api/v0/equity/account/info';

  console.log('[T212 test] GET', url);

  let status: number;
  let rawBody: string;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: authHeader },
      cache: 'no-store',
    });
    status = res.status;
    rawBody = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('[T212 test] network error:', msg);
    return NextResponse.json({ ok: false, error: `Request to Trading 212 failed: ${msg}` });
  }

  console.log('[T212 test] status:', status, '| body:', rawBody);

  if (status >= 200 && status < 300) {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(rawBody); } catch { /* leave empty */ }
    return NextResponse.json({
      ok: true,
      accountId: data.id ?? 'unknown',
      currency: data.currencyCode ?? 'GBP',
      status,
      rawBody,
    });
  }

  return NextResponse.json({
    ok: false,
    status,
    rawBody,
    error: describeT212Error(status, rawBody),
  });
}

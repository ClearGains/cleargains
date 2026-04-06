import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { apiKey, apiSecret } = body as { apiKey: string; apiSecret: string };

  console.log('[T212 test] apiKey received:', !!apiKey, '| first 4 chars:', apiKey ? apiKey.slice(0, 4) : 'none');
  console.log('[T212 test] apiSecret received:', !!apiSecret);

  if (!apiKey || !apiSecret) {
    return NextResponse.json({ ok: false, error: 'API key and secret are required.' }, { status: 400 });
  }

  const authHeader = 'Basic ' + Buffer.from(apiKey + ':' + apiSecret).toString('base64');
  const url = 'https://live.trading212.com/api/v0/equity/account/info';

  console.log('[T212 test] fetching:', url);
  console.log('[T212 test] Authorization header prefix:', authHeader.slice(0, 12));

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
    console.log('[T212 test] fetch threw:', msg);
    return NextResponse.json({ ok: false, error: `Network error: ${msg}` });
  }

  console.log('[T212 test] status:', status);
  console.log('[T212 test] body:', rawBody);

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
    error: `Trading 212 returned HTTP ${status} — ${rawBody || '(empty body)'}`,
  });
}

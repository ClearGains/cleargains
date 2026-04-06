import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { apiKey, apiSecret, accountType = 'DEMO' } = body as {
    apiKey: string;
    apiSecret: string;
    accountType: 'LIVE' | 'DEMO';
  };

  console.log('[T212 test] accountType:', accountType);
  console.log('[T212 test] apiKey received:', !!apiKey, '| first 4 chars:', apiKey ? apiKey.slice(0, 4) : 'none');
  console.log('[T212 test] apiSecret received:', !!apiSecret);

  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      { ok: false, error: 'API key and secret are required.' },
      { status: 400 }
    );
  }

  const base =
    accountType === 'LIVE'
      ? 'https://live.trading212.com/api/v0'
      : 'https://demo.trading212.com/api/v0';

  const credentials = Buffer.from(apiKey + ':' + apiSecret).toString('base64');

  console.log('[T212 test] fetching:', `${base}/equity/account/info`);

  try {
    const res = await fetch(`${base}/equity/account/info`, {
      headers: {
        Authorization: 'Basic ' + credentials,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });

    const errorBody = await res.text();
    console.log('[T212 test] response status:', res.status);
    console.log('[T212 test] response body:', errorBody);

    if (res.ok) {
      const data = JSON.parse(errorBody);
      return NextResponse.json({
        ok: true,
        accountType,
        accountId: data.id ?? 'unknown',
        currency: data.currencyCode ?? 'GBP',
      });
    }

    // Parse T212 error message if JSON, otherwise use raw text
    let t212Error = errorBody;
    try {
      const parsed = JSON.parse(errorBody);
      t212Error = parsed.message ?? parsed.error ?? parsed.code ?? errorBody;
    } catch {
      // errorBody is plain text — use as-is
    }

    return NextResponse.json({
      ok: false,
      status: res.status,
      error: t212Error || `Trading 212 returned HTTP ${res.status}`,
      t212Raw: errorBody,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('[T212 test] fetch error:', msg);
    return NextResponse.json(
      { ok: false, error: `Network error: ${msg}` },
      { status: 200 }
    );
  }
}

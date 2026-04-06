import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { accountType = 'DEMO' } = body as { accountType: 'LIVE' | 'DEMO' };

  const isLive = accountType === 'LIVE';
  const apiKey = isLive ? process.env.T212_API_KEY : process.env.T212_DEMO_API_KEY;
  const apiSecret = isLive ? process.env.T212_API_SECRET : process.env.T212_DEMO_SECRET;

  console.log('[T212 test] accountType:', accountType);
  console.log('[T212 test] apiKey present:', !!apiKey);
  console.log('[T212 test] apiSecret present:', !!apiSecret);

  if (!apiKey || !apiSecret) {
    const vars = isLive
      ? 'T212_API_KEY and T212_API_SECRET'
      : 'T212_DEMO_API_KEY and T212_DEMO_SECRET';
    return NextResponse.json(
      { ok: false, error: `${vars} are not set in environment variables.` },
      { status: 503 }
    );
  }

  const base = isLive
    ? (process.env.T212_BASE_URL ?? 'https://live.trading212.com/api/v0')
    : (process.env.T212_DEMO_URL ?? 'https://demo.trading212.com/api/v0');

  const credentials = Buffer.from(apiKey + ':' + apiSecret).toString('base64');

  try {
    const res = await fetch(`${base}/equity/account/info`, {
      headers: {
        Authorization: 'Basic ' + credentials,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });

    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({
        ok: true,
        accountType,
        accountId: data.id ?? 'unknown',
        currency: data.currencyCode ?? 'GBP',
      });
    }

    const errorBody = await res.text();
    console.error('[T212 test] failed:', res.status, errorBody);
    return NextResponse.json(
      {
        ok: false,
        status: res.status,
        error:
          res.status === 401
            ? `Invalid credentials — check ${isLive ? 'T212_API_KEY and T212_API_SECRET' : 'T212_DEMO_API_KEY and T212_DEMO_SECRET'} are correct.`
            : `Trading 212 returned ${res.status}`,
        t212Message: errorBody,
      },
      { status: 200 } // Always 200 so the client can read the body
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 200 }
    );
  }
}

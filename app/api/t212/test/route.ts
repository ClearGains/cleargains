import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { apiKey, apiSecret, accountType = 'DEMO' } = body as {
    apiKey: string;
    apiSecret: string;
    accountType: 'LIVE' | 'DEMO';
  };

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
    return NextResponse.json(
      {
        ok: false,
        status: res.status,
        error:
          res.status === 401
            ? 'Invalid credentials — check your API key and secret are correct.'
            : `Trading 212 returned ${res.status}`,
        t212Message: errorBody,
      },
      { status: 200 }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 200 }
    );
  }
}

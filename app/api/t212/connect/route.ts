import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { apiKey, apiSecret } = body as { apiKey: string; apiSecret: string };

  if (!apiKey || !apiSecret) {
    return NextResponse.json({ ok: false, error: 'API key and secret are required.' }, { status: 400 });
  }

  const credentials = Buffer.from(apiKey + ':' + apiSecret).toString('base64');

  let status: number;
  let rawBody: string;

  try {
    const response = await fetch('https://live.trading212.com/api/v0/equity/account/cash', {
      method: 'GET',
      headers: {
        Authorization: 'Basic ' + credentials,
        'Content-Type': 'application/json',
      },
    });
    status = response.status;
    rawBody = await response.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `Request to Trading 212 failed: ${msg}` });
  }

  if (status >= 200 && status < 300) {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(rawBody); } catch { /* leave empty */ }
    return NextResponse.json({
      ok: true,
      accountId: String(data.id ?? 'unknown'),
      currency: String(data.currencyCode ?? data.currency ?? 'GBP'),
      cash: Number(data.free ?? data.cash ?? 0),
    });
  }

  if (status === 401) {
    const body = rawBody.trim();
    return NextResponse.json({
      ok: false,
      status,
      rawBody,
      error: body
        ? `Trading 212 returned 401: ${body}`
        : 'Trading 212 returned 401 with empty response — check your API key and secret are correct',
    });
  }

  if (status === 403) {
    return NextResponse.json({
      ok: false,
      status,
      rawBody,
      error: `Trading 212 returned 403 Forbidden — your key may not have the required permissions${rawBody ? `: ${rawBody}` : ''}`,
    });
  }

  return NextResponse.json({
    ok: false,
    status,
    rawBody,
    error: `Trading 212 returned HTTP ${status}: ${rawBody || '(empty body)'}`,
  });
}

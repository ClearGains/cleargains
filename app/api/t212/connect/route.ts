import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  // Credentials are base64-encoded by the browser (btoa) and sent as a header.
  // We pass the encoded value directly to Trading 212 — no server-side re-encoding.
  const encoded = request.headers.get('x-t212-auth');

  if (!encoded) {
    return NextResponse.json({ ok: false, error: 'Missing x-t212-auth header.' }, { status: 400 });
  }

  let status: number;
  let rawBody: string;

  try {
    const response = await fetch('https://live.trading212.com/api/v0/equity/account/cash', {
      method: 'GET',
      headers: {
        Authorization: 'Basic ' + encoded,
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
    const trimmed = rawBody.trim();
    return NextResponse.json({
      ok: false,
      status,
      rawBody,
      error: trimmed
        ? `Trading 212 returned 401: ${trimmed}`
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

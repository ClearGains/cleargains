import { NextRequest, NextResponse } from 'next/server';

async function probe(url: string, authHeader: string): Promise<{ url: string; status: number; rawBody: string }> {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    cache: 'no-store',
  });
  const rawBody = await res.text();
  return { url, status: res.status, rawBody };
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { apiKey, apiSecret } = body as { apiKey: string; apiSecret: string };

  // Trim to strip invisible whitespace from copy-paste
  const key = (apiKey ?? '').trim();
  const secret = (apiSecret ?? '').trim();

  if (!key || !secret) {
    return NextResponse.json(
      { ok: false, error: 'API key and secret must not be empty.' },
      { status: 400 }
    );
  }

  // Server-side base64 — identical output to btoa() for ASCII strings
  const credentials = Buffer.from(key + ':' + secret).toString('base64');
  const authHeader = 'Basic ' + credentials;

  // Log first 20 chars to confirm encoding without exposing full value
  console.log('[T212 test] key length:', key.length, '| key[0:4]:', key.slice(0, 4));
  console.log('[T212 test] secret length:', secret.length);
  console.log('[T212 test] Authorization header[0:20]:', authHeader.slice(0, 20));
  console.log('[T212 test] base64 credentials[0:20]:', credentials.slice(0, 20));

  const urls = [
    'https://live.trading212.com/api/v0/equity/account/info',
    'https://live.trading212.com/api/v0/equity/account/cash',
  ];

  let results: { url: string; status: number; rawBody: string }[];

  try {
    results = await Promise.all(urls.map((url) => probe(url, authHeader)));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('[T212 test] network error:', msg);
    return NextResponse.json({ ok: false, error: `Request to Trading 212 failed: ${msg}` });
  }

  for (const r of results) {
    console.log(`[T212 test] ${r.url} → ${r.status} | body: ${r.rawBody}`);
  }

  const success = results.find((r) => r.status >= 200 && r.status < 300);
  if (success) {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(success.rawBody); } catch { /* leave empty */ }
    return NextResponse.json({
      ok: true,
      accountId: data.id ?? 'unknown',
      currency: data.currencyCode ?? data.free ?? 'GBP',
      results,
    });
  }

  // All failed — return full diagnostic info for every endpoint
  const summary = results
    .map((r) => `${r.url.split('/').pop()} → HTTP ${r.status}: ${r.rawBody || '(empty body)'}`)
    .join(' | ');

  return NextResponse.json({
    ok: false,
    error: summary,
    results,
  });
}

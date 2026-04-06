import { NextRequest, NextResponse } from 'next/server';

async function probe(
  label: string,
  url: string,
  authHeader: string
): Promise<{ label: string; url: string; status: number; rawBody: string }> {
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
  return { label, url, status: res.status, rawBody };
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { apiKey, apiSecret, clientEncoded } = body as {
    apiKey: string;
    apiSecret: string;
    clientEncoded?: string; // pre-encoded by browser btoa()
  };

  // Strip ALL whitespace: spaces, newlines, carriage returns, tabs
  const key = (apiKey ?? '').replace(/[\s\n\r\t]/g, '');
  const secret = (apiSecret ?? '').replace(/[\s\n\r\t]/g, '');

  console.log('[T212 test] key length after strip:', key.length, '| key[0:4]:', key.slice(0, 4));
  console.log('[T212 test] secret length after strip:', secret.length);

  if (!key || !secret) {
    return NextResponse.json(
      { ok: false, error: 'API key and secret must not be empty.' },
      { status: 400 }
    );
  }

  // Approach A: server-side encoding with explicit utf8
  const rawA = key + ':' + secret;
  const encodedA = Buffer.from(rawA, 'utf8').toString('base64');
  const headerA = 'Basic ' + encodedA;
  console.log('[T212 test] server-encoded header[0:20]:', headerA.slice(0, 20));
  console.log('[T212 test] server raw string length:', rawA.length);

  // Approach B: client-side btoa() result forwarded as-is
  const headerB = clientEncoded ? 'Basic ' + clientEncoded : null;
  if (headerB) {
    console.log('[T212 test] client-encoded header[0:20]:', headerB.slice(0, 20));
  }

  const url = 'https://live.trading212.com/api/v0/equity/account/summary';

  const attempts: Promise<{ label: string; url: string; status: number; rawBody: string }>[] = [
    probe('server-encoded', url, headerA),
  ];
  if (headerB) {
    attempts.push(probe('client-encoded', url, headerB));
  }

  let results: { label: string; url: string; status: number; rawBody: string }[];
  try {
    results = await Promise.all(attempts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('[T212 test] network error:', msg);
    return NextResponse.json({ ok: false, error: `Request to Trading 212 failed: ${msg}` });
  }

  for (const r of results) {
    console.log(`[T212 test] [${r.label}] ${r.status} | body: ${r.rawBody}`);
  }

  const success = results.find((r) => r.status >= 200 && r.status < 300);
  if (success) {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(success.rawBody); } catch { /* leave empty */ }
    return NextResponse.json({
      ok: true,
      accountId: data.id ?? 'unknown',
      currency: data.currencyCode ?? 'GBP',
      usedEncoding: success.label,
      keyLength: key.length,
      secretLength: secret.length,
      results,
    });
  }

  const summary = results
    .map((r) => `[${r.label}] HTTP ${r.status}: ${r.rawBody || '(empty body)'}`)
    .join(' | ');

  return NextResponse.json({
    ok: false,
    error: summary,
    keyLength: key.length,
    secretLength: secret.length,
    results,
  });
}

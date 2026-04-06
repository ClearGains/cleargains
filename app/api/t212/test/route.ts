import { NextRequest, NextResponse } from 'next/server';
import https from 'https';

type ProbeResult = { label: string; status: number; rawBody: string };

// Method A & B: fetch() with Authorization header
async function probeFetch(label: string, url: string, authHeader: string): Promise<ProbeResult> {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
    },
    cache: 'no-store',
  });
  const rawBody = await res.text();
  return { label, status: res.status, rawBody };
}

// Method C: Node.js https.request with auth option — same as curl -u key:secret
function probeNodeAuth(key: string, secret: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const options: https.RequestOptions = {
      hostname: 'live.trading212.com',
      path: '/api/v0/equity/account/cash',
      method: 'GET',
      auth: key + ':' + secret,
      headers: { Accept: 'application/json' },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ label: 'node-https-auth', status: res.statusCode ?? 0, rawBody: data }));
    });
    req.on('error', (err) => resolve({ label: 'node-https-auth', status: 0, rawBody: `error: ${err.message}` }));
    req.end();
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { apiKey, apiSecret, clientEncoded } = body as {
    apiKey: string;
    apiSecret: string;
    clientEncoded?: string;
  };

  // Strip ALL whitespace: spaces, newlines, carriage returns, tabs
  const key = (apiKey ?? '').replace(/[\s\n\r\t]/g, '');
  const secret = (apiSecret ?? '').replace(/[\s\n\r\t]/g, '');

  console.log('[T212 test] key length:', key.length, '| key[0:4]:', key.slice(0, 4));
  console.log('[T212 test] secret length:', secret.length);

  if (!key || !secret) {
    return NextResponse.json({ ok: false, error: 'API key and secret must not be empty.' }, { status: 400 });
  }

  const url = 'https://live.trading212.com/api/v0/equity/account/cash';

  // Method A: server-side Buffer.from().toString('base64')
  const serverEncoded = Buffer.from(key + ':' + secret).toString('base64');
  console.log('[T212 test] method-A header[0:20]:', ('Basic ' + serverEncoded).slice(0, 20));

  // Method B: client-side btoa() forwarded from browser
  console.log('[T212 test] method-B clientEncoded present:', !!clientEncoded);

  const attempts: Promise<ProbeResult>[] = [
    probeFetch('fetch-server-b64', url, 'Basic ' + serverEncoded),
    probeNodeAuth(key, secret),
  ];
  if (clientEncoded) {
    console.log('[T212 test] method-B header[0:20]:', ('Basic ' + clientEncoded).slice(0, 20));
    attempts.push(probeFetch('fetch-client-btoa', url, 'Basic ' + clientEncoded));
  }

  let results: ProbeResult[];
  try {
    results = await Promise.all(attempts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('[T212 test] unexpected error:', msg);
    return NextResponse.json({ ok: false, error: `Request failed: ${msg}` });
  }

  for (const r of results) {
    console.log(`[T212 test] [${r.label}] HTTP ${r.status} | body: ${r.rawBody}`);
  }

  const success = results.find((r) => r.status >= 200 && r.status < 300);
  if (success) {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(success.rawBody); } catch { /* leave empty */ }
    return NextResponse.json({
      ok: true,
      accountId: data.id ?? 'unknown',
      currency: data.currencyCode ?? 'GBP',
      usedMethod: success.label,
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

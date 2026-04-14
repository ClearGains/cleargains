import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const encoded = request.headers.get('x-t212-auth');
  if (!encoded) return NextResponse.json({ error: 'Missing x-t212-auth' }, { status: 400 });
  const env = request.nextUrl.searchParams.get('env') ?? 'live'; // 'live' | 'isa' | 'demo'
  const base = env === 'demo'
    ? 'https://demo.trading212.com/api/v0'
    : 'https://live.trading212.com/api/v0';
  try {
    const res = await fetch(`${base}/equity/portfolio`, {
      headers: { Authorization: 'Basic ' + encoded },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) return NextResponse.json({ error: text }, { status: res.status });
    return NextResponse.json(JSON.parse(text));
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

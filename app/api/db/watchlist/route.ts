import { NextRequest, NextResponse } from 'next/server';
import { DB, isRedisConfigured } from '@/lib/db';

export async function GET() {
  if (!isRedisConfigured) return NextResponse.json([]);
  try { return NextResponse.json(await DB.getWatchlist()); }
  catch { return NextResponse.json([]); }
}

export async function POST(req: NextRequest) {
  if (!isRedisConfigured) return NextResponse.json({ ok: true });
  try {
    await DB.saveWatchlist(await req.json() as string[]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

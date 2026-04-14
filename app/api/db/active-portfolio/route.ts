import { NextRequest, NextResponse } from 'next/server';
import { DB, isRedisConfigured } from '@/lib/db';

export async function GET() {
  if (!isRedisConfigured) return NextResponse.json({ id: null });
  try { return NextResponse.json({ id: await DB.getActivePortfolio() }); }
  catch { return NextResponse.json({ id: null }); }
}

export async function POST(req: NextRequest) {
  if (!isRedisConfigured) return NextResponse.json({ ok: true });
  try {
    const { id } = await req.json() as { id: string };
    await DB.setActivePortfolio(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

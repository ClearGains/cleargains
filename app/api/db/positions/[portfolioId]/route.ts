import { NextRequest, NextResponse } from 'next/server';
import { DB, isRedisConfigured } from '@/lib/db';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ portfolioId: string }> }
) {
  if (!isRedisConfigured) return NextResponse.json([]);
  try {
    const { portfolioId } = await params;
    return NextResponse.json(await DB.getPositions(portfolioId));
  } catch { return NextResponse.json([]); }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ portfolioId: string }> }
) {
  if (!isRedisConfigured) return NextResponse.json({ ok: true });
  try {
    const { portfolioId } = await params;
    await DB.savePositions(portfolioId, await req.json());
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

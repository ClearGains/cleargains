import { NextRequest, NextResponse } from 'next/server';
import { DB, isRedisConfigured } from '@/lib/db';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ portfolioId: string }> }
) {
  if (!isRedisConfigured) return NextResponse.json({ amount: 1000 });
  try {
    const { portfolioId } = await params;
    return NextResponse.json({ amount: await DB.getBudget(portfolioId) });
  } catch { return NextResponse.json({ amount: 1000 }); }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ portfolioId: string }> }
) {
  if (!isRedisConfigured) return NextResponse.json({ ok: true });
  try {
    const { portfolioId } = await params;
    const { amount } = await req.json() as { amount: number };
    await DB.saveBudget(portfolioId, amount);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

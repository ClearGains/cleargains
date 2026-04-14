import { NextRequest, NextResponse } from 'next/server';
import { DB } from '@/lib/db';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ portfolioId: string }> }
) {
  try {
    const { portfolioId } = await params;
    const amount = await DB.getBudget(portfolioId);
    return NextResponse.json({ amount });
  } catch (err) {
    console.error('[db/budget GET]', err);
    return NextResponse.json({ amount: 1000 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ portfolioId: string }> }
) {
  try {
    const { portfolioId } = await params;
    const { amount } = await req.json() as { amount: number };
    await DB.saveBudget(portfolioId, amount);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[db/budget POST]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

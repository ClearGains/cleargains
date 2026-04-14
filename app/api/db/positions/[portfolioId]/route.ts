import { NextRequest, NextResponse } from 'next/server';
import { DB } from '@/lib/db';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ portfolioId: string }> }
) {
  try {
    const { portfolioId } = await params;
    const data = await DB.getPositions(portfolioId);
    return NextResponse.json(data);
  } catch (err) {
    console.error('[db/positions GET]', err);
    return NextResponse.json([]);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ portfolioId: string }> }
) {
  try {
    const { portfolioId } = await params;
    const body = await req.json();
    await DB.savePositions(portfolioId, body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[db/positions POST]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

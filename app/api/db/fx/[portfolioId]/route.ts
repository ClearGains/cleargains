import { NextRequest, NextResponse } from 'next/server';
import { DB, isRedisConfigured } from '@/lib/db';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ portfolioId: string }> }
) {
  if (!isRedisConfigured) return NextResponse.json({ positions: [], trades: [] });
  try {
    const { portfolioId } = await params;
    const [positions, trades] = await Promise.all([
      DB.getFXPositions(portfolioId),
      DB.getFXTrades(portfolioId),
    ]);
    return NextResponse.json({ positions, trades });
  } catch { return NextResponse.json({ positions: [], trades: [] }); }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ portfolioId: string }> }
) {
  if (!isRedisConfigured) return NextResponse.json({ ok: true });
  try {
    const { portfolioId } = await params;
    const { positions, trades } = await req.json() as { positions?: unknown[]; trades?: unknown[] };
    if (positions !== undefined) await DB.saveFXPositions(portfolioId, positions as never);
    if (trades    !== undefined) await DB.saveFXTrades(portfolioId, trades as never);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

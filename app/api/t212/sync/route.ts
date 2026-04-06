import { NextRequest, NextResponse } from 'next/server';
import {
  fetchT212AccountInfo,
  fetchT212Cash,
  fetchT212Portfolio,
} from '@/lib/t212';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { accountType = 'DEMO' } = body as { accountType: 'LIVE' | 'DEMO' };

  if (!process.env.T212_API_KEY || !process.env.T212_API_SECRET) {
    return NextResponse.json(
      { error: 'T212_API_KEY and T212_API_SECRET must both be configured.' },
      { status: 503 }
    );
  }

  try {
    const [accountInfo, cashData, positions] = await Promise.all([
      fetchT212AccountInfo(accountType),
      fetchT212Cash(accountType),
      fetchT212Portfolio(accountType),
    ]);

    const portfolioValue = positions.reduce(
      (sum: number, pos) => sum + pos.currentPrice * pos.quantity,
      0
    );

    return NextResponse.json({
      id: accountInfo.id ?? 'unknown',
      type: accountType,
      currency: accountInfo.currencyCode ?? cashData.currency ?? 'GBP',
      cash: cashData.free ?? cashData.cash ?? 0,
      portfolioValue,
      positions,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('T212 sync error:', err);
    return NextResponse.json(
      { error: `T212 sync failed: ${err instanceof Error ? err.message : 'Unknown error'}` },
      { status: 500 }
    );
  }
}

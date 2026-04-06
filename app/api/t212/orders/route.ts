import { NextRequest, NextResponse } from 'next/server';
import { fetchT212Orders } from '@/lib/t212';
import { Trade } from '@/lib/types';

export async function GET(request: NextRequest) {
  const accountType =
    (request.nextUrl.searchParams.get('accountType') as 'LIVE' | 'DEMO') ??
    'DEMO';
  const limit = parseInt(request.nextUrl.searchParams.get('limit') ?? '50', 10);

  if (!process.env.T212_API_KEY) {
    return NextResponse.json(
      { error: 'T212_API_KEY not configured' },
      { status: 503 }
    );
  }

  try {
    const orders = await fetchT212Orders(accountType, limit);

    // Map T212 orders to our Trade format
    const trades: Trade[] = orders
      .filter((o) => o.fillDate && o.price > 0)
      .map((order) => ({
        id: order.id,
        ticker: order.ticker,
        type: order.side,
        quantity: order.quantity,
        price: order.price,
        currency: order.currency ?? 'GBP',
        gbpValue: order.quantity * order.price,
        date: order.fillDate,
        fees: order.taxes ?? 0,
        isISA: false,
        source: 't212' as const,
      }));

    return NextResponse.json({ trades, total: trades.length });
  } catch (err) {
    console.error('T212 orders error:', err);
    return NextResponse.json(
      { error: `T212 orders failed: ${err instanceof Error ? err.message : 'Unknown error'}` },
      { status: 500 }
    );
  }
}

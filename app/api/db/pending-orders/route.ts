import { NextRequest, NextResponse } from 'next/server';
import { DB } from '@/lib/db';

export async function GET() {
  try {
    const data = await DB.getPendingOrders();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[db/pending-orders GET]', err);
    return NextResponse.json([]);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as unknown[];
    await DB.savePendingOrders(body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[db/pending-orders POST]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

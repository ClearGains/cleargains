import { NextRequest, NextResponse } from 'next/server';
import { DB } from '@/lib/db';

export async function GET() {
  try {
    const id = await DB.getActivePortfolio();
    return NextResponse.json({ id });
  } catch (err) {
    console.error('[db/active-portfolio GET]', err);
    return NextResponse.json({ id: null });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { id } = await req.json() as { id: string };
    await DB.setActivePortfolio(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[db/active-portfolio POST]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

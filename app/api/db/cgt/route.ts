import { NextRequest, NextResponse } from 'next/server';
import { DB } from '@/lib/db';

export async function GET() {
  try {
    const data = await DB.getCGTHistory();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[db/cgt GET]', err);
    return NextResponse.json([]);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    await DB.saveCGTHistory(body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[db/cgt POST]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { DB, isRedisConfigured } from '@/lib/db';

export async function GET() {
  if (!isRedisConfigured) return NextResponse.json(null);
  try { return NextResponse.json(await DB.getEncryptedKeys()); }
  catch { return NextResponse.json(null); }
}

export async function POST(req: Request) {
  if (!isRedisConfigured) return NextResponse.json({ ok: true });
  try {
    await DB.saveEncryptedKeys(await req.json());
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

export async function DELETE() {
  if (!isRedisConfigured) return NextResponse.json({ ok: true });
  try {
    await DB.deleteEncryptedKeys();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

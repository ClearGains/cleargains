import { NextResponse } from 'next/server';
import { DB } from '@/lib/db';

/**
 * Encrypted T212 credentials storage.
 *
 * Only AES-256-GCM encrypted blobs are stored here — raw API keys
 * are NEVER sent to or stored on this server. Even if Redis were
 * compromised, the encrypted blobs are useless without the user's
 * SITE_PASSWORD.
 */

/** GET  — retrieve encrypted key blobs (if any) */
export async function GET() {
  try {
    const data = await DB.getEncryptedKeys();
    return NextResponse.json(data ?? null);
  } catch {
    return NextResponse.json(null);
  }
}

/** POST — save encrypted key blobs */
export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      live?: { key: string; secret: string };
      isa?:  { key: string; secret: string };
      demo?: { key: string; secret: string };
    };
    await DB.saveEncryptedKeys(body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

/** DELETE — remove all encrypted key blobs */
export async function DELETE() {
  try {
    await DB.deleteEncryptedKeys();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

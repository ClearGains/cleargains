import { put } from '@vercel/blob';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Saves a ClearGains backup to Vercel Blob storage.
 *
 * POST body: { backup: BackupFile, accountId?: string }
 * Response:  { ok: true, syncUrl: string } | { ok: false, error: string }
 *
 * If accountId is supplied the blob is stored at a deterministic path
 * (strategies/{accountId}.json) so the same URL is returned on every save.
 * Anonymous saves use a timestamp-based path.
 */
export async function POST(request: NextRequest) {
  let body: { backup: unknown; accountId?: string };
  try {
    body = await request.json() as { backup: unknown; accountId?: string };
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { backup, accountId } = body;
  if (!backup) {
    return NextResponse.json({ ok: false, error: 'Missing backup field' }, { status: 400 });
  }

  const path =
    accountId && /^[a-f0-9]{16}$/.test(accountId)
      ? `strategies/${accountId}.json`
      : `strategies/anon-${Date.now()}.json`;

  try {
    const blob = await put(path, JSON.stringify(backup), {
      access: 'public',
      addRandomSuffix: false,
    });
    return NextResponse.json({ ok: true, syncUrl: blob.url });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Save failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}

import { list } from '@vercel/blob';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Fetches a ClearGains backup from Vercel Blob storage.
 *
 * GET /api/sync/load?accountId=a3f7c291b8e240d1
 *   → looks up strategies/{accountId}.json in blob storage
 *
 * GET /api/sync/load?url=https://...vercel-storage.com/strategies/xxx.json
 *   → fetches that specific blob URL directly
 *
 * POST /api/sync/load  { url: string }
 *   → same as GET ?url= but via request body
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const accountId = searchParams.get('accountId');
  const rawUrl    = searchParams.get('url');

  let targetUrl: string;

  if (accountId) {
    if (!/^[a-f0-9]{16}$/.test(accountId)) {
      return NextResponse.json({ ok: false, error: 'Invalid account ID format.' }, { status: 400 });
    }
    try {
      const { blobs } = await list({ prefix: `strategies/${accountId}.json` });
      if (!blobs.length) {
        return NextResponse.json({
          ok: false,
          error: 'No strategies found for this account — save from another device first.',
        });
      }
      targetUrl = blobs[0].url;
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: `Lookup failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      );
    }
  } else if (rawUrl) {
    // Accept Vercel Blob URLs only.
    // Legacy npoint.io / paste.rs URLs are accepted read-only so existing users
    // can still restore old backups before re-saving to Vercel Blob.
    const isVercelBlob = rawUrl.includes('vercel-storage.com') || rawUrl.includes('blob.vercel.com');
    const isLegacy     = rawUrl.startsWith('https://api.npoint.io/') || rawUrl.startsWith('https://paste.rs/');
    if (!isVercelBlob && !isLegacy) {
      return NextResponse.json(
        { ok: false, error: 'URL must be from Vercel Blob storage (or a legacy npoint.io/paste.rs URL).' },
        { status: 400 },
      );
    }
    targetUrl = rawUrl;
  } else {
    return NextResponse.json({ ok: false, error: 'Provide ?accountId= or ?url=' }, { status: 400 });
  }

  return fetchAndValidate(targetUrl, !!accountId);
}

export async function POST(request: NextRequest) {
  let body: { url?: string };
  try { body = await request.json() as { url?: string }; }
  catch { return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 }); }

  const { url } = body;
  if (!url) return NextResponse.json({ ok: false, error: 'Missing url field' }, { status: 400 });

  return fetchAndValidate(url, false);
}

async function fetchAndValidate(targetUrl: string, byAccountId: boolean): Promise<NextResponse> {
  try {
    const response = await fetch(targetUrl, {
      headers: { Accept: 'application/json, text/plain, */*' },
    });

    if (response.status === 404) {
      return NextResponse.json({
        ok: false,
        error: byAccountId
          ? 'No strategies found for this account — save from another device first.'
          : 'Backup not found — the link may be invalid.',
      });
    }

    if (!response.ok) {
      return NextResponse.json({ ok: false, error: `Storage returned ${response.status}.` });
    }

    let backup: unknown;
    try { backup = await response.json(); }
    catch { return NextResponse.json({ ok: false, error: 'The URL content is not valid JSON.' }); }

    const b = backup as Record<string, unknown>;
    if (!b.version || !b.data || !b.exportedAt) {
      return NextResponse.json({ ok: false, error: 'This is not a valid ClearGains backup file.' });
    }

    return NextResponse.json({ ok: true, backup });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Load failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}

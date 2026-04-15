import { NextRequest, NextResponse } from 'next/server';

/**
 * Fetches a ClearGains backup from npoint.io server-side (bypasses CORS).
 *
 * Usage:
 *   GET /api/sync/download?accountId=a3f7c291b8e240d1
 *     → Tries https://api.npoint.io/{accountId} automatically
 *
 *   GET /api/sync/download?url=https://api.npoint.io/abc123
 *     → Fetches that specific URL
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const accountId = searchParams.get('accountId');
  const rawUrl = searchParams.get('url');

  let targetUrl: string;

  if (accountId) {
    if (!/^[a-f0-9]{16}$/.test(accountId)) {
      return NextResponse.json({ ok: false, error: 'Invalid account ID format.' }, { status: 400 });
    }
    targetUrl = `https://api.npoint.io/${accountId}`;
  } else if (rawUrl) {
    // Allow npoint.io and paste.rs (backwards compat)
    const ALLOWED = ['https://api.npoint.io/', 'https://paste.rs/'];
    if (!ALLOWED.some(p => rawUrl.startsWith(p))) {
      return NextResponse.json(
        { ok: false, error: 'URL must be from https://api.npoint.io/ or https://paste.rs/' },
        { status: 400 },
      );
    }
    targetUrl = rawUrl;
  } else {
    return NextResponse.json({ ok: false, error: 'Provide ?accountId= or ?url=' }, { status: 400 });
  }

  try {
    const response = await fetch(targetUrl, {
      headers: { Accept: 'application/json, text/plain, */*' },
    });

    if (response.status === 404) {
      return NextResponse.json({
        ok: false,
        error: accountId
          ? 'No strategies found for this account — save from another device first.'
          : 'Backup not found — the link may have expired.',
      });
    }

    if (!response.ok) {
      return NextResponse.json({ ok: false, error: `Storage returned ${response.status}.` });
    }

    const text = await response.text();
    let backup: unknown;
    try {
      backup = JSON.parse(text);
    } catch {
      return NextResponse.json({ ok: false, error: 'The URL content is not valid JSON.' });
    }

    const b = backup as Record<string, unknown>;
    if (!b.version || !b.data || !b.exportedAt) {
      return NextResponse.json({ ok: false, error: 'This is not a valid ClearGains backup file.' });
    }

    return NextResponse.json({ ok: true, backup });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: `Download failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

import { NextRequest, NextResponse } from 'next/server';

/**
 * Fetches a ClearGains backup from a trusted cloud URL server-side
 * (avoids browser CORS restrictions).
 *
 * Usage: GET /api/sync/download?url=https://paste.rs/AbCd
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url');

  if (!url) {
    return NextResponse.json({ ok: false, error: 'Missing ?url parameter' }, { status: 400 });
  }

  // Only allow URLs from supported paste services
  const ALLOWED = ['https://paste.rs/'];
  if (!ALLOWED.some(prefix => url.startsWith(prefix))) {
    return NextResponse.json(
      { ok: false, error: 'URL must start with https://paste.rs/ — only paste.rs sync URLs are supported.' },
      { status: 400 },
    );
  }

  try {
    const response = await fetch(url, {
      headers: { Accept: 'text/plain, application/json, */*' },
    });

    if (response.status === 404) {
      return NextResponse.json({
        ok: false,
        error: 'Backup not found — the link may have expired (pastes expire after 30 days of inactivity).',
      });
    }

    if (!response.ok) {
      return NextResponse.json({
        ok: false,
        error: `Cloud storage returned ${response.status} for that URL.`,
      });
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
      return NextResponse.json({
        ok: false,
        error: 'This does not appear to be a ClearGains backup file.',
      });
    }

    return NextResponse.json({ ok: true, backup });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: `Download failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

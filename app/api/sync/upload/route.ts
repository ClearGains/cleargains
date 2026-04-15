import { NextRequest, NextResponse } from 'next/server';

/**
 * Saves a ClearGains backup to npoint.io.
 *
 * Strategy:
 *  1. If accountId is supplied, try to POST to https://api.npoint.io/{accountId}.
 *     npoint.io allows creating/updating a bin at a known path — this means the
 *     same API key always maps to the same sync URL on every device.
 *  2. If that fails (or no accountId), POST to https://api.npoint.io/ to create
 *     a new bin with a random ID and return that URL.
 *
 * Request body: { backup: BackupFile, accountId?: string }
 * Response:     { ok: true, syncUrl: string } | { ok: false, error: string }
 */
export async function POST(req: NextRequest) {
  let body: { backup: unknown; accountId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { backup, accountId } = body;
  if (!backup) {
    return NextResponse.json({ ok: false, error: 'Missing backup field' }, { status: 400 });
  }

  const jsonStr = JSON.stringify(backup);

  // ── Attempt 1: accountId-based URL ─────────────────────────────────────────
  if (accountId && /^[a-f0-9]{16}$/.test(accountId)) {
    try {
      const res = await fetch(`https://api.npoint.io/${accountId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonStr,
      });

      if (res.ok || res.status === 201) {
        const syncUrl = `https://api.npoint.io/${accountId}`;
        return NextResponse.json({ ok: true, syncUrl, source: 'accountId' });
      }
      // Non-2xx — fall through to attempt 2
    } catch {
      // Network error — fall through
    }
  }

  // ── Attempt 2: create new bin with random ID ────────────────────────────────
  try {
    const res = await fetch('https://api.npoint.io/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonStr,
    });

    if (!res.ok && res.status !== 201) {
      const errText = await res.text().catch(() => '');
      return NextResponse.json({
        ok: false,
        error: `npoint.io returned ${res.status}${errText ? ': ' + errText.slice(0, 200) : ''}`,
      });
    }

    // npoint.io may return JSON with an id/url field, or just the URL as text
    const raw = await res.text();
    let syncUrl: string | null = null;

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.url === 'string') syncUrl = parsed.url;
      else if (typeof parsed.id === 'string') syncUrl = `https://api.npoint.io/${parsed.id}`;
      else if (typeof parsed._id === 'string') syncUrl = `https://api.npoint.io/${parsed._id}`;
    } catch {
      // Response was plain text — check if it looks like a URL
      const trimmed = raw.trim();
      if (trimmed.startsWith('http')) syncUrl = trimmed;
    }

    // Last fallback: check the Location header (some services use redirects)
    if (!syncUrl) {
      const location = res.headers.get('location');
      if (location?.startsWith('http')) syncUrl = location;
    }

    if (!syncUrl) {
      return NextResponse.json({
        ok: false,
        error: `Could not parse npoint.io response. Raw: "${raw.slice(0, 200)}"`,
      });
    }

    return NextResponse.json({ ok: true, syncUrl, source: 'random' });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

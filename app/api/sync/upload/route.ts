import { NextRequest, NextResponse } from 'next/server';

/**
 * Proxies a ClearGains backup to paste.rs (free, anonymous, no auth).
 *
 * paste.rs API:
 *   POST https://paste.rs/  (body = any text, Content-Type: text/plain)
 *   → 201 Created, response body = full URL like https://paste.rs/AbCd
 *
 * Pastes expire after 30 days of inactivity.
 */
export async function POST(req: NextRequest) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const bodyStr = JSON.stringify(payload);

  try {
    const response = await fetch('https://paste.rs/', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: bodyStr,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return NextResponse.json({
        ok: false,
        error: `Cloud storage error ${response.status}${errText ? ': ' + errText.slice(0, 200) : ''}`,
      });
    }

    const syncUrl = (await response.text()).trim();

    if (!syncUrl.startsWith('http')) {
      return NextResponse.json({
        ok: false,
        error: `Unexpected response from storage service: "${syncUrl.slice(0, 100)}"`,
      });
    }

    return NextResponse.json({ ok: true, syncUrl });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

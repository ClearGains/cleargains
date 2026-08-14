import { NextRequest, NextResponse } from 'next/server';
import { resolveIgAuth, igRequestHeaders } from '@/lib/igAuthHeaders';

type RawPositionEntry = {
  position?: {
    dealId?: string; size?: number; direction?: string; level?: number;
    currency?: string; stopLevel?: number; limitLevel?: number;
    contractSize?: number; createdDate?: string; createdDateUTC?: string;
  };
  market?: {
    epic?: string; instrumentName?: string; bid?: number; offer?: number;
    instrumentType?: string; netChange?: number; percentageChange?: number;
  };
};

type RawPositionsData = { positions?: RawPositionEntry[] };

function normalisePositions(data: RawPositionsData) {
  return (data.positions ?? []).map(p => {
    const direction = p.position?.direction ?? '';
    const level     = p.position?.level ?? 0;
    const size      = p.position?.size ?? 0;
    const bid       = p.market?.bid ?? 0;
    const offer     = p.market?.offer ?? 0;
    const upl = direction === 'BUY'
      ? (bid   - level) * size
      : (level - offer) * size;
    return {
      dealId:         p.position?.dealId         ?? '',
      direction,
      size,
      level,
      upl:            Math.round(upl * 100) / 100,
      currency:       p.position?.currency        ?? 'GBP',
      stopLevel:      p.position?.stopLevel,
      limitLevel:     p.position?.limitLevel,
      contractSize:   p.position?.contractSize,
      createdDate:    p.position?.createdDateUTC ?? p.position?.createdDate,
      epic:           p.market?.epic              ?? '',
      instrumentName: p.market?.instrumentName    ?? '',
      bid,
      offer,
      instrumentType: p.market?.instrumentType,
    };
  });
}

export async function GET(request: NextRequest) {
  const steps: string[] = [];
  try {
    const env = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';
    const auth = resolveIgAuth(request);

    steps.push(`[1] env=${env}, auth=${auth?.style ?? 'MISSING'}`);

    if (!auth) {
      steps.push('[1] ✗ Missing auth headers — aborting');
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers', steps }, { status: 401 });
    }

    const baseUrl = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    // IG Spread Bet accounts use /positions (not /positions/otc).
    // Try /positions first; if that 404s, fall back to /positions/otc (CFD).
    const endpoints = [
      { path: `${baseUrl}/positions`,     version: '2', label: '/positions V2 (spreadbet)'  },
      { path: `${baseUrl}/positions/otc`, version: '2', label: '/positions/otc V2 (CFD)'    },
    ];

    let rawText = '';
    let usedLabel = '';
    for (const ep of endpoints) {
      steps.push(`[2] Trying ${ep.label}`);
      const r = await fetch(ep.path, { headers: igRequestHeaders(auth, ep.version) });
      steps.push(`[2] HTTP ${r.status}`);
      if (r.ok) {
        rawText   = await r.text();
        usedLabel = ep.label;
        break;
      }
      const errBody = await r.text().catch(() => '');
      steps.push(`[2] ${ep.label} error: ${errBody.slice(0, 150)}`);
    }

    if (!rawText) {
      steps.push('[2] ✗ All endpoints returned errors');
      return NextResponse.json({ ok: true, positions: [], steps });
    }
    steps.push(`[3] Got response via ${usedLabel} — length ${rawText.length}`);

    let data: RawPositionsData;

    try {
      data = JSON.parse(rawText) as RawPositionsData;
    } catch (parseErr) {
      steps.push(`[3] ✗ JSON parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
      return NextResponse.json({ ok: false, error: 'JSON parse error', steps, rawResponse: rawText.slice(0, 500) }, { status: 500 });
    }

    const rawCount = data.positions?.length ?? 0;
    steps.push(`[4] Parsed OK — positions array length: ${rawCount}`);
    if (rawCount > 0) {
      data.positions!.slice(0, 3).forEach((p, i) => {
        steps.push(`[4] position[${i}]: dealId=${p.position?.dealId ?? '?'} dir=${p.position?.direction ?? '?'} size=${p.position?.size ?? '?'} epic=${p.market?.epic ?? '?'}`);
      });
    } else {
      steps.push('[4] ⚠ No positions in response. Possible causes: wrong account selected, tokens for a different sub-account, or account is genuinely empty.');
    }

    const positions = normalisePositions(data);

    steps.push(`[5] Normalised ${positions.length} position(s) — returning`);
    console.log(`[ig/positions] ${env} → ${positions.length} position(s)`);
    return NextResponse.json({ ok: true, positions, steps, rawResponse: rawText.slice(0, 2000) });
  } catch (err) {
    steps.push(`[ERR] Exception: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error', steps },
      { status: 500 }
    );
  }
}

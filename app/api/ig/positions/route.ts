import { NextRequest, NextResponse } from 'next/server';

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
    const cst = request.headers.get('x-ig-cst') ?? '';
    const securityToken = request.headers.get('x-ig-security-token') ?? '';
    const apiKey = request.headers.get('x-ig-api-key') ?? '';
    const env = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';

    steps.push(`[1] env=${env}, apiKey=${apiKey.slice(0, 8)}…, CST=${cst ? cst.slice(0, 10) + '…' : 'MISSING'}, SecurityToken=${securityToken ? securityToken.slice(0, 10) + '…' : 'MISSING'}`);

    if (!cst || !securityToken || !apiKey) {
      steps.push('[1] ✗ Missing auth headers — aborting');
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers', steps }, { status: 401 });
    }

    const baseUrl = env === 'demo'
      ? 'https://demo-api.ig.com/gateway/deal'
      : 'https://api.ig.com/gateway/deal';

    steps.push(`[2] GET ${baseUrl}/positions/otc (Version: 2)`);

    const res = await fetch(`${baseUrl}/positions/otc`, {
      headers: {
        'X-IG-API-KEY': apiKey,
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken,
        'Accept': 'application/json; charset=UTF-8',
        'Version': '2',
      },
    });

    steps.push(`[2] HTTP ${res.status} ${res.statusText}`);

    // 404 from IG — capture body and retry with Version: 1 before giving up
    if (res.status === 404) {
      const body404 = await res.text().catch(() => '');
      steps.push(`[2] 404 body: ${body404.slice(0, 200) || '(empty)'}`);

      // Retry with Version: 1 — some SPREADBET accounts need V1
      steps.push('[2b] Retrying with Version: 1…');
      const res1 = await fetch(`${baseUrl}/positions/otc`, {
        headers: {
          'X-IG-API-KEY': apiKey,
          'CST': cst,
          'X-SECURITY-TOKEN': securityToken,
          'Accept': 'application/json; charset=UTF-8',
          'Version': '1',
        },
      });
      steps.push(`[2b] V1 response: HTTP ${res1.status}`);

      if (res1.ok) {
        const rawText1 = await res1.text();
        steps.push(`[2b] V1 body length: ${rawText1.length}`);
        try {
          const data1 = JSON.parse(rawText1) as { positions?: unknown[] };
          const count1 = data1.positions?.length ?? 0;
          steps.push(`[2b] V1 positions count: ${count1}`);
          if (count1 > 0) {
            // Re-parse as full position data
            const fullData = data1 as Parameters<typeof normalisePositions>[0];
            const positions = normalisePositions(fullData);
            steps.push(`[5] Normalised ${positions.length} position(s) via V1 — returning`);
            return NextResponse.json({ ok: true, positions, steps, rawResponse: rawText1.slice(0, 2000) });
          }
        } catch (e) {
          steps.push(`[2b] V1 JSON parse error: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        const body1 = await res1.text().catch(() => '');
        steps.push(`[2b] V1 error body: ${body1.slice(0, 200)}`);
      }

      // Diagnose which account/type these tokens are for
      try {
        const sessRes = await fetch(`${baseUrl}/session`, {
          headers: { 'X-IG-API-KEY': apiKey, 'CST': cst, 'X-SECURITY-TOKEN': securityToken, 'Accept': 'application/json; charset=UTF-8', 'Version': '1' },
          signal: AbortSignal.timeout(5_000),
        });
        if (sessRes.ok) {
          type SessResp = { currentAccountId?: string; accountId?: string; accounts?: Array<{ accountId: string; accountType: string }> };
          const sd = await sessRes.json() as SessResp;
          const activeId = sd.currentAccountId ?? sd.accountId ?? '?';
          const activeType = sd.accounts?.find(a => a.accountId === activeId)?.accountType ?? '?';
          steps.push(`[3] Tokens → accountId=${activeId} accountType=${activeType} (${sd.accounts?.map(a => `${a.accountId}:${a.accountType}`).join(', ') ?? 'no accounts'})`);
        } else {
          steps.push(`[3] Session check returned ${sessRes.status}`);
        }
      } catch (e) {
        steps.push(`[3] Session check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return NextResponse.json({ ok: true, positions: [], steps, rawResponse: `404 body: ${body404.slice(0, 300)}` });
    }

    const rawText = await res.text();
    steps.push(`[3] Raw response length: ${rawText.length} chars`);

    if (!res.ok) {
      steps.push(`[3] ✗ IG error: ${rawText.slice(0, 300)}`);
      console.error(`[ig/positions] IG ${res.status}:`, rawText.slice(0, 300));
      return NextResponse.json(
        { ok: false, error: `IG positions error ${res.status}`, detail: rawText.slice(0, 200), steps, rawResponse: rawText.slice(0, 500) },
        { status: res.status },
      );
    }

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

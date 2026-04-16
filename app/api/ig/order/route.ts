import { NextRequest, NextResponse } from 'next/server';
import { ALL_KNOWN_EPICS, isCfdEpic } from '@/lib/igConfig';

/** If the epic isn't in the central table, search IG and return the best match. */
async function resolveEpic(
  epic: string,
  apiKey: string, cst: string, securityToken: string,
  base: string,
): Promise<{ epic: string; resolvedVia: string }> {
  if (ALL_KNOWN_EPICS.has(epic)) return { epic, resolvedVia: 'table' };
  // Try searching by epic string itself
  try {
    const r = await fetch(`${base}/markets?searchTerm=${encodeURIComponent(epic)}&pageSize=5`, {
      headers: igHeaders(apiKey, cst, securityToken, '1'),
      signal: AbortSignal.timeout(5_000),
    });
    if (r.ok) {
      const d = await r.json() as { markets?: Array<{ epic: string; instrumentType: string }> };
      const match = d.markets?.find(m => ['CURRENCIES', 'INDICES', 'COMMODITIES', 'SHARES'].includes(m.instrumentType));
      if (match) return { epic: match.epic, resolvedVia: 'search' };
    }
  } catch { /* ignore */ }
  return { epic, resolvedVia: 'unresolved' };
}

function igHeaders(apiKey: string, cst: string, securityToken: string, version = '2'): Record<string, string> {
  return {
    'X-IG-API-KEY': apiKey,
    'CST': cst,
    'X-SECURITY-TOKEN': securityToken,
    'Content-Type': 'application/json',
    'Accept': 'application/json; charset=UTF-8',
    'Version': version,
  };
}

function getAuth(request: NextRequest) {
  return {
    cst:           request.headers.get('x-ig-cst') ?? '',
    securityToken: request.headers.get('x-ig-security-token') ?? '',
    apiKey:        request.headers.get('x-ig-api-key') ?? '',
    env:          (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live',
  };
}

function baseUrl(env: 'demo' | 'live') {
  return env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';
}

/**
 * CFD positions use expiry '-' (rolling / no expiry).
 * Spread-bet DFB positions use expiry 'DFB'.
 * Sending 'DFB' to a CFD account causes EXPIRY_NOT_SUPPORTED rejection.
 */
function resolveExpiry(epic: string, explicitExpiry?: string): string {
  if (explicitExpiry) return explicitExpiry;
  // UA.D.* = CFD stocks (e.g. UA.D.AAPL.CASH.IP)
  // IX.D.*.CFD.IP = CFD indices
  if (epic.startsWith('UA.D.') || epic.includes('.CFD.IP')) return '-';
  return 'DFB';
}

// ── POST — open market position OR create working order ───────────────────────
export async function POST(request: NextRequest) {
  try {
    const { cst, securityToken, apiKey, env } = getAuth(request);
    if (!cst || !securityToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }

    const body = await request.json() as {
      epic: string;
      expiry?: string;
      direction: 'BUY' | 'SELL';
      size: number;
      // MARKET (default) → positions/otc
      // LIMIT / STOP     → workingorders/otc
      orderType?: 'MARKET' | 'LIMIT' | 'STOP';
      level?: number;          // required for LIMIT/STOP working orders
      guaranteedStop?: boolean;
      stopDistance?: number;   // points below/above entry for auto stop-loss
      profitDistance?: number; // points above/below entry for auto take-profit
      stopLevel?: number;      // absolute stop level (alternative to stopDistance)
      limitLevel?: number;     // absolute limit level (alternative to profitDistance)
      currencyCode?: string;
      forceOpen?: boolean;
      timeInForce?: 'GOOD_TILL_CANCELLED' | 'GOOD_TILL_DATE';
    };

    const base = baseUrl(env);
    const orderType = body.orderType ?? 'MARKET';

    // Resolve epic — validate against verified set, search IG if unknown
    const { epic: resolvedEpic, resolvedVia } = await resolveEpic(body.epic, apiKey, cst, securityToken, base);

    // ── Working order (LIMIT or STOP) ─────────────────────────────────────────
    if (orderType === 'LIMIT' || orderType === 'STOP') {
      if (!body.level) {
        return NextResponse.json({ ok: false, error: 'level is required for LIMIT/STOP working orders' }, { status: 400 });
      }
      const woIsCfd = isCfdEpic(resolvedEpic);
      const woPayload: Record<string, unknown> = {
        epic:          resolvedEpic,
        expiry:        resolveExpiry(resolvedEpic, body.expiry),
        direction:     body.direction,
        size:          body.size,
        level:         body.level,
        type:          orderType,
        guaranteedStop: body.guaranteedStop ?? false,
        timeInForce:   body.timeInForce ?? 'GOOD_TILL_CANCELLED',
        forceOpen:     body.forceOpen ?? true,
      };
      if (!woIsCfd) {
        woPayload.currencyCode = body.currencyCode ?? 'GBP';
      }
      // Only include optional fields if they have actual values
      if (body.stopDistance)    woPayload.stopDistance  = body.stopDistance;
      if (body.profitDistance)  woPayload.limitDistance = body.profitDistance;
      if (body.stopLevel)       woPayload.stopLevel     = body.stopLevel;
      if (body.limitLevel)      woPayload.limitLevel    = body.limitLevel;
      const wRes = await fetch(`${base}/workingorders/otc`, {
        method: 'POST',
        headers: igHeaders(apiKey, cst, securityToken, '2'),
        body: JSON.stringify(woPayload),
      });
      let wData: { dealReference?: string; errorCode?: string } = {};
      try { wData = await wRes.json() as typeof wData; } catch {}
      if (!wRes.ok) {
        return NextResponse.json({ ok: false, error: wData.errorCode ?? `IG API error ${wRes.status}`, epic: resolvedEpic, sentPayload: woPayload, igBody: wData }, { status: wRes.status });
      }
      return NextResponse.json({ ok: true, dealReference: wData.dealReference, orderType, epic: resolvedEpic, resolvedVia });
    }

    // ── Market position ───────────────────────────────────────────────────────
    // IMPORTANT: do NOT include null fields — they cause silent rejections on some IG accounts.
    // SL/TP are applied separately via PUT after the deal is confirmed ACCEPTED.
    // CFD orders use margin — do NOT include currencyCode (IG rejects it on CFD accounts).
    const isCfd = isCfdEpic(resolvedEpic);
    const payload: Record<string, unknown> = {
      epic:          resolvedEpic,
      expiry:        resolveExpiry(resolvedEpic, body.expiry),
      direction:     body.direction,
      size:          body.size,
      orderType:     'MARKET',
      guaranteedStop: body.guaranteedStop ?? false,
      trailingStop:  false,
      forceOpen:     body.forceOpen ?? true,
    };
    // Spread-bet accounts require currencyCode (£/point); CFD accounts must NOT have it
    if (!isCfd) {
      payload.currencyCode = body.currencyCode ?? 'GBP';
    }

    console.log(`[ig/order] POST → ${env} ${resolvedEpic} (via ${resolvedVia})`, JSON.stringify(payload));

    const res = await fetch(`${base}/positions/otc`, {
      method: 'POST',
      headers: igHeaders(apiKey, cst, securityToken, '2'),
      body: JSON.stringify(payload),
    });

    // Capture fresh tokens — IG rotates CST/X-SECURITY-TOKEN on every API call
    const freshCst      = res.headers.get('CST') ?? null;
    const freshSecToken = res.headers.get('X-SECURITY-TOKEN') ?? null;

    const resText = await res.text();
    let data: { dealReference?: string; errorCode?: string } = {};
    try { data = JSON.parse(resText) as typeof data; } catch {}

    console.log(`[ig/order] IG response ${res.status}:`, resText.slice(0, 500));

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: data.errorCode ?? `IG API error ${res.status}`, epic: resolvedEpic, sentPayload: payload, igBody: data, igStatus: res.status }, { status: res.status });
    }

    const dealRef = data.dealReference;

    // ── Confirm the deal was ACCEPTED (IG processes deals asynchronously) ────
    type ConfirmData = { dealStatus?: string; dealId?: string; reason?: string; status?: string; level?: number; size?: number };
    let confirm: ConfirmData = {};
    if (dealRef) {
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise(r => setTimeout(r, 600));
        try {
          const cr = await fetch(`${base}/confirms/${encodeURIComponent(dealRef)}`, {
            headers: igHeaders(apiKey, cst, securityToken, '1'),
            signal: AbortSignal.timeout(5_000),
          });
          if (cr.ok) {
            confirm = await cr.json() as ConfirmData;
            console.log(`[ig/order] confirm attempt ${attempt + 1}:`, JSON.stringify(confirm));
            if (confirm.dealStatus === 'ACCEPTED' || confirm.dealStatus === 'REJECTED') break;
          }
        } catch { /* retry */ }
      }
    }

    if (confirm.dealStatus === 'REJECTED') {
      return NextResponse.json({
        ok: false,
        error: `Deal REJECTED by IG: ${confirm.reason ?? confirm.status ?? 'unknown reason'}`,
        dealReference: dealRef,
        dealStatus: 'REJECTED',
        reason: confirm.reason,
        epic: resolvedEpic,
        sentPayload: payload,
        igBody: confirm,
      }, { status: 422 });
    }

    // ── Apply SL/TP via separate PUT after deal is confirmed ACCEPTED ─────────
    // (Including these in the initial order causes rejections on some accounts)
    let slTpResult: { ok: boolean; error?: string } = { ok: true };
    if (confirm.dealId && confirm.level && (body.stopDistance || body.profitDistance)) {
      const fillPrice = confirm.level;
      const slTpPayload: Record<string, unknown> = { trailingStop: false };
      if (body.stopDistance) {
        slTpPayload.stopLevel = Math.round(
          (body.direction === 'BUY' ? fillPrice - body.stopDistance : fillPrice + body.stopDistance) * 100,
        ) / 100;
      }
      if (body.profitDistance) {
        slTpPayload.limitLevel = Math.round(
          (body.direction === 'BUY' ? fillPrice + body.profitDistance : fillPrice - body.profitDistance) * 100,
        ) / 100;
      }
      console.log(`[ig/order] SL/TP PUT for ${confirm.dealId}:`, JSON.stringify(slTpPayload));
      try {
        const upd = await fetch(`${base}/positions/otc/${encodeURIComponent(confirm.dealId)}`, {
          method: 'PUT',
          headers: igHeaders(apiKey, cst, securityToken, '2'),
          body: JSON.stringify(slTpPayload),
        });
        if (!upd.ok) {
          const updText = await upd.text();
          console.warn(`[ig/order] SL/TP update failed (${upd.status}):`, updText.slice(0, 200));
          slTpResult = { ok: false, error: `SL/TP update failed: ${upd.status}` };
        }
      } catch (e) {
        slTpResult = { ok: false, error: `SL/TP update error: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    return NextResponse.json({
      ok: true,
      dealReference: dealRef,
      dealId: confirm.dealId,
      dealStatus: confirm.dealStatus ?? 'UNKNOWN',
      level: confirm.level,
      orderType: 'MARKET',
      epic: resolvedEpic,
      resolvedVia,
      sentPayload: payload,
      slTpResult,
      freshCst,
      freshSecurityToken: freshSecToken,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}

// ── DELETE — close an existing position ──────────────────────────────────────
export async function DELETE(request: NextRequest) {
  try {
    const { cst, securityToken, apiKey, env } = getAuth(request);
    if (!cst || !securityToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }

    const body = await request.json() as { dealId: string; direction: 'BUY' | 'SELL'; size: number };
    const base = baseUrl(env);

    const closePayload = {
      dealId:      body.dealId,
      epic:        null,
      expiry:      null,
      direction:   body.direction,
      size:        body.size,
      level:       null,
      orderType:   'MARKET',
      timeInForce: null,
      quoteId:     null,
    };

    const res = await fetch(`${base}/positions/otc`, {
      method: 'POST',
      headers: { ...igHeaders(apiKey, cst, securityToken, '1'), '_method': 'DELETE' },
      body: JSON.stringify(closePayload),
    });

    let data: { dealReference?: string; errorCode?: string } = {};
    try { data = await res.json() as typeof data; } catch {}

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: data.errorCode ?? `IG API error ${res.status}` }, { status: res.status });
    }
    return NextResponse.json({ ok: true, dealReference: data.dealReference });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}

// ── PATCH — update stop/limit levels on an existing open position ─────────────
export async function PATCH(request: NextRequest) {
  try {
    const { cst, securityToken, apiKey, env } = getAuth(request);
    if (!cst || !securityToken || !apiKey) {
      return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
    }

    const body = await request.json() as {
      dealId: string;
      stopLevel?: number | null;
      limitLevel?: number | null;
    };

    if (!body.dealId) {
      return NextResponse.json({ ok: false, error: 'dealId is required' }, { status: 400 });
    }

    const base = baseUrl(env);
    const updatePayload = {
      stopLevel:   body.stopLevel ?? null,
      limitLevel:  body.limitLevel ?? null,
      trailingStop: false,
    };

    const res = await fetch(`${base}/positions/otc/${encodeURIComponent(body.dealId)}`, {
      method: 'PUT',
      headers: igHeaders(apiKey, cst, securityToken, '2'),
      body: JSON.stringify(updatePayload),
    });

    let data: { dealReference?: string; errorCode?: string } = {};
    try { data = await res.json() as typeof data; } catch {}

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: data.errorCode ?? `IG API error ${res.status}` }, { status: res.status });
    }
    return NextResponse.json({ ok: true, dealReference: data.dealReference });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}

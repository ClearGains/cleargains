import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const cst   = request.headers.get('x-ig-cst') ?? '';
  const token = request.headers.get('x-ig-security-token') ?? '';
  const key   = request.headers.get('x-ig-api-key') ?? '';
  const env   = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';
  const pageSize = request.nextUrl.searchParams.get('pageSize') ?? '100';

  if (!cst || !token || !key) {
    return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
  }

  const base = env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

  const commonHeaders = {
    'X-IG-API-KEY':     key,
    'CST':              cst,
    'X-SECURITY-TOKEN': token,
    'Accept':           'application/json; charset=UTF-8',
  };

  try {
    const activityRes = await fetch(
      `${base}/history/activity?pageSize=${pageSize}`,
      { headers: { ...commonHeaders, 'Version': '3' }, signal: AbortSignal.timeout(10_000) },
    );

    type Action = { actionType: string; affectedDealId: string };
    type ActivityDetails = {
      actions?:    Action[];
      currency:    string;
      direction:   string;
      level:       number;
      marketName:  string;
      size:        number;
      stopLevel:   number | null;
      limitLevel:  number | null;
    };
    type ActivityItem = {
      date:         string;
      epic:         string;
      dealId:       string;
      dealReference: string;
      status:       string;
      type:         string;
      description:  string;
      details?:     ActivityDetails;
    };

    let activities: ActivityItem[] = [];
    if (activityRes.ok) {
      const d = await activityRes.json() as { activities?: ActivityItem[] };
      activities = d.activities ?? [];
    } else {
      const body = await activityRes.text().catch(() => '');
      return NextResponse.json(
        { ok: false, error: `IG activity ${activityRes.status}: ${body.slice(0, 200)}` },
        { status: 502 },
      );
    }

    // Build maps keyed by the actual position dealId (= affectedDealId from the action).
    // IG's activity API assigns a new dealId to every confirmation (open, close, amend),
    // so we must look inside actions[] to find which position was affected.
    const openMap  = new Map<string, ActivityItem>();
    const closeMap = new Map<string, ActivityItem>();

    for (const a of activities) {
      if (a.type !== 'POSITION' || a.status !== 'ACCEPTED') continue;
      for (const action of (a.details?.actions ?? [])) {
        if (action.actionType === 'POSITION_OPENED') {
          openMap.set(action.affectedDealId, a);
        } else if (
          action.actionType === 'POSITION_CLOSED' ||
          action.actionType === 'POSITION_PARTIALLY_CLOSED'
        ) {
          closeMap.set(action.affectedDealId, a);
        }
      }
    }

    type MergedTrade = {
      positionDealId: string;
      epic:           string;
      marketName:     string;
      direction:      string;
      size:           number;
      openLevel:      number;
      closeLevel:     number | null;
      openedAt:       string;
      closedAt:       string | null;
      currency:       string;
      status:         'OPEN' | 'CLOSED';
    };

    const trades: MergedTrade[] = [];
    for (const [posId, openA] of openMap) {
      const closeA = closeMap.get(posId);
      trades.push({
        positionDealId: posId,
        epic:           openA.epic,
        marketName:     openA.details?.marketName ?? openA.epic,
        direction:      openA.details?.direction  ?? '',
        size:           openA.details?.size        ?? 0,
        openLevel:      openA.details?.level       ?? 0,
        closeLevel:     closeA?.details?.level     ?? null,
        openedAt:       openA.date,
        closedAt:       closeA?.date               ?? null,
        currency:       openA.details?.currency    ?? 'GBP',
        status:         closeA ? 'CLOSED' : 'OPEN',
      });
    }

    trades.sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime());

    return NextResponse.json({ ok: true, trades });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

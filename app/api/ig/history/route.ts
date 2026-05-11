import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/ig/history
 * Headers: x-ig-cst, x-ig-security-token, x-ig-api-key, x-ig-env
 * Query:   ?pageSize=50
 *
 * Returns recent activity (deal confirmations) from IG.
 */
export async function GET(request: NextRequest) {
  const cst   = request.headers.get('x-ig-cst') ?? '';
  const token = request.headers.get('x-ig-security-token') ?? '';
  const key   = request.headers.get('x-ig-api-key') ?? '';
  const env   = (request.headers.get('x-ig-env') ?? 'demo') as 'demo' | 'live';
  const pageSize = request.nextUrl.searchParams.get('pageSize') ?? '50';

  if (!cst || !token || !key) {
    return NextResponse.json({ ok: false, error: 'Missing IG auth headers' }, { status: 401 });
  }

  const base = env === 'demo'
    ? 'https://demo-api.ig.com/gateway/deal'
    : 'https://api.ig.com/gateway/deal';

  const commonHeaders = {
    'X-IG-API-KEY': key,
    'CST': cst,
    'X-SECURITY-TOKEN': token,
    'Accept': 'application/json; charset=UTF-8',
  };

  try {
    // Fetch activity log (deal confirmations — opens and closes)
    const activityRes = await fetch(
      `${base}/history/activity?pageSize=${pageSize}`,
      { headers: { ...commonHeaders, 'Version': '3' }, signal: AbortSignal.timeout(10_000) },
    );

    type ActivityItem = {
      date: string;
      epic: string;
      period: string;
      dealId: string;
      channel: string;
      dealReference: string;
      status: string;
      type: string;
      description: string;
      details?: {
        actions?: { actionType: string; affectedDealId: string }[];
        currency: string;
        dealReference: string;
        direction: string;
        goodTillDate: string | null;
        guaranteedStop: boolean;
        level: number;
        limitLevel: number | null;
        limitedRiskPremium: number | null;
        marketName: string;
        size: number;
        stopLevel: number | null;
        trailingStep: number | null;
        trailingStopDistance: number | null;
      };
    };

    let activities: ActivityItem[] = [];
    if (activityRes.ok) {
      const d = await activityRes.json() as { activities?: ActivityItem[] };
      activities = d.activities ?? [];
    }

    // Derive closed positions from POSITION_CLOSED activity entries
    const closed = activities
      .filter(a => a.type === 'POSITION' && a.status === 'ACCEPTED' &&
        (a.details?.actions ?? []).some(x => x.actionType === 'POSITION_CLOSED' || x.actionType === 'POSITION_PARTIALLY_CLOSED'))
      .map(a => ({
        date:       a.date,
        epic:       a.epic,
        dealId:     a.dealId,
        dealRef:    a.dealReference,
        direction:  a.details?.direction ?? '',
        size:       a.details?.size ?? 0,
        level:      a.details?.level ?? 0,
        marketName: a.details?.marketName ?? a.epic,
        currency:   a.details?.currency ?? 'GBP',
        description: a.description,
      }));

    // Opened entries (for source-tagging open positions)
    const opened = activities
      .filter(a => a.type === 'POSITION' && a.status === 'ACCEPTED' &&
        (a.details?.actions ?? []).some(x => x.actionType === 'POSITION_OPENED'))
      .map(a => ({
        date:       a.date,
        epic:       a.epic,
        dealId:     a.dealId,
        direction:  a.details?.direction ?? '',
        size:       a.details?.size ?? 0,
        level:      a.details?.level ?? 0,
        marketName: a.details?.marketName ?? a.epic,
      }));

    return NextResponse.json({ ok: true, closed, opened, raw: activities });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error', closed: [], opened: [] },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { hashFromEncoded, verifyLinks, isAuthorised, ACCOUNT_COOKIE, AccountType } from '@/lib/accountAuth';

// ── Hardcoded T212 ticker mapping ─────────────────────────────────────────────
const T212_TICKERS: Record<string, string> = {
  // Technology — US
  'AAPL':  'AAPL_US_EQ',
  'MSFT':  'MSFT_US_EQ',
  'GOOGL': 'GOOGL_US_EQ',
  'GOOG':  'GOOG_US_EQ',
  'AMZN':  'AMZN_US_EQ',
  'TSLA':  'TSLA_US_EQ',
  'NVDA':  'NVDA_US_EQ',
  'META':  'META_US_EQ',
  'NFLX':  'NFLX_US_EQ',
  'AMD':   'AMD_US_EQ',
  'INTC':  'INTC_US_EQ',
  'QCOM':  'QCOM_US_EQ',
  'AVGO':  'AVGO_US_EQ',
  'MU':    'MU_US_EQ',
  'AMAT':  'AMAT_US_EQ',
  'CRM':   'CRM_US_EQ',
  'ORCL':  'ORCL_US_EQ',
  'ADBE':  'ADBE_US_EQ',
  'UBER':  'UBER_US_EQ',
  'COIN':  'COIN_US_EQ',
  'PLTR':  'PLTR_US_EQ',
  'SNOW':  'SNOW_US_EQ',
  'SHOP':  'SHOP_US_EQ',
  'RBLX':  'RBLX_US_EQ',
  // Finance — US
  'JPM':   'JPM_US_EQ',
  'BAC':   'BAC_US_EQ',
  'GS':    'GS_US_EQ',
  'MS':    'MS_US_EQ',
  'WFC':   'WFC_US_EQ',
  'AXP':   'AXP_US_EQ',
  'V':     'V_US_EQ',
  'MA':    'MA_US_EQ',
  'PYPL':  'PYPL_US_EQ',
  'HOOD':  'HOOD_US_EQ',
  // Energy — US
  'XOM':   'XOM_US_EQ',
  'CVX':   'CVX_US_EQ',
  'COP':   'COP_US_EQ',
  'SLB':   'SLB_US_EQ',
  'OXY':   'OXY_US_EQ',
  'VLO':   'VLO_US_EQ',
  'EOG':   'EOG_US_EQ',
  'MPC':   'MPC_US_EQ',
  // Healthcare — US
  'JNJ':   'JNJ_US_EQ',
  'LLY':   'LLY_US_EQ',
  'UNH':   'UNH_US_EQ',
  'ABBV':  'ABBV_US_EQ',
  'MRK':   'MRK_US_EQ',
  'PFE':   'PFE_US_EQ',
  'AMGN':  'AMGN_US_EQ',
  'GILD':  'GILD_US_EQ',
  'REGN':  'REGN_US_EQ',
  'VRTX':  'VRTX_US_EQ',
  'MRNA':  'MRNA_US_EQ',
  'BIIB':  'BIIB_US_EQ',
  // Consumer — US
  'WMT':   'WMT_US_EQ',
  'COST':  'COST_US_EQ',
  'MCD':   'MCD_US_EQ',
  'NKE':   'NKE_US_EQ',
  'KO':    'KO_US_EQ',
  'PEP':   'PEP_US_EQ',
  'HD':    'HD_US_EQ',
  'TGT':   'TGT_US_EQ',
  'SBUX':  'SBUX_US_EQ',
  // UK — LSE
  'VOD':   'VOD_GB_EQ',
  'BP':    'BP_GB_EQ',
  'SHEL':  'SHEL_GB_EQ',
  'BARC':  'BARC_GB_EQ',
  'LLOY':  'LLOY_GB_EQ',
  'AZN':   'AZN_GB_EQ',
  'GSK':   'GSK_GB_EQ',
  'RIO':   'RIO_GB_EQ',
  'HSBA':  'HSBA_GB_EQ',
  'DGE':   'DGE_GB_EQ',
  'ULVR':  'ULVR_GB_EQ',
  'RR':    'RR_GB_EQ',
  'IAG':   'IAG_GB_EQ',
  'NWG':   'NWG_GB_EQ',
  'STAN':  'STAN_GB_EQ',
};

function resolveTicker(raw: string): string {
  const upper = raw.toUpperCase().trim();
  if (upper.includes('_')) return upper;
  const stripped = upper.replace(/\.L$/, '');
  return T212_TICKERS[stripped] ?? T212_TICKERS[upper] ?? `${upper}_US_EQ`;
}

async function resolveViaLiveInstruments(symbol: string, liveEncoded: string): Promise<string | null> {
  try {
    const res = await fetch('https://live.trading212.com/api/v0/equity/metadata/instruments', {
      headers: { Authorization: 'Basic ' + liveEncoded },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const instruments = await res.json() as Array<{ ticker: string; shortName: string }>;
    if (!Array.isArray(instruments)) return null;
    const upper = symbol.toUpperCase().replace(/\.L$/, '');
    const match = instruments.find(i => i.ticker.startsWith(upper + '_') || i.shortName?.toUpperCase() === upper);
    return match?.ticker ?? null;
  } catch {
    return null;
  }
}

/** POST a single T212 order. Also handles atomic 3-order placement (market + stop-loss + take-profit). */
export async function POST(request: NextRequest) {
  const encoded = request.headers.get('x-t212-auth');
  if (!encoded) {
    return NextResponse.json({ ok: false, error: 'Missing x-t212-auth header.' }, { status: 400 });
  }
  const liveEncoded = request.headers.get('x-t212-live-auth') ?? encoded;

  type Body = {
    ticker: string;
    quantity: number;          // positive = BUY, negative = SELL
    env?: 'demo' | 'live';
    // Order type (defaults to MARKET)
    orderType?: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
    limitPrice?: number;
    stopPrice?: number;
    timeValidity?: 'DAY' | 'GOOD_TILL_CANCEL';
    // Atomic strategy placement: also place SL stop + TP limit alongside market buy
    stopLossPrice?: number;
    takeProfitPrice?: number;
  };

  const body = await request.json() as Body;
  const {
    ticker,
    quantity,
    env = 'live',
    orderType = 'MARKET',
    limitPrice,
    stopPrice,
    timeValidity = 'GOOD_TILL_CANCEL',
    stopLossPrice,
    takeProfitPrice,
  } = body;

  // ── Account-link permission check ──────────────────────────────────────────
  const accountCookie = request.cookies.get(ACCOUNT_COOKIE)?.value;
  if (accountCookie) {
    const links = verifyLinks(accountCookie);
    if (links) {
      const accountType: AccountType = env === 'demo' ? 'demo' : env === 'live' ? 'live' : 'isa';
      const keyHash = hashFromEncoded(encoded);
      const claim = links.claims.find(c => c.accountType === accountType);
      if (claim && claim.keyHash !== keyHash) {
        return NextResponse.json({
          ok: false,
          error: `Permission denied: credentials do not match the ${accountType} account linked to this session.`,
        }, { status: 403 });
      }
    }
  }

  if (!ticker || quantity === undefined || quantity === null || quantity === 0) {
    return NextResponse.json({ ok: false, error: 'ticker and non-zero quantity are required.' }, { status: 400 });
  }
  if ((orderType === 'LIMIT' || orderType === 'STOP_LIMIT') && !limitPrice) {
    return NextResponse.json({ ok: false, error: 'limitPrice required for LIMIT and STOP_LIMIT orders.' }, { status: 400 });
  }
  if ((orderType === 'STOP' || orderType === 'STOP_LIMIT') && !stopPrice) {
    return NextResponse.json({ ok: false, error: 'stopPrice required for STOP and STOP_LIMIT orders.' }, { status: 400 });
  }

  const base = env === 'demo'
    ? 'https://demo.trading212.com/api/v0'
    : 'https://live.trading212.com/api/v0';

  // ── Resolve T212 ticker ────────────────────────────────────────────────────
  let resolvedTicker = resolveTicker(ticker);
  const isGuessed = !T212_TICKERS[ticker.toUpperCase().replace(/\.L$/, '')] && !ticker.includes('_');
  if (isGuessed) {
    const fromLive = await resolveViaLiveInstruments(ticker, liveEncoded);
    if (fromLive) resolvedTicker = fromLive;
  }

  // Fractional quantities: 4 decimal places, no minimum — supports percentage-based capital allocation
  const roundedQty = quantity < 0
    ? -(Math.round(Math.abs(quantity) * 10000) / 10000)
    : Math.round(quantity * 10000) / 10000;

  if (roundedQty === 0) {
    return NextResponse.json({ ok: false, error: 'Calculated quantity is zero after rounding.' }, { status: 400 });
  }

  // ── Build order payload ────────────────────────────────────────────────────
  let orderPath: string;
  let orderBody: Record<string, unknown>;

  switch (orderType) {
    case 'LIMIT':
      orderPath = `${base}/equity/orders/limit`;
      orderBody = { ticker: resolvedTicker, quantity: roundedQty, limitPrice, timeValidity };
      break;
    case 'STOP':
      orderPath = `${base}/equity/orders/stop`;
      orderBody = { ticker: resolvedTicker, quantity: roundedQty, stopPrice, timeValidity };
      break;
    case 'STOP_LIMIT':
      orderPath = `${base}/equity/orders/stop_limit`;
      orderBody = { ticker: resolvedTicker, quantity: roundedQty, stopPrice, limitPrice, timeValidity };
      break;
    default: // MARKET
      orderPath = `${base}/equity/orders/market`;
      orderBody = { ticker: resolvedTicker, quantity: roundedQty };
      break;
  }

  console.log(`[t212/live-order] → ${env} ${orderPath}`, JSON.stringify(orderBody));

  const mainResult = await placeT212Order(orderPath, orderBody, encoded);
  if (!mainResult.ok) return NextResponse.json(mainResult);

  const results: unknown[] = [mainResult.data];

  // ── Atomic SL/TP placement for strategy market buys ───────────────────────
  if (orderType === 'MARKET' && roundedQty > 0 && (stopLossPrice || takeProfitPrice)) {
    const fillPrice = (mainResult.data as Record<string, unknown>)?.fillPrice as number | undefined;
    const basePrice = fillPrice ?? stopLossPrice ?? takeProfitPrice ?? 0;

    // Stop-loss: STOP order with negative quantity (SELL stop)
    if (stopLossPrice) {
      const slBody = { ticker: resolvedTicker, quantity: -roundedQty, stopPrice: stopLossPrice, timeValidity: 'GOOD_TILL_CANCEL' };
      const slPath = `${base}/equity/orders/stop`;
      console.log(`[t212/live-order] → SL stop`, JSON.stringify(slBody));
      const slResult = await placeT212Order(slPath, slBody, encoded);
      results.push({ type: 'STOP_LOSS', ...(slResult.data as Record<string, unknown> ?? {}) });
      if (!slResult.ok) console.warn('[t212/live-order] SL placement failed:', slResult.error);
    }

    // Take-profit: LIMIT order with negative quantity (SELL limit)
    if (takeProfitPrice) {
      const tpBody = { ticker: resolvedTicker, quantity: -roundedQty, limitPrice: takeProfitPrice, timeValidity: 'GOOD_TILL_CANCEL' };
      const tpPath = `${base}/equity/orders/limit`;
      console.log(`[t212/live-order] → TP limit`, JSON.stringify(tpBody));
      const tpResult = await placeT212Order(tpPath, tpBody, encoded);
      results.push({ type: 'TAKE_PROFIT', ...(tpResult.data as Record<string, unknown> ?? {}) });
      if (!tpResult.ok) console.warn('[t212/live-order] TP placement failed:', tpResult.error);
    }

    void basePrice; // suppress unused warning when neither SL nor TP set
  }

  return NextResponse.json({
    ok: true,
    orderId: (mainResult.data as Record<string, unknown>)?.id,
    fillPrice: (mainResult.data as Record<string, unknown>)?.fillPrice,
    ticker: resolvedTicker,
    quantity: roundedQty,
    orderType,
    env,
    orders: results,
  });
}

/** Helper: place a single T212 order and return normalised result. */
async function placeT212Order(
  url: string,
  body: Record<string, unknown>,
  encoded: string
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + encoded, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* ok */ }

    if (res.ok) return { ok: true, data };

    const msg =
      (data.message as string) ||
      (data.code    as string) ||
      (data.error   as string) ||
      (data.errorCode as string) ||
      text.trim() ||
      `HTTP ${res.status}`;

    // Retry with integer quantity on precision error
    if (res.status === 400 && msg.toLowerCase().includes('precision')) {
      const qty = body.quantity as number;
      // Retry with fewer decimal places: try 2dp first, then integer
      const intQty = qty < 0
        ? -(Math.max(0.01, Math.round(Math.abs(qty) * 100) / 100))
        : Math.max(0.01, Math.round(qty * 100) / 100);
      const retry = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + encoded, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, quantity: intQty }),
        signal: AbortSignal.timeout(10_000),
      });
      const retryText = await retry.text();
      let retryData: Record<string, unknown> = {};
      try { retryData = JSON.parse(retryText); } catch { /* ok */ }
      if (retry.ok) return { ok: true, data: retryData };
    }

    return { ok: false, error: msg, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

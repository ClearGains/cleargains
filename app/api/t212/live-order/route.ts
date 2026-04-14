import { NextRequest, NextResponse } from 'next/server';

// ── Hardcoded T212 ticker mapping ─────────────────────────────────────────────
// Used when the instruments endpoint is unavailable (403 on demo) or for speed.
// Both live and demo T212 use identical ticker formats.
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

/**
 * Resolve a plain symbol (e.g. "AAPL") or Finnhub symbol (e.g. "VOD.L")
 * to a T212 ticker (e.g. "AAPL_US_EQ").
 *
 * Priority:
 * 1. Already in T212 format (contains underscore) → use as-is
 * 2. Strip ".L" suffix and look up in T212_TICKERS (UK LSE)
 * 3. Look up plain symbol in T212_TICKERS
 * 4. Fallback: SYMBOL_US_EQ
 */
function resolveTicker(raw: string): string {
  const upper = raw.toUpperCase().trim();

  // Already resolved (e.g. "AAPL_US_EQ")
  if (upper.includes('_')) return upper;

  // Finnhub UK suffix: "VOD.L" → "VOD"
  const stripped = upper.replace(/\.L$/, '');

  return T212_TICKERS[stripped] ?? T212_TICKERS[upper] ?? `${upper}_US_EQ`;
}

/**
 * Try to fetch the full instruments list from the LIVE endpoint and build a
 * richer mapping. Returns the resolved ticker if found, null otherwise.
 * Falls back silently if the request fails or returns 403.
 */
async function resolveViaLiveInstruments(
  symbol: string,
  liveEncoded: string
): Promise<string | null> {
  try {
    const res = await fetch(
      'https://live.trading212.com/api/v0/equity/metadata/instruments',
      {
        headers: { Authorization: 'Basic ' + liveEncoded },
        signal: AbortSignal.timeout(8_000),
      }
    );
    if (!res.ok) return null;

    const instruments = await res.json() as Array<{ ticker: string; shortName: string }>;
    if (!Array.isArray(instruments)) return null;

    const upper = symbol.toUpperCase().replace(/\.L$/, '');
    const match = instruments.find(
      i => i.ticker.startsWith(upper + '_') || i.shortName?.toUpperCase() === upper
    );
    return match?.ticker ?? null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const encoded = request.headers.get('x-t212-auth');
  if (!encoded) {
    return NextResponse.json({ ok: false, error: 'Missing x-t212-auth header.' }, { status: 400 });
  }

  // Optional separate live credentials for instrument resolution (demo orders)
  const liveEncoded = request.headers.get('x-t212-live-auth') ?? encoded;

  type Body = { ticker: string; quantity: number; env?: 'demo' | 'live' };
  const body = await request.json() as Body;
  const { ticker, quantity, env = 'live' } = body;

  if (!ticker || !quantity || quantity <= 0) {
    return NextResponse.json({ ok: false, error: 'ticker and positive quantity are required.' }, { status: 400 });
  }

  const base = env === 'demo'
    ? 'https://demo.trading212.com/api/v0'
    : 'https://live.trading212.com/api/v0';

  // ── Resolve T212 ticker ───────────────────────────────────────────────────
  let resolvedTicker = resolveTicker(ticker);

  // If not found in hardcoded map (still ends with _US_EQ as a guess),
  // try the live instruments endpoint to get the exact ticker
  const isGuessed = !T212_TICKERS[ticker.toUpperCase().replace(/\.L$/, '')] && !ticker.includes('_');
  if (isGuessed) {
    const fromLive = await resolveViaLiveInstruments(ticker, liveEncoded);
    if (fromLive) resolvedTicker = fromLive;
  }

  // ── Quantity precision ────────────────────────────────────────────────────
  // T212 accepts up to 2 decimal places; ensure minimum of 1 share
  const roundedQty = Math.max(1, Math.round(quantity * 100) / 100);

  // ── Place order ───────────────────────────────────────────────────────────
  try {
    const res = await fetch(`${base}/equity/orders/market`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + encoded,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ quantity: roundedQty, ticker: resolvedTicker }),
      signal: AbortSignal.timeout(10_000),
    });

    const text = await res.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* non-JSON body */ }

    if (res.ok) {
      return NextResponse.json({
        ok: true,
        orderId: data.id,
        fillPrice: data.fillPrice,
        ticker: resolvedTicker,
        quantity: roundedQty,
        env,
        data,
      });
    }

    // Extract the most useful error message from T212's response
    const t212Message =
      (data.message as string) ??
      (data.error as string) ??
      (data.errorCode as string) ??
      text ??
      `HTTP ${res.status}`;

    // If precision error, retry with integer quantity
    if (res.status === 400 && t212Message.toLowerCase().includes('precision')) {
      const intQty = Math.max(1, Math.floor(quantity));
      const retry = await fetch(`${base}/equity/orders/market`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + encoded, 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: intQty, ticker: resolvedTicker }),
        signal: AbortSignal.timeout(10_000),
      });
      const retryText = await retry.text();
      let retryData: Record<string, unknown> = {};
      try { retryData = JSON.parse(retryText); } catch { /* ok */ }

      if (retry.ok) {
        return NextResponse.json({
          ok: true,
          orderId: retryData.id,
          fillPrice: retryData.fillPrice,
          ticker: resolvedTicker,
          quantity: intQty,
          env,
          note: 'Quantity rounded to integer due to precision requirement',
          data: retryData,
        });
      }
    }

    return NextResponse.json({
      ok: false,
      error: t212Message,
      t212Status: res.status,
      t212Body: text,
      ticker: resolvedTicker,
      quantity: roundedQty,
      env,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
      ticker: resolvedTicker,
      env,
    }, { status: 500 });
  }
}

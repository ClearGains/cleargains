import { NextRequest, NextResponse } from 'next/server';
import { DB } from '@/lib/db';

/**
 * POST /api/db/migrate
 * Called once per device when localStorage data exists but hasn't been uploaded to Redis.
 * Body: { portfolios, activePortfolioId, portfolioData, watchlist, cgtHistory, fxPositions, fxTrades, manualStocks, pendingOrders }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      portfolios?: unknown[];
      activePortfolioId?: string | null;
      portfolioData?: Record<string, {
        positions?: unknown[];
        trades?: unknown[];
        budget?: number | null;
        settings?: unknown;
      }>;
      watchlist?: string[];
      cgtHistory?: unknown[];
      fxPositions?: unknown[];
      fxTrades?: unknown[];
      manualStocks?: unknown[];
      pendingOrders?: unknown[];
    };

    const ops: Promise<unknown>[] = [];

    if (body.portfolios?.length)      ops.push(DB.savePortfolios(body.portfolios));
    if (body.activePortfolioId)        ops.push(DB.setActivePortfolio(body.activePortfolioId));
    if (body.watchlist?.length)        ops.push(DB.saveWatchlist(body.watchlist));
    if (body.cgtHistory?.length)       ops.push(DB.saveCGTHistory(body.cgtHistory as never));
    if (body.fxPositions?.length)      ops.push(DB.saveFXPositions('global', body.fxPositions as never));
    if (body.fxTrades?.length)         ops.push(DB.saveFXTrades('global', body.fxTrades as never));
    if (body.manualStocks?.length)     ops.push(DB.saveManualStocks(body.manualStocks));
    if (body.pendingOrders?.length)    ops.push(DB.savePendingOrders(body.pendingOrders));

    // Per-portfolio data
    if (body.portfolioData) {
      for (const [id, data] of Object.entries(body.portfolioData)) {
        if (data.positions !== undefined) ops.push(DB.savePositions(id, data.positions as never));
        if (data.trades    !== undefined) ops.push(DB.saveTrades(id, data.trades as never));
        if (data.budget    != null)       ops.push(DB.saveBudget(id, data.budget));
        if (data.settings  !== undefined) ops.push(DB.saveStrategySettings(id, data.settings));
      }
    }

    await Promise.all(ops);
    await DB.setMigrationDone();

    return NextResponse.json({ ok: true, migrated: ops.length });
  } catch (err) {
    console.error('[db/migrate POST]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

/** GET /api/db/migrate — check if migration has already been done */
export async function GET() {
  try {
    const done = await DB.isMigrationDone();
    return NextResponse.json({ done });
  } catch (err) {
    return NextResponse.json({ done: false, error: String(err) });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { DB } from '@/lib/db';
import { decryptAllCredentials } from '@/lib/crypto';
import type { DemoPosition, DemoTrade } from '@/lib/types';

/**
 * Automated Strategy Cron — runs every 5 minutes via Vercel Cron.
 *
 * Per run:
 *  1. Load all active auto-trade portfolios from Redis.
 *  2. For each portfolio:
 *     a. Fetch current prices for open positions (Finnhub).
 *     b. Update PnL; close positions that hit stop-loss or take-profit.
 *     c. If the portfolio has a real T212 execution account and encrypted
 *        credentials exist in Redis, decrypt with SITE_PASSWORD and place
 *        the corresponding sell order on T212 automatically.
 *  3. Return a summary of actions taken.
 *
 * Security:
 *  - Verifies Authorization: Bearer {CRON_SECRET || SITE_PASSWORD} header.
 *  - Encrypted T212 key blobs are decrypted server-side ONLY during this
 *    automated execution — raw keys are never logged or persisted.
 */

// ── Auth ────────────────────────────────────────────────────────────────────────
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET ?? process.env.SITE_PASSWORD;
  if (!secret) return true; // dev mode: allow unauthenticated
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${secret}`;
}

// ── Price fetching ──────────────────────────────────────────────────────────────
async function fetchPrice(ticker: string): Promise<number | null> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return null;

  // UK stocks (ticker ends in .L) → Yahoo Finance
  if (ticker.endsWith('.L')) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClearGains/1.0)' },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const data = await res.json() as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } };
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (price && price > 0) return price;
      }
    } catch { /* fall through */ }
  }

  // US stocks → Finnhub
  try {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${apiKey}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const q = await res.json() as { c: number };
      if (q.c > 0) return q.c;
    }
  } catch { /* price unavailable */ }

  return null;
}

// ── T212 order placement (sell) ──────────────────────────────────────────────────
async function placeT212SellOrder(
  ticker: string, quantity: number,
  encoded: string, isDemo: boolean
): Promise<string | null> {
  const base = isDemo ? 'https://demo.trading212.com' : 'https://live.trading212.com';
  try {
    const res = await fetch(`${base}/api/v0/equity/orders/market`, {
      method: 'POST',
      headers: { Authorization: `Basic ${encoded}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, quantity, timeValidity: 'DAY' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json() as { id?: number };
      return data.id ? String(data.id) : 'ok';
    }
  } catch { /* order failed */ }
  return null;
}

// ── PortfolioMeta type (subset) ──────────────────────────────────────────────────
type PortfolioMeta = {
  id: string;
  name: string;
  autoTrade: boolean;
  status: string;
  executionAccount: string; // 'paper' | 'practice' | 'invest' | 'isa'
};

// ── Main handler ────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sitePassword = process.env.SITE_PASSWORD;
  const summary: Array<{
    portfolioId: string; name: string;
    checked: number; closed: number; errors: string[];
  }> = [];

  try {
    const portfolios = (await DB.getPortfolios()) as PortfolioMeta[];
    const encryptedKeys = await DB.getEncryptedKeys();

    for (const portfolio of portfolios) {
      if (!portfolio.autoTrade || portfolio.status !== 'active') continue;

      const entry = { portfolioId: portfolio.id, name: portfolio.name, checked: 0, closed: 0, errors: [] as string[] };
      summary.push(entry);

      try {
        const positions = await DB.getPositions(portfolio.id);
        if (positions.length === 0) continue;

        const updatedPositions: DemoPosition[] = [];
        const newTrades: DemoTrade[] = [];

        // Determine T212 encoded credentials for this execution account (if any)
        let t212Encoded: string | null = null;
        let isDemo = false;

        if (portfolio.executionAccount !== 'paper' && encryptedKeys && sitePassword) {
          try {
            const decrypted = await decryptAllCredentials(encryptedKeys, sitePassword);
            if (portfolio.executionAccount === 'practice' && decrypted.demo?.key && decrypted.demo?.secret) {
              t212Encoded = btoa(`${decrypted.demo.key}:${decrypted.demo.secret}`);
              isDemo = true;
            } else if (portfolio.executionAccount === 'isa' && decrypted.isa?.key && decrypted.isa?.secret) {
              t212Encoded = btoa(`${decrypted.isa.key}:${decrypted.isa.secret}`);
            } else if (portfolio.executionAccount === 'invest' && decrypted.live?.key && decrypted.live?.secret) {
              t212Encoded = btoa(`${decrypted.live.key}:${decrypted.live.secret}`);
            }
          } catch {
            entry.errors.push('Failed to decrypt T212 credentials');
          }
        }

        for (const pos of positions) {
          entry.checked++;

          const price = await fetchPrice(pos.ticker);
          if (!price) {
            updatedPositions.push(pos);
            continue;
          }

          const pnl    = (price - pos.entryPrice) * pos.quantity;
          const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
          const updated: DemoPosition = { ...pos, currentPrice: price, pnl, pnlPct };

          const hitSL = price <= pos.stopLoss;
          const hitTP = price >= pos.takeProfit;

          if (hitSL || hitTP) {
            // Close this position
            const closeReason: DemoTrade['closeReason'] = hitSL ? 'stop-loss' : 'take-profit';
            const trade: DemoTrade = {
              id:          `cron_${Date.now()}_${pos.id}`,
              ticker:      pos.ticker,
              t212Ticker:  pos.t212Ticker,
              companyName: pos.companyName,
              sector:      pos.sector,
              quantity:    pos.quantity,
              entryPrice:  pos.entryPrice,
              exitPrice:   price,
              pnl,
              pnlPct,
              openedAt:    pos.openedAt,
              closedAt:    new Date().toISOString(),
              closeReason,
              accountType: portfolio.executionAccount as DemoTrade['accountType'],
            };
            newTrades.push(trade);
            entry.closed++;

            // Place T212 sell order if we have credentials
            if (t212Encoded && pos.t212Ticker) {
              const orderId = await placeT212SellOrder(pos.t212Ticker, pos.quantity, t212Encoded, isDemo);
              if (!orderId) entry.errors.push(`T212 sell failed for ${pos.ticker}`);
            }
          } else {
            updatedPositions.push(updated);
          }
        }

        // Save updated state to Redis
        await DB.savePositions(portfolio.id, updatedPositions);
        if (newTrades.length > 0) {
          const existingTrades = await DB.getTrades(portfolio.id);
          await DB.saveTrades(portfolio.id, [...existingTrades, ...newTrades]);
        }
      } catch (err) {
        entry.errors.push(String(err));
      }
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    runAt: new Date().toISOString(),
    portfoliosProcessed: summary.length,
    summary,
  });
}

import { IG_STOCK_EPICS } from './ig-stock-epics';

// FX/indices/commodities/crypto don't follow a derivable ticker pattern the
// way shares do (see epicToYahooSymbol below), so they're listed explicitly
// here. Mirrors the equivalent map already used for the Daily Brief's own
// market universe (components/DailyBrief.tsx) and bot-server's yahooFetch.ts.
const NON_STOCK_EPIC_TO_YAHOO: Record<string, string> = {
  'IX.D.FTSE.DAILY.IP':    '^FTSE',
  'IX.D.SPTRD.DAILY.IP':   '^GSPC',
  'IX.D.NASDAQ.CASH.IP':   '^IXIC',
  'IX.D.DAX.DAILY.IP':     '^GDAXI',
  'IX.D.DOW.DAILY.IP':     '^DJI',
  'IX.D.NIKKEI.DAILY.IP':  '^N225',
  'IX.D.STXE.CASH.IP':     '^STOXX50E',
  'CS.D.GBPUSD.TODAY.IP':  'GBPUSD=X',
  'CS.D.EURUSD.TODAY.IP':  'EURUSD=X',
  'CS.D.USDJPY.TODAY.IP':  'JPY=X',
  'CS.D.EURGBP.TODAY.IP':  'EURGBP=X',
  'CS.D.AUDUSD.TODAY.IP':  'AUDUSD=X',
  'CS.D.USCGC.TODAY.IP':   'GC=F',    // Gold
  'CC.D.CL.USS.IP':        'CL=F',    // Oil (WTI)
  'CS.D.USCSI.TODAY.IP':   'SI=F',    // Silver
  'CC.D.LCO.USS.IP':       'BZ=F',    // Brent Crude
  'CC.D.NG.USS.IP':        'NG=F',    // Natural Gas
  'CS.D.BITCOIN.TODAY.IP': 'BTC-USD',
  'CS.D.BITCOIN.CFD.IP':   'BTC-USD',
};

// Reverse-lookup index built once from IG_STOCK_EPICS, keyed by the exact
// epic string — that map is already keyed by ticker (which IS the Yahoo
// symbol for every NASDAQ/NYSE entry), so building this avoids maintaining
// a second, parallel epic->ticker list that could drift out of sync.
const STOCK_EPIC_TO_YAHOO: Record<string, string> = {};
for (const [ticker, info] of Object.entries(IG_STOCK_EPICS)) {
  STOCK_EPIC_TO_YAHOO[info.epic] = info.exchange === 'LSE' ? `${ticker}.L` : ticker;
}

// Resolves an IG epic (spread-bet .DAILY.IP or CFD .CASH.IP form) to the
// Yahoo Finance symbol used to chart it. Returns null when the epic isn't
// in either the fixed non-stock map or the stock universe — callers should
// treat that as "no chart available" rather than guessing a symbol.
export function epicToYahooSymbol(epic: string): string | null {
  if (NON_STOCK_EPIC_TO_YAHOO[epic]) return NON_STOCK_EPIC_TO_YAHOO[epic];
  if (STOCK_EPIC_TO_YAHOO[epic]) return STOCK_EPIC_TO_YAHOO[epic];
  // CFD-account share positions use a distinct .CASH.IP epic for the same
  // underlying stock (see CFD_STOCK_EPIC_OVERRIDES in bot-server/igCfdBot.ts)
  // — IG_STOCK_EPICS only has the spread-bet .DAILY.IP form, so fall back to
  // that variant before giving up.
  if (epic.endsWith('.CASH.IP')) {
    const dailyVariant = epic.slice(0, -'.CASH.IP'.length) + '.DAILY.IP';
    if (STOCK_EPIC_TO_YAHOO[dailyVariant]) return STOCK_EPIC_TO_YAHOO[dailyVariant];
  }
  return null;
}

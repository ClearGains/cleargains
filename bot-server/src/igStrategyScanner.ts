import { fetchCandleHistory, type IGSession, type CandleBar } from './igApi';
import { calcRsi, calcEma, calcAtr, calcVwap, calcSma, calcMacdHist, calcEfficiencyRatio } from './alpacaStrategies';
import type { AlpacaBar } from './alpacaApi';
import type { IgStrategyName } from './igStrategyBot';
import { fetchBarsWithFallback, EPIC_TO_ALPACA } from './yahooFetch';
import { ruleBasedAnalysis } from './ruleBasedAnalysis';
import type { LWCandle } from './chartIndicators';

// ── Curated liquid IG epic universe ───────────────────────────────────────────
// Indices, major US/UK stocks, and FX majors. Stake sizing is risk-based
// (£risk ÷ stop-distance-in-points, computed off actual returned prices) —
// scale-agnostic, so it's correct for FX's ~1.3 price / 0.0001 point size
// alongside indices' ~10,000 price / 1.0 point size without special-casing.

export const IG_EPICS: { epic: string; name: string }[] = [
  // FX majors
  { epic: 'CS.D.GBPUSD.TODAY.IP', name: 'GBP/USD'      },
  { epic: 'CS.D.EURUSD.TODAY.IP', name: 'EUR/USD'      },
  { epic: 'CS.D.USDJPY.TODAY.IP', name: 'USD/JPY'      },
  { epic: 'CS.D.EURGBP.TODAY.IP', name: 'EUR/GBP'      },
  { epic: 'CS.D.AUDUSD.TODAY.IP', name: 'AUD/USD'      },
  // US indices
  { epic: 'IX.D.DOW.DAILY.IP',    name: 'Wall St'      },
  // Confirmed live: IX.D.NASDAQ.DAILY.IP / IX.D.SANDA.DAILY.IP / IX.D.EUROST.DAILY.IP
  // don't resolve via IG's own fetchMarketDetails at all (undefined, not just
  // missing a price) — stale/wrong epic codes, not a market-hours thing. The
  // NASDAQ fix was already applied elsewhere in the codebase (lib/igStrategyEngine.ts,
  // commit 331b1da) but never propagated to this file; SANDA/EUROST were never
  // fixed anywhere. Corrected against a live IG market search.
  { epic: 'IX.D.NASDAQ.CASH.IP',  name: 'US Tech 100'  },
  { epic: 'IX.D.SPTRD.DAILY.IP',  name: 'US 500'       },
  // UK / EU indices
  { epic: 'IX.D.FTSE.DAILY.IP',   name: 'UK 100'       },
  { epic: 'IX.D.STXE.CASH.IP',    name: 'EU Stocks 50' },
  { epic: 'IX.D.DAX.DAILY.IP',    name: 'Germany 40'   },
  // Asian index — confirmed live against IG's market search
  { epic: 'IX.D.NIKKEI.DAILY.IP', name: 'Japan 225'    },
  // Major US stocks (IG spreadbet format)
  { epic: 'UA.D.AAPL.CASH.IP',    name: 'Apple'        },
  { epic: 'UC.D.MSFT.DAILY.IP',   name: 'Microsoft'    },
  { epic: 'UC.D.NVDA.DAILY.IP',   name: 'NVIDIA'       },
  { epic: 'UA.D.AMZN.CASH.IP',    name: 'Amazon'       },
  { epic: 'UB.D.GOOGL.DAILY.IP',  name: 'Alphabet'     },
  { epic: 'UB.D.FB.DAILY.IP',     name: 'Meta'         },
  { epic: 'UD.D.TSLA.DAILY.IP',   name: 'Tesla'        },
  { epic: 'UC.D.NFLX.DAILY.IP',   name: 'Netflix'      },
  { epic: 'SD.D.JPM.DAILY.IP',    name: 'JPMorgan'     },
  { epic: 'SH.D.VUS.DAILY.IP',    name: 'Visa'         },
  { epic: 'SH.D.UNH.DAILY.IP',    name: 'UnitedHealth' },
  { epic: 'SH.D.XOM.DAILY.IP',    name: 'ExxonMobil'   },
  // Semiconductor / storage / legacy tech — added for the sector's characteristically
  // sharp trend moves (rally-then-reversal), which is exactly what the
  // trend-following strategies (Donchian/EMA/MACD) are built to catch.
  { epic: 'SA.D.AMD.DAILY.IP',    name: 'AMD'          },
  { epic: 'UA.D.AVGO.DAILY.IP',   name: 'Broadcom'     },
  { epic: 'UB.D.INTC.DAILY.IP',   name: 'Intel'        },
  { epic: 'UC.D.QCOM.DAILY.IP',   name: 'Qualcomm'     },
  { epic: 'UC.D.MU.DAILY.IP',     name: 'Micron'       },
  { epic: 'SG.D.TSM.DAILY.IP',    name: 'TSMC'         },
  { epic: 'UD.D.SNDKUS.DAILY.IP', name: 'SanDisk'      },
  { epic: 'UD.D.STX.DAILY.IP',    name: 'Seagate'      },
  { epic: 'UC.D.MRVL.DAILY.IP',   name: 'Marvell'      },
  { epic: 'UD.D.SKHYUS.DAILY.IP', name: 'SK Hynix'     },
  { epic: 'UD.D.WDC.DAILY.IP',    name: 'Western Digital' },
  { epic: 'SB.D.DELLUS.DAILY.IP', name: 'Dell'         },
  { epic: 'UC.D.RIMM.DAILY.IP',   name: 'BlackBerry'   },
  { epic: 'EC.D.NOKIAFP.DAILY.IP', name: 'Nokia'       },
  // Major UK stocks — confirmed live these were ALL wrong (UC.D.*.CASH.IP
  // doesn't exist as an epic at all, not just closed/no-quote — IG's own
  // market search shows the real prefix is KA.D.*.DAILY.IP). These have
  // likely never actually resolved, this session or before.
  { epic: 'KA.D.BARC.DAILY.IP',   name: 'Barclays'     },
  { epic: 'KA.D.BP.DAILY.IP',     name: 'BP'           },
  { epic: 'KA.D.HSBA.DAILY.IP',   name: 'HSBC'         },
  { epic: 'KA.D.SHELLN.DAILY.IP', name: 'Shell'        },
  { epic: 'KA.D.GSK.DAILY.IP',    name: 'GSK'          },
  { epic: 'KA.D.AZN.DAILY.IP',    name: 'AstraZeneca'  },
  { epic: 'KA.D.LLOY.DAILY.IP',   name: 'Lloyds'       },
  // Commodities/crypto/extra shares — added 2026-08-15 after backtesting
  // confirmed real edge on these specifically (scripts/backtestDailyBrief.ts
  // + backtest.ts's leaderboard engine), but they weren't in this universe
  // at all before. Epics verified live via IG's own market search first
  // (this codebase has repeatedly found guessed epics silently wrong) —
  // picked the plain DFB/"24 Hours" variant over month-dated futures
  // contracts or leveraged ETP variants, matching the convention every
  // other entry above already uses.
  { epic: 'CS.D.USCSI.TODAY.IP',  name: 'Silver'       },
  { epic: 'CC.D.LCO.USS.IP',      name: 'Brent Crude'  },
  { epic: 'CC.D.NG.USS.IP',       name: 'Natural Gas'  },
  { epic: 'CS.D.BITCOIN.TODAY.IP', name: 'Bitcoin'     },
  { epic: 'UC.D.RIVNUS.DAILY.IP', name: 'Rivian'       },
  { epic: 'SH.D.UBERUS.DAILY.IP', name: 'Uber'         },
  { epic: 'SC.D.F.DAILY.IP',      name: 'Ford'         },
  { epic: 'UA.D.COINUS.DAILY.IP', name: 'Coinbase'     },
  // Sector expansion 2026-08-19 — the universe above had no healthcare/
  // pharma beyond AZN/GSK/UNH, and no consumer/retail, industrials, or
  // media/communication at all, so a stock in any of those sectors having
  // a genuinely good day was structurally invisible to every strategy
  // regardless of how it performed. Every epic below individually verified
  // live against IG's own market search first (see igApi.ts's authenticate
  // + a throwaway /markets?searchTerm= script) — this codebase has
  // repeatedly found guessed epics silently wrong (see the UK-stocks
  // comment above). None of these are in RULE_BASED_ANALYSIS_CONFIRMED_EPICS
  // (no backtest data exists for them yet), so rule_based_analysis's own
  // scan won't pick them up on its own — they're reachable via
  // gemini_opinion (unrestricted) and epicStrategyOverrides, same as
  // AstraZeneca/Broadcom/Marvell/Meta.
  // Healthcare / pharma (beyond the existing AZN/GSK/UNH)
  { epic: 'SD.D.JNJ.DAILY.IP',    name: 'Johnson & Johnson' },
  { epic: 'SE.D.PFE.DAILY.IP',    name: 'Pfizer'       },
  { epic: 'SD.D.LLY.DAILY.IP',    name: 'Eli Lilly'    },
  // Moderna specifically — missed a real move entirely on 2026-08-19
  // because it wasn't in this universe at all (a manually-opened position
  // was the only reason the account even had exposure to it that day).
  { epic: 'UC.D.MRNAUS.DAILY.IP', name: 'Moderna'      },
  // Consumer / retail — entirely new sector for this universe
  { epic: 'SE.D.NKE.DAILY.IP',    name: 'Nike'         },
  { epic: 'SE.D.MCD.DAILY.IP',    name: 'McDonald\'s'  },
  { epic: 'SH.D.WMT.DAILY.IP',    name: 'Walmart'      },
  { epic: 'UA.D.COST.DAILY.IP',   name: 'Costco'       },
  // Industrials — entirely new sector for this universe
  { epic: 'SA.D.BA.DAILY.IP',     name: 'Boeing'       },
  { epic: 'SB.D.CAT.DAILY.IP',    name: 'Caterpillar'  },
  // Confirmed live via market search this is "Honeywell International Inc"
  // (SC.D.HON) — a decoy match, "Honeywell Aerospace Inc" (UB.D.HONAUS),
  // came back first in the same search and is a different, much thinner
  // instrument.
  { epic: 'SC.D.HON.DAILY.IP',    name: 'Honeywell'    },
  // Communication / media — entirely new sector for this universe
  { epic: 'SB.D.DIS.DAILY.IP',    name: 'Disney'       },
  { epic: 'SG.D.T.DAILY.IP',      name: 'AT&T'         },
  // Utilities — entirely new sector for this universe
  { epic: 'SC.D.FPL.DAILY.IP',    name: 'NextEra Energy' },
  // More AI/semiconductors — same sector as existing NVDA/AMD/AVGO etc.
  { epic: 'UA.D.ASML.DAILY.IP',   name: 'ASML'         },
  { epic: 'UC.D.ONNN.DAILY.IP',   name: 'ON Semiconductor' },
  // Already had Yahoo/Alpaca data mappings from an earlier sweep but were
  // never actually added to this tradeable universe — closing that gap
  // here rather than duplicating the mapping work.
  { epic: 'SE.D.PLTRUS.DAILY.IP', name: 'Palantir'     },
  { epic: 'SG.D.SHOPUS.DAILY.IP', name: 'Shopify'      },
  { epic: 'UC.D.PYPLVUS.DAILY.IP', name: 'PayPal'      },
];

// Rough sector grouping for the stock universe above — used to warn the
// gemini_opinion entry decision when OTHER names in the same sector have
// been losing recently, since a sector-wide theme (e.g. "memory sector
// cooling") tends to hit correlated names together, not just the one that
// already got cut. Deliberately coarse — this is advisory context for
// Gemini's own judgment, not a hard rule, so approximate groupings are fine.
export const SECTOR_MAP: Record<string, string> = {
  // Memory / storage
  'UC.D.MU.DAILY.IP':     'memory/storage',
  'UD.D.SNDKUS.DAILY.IP': 'memory/storage',
  'UD.D.STX.DAILY.IP':    'memory/storage',
  'UD.D.SKHYUS.DAILY.IP': 'memory/storage',
  'UD.D.WDC.DAILY.IP':    'memory/storage',
  'UC.D.MRVL.DAILY.IP':   'memory/storage',
  // AI / semiconductors
  'SA.D.AMD.DAILY.IP':    'AI/semiconductors',
  'UA.D.AVGO.DAILY.IP':   'AI/semiconductors',
  'UB.D.INTC.DAILY.IP':   'AI/semiconductors',
  'UC.D.QCOM.DAILY.IP':   'AI/semiconductors',
  'SG.D.TSM.DAILY.IP':    'AI/semiconductors',
  'UC.D.NVDA.DAILY.IP':   'AI/semiconductors',
  // Megacap tech
  'UA.D.AAPL.CASH.IP':    'megacap tech',
  'UC.D.MSFT.DAILY.IP':   'megacap tech',
  'UB.D.GOOGL.DAILY.IP':  'megacap tech',
  'UB.D.FB.DAILY.IP':     'megacap tech',
  'UA.D.AMZN.CASH.IP':    'megacap tech',
  'UC.D.NFLX.DAILY.IP':   'megacap tech',
  'UD.D.TSLA.DAILY.IP':   'megacap tech',
  // Enterprise / legacy tech
  'SB.D.DELLUS.DAILY.IP':  'enterprise/legacy tech',
  'UC.D.RIMM.DAILY.IP':    'enterprise/legacy tech',
  'EC.D.NOKIAFP.DAILY.IP': 'enterprise/legacy tech',
  // Financials
  'SD.D.JPM.DAILY.IP':   'financials',
  'SH.D.VUS.DAILY.IP':   'financials',
  'KA.D.BARC.DAILY.IP':  'financials',
  'KA.D.HSBA.DAILY.IP':  'financials',
  'KA.D.LLOY.DAILY.IP':  'financials',
  // Healthcare
  'SH.D.UNH.DAILY.IP':  'healthcare',
  'KA.D.GSK.DAILY.IP':  'healthcare',
  'KA.D.AZN.DAILY.IP':  'healthcare',
  // Energy
  'SH.D.XOM.DAILY.IP':    'energy',
  'KA.D.BP.DAILY.IP':     'energy',
  'KA.D.SHELLN.DAILY.IP': 'energy',
  // Healthcare / pharma
  'SD.D.JNJ.DAILY.IP':    'healthcare',
  'SE.D.PFE.DAILY.IP':    'healthcare',
  'SD.D.LLY.DAILY.IP':    'healthcare',
  'UC.D.MRNAUS.DAILY.IP': 'healthcare',
  // Consumer / retail
  'SE.D.NKE.DAILY.IP':    'consumer/retail',
  'SE.D.MCD.DAILY.IP':    'consumer/retail',
  'SH.D.WMT.DAILY.IP':    'consumer/retail',
  'UA.D.COST.DAILY.IP':   'consumer/retail',
  // Industrials
  'SA.D.BA.DAILY.IP':     'industrials',
  'SB.D.CAT.DAILY.IP':    'industrials',
  'SC.D.HON.DAILY.IP':    'industrials',
  // Communication / media
  'SB.D.DIS.DAILY.IP':    'communication/media',
  'SG.D.T.DAILY.IP':      'communication/media',
  // Utilities
  'SC.D.FPL.DAILY.IP':    'utilities',
  // AI / semiconductors (extends the existing group above)
  'UA.D.ASML.DAILY.IP':   'AI/semiconductors',
  'UC.D.ONNN.DAILY.IP':   'AI/semiconductors',
  // Growth / fintech
  'SE.D.PLTRUS.DAILY.IP':  'growth/fintech',
  'SG.D.SHOPUS.DAILY.IP':  'growth/fintech',
  'UC.D.PYPLVUS.DAILY.IP': 'growth/fintech',
};

// The 5 FX majors above, also owned exclusively by fxScalperBot.ts (a
// dedicated, Lightstreamer-driven FX scalper with its own risk/loss-lock
// checks) — exported so this scanner can exclude them from every stock-bot
// strategy's own candidate pool below. Without this, several strategies
// (ema_crossover, donchian, macd_crossover, weekly_momentum, gemini_opinion)
// could independently decide to trade the same pair fxScalperBot.ts is
// already watching, racing two uncoordinated bots against each other on one
// live account with no shared awareness of one another's positions.
//
// Explicit list, NOT derived by epic prefix — Bitcoin and Spot Silver's
// real IG epics also happen to start with "CS." (IG's generic "currencies"
// dealing category, not actually FX) despite not being FX pairs at all.
// A prefix-based `.filter(e => e.epic.startsWith('CS.'))` would have
// silently swept both into this set the moment they were added to
// IG_EPICS below, wrongly excluding them from every stock-bot strategy's
// scan pool as if fxScalperBot.ts owned them too.
export const FX_EPICS = new Set([
  'CS.D.GBPUSD.TODAY.IP', 'CS.D.EURUSD.TODAY.IP', 'CS.D.USDJPY.TODAY.IP',
  'CS.D.EURGBP.TODAY.IP', 'CS.D.AUDUSD.TODAY.IP',
]);

// Restricts rule_based_analysis to only the instruments genuinely confirmed
// profitable — SUPERSEDES an earlier version of this list (2026-08-15,
// scripts/backtestDailyBrief.ts) that turned out to be built on an
// unrealistically generous test: no slippage, no overnight financing cost,
// and only the Daily Brief's own 27-instrument universe. Re-tested properly
// through backtest.ts's real engine (same slippage/financing model, same
// 52-symbol BT_UNIVERSE, every other strategy in the leaderboard already
// uses) and the result was genuinely different — 8 of that original 12
// turned out to be real losers once costs were included: S&P 500 (-7.21%),
// NASDAQ 100 (-12.64%), Germany 40 (-5.03%), Wall St (-9.98%), Microsoft
// (-11.22%), Meta (-10.45%, profit factor 0.21 — one of the single worst
// performers in the entire 52-symbol set), EUR/USD (-4.02%), AUD/USD
// (-5.63%). This list is the corrected one — every entry re-verified
// profitable (return>0 AND profitFactor>1) under the proper engine.
// BP is a genuine surprise here: excluded as a loser (-0.24R) under the old
// test, confirmed profitable (+4.00%, PF 1.24) under the real one.
// Extended 2026-08-15 with commodities/crypto/extra shares that also
// backtested genuinely profitable but weren't in IG_EPICS at all until
// now (see that array's own comment) — epics verified live via IG's
// market search before adding, same discipline as everything else here.
export const RULE_BASED_ANALYSIS_CONFIRMED_EPICS = new Set([
  'IX.D.FTSE.DAILY.IP',   // FTSE 100     return=+2.66%  PF=1.38
  'IX.D.NIKKEI.DAILY.IP', // Japan 225    return=+10.76% PF=1.83
  'UA.D.AAPL.CASH.IP',    // Apple        return=+11.23% PF=2.33
  'KA.D.BARC.DAILY.IP',   // Barclays     return=+2.03%  PF=1.14
  'UB.D.GOOGL.DAILY.IP',  // Alphabet     return=+14.53% PF=4.21 (best performer in the IG universe)
  'KA.D.HSBA.DAILY.IP',   // HSBC         return=+10.98% PF=1.82
  'KA.D.BP.DAILY.IP',     // BP           return=+4.00%  PF=1.24
  'CS.D.USCSI.TODAY.IP',  // Silver       return=+26.17% PF=2.45 (best raw return of any symbol tested)
  'CC.D.LCO.USS.IP',      // Brent Crude  return=+22.98% PF=2.55
  'CC.D.NG.USS.IP',       // Natural Gas  return=+17.69% PF=2.32
  'CS.D.BITCOIN.TODAY.IP', // Bitcoin     return=+13.78% PF=2.13
  'UC.D.RIVNUS.DAILY.IP', // Rivian       return=+12.79% PF=1.51
  'SH.D.UBERUS.DAILY.IP', // Uber         return=+3.73%  PF=1.38
  'SC.D.F.DAILY.IP',      // Ford         return=+3.56%  PF=1.21
  'UA.D.COINUS.DAILY.IP', // Coinbase     return=+2.54%  PF=1.65
  // Added 2026-08-19 — was one of live's epicStrategyOverrides picks
  // (running under gemini_opinion since it wasn't in this list), checked
  // against the real engine on request and it backtests genuinely well,
  // beating several already-confirmed names above on both metrics.
  // AstraZeneca and Broadcom were checked in the same pass and did NOT
  // make the cut (AZN: -4.52% PF=0.79, a real loser; Broadcom: +0.67%
  // PF=1.06, too marginal to call confirmed) — both correctly stay on
  // Gemini via the override instead.
  'UC.D.MRVL.DAILY.IP',   // Marvell      return=+13.62% PF=1.41
  // Checked the full 19-name sector expansion (2026-08-19's IG_EPICS
  // addition) the same way, on request — 5 of 19 confirmed genuinely
  // profitable, 14 did not (several badly: Moderna -28.42% PF=0.50,
  // Costco -12.22% PF=0.26, PayPal -12.72% PF=0.20, Disney -11.18%
  // PF=0.31, Boeing -10.47% PF=0.49 — none of those 14 added here,
  // reachable only via gemini_opinion/epicStrategyOverrides instead,
  // same as every other unconfirmed name).
  'SD.D.JNJ.DAILY.IP',     // Johnson & Johnson return=+8.44% PF=1.77
  'SE.D.PLTRUS.DAILY.IP',  // Palantir          return=+8.03% PF=1.63
  'SC.D.HON.DAILY.IP',     // Honeywell         return=+7.73% PF=1.72
  'SB.D.CAT.DAILY.IP',     // Caterpillar       return=+6.23% PF=1.33
  'SE.D.MCD.DAILY.IP',     // McDonald's        return=+4.89% PF=1.89
  // Checked the remaining 29 original-universe names that had never
  // actually been tested under this specific engine (indices, megacap
  // tech, semis, UK names) — on request, so "cover all" instruments
  // could be evaluated instead of assumed either way. 9 of 29 confirmed,
  // 20 did not (several badly: Qualcomm -23.71% PF=0.29, BlackBerry
  // -22.58% PF=0.52, AMD -18.54% PF=0.58, Lloyds -15.94% PF=0.34,
  // Microsoft -13.50% PF=0.30, Amazon -13.01% PF=0.39 — none of those 20
  // added here, same as every other unconfirmed name). Deliberately did
  // NOT pin any of the 20 losers (or the 14 from the sector-expansion
  // pass above) to gemini_opinion en masse — 43 epics on a 15-min poll
  // would run ~1,200 Gemini calls/day from entries alone, blowing past
  // the 1000/day cap before Position Watch reviews are even counted.
  // They stay reachable via the Recommended panel (zero ongoing cost)
  // and the override picker for anyone the user wants to pin individually.
  'EC.D.NOKIAFP.DAILY.IP', // Nokia             return=+53.66% PF=4.93 (best in the whole universe)
  'UD.D.WDC.DAILY.IP',     // Western Digital   return=+36.66% PF=1.95
  'UD.D.SKHYUS.DAILY.IP',  // SK Hynix          return=+32.71% PF=2.58
  'UD.D.SNDKUS.DAILY.IP',  // SanDisk           return=+23.25% PF=2.46
  'SB.D.DELLUS.DAILY.IP',  // Dell              return=+3.42%  PF=1.14
  'SH.D.XOM.DAILY.IP',     // ExxonMobil        return=+3.06%  PF=1.24
  'UB.D.INTC.DAILY.IP',    // Intel             return=+2.99%  PF=1.14
  'UD.D.STX.DAILY.IP',     // Seagate           return=+2.25%  PF=1.11
  'UC.D.NVDA.DAILY.IP',    // NVIDIA            return=+0.63%  PF=1.06
]);

// Indices fxScalperBot.ts is also allowed to trade, alongside the 5 FX
// majors above — kept as a separate set (not merged into FX_EPICS) since
// FX_EPICS is also used elsewhere to exclude currency pairs from the
// stock/index bot's own scanning pool, and these indices should stay
// eligible there too. marketHours.ts already has real session hours
// defined for all 4 (was previously only used by the signal-only
// Lightstreamer displays, never wired into the actual trading bot).
export const SCALPER_INDEX_EPICS = new Set([
  'IX.D.FTSE.DAILY.IP',   // UK 100
  'IX.D.DAX.DAILY.IP',    // Germany 40
  'IX.D.DOW.DAILY.IP',    // Wall St
  'IX.D.NIKKEI.DAILY.IP', // Japan 225
]);

// Instruments worth surfacing as a manual heads-up but not worth the bot
// actually auto-trading — excluded from scanIgEpics's live-trading pool
// below, but NOT from refreshRecommendations' full-universe sweep (which
// reads IG_EPICS directly, unfiltered), so they still show up under
// "Recommended — Manual Only" for a human to act on if they agree.
// SK Hynix: no real Alpaca/US-listed ticker — its Korean primary listing is
// a proxy, "close enough" for a free directional read but not something to
// size or auto-enter real positions off. BlackBerry: user call, not a data
// quality issue — flagged as not worth the bot auto-trading either. Nokia:
// Helsinki listing, same non-Alpaca situation as SK Hynix — confirmed live,
// its entry-time bar fetch falls to IG's own allowance-limited REST candle
// API (no free Alpaca/Yahoo path for a non-US-listed name at evaluation
// time) and hit error.public-api.exceeded-account-historical-data-allowance.
// Every index epic in IG_EPICS above uses the IX.D. prefix — used to split
// stock vs index positions into separate max-positions pools instead of one
// shared count (they were previously grouped together, which let one
// category crowd out the other's allowance).
export function isIndexEpic(epic: string): boolean {
  return epic.startsWith('IX.D.');
}

export const MANUAL_ONLY_EPICS = new Set([
  'UD.D.SKHYUS.DAILY.IP',  // SK Hynix
  'UC.D.RIMM.DAILY.IP',    // BlackBerry
  'EC.D.NOKIAFP.DAILY.IP', // Nokia
]);

// UK stocks + indices — Yahoo-covered but not Alpaca-covered, so their
// entry-time bar fetch otherwise falls to IG's own allowance-limited REST
// candle API (same root cause as Nokia above). Two complementary fixes:
// evaluateEpic/refreshRecommendations use Yahoo (dynamically rescaled to
// IG's own live quote — confirmed live no fixed constant is safe, e.g.
// indices are ~1:1 with Yahoo but Nokia is ~69.74x) for the daily/weekly
// strategies, since IG's Lightstreamer CHART subscription has no DAY/WEEK
// resolution at all (confirmed live: HOUR works, DAY/WEEK don't exist).
// For donchian_hourly/gemini_opinion specifically — the only two strategies
// on an hourly timeframe — igStrategyBot.ts instead streams these live via
// Lightstreamer (HOUR resolution, confirmed live working), which needs no
// scale guessing at all since the data is already in IG's own native units.
export const LIGHTSTREAM_ELIGIBLE_EPICS = new Set([
  // Indices
  'IX.D.DOW.DAILY.IP', 'IX.D.NASDAQ.CASH.IP', 'IX.D.SPTRD.DAILY.IP',
  'IX.D.FTSE.DAILY.IP', 'IX.D.STXE.CASH.IP', 'IX.D.DAX.DAILY.IP',
  // UK stocks
  'KA.D.BARC.DAILY.IP', 'KA.D.BP.DAILY.IP', 'KA.D.HSBA.DAILY.IP',
  'KA.D.SHELLN.DAILY.IP', 'KA.D.GSK.DAILY.IP', 'KA.D.AZN.DAILY.IP', 'KA.D.LLOY.DAILY.IP',
]);

// ── IG resolution per strategy ────────────────────────────────────────────────

const SCAN_RESOLUTION: Record<IgStrategyName, { resolution: string; count: number }> = {
  rsi_mean_reversion: { resolution: 'MINUTE_5', count: 60 },
  ema_crossover:      { resolution: 'DAY',       count: 30 },
  orb:                { resolution: 'MINUTE_5',  count: 60 },
  vwap:               { resolution: 'MINUTE',    count: 60 },
  weekly_momentum:    { resolution: 'WEEK',       count: 20 },
  donchian_breakout:  { resolution: 'DAY',       count: 40 },
  donchian_hourly:    { resolution: 'HOUR',       count: 40 },
  macd_crossover:     { resolution: 'DAY',       count: 50 },
  pivot_points:       { resolution: 'DAY',       count: 30 },
  // Not actually used at runtime — gemini_opinion is in YAHOO_SCAN_STRATEGIES
  // below, so scanning always goes through SCAN_FREE_PARAMS instead. Kept
  // accurate anyway (30-min bars, matching igStrategyBot.ts's IG_RES) so
  // this doesn't read as stale/wrong if that ever changes.
  gemini_opinion:     { resolution: 'MINUTE_30',  count: 240 },
  // Also not used at runtime in practice — see YAHOO_SCAN_STRATEGIES below —
  // kept accurate to match igStrategyBot.ts's IG_RES (250 daily bars for
  // the SMA200 trend filter).
  rule_based_analysis: { resolution: 'DAY', count: 250 },
};

// ── Bar conversion ────────────────────────────────────────────────────────────

function igBarToAlpacaBar(b: CandleBar): AlpacaBar {
  return {
    t: b.snapshotTime,
    o: b.openPrice.mid  ?? b.openPrice.bid,
    h: b.highPrice.mid  ?? b.highPrice.bid,
    l: b.lowPrice.mid   ?? b.lowPrice.bid,
    c: b.closePrice.mid ?? b.closePrice.bid,
    v: 0,
  };
}

// ── Per-strategy scorers (mirrors alpacaScanner logic) ────────────────────────

type Scored = { epic: string; name: string; score: number };

function scoreRsi(bars: AlpacaBar[], epic: string, name: string): Scored {
  if (bars.length < 20) return { epic, name, score: -1 };
  const rsi = calcRsi(bars);
  if (rsi === null) return { epic, name, score: -1 };
  return { epic, name, score: Math.abs(rsi - 50) };
}

function scoreEma(bars: AlpacaBar[], epic: string, name: string): Scored {
  if (bars.length < 25) return { epic, name, score: -1 };
  const closes = bars.map(b => b.c);
  const ema9   = calcEma(closes, 9);
  const ema21  = calcEma(closes, 21);
  if (ema9.length < 2 || ema21.length < 2) return { epic, name, score: -1 };
  const last9  = ema9[ema9.length - 1];
  const last21 = ema21[ema21.length - 1];
  const prev9  = ema9[ema9.length - 2]  ?? last9;
  const prev21 = ema21[ema21.length - 2] ?? last21;
  const crossed = (last9 > last21 && prev9 <= prev21) || (last9 < last21 && prev9 >= prev21);
  const sep     = Math.abs(last9 - last21) / last21 * 100;
  return { epic, name, score: (crossed ? 40 : 0) + sep * 10 };
}

function scoreOrb(bars: AlpacaBar[], epic: string, name: string): Scored {
  if (bars.length < 10) return { epic, name, score: -1 };
  const recent    = bars.slice(-10);
  const avgVol    = bars.slice(0, -10).reduce((s, b) => s + b.v, 0) / Math.max(bars.length - 10, 1);
  const recentVol = recent.reduce((s, b) => s + b.v, 0) / recent.length;
  const relVol    = avgVol > 0 ? recentVol / avgVol : 1;
  const atr       = calcAtr(bars);
  const atrPct    = atr && bars[bars.length - 1].c > 0 ? (atr / bars[bars.length - 1].c) * 100 : 0;
  return { epic, name, score: relVol * 20 + atrPct * 5 };
}

// Own scoring function for gemini_opinion rather than reusing scoreOrb, so
// this can weight gaps/volume surges without changing the unrelated 'orb'
// strategy's own behavior. Same base "is there enough going on to be worth
// asking about" logic as scoreOrb, plus explicit bonuses for a genuine
// gap-at-open or a real volume surge (3x+, not just moderately elevated) —
// these are exactly the kind of "something happened here" signals worth
// prioritizing a candidate for, on top of plain volatility/relative volume.
function scoreGeminiOpinion(bars: AlpacaBar[], epic: string, name: string): Scored {
  if (bars.length < 20) return { epic, name, score: -1 };
  // Windows doubled (10->20, ATR/efficiency periods below) — bars are
  // 30-min now, not hourly, so this preserves the same wall-clock windows.
  const recent    = bars.slice(-20);
  const avgVol    = bars.slice(0, -20).reduce((s, b) => s + b.v, 0) / Math.max(bars.length - 20, 1);
  const recentVol = recent.reduce((s, b) => s + b.v, 0) / recent.length;
  const relVol    = avgVol > 0 ? recentVol / avgVol : 1;
  const atr       = calcAtr(bars, 28);
  const last      = bars[bars.length - 1];
  const atrPct    = atr && last.c > 0 ? (atr / last.c) * 100 : 0;

  const todayUtc    = new Date().toISOString().slice(0, 10);
  const todayIdx    = bars.findIndex(b => b.t.slice(0, 10) === todayUtc);
  const priorClose  = todayIdx > 0 ? bars[todayIdx - 1].c : undefined;
  const todayOpen   = todayIdx >= 0 ? bars[todayIdx].o : undefined;
  const gapPct      = priorClose && todayOpen ? Math.abs(todayOpen - priorClose) / priorClose * 100 : 0;

  const volumeSurgeBonus = relVol >= 3 ? 25 : 0;
  const gapBonus          = gapPct >= 3 ? 25 : 0;
  // Confirmed live this matters: relVol/atrPct alone reward pure noise just
  // as much as a real move — a stock chopping violently back and forth
  // scores the same as one quietly grinding in one clear direction. This
  // biases candidate selection toward names actually going somewhere,
  // without excluding choppy ones outright (that hard filter lives at
  // entry time, in evaluateEpic — this is just a ranking nudge).
  const efficiencyBonus = (calcEfficiencyRatio(bars, 40) ?? 0) * 30;

  return { epic, name, score: relVol * 20 + atrPct * 5 + volumeSurgeBonus + gapBonus + efficiencyBonus };
}

function scoreVwap(bars: AlpacaBar[], epic: string, name: string): Scored {
  if (bars.length < 20) return { epic, name, score: -1 };
  const vwap = calcVwap(bars);
  if (!vwap) return { epic, name, score: -1 };
  const price  = bars[bars.length - 1].c;
  const devPct = Math.abs(price - vwap) / vwap * 100;
  return { epic, name, score: devPct * 10 };
}

function scoreWeekly(bars: AlpacaBar[], epic: string, name: string): Scored {
  if (bars.length < 15) return { epic, name, score: -1 };
  const sma12 = calcSma(bars, 12);
  if (!sma12) return { epic, name, score: -1 };
  const price = bars[bars.length - 1].c;
  if (price < sma12) return { epic, name, score: 0 };
  const mom = (price - (bars[bars.length - 4]?.c ?? price)) / (bars[bars.length - 4]?.c ?? price) * 100;
  return { epic, name, score: (price / sma12 - 1) * 100 + Math.max(0, mom) };
}

function scoreDonchian(bars: AlpacaBar[], epic: string, name: string): Scored {
  if (bars.length < 21) return { epic, name, score: -1 };
  const n = bars.length;
  const window = bars.slice(n - 21, n - 1);
  const last = bars[n - 1].c;
  const high = Math.max(...window.map(b => b.h));
  const low  = Math.min(...window.map(b => b.l));
  // Positive = already broken out (favour these); negative = how close to breaking
  const proximity = Math.max((last - high) / high * 100, (low - last) / low * 100);
  return { epic, name, score: proximity > 0 ? 50 + proximity * 20 : 20 + proximity };
}

function scoreMacd(bars: AlpacaBar[], epic: string, name: string): Scored {
  const macd = calcMacdHist(bars);
  if (!macd) return { epic, name, score: -1 };
  const crossed = (macd.hist > 0 && macd.prevHist <= 0) || (macd.hist < 0 && macd.prevHist >= 0);
  const momentum = Math.abs(macd.hist - macd.prevHist);
  return { epic, name, score: (crossed ? 40 : 0) + momentum * 1000 };
}

// Needs ~200+ daily bars for its SMA200 trend filter (see
// ruleBasedAnalysisSignal in alpacaStrategies.ts) — a thin/short bar array
// just means the filter doesn't kick in yet, not a crash, but a real
// candidate here should have the full history the scan requested.
function scoreRuleBasedAnalysis(bars: AlpacaBar[], epic: string, name: string): Scored {
  if (bars.length < 60) return { epic, name, score: -1 };
  const candles: LWCandle[] = bars.map(b => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
  let analysis;
  try { analysis = ruleBasedAnalysis('', candles); } catch { return { epic, name, score: -1 }; }
  const swing = analysis.swing;
  if (swing.direction === 'FLAT') return { epic, name, score: 0 };
  return { epic, name, score: swing.confidence * 10 }; // confidence is 1-10 here — scale to be comparable with other strategies' score ranges
}

// Every strategy scores off free Alpaca/Yahoo bars instead of IG's allowance-
// limited candle API — a 44-epic scan was burning a meaningful chunk of IG's
// weekly historical-data allowance on every bot start or strategy switch, on
// top of the per-poll confirm calls, and a 30-call IG scan alone was enough
// to trip the account-wide non-trading allowance and lock the whole account
// out for several minutes (confirmed live) — not something worth risking
// even once per strategy. EPIC_TO_YAHOO covers the full IG_EPICS universe,
// so every strategy can scan for free; per-strategy timeframe/interval is
// looked up below instead of defaulting every strategy to daily bars.
const YAHOO_SCAN_STRATEGIES = new Set<IgStrategyName>([
  'donchian_breakout', 'donchian_hourly', 'ema_crossover', 'macd_crossover',
  'rsi_mean_reversion', 'orb', 'vwap', 'weekly_momentum', 'gemini_opinion',
  'rule_based_analysis',
]);

// orb/rsi_mean_reversion are timeframe 'intraday' — igStrategyBot.ts's poll()
// still gates the *entire* cycle on isNYSEOpen() for these, not per-epic. A
// non-Alpaca epic (different exchange, different real trading hours) gets
// zero benefit from a watchlist slot: it's blocked by the NYSE-hours gate
// exactly the same as everything else, but without free data or Gemini
// confirmation on top. Restricting these two to Alpaca-covered epics only
// means every watched slot is actually usable during the one window the bot
// ever polls them in.
//
// vwap stays Alpaca-only for an unrelated reason: it needs real volume, and
// Yahoo's FX bars report zero volume (OTC market, no central tape) — VWAP is
// mathematically undefined there regardless of this filter (calcVwap returns
// null on zero cumulative volume).
//
// gemini_opinion is deliberately NOT in this set (unlike when it first shipped)
// — it was originally NYSE-hours-gated like ORB/RSI Mean Reversion, which is
// why it started Alpaca-only too, but it was later extended to trade 24h (see
// is24hStrategy in igStrategyBot.ts) same as vwap. Unlike vwap it needs no
// volume data (its score comes from scoreOrb's relative-volume/ATR% read,
// which degrates gracefully to ATR% alone when volume is zero) and its entry
// path already handles a missing Alpaca ticker fine (EPIC_TO_ALPACA[epic]
// undefined just means no company headlines, not a broken evaluation) — so
// nothing actually requires excluding FX here anymore, and doing so was
// silently keeping every FX pair out of its watchlist for good.
const ALPACA_ONLY_STRATEGIES = new Set<IgStrategyName>(['vwap', 'orb', 'rsi_mean_reversion']);

// Mirrors igStrategyBot.ts's FREE_DATA_PARAMS — duplicated rather than
// imported to avoid a circular import (igStrategyBot.ts already imports
// scanIgEpics from this file).
const SCAN_FREE_PARAMS: Partial<Record<IgStrategyName, { range: string; alpacaTimeframe: '1Min' | '5Min' | '30Min' | '1Hour' | '1Day' | '1Week'; yahooInterval: '1m' | '5m' | '30m' | '1h' | '1d' | '1wk' }>> = {
  rsi_mean_reversion: { range: '1mo', alpacaTimeframe: '5Min', yahooInterval: '5m' },
  orb:                { range: '5d',  alpacaTimeframe: '1Min', yahooInterval: '1m' },
  vwap:               { range: '5d',  alpacaTimeframe: '1Min', yahooInterval: '1m' },
  weekly_momentum:    { range: '5y',  alpacaTimeframe: '1Week', yahooInterval: '1wk' },
  donchian_hourly:    { range: '1mo', alpacaTimeframe: '1Hour', yahooInterval: '1h' },
  // 30-min bars, not hourly — see STRATEGY_META.gemini_opinion in
  // alpacaStrategies.ts for why.
  gemini_opinion:     { range: '1mo', alpacaTimeframe: '30Min', yahooInterval: '30m' },
  rule_based_analysis: { range: '2y', alpacaTimeframe: '1Day', yahooInterval: '1d' },
};

// Volatility-matched routing — a fast (hourly) strategy wants instruments
// that actually move enough intraday to matter; a slow (daily) strategy
// wants calmer ones, since extreme volatility on a multi-day hold is what
// blew stop-sizing past the loss ceiling repeatedly on semiconductors
// today (SanDisk/Micron/AMD etc — confirmed live, ATR-implied stops came
// out 5-9x the instrument's own price). Rather than a hard filter, this
// scales the score so the "right" timeframe for an instrument's own
// volatility naturally outranks the "wrong" one instead of excluding
// anything outright — a calm stock can still win a slot on the daily
// strategy if nothing more volatile is currently breaking out.
function volatilityMultiplier(strategy: IgStrategyName, bars: AlpacaBar[]): number {
  if (strategy !== 'donchian_breakout' && strategy !== 'donchian_hourly') return 1;
  if (!bars.length) return 1;
  const atr      = calcAtr(bars);
  const price    = bars[bars.length - 1].c;
  if (!atr || price <= 0) return 1;
  const atrPct = (atr / price) * 100;

  if (strategy === 'donchian_hourly') {
    // Hourly wants movement — a name barely moving intraday just gets
    // chopped by noise. Penalize (not exclude) anything too calm.
    return atrPct < 1.5 ? 0.4 : 1;
  }
  // donchian_breakout (daily) wants steadier multi-day trends — extreme
  // volatility is exactly what's been forcing the loss-ceiling to skip
  // entries all day. Penalize (not exclude) anything this hot.
  return atrPct > 4 ? 0.4 : 1;
}

// Shared with the recommendations feature in igStrategyBot.ts, which needs
// the same conviction score to rank "best pick of the day" — not just a
// bare BUY/SELL, since more than one instrument can have a live signal at
// once and only the strongest is worth a single daily highlight.
export function scoreForStrategy(strategy: IgStrategyName, bars: AlpacaBar[], epic: string, name: string): number {
  const base = (() => {
    switch (strategy) {
      case 'rsi_mean_reversion': return scoreRsi(bars, epic, name).score;
      case 'ema_crossover':      return scoreEma(bars, epic, name).score;
      case 'orb':                return scoreOrb(bars, epic, name).score;
      case 'vwap':               return scoreVwap(bars, epic, name).score;
      case 'weekly_momentum':    return scoreWeekly(bars, epic, name).score;
      case 'donchian_breakout':  return scoreDonchian(bars, epic, name).score;
      case 'donchian_hourly':    return scoreDonchian(bars, epic, name).score;
      case 'macd_crossover':     return scoreMacd(bars, epic, name).score;
      // No directional thesis of its own to score by design — Gemini
      // decides direction from scratch. scoreGeminiOpinion is a neutral
      // "is there enough going on here to be worth asking about" proxy
      // (volatility/relative-volume, plus explicit gap and volume-surge
      // bonuses), not biased toward a specific technical thesis before
      // Gemini ever looks at it.
      case 'gemini_opinion':     return scoreGeminiOpinion(bars, epic, name).score;
      case 'rule_based_analysis': return scoreRuleBasedAnalysis(bars, epic, name).score;
      default:                   return -1;
    }
  })();
  return base <= 0 ? base : base * volatilityMultiplier(strategy, bars);
}

// ── Public API ────────────────────────────────────────────────────────────────

// User asked for standing extra focus on Japan 225 specifically (2026-08-14)
// — sees real opportunity there and wants it watched every cycle regardless
// of how it happens to score, on top of gemini_opinion's usual stock-only
// exclusion above (that exclusion was about avoiding repetitive index churn
// in general, not a verdict on this specific instrument).
const PRIORITY_EPIC = 'IX.D.NIKKEI.DAILY.IP';

export async function scanIgEpics(
  strategy: IgStrategyName,
  session:  IGSession,
  exclude:  string[],
  count:    number,
  log:      (msg: string) => void = console.log,
  minIndexCount: number = 0,
): Promise<string[]> {
  const alpacaOnly = ALPACA_ONLY_STRATEGIES.has(strategy);
  // FX excluded unconditionally — fxScalperBot.ts owns FX trading exclusively
  // (dedicated Lightstreamer feed + its own risk checks), see FX_EPICS above.
  // Indices excluded for gemini_opinion specifically, same reasoning: the FX
  // swing bot already trades a dedicated index set (SCALPER_INDEX_EPICS) as
  // part of its own strategy — confirmed live gemini_opinion kept
  // re-triggering near-identical "extreme overbought RSI" SELL theses on
  // Wall St repeatedly (9 entries in one morning), each a real Gemini call,
  // for gains judged not worth that usage. User call to keep gemini_opinion
  // stock-only; other strategies (e.g. donchian_hourly) still trade indices.
  const excludeIndices = strategy === 'gemini_opinion';
  // rule_based_analysis is restricted to only the instruments its own
  // backtest actually confirmed profitable — see
  // RULE_BASED_ANALYSIS_CONFIRMED_EPICS's own comment. Applied on top of
  // (not instead of) the FX-exclusivity filter below, so EUR/USD/AUD/USD
  // still correctly stay off-limits (fxScalperBot.ts owns FX trading
  // exclusively) even though they backtested profitably too.
  const restrictToConfirmed = strategy === 'rule_based_analysis';
  const pool = IG_EPICS.filter(e =>
    !exclude.includes(e.epic) && !FX_EPICS.has(e.epic) && !MANUAL_ONLY_EPICS.has(e.epic)
    && (!excludeIndices || !isIndexEpic(e.epic) || e.epic === PRIORITY_EPIC)
    && (!restrictToConfirmed || RULE_BASED_ANALYSIS_CONFIRMED_EPICS.has(e.epic))
    && (!alpacaOnly || e.epic in EPIC_TO_ALPACA));
  const useYahoo = YAHOO_SCAN_STRATEGIES.has(strategy);
  log(`[ig-scanner] Fetching bars for ${pool.length} epics (strategy: ${strategy}, source: ${useYahoo ? 'yahoo (free)' : 'ig'})…`);

  const { resolution, count: barCount } = SCAN_RESOLUTION[strategy];
  const scored: Scored[] = [];

  const freeParams = SCAN_FREE_PARAMS[strategy];
  for (const { epic, name } of pool) {
    try {
      const bars = useYahoo
        ? freeParams
          ? await fetchBarsWithFallback(epic, freeParams.range, freeParams) ?? []
          : await fetchBarsWithFallback(epic, '6mo') ?? []
        : (await fetchCandleHistory(session, epic, resolution, barCount)).map(igBarToAlpacaBar);
      scored.push({ epic, name, score: scoreForStrategy(strategy, bars, epic, name) });
    } catch {
      // Epic unavailable or market closed — skip silently
    }
    // IG's non-trading allowance is exceeded (403 error.public-api.exceeded-*-allowance)
    // by a 30-call scan at 150ms spacing — confirmed empirically, and once tripped it
    // doesn't clear for a while, taking the whole account (not just the scan) down with
    // it for the next several minutes. Yahoo has no such allowance, so only throttle
    // when actually calling IG.
    await new Promise(r => setTimeout(r, useYahoo ? 250 : 1200));
  }

  let top = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, count);

  // When IG's own historical-data allowance is exhausted, only Alpaca-covered
  // epics can actually get their entry signal confirmed and sized (see
  // evaluateEpic in igStrategyBot.ts) — everything else just sits unconfirmed.
  // A pure top-score list can end up with zero Alpaca-covered picks purely by
  // chance (exactly what happened live: SK Hynix/FX/indices outscored every
  // share this cycle), leaving the bot watching instruments it can't actually
  // act on. Guarantee at least half the slots are Alpaca-covered when enough
  // scored candidates exist, swapping in the best-scoring ones that didn't
  // make the raw cut rather than leaving the list to chance.
  const minAlpaca = Math.ceil(count / 2);
  const alpacaInTop = top.filter(s => s.epic in EPIC_TO_ALPACA).length;
  if (alpacaInTop < minAlpaca) {
    // No score>0 floor here deliberately — an Alpaca-covered epic sitting at
    // a middling/negative score is still confirmable right now, which beats
    // an IG-only epic that can't be confirmed at all while the allowance is
    // exhausted, regardless of how good that epic's raw score looks.
    const alpacaCandidates = scored
      .filter(s => s.epic in EPIC_TO_ALPACA && s.score !== -1 && !top.some(t => t.epic === s.epic))
      .sort((a, b) => b.score - a.score);
    const need = minAlpaca - alpacaInTop;
    const nonAlpaca = top.filter(s => !(s.epic in EPIC_TO_ALPACA));
    const alreadyAlpaca = top.filter(s => s.epic in EPIC_TO_ALPACA);
    const backfilled = alpacaCandidates.slice(0, need);
    // Drop the lowest-scoring non-Alpaca picks to make room, keeping the list length stable.
    const trimmedNonAlpaca = nonAlpaca.sort((a, b) => b.score - a.score).slice(0, Math.max(0, count - alreadyAlpaca.length - backfilled.length));
    top = [...alreadyAlpaca, ...backfilled, ...trimmedNonAlpaca].sort((a, b) => b.score - a.score);
  }

  // Guarantee at least minIndexCount index picks make the final list — a
  // pure top-score list (or the Alpaca-guarantee backfill just above, which
  // discards "non-Alpaca" picks to add more Alpaca-covered stocks, and every
  // index epic is non-Alpaca) can otherwise squeeze indices out entirely,
  // leaving a separate index position cap with nothing to actually watch.
  if (minIndexCount > 0) {
    const indexInTop = top.filter(s => isIndexEpic(s.epic)).length;
    if (indexInTop < minIndexCount) {
      const indexCandidates = scored
        .filter(s => isIndexEpic(s.epic) && s.score !== -1 && !top.some(t => t.epic === s.epic))
        .sort((a, b) => b.score - a.score);
      const need         = minIndexCount - indexInTop;
      const backfilled    = indexCandidates.slice(0, need);
      const alreadyIndex  = top.filter(s => isIndexEpic(s.epic));
      const nonIndex      = top.filter(s => !isIndexEpic(s.epic)).sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, count - alreadyIndex.length - backfilled.length));
      top = [...alreadyIndex, ...backfilled, ...nonIndex].sort((a, b) => b.score - a.score);
    }
  }

  // Pinned by explicit user request — always keep Japan 225 on the watch
  // list regardless of how it happens to score this cycle, so Gemini's own
  // per-poll opinion always gets a real look at it (same "never drop it"
  // treatment an open position already gets above). Added on top of, not
  // instead of, the normal top-N picks.
  if (!top.some(s => s.epic === PRIORITY_EPIC)) {
    const nikkei = scored.find(s => s.epic === PRIORITY_EPIC);
    if (nikkei) top = [...top, nikkei];
  }

  log(`[ig-scanner] Best picks: ${top.map(s => `${s.name}(${s.score.toFixed(1)}${s.epic in EPIC_TO_ALPACA ? ', alpaca' : ''})`).join(', ') || 'none'}`);
  return top.length >= count
    ? top.map(s => s.epic)
    : [...top.map(s => s.epic), ...pool.map(e => e.epic).filter(e => !top.some(t => t.epic === e)).slice(0, count - top.length)];
}

export function epicName(epic: string): string {
  return IG_EPICS.find(e => e.epic === epic)?.name ?? epic.split('.').slice(0, 3).join('.');
}

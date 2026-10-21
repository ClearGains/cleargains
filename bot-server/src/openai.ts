// ── AI routing for the IG / FX / mean-reversion / options bots ─────────────
// History: OpenAI (gpt-5.6-sol) was the acting engine here from 2026-08-25,
// with Gemini as fallback. The OpenAI account ran out of credit in October
// 2026, so every call was already failing over to Gemini. On 2026-10-21 the
// owner asked for OpenAI to be removed entirely, so these wrappers now call
// Gemini directly. The names stay the same so the bots needn't change. The
// prompts are still the shared builders in gemini.ts.
import {
  type DailyVerdictRequest, type DailyVerdict,
  type PositionReviewRequest, type PositionVerdict,
  type TradeIdeaRequest, type TradeIdeaVerdict,
  type StockConfirmSignal, type StockConfirmVerdict,
  type FxSwingEntrySignal, type FxSwingVerdict,
  type MrSafetyRequest, type MrSafetyVerdict,
  type OptionsExitRequest, type OptionsExitVerdict,
  askGeminiDailyVerdict, askGeminiPositionVerdict, askGeminiTradeIdea, askGeminiConfirmStockTrade, askGeminiFxSwing,
  askGeminiMrSafety, askGeminiOptionsExit,
} from './gemini';

export const askIgDailyVerdict      = (req: DailyVerdictRequest):    Promise<DailyVerdict>       => askGeminiDailyVerdict(req);
export const askIgPositionVerdict   = (req: PositionReviewRequest):  Promise<PositionVerdict>    => askGeminiPositionVerdict(req);
export const askIgTradeIdea         = (req: TradeIdeaRequest):       Promise<TradeIdeaVerdict>   => askGeminiTradeIdea(req);
export const askIgConfirmStockTrade = (req: StockConfirmSignal):     Promise<StockConfirmVerdict> => askGeminiConfirmStockTrade(req);
export const askFxSwing             = (signal: FxSwingEntrySignal):  Promise<FxSwingVerdict>     => askGeminiFxSwing(signal);
// The mean-reversion safety net and the options exit check keep their
// fail-closed behaviour. That lives in the Gemini functions themselves: if
// the AI is unreachable, the position is never force-closed.
export const askMrSafety            = (req: MrSafetyRequest):        Promise<MrSafetyVerdict>    => askGeminiMrSafety(req);
export const askOptionsExit         = (req: OptionsExitRequest):     Promise<OptionsExitVerdict> => askGeminiOptionsExit(req);

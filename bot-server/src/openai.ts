// ── OpenAI — judgment layer, dual role ──────────────────────────────────────
// Two distinct uses in this file:
//  1. T212 ISA thesis (askOpenAiIsaThesis) — comparison-only, logged
//     alongside Gemini/xAI, never places or blocks a real order there. Built
//     2026-08-25 to test whether another provider calls it better than
//     Gemini after Gemini showed real production failures (~9% of calls over
//     a 5-day sample).
//  2. IG spread-bet bot + FX scalper bot (askIg*/askFxSwing, 2026-08-25) —
//     OpenAI is the ACTING decision-maker here, with Gemini called only if
//     OpenAI's own attempt genuinely fails. Real trades depend on this path.
// Every prompt is shared with Gemini/xAI's identical builders in gemini.ts
// (buildIsaThesisPrompt, buildDailyVerdictPrompt, etc.) so whichever role a
// given call plays, every provider is always being asked the exact same
// question.
//
// Model choice: started on gpt-5-nano, swapped to gpt-5.6-sol same day after
// checking — nano is from an already-superseded generation (not even on
// current benchmarks any more, same "chasing an outdated pin" problem this
// file exists to sidestep for Gemini) and structurally cannot turn its
// reasoning overhead down (confirmed live: 192 of 206 output tokens were
// invisible reasoning tokens for a trivial 3-character JSON answer). Sol
// scores competitively with Gemini 3.7 Flash and Grok 4.6 on the Artificial
// Analysis Intelligence Index and its reasoning effort IS controllable via
// `reasoning_effort`, unlike nano/mini.
import {
  buildIsaThesisPrompt, parseIsaThesisResponse, type IsaThesisRequest, type IsaThesisVerdict,
  buildDailyVerdictPrompt, parseDailyVerdictResponse, type DailyVerdictRequest, type DailyVerdict,
  buildPositionVerdictPrompt, parsePositionVerdictResponse, type PositionReviewRequest, type PositionVerdict,
  buildTradeIdeaPrompt, parseTradeIdeaResponse, type TradeIdeaRequest, type TradeIdeaVerdict,
  buildConfirmStockTradePrompt, parseConfirmStockTradeResponse, type StockConfirmSignal, type StockConfirmVerdict,
  buildFxSwingPrompt, parseFxSwingResponse, type FxSwingEntrySignal, type FxSwingVerdict,
  buildMrSafetyPrompt, parseMrSafetyResponse, type MrSafetyRequest, type MrSafetyVerdict,
  buildOptionsExitPrompt, parseOptionsExitResponse, type OptionsExitRequest, type OptionsExitVerdict,
  askGeminiDailyVerdict, askGeminiPositionVerdict, askGeminiTradeIdea, askGeminiConfirmStockTrade, askGeminiFxSwing,
  askGeminiMrSafety, askGeminiOptionsExit,
} from './gemini';

const OPENAI_MODEL = 'gpt-5.6-sol';

export async function askOpenAiIsaThesis(req: IsaThesisRequest): Promise<IsaThesisVerdict> {
  const apiKey = process.env.OPENAI_API_KEY;
  const { prompt, fallbackAction } = buildIsaThesisPrompt(req);
  if (!apiKey) return { action: fallbackAction, confidence: 0, reason: 'No OpenAI key configured', engine: 'passthrough' };

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model:            OPENAI_MODEL,
        messages:         [{ role: 'user', content: prompt }],
        // 'high' balances quality against the max-effort price premium —
        // ties Gemini 3.7 Flash's score on the Intelligence Index at a
        // fraction of max effort's cost. Confirmed accepted live (unlike
        // nano/mini, which reject this parameter outright).
        reasoning_effort: 'high',
        response_format:  { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { action: fallbackAction, confidence: 0, reason: `OpenAI ${res.status}`, engine: 'passthrough' };

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? '';
    return parseIsaThesisResponse(text, req.action, fallbackAction, 'openai');
  } catch (e) {
    return { action: fallbackAction, confidence: 0, reason: `OpenAI failed (${e instanceof Error ? e.message : String(e)})`, engine: 'passthrough' };
  }
}

// ── IG spread-bet bot + FX scalper bot — OpenAI acting, Gemini as fallback ──
// 20s timeout, matching Gemini's own SLA — these calls sit on the real
// decision path across many epics per scan (IG alone evaluates up to ~64 a
// cycle), so a slow provider here directly slows the bot, unlike T212's
// comparison-only calls which can afford to wait longer.
async function openaiChat(prompt: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model:            OPENAI_MODEL,
      messages:         [{ role: 'user', content: prompt }],
      reasoning_effort: 'high',
      response_format:  { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? null;
}

export async function askOpenAiDailyVerdict(req: DailyVerdictRequest): Promise<DailyVerdict> {
  try {
    const text = await openaiChat(buildDailyVerdictPrompt(req));
    if (text === null) return { direction: req.direction, confidence: req.strength, reason: 'No OpenAI response', engine: 'passthrough' };
    return parseDailyVerdictResponse(text, req, 'openai');
  } catch (e) {
    return { direction: req.direction, confidence: req.strength, reason: `OpenAI failed (${e instanceof Error ? e.message : String(e)})`, engine: 'passthrough' };
  }
}

export async function askOpenAiPositionVerdict(req: PositionReviewRequest): Promise<PositionVerdict> {
  try {
    const text = await openaiChat(buildPositionVerdictPrompt(req));
    if (text === null) return { action: 'HOLD', confidence: 0, reason: 'No OpenAI response — holding, stop still protects the position', engine: 'passthrough' };
    return parsePositionVerdictResponse(text, 'openai');
  } catch (e) {
    return { action: 'HOLD', confidence: 0, reason: `OpenAI failed — holding, stop still protects the position (${e instanceof Error ? e.message : String(e)})`, engine: 'passthrough' };
  }
}

export async function askOpenAiTradeIdea(req: TradeIdeaRequest): Promise<TradeIdeaVerdict> {
  try {
    const text = await openaiChat(buildTradeIdeaPrompt(req));
    if (text === null) return { action: 'HOLD', confidence: 0, reason: 'No OpenAI response', stopPoints: 0, takeProfitPoints: 0, engine: 'passthrough' };
    return parseTradeIdeaResponse(text, 'openai');
  } catch (e) {
    return { action: 'HOLD', confidence: 0, reason: `OpenAI failed (${e instanceof Error ? e.message : String(e)})`, stopPoints: 0, takeProfitPoints: 0, engine: 'passthrough' };
  }
}

export async function askOpenAiConfirmStockTrade(req: StockConfirmSignal): Promise<StockConfirmVerdict> {
  try {
    const text = await openaiChat(buildConfirmStockTradePrompt(req));
    if (text === null) return { direction: 'SKIP', confidence: 0, reason: 'No OpenAI response', engine: 'passthrough' };
    return parseConfirmStockTradeResponse(text, req, 'openai');
  } catch (e) {
    return { direction: 'SKIP', confidence: 0, reason: `OpenAI failed (${e instanceof Error ? e.message : String(e)})`, engine: 'passthrough' };
  }
}

export async function askOpenAiFxSwing(signal: FxSwingEntrySignal): Promise<FxSwingVerdict> {
  try {
    const text = await openaiChat(buildFxSwingPrompt(signal));
    if (text === null) return { direction: signal.suggestedDir, confidence: 65, reason: 'No OpenAI response — trading on the technical signal alone', engine: 'passthrough' };
    return parseFxSwingResponse(text, 'openai');
  } catch (e) {
    return { direction: signal.suggestedDir, confidence: 65, reason: `OpenAI failed — trading on the technical signal alone (${e instanceof Error ? e.message : String(e)})`, engine: 'passthrough' };
  }
}

// Tries OpenAI; only calls Gemini if OpenAI's own attempt genuinely failed
// (engine === 'passthrough' — no key, network error, bad response, parse
// failure). A working OpenAI verdict is never overridden or double-checked —
// this is a failover chain, not a vote. Used by both the IG spread-bet bot
// (igStrategyBot.ts, geminiWatch.ts) and the FX scalper bot (fxScalperBot.ts
// for position review) — the same review question either way.
export async function askIgDailyVerdict(req: DailyVerdictRequest): Promise<DailyVerdict> {
  const openai = await askOpenAiDailyVerdict(req);
  return openai.engine === 'passthrough' ? askGeminiDailyVerdict(req) : openai;
}
export async function askIgPositionVerdict(req: PositionReviewRequest): Promise<PositionVerdict> {
  const openai = await askOpenAiPositionVerdict(req);
  return openai.engine === 'passthrough' ? askGeminiPositionVerdict(req) : openai;
}
export async function askIgTradeIdea(req: TradeIdeaRequest): Promise<TradeIdeaVerdict> {
  const openai = await askOpenAiTradeIdea(req);
  return openai.engine === 'passthrough' ? askGeminiTradeIdea(req) : openai;
}
export async function askIgConfirmStockTrade(req: StockConfirmSignal): Promise<StockConfirmVerdict> {
  const openai = await askOpenAiConfirmStockTrade(req);
  return openai.engine === 'passthrough' ? askGeminiConfirmStockTrade(req) : openai;
}
// FX scalper bot's own entry signal — same failover pattern.
export async function askFxSwing(signal: FxSwingEntrySignal): Promise<FxSwingVerdict> {
  const openai = await askOpenAiFxSwing(signal);
  return openai.engine === 'passthrough' ? askGeminiFxSwing(signal) : openai;
}

// Mean-reversion "stocks" instance's light-touch safety net — see
// buildMrSafetyPrompt's own comment for why this is a deliberately separate,
// much narrower question than askIgPositionVerdict. Same failover shape as
// everything else in this file; a genuine outage on both providers still
// fails closed (severe: false — never force-closes a position just because
// the AI was unreachable, same "absence of a working call means don't act"
// discipline as the rest of this account).
export async function askOpenAiMrSafety(req: MrSafetyRequest): Promise<MrSafetyVerdict> {
  try {
    const text = await openaiChat(buildMrSafetyPrompt(req));
    if (text === null) return { severe: false, reason: 'No OpenAI response', engine: 'passthrough' };
    return parseMrSafetyResponse(text, 'openai');
  } catch (e) {
    return { severe: false, reason: `OpenAI failed (${e instanceof Error ? e.message : String(e)})`, engine: 'passthrough' };
  }
}
export async function askMrSafety(req: MrSafetyRequest): Promise<MrSafetyVerdict> {
  const openai = await askOpenAiMrSafety(req);
  return openai.engine === 'passthrough' ? askGeminiMrSafety(req) : openai;
}

// Options exit check — see buildOptionsExitPrompt's own comment for why this
// is a genuinely different question from askMrSafety above (time decay/hard
// expiry means it can't just filter for literal emergencies). Same fail-
// closed shape: an outage on both providers means thesisIntact: true —
// absence of a working AI call is never itself a reason to close a position.
export async function askOpenAiOptionsExit(req: OptionsExitRequest): Promise<OptionsExitVerdict> {
  try {
    const text = await openaiChat(buildOptionsExitPrompt(req));
    if (text === null) return { thesisIntact: true, reason: 'No OpenAI response', engine: 'passthrough' };
    return parseOptionsExitResponse(text, 'openai');
  } catch (e) {
    return { thesisIntact: true, reason: `OpenAI failed (${e instanceof Error ? e.message : String(e)})`, engine: 'passthrough' };
  }
}
export async function askOptionsExit(req: OptionsExitRequest): Promise<OptionsExitVerdict> {
  const openai = await askOpenAiOptionsExit(req);
  return openai.engine === 'passthrough' ? askGeminiOptionsExit(req) : openai;
}

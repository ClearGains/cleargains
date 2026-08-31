// ── xAI (Grok) — T212 ISA bot's acting judgment layer ───────────────────────
// Grok is the acting decision-maker for the T212 ISA bot as of 2026-08-25
// (moved here from OpenAI same day, per explicit request — Gemini and
// OpenAI both still run alongside it as a logged comparison, never gating a
// trade; see t212Bot.ts for where all three are invoked side by side).
//
// Included despite xAI's weaker data-privacy posture (trains on content by
// default, active regulatory scrutiny in several countries as of 2026) —
// the user's call, and reasonable for this specific payload: ticker, price,
// trend %, public news headlines, and a return % with no account-identifying
// data attached. Revisit if this ever starts carrying more sensitive data.
//
// Grok 4.6 tied OpenAI's best (gpt-5.6-sol) on the Artificial Analysis
// Intelligence Index (61). xAI's API is OpenAI-compatible, same
// request/response shape as openai.ts.
//
// NOTE: this file previously also carried Grok as the acting engine for the
// IG spread-bet bot and FX scalper bot — moved to OpenAI same day (see
// openai.ts's askIg*/askFxSwing) after Grok proved too slow on the IG bot's
// longer prompts (TradeIdea/ConfirmStockTrade) to sit on a decision path
// evaluating up to ~64 epics a scan. The trade-idea/stock-confirm xAI
// functions that supported that role were removed as dead code along with
// it — reintroduce them (straightforward mirror of openai.ts's askOpenAi*
// equivalents) if Grok is ever wanted back on those two specifically.
//
// Alpaca (paper trading only, 2026-08-25) — Grok as an actual live test, not
// just comparison logging: since nothing here is real money, the point is
// to genuinely try Grok as the acting engine and see if it's any better,
// not to hedge with a passive log. Still falls back to Gemini on a genuine
// Grok failure (no key, timeout, bad response) so the bot doesn't just stop
// trading when Grok has a bad moment — same failover discipline as every
// other bot, paper money or not.
import {
  buildIsaThesisPrompt, parseIsaThesisResponse, type IsaThesisRequest, type IsaThesisVerdict,
  buildDailyVerdictPrompt, parseDailyVerdictResponse, type DailyVerdictRequest, type DailyVerdict,
  buildPositionVerdictPrompt, parsePositionVerdictResponse, type PositionReviewRequest, type PositionVerdict,
  askGeminiDailyVerdict, askGeminiPositionVerdict,
} from './gemini';

const XAI_MODEL = 'grok-4.6';
// Alpaca scans a couple dozen symbols fairly frequently — same latency
// concern as the IG bot's scan, not T212's low-frequency check. 20s, not 45s.
const XAI_ACTING_TIMEOUT_MS = 20_000;

async function xaiChatActing(prompt: string): Promise<string | null> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return null;
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model:            XAI_MODEL,
      messages:         [{ role: 'user', content: prompt }],
      temperature:      0.2,
      // Confirmed live 2026-08-25: without this, grok-4.6's default reasoning
      // pass took ~13s on a realistic-length prompt (12.8s measured directly
      // against the real endpoint) — close enough to this function's 20s
      // budget that in practice EVERY Alpaca call was timing out and falling
      // back to Gemini (checked trade-journal/live logs: 100% of recent
      // askAlpacaDailyVerdict calls returned engine 'gemini', none 'xai').
      // 'low' cut the same test call to ~4s, comfortably inside budget —
      // T212's askXaiIsaThesis deliberately keeps full reasoning (no time
      // pressure at a 3h cadence), this is Alpaca-acting-only.
      reasoning_effort: 'low',
      response_format:  { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(XAI_ACTING_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? null;
}

export async function askXaiDailyVerdict(req: DailyVerdictRequest): Promise<DailyVerdict> {
  try {
    const text = await xaiChatActing(buildDailyVerdictPrompt(req));
    if (text === null) return { direction: req.direction, confidence: req.strength, reason: 'No xAI response', engine: 'passthrough' };
    return parseDailyVerdictResponse(text, req, 'xai');
  } catch (e) {
    return { direction: req.direction, confidence: req.strength, reason: `xAI failed (${e instanceof Error ? e.message : String(e)})`, engine: 'passthrough' };
  }
}

export async function askXaiPositionVerdict(req: PositionReviewRequest): Promise<PositionVerdict> {
  try {
    const text = await xaiChatActing(buildPositionVerdictPrompt(req));
    if (text === null) return { action: 'HOLD', confidence: 0, reason: 'No xAI response — holding, stop still protects the position', engine: 'passthrough' };
    return parsePositionVerdictResponse(text, 'xai');
  } catch (e) {
    return { action: 'HOLD', confidence: 0, reason: `xAI failed — holding, stop still protects the position (${e instanceof Error ? e.message : String(e)})`, engine: 'passthrough' };
  }
}

// Tries Grok; only calls Gemini if Grok's own attempt genuinely failed.
export async function askAlpacaDailyVerdict(req: DailyVerdictRequest): Promise<DailyVerdict> {
  const grok = await askXaiDailyVerdict(req);
  return grok.engine === 'passthrough' ? askGeminiDailyVerdict(req) : grok;
}
export async function askAlpacaPositionVerdict(req: PositionReviewRequest): Promise<PositionVerdict> {
  const grok = await askXaiPositionVerdict(req);
  return grok.engine === 'passthrough' ? askGeminiPositionVerdict(req) : grok;
}

export async function askXaiIsaThesis(req: IsaThesisRequest): Promise<IsaThesisVerdict> {
  const apiKey = process.env.XAI_API_KEY;
  const { prompt, fallbackAction } = buildIsaThesisPrompt(req);
  if (!apiKey) return { action: fallbackAction, confidence: 0, reason: 'No xAI key configured', engine: 'passthrough' };

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model:            XAI_MODEL,
        messages:         [{ role: 'user', content: prompt }],
        temperature:      0.2,
        // Switched from full (default) to 'low' 2026-08-28 — the xAI key's
        // allowance got burned through after ~3-4 days of this running at
        // full reasoning effort alongside Alpaca's separate high-frequency
        // Grok test (askAlpacaDailyVerdict/PositionVerdict, already 'low').
        // Explicit user call: keep Grok acting here, just cut cost/call
        // rather than dropping it or topping up credits.
        reasoning_effort: 'low',
        response_format:  { type: 'json_object' },
      }),
      // Was 45s for full reasoning on this long prompt. 'low' effort should
      // run markedly faster (Alpaca's own 'low' calls comfortably clear a
      // 20s budget on a shorter prompt) — 30s here isn't a measured number
      // for this specific (longer) prompt yet, just a safety margin above
      // that expectation. Tighten further once real timing is observed.
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { action: fallbackAction, confidence: 0, reason: `xAI ${res.status}`, engine: 'passthrough' };

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? '';
    return parseIsaThesisResponse(text, req.action, fallbackAction, 'xai');
  } catch (e) {
    return { action: fallbackAction, confidence: 0, reason: `xAI failed (${e instanceof Error ? e.message : String(e)})`, engine: 'passthrough' };
  }
}

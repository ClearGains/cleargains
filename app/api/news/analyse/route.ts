export interface NewsHeadline {
  headline: string;
  source: string;
  datetime: string | number;
  url?: string;
}

export interface NewsSignal {
  headline: string;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number;
  affectedAssets: string[];
  action: 'CLOSE_LONG' | 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE_SHORT' | 'HOLD' | 'NONE';
  reasoning: string;
  urgency: 'HIGH' | 'MEDIUM' | 'LOW';
  url?: string;
}

// Plain keyword-based classification — no AI call. Previously used the
// Anthropic API directly (a third AI provider, separate from Gemini,
// genuinely never realized was wired up) for a feature that turned out to
// be barely used and never actually billed anything. Reuses the same
// bullish/bearish word-list approach already proven in
// app/api/demo-trader/signals/route.ts's sentimentScore, rather than
// spending Gemini's shared allowance on something this low-value.
const BULLISH = ['beats','beat','surges','surge','soars','soar','rises','rise','gains','gain',
  'rallies','rally','record','upgrade','upgraded','outperform','strong','growth','profit','profits',
  'boost','boosted','raises','raised','exceeds','jumps','jump','climbs','positive','higher','bullish',
  'buy','overweight','breakthrough','approval','deal','wins'];
const BEARISH = ['misses','miss','falls','fall','drops','drop','declines','decline','plunges','plunge',
  'slumps','slump','loss','losses','cuts','cut','downgrade','downgraded','underperform','weak',
  'concern','concerns','risk','risks','warning','warns','layoffs','disappoints','sell','bearish',
  'negative','lower','down','below','lawsuit','probe','recall','sinks','sink','tumbles','tumble'];
// Words that flip an otherwise-bullish-looking headline when they appear
// right before it — catches the classic "X sinks AS market gains" pattern
// (relative underperformance, not a bullish signal for X specifically),
// which is exactly the kind of headline a naive keyword scan (or an LLM
// skimming for the word "gains") gets backwards.
const RELATIVE_FLIP = /\b(sinks?|falls?|drops?|declines?|slumps?|tumbles?)\b[^.!?]{0,40}\bas\b[^.!?]{0,20}\b(market|index|s&p|nasdaq|dow)\b/i;

const URGENT_WORDS = ['fed','federal reserve','rate decision','earnings','acquisition','merger',
  'bankruptcy','lawsuit','recall','fraud','investigation','ceo','resigns','fired'];

function classify(headline: string): { sentiment: NewsSignal['sentiment']; confidence: number; bull: number; bear: number } {
  const l = headline.toLowerCase();
  let bull = BULLISH.filter(w => l.includes(w)).length;
  let bear = BEARISH.filter(w => l.includes(w)).length;

  if (RELATIVE_FLIP.test(headline)) {
    // The stock itself is underperforming even though a bullish-sounding
    // word (e.g. "gains") appears — that word describes the market, not
    // the asset in the headline. Treat as bearish for the asset.
    bear += 2;
  }

  const total = bull + bear;
  if (total === 0) return { sentiment: 'NEUTRAL', confidence: 0, bull, bear };
  const sentiment = bull === bear ? 'NEUTRAL' : bull > bear ? 'BULLISH' : 'BEARISH';
  // Confidence scales with how lopsided the keyword count is — a single
  // matched word either way is a weak signal, several in one direction is
  // a much stronger one. Capped well below 100 since this is pattern
  // matching, not real comprehension.
  const confidence = Math.min(90, 55 + Math.abs(bull - bear) * 12);
  return { sentiment, confidence, bull, bear };
}

function findAffectedAssets(headline: string, watchlist: string[], openPositions: { symbol: string }[]): string[] {
  const l = headline.toLowerCase();
  const candidates = new Set([...watchlist, ...openPositions.map(p => p.symbol)]);
  const hits: string[] = [];
  for (const sym of candidates) {
    if (!sym) continue;
    const s = sym.toLowerCase();
    // Matches a bare ticker (word boundary) or the common "(TICKER)" form
    // news headlines use — doesn't attempt full company-name matching,
    // that needs real entity recognition this deliberately isn't doing.
    const re = new RegExp(`\\(${s}\\)|\\b${s}\\b`, 'i');
    if (re.test(l)) hits.push(sym);
  }
  return hits;
}

export async function POST(request: Request) {
  const { headlines, openPositions, watchlist } = await request.json() as {
    headlines: NewsHeadline[];
    openPositions: { symbol: string; direction: string; size: number }[];
    watchlist: string[];
  };

  if (!headlines?.length) {
    return Response.json({ analysis: [], success: true });
  }

  const heldSymbols = new Map(openPositions.map(p => [p.symbol, p.direction]));
  const analysis: NewsSignal[] = [];

  for (const h of headlines.slice(0, 30)) {
    const affectedAssets = findAffectedAssets(h.headline, watchlist ?? [], openPositions ?? []);
    if (!affectedAssets.length) continue; // only relevant headlines, same as before

    const { sentiment, confidence, bull, bear } = classify(h.headline);
    if (confidence < 60) continue; // same "above 60%" bar the AI version used

    const isUrgent = URGENT_WORDS.some(w => h.headline.toLowerCase().includes(w));

    let action: NewsSignal['action'] = 'NONE';
    const heldDirection = affectedAssets.map(a => heldSymbols.get(a)).find(Boolean);
    if (sentiment === 'BULLISH' && confidence >= 70) {
      action = heldDirection === 'SHORT' ? 'CLOSE_SHORT' : !heldDirection ? 'OPEN_LONG' : 'HOLD';
    } else if (sentiment === 'BEARISH' && confidence >= 70) {
      action = heldDirection === 'LONG' ? 'CLOSE_LONG' : !heldDirection ? 'OPEN_SHORT' : 'HOLD';
    } else {
      action = heldDirection ? 'HOLD' : 'NONE';
    }
    // Only recommend CLOSE actions above the higher 75% bar, matching the
    // AI version's own rule — downgrade to HOLD below that.
    if ((action === 'CLOSE_LONG' || action === 'CLOSE_SHORT') && confidence < 75) action = 'HOLD';

    analysis.push({
      headline: h.headline,
      sentiment,
      confidence,
      affectedAssets,
      action,
      reasoning: `${bull} bullish / ${bear} bearish keyword${bull + bear === 1 ? '' : 's'} matched`,
      urgency: isUrgent ? 'HIGH' : confidence >= 75 ? 'MEDIUM' : 'LOW',
      url: h.url,
    });
  }

  return Response.json({ analysis, success: true });
}

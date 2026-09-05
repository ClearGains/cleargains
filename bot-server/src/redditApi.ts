// ── Reddit — free secondary hype signal ─────────────────────────────────────
// Confirmed live 2026-09-05: Reddit's old unauthenticated `.json` trick is
// dead (robots.txt now disallows everything, oauth.reddit.com 403s without a
// real bearer token) — the sanctioned, still-genuinely-free path is a
// registered "script" app (reddit.com/prefs/apps, no payment) using the
// app-only client_credentials grant, which only needs REDDIT_CLIENT_ID/
// REDDIT_CLIENT_SECRET, no user login. Fails open exactly like
// lunarcrushApi.ts: no credentials or any failure returns zero mentions
// rather than blocking the strategy — this is a secondary/supplementary
// signal on top of DexScreener's on-chain volume proxy, never a hard gate
// on its own, since meme coin culture lives on Twitter/Telegram far more
// than Reddit (this account has no legitimate free path to those — see
// memeCoinBot.ts's own history for why).

const SUBREDDITS = ['CryptoMoonShots', 'SolanaMemeCoins', 'solana', 'Solana'];
const MENTION_WINDOW_MS = 24 * 3_600_000;

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAppToken(): Promise<string | null> {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  try {
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'nexustrade-bot/1.0 (meme coin hype signal)',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    // Refresh a couple minutes early rather than exactly at expiry.
    cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 120_000 };
    return cachedToken.token;
  } catch {
    return null;
  }
}

export type RedditMentions = { count: number; source: 'reddit' | 'none' };

// Ticker symbols are short and generic (e.g. "SOL", "AI") — searching them
// bare produces enormous false-positive noise across unrelated subreddits.
// Scoping to a small, meme-coin-relevant subreddit list and requiring the
// token to appear as a whole word keeps this a real signal rather than
// counting every unrelated use of a common word.
export async function getMentionCount(symbol: string): Promise<RedditMentions> {
  const token = await getAppToken();
  if (!token) return { count: 0, source: 'none' };
  if (symbol.length < 3) return { count: 0, source: 'none' }; // too generic to search meaningfully

  let total = 0;
  const cutoff = (Date.now() - MENTION_WINDOW_MS) / 1000;
  try {
    for (const sub of SUBREDDITS) {
      const res = await fetch(
        `https://oauth.reddit.com/r/${sub}/search?q=${encodeURIComponent(symbol)}&restrict_sr=1&sort=new&limit=25&t=day`,
        { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'nexustrade-bot/1.0 (meme coin hype signal)' }, signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) continue;
      const data = await res.json() as { data?: { children?: Array<{ data?: { created_utc?: number } }> } };
      const posts = data.data?.children ?? [];
      total += posts.filter(p => (p.data?.created_utc ?? 0) >= cutoff).length;
    }
    return { count: total, source: 'reddit' };
  } catch {
    return { count: total, source: total > 0 ? 'reddit' : 'none' };
  }
}

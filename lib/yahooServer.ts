/**
 * Shared server-side Yahoo Finance authentication helper.
 * Tries multiple strategies to obtain a valid crumb + cookie pair.
 * Import only from API routes (server-side), never from client components.
 */

export const YF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let crumbCache: { crumb: string; cookie: string; ts: number } | null = null;

const COOKIE_NAMES = ['A1', 'A1S', 'A3'];

function extractYahooCookie(header: string): string {
  for (const name of COOKIE_NAMES) {
    const m = new RegExp(`\\b${name}=([^;,\\s]+)`).exec(header);
    if (m) return `${name}=${m[1]}`;
  }
  return '';
}

async function tryGetCrumb(cookie: string): Promise<string | null> {
  try {
    const headers: HeadersInit = { 'User-Agent': YF_UA, Accept: 'text/plain' };
    if (cookie) (headers as Record<string, string>)['Cookie'] = cookie;
    const r = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers });
    if (!r.ok) return null;
    const crumb = (await r.text()).trim();
    if (!crumb || crumb.length > 50 || crumb.includes('<')) return null;
    return crumb;
  } catch {
    return null;
  }
}

async function strategy1(): Promise<{ crumb: string; cookie: string } | null> {
  // fc.yahoo.com redirect — original approach
  const r = await fetch('https://fc.yahoo.com', {
    headers: { 'User-Agent': YF_UA, Accept: 'text/html' },
    redirect: 'manual',
  });
  const cookie = extractYahooCookie(r.headers.get('set-cookie') ?? '');
  const crumb = await tryGetCrumb(cookie);
  return crumb ? { crumb, cookie } : null;
}

async function strategy2(): Promise<{ crumb: string; cookie: string } | null> {
  // finance.yahoo.com follow redirects — picks up cookies after consent flow
  const r = await fetch('https://finance.yahoo.com', {
    headers: {
      'User-Agent': YF_UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  const cookie = extractYahooCookie(r.headers.get('set-cookie') ?? '');
  const crumb = await tryGetCrumb(cookie);
  return crumb ? { crumb, cookie } : null;
}

async function strategy3(): Promise<{ crumb: string; cookie: string } | null> {
  // No cookie — some endpoints still respond without one
  const crumb = await tryGetCrumb('');
  return crumb ? { crumb, cookie: '' } : null;
}

export async function getYahooCrumb(): Promise<{ crumb: string; cookie: string } | null> {
  if (crumbCache && Date.now() - crumbCache.ts < 25 * 60_000) return crumbCache;

  for (const strategy of [strategy1, strategy2, strategy3]) {
    try {
      const result = await strategy();
      if (result) {
        crumbCache = { ...result, ts: Date.now() };
        return crumbCache;
      }
    } catch {
      // try next
    }
  }

  return null;
}

export function yfHeaders(cookie?: string): HeadersInit {
  return {
    'User-Agent': YF_UA,
    Accept: 'application/json',
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

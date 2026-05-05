/**
 * Shared server-side Yahoo Finance authentication helper.
 * Fetches and caches the A1 consent cookie + crumb token.
 * Import only from API routes (server-side), never from client components.
 */

export const YF_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let crumbCache: { crumb: string; cookie: string; ts: number } | null = null;

export async function getYahooCrumb(): Promise<{ crumb: string; cookie: string } | null> {
  if (crumbCache && Date.now() - crumbCache.ts < 25 * 60_000) return crumbCache;
  try {
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': YF_UA, Accept: 'text/html' },
      redirect: 'manual',
    });
    const setCookie = r1.headers.get('set-cookie') ?? '';
    const a1 = setCookie.match(/A1=([^;]+)/)?.[1];
    const cookie = a1 ? `A1=${a1}` : '';

    const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': YF_UA, Accept: 'text/plain', Cookie: cookie },
    });
    if (!r2.ok) return null;
    const crumb = (await r2.text()).trim();
    if (!crumb || crumb.length > 30 || crumb.includes('<')) return null;

    crumbCache = { crumb, cookie, ts: Date.now() };
    return crumbCache;
  } catch {
    return null;
  }
}

export function yfHeaders(cookie?: string): HeadersInit {
  return {
    'User-Agent': YF_UA,
    Accept: 'application/json',
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

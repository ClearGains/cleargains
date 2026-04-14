/**
 * Server-side account-linking utilities.
 * Uses Node.js `crypto` — never import this in Edge runtime or client components.
 */
import { createHmac, createHash } from 'crypto';

export const ACCOUNT_COOKIE = 'cg-account-links';
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export type AccountType = 'demo' | 'live' | 'isa';

export type AccountClaim = {
  keyHash: string;   // SHA-256(apiKey:apiSecret) — never the raw key
  accountId: string; // T212 account ID (from their API)
  accountType: AccountType;
  linkedAt: number;  // Unix ms
};

export type AccountLinks = {
  claims: AccountClaim[];
  exp: number; // Unix ms
};

function getSecret(): string {
  const s = process.env.ACCOUNT_SECRET;
  if (!s) {
    // Warn loudly so developers add the env var
    console.warn(
      '[accountAuth] ACCOUNT_SECRET is not set — account link tokens will use a weak fallback. ' +
      'Set ACCOUNT_SECRET in Vercel Dashboard → Settings → Environment Variables.'
    );
  }
  return s ?? 'fallback-insecure-account-secret';
}

/** SHA-256 hash of the raw "key:secret" string */
export function hashKeyPair(apiKey: string, apiSecret: string): string {
  return createHash('sha256').update(`${apiKey}:${apiSecret}`).digest('hex');
}

/**
 * Hash the key pair from a base64-encoded "key:secret" string
 * (the format sent in x-t212-auth headers).
 */
export function hashFromEncoded(encoded: string): string {
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  return createHash('sha256').update(decoded).digest('hex');
}

/** Serialize and HMAC-sign an AccountLinks object → cookie string */
export function signLinks(links: AccountLinks): string {
  const payload = Buffer.from(JSON.stringify(links)).toString('base64url');
  const sig = createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Verify and parse a signed cookie string → AccountLinks or null */
export function verifyLinks(cookie: string): AccountLinks | null {
  const dotIdx = cookie.lastIndexOf('.');
  if (dotIdx === -1) return null;
  const payload = cookie.slice(0, dotIdx);
  const sig = cookie.slice(dotIdx + 1);
  const expected = createHmac('sha256', getSecret()).update(payload).digest('base64url');
  if (expected !== sig) return null;
  try {
    const links = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AccountLinks;
    if (links.exp < Date.now()) return null;
    return links;
  } catch {
    return null;
  }
}

/** Check whether a specific account type + key hash is authorised in the cookie */
export function isAuthorised(
  cookie: string | undefined,
  accountType: AccountType,
  keyHash: string
): boolean {
  if (!cookie) return false;
  const links = verifyLinks(cookie);
  if (!links) return false;
  return links.claims.some(c => c.accountType === accountType && c.keyHash === keyHash);
}

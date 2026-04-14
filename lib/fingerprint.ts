'use client';

/**
 * Generates a short unique account ID from a T212 API key using SHA-256.
 * The first 8 bytes of the hash → 16 hex chars like "a3f7c291b8e240d1".
 * This is stored as 't212_account_id' — never the raw key.
 */
export async function generateAccountId(apiKey: string): Promise<string> {
  const clean = apiKey.replace(/[\s\n\r\t]/g, '');
  const data = new TextEncoder().encode(clean);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── localStorage helpers ──────────────────────────────────────────────────────

const LS_ACCOUNT_ID = 't212_account_id';
const SYNC_URL_PREFIX = 'sync_url_';

export function getStoredAccountId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(LS_ACCOUNT_ID);
}

export function setStoredAccountId(id: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(LS_ACCOUNT_ID, id);
}

export function getStoredSyncUrl(accountId: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(SYNC_URL_PREFIX + accountId);
}

export function setStoredSyncUrl(accountId: string, url: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(SYNC_URL_PREFIX + accountId, url);
}

export function clearStoredSyncUrl(accountId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(SYNC_URL_PREFIX + accountId);
}

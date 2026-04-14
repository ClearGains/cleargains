/**
 * AES-256-GCM encryption/decryption for T212 API credentials.
 *
 * Uses the Web Crypto API (available in both browser and Node.js 18+).
 * The encryption password is the user's SITE_PASSWORD — raw keys are
 * never sent to any server; only the encrypted blob is stored in Redis.
 *
 * Format: `ivBase64.encryptedBase64`
 */

const SALT = 'cleargains-salt';
const ITERATIONS = 100_000;

async function deriveKey(password: string, usage: 'encrypt' | 'decrypt') {
  const encoder = new TextEncoder();
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode(SALT), iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

export async function encryptKey(plaintext: string, password: string): Promise<string> {
  const key = await deriveKey(password, 'encrypt');
  const iv  = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  const ivB64   = btoa(String.fromCharCode(...iv));
  const dataB64 = btoa(String.fromCharCode(...new Uint8Array(encrypted)));
  return `${ivB64}.${dataB64}`;
}

export async function decryptKey(encryptedStr: string, password: string): Promise<string> {
  const [ivB64, dataB64] = encryptedStr.split('.');
  if (!ivB64 || !dataB64) throw new Error('Invalid encrypted key format');
  const iv   = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
  const data = Uint8Array.from(atob(dataB64), c => c.charCodeAt(0));
  const key  = await deriveKey(password, 'decrypt');
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
  return new TextDecoder().decode(decrypted);
}

/** Encrypt all three T212 account credential pairs with the given password. */
export async function encryptAllCredentials(
  creds: {
    live?: { key: string; secret: string };
    isa?:  { key: string; secret: string };
    demo?: { key: string; secret: string };
  },
  password: string
): Promise<{
  live?: { key: string; secret: string };
  isa?:  { key: string; secret: string };
  demo?: { key: string; secret: string };
}> {
  const result: {
    live?: { key: string; secret: string };
    isa?:  { key: string; secret: string };
    demo?: { key: string; secret: string };
  } = {};

  if (creds.live?.key && creds.live?.secret) {
    result.live = {
      key:    await encryptKey(creds.live.key, password),
      secret: await encryptKey(creds.live.secret, password),
    };
  }
  if (creds.isa?.key && creds.isa?.secret) {
    result.isa = {
      key:    await encryptKey(creds.isa.key, password),
      secret: await encryptKey(creds.isa.secret, password),
    };
  }
  if (creds.demo?.key && creds.demo?.secret) {
    result.demo = {
      key:    await encryptKey(creds.demo.key, password),
      secret: await encryptKey(creds.demo.secret, password),
    };
  }

  return result;
}

/** Decrypt all available T212 account credential pairs with the given password. */
export async function decryptAllCredentials(
  encrypted: {
    live?: { key: string; secret: string };
    isa?:  { key: string; secret: string };
    demo?: { key: string; secret: string };
  },
  password: string
): Promise<{
  live?: { key: string; secret: string };
  isa?:  { key: string; secret: string };
  demo?: { key: string; secret: string };
}> {
  const result: {
    live?: { key: string; secret: string };
    isa?:  { key: string; secret: string };
    demo?: { key: string; secret: string };
  } = {};

  if (encrypted.live?.key && encrypted.live?.secret) {
    result.live = {
      key:    await decryptKey(encrypted.live.key, password),
      secret: await decryptKey(encrypted.live.secret, password),
    };
  }
  if (encrypted.isa?.key && encrypted.isa?.secret) {
    result.isa = {
      key:    await decryptKey(encrypted.isa.key, password),
      secret: await decryptKey(encrypted.isa.secret, password),
    };
  }
  if (encrypted.demo?.key && encrypted.demo?.secret) {
    result.demo = {
      key:    await decryptKey(encrypted.demo.key, password),
      secret: await decryptKey(encrypted.demo.secret, password),
    };
  }

  return result;
}

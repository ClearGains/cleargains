import { NextResponse } from 'next/server';

/**
 * GET /api/health
 * Returns status of all environment variables needed for the app to function.
 * Values are NEVER leaked — only "set" or "MISSING" is returned.
 *
 * Required variables must be set in Vercel Dashboard → Settings → Environment Variables.
 * Do NOT prefix server-side secrets with NEXT_PUBLIC_ or they will be embedded in the
 * client bundle and exposed to users.
 */

const REQUIRED = [
  'FINNHUB_API_KEY',
  'ANTHROPIC_API_KEY',
  'ACCOUNT_SECRET',
] as const;

const OPTIONAL = [
  'SITE_PASSWORD',
  'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_EMAIL',
  'NEXT_PUBLIC_EXCHANGERATE_URL',
] as const;

export async function GET() {
  const required = Object.fromEntries(
    REQUIRED.map(v => [v, process.env[v] ? 'set' : 'MISSING'])
  );
  const optional = Object.fromEntries(
    OPTIONAL.map(v => [v, process.env[v] ? 'set' : 'not set'])
  );
  const allRequiredPresent = REQUIRED.every(v => Boolean(process.env[v]));

  return NextResponse.json(
    { required, optional, allRequiredPresent, timestamp: new Date().toISOString() },
    { status: allRequiredPresent ? 200 : 503 }
  );
}

import type { NextConfig } from "next";

/**
 * REQUIRED server-side environment variables — set all of these in:
 *   Vercel Dashboard → Your Project → Settings → Environment Variables
 *
 * Server-side (never prefix with NEXT_PUBLIC_):
 *   FINNHUB_API_KEY      — Finnhub market data API key
 *   ANTHROPIC_API_KEY    — Claude API key for AI scanner
 *   ACCOUNT_SECRET       — Random secret for signing account-link cookies (min 32 chars)
 *   VAPID_PRIVATE_KEY    — Web push VAPID private key
 *   VAPID_EMAIL          — Web push sender email (mailto:...)
 *
 * Optional server-side:
 *   SITE_PASSWORD        — If set, protects the whole site with a password
 *
 * Public (safe to expose to browser — must have NEXT_PUBLIC_ prefix):
 *   NEXT_PUBLIC_VAPID_PUBLIC_KEY  — Web push VAPID public key
 *   NEXT_PUBLIC_EXCHANGERATE_URL  — Exchange rate API base URL
 *
 * Visit /api/health to see which variables are currently set on the server.
 */
const nextConfig: NextConfig = {
  turbopack: {},
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default nextConfig;

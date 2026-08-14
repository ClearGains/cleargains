// Shared IG auth-header resolution for the /api/ig/* routes.
//
// Two auth styles now coexist deliberately, not as a migration-in-progress:
// - Legacy (CST / X-SECURITY-TOKEN, IG session Version 2): what every
//   existing caller of these routes already uses (SharesTrading,
//   IGStrategyTrader, dashboard, /positions, /settings/accounts, etc.) —
//   left completely untouched so none of them need to change.
// - OAuth (Version 3): what IGCfdAutoTrader.tsx uses instead, specifically
//   because it needs to run concurrently with the persistent server-side
//   bots (igStrategyBot.ts/fxScalperBot.ts on the SPREADBET account)
//   without triggering IG's real, confirmed-live "second concurrent
//   session" rejection (error.security.api-key-disabled /
//   exceed-login-session-limit). Verified directly against IG's API before
//   building this: a legacy (V2) session and an OAuth (V3) session on the
//   same account coexist without colliding, but two legacy sessions do
//   not — so the fix is a second, independent OAuth login for the CFD
//   bot, not a wholesale swap of the existing mechanism (which would also
//   have broken Lightstreamer — it specifically requires CST/token, OAuth
//   doesn't provide them).
//
// IG's own account-targeting differs by auth style too: a legacy session
// is pinned to whichever account it authenticated/switched onto; an OAuth
// session isn't pinned to one account at all — every request carries an
// explicit IG-ACCOUNT-ID header saying which account (SPREADBET, CFD,
// stocks) that specific call applies to. That's what actually lets one
// OAuth login address multiple account types without ever needing to
// "switch."

export type IgOutboundAuth =
  | { style: 'legacy'; apiKey: string; cst: string; securityToken: string }
  | { style: 'oauth';  apiKey: string; accessToken: string; accountId: string };

// Reads whichever auth style the incoming request used and returns a
// discriminated result — never both, never neither silently. Callers
// should treat a null return as "missing auth headers" (400/401), same as
// today's behaviour when cst/securityToken were absent.
export function resolveIgAuth(request: Request): IgOutboundAuth | null {
  const apiKey = request.headers.get('x-ig-api-key') ?? '';
  if (!apiKey) return null;

  const accessToken = request.headers.get('x-ig-access-token');
  const accountId   = request.headers.get('x-ig-account-id');
  if (accessToken && accountId) {
    return { style: 'oauth', apiKey, accessToken, accountId };
  }

  const cst           = request.headers.get('x-ig-cst') ?? '';
  const securityToken = request.headers.get('x-ig-security-token') ?? '';
  if (cst && securityToken) {
    return { style: 'legacy', apiKey, cst, securityToken };
  }

  return null;
}

// Builds the headers to actually send to IG's own REST API for this
// request, given whichever auth style was resolved above. `version` is
// the IG API "Version" header for the specific endpoint being called —
// unrelated to the auth style (both legacy and OAuth sessions can call any
// endpoint version).
export function igRequestHeaders(auth: IgOutboundAuth, version: string): Record<string, string> {
  const base = {
    'X-IG-API-KEY': auth.apiKey,
    'Accept':       'application/json; charset=UTF-8',
    'Version':      version,
  };
  return auth.style === 'oauth'
    ? { ...base, 'Authorization': `Bearer ${auth.accessToken}`, 'IG-ACCOUNT-ID': auth.accountId }
    : { ...base, 'CST': auth.cst, 'X-SECURITY-TOKEN': auth.securityToken };
}

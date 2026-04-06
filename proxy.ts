import { NextRequest, NextResponse } from 'next/server';

export const SESSION_COOKIE = 'cg-session';

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Pass through: login page, auth API, Next.js internals, static assets
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next();
  }

  const sitePassword = process.env.SITE_PASSWORD;

  // If no SITE_PASSWORD is configured the site is open — useful in local dev
  if (!sitePassword) return NextResponse.next();

  const session = request.cookies.get(SESSION_COOKIE)?.value;

  // Store password as base64 token in the cookie (sufficient for a private site)
  const expected = btoa(sitePassword);

  if (session !== expected) {
    const loginUrl = new URL('/login', request.url);
    // Preserve intended destination for redirect after login
    loginUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

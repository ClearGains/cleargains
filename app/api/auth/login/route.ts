import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/proxy';

export async function POST(request: NextRequest) {
  const { password } = await request.json() as { password: string };
  const sitePassword = process.env.SITE_PASSWORD;

  if (!sitePassword) {
    // No password configured — just set a cookie and allow
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, 'open', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
    return res;
  }

  if (password !== sitePassword) {
    return NextResponse.json({ ok: false, error: 'Incorrect password.' }, { status: 401 });
  }

  const token = btoa(sitePassword);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
    secure: process.env.NODE_ENV === 'production',
  });
  return res;
}

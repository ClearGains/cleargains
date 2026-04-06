import { NextRequest, NextResponse } from 'next/server';
import webpush from 'web-push';
import { readFile } from 'fs/promises';
import path from 'path';

const SUBS_FILE = path.join(process.cwd(), 'data', 'push-subscriptions.json');

webpush.setVapidDetails(
  process.env.VAPID_EMAIL ?? 'mailto:admin@cleargains.app',
  process.env.NEXT_PUBLIC_VAPID_KEY ?? '',
  process.env.VAPID_PRIVATE_KEY ?? ''
);

export async function POST(request: NextRequest) {
  const { title, body, url, tag } = await request.json() as {
    title: string;
    body: string;
    url?: string;
    tag?: string;
  };

  let subs: webpush.PushSubscription[] = [];
  try {
    const raw = await readFile(SUBS_FILE, 'utf-8');
    subs = JSON.parse(raw) as webpush.PushSubscription[];
  } catch {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  if (subs.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 });
  }

  const payload = JSON.stringify({ title, body, url: url ?? '/', tag });

  const results = await Promise.allSettled(
    subs.map((sub) => webpush.sendNotification(sub, payload))
  );

  const sent = results.filter((r) => r.status === 'fulfilled').length;
  return NextResponse.json({ ok: true, sent, total: subs.length });
}

import { NextRequest, NextResponse } from 'next/server';
import { writeFile, readFile } from 'fs/promises';

const SUBS_FILE = '/tmp/push-subscription.json';

export async function POST(request: NextRequest) {
  const subscription = await request.json();

  if (!subscription?.endpoint) {
    return NextResponse.json({ error: 'Invalid subscription.' }, { status: 400 });
  }

  // Read existing subscriptions (array), replace or append
  let subs: object[] = [];
  try {
    const raw = await readFile(SUBS_FILE, 'utf-8');
    subs = JSON.parse(raw);
  } catch {
    // File doesn't exist yet — start fresh
  }

  const idx = subs.findIndex(
    (s) => (s as { endpoint: string }).endpoint === subscription.endpoint
  );
  if (idx >= 0) {
    subs[idx] = subscription;
  } else {
    subs.push(subscription);
  }

  await writeFile(SUBS_FILE, JSON.stringify(subs));
  return NextResponse.json({ ok: true });
}

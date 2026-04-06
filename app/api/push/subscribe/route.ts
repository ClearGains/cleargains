import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';

const SUBS_FILE = path.join(process.cwd(), 'data', 'push-subscriptions.json');

async function readSubs(): Promise<object[]> {
  try {
    const raw = await readFile(SUBS_FILE, 'utf-8');
    return JSON.parse(raw) as object[];
  } catch {
    return [];
  }
}

async function writeSubs(subs: object[]) {
  await writeFile(SUBS_FILE, JSON.stringify(subs, null, 2), 'utf-8');
}

export async function POST(request: NextRequest) {
  const sub = await request.json() as { endpoint: string; keys: object };

  if (!sub?.endpoint) {
    return NextResponse.json({ error: 'Invalid subscription.' }, { status: 400 });
  }

  const subs = await readSubs();
  // Replace existing subscription for same endpoint
  const idx = subs.findIndex((s) => (s as { endpoint: string }).endpoint === sub.endpoint);
  if (idx >= 0) {
    subs[idx] = sub;
  } else {
    subs.push(sub);
  }

  await writeSubs(subs);
  return NextResponse.json({ ok: true, count: subs.length });
}

export async function DELETE(request: NextRequest) {
  const { endpoint } = await request.json() as { endpoint: string };
  const subs = await readSubs();
  const filtered = subs.filter((s) => (s as { endpoint: string }).endpoint !== endpoint);
  await writeSubs(filtered);
  return NextResponse.json({ ok: true });
}

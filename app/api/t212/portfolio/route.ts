import { NextRequest, NextResponse } from 'next/server';
import { fetchT212Portfolio } from '@/lib/t212';

export async function GET(request: NextRequest) {
  const accountType =
    (request.nextUrl.searchParams.get('accountType') as 'LIVE' | 'DEMO') ??
    'DEMO';

  if (!process.env.T212_API_KEY) {
    return NextResponse.json(
      { error: 'T212_API_KEY not configured' },
      { status: 503 }
    );
  }

  try {
    const positions = await fetchT212Portfolio(accountType);
    return NextResponse.json({ positions });
  } catch (err) {
    console.error('T212 portfolio error:', err);
    return NextResponse.json(
      { error: `T212 portfolio failed: ${err instanceof Error ? err.message : 'Unknown error'}` },
      { status: 500 }
    );
  }
}

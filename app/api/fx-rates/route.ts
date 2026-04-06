import { NextRequest, NextResponse } from 'next/server';

export const revalidate = 3600; // Cache for 1 hour

export async function GET(request: NextRequest) {
  const base = request.nextUrl.searchParams.get('base') ?? 'GBP';
  const apiKey = process.env.FX_API_KEY;

  if (!apiKey) {
    // Return mock rates if no API key configured
    const mockRates: Record<string, number> = {
      GBP: 1,
      USD: 1.27,
      EUR: 1.17,
      CAD: 1.72,
      AUD: 1.94,
      SEK: 13.42,
    };
    return NextResponse.json({ base, rates: mockRates, mock: true });
  }

  try {
    const url = `https://v6.exchangerate-api.com/v6/${apiKey}/latest/${base}`;
    const res = await fetch(url, { next: { revalidate: 3600 } });

    if (!res.ok) {
      throw new Error(`Exchange rate API returned ${res.status}`);
    }

    const data = await res.json();

    if (data.result !== 'success') {
      throw new Error(data['error-type'] ?? 'Unknown FX API error');
    }

    return NextResponse.json({
      base: data.base_code,
      rates: data.conversion_rates,
      lastUpdate: data.time_last_update_utc,
    });
  } catch (err) {
    console.error('FX rate fetch error:', err);
    // Fallback rates
    const fallbackRates: Record<string, number> = {
      GBP: 1,
      USD: 1.27,
      EUR: 1.17,
      CAD: 1.72,
      AUD: 1.94,
      SEK: 13.42,
      IRE: 1.17,
    };
    return NextResponse.json(
      { base, rates: fallbackRates, fallback: true, error: String(err) },
      { status: 200 }
    );
  }
}

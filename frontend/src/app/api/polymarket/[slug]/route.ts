import { NextRequest, NextResponse } from 'next/server';

const GAMMA_API = 'https://gamma-api.polymarket.com';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const res = await fetch(`${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`, {
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      return NextResponse.json(
        { markets: [] },
        {
          status: 200,
          headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=120' },
        },
      );
    }

    const data = await res.json();
    const event = Array.isArray(data) ? data[0] : data;

    if (!event) {
      return NextResponse.json(
        { markets: [] },
        {
          status: 200,
          headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=120' },
        },
      );
    }

    return NextResponse.json(event, {
      headers: { 'Cache-Control': 's-maxage=60, stale-while-revalidate=120' },
    });
  } catch {
    return NextResponse.json(
      { markets: [] },
      {
        status: 200,
        headers: { 'Cache-Control': 's-maxage=30, stale-while-revalidate=60' },
      },
    );
  }
}

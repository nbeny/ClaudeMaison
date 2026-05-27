import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

export async function GET() {
  const session = await auth();
  const token = (session as never as { accessToken?: string })?.accessToken;
  if (!token) return NextResponse.json({ error: 'unauth' }, { status: 401 });
  return NextResponse.json({ token });
}

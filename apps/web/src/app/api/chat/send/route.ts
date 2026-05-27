import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { gqlClient } from '@/lib/gql';

export async function POST(req: Request) {
  const session = await auth();
  const accessToken = (session as never as { accessToken?: string })?.accessToken;
  if (!accessToken) return NextResponse.json({ error: 'unauth' }, { status: 401 });
  const { conversationId, content } = await req.json();
  const data = await gqlClient(accessToken).request(`
    mutation { sendMessage(conversationId: "${conversationId}", content: ${JSON.stringify(content)}) {
      conversationId userMessageId assistantMessageId
    }}
  `);
  return NextResponse.json(data);
}

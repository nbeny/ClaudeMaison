import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { gqlClient } from '@/lib/gql';

export async function POST() {
  const session = await auth();
  const accessToken = (session as never as { accessToken?: string })?.accessToken;
  if (!accessToken) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const workspaceId = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_ID!;
  const data = await gqlClient(accessToken).request<{ startConversation: string }>(`
    mutation { startConversation(workspaceId: "${workspaceId}") }
  `);
  return NextResponse.json({ conversationId: data.startConversation });
}

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { gqlClient } from '@/lib/gql';

const START_CONVERSATION = `
  mutation Start($workspaceId: ID!) {
    startConversation(workspaceId: $workspaceId)
  }
`;

export async function POST() {
  const session = await auth();
  const accessToken = (session as never as { accessToken?: string })?.accessToken;
  if (!accessToken) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const workspaceId = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_ID;
  if (!workspaceId) {
    return NextResponse.json(
      { error: 'NEXT_PUBLIC_DEFAULT_WORKSPACE_ID not configured' },
      { status: 500 },
    );
  }
  const data = await gqlClient(accessToken).request<{ startConversation: string }>(
    START_CONVERSATION,
    { workspaceId },
  );
  return NextResponse.json({ conversationId: data.startConversation });
}

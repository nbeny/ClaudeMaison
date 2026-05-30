import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { gqlClient } from '@/lib/gql';

const SEND_MESSAGE = `
  mutation Send($conversationId: ID!, $content: String!) {
    sendMessage(conversationId: $conversationId, content: $content) {
      conversationId
      userMessageId
      assistantMessageId
    }
  }
`;

export async function POST(req: Request) {
  const session = await auth();
  const accessToken = (session as never as { accessToken?: string })?.accessToken;
  if (!accessToken) return NextResponse.json({ error: 'unauth' }, { status: 401 });
  const { conversationId, content } = (await req.json()) as {
    conversationId?: unknown;
    content?: unknown;
  };
  // On valide côté handler avant d'atteindre edge-api : interpoler un
  // `conversationId` non-string dans une variable GraphQL ferait passer
  // un type mismatch côté serveur, mais on préfère échouer tôt avec un
  // 400 lisible.
  if (typeof conversationId !== 'string' || typeof content !== 'string') {
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }
  const data = await gqlClient(accessToken).request(SEND_MESSAGE, {
    conversationId,
    content,
  });
  return NextResponse.json(data);
}

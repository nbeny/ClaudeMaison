import { ChatStream } from '@/components/ChatStream';

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChatStream conversationId={id} ssetokenUrl="/api/chat/sse-token" />;
}

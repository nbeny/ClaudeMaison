'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function ChatNew() {
  const router = useRouter();
  useEffect(() => {
    (async () => {
      const resp = await fetch('/api/chat/start', { method: 'POST' });
      const { conversationId } = await resp.json();
      router.replace(`/chat/${conversationId}`);
    })();
  }, [router]);
  return <main>Création de la conversation…</main>;
}

'use client';
import { useEffect, useRef, useState } from 'react';

interface Message {
  role: string;
  content: string;
}

export interface ChatStreamProps {
  conversationId: string;
  /** JWT exposé via /api/chat/sse-token (route handler qui retourne accessToken) */
  ssetokenUrl: string;
}

export function ChatStream({ conversationId, ssetokenUrl }: ChatStreamProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const currentAssistantRef = useRef<{ index: number; id?: string } | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    (async () => {
      const tokenResp = await fetch(ssetokenUrl);
      const { token } = await tokenResp.json();
      const url = `${process.env.NEXT_PUBLIC_REALTIME_URL}/sse/v1/conversations/${conversationId}/stream?token=${encodeURIComponent(token)}`;
      es = new EventSource(url);
      es.onmessage = (evt) => {
        const payload = JSON.parse(evt.data);
        if (payload.type === 'token') {
          setMessages((prev) => {
            const next = [...prev];
            const cur = currentAssistantRef.current;
            const existing = cur ? next[cur.index] : undefined;
            if (cur && existing) {
              next[cur.index] = { ...existing, content: existing.content + payload.delta };
            } else {
              currentAssistantRef.current = { index: next.length, id: payload.messageId };
              next.push({ role: 'assistant', content: payload.delta });
            }
            return next;
          });
        } else if (payload.type === 'done' || payload.type === 'error') {
          currentAssistantRef.current = null;
        }
      };
    })();
    return () => { es?.close(); };
  }, [conversationId, ssetokenUrl]);

  async function send() {
    if (!input.trim()) return;
    const userMessage = input;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, content: userMessage }),
    });
  }

  return (
    <div>
      <ul>
        {messages.map((m, i) => (
          <li key={i}><strong>{m.role}:</strong> {m.content}</li>
        ))}
      </ul>
      <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
      <button onClick={send}>Envoyer</button>
    </div>
  );
}

import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>ClaudeMaison</h1>
      <p>Walking skeleton — Phase 1.</p>
      <Link href="/chat/new">Démarrer une conversation</Link>
    </main>
  );
}

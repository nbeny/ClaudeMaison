import type { ReactNode } from 'react';

export const metadata = {
  title: 'ClaudeMaison',
  description: 'Assistant IA souverain — Phase 1 walking skeleton',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}

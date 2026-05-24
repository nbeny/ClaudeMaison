import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE (RFC 7636) — generate a verifier and its SHA-256 challenge.
 *
 * Verifier : 43-128 chars, alphabet [A-Z a-z 0-9 - . _ ~]. On utilise
 * 32 bytes aléatoires → 43 chars en base64url, max d'entropie pour le
 * minimum de longueur autorisé.
 */
export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

export function deriveCodeChallenge(verifier: string): string {
  const digest = createHash('sha256').update(verifier).digest();
  return base64UrlEncode(digest);
}

/**
 * State et nonce : 32 bytes aléatoires, non-prédictibles, base64url.
 */
export function generateRandomToken(): string {
  return base64UrlEncode(randomBytes(32));
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

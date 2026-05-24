import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveCodeChallenge, generateCodeVerifier, generateRandomToken } from './pkce';

describe('PKCE helpers', () => {
  it('le verifier fait 43 chars base64url (32 bytes encodés)', () => {
    const v = generateCodeVerifier();
    expect(v).toHaveLength(43);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('deux verifiers consécutifs ne sont jamais égaux (entropie)', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });

  it('le challenge est bien SHA-256(verifier) en base64url, sans padding', () => {
    const verifier = generateCodeVerifier();
    const challenge = deriveCodeChallenge(verifier);

    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    expect(challenge).toBe(expected);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain('=');
  });

  it('generateRandomToken produit 43 chars base64url et n’est pas répétable', () => {
    const a = generateRandomToken();
    const b = generateRandomToken();
    expect(a).toHaveLength(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});

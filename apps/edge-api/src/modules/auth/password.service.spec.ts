import { describe, expect, it } from 'vitest';
import { DUMMY_HASH, PasswordService } from './password.service';

describe('PasswordService', () => {
  const svc = new PasswordService();

  it('hash() produit un encoding Argon2id reconnaissable', async () => {
    const digest = await svc.hash('correct horse battery staple');
    expect(digest.startsWith('$argon2id$')).toBe(true);
  });

  it('verify() valide le bon mot de passe', async () => {
    const digest = await svc.hash('mot-de-passe-correct-123');
    expect(await svc.verify(digest, 'mot-de-passe-correct-123')).toBe(true);
  });

  it('verify() refuse un mot de passe incorrect', async () => {
    const digest = await svc.hash('mot-de-passe-correct-123');
    expect(await svc.verify(digest, 'mauvais-mot-de-passe-123')).toBe(false);
  });

  it('verify() retourne false (sans throw) sur un hash malformé', async () => {
    expect(await svc.verify('not-a-real-hash', 'whatever')).toBe(false);
  });

  it('DUMMY_HASH est calculé au chargement et est un hash Argon2id valide', () => {
    expect(DUMMY_HASH.startsWith('$argon2id$')).toBe(true);
  });
});

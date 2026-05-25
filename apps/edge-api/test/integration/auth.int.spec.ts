import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { buildAuthRig, makeAdminSql, resetDatabase } from './helpers';

// Tests d'intégration auth : on attaque le vrai Postgres pour vérifier que
// les invariants critiques tiennent en bout de chaîne — schéma + repository
// + service. On NE re-teste PAS la logique pure (hash factice, expiration
// JWT, etc.) déjà couverte par les specs unitaires.

describe('auth — intégration', () => {
  const admin = makeAdminSql();
  const { authService, sessions, jwt, db } = buildAuthRig();

  beforeAll(async () => {
    await resetDatabase(admin);
  });
  afterEach(async () => {
    await resetDatabase(admin);
  });
  afterAll(async () => {
    await db.onModuleDestroy();
    await admin.end({ timeout: 5 });
  });

  it('signup crée un user vivant et émet un JWT vérifiable', async () => {
    const issued = await authService.signup({
      email: 'alice@example.test',
      password: 'correct-horse-battery-staple',
    });

    expect(issued.user.email).toBe('alice@example.test');
    expect(issued.user.passwordHash).toBeTruthy();
    expect(issued.refreshToken).toMatch(/^[A-Za-z0-9_-]+$/);

    const claims = await jwt.verifyAccessToken(issued.accessToken);
    expect(claims.sub).toBe(issued.user.id);
    expect(claims.sid).toBe(issued.sessionId);

    // La session existe en base avec un hash binaire (jamais le token clair).
    const session = await sessions.findById(issued.sessionId);
    expect(session).not.toBeNull();
    expect(session!.userId).toBe(issued.user.id);
    expect(session!.revokedAt).toBeNull();
    expect(session!.rotatedTo).toBeNull();
  });

  it('refresh fait tourner la session et casse l’ancien token', async () => {
    const a = await authService.signup({
      email: 'rotate@example.test',
      password: 'correct-horse-battery-staple',
    });

    const b = await authService.refresh(a.refreshToken);
    expect(b.sessionId).not.toBe(a.sessionId);

    const oldSession = await sessions.findById(a.sessionId);
    expect(oldSession!.revokedAt).not.toBeNull();
    expect(oldSession!.rotatedTo).toBe(b.sessionId);

    // Rejouer l'ancien refresh est désormais refusé.
    await expect(authService.refresh(a.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('révoque toute la chaîne quand un refresh déjà tourné est rejoué', async () => {
    const a = await authService.signup({
      email: 'chain@example.test',
      password: 'correct-horse-battery-staple',
    });
    const b = await authService.refresh(a.refreshToken);
    const c = await authService.refresh(b.refreshToken);

    // L'attaquant rejoue le PREMIER refresh (qui a déjà été échangé) :
    // la détection doit révoquer toute la chaîne, y compris la session
    // courante c, qui devient invalide.
    await expect(authService.refresh(a.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    const after = await sessions.findById(c.sessionId);
    expect(after!.revokedAt).not.toBeNull();

    // Et tenter de continuer la chaîne légitime échoue aussi.
    await expect(authService.refresh(c.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

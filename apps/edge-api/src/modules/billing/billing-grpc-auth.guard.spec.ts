import type { Metadata } from '@grpc/grpc-js';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env';
import { BillingGrpcAuthGuard } from './billing-grpc-auth.guard';

// BillingGrpcAuthGuard protège l'endpoint gRPC de réservation/comptage de
// quotas exposé aux autres services internes (ai-core, …). Une régression
// silencieuse — remplacer `timingSafeEqual` par `===`, oublier le length
// pre-check, ou pire : accepter en l'absence de token configuré — laisserait
// n'importe quel caller incrémenter les compteurs d'usage de n'importe quel
// workspace. Ces tests verrouillent :
//   - fail-closed si BILLING_GRPC_TOKEN absent (anti-déploiement-foireux),
//   - rejet propre (401, pas 500) sur header absent / mal formé / mauvaise
//     longueur,
//   - comparaison timing-safe sur des buffers de longueur égale.

const TOKEN = 's3cret-billing-token-must-be-long-enough';

function makeConfig(token: string | undefined): ConfigService<Env, true> {
  return {
    get: vi.fn((key: string) =>
      key === 'BILLING_GRPC_TOKEN' ? token : undefined,
    ),
  } as unknown as ConfigService<Env, true>;
}

function makeCtx(authHeaders: string[] | null | undefined): ExecutionContext {
  // gRPC Metadata.get(key) renvoie un tableau de valeurs (Buffer | string).
  // On stube uniquement la méthode utilisée par le guard.
  const meta = {
    get: vi.fn().mockReturnValue(authHeaders),
  } as unknown as Metadata;
  return {
    switchToRpc: () => ({ getContext: () => meta }),
  } as unknown as ExecutionContext;
}

describe('BillingGrpcAuthGuard.canActivate', () => {
  it('throw 401 si BILLING_GRPC_TOKEN n\'est pas configuré (fail-closed)', () => {
    // CRITIQUE : la valeur par défaut d'un guard non configuré ne doit
    // *jamais* être "j'accepte tout". Si un déploiement oublie le secret
    // (env manquant, secret rotaté à vide), le guard refuse plutôt que
    // d'ouvrir grand l'API quotas en interne.
    const guard = new BillingGrpcAuthGuard(makeConfig(undefined));
    expect(() => guard.canActivate(makeCtx(['Bearer ' + TOKEN]))).toThrow(
      UnauthorizedException,
    );
  });

  it('throw 401 si BILLING_GRPC_TOKEN est une chaîne vide (fail-closed)', () => {
    // Empty string est "falsy" — le constructor doit le traiter comme
    // "non configuré", pas comme "le token attendu est """ (sinon tout
    // appel avec `Bearer ` passerait).
    const guard = new BillingGrpcAuthGuard(makeConfig(''));
    expect(() => guard.canActivate(makeCtx(['Bearer anything']))).toThrow(
      UnauthorizedException,
    );
  });

  it('throw 401 si metadata.get(authorization) renvoie undefined', () => {
    const guard = new BillingGrpcAuthGuard(makeConfig(TOKEN));
    expect(() => guard.canActivate(makeCtx(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('throw 401 si metadata.get(authorization) renvoie un tableau vide', () => {
    // Métadonnée présente mais sans valeur : doit échouer comme "absente",
    // pas crasher en accédant à headers[0]!.
    const guard = new BillingGrpcAuthGuard(makeConfig(TOKEN));
    expect(() => guard.canActivate(makeCtx([]))).toThrow(UnauthorizedException);
  });

  it('throw 401 si le header ne commence pas par "Bearer "', () => {
    // Anti-format-incorrect : un caller qui envoie juste le token cru
    // (sans préfixe) doit être rejeté pour qu'on garde un format unique
    // côté logs / audit.
    const guard = new BillingGrpcAuthGuard(makeConfig(TOKEN));
    expect(() => guard.canActivate(makeCtx([TOKEN]))).toThrow(
      UnauthorizedException,
    );
  });

  it('throw 401 si le préfixe est en mauvaise casse ("bearer ")', () => {
    // RFC 6750 §2.1 dit que le scheme est insensible à la casse, mais
    // notre garde fait un startsWith strict — on lock-in ce contrat
    // (changement → tests cassent → décision consciente requise).
    const guard = new BillingGrpcAuthGuard(makeConfig(TOKEN));
    expect(() => guard.canActivate(makeCtx(['bearer ' + TOKEN]))).toThrow(
      UnauthorizedException,
    );
  });

  it('throw 401 (pas 500) si le token présenté est plus court (length pre-check)', () => {
    // Sans le pre-check de longueur, timingSafeEqual lèverait une
    // RangeError ("Input buffers must have the same byte length") et
    // ce serait remonté en 500 — pratique pour un attaquant qui veut
    // distinguer "longueur ≠" de "valeur ≠".
    const guard = new BillingGrpcAuthGuard(makeConfig(TOKEN));
    expect(() =>
      guard.canActivate(makeCtx(['Bearer ' + TOKEN.slice(0, -1)])),
    ).toThrow(UnauthorizedException);
  });

  it('throw 401 (pas 500) si le token présenté est plus long', () => {
    const guard = new BillingGrpcAuthGuard(makeConfig(TOKEN));
    expect(() =>
      guard.canActivate(makeCtx(['Bearer ' + TOKEN + 'x'])),
    ).toThrow(UnauthorizedException);
  });

  it('throw 401 si bonne longueur mais mauvaise valeur', () => {
    const guard = new BillingGrpcAuthGuard(makeConfig(TOKEN));
    const wrong = 'y'.repeat(TOKEN.length);
    expect(() => guard.canActivate(makeCtx(['Bearer ' + wrong]))).toThrow(
      UnauthorizedException,
    );
  });

  it('retourne true sur match exact', () => {
    const guard = new BillingGrpcAuthGuard(makeConfig(TOKEN));
    expect(guard.canActivate(makeCtx(['Bearer ' + TOKEN]))).toBe(true);
  });

  it('trim les espaces autour du token (tolérance copy-paste)', () => {
    // Le guard fait .trim() après slice — on lock-in ce comportement.
    // Utile en pratique quand un opérateur copie un secret avec un \n
    // résiduel depuis un secret manager.
    const guard = new BillingGrpcAuthGuard(makeConfig(TOKEN));
    expect(guard.canActivate(makeCtx(['Bearer  ' + TOKEN + '  ']))).toBe(true);
  });

  it('lit BILLING_GRPC_TOKEN via ConfigService au boot', () => {
    const config = makeConfig(TOKEN);
    new BillingGrpcAuthGuard(config);
    expect(config.get).toHaveBeenCalledWith('BILLING_GRPC_TOKEN', {
      infer: true,
    });
  });
});

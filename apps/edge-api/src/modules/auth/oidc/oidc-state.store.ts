import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../redis/redis.service';

/**
 * Données stockées entre /login et /callback. Le state token (clé Redis)
 * est aussi renvoyé au browser via le query string OIDC, ce qui ferme la
 * boucle CSRF : seul un callback portant le bon state retrouve les valeurs.
 */
export interface OidcStateData {
  /** Code verifier PKCE, à renvoyer au token endpoint */
  codeVerifier: string;
  /** Nonce à vérifier dans l'ID token */
  nonce: string;
  /** Où rediriger le browser après login (optionnel) */
  returnTo?: string;
  /** Quand le state a été émis (debug / forensics) */
  createdAt: number;
}

const KEY_PREFIX = 'oidc:state:';
/** 10 minutes : un user qui n'a pas validé son login d'ici là doit recommencer. */
const TTL_SECONDS = 600;

@Injectable()
export class OidcStateStore {
  constructor(private readonly redis: RedisService) {}

  async put(state: string, data: OidcStateData): Promise<void> {
    const key = KEY_PREFIX + state;
    const payload = JSON.stringify(data);
    // SET avec NX pour empêcher tout réenregistrement accidentel sur le même
    // state (collision improbable mais l'écraser silencieusement masquerait
    // un bug). EX impose le TTL atomiquement.
    const result = await this.redis.client.set(key, payload, 'EX', TTL_SECONDS, 'NX');
    if (result !== 'OK') {
      throw new Error('Collision OIDC state détectée — réessayer.');
    }
  }

  /**
   * Consommation one-shot : récupère et supprime atomiquement. Cela évite
   * le replay d'un même state→data sur deux callbacks.
   */
  async consume(state: string): Promise<OidcStateData | null> {
    const key = KEY_PREFIX + state;
    // GETDEL est atomique (Redis 6.2+).
    const raw = await this.redis.client.getdel(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OidcStateData;
    } catch {
      return null;
    }
  }
}

import { Query, Resolver } from '@nestjs/graphql';
import { Viewer } from './models/viewer.model';

@Resolver(() => Viewer)
export class AuthResolver {
  // Placeholder Jour-1 : retourne toujours null tant que l'auth n'est pas câblée.
  // Cf. spec §10 — l'implémentation arrive au commit suivant.
  @Query(() => Viewer, { nullable: true })
  viewer(): Viewer | null {
    return null;
  }
}

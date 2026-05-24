import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { SystemResolver } from './system.resolver';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      sortSchema: true,
      playground: false,
      introspection: true,
      // `req`/`reply` exposés dans le contexte pour que les guards et
      // resolvers puissent lire les headers (Bearer JWT), l'IP, le user-agent.
      context: ({ req, reply }: { req: unknown; reply: unknown }) => ({ req, reply }),
      plugins:
        process.env.NODE_ENV !== 'production'
          ? [ApolloServerPluginLandingPageLocalDefault({ embed: true })]
          : [],
    }),
  ],
  providers: [SystemResolver],
})
export class GatewayModule {}

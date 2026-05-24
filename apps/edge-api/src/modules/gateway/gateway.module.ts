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
      plugins:
        process.env.NODE_ENV !== 'production'
          ? [ApolloServerPluginLandingPageLocalDefault({ embed: true })]
          : [],
    }),
  ],
  providers: [SystemResolver],
})
export class GatewayModule {}

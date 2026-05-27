import { GraphQLClient } from 'graphql-request';

export function gqlClient(accessToken: string): GraphQLClient {
  const url = process.env.NEXT_PUBLIC_GRAPHQL_URL ?? 'http://localhost:3000/graphql';
  return new GraphQLClient(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

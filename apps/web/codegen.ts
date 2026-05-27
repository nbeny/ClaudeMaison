import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: process.env.GRAPHQL_SCHEMA_URL ?? 'http://localhost:3000/graphql',
  documents: ['src/**/*.graphql'],
  generates: {
    './src/gql/generated.ts': {
      plugins: ['typescript', 'typescript-operations', 'typescript-graphql-request'],
    },
  },
};
export default config;

# syntax=docker/dockerfile:1.7
# Build du binaire edge-api dans un contexte monorepo pnpm.
# Construit depuis la racine du dépôt :
#   docker build -f apps/edge-api/Dockerfile -t edge-api:dev .

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# ---------- deps : installe les dépendances avec cache pnpm ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/edge-api/package.json apps/edge-api/
# Quand des packages partagés existeront, les copier ici aussi.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- build : compile TS -> JS ----------
FROM deps AS build
COPY apps/edge-api apps/edge-api
RUN pnpm --filter edge-api build
RUN pnpm --filter edge-api deploy --prod /pruned

# ---------- runtime : image finale minimale ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /pruned/dist ./dist
COPY --from=build /pruned/node_modules ./node_modules
COPY --from=build /pruned/package.json ./
# main.ts résout les .proto via join(__dirname, '..', 'proto', ...)
COPY --from=build /repo/apps/edge-api/proto ./proto
EXPOSE 3000
EXPOSE 5001
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

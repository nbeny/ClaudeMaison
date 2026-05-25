# syntax=docker/dockerfile:1.7
# Construit depuis la racine du dépôt :
#   docker build -f apps/realtime/Dockerfile -t realtime:dev .

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/realtime/package.json apps/realtime/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/realtime apps/realtime
RUN pnpm --filter realtime build
RUN pnpm --filter realtime deploy --prod /pruned

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /pruned/dist ./dist
COPY --from=build /pruned/node_modules ./node_modules
COPY --from=build /pruned/package.json ./
EXPOSE 3100
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

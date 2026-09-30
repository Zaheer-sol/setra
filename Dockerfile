# One image definition, three targets: api, worker, web.
#   docker build --target api    -t setra-api .
#   docker build --target worker -t setra-worker .
#   docker build --target web    -t setra-web .
# The last stage (the default when no target is given, as on Railway) holds all three and starts the
# one named by SETRA_ROLE.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
# Manifests only, so this layer (and npm ci) is cached until dependencies change.
COPY packages/blockchain/package.json packages/blockchain/
COPY packages/config/package.json packages/config/
COPY packages/contracts-client/package.json packages/contracts-client/
COPY packages/database/package.json packages/database/
COPY packages/devchain/package.json packages/devchain/
COPY packages/engine/package.json packages/engine/
COPY packages/events/package.json packages/events/
COPY packages/matching/package.json packages/matching/
COPY packages/schemas/package.json packages/schemas/
COPY packages/sdk/package.json packages/sdk/
COPY packages/security/package.json packages/security/
RUN npm ci --ignore-scripts

FROM deps AS build
COPY . .
RUN node scripts/build-service.mjs apps/api/src/main.ts apps/api/dist/main.js \
 && node scripts/build-service.mjs apps/worker/src/main.ts apps/worker/dist/main.js \
 && node scripts/build-service.mjs packages/database/src/migrate.ts packages/database/dist/migrate.js \
 && node scripts/build-service.mjs packages/database/src/seed.ts packages/database/dist/seed.js \
 && node scripts/build-service.mjs packages/database/src/seed-books.ts packages/database/dist/seed-books.js
RUN npm run build -w @setra/web

FROM node:22-bookworm-slim AS runtime-base
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --system --uid 1001 setra
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

FROM runtime-base AS api
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/packages/database/dist/migrate.js ./dist/migrate.js
COPY --from=build /app/packages/database/migrations ./migrations
USER setra
EXPOSE 4000
CMD ["node", "dist/main.js"]

FROM runtime-base AS worker
COPY --from=build /app/apps/worker/dist ./dist
USER setra
CMD ["node", "dist/main.js"]

FROM runtime-base AS web
WORKDIR /app/apps/web
COPY --from=build /app/apps/web/.next ./.next
COPY --from=build /app/apps/web/public ./public
COPY --from=build /app/apps/web/package.json ./package.json
COPY --from=build /app/apps/web/next.config.ts ./next.config.ts
COPY --from=build /app/packages/schemas /app/packages/schemas
USER setra
EXPOSE 3000
CMD ["node", "/app/node_modules/next/dist/bin/next", "start", "--port", "3000"]

# Default target: every service in one image, for hosts that build without choosing a target
# (Railway). SETRA_ROLE=api|worker|web picks what starts; the API runs migrations first.
FROM runtime-base AS all
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=build /app/packages/database/migrations ./packages/database/migrations
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/next.config.ts ./apps/web/next.config.ts
COPY --from=build /app/packages/schemas ./packages/schemas
COPY deploy/railway ./deploy/railway
USER setra
CMD ["sh", "deploy/railway/start.sh"]

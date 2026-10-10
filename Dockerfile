# Image de production Cadence. Node 24 (LTS) : Node 20 est en fin de support et supabase-js annonce son abandon.
# Version déployée identifiable : docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) …
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 BUILD_STANDALONE=1
RUN npm run build

FROM node:24-alpine AS run
WORKDIR /app
ARG GIT_COMMIT=inconnu
# Empreinte du CONTEXTE de construction (sources livrées, y compris les modifications non commitées) : le commit seul
# n'identifie pas une image construite à partir d'un arbre modifié.
ARG CONTEXT_SHA256=inconnue
LABEL org.opencontainers.image.revision=$GIT_COMMIT cadence.context.sha256=$CONTEXT_SHA256
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 CADENCE_VERSION=$GIT_COMMIT CADENCE_CONTEXT=$CONTEXT_SHA256
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
# Santé (liveness) : le processus répond, sans appeler Supabase ni Buffer. La PRÉPARATION au service (configuration,
# migrations requises, base joignable) est un autre contrôle, protégé par secret : GET /api/ready (scripts/preflight.mjs).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]

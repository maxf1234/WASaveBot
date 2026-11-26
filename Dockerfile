# One image for the whole product: the dashboard is built here and served by
# the worker, so there is a single Railway service, a single URL, and no second
# host to keep in step with the first.
#
# Built from the repository root (Railway: leave Root Directory empty) because
# it needs both web/ and worker/.

FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# No VITE_ variables: the site reads its Supabase settings from the worker's
# /config.js when it loads, so this build is the same for every deployment.
RUN npm run build

FROM node:22-slim AS worker
WORKDIR /worker
COPY worker/package.json worker/package-lock.json ./
RUN npm ci
COPY worker/tsconfig.json worker/tsconfig.build.json ./
COPY worker/src ./src
RUN npm run build

FROM node:22-slim
# ca-certificates: outbound TLS to WhatsApp, Supabase and Stripe.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV WEB_ROOT=/app/web
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=worker /worker/dist ./dist
COPY --from=web /web/dist ./web
CMD ["node", "dist/index.js"]

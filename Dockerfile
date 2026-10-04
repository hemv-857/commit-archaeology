# ---- deps ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# GITHUB_API_BASE is overridden at runtime; a dummy value keeps the build hermetic.
RUN npm run build

# ---- run (web) ----
FROM node:22-alpine AS run
WORKDIR /app
RUN apk add --no-cache git curl && addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/app/.data
# Standalone output + static assets + public dir
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
RUN mkdir -p /app/.data && chown -R app:app /app
USER app
EXPOSE 3000
# Must follow $PORT, not a hardcoded 3000: Render, Fly and most PaaS inject
# their own PORT, so a fixed port here kills the container with exit 1 on the
# first health probe and the deploy fails.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1
CMD ["node", "server.js"]

# ---- run (dedicated scan worker; docker compose --profile scale) ----
FROM node:22-alpine AS worker
WORKDIR /app
RUN apk add --no-cache git && addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DATA_DIR=/app/.data
COPY --from=deps /app/node_modules ./node_modules
# package.json is required: the CMD below resolves the `worker` script via npm.
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
# The worker runs src only — drop the web build's devDependencies from the image.
RUN npm prune --omit=dev \
 && mkdir -p /app/.data && chown -R app:app /app
USER app
CMD ["npm", "run", "worker"]

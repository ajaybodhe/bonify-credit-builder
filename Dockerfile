# Multi-stage: the runtime image carries no compiler and no dev dependencies.
ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Run unprivileged; the node image ships a `node` user for exactly this.
USER node
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node drizzle ./drizzle
EXPOSE 3000
# The container orchestrator, not the app, decides when to restart.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "./dist/telemetry/register.js", "dist/index.js"]

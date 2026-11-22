# Stage 1 — build:
FROM node:20-alpine AS build

WORKDIR /app

# Copy package manifests and vendored contracts
COPY package*.json ./
COPY vendor/ ./vendor/

# Install all dependencies
RUN npm ci

# Copy tsconfig and sources
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript
RUN npm run build

# Stage 2 — runtime:
FROM node:20-alpine

# Non-root user (uid 1001)
RUN addgroup -g 1001 -S nebron && \
    adduser -u 1001 -S nebron -G nebron

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4004

# Copy package manifests and vendored contracts for production pruning
COPY --chown=nebron:nebron package*.json ./
COPY --chown=nebron:nebron vendor/ ./vendor/
COPY --chown=nebron:nebron --from=build /app/node_modules ./node_modules
RUN npm prune --omit=dev && rm -rf vendor

# Copy compiled artifacts
COPY --chown=nebron:nebron --from=build /app/dist ./dist

USER nebron

EXPOSE 4004

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:4004/health || exit 1

CMD ["node", "dist/server.js"]

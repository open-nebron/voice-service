# Multi-stage Dockerfile for Zenuxs voice-service

# Stage 1: Build TypeScript source
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json tsconfig.json ./

# Install all dependencies
RUN npm install

# Copy source code
COPY src/ ./src/

# Compile TypeScript
RUN npm run build

# Stage for dev mode target
FROM builder AS build

# Stage 2: Production runner
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4004

# Copy package manifests and install only production dependencies
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy compiled files from builder
COPY --from=builder /app/dist ./dist

# Use non-root node user
USER node

EXPOSE 4004

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:4004/health || exit 1

CMD ["node", "dist/index.js"]

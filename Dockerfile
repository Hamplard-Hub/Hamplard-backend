# ============================================================
# Stage 1: Build
# ============================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Install native dependencies required for build and Prisma engine
RUN apk add --no-cache openssl libc6-compat

# Copy dependency manifests
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Generate Prisma Client
RUN npx prisma generate

# Copy source files and configuration
COPY tsconfig*.json nest-cli.json ./
COPY src ./src

# Compile NestJS TypeScript application
RUN npm run build

# Remove development dependencies
RUN npm prune --omit=dev

# ============================================================
# Stage 2: Slim Runtime with ffmpeg and pg_dump
# ============================================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Install slim runtime tools: ffmpeg, postgresql-client (provides pg_dump), openssl & libc6-compat for Prisma
RUN apk add --no-cache \
    ffmpeg \
    postgresql-client \
    openssl \
    libc6-compat \
    bash

# Copy node_modules and compiled output from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Ensure uploads directory exists and permissions are set
RUN mkdir -p /app/uploads && chown -R node:node /app

USER node

EXPOSE 3000

# Apply database migrations on container start, then run the API server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]

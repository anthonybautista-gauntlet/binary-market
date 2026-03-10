# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer-cached separately from source)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Use UTC for consistent log timestamps regardless of host timezone
ENV TZ=UTC
ENV NODE_ENV=production

WORKDIR /app

# Create a non-root user for security
RUN addgroup -S meridian && adduser -S meridian -G meridian

# Copy only what is needed to run
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Drop to non-root user
USER meridian

CMD ["node", "dist/index.js"]

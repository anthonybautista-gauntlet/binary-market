# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source and compile
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine

# Set timezone so date logic is predictable (jobs use IANA tz internally,
# but this prevents surprises with system-level date calls)
ENV TZ=UTC
ENV NODE_ENV=production

WORKDIR /app

# Copy only what's needed to run
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Non-root user for security
RUN addgroup -S meridian && adduser -S meridian -G meridian
USER meridian

# Health: process exits if startup fails, Railway will restart it
CMD ["node", "dist/index.js"]

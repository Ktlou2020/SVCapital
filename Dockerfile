# ── Stage 1: Build ──────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app/server

# Install server dependencies
COPY server/package*.json ./
RUN npm install --production --no-audit --no-fund

# ── Stage 2: Production ──────────────────────────────
FROM node:20-alpine AS production

# Set working directory to /app (project root)
WORKDIR /app

# Copy frontend static files
COPY assets/    ./assets/
COPY css/       ./css/
COPY js/        ./js/
COPY portal/    ./portal/
COPY admin/     ./admin/
COPY ifa/       ./ifa/
COPY fund/      ./fund/
COPY team/      ./team/
COPY _data/     ./_data/
COPY index.html ./
COPY login.html ./
COPY signup.html ./
COPY test.html  ./
COPY manifest.json ./

# Copy server (with node_modules from build stage)
COPY server/    ./server/
COPY --from=build /app/server/node_modules ./server/node_modules

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser  -S nodejs -u 1001
USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server/index.js"]

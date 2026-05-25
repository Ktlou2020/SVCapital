# ── Stage 1: Build ──────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app/server

# Install server dependencies
COPY server/package*.json ./
RUN npm install --production --no-audit --no-fund

# ── Stage 2: Production ──────────────────────────────
FROM node:20-alpine AS production

# Set NODE_ENV so SSL is enabled and production optimisations apply
ENV NODE_ENV=production

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

# Railway injects PORT at runtime (typically 8080).
# EXPOSE is documentation only — use the $PORT env var.
# Do NOT add a Docker HEALTHCHECK here: Railway uses healthcheckPath
# from railway.toml and knows the correct port. A hardcoded Docker
# HEALTHCHECK against port 3000 would fail and kill the container.
EXPOSE 8080

CMD ["node", "server/index.js"]

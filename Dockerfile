# syntax=docker/dockerfile:1
#
# Cloudflare Pages MCP server — remote HTTP + OAuth 2.1 image.

# --- Stage 1: install full dependencies (incl. dev) ------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- Stage 2: compile TypeScript -------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Stage 3: production dependencies only ---------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Stage 4: minimal runtime image ----------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/perzeuss/cloudflare-pages-mcp" \
      org.opencontainers.image.description="Remote MCP server (HTTP + OAuth 2.1) for Cloudflare Pages, usable as a Claude custom connector." \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    PORT=3000

# tini gives us proper PID 1 signal handling (clean shutdowns).
RUN apk add --no-cache tini

# Run as the unprivileged "node" user that ships with the base image.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

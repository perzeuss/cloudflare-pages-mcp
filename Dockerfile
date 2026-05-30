# syntax=docker/dockerfile:1

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
      org.opencontainers.image.description="MCP server that deploys static sites to Cloudflare Pages via the Direct Upload API." \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production

# tini gives us proper PID 1 signal handling so SIGINT/SIGTERM reach Node for a
# graceful shutdown.
RUN apk add --no-cache tini

# Run as the unprivileged "node" user that ships with the base image.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node

# This is a stdio MCP server: it speaks JSON-RPC over stdin/stdout and does not
# listen on any port, so there is no EXPOSE/HEALTHCHECK.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

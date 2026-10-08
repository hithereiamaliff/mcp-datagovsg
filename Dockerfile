# Singapore Open Data MCP Server - Streamable HTTP
# Self-hosted on the VPS behind nginx at https://mcp.techmavie.digital/datagovsg/mcp

# ---- Build stage ----
FROM node:24-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

# ---- Runtime stage ----
FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Non-root user; /app/data holds analytics + the catalogue index (Docker volume)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S mcp -u 1001 -G nodejs && \
    mkdir -p /app/data && chown -R mcp:nodejs /app/data
USER mcp

EXPOSE 8080

# busybox wget is available in alpine images
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "dist/http-server.js"]

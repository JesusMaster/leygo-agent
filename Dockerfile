# ── Yisus Agent (backend) ────────────────────────────────────────────────────
# Etapa 1: compilar TypeScript
FROM node:22-bookworm-slim AS build
# Toolchain para módulos nativos (better-sqlite3 llega como peer opcional de @google/adk).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_OPTIONS=--max-old-space-size=2048
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# Compila y deja node_modules solo con producción (ya compilado: el runtime no necesita toolchain).
RUN npm run build && npm prune --omit=dev && npm cache clean --force

# Etapa 2: runtime (solo dependencias de producción)
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node config ./config
# data/ (SQLite, agentes, adjuntos, catálogo de precios) es un volumen: ver docker-compose.yml
RUN mkdir -p /app/data && chown node:node /app /app/data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

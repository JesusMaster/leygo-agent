# ── Yisus GUI (Angular) ──────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
# Heap explícito: en contenedores V8 se autolimita a ~1 GB y el build de Angular puede superarlo.
ENV NODE_OPTIONS=--max-old-space-size=2048
WORKDIR /gui
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx ng build --configuration production

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /gui/dist/yisus-gui/browser /usr/share/nginx/html
EXPOSE 80

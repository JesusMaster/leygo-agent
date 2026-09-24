# ── Yisus GUI (Angular) ──────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /gui
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx ng build --configuration production

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /gui/dist/yisus-gui/browser /usr/share/nginx/html
EXPOSE 80

#!/usr/bin/env bash
# Despliega o actualiza: trae el código, reconstruye las imágenes y reinicia sin perder datos.
# Uso:  ./deploy/deploy.sh            (desde la raíz del repo, en el servidor)
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Falta .env (copia .env.example y complétalo)"; exit 1; }
grep -q '^DOMAIN=' .env || { echo "Falta DOMAIN=<tu dominio> en .env (lo usa Caddy para el certificado TLS)"; exit 1; }

git pull --ff-only
mkdir -p data
docker compose build --pull
docker compose up -d --remove-orphans
docker image prune -f >/dev/null

echo
docker compose ps
echo
echo "Logs:  docker compose logs -f agent"

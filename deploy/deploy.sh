#!/usr/bin/env bash
# Despliega o actualiza: trae el código, reconstruye las imágenes y reinicia sin perder datos.
# Uso:  ./deploy/deploy.sh            (desde la raíz del repo, en el servidor)
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Falta .env (copia .env.example y complétalo)"; exit 1; }
grep -q '^DOMAIN=' .env || { echo "Falta DOMAIN=<tu dominio> en .env (lo usa Caddy para el certificado TLS)"; exit 1; }

# docker compose interpola `$VAR` dentro de .env: un valor con `$` sin comillas simples (p. ej. el hash
# scrypt$…$… de GUI_PASSWORD_HASH) llegaría recortado al contenedor. Se exige VAR='valor'.
malos=$(grep -nE "^[A-Za-z_][A-Za-z0-9_]*=[^'#].*\\$" .env || true)
if [ -n "$malos" ]; then
  echo "Estas líneas de .env contienen \$ y deben ir entre comillas simples (VAR='valor'):"
  echo "$malos" | cut -d= -f1
  exit 1
fi

git pull --ff-only
mkdir -p data
docker compose build --pull
docker compose up -d --remove-orphans
docker image prune -f >/dev/null

echo
docker compose ps
echo
echo "Logs:  docker compose logs -f agent"

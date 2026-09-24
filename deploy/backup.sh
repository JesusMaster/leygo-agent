#!/usr/bin/env bash
# Respaldo diario de data/ (SQLite consistente + agentes) a un tar con fecha.
# Cron sugerido (usuario yisus):  15 3 * * * /home/yisus/yisus-agent/deploy/backup.sh >> /home/yisus/backup.log 2>&1
# Súbelo a DigitalOcean Spaces con s3cmd/rclone si quieres copia fuera del Droplet.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=${BACKUP_DIR:-$HOME/backups}
mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M)
TMP=$(mktemp -d)

# Copia consistente de SQLite aunque el servicio esté escribiendo (usa el backup API de sqlite vía node)
docker compose exec -T agent node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/app/data/reminders.db');
  db.exec(\"VACUUM INTO '/app/data/.backup.db'\");
" && mv data/.backup.db "$TMP/reminders.db"
cp -r data/agents "$TMP/agents" 2>/dev/null || true
cp .env "$TMP/.env"
tar -czf "$DEST/yisus-$STAMP.tar.gz" -C "$TMP" .
rm -rf "$TMP"
# Conserva 14 días
find "$DEST" -name 'yisus-*.tar.gz' -mtime +14 -delete
echo "Respaldo: $DEST/yisus-$STAMP.tar.gz"

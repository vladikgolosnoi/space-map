#!/bin/sh
set -eu
cd "$(dirname "$0")"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p backups
docker compose exec -T app python - "$stamp" <<'PY'
import sqlite3
import sys
source = sqlite3.connect('/data/space.db')
target = sqlite3.connect(f'/data/space-{sys.argv[1]}.db')
with target:
    source.backup(target)
target.close()
source.close()
PY
mv "data/space-$stamp.db" "backups/space-$stamp.db"
if [ -d data/media ]; then
  tar -czf "backups/media-$stamp.tar.gz" -C data media
else
  tar -czf "backups/media-$stamp.tar.gz" --files-from /dev/null
fi
find backups -type f -mtime +7 -delete
printf 'Backup created: %s\n' "$stamp"

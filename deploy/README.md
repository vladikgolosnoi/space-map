# Публичное размещение

Production работает в двух контейнерах: один процесс FastAPI и Caddy для HTTPS. SQLite и медиа находятся в `deploy/data`, TLS-состояние — в Docker volume. Приложение не запускается от root; контейнер read-only, кроме `/data` и временного `/tmp`.

1. Указать A-записи корня и `www` на IP сервера. Удалить конфликтующие A/AAAA/CNAME. Для `www` допустим CNAME на корневой домен.
2. Скопировать `.env.example` в `.env`, задать домен, IP и длинный случайный пароль организатора. `.env` не коммитится.
3. `docker compose up -d --build`, затем `docker compose ps` и `docker compose logs --tail=100`.
4. Проверить `https://DOMAIN/api/health`, `/map/demo`, вход организатора, публикацию и скачивание офлайн-копии.
5. Резервная копия: `sh backup.sh`. Скрипт использует SQLite backup API, архивирует media и хранит семь дней. На сервере `space-map-backup.timer` запускает её ежедневно около 03:20 UTC и выполняет пропущенный запуск после выключения.
6. Периодически выполнить restore-check на конкретной паре файлов, не затрагивая production data: `python3 ../scripts/verify_backup.py backups/space-<UTC timestamp>.db backups/media-<UTC timestamp>.tar.gz`. Скрипт восстанавливает копии во временную директорию, проверяет SQLite integrity/schema и безопасно извлекает архив. Он не подменяет production-базу и удаляет временную копию после завершения.

Для сшивки нужен один worker приложения. Caddy повторяет получение сертификата автоматически после распространения DNS. До этого просмотр доступен через `http://SERVER_IP/map/demo`; авторизованный режим лучше использовать только после появления HTTPS.

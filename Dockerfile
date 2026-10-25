FROM node:22-alpine AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts vite.offline.config.ts ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM python:3.12-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SPACE_DB_PATH=/data/space.db \
    MALLOC_ARENA_MAX=2
RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home /app --shell /usr/sbin/nologin space-map
WORKDIR /app
COPY backend/requirements.lock.txt /app/backend/requirements.lock.txt
RUN python -m pip install -r /app/backend/requirements.lock.txt
COPY backend /app/backend
COPY --from=frontend /build/dist /app/dist
RUN mkdir -p /data /app/backend/data && chown -R space-map:space-map /data /app/backend/data
USER space-map
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]

"""Self-contained, read-only export of one published snapshot."""
import base64
import html
import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException, Response

from .storage import Storage

MAX_EXPORT_BYTES = 96 * 1024 * 1024


def export_html(storage: Storage, bundle_dir: Path) -> Response:
    scripts, styles = bundle_dir / 'app.js', bundle_dir / 'app.css'
    if not scripts.is_file() or not styles.is_file():
        raise HTTPException(503, 'Офлайн-сборка не готова. Организатору нужно выполнить npm run build и повторить скачивание.')
    project = storage.get_published()
    ids = {p.assetId for p in project.panoramas} | {p.thumbnailId for p in project.panoramas}
    ids.update(f.backgroundAssetId for f in project.floors if f.backgroundAssetId)
    paths = {}
    size = scripts.stat().st_size + styles.stat().st_size + len(project.model_dump_json().encode('utf-8')) + 4096
    for asset_id in sorted(ids):
        asset = storage.get_asset(asset_id)
        path = storage.path.parent / 'media' / asset[0] if asset else None
        if path is None or not path.is_file():
            raise HTTPException(409, 'Изображение опубликованной карты отсутствует. Организатору нужно восстановить его и опубликовать карту заново.')
        size += 4 * ((path.stat().st_size + 2) // 3) + 128
        if size > MAX_EXPORT_BYTES:
            raise HTTPException(413, 'Офлайн-копия превышает 96 МБ. Уменьшите изображения или число панорам и повторите публикацию.')
        paths[asset_id] = path
    payload = json.dumps({
        'project': project.model_dump(),
        'createdAt': datetime.now(timezone.utc).isoformat(),
        'assets': {key: 'data:image/jpeg;base64,' + base64.b64encode(path.read_bytes()).decode('ascii') for key, path in paths.items()},
    }, ensure_ascii=False).replace('<', '\\u003c').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    # The bundle is trusted local build output; escape HTML raw-text terminators.
    script = scripts.read_text(encoding='utf-8').replace('</script', '<\\/script')
    css = styles.read_text(encoding='utf-8').replace('</style', '<\\/style')
    document = ('<!doctype html><html lang="ru"><head><meta charset="UTF-8">'
                '<meta name="viewport" content="width=device-width,initial-scale=1">'
                f'<title>{html.escape(project.title)} — офлайн</title><style>{css}</style></head>'
                f'<body><div id="root"></div><script>window.__SPACE_OFFLINE__={payload};</script>'
                f'<script>{script}</script></body></html>')
    content = document.encode('utf-8')
    if len(content) > MAX_EXPORT_BYTES:
        raise HTTPException(413, 'Офлайн-копия превышает 96 МБ. Уменьшите опубликованные изображения.')
    return Response(content, media_type='text/html', headers={
        'Content-Disposition': f'attachment; filename="space-map-v{project.revision}.html"',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    })

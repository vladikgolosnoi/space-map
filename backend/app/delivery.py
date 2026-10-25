"""Compress text responses; only content-addressed build assets are immutable."""
import re

from starlette.middleware.gzip import GZipMiddleware
from starlette.staticfiles import StaticFiles


class TextCompression:
    def __init__(self, app):
        self.app = app
        self.compressed = GZipMiddleware(app, minimum_size=1000, compresslevel=5)

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        text = (path.startswith('/assets/') and path.endswith(('.js', '.css'))) or path == '/api/projects/demo'
        handler = self.compressed if scope['type'] == 'http' and text else self.app
        await handler(scope, receive, send)


class BuildFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        path = path.replace('\\', '/')
        if path.startswith('assets/') and re.search(r'-[A-Za-z0-9_-]{8}\.(js|css)$', path) and response.status_code in (200, 304):
            response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        else:
            response.headers['Cache-Control'] = 'no-cache'
        return response

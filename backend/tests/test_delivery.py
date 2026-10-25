from fastapi.testclient import TestClient
from backend.app.main import create_app
from backend.app.delivery import BuildFiles, TextCompression
from starlette.applications import Starlette
from starlette.routing import Mount


def test_text_compression_and_publication_remains_uncached(tmp_path):
    with TestClient(create_app(tmp_path / 'space.db', 'test-password')) as client:
        response = client.get('/api/projects/demo', headers={'Accept-Encoding': 'gzip'})
        assert response.status_code == 200
        assert response.headers['content-encoding'] == 'gzip'
        assert response.headers['cache-control'] == 'no-store'
        assert 'Accept-Encoding' in response.headers['vary']
        assert response.json()['id'] == 'demo'
        raw = client.get('/api/projects/demo', headers={'Accept-Encoding': 'identity'})
        assert 'content-encoding' not in raw.headers
        assert response.json() == raw.json()


def test_immutable_only_for_hashed_build_files(tmp_path):
    (tmp_path / 'assets').mkdir()
    (tmp_path / 'assets' / 'index-1234abcd.js').write_text('const x = 1;\n' * 1000)
    (tmp_path / 'app.js').write_text('const x = 1;')
    (tmp_path / 'assets' / 'photo-1234abcd.jpg').write_bytes(b'jpeg fixture' * 1000)
    app = Starlette(routes=[Mount('/', BuildFiles(directory=tmp_path))])
    app.add_middleware(TextCompression)
    with TestClient(app) as client:
        response = client.get('/assets/index-1234abcd.js')
        assert response.headers['content-encoding'] == 'gzip'
        assert response.headers['cache-control'] == 'public, max-age=31536000, immutable'
        assert int(response.headers['content-length']) < 1000
        assert client.get('/app.js').headers['cache-control'] == 'no-cache'
        photo = client.get('/assets/photo-1234abcd.jpg')
        assert 'content-encoding' not in photo.headers
        assert photo.headers['cache-control'] == 'no-cache'
        assert client.get('/assets/missing-1234abcd.js').status_code == 404

import io
import json
import re

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from backend.app.main import create_app
from backend.app.offline import export_html


def test_export_contains_published_snapshot_only_and_escapes_html(tmp_path):
    app = create_app(tmp_path / 'space.db', 'test-password')
    bundle = tmp_path / 'bundle'; bundle.mkdir()
    (bundle / 'app.js').write_text('window.bundleLoaded=true;', encoding='utf-8')
    (bundle / 'app.css').write_text('body{color:black}', encoding='utf-8')
    with TestClient(app) as client:
        client.post('/api/session', json={'password': 'test-password'})
        project = client.get('/api/projects/demo').json()
        image = io.BytesIO(); Image.new('RGB', (400, 300), 'white').save(image, 'PNG')
        asset = client.post('/api/plan-import', files={'file': ('plan.png', image.getvalue(), 'image/png')}).json()['assetId']
        project['title'] = '</script><script>alert(1)</script>'
        project['floors'][0]['backgroundAssetId'] = asset
        saved = client.put('/api/projects/demo', json=project).json()
        assert asset not in export_html(app.state.storage, bundle).body.decode()
        client.post('/api/projects/demo/publish', json={'revision': saved['revision']})
        result = export_html(app.state.storage, bundle)
        document = result.body.decode()
        assert '</script><script>alert(1)' not in document
        payload = json.loads(re.search(r'window.__SPACE_OFFLINE__=(.*?);</script>', document).group(1))
        assert payload['project']['title'] == project['title']
        assert list(payload['assets']) == [asset]
        assert payload['assets'][asset].startswith('data:image/jpeg;base64,')
        assert 'attachment;' in result.headers['content-disposition']
        saved['title'] = 'PRIVATE_DRAFT'
        client.put('/api/projects/demo', json=saved)
        assert 'PRIVATE_DRAFT' not in export_html(app.state.storage, bundle).body.decode()
        filename, _ = app.state.storage.get_asset(asset)
        (tmp_path / 'media' / filename).unlink()
        with pytest.raises(HTTPException) as error:
            export_html(app.state.storage, bundle)
        assert error.value.status_code == 409


def test_export_missing_build_and_size_limit(tmp_path, monkeypatch):
    app = create_app(tmp_path / 'space.db', 'test-password')
    with pytest.raises(HTTPException) as error:
        export_html(app.state.storage, tmp_path)
    assert error.value.status_code == 503
    (tmp_path / 'app.js').write_text('void 0;', encoding='utf-8')
    (tmp_path / 'app.css').write_text('body{}', encoding='utf-8')
    monkeypatch.setattr('backend.app.offline.MAX_EXPORT_BYTES', 10)
    with pytest.raises(HTTPException) as error:
        export_html(app.state.storage, tmp_path)
    assert error.value.status_code == 413

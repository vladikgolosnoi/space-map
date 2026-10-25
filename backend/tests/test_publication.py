import io
from fastapi.testclient import TestClient
from PIL import Image
from backend.app.main import create_app


def test_private_draft_atomic_publication_and_asset_lifetime(tmp_path):
    app = create_app(tmp_path / 'space.db', 'test-password')
    with TestClient(app) as admin, TestClient(app) as visitor:
        original = visitor.get('/api/projects/demo').json()
        assert visitor.get('/api/projects/demo?view=draft').status_code == 401
        assert visitor.post('/api/projects/demo/publish', json={'revision':1}).status_code == 401
        admin.post('/api/session', json={'password':'test-password'})
        image = io.BytesIO(); Image.new('RGB', (400,300), 'white').save(image,'PNG')
        asset = admin.post('/api/plan-import', files={'file':('plan.png',image.getvalue(),'image/png')}).json()['assetId']
        draft = dict(original)
        draft['title'] = 'Неопубликованное название'
        draft['floors'][0]['backgroundAssetId'] = asset
        next(e for e in draft['edges'] if e['id']=='elevator-f1-f2')['blocked'] = True
        saved = admin.put('/api/projects/demo', json=draft).json()
        assert visitor.get('/api/projects/demo').json()['title'] != saved['title']
        assert visitor.get('/api/assets/'+asset).status_code == 404
        args = {'startId':'f1-entrance','endId':'f2-orbit','profile':'accessible'}
        assert visitor.post('/api/projects/demo/route', json=args).status_code == 200
        assert admin.post('/api/projects/demo/route?view=draft', json=args).status_code == 404
        assert admin.post('/api/projects/demo/publish', json={'revision':1}).status_code == 409
        assert admin.post('/api/projects/demo/publish', json={'revision':saved['revision']}, headers={'Origin':'https://evil.example'}).status_code == 403
        assert admin.post('/api/projects/demo/publish', json={'revision':saved['revision']}).status_code == 200
        assert visitor.get('/api/projects/demo').json()['title'] == saved['title']
        assert visitor.post('/api/projects/demo/route', json=args).status_code == 404
        assert visitor.get('/api/assets/'+asset).status_code == 200
        saved['floors'][0]['backgroundAssetId'] = None
        removed = admin.put('/api/projects/demo', json=saved).json()
        assert visitor.get('/api/assets/'+asset).status_code == 200
        assert admin.post('/api/projects/demo/publish', json={'revision':removed['revision']}).status_code == 200
        assert visitor.get('/api/assets/'+asset).status_code == 404
        assert visitor.get('/editor/demo').headers['x-frame-options'] == 'SAMEORIGIN'
        assert visitor.get('/embed/demo').headers['content-security-policy'] == 'frame-ancestors *'
    with TestClient(create_app(tmp_path / 'space.db', 'test-password')) as reopened:
        assert reopened.get('/api/projects/demo').json()['revision'] == removed['revision']

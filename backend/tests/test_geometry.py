import io
from types import SimpleNamespace as Point

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app.geometry import crosses_room_wall
from backend.app.main import create_app


@pytest.mark.parametrize('start,end,expected', [
    ((20, 20), (80, 80), False),
    ((50, 50), (150, 50), True),
    ((-50, 50), (150, 50), True),
    ((50, 50), (100, 50), False),
    ((100, 50), (150, 50), False),
    ((-50, 0), (150, 0), False),
    ((-50, -50), (0, 0), False),
    ((0, 0), (100, 100), False),
    ((-50, -50), (150, 150), True),
    ((110, 20), (110, 80), False),
])
def test_wall_intersections(start, end, expected):
    assert crosses_room_wall(Point(x=start[0], y=start[1]), Point(x=end[0], y=end[1]), Point(x=0, y=0, width=100, height=100)) == expected


def test_plan_import_access_and_wall_validation(tmp_path):
    with TestClient(create_app(tmp_path / 'space.db', 'test-password')) as client:
        image = io.BytesIO()
        Image.new('RGB', (400, 300), 'white').save(image, 'PNG')
        files = {'file': ('plan.png', image.getvalue(), 'image/png')}
        assert client.post('/api/plan-import', files=files).status_code == 401
        client.post('/api/session', json={'password': 'test-password'})
        assert client.post('/api/plan-import', files=files, headers={'Origin': 'https://evil.example'}).status_code == 403
        response = client.post('/api/plan-import', files=files)
        assert response.status_code == 201
        asset_id = response.json()['assetId']
        project = client.get('/api/projects/demo').json()
        project['floors'][0]['backgroundAssetId'] = asset_id
        # This room boundary is crossed by an existing corridor edge.
        project['rooms'].append({'id':'bad-room', 'floorId':'f1', 'name':'Новая стена', 'kind':'room', 'x':180, 'y':330, 'width':20, 'height':40})
        assert client.put('/api/projects/demo', json=project).status_code == 422
        project['rooms'].pop()
        saved = client.put('/api/projects/demo', json=project)
        assert saved.status_code == 200
        assert client.post('/api/projects/demo/publish', json={'revision': saved.json()['revision']}).status_code == 200
        client.delete('/api/session')
        assert client.get('/api/assets/' + asset_id).status_code == 200
        assert client.get('/api/projects/demo').json()['floors'][0]['backgroundAssetId'] == asset_id

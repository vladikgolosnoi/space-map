import io
import math
import time
from copy import deepcopy
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app.main import create_app
from backend.app.stitching import StitchError, _angular_metadata, _largest_valid_rectangle, stitch_images


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / 'space.db', 'test-password')) as client:
        yield client


def photo(size=(400, 200)):
    output = io.BytesIO()
    Image.new('RGB', size, '#5689ab').save(output, 'JPEG')
    return output.getvalue()


def login(client):
    assert client.post('/api/session', json={'password': 'test-password'}).status_code == 200


def upload(client, **angles):
    return client.post('/api/panorama-import', files={'file': ('photo.jpg', photo(), 'image/jpeg')},
                       data={'haov': 360, 'vaov': 180, 'vOffset': 0, **angles})


def test_assets_visibility_revision_and_projection_integrity(client):
    assert upload(client).status_code == 401
    login(client)
    assert client.post('/api/panorama-import', headers={'Origin': 'https://evil.example'}, content=b'x').status_code == 403
    media = upload(client).json()
    assert client.get('/api/assets/' + media['assetId']).status_code == 200
    project = client.get('/api/projects/demo').json()
    node = project['nodes'][0]
    panorama = {k: v for k, v in media.items() if k != 'warnings'}
    panorama.update(id='p1', name='Test', nodeId=node['id'], floorId=node['floorId'], x=node['x'], y=node['y'], yawOffset=0, hotspots=[])
    client.delete('/api/session')
    assert client.get('/api/assets/' + media['assetId']).status_code == 404
    login(client)
    project['panoramas'] = [panorama]
    panorama['haov'] = 180
    assert client.put('/api/projects/demo', json=project).status_code == 422
    panorama['haov'] = 360
    for hotspot in [
        {'id': 'bad', 'kind': 'scene', 'yaw': 0, 'pitch': 0, 'text': 'Missing', 'targetPanoramaId': 'missing'},
        {'id': 'bad', 'kind': 'info', 'yaw': 0, 'pitch': 0, 'text': 'Missing', 'placeId': 'missing'},
        {'id': 'bad', 'kind': 'scene', 'yaw': 0, 'pitch': 0, 'text': 'Self', 'targetPanoramaId': 'p1'},
    ]:
        invalid = deepcopy(project)
        invalid['panoramas'][0]['hotspots'] = [hotspot]
        assert client.put('/api/projects/demo', json=invalid).status_code == 422
    saved = client.put('/api/projects/demo', json=project)
    assert saved.status_code == 200
    assert client.post("/api/projects/demo/publish", json={"revision": saved.json()["revision"]}).status_code == 200
    assert client.put('/api/projects/demo', json=project).status_code == 409
    client.delete('/api/session')
    response = client.get('/api/assets/' + media['assetId'])
    assert response.status_code == 200
    assert response.headers['x-content-type-options'] == 'nosniff'
    login(client)
    project = saved.json()
    project['panoramas'] = []
    removed = client.put('/api/projects/demo', json=project)
    assert removed.status_code == 200
    assert client.post('/api/projects/demo/publish', json={'revision': removed.json()['revision']}).status_code == 200
    client.delete('/api/session')
    assert client.get('/api/assets/' + media['assetId']).status_code == 404


@pytest.mark.parametrize('angles', [{'haov': 'nan'}, {'vaov': 0}, {'vOffset': 40}, {'haov': 200}])
def test_reject_invalid_projection(client, angles):
    login(client)
    assert upload(client, **angles).status_code == 422


def test_reject_bad_upload_and_release_slot(client):
    login(client)
    assert client.post('/api/panorama-import', files={'file': ('x.jpg', b'not an image')}).status_code == 422
    assert client.post('/api/stitch-jobs', files=[('files', ('x.jpg', photo()))]).status_code == 422
    assert client.app.state.jobs.reserve()
    try:
        assert client.post('/api/stitch-jobs', content=b'').status_code == 429
    finally:
        client.app.state.jobs.release()
    assert client.post('/api/panorama-import', content=b'x', headers={'Content-Length': str(65 * 1024 * 1024)}).status_code == 413


def wait_job(client, job_id):
    deadline = time.monotonic() + 125
    while time.monotonic() < deadline:
        job = client.get('/api/stitch-jobs/' + job_id).json()
        if job['status'] in {'succeeded', 'failed'}:
            return job
        time.sleep(.2)
    pytest.fail('Job did not terminate within its time limit')


def test_blank_series_fails_with_recovery_message(client):
    login(client)
    response = client.post('/api/stitch-jobs', files=[('files', (f'{i}.jpg', photo())) for i in range(2)])
    assert response.status_code == 202
    job = wait_job(client, response.json()['id'])
    assert job['status'] == 'failed'
    assert 'детал' in job['error']
    assert not list(client.app.state.jobs.directory.glob('*'))


def test_real_photographs_stitch_in_child_process(client):
    paths = [Path(f'tmp/fixtures/stitching/boat{i}.jpg') for i in range(1, 4)]
    if not all(path.is_file() for path in paths):
        pytest.skip('Download optional OpenCV photographs with scripts/fetch-stitch-fixtures.py')
    login(client)
    response = client.post('/api/stitch-jobs', files=[('files', (path.name, path.read_bytes(), 'image/jpeg')) for path in paths])
    assert response.status_code == 202
    job = wait_job(client, response.json()['id'])
    assert job['status'] == 'succeeded', job
    result = job['result']
    assert result['sourceCount'] == result['usedImageCount'] == 3
    assert 40 < result['haov'] < 130
    assert 10 < result['vaov'] < 60
    assert math.isclose(result['width'] / result['height'], result['haov'] / result['vaov'])
    assert client.get('/api/assets/' + result['assetId']).status_code == 200


def test_crop_excludes_holes_and_projection_tracks_vertical_crop():
    mask = np.full((100, 150), 255, dtype=np.uint8)
    mask[:5] = 0
    mask[30:40, 60:70] = 0
    x, y, width, height = _largest_valid_rectangle(mask)
    assert width * height > 4000
    assert mask[y:y + height, x:x + width].min() == 255
    metadata = _angular_metadata(200, 100, 100, 100)
    assert math.isclose(metadata['haov'], math.degrees(2))
    assert math.isclose(metadata['vOffset'], 90 - math.degrees(1.495))


def test_invalid_series_count(tmp_path):
    with pytest.raises(StitchError, match='2 до 16'):
        stitch_images([], tmp_path / 'result.jpg')


def test_unrelated_textured_frames_are_not_silently_dropped(tmp_path):
    rng = np.random.default_rng(42)
    paths = []
    for index in range(2):
        path = tmp_path / f'noise{index}.png'
        Image.fromarray(rng.integers(0, 256, size=(500, 600, 3), dtype=np.uint8)).save(path)
        paths.append(path)
    with pytest.raises(StitchError, match='перекрытия'):
        stitch_images(paths, tmp_path / 'output.jpg')
    assert not (tmp_path / 'output.jpg').exists()


def test_restart_marks_interrupted_job_failed(tmp_path):
    app = create_app(tmp_path / 'space.db', 'test-password')
    job_id = 'a' * 32
    app.state.storage.save_job({'id': job_id, 'status': 'running', 'progress': 0})
    with TestClient(app) as client:
        login(client)
        job = client.get('/api/stitch-jobs/' + job_id).json()
        assert job['status'] == 'failed'
        assert 'перезапуском' in job['error']

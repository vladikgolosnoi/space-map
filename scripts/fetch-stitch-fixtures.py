"""Download optional real-photo QA fixtures; do not redistribute with the app."""
import hashlib
from pathlib import Path
from urllib.request import urlopen

HASHES = [
    'c084dab5e87d0c7a018fc6ab75e847621f0809b20a968c42bfb5d58b81303f2e',
    '3bb4e222a5879d2555c3f1109e6b77284b418f378db02e6e86cc414f46fb33ad',
    'dd3c5c15bff43782039aeeff19361251ab9d60b3fb6d1195df6b7dc357e33e65',
]
directory = Path(__file__).resolve().parents[1] / 'tmp' / 'fixtures' / 'stitching'
directory.mkdir(parents=True, exist_ok=True)
for index, expected in enumerate(HASHES, 1):
    path = directory / f'boat{index}.jpg'
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
        print(f'{path.name}: verified')
        continue
    url = f'https://raw.githubusercontent.com/opencv/opencv_extra/4.x/testdata/stitching/boat{index}.jpg'
    with urlopen(url, timeout=30) as response:
        content = response.read(12 * 1024 * 1024)
    if hashlib.sha256(content).hexdigest() != expected:
        raise RuntimeError(f'Unexpected checksum for {url}; inspect upstream before updating.')
    path.write_bytes(content)
    print(f'{path.name}: downloaded and verified')

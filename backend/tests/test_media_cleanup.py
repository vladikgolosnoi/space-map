import json
import os
import sqlite3
import time
from pathlib import Path

import pytest

from scripts.cleanup_media import cleanup_media


def make_database(path: Path, *, document: str | None = None) -> None:
    with sqlite3.connect(path) as connection:
        connection.executescript("""
            CREATE TABLE assets(id TEXT PRIMARY KEY, filename TEXT NOT NULL, metadata TEXT NOT NULL);
            CREATE TABLE projects(id TEXT PRIMARY KEY, revision INTEGER, document TEXT);
            CREATE TABLE publications(id TEXT PRIMARY KEY, revision INTEGER, document TEXT);
            CREATE TABLE spaces(slug TEXT PRIMARY KEY, document TEXT, published_document TEXT);
            CREATE TABLE space_assets(asset_id TEXT PRIMARY KEY, space_slug TEXT);
        """)
        if document:
            connection.execute("INSERT INTO projects VALUES('demo',1,?)", (document,))


def add_asset(database: Path, media: Path, asset_id: str, *, age_days: int, size: int = 8) -> None:
    filename = f"{asset_id}.jpg"
    path = media / filename
    path.write_bytes(b"x" * size)
    old = time.time() - age_days * 24 * 60 * 60
    os.utime(path, (old, old))
    with sqlite3.connect(database) as connection:
        connection.execute("INSERT INTO assets VALUES(?,?,?)", (asset_id, filename, "{}"))


def test_cleanup_dry_run_keeps_files_and_reports_only_old_unreferenced_media(tmp_path):
    database, media = tmp_path / "space.db", tmp_path / "media"
    media.mkdir()
    referenced = "a" * 32
    document = json.dumps({"floors": [{"backgroundAssetId": referenced}], "panoramas": []})
    make_database(database, document=document)
    add_asset(database, media, referenced, age_days=90)
    orphan = "b" * 32
    add_asset(database, media, orphan, age_days=90, size=23)
    recent = "c" * 32
    add_asset(database, media, recent, age_days=2)
    unindexed = media / ("d" * 32 + ".jpg")
    unindexed.write_bytes(b"unindexed")
    old = time.time() - 90 * 24 * 60 * 60
    os.utime(unindexed, (old, old))
    (media / "keep.jpg").write_bytes(b"unrecognized name")

    result = cleanup_media(database, media)

    assert result == {"files": 2, "assets": 1, "bytes": 32, "applied": 0}
    assert (media / f"{referenced}.jpg").is_file()
    assert (media / f"{orphan}.jpg").is_file()
    assert (media / f"{recent}.jpg").is_file()
    assert unindexed.is_file()


def test_apply_removes_only_expired_unreferenced_assets_and_files(tmp_path):
    database, media = tmp_path / "space.db", tmp_path / "media"
    media.mkdir()
    referenced = "a" * 32
    draft = {"floors": [], "panoramas": [{"assetId": referenced, "thumbnailId": "e" * 32}]}
    make_database(database, document=json.dumps(draft))
    add_asset(database, media, referenced, age_days=60)
    add_asset(database, media, "b" * 32, age_days=60)
    add_asset(database, media, "c" * 32, age_days=3)

    result = cleanup_media(database, media, older_than_days=30, apply=True)

    assert result == {"files": 1, "assets": 1, "bytes": 8, "applied": 1}
    with sqlite3.connect(database) as connection:
        rows = {row[0] for row in connection.execute("SELECT id FROM assets")}
    assert rows == {referenced, "c" * 32}
    assert (media / f"{referenced}.jpg").is_file()
    assert not (media / f"{'b' * 32}.jpg").exists()
    assert (media / f"{'c' * 32}.jpg").is_file()


def test_cleanup_stops_on_unreadable_project_without_deleting(tmp_path):
    database, media = tmp_path / "space.db", tmp_path / "media"
    media.mkdir()
    make_database(database, document="not-json")
    add_asset(database, media, "b" * 32, age_days=90)

    with pytest.raises(ValueError, match="unreadable"):
        cleanup_media(database, media, apply=True)
    assert (media / f"{'b' * 32}.jpg").is_file()
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM assets").fetchone()[0] == 1


def test_cleanup_rejects_invalid_retention_and_non_database(tmp_path):
    database, media = tmp_path / "space.db", tmp_path / "media"
    media.mkdir()
    make_database(database)
    with pytest.raises(ValueError, match="between 1 and 3650"):
        cleanup_media(database, media, older_than_days=0)
    with pytest.raises(ValueError, match="does not exist"):
        cleanup_media(tmp_path / "missing.db", media)

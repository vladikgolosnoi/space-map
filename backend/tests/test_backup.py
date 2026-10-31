import io
import sqlite3
import tarfile
from types import SimpleNamespace

import pytest

from scripts.verify_backup import verify_backup


def make_database(path):
    with sqlite3.connect(path) as connection:
        connection.executescript("""
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE projects (id TEXT PRIMARY KEY, revision INTEGER, document TEXT);
            CREATE TABLE publications (id TEXT PRIMARY KEY, revision INTEGER, document TEXT);
            CREATE TABLE assets (id TEXT PRIMARY KEY, filename TEXT NOT NULL, metadata TEXT NOT NULL);
            PRAGMA user_version = 8;
        """)
        connection.execute("INSERT INTO projects VALUES ('space', 1, '{}')")
        connection.execute("INSERT INTO publications VALUES ('space', 1, '{}')")
        connection.execute("INSERT INTO assets VALUES ('asset', 'floor.png', '{}')")


def make_archive(path, filename="media/floor.png", content=b"test image"):
    with tarfile.open(path, "w:gz") as archive:
        info = tarfile.TarInfo(filename)
        info.size = len(content)
        archive.addfile(info, io.BytesIO(content))


def test_backup_restore_check_validates_database_and_restores_media(tmp_path):
    database = tmp_path / "space.db"
    media = tmp_path / "media.tar.gz"
    make_database(database)
    make_archive(media)

    result = verify_backup(database, media)

    assert result == {"schema_version": 8, "documents": 2, "media_files": 1, "assets_checked": 1}
    # The source archive remains unchanged; restore output lives in a temp directory.
    with tarfile.open(media, "r:gz") as archive:
        assert archive.extractfile("media/floor.png").read() == b"test image"


def test_backup_restore_check_rejects_corrupt_database(tmp_path):
    database = tmp_path / "space.db"
    media = tmp_path / "media.tar.gz"
    database.write_bytes(b"not a database")
    make_archive(media)

    with pytest.raises(sqlite3.DatabaseError):
        verify_backup(database, media)


def test_backup_restore_check_rejects_traversal_in_media_archive(tmp_path):
    database = tmp_path / "space.db"
    media = tmp_path / "media.tar.gz"
    make_database(database)
    make_archive(media, "media/../../outside.png")

    with pytest.raises(ValueError, match="Unsafe"):
        verify_backup(database, media)


def test_backup_restore_check_rejects_media_missing_from_archive(tmp_path):
    database = tmp_path / "space.db"
    media = tmp_path / "media.tar.gz"
    make_database(database)
    make_archive(media, "media/other.png")

    with pytest.raises(ValueError, match="missing"):
        verify_backup(database, media)


def test_backup_restore_check_fails_before_copy_when_temp_space_is_insufficient(tmp_path, monkeypatch):
    database = tmp_path / "space.db"
    media = tmp_path / "media.tar.gz"
    make_database(database)
    make_archive(media)
    monkeypatch.setattr("scripts.verify_backup.shutil.disk_usage", lambda _: SimpleNamespace(free=1))

    with pytest.raises(ValueError, match="free space"):
        verify_backup(database, media)

"""Safely rehearse restoring a Space Map SQLite and media backup into a temp dir.

Usage: python scripts/verify_backup.py deploy/backups/space-*.db deploy/backups/media-*.tar.gz
The production data directory is never opened or modified.
"""
from __future__ import annotations

import argparse
import shutil
import sqlite3
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


REQUIRED_TABLES = {"metadata", "projects", "publications"}


def restore_database(backup: Path, destination: Path) -> tuple[int, int]:
    source = sqlite3.connect(f"file:{backup.resolve().as_posix()}?mode=ro", uri=True)
    restored = sqlite3.connect(destination)
    try:
        source.backup(restored)
        integrity = restored.execute("PRAGMA integrity_check").fetchone()
        if not integrity or integrity[0] != "ok":
            raise ValueError("SQLite integrity check failed")
        tables = {row[0] for row in restored.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        missing = REQUIRED_TABLES - tables
        if missing:
            raise ValueError(f"SQLite backup is missing required tables: {', '.join(sorted(missing))}")
        version = restored.execute("PRAGMA user_version").fetchone()[0]
        projects = restored.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
        publications = restored.execute("SELECT COUNT(*) FROM publications").fetchone()[0]
        return version, projects + publications
    finally:
        restored.close()
        source.close()


def restore_media(archive_path: Path, destination: Path) -> int:
    files = 0
    with tarfile.open(archive_path, mode="r:gz") as archive:
        for member in archive:
            relative = PurePosixPath(member.name)
            if (relative.is_absolute() or ".." in relative.parts or not relative.parts
                    or relative.parts[0] != "media" or not (member.isdir() or member.isfile())):
                raise ValueError(f"Unsafe or unsupported media archive entry: {member.name!r}")
            target = destination.joinpath(*relative.parts)
            target.resolve().relative_to(destination.resolve())
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            source = archive.extractfile(member)
            if source is None:
                raise ValueError(f"Unable to read media archive entry: {member.name!r}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            files += 1
    return files


def verify_backup(database: Path, media: Path) -> dict[str, int]:
    if not database.is_file() or not media.is_file():
        raise ValueError("Both a SQLite backup and a media archive must exist")
    with tempfile.TemporaryDirectory(prefix="space-map-restore-check-") as temporary:
        root = Path(temporary)
        version, document_count = restore_database(database, root / "space.db")
        media_files = restore_media(media, root / "data")
        return {"schema_version": version, "documents": document_count, "media_files": media_files}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="SQLite file created by deploy/backup.sh")
    parser.add_argument("media", type=Path, help="media .tar.gz created by deploy/backup.sh")
    args = parser.parse_args()
    try:
        result = verify_backup(args.database, args.media)
    except (OSError, sqlite3.Error, tarfile.TarError, ValueError) as error:
        parser.exit(1, f"Backup restore check failed: {error}\n")
    print("Backup restored and verified in a temporary directory.")
    print(f"SQLite schema version: {result['schema_version']}; documents checked: {result['documents']}")
    print(f"Media files restored: {result['media_files']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

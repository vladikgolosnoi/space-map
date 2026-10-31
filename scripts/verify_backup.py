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


REQUIRED_TABLES = {"metadata", "projects", "publications", "assets"}


def restore_database(backup: Path, destination: Path) -> tuple[int, int, list[str]]:
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
        filenames = [row[0] for row in restored.execute("SELECT filename FROM assets")]
        return version, projects + publications, filenames
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


def inspect_media_archive(archive_path: Path) -> tuple[int, int]:
    """Validate archive members and estimate expanded bytes before writing anything."""
    expanded_bytes = 0
    file_count = 0
    seen: set[str] = set()
    with tarfile.open(archive_path, mode="r:gz") as archive:
        for member in archive:
            relative = PurePosixPath(member.name)
            if (relative.is_absolute() or ".." in relative.parts or not relative.parts
                    or relative.parts[0] != "media" or "\\" in member.name
                    or ":" in member.name or not (member.isdir() or member.isfile())):
                raise ValueError(f"Unsafe or unsupported media archive entry: {member.name!r}")
            normalized = relative.as_posix()
            if normalized in seen:
                raise ValueError(f"Duplicate media archive entry: {member.name!r}")
            seen.add(normalized)
            if member.isfile():
                if member.size < 0:
                    raise ValueError(f"Invalid media file size: {member.name!r}")
                expanded_bytes += member.size
                file_count += 1
    return expanded_bytes, file_count


def ensure_restore_space(database: Path, media_bytes: int) -> None:
    required = database.stat().st_size + media_bytes + 16 * 1024 * 1024
    free = shutil.disk_usage(tempfile.gettempdir()).free
    if free < required:
        raise ValueError(
            f"Not enough free space for a temporary restore: need about {required} bytes, have {free}"
        )


def verify_restored_assets(data_dir: Path, filenames: list[str]) -> int:
    media_root = (data_dir / "media").resolve()
    checked: set[str] = set()
    for filename in filenames:
        if not filename or "\\" in filename:
            raise ValueError("SQLite contains an invalid media filename")
        path = (media_root / filename).resolve()
        try:
            path.relative_to(media_root)
        except ValueError as error:
            raise ValueError("SQLite media filename escapes the media directory") from error
        if path in checked:
            continue
        if not path.is_file():
            raise ValueError(f"Restored media file is missing: {filename}")
        checked.add(path)
    return len(checked)


def verify_backup(database: Path, media: Path) -> dict[str, int]:
    if not database.is_file() or not media.is_file():
        raise ValueError("Both a SQLite backup and a media archive must exist")
    media_bytes, expected_media_files = inspect_media_archive(media)
    ensure_restore_space(database, media_bytes)
    with tempfile.TemporaryDirectory(prefix="space-map-restore-check-") as temporary:
        root = Path(temporary)
        version, document_count, filenames = restore_database(database, root / "space.db")
        media_files = restore_media(media, root / "data")
        if media_files != expected_media_files:
            raise ValueError("The number of extracted media files differs from the archive listing")
        assets_checked = verify_restored_assets(root / "data", filenames)
        return {"schema_version": version, "documents": document_count,
                "media_files": media_files, "assets_checked": assets_checked}


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
    print(f"Media files restored: {result['media_files']}; database references checked: {result['assets_checked']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

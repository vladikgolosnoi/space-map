"""Report or remove aged media that no saved or published map references.

Dry-run is the default. Apply only after reviewing the candidate count and a recent
backup. Example: python scripts/cleanup_media.py /srv/space-map/space.db --apply
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import time
from pathlib import Path


MEDIA_NAME = re.compile(r"^[a-f0-9]{32}\.jpg$")
REQUIRED_TABLES = {"assets", "projects", "publications", "spaces", "space_assets"}


def referenced_asset_ids(connection: sqlite3.Connection) -> set[str]:
    """Return every plan, panorama, and thumbnail ID in drafts or publications."""
    documents: list[str] = []
    for table, columns in (("projects", ("document",)),
                           ("publications", ("document",)),
                           ("spaces", ("document", "published_document"))):
        present = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        for column in columns:
            if column in present:
                documents.extend(row[0] for row in connection.execute(
                    f"SELECT {column} FROM {table} WHERE {column} IS NOT NULL"))

    result: set[str] = set()
    for raw in documents:
        try:
            project = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError("A saved map document is unreadable; cleanup stopped safely") from error
        if not isinstance(project, dict):
            raise ValueError("A saved map document has an invalid shape; cleanup stopped safely")
        floors, panoramas = project.get("floors", []), project.get("panoramas", [])
        if not isinstance(floors, list) or not isinstance(panoramas, list):
            raise ValueError("A saved map document has invalid media references; cleanup stopped safely")
        for floor in floors:
            if not isinstance(floor, dict):
                raise ValueError("A saved map document has invalid floor data; cleanup stopped safely")
            asset_id = floor.get("backgroundAssetId")
            if asset_id:
                result.add(asset_id)
        for panorama in panoramas:
            if not isinstance(panorama, dict):
                raise ValueError("A saved map document has invalid panorama data; cleanup stopped safely")
            for key in ("assetId", "thumbnailId"):
                asset_id = panorama.get(key)
                if asset_id:
                    result.add(asset_id)
    return result


def cleanup_media(database: Path, media_dir: Path, *, older_than_days: int = 30,
                  apply: bool = False) -> dict[str, int]:
    if older_than_days < 1 or older_than_days > 3650:
        raise ValueError("Retention must be between 1 and 3650 days")
    if not database.is_file():
        raise ValueError("SQLite database does not exist")
    media_root = media_dir.resolve(strict=True)
    if not media_root.is_dir():
        raise ValueError("Media path must be a directory")

    connection = sqlite3.connect(database, timeout=30)
    try:
        tables = {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        missing = REQUIRED_TABLES - tables
        if missing:
            raise ValueError(f"SQLite database is missing tables: {', '.join(sorted(missing))}")
        connection.execute("BEGIN IMMEDIATE" if apply else "BEGIN")
        referenced = referenced_asset_ids(connection)
        rows = connection.execute("SELECT id,filename FROM assets").fetchall()
        by_filename: dict[str, list[str]] = {}
        for asset_id, filename in rows:
            by_filename.setdefault(filename, []).append(asset_id)

        cutoff = time.time() - older_than_days * 24 * 60 * 60
        candidates: list[tuple[Path, list[str]]] = []
        for filename, asset_ids in by_filename.items():
            if not MEDIA_NAME.fullmatch(filename) or any(asset_id in referenced for asset_id in asset_ids):
                continue
            path = media_root / filename
            if path.is_symlink() or not path.is_file() or path.stat().st_mtime >= cutoff:
                continue
            candidates.append((path, asset_ids))

        indexed = set(by_filename)
        for path in media_root.iterdir():
            if (MEDIA_NAME.fullmatch(path.name) and path.name not in indexed
                    and not path.is_symlink() and path.is_file()
                    and path.stat().st_mtime < cutoff):
                candidates.append((path, []))

        size_bytes = sum(path.stat().st_size for path, _ in candidates)
        if apply:
            for _, asset_ids in candidates:
                if asset_ids:
                    connection.executemany("DELETE FROM space_assets WHERE asset_id=?",
                                           [(asset_id,) for asset_id in asset_ids])
                    connection.executemany("DELETE FROM assets WHERE id=?",
                                           [(asset_id,) for asset_id in asset_ids])
            connection.commit()
            # Rows are removed first. If unlinking is interrupted, a later dry-run
            # reports the remaining unindexed files without affecting map data.
            for path, _ in candidates:
                path.unlink(missing_ok=True)
        else:
            connection.rollback()
        return {"files": len(candidates), "assets": sum(len(ids) for _, ids in candidates),
                "bytes": size_bytes, "applied": int(apply)}
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="Path to the app's SQLite database")
    parser.add_argument("--media-dir", type=Path, help="Media directory (default: DATABASE/../media)")
    parser.add_argument("--older-than-days", type=int, default=30,
                        help="Keep newer files (default: 30 days; minimum: 1)")
    parser.add_argument("--apply", action="store_true",
                        help="Delete listed unreferenced files; otherwise only report them")
    args = parser.parse_args()
    media_dir = args.media_dir or args.database.parent / "media"
    try:
        result = cleanup_media(args.database, media_dir,
                               older_than_days=args.older_than_days, apply=args.apply)
    except (OSError, sqlite3.Error, ValueError) as error:
        parser.exit(1, f"Media cleanup stopped: {error}\n")
    print("Cleanup applied." if result["applied"] else "Dry run only; no files changed.")
    print(f"Candidates: {result['files']} files ({result['assets']} indexed assets), {result['bytes']} bytes.")
    if result["files"] and not result["applied"]:
        print("Review the database and backup, then rerun with --apply to remove these files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

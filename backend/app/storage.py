"""SQLite persistence with transactional optimistic concurrency."""
from __future__ import annotations

import secrets
import hashlib
import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .models import Project
from .seed import demo_project


class RevisionConflict(ValueError):
    pass


class InvalidAsset(ValueError):
    pass


class Storage:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, expires_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS assets (
                    id TEXT PRIMARY KEY, filename TEXT NOT NULL, metadata TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS stitch_jobs (
                    id TEXT PRIMARY KEY, document TEXT NOT NULL, updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS publications (
                    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
                    password_hash TEXT NOT NULL, created_at REAL NOT NULL, organization TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS organizations (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS organization_members (
                    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','viewer')),
                    joined_at REAL NOT NULL,
                    PRIMARY KEY(organization_id,user_id)
                );
                CREATE TABLE IF NOT EXISTS organization_invites (
                    token_hash TEXT PRIMARY KEY,
                    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                    email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
                    invited_by TEXT NOT NULL REFERENCES users(id), expires_at REAL NOT NULL,
                    created_at REAL NOT NULL, invite_id TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS account_sessions (
                    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    expires_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS spaces (
                    slug TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    title TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL,
                    published_revision INTEGER, published_document TEXT, is_public INTEGER NOT NULL DEFAULT 0,
                    views INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS organization_members_user_idx ON organization_members(user_id);
                CREATE INDEX IF NOT EXISTS spaces_owner_idx ON spaces(owner_id);
                CREATE TABLE IF NOT EXISTS space_assets (
                    asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
                    space_slug TEXT NOT NULL REFERENCES spaces(slug) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS space_views (
                    slug TEXT NOT NULL REFERENCES spaces(slug) ON DELETE CASCADE,
                    visitor_hash TEXT NOT NULL, viewed_at REAL NOT NULL,
                    PRIMARY KEY(slug, visitor_hash)
                );
            """)
            user_columns = {row[1] for row in connection.execute("PRAGMA table_info(users)")}
            if "organization" not in user_columns:
                connection.execute("ALTER TABLE users ADD COLUMN organization TEXT NOT NULL DEFAULT ''")
            space_columns = {row[1] for row in connection.execute("PRAGMA table_info(spaces)")}
            if "organization_id" not in space_columns:
                connection.execute("ALTER TABLE spaces ADD COLUMN organization_id TEXT REFERENCES organizations(id)")
            invite_columns = {row[1] for row in connection.execute("PRAGMA table_info(organization_invites)")}
            if "invite_id" not in invite_columns:
                connection.execute("ALTER TABLE organization_invites ADD COLUMN invite_id TEXT NOT NULL DEFAULT ''")
            for token_hash, in connection.execute("SELECT token_hash FROM organization_invites WHERE invite_id='' OR invite_id IS NULL").fetchall():
                connection.execute("UPDATE organization_invites SET invite_id=? WHERE token_hash=?",
                                   (hashlib.sha256(token_hash.encode("ascii")).hexdigest()[:24], token_hash))
            connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS organization_invites_id_idx ON organization_invites(invite_id)")
            # Idempotent migration: existing accounts and their spaces become personal workspaces.
            for user_id, name, created_at in connection.execute("SELECT id,organization,created_at FROM users").fetchall():
                organization_id = "org-" + user_id
                connection.execute("INSERT OR IGNORE INTO organizations(id,name,created_at) VALUES(?,?,?)",
                                   (organization_id, name.strip() or "Личное пространство", created_at))
                connection.execute("INSERT OR IGNORE INTO organization_members(organization_id,user_id,role,joined_at) VALUES(?,?,?,?)",
                                   (organization_id, user_id, "owner", created_at))
                connection.execute("UPDATE spaces SET organization_id=? WHERE owner_id=? AND organization_id IS NULL",
                                   (organization_id, user_id))
            connection.execute("PRAGMA user_version = 6")
            project = demo_project()
            connection.execute("INSERT OR IGNORE INTO projects VALUES (?, ?, ?)",
                               (project.id, project.revision, project.model_dump_json()))
            connection.execute("INSERT OR IGNORE INTO publications SELECT id, revision, document FROM projects")
            connection.execute("INSERT OR IGNORE INTO metadata VALUES ('session_secret', ?)",
                               (secrets.token_hex(32),))

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10)
        try:
            connection.execute("PRAGMA foreign_keys=ON")
            with connection:
                yield connection
        finally:
            connection.close()

    def secret(self) -> bytes:
        with self.connect() as connection:
            row = connection.execute("SELECT value FROM metadata WHERE key='session_secret'").fetchone()
        return bytes.fromhex(row[0])

    def get_project(self) -> Project:
        with self.connect() as connection:
            row = connection.execute("SELECT document FROM projects WHERE id='demo'").fetchone()
        return Project.model_validate_json(row[0])

    def save_project(self, project: Project) -> Project:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute("SELECT revision FROM projects WHERE id='demo'").fetchone()[0]
            if current != project.revision:
                raise RevisionConflict("Проект изменён в другой сессии. Загрузите актуальную версию.")
            for floor in project.floors:
                if floor.backgroundAssetId:
                    asset = connection.execute("SELECT filename, metadata FROM assets WHERE id=?", (floor.backgroundAssetId,)).fetchone()
                    if not asset or json.loads(asset[1]).get("role") != "plan" or not (self.path.parent / "media" / asset[0]).is_file():
                        raise InvalidAsset("Подложка плана отсутствует. Загрузите изображение заново.")
            for panorama in project.panoramas:
                row = connection.execute("SELECT filename, metadata FROM assets WHERE id=?", (panorama.assetId,)).fetchone()
                thumbnail = connection.execute("SELECT filename, metadata FROM assets WHERE id=?", (panorama.thumbnailId,)).fetchone()
                if not row or not thumbnail:
                    raise InvalidAsset("Изображение панорамы не найдено. Загрузите его заново.")
                metadata, thumbnail_metadata = json.loads(row[1]), json.loads(thumbnail[1])
                if metadata.get("role") != "panorama" or thumbnail_metadata.get("role") != "thumbnail" or metadata.get("thumbnailId") != panorama.thumbnailId:
                    raise InvalidAsset("Панорама и миниатюра не соответствуют друг другу.")
                for key in ("width", "height", "haov", "vaov", "vOffset", "projection", "source"):
                    if metadata.get(key) != getattr(panorama, key):
                        raise InvalidAsset("Метаданные проекции отличаются от загруженного изображения. Импортируйте его заново.")
                if not all((self.path.parent / "media" / value[0]).is_file() for value in (row, thumbnail)):
                    raise InvalidAsset("Файл панорамы отсутствует на диске. Загрузите его заново.")
            saved = project.model_copy(update={"revision": current + 1})
            connection.execute("UPDATE projects SET revision=?, document=? WHERE id='demo'",
                               (saved.revision, saved.model_dump_json()))
        return saved

    def get_published(self) -> Project:
        with self.connect() as connection:
            row = connection.execute("SELECT document FROM publications WHERE id='demo'").fetchone()
        return Project.model_validate_json(row[0])

    def publish(self, revision: int) -> Project:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT revision, document FROM projects WHERE id='demo'").fetchone()
            if row[0] != revision:
                raise RevisionConflict("Черновик изменился. Обновите страницу перед публикацией.")
            project = Project.model_validate_json(row[1])
            asset_ids = [value for p in project.panoramas for value in (p.assetId, p.thumbnailId)] + [f.backgroundAssetId for f in project.floors if f.backgroundAssetId]
            for asset_id in asset_ids:
                asset = connection.execute("SELECT filename FROM assets WHERE id=?", (asset_id,)).fetchone()
                if not asset or not (self.path.parent / 'media' / asset[0]).is_file():
                    raise InvalidAsset("Изображение отсутствует. Восстановите его перед публикацией.")
            connection.execute("UPDATE publications SET revision=?, document=? WHERE id='demo'", (revision, row[1]))
        return project

    def add_session(self, token_hash: str, expires_at: float) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (time.time(),))
            connection.execute("INSERT INTO sessions VALUES (?, ?)", (token_hash, expires_at))

    def has_session(self, token_hash: str) -> bool:
        with self.connect() as connection:
            row = connection.execute("SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?",
                                     (token_hash, time.time())).fetchone()
        return row is not None

    def delete_session(self, token_hash: str) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))

    def create_user(self, user_id: str, email: str, display_name: str, password_hash: str, organization: str = "") -> bool:
        if not display_name.strip():
            return False
        try:
            with self.connect() as connection:
                now = time.time()
                connection.execute("INSERT INTO users(id,email,display_name,password_hash,created_at,organization) VALUES (?, ?, ?, ?, ?, ?)",
                                   (user_id, email, display_name, password_hash, now, organization.strip()))
                org_id = "org-" + user_id
                connection.execute("INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)",
                                   (org_id, organization.strip() or "Личное пространство", now))
                connection.execute("INSERT INTO organization_members(organization_id,user_id,role,joined_at) VALUES(?,?,?,?)",
                                   (org_id, user_id, "owner", now))
            return True
        except sqlite3.IntegrityError:
            return False

    def get_user_by_email(self, email: str) -> dict | None:
        with self.connect() as connection:
            row = connection.execute("SELECT id, email, display_name, password_hash, organization FROM users WHERE email=?", (email,)).fetchone()
        return ({"id": row[0], "email": row[1], "name": row[2], "password_hash": row[3], "organization": row[4]} if row else None)

    def get_user(self, user_id: str) -> dict | None:
        with self.connect() as connection:
            row = connection.execute("SELECT id, email, display_name, organization FROM users WHERE id=?", (user_id,)).fetchone()
        return ({"id": row[0], "email": row[1], "name": row[2], "organization": row[3]} if row else None)

    def add_account_session(self, token_hash: str, user_id: str, expires_at: float) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM account_sessions WHERE expires_at<=?", (time.time(),))
            connection.execute("INSERT INTO account_sessions VALUES (?, ?, ?)", (token_hash, user_id, expires_at))

    def account_user_id(self, token_hash: str) -> str | None:
        with self.connect() as connection:
            row = connection.execute("SELECT user_id FROM account_sessions WHERE token_hash=? AND expires_at>?",
                                     (token_hash, time.time())).fetchone()
        return row[0] if row else None

    def delete_account_session(self, token_hash: str) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM account_sessions WHERE token_hash=?", (token_hash,))

    def create_space(self, owner_id: str, project: Project, organization_id: str | None = None) -> None:
        now = time.time()
        with self.connect() as connection:
            organization_id = organization_id or "org-" + owner_id
            membership = connection.execute("SELECT role FROM organization_members WHERE organization_id=? AND user_id=?", (organization_id, owner_id)).fetchone()
            if not membership or membership[0] not in {"owner", "admin", "editor"}:
                raise PermissionError("Нет права создавать карты в этой команде")
            count = connection.execute("SELECT COUNT(*) FROM spaces WHERE organization_id=?", (organization_id,)).fetchone()[0]
            if count >= 100:
                raise ValueError("В аккаунте уже 100 карт. Удалите ненужные пространства, чтобы создать новое.")
            connection.execute("INSERT INTO spaces(slug, owner_id, title, revision, document, created_at, updated_at, organization_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                               (project.slug, owner_id, project.title, project.revision, project.model_dump_json(), now, now, organization_id))

    def get_space(self, slug: str) -> dict | None:
        with self.connect() as connection:
            row = connection.execute("SELECT owner_id,title,revision,document,published_revision,published_document,is_public,views,created_at,updated_at,organization_id FROM spaces WHERE slug=?", (slug,)).fetchone()
        if not row:
            return None
        return {"owner_id": row[0], "title": row[1], "revision": row[2], "document": row[3],
                "published_revision": row[4], "published_document": row[5], "is_public": bool(row[6]),
                "views": row[7], "created_at": row[8], "updated_at": row[9], "organization_id": row[10]}

    def organizations_for_user(self, user_id: str) -> list[dict]:
        with self.connect() as connection:
            rows = connection.execute("SELECT o.id,o.name,m.role FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.user_id=? ORDER BY m.joined_at", (user_id,)).fetchall()
        return [{"id": row[0], "name": row[1], "role": row[2]} for row in rows]

    def update_member_role(self, organization_id: str, actor_id: str, target_id: str, role: str) -> None:
        if role not in {"admin", "editor", "viewer"}:
            raise ValueError("Недопустимая роль")
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            actor = connection.execute("SELECT role FROM organization_members WHERE organization_id=? AND user_id=?", (organization_id, actor_id)).fetchone()
            target = connection.execute("SELECT role FROM organization_members WHERE organization_id=? AND user_id=?", (organization_id, target_id)).fetchone()
            if not actor or actor[0] not in {"owner", "admin"}:
                raise PermissionError("Изменять роли может владелец или администратор")
            if not target or target[0] == "owner" or (actor[0] != "owner" and target[0] == "admin"):
                raise PermissionError("Нельзя изменить роль этого участника")
            connection.execute("UPDATE organization_members SET role=? WHERE organization_id=? AND user_id=?", (role, organization_id, target_id))

    def remove_member(self, organization_id: str, actor_id: str, target_id: str) -> None:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            actor = connection.execute("SELECT role FROM organization_members WHERE organization_id=? AND user_id=?", (organization_id, actor_id)).fetchone()
            target = connection.execute("SELECT role FROM organization_members WHERE organization_id=? AND user_id=?", (organization_id, target_id)).fetchone()
            if not actor or not target or actor[0] not in {"owner", "admin"}:
                raise PermissionError("Нет прав удалить участника")
            if target[0] == "owner" or (actor[0] != "owner" and target[0] == "admin"):
                raise PermissionError("Владелец и администратор не могут удалить этого участника")
            connection.execute("DELETE FROM organization_members WHERE organization_id=? AND user_id=?", (organization_id, target_id))

    def can_access_space(self, user_id: str | None, slug: str, permission: str = "read") -> bool:
        if not user_id:
            return False
        allowed = ("owner", "admin", "editor") if permission == "write" else ("owner", "admin", "editor", "viewer")
        with self.connect() as connection:
            row = connection.execute("SELECT 1 FROM spaces s JOIN organization_members m ON m.organization_id=s.organization_id WHERE s.slug=? AND m.user_id=? AND m.role IN (%s)" % ",".join("?" for _ in allowed),
                                     (slug, user_id, *allowed)).fetchone()
        return row is not None

    def create_invite(self, organization_id: str, invited_by: str, email: str, role: str, token_hash: str, expires_at: float, invite_id: str) -> None:
        if role not in {"admin", "editor", "viewer"}:
            raise ValueError("Недопустимая роль")
        now = time.time()
        with self.connect() as connection:
            membership = connection.execute("SELECT role FROM organization_members WHERE organization_id=? AND user_id=?", (organization_id, invited_by)).fetchone()
            if not membership or membership[0] not in {"owner", "admin"}:
                raise PermissionError("Приглашать участников может владелец или администратор")
            existing = connection.execute("SELECT 1 FROM organization_members WHERE organization_id=? AND user_id=(SELECT id FROM users WHERE email=?)", (organization_id, email)).fetchone()
            if existing:
                raise ValueError("Этот пользователь уже в команде")
            connection.execute("INSERT INTO organization_invites(token_hash,organization_id,email,role,invited_by,expires_at,created_at,invite_id) VALUES(?,?,?,?,?,?,?,?)",
                               (token_hash, organization_id, email, role, invited_by, expires_at, now, invite_id))

    def list_invites(self, organization_id: str, user_id: str) -> list[dict]:
        now = time.time()
        with self.connect() as connection:
            membership = connection.execute("SELECT role FROM organization_members WHERE organization_id=? AND user_id=?", (organization_id, user_id)).fetchone()
            if not membership or membership[0] not in {"owner", "admin"}:
                raise PermissionError("Управлять приглашениями может владелец или администратор")
            connection.execute("DELETE FROM organization_invites WHERE expires_at<=?", (now,))
            rows = connection.execute("SELECT invite_id,email,role,expires_at,created_at FROM organization_invites WHERE organization_id=? ORDER BY created_at DESC", (organization_id,)).fetchall()
        return [{"id": row[0], "email": row[1], "role": row[2], "expiresAt": row[3], "createdAt": row[4]} for row in rows]

    def revoke_invite(self, organization_id: str, actor_id: str, invite_id: str) -> None:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            membership = connection.execute("SELECT role FROM organization_members WHERE organization_id=? AND user_id=?", (organization_id, actor_id)).fetchone()
            if not membership or membership[0] not in {"owner", "admin"}:
                raise PermissionError("Отозвать приглашение может владелец или администратор")
            cursor = connection.execute("DELETE FROM organization_invites WHERE organization_id=? AND invite_id=?", (organization_id, invite_id))
            if cursor.rowcount == 0:
                raise KeyError("Приглашение уже принято, отозвано или истекло")

    def accept_invite(self, user_id: str, email: str, token_hash: str) -> dict:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            invite = connection.execute("SELECT organization_id,email,role,expires_at FROM organization_invites WHERE token_hash=?", (token_hash,)).fetchone()
            if not invite or invite[3] <= time.time():
                raise KeyError("Приглашение недействительно или истекло")
            if invite[1] != email:
                raise PermissionError("Войдите под адресом, на который отправлено приглашение")
            connection.execute("INSERT OR IGNORE INTO organization_members(organization_id,user_id,role,joined_at) VALUES(?,?,?,?)",
                               (invite[0], user_id, invite[2], time.time()))
            connection.execute("DELETE FROM organization_invites WHERE token_hash=?", (token_hash,))
            org = connection.execute("SELECT id,name FROM organizations WHERE id=?", (invite[0],)).fetchone()
        return {"id": org[0], "name": org[1], "role": invite[2]}

    def list_members(self, organization_id: str, user_id: str) -> list[dict]:
        with self.connect() as connection:
            allowed = connection.execute("SELECT 1 FROM organization_members WHERE organization_id=? AND user_id=?", (organization_id, user_id)).fetchone()
            if not allowed:
                raise PermissionError("Нет доступа к команде")
            rows = connection.execute("SELECT u.id,u.email,u.display_name,m.role FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,u.display_name", (organization_id,)).fetchall()
        return [{"id": r[0], "email": r[1], "name": r[2], "role": r[3]} for r in rows]

    def list_spaces(self, owner_id: str) -> list[dict]:
        with self.connect() as connection:
            rows = connection.execute("SELECT DISTINCT s.slug,s.title,s.revision,s.published_revision,s.is_public,s.views,s.created_at,s.updated_at,m.role,s.organization_id FROM spaces s JOIN organization_members m ON m.organization_id=s.organization_id WHERE m.user_id=? ORDER BY s.updated_at DESC", (owner_id,)).fetchall()
        return [{"slug": r[0], "title": r[1], "revision": r[2], "publishedRevision": r[3],
                 "isPublic": bool(r[4]), "views": r[5], "createdAt": r[6], "updatedAt": r[7], "role": r[8],
                 "organizationId": r[9]} for r in rows]

    def save_space(self, owner_id: str, project: Project) -> Project:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT s.revision FROM spaces s JOIN organization_members m ON m.organization_id=s.organization_id WHERE s.slug=? AND m.user_id=? AND m.role IN ('owner','admin','editor')", (project.slug, owner_id)).fetchone()
            if not row:
                raise KeyError("Пространство не найдено")
            if row[0] != project.revision:
                raise RevisionConflict("Карта уже изменена в другой сессии. Обновите страницу перед сохранением.")
            asset_ids = {asset_id for floor in project.floors if (asset_id := floor.backgroundAssetId)}
            for panorama in project.panoramas:
                asset_ids.update((panorama.assetId, panorama.thumbnailId))
            if asset_ids:
                owned = {item[0] for item in connection.execute("SELECT asset_id FROM space_assets WHERE space_slug=?", (project.slug,)).fetchall()}
                if not asset_ids <= owned:
                    raise InvalidAsset("Одно из изображений не принадлежит этому пространству. Загрузите файл заново.")
            for floor in project.floors:
                if floor.backgroundAssetId:
                    row_asset = connection.execute("SELECT filename,metadata FROM assets WHERE id=?", (floor.backgroundAssetId,)).fetchone()
                    if not row_asset or json.loads(row_asset[1]).get("role") != "plan" or not (self.path.parent / "media" / row_asset[0]).is_file():
                        raise InvalidAsset("Подложка плана не найдена. Загрузите план заново.")
            for panorama in project.panoramas:
                row_asset = connection.execute("SELECT filename,metadata FROM assets WHERE id=?", (panorama.assetId,)).fetchone()
                thumbnail = connection.execute("SELECT filename,metadata FROM assets WHERE id=?", (panorama.thumbnailId,)).fetchone()
                if not row_asset or not thumbnail:
                    raise InvalidAsset("Изображение панорамы не найдено. Загрузите его заново.")
                metadata, thumbnail_metadata = json.loads(row_asset[1]), json.loads(thumbnail[1])
                if metadata.get("role") != "panorama" or thumbnail_metadata.get("role") != "thumbnail" or metadata.get("thumbnailId") != panorama.thumbnailId:
                    raise InvalidAsset("Панорама и миниатюра не соответствуют друг другу. Импортируйте панораму заново.")
                if any(metadata.get(key) != getattr(panorama, key) for key in ("width", "height", "haov", "vaov", "vOffset", "projection", "source")):
                    raise InvalidAsset("Метаданные панорамы изменились. Импортируйте файл заново.")
                if not all((self.path.parent / "media" / asset[0]).is_file() for asset in (row_asset, thumbnail)):
                    raise InvalidAsset("Файл панорамы отсутствует на диске. Загрузите его заново.")
            saved = project.model_copy(update={"revision": project.revision + 1})
            connection.execute("UPDATE spaces SET title=?, revision=?, document=?, updated_at=? WHERE slug=?",
                               (saved.title, saved.revision, saved.model_dump_json(), time.time(), project.slug))
        return saved

    def publish_space(self, owner_id: str, slug: str, revision: int) -> Project:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT s.revision,s.document FROM spaces s JOIN organization_members m ON m.organization_id=s.organization_id WHERE s.slug=? AND m.user_id=? AND m.role IN ('owner','admin')", (slug, owner_id)).fetchone()
            if not row:
                raise KeyError("Пространство не найдено")
            if row[0] != revision:
                raise RevisionConflict("Черновик изменился. Обновите страницу перед публикацией.")
            project = Project.model_validate_json(row[1])
            asset_ids = {floor.backgroundAssetId for floor in project.floors if floor.backgroundAssetId}
            for panorama in project.panoramas:
                asset_ids.update((panorama.assetId, panorama.thumbnailId))
            for asset_id in asset_ids:
                asset = connection.execute("SELECT filename FROM assets WHERE id=?", (asset_id,)).fetchone()
                owned = connection.execute("SELECT 1 FROM space_assets WHERE asset_id=? AND space_slug=?", (asset_id, slug)).fetchone()
                if not asset or not owned or not (self.path.parent / "media" / asset[0]).is_file():
                    raise InvalidAsset("Медиафайл пространства не найден. Восстановите его перед публикацией.")
            connection.execute("UPDATE spaces SET published_revision=?, published_document=?, is_public=1, updated_at=? WHERE slug=?",
                               (revision, row[1], time.time(), slug))
        return Project.model_validate_json(row[1])

    def record_space_view(self, slug: str, visitor_id: str) -> bool:
        visitor_hash = hashlib.sha256(visitor_id.encode("ascii")).hexdigest()
        now = time.time()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM space_views WHERE viewed_at<?", (now - 30 * 24 * 60 * 60,))
            space = connection.execute("SELECT 1 FROM spaces WHERE slug=? AND is_public=1 AND published_document IS NOT NULL", (slug,)).fetchone()
            if not space:
                return False
            row = connection.execute("SELECT viewed_at FROM space_views WHERE slug=? AND visitor_hash=?", (slug, visitor_hash)).fetchone()
            if row and row[0] > now - 1800:
                return False
            connection.execute("INSERT INTO space_views(slug,visitor_hash,viewed_at) VALUES(?,?,?) ON CONFLICT(slug,visitor_hash) DO UPDATE SET viewed_at=excluded.viewed_at", (slug, visitor_hash, now))
            connection.execute("UPDATE spaces SET views=views+1 WHERE slug=?", (slug,))
            return True

    def add_assets(self, assets: list[tuple[str, str, dict]], space_slug: str | None = None) -> None:
        with self.connect() as connection:
            connection.executemany("INSERT INTO assets VALUES (?, ?, ?)",
                                   [(asset_id, filename, json.dumps(metadata, ensure_ascii=False))
                                    for asset_id, filename, metadata in assets])
            if space_slug:
                connection.executemany("INSERT INTO space_assets(asset_id,space_slug) VALUES(?,?)",
                                       [(asset_id, space_slug) for asset_id, _, _ in assets])

    def get_asset(self, asset_id: str) -> tuple[str, dict] | None:
        with self.connect() as connection:
            row = connection.execute("SELECT filename, metadata FROM assets WHERE id=?", (asset_id,)).fetchone()
        return (row[0], json.loads(row[1])) if row else None

    def asset_is_public(self, asset_id: str) -> bool:
        with self.connect() as connection:
            owner = connection.execute("SELECT space_slug FROM space_assets WHERE asset_id=?", (asset_id,)).fetchone()
            if owner:
                row = connection.execute("SELECT published_document FROM spaces WHERE slug=? AND is_public=1", (owner[0],)).fetchone()
                if not row or not row[0]:
                    return False
                project = Project.model_validate_json(row[0])
                return any(asset_id in (panorama.assetId, panorama.thumbnailId) for panorama in project.panoramas) or any(floor.backgroundAssetId == asset_id for floor in project.floors)
        project = self.get_published()
        return any(asset_id in (panorama.assetId, panorama.thumbnailId) for panorama in project.panoramas) or any(floor.backgroundAssetId == asset_id for floor in project.floors)

    def asset_space_slug(self, asset_id: str) -> str | None:
        with self.connect() as connection:
            row = connection.execute("SELECT space_slug FROM space_assets WHERE asset_id=?", (asset_id,)).fetchone()
        return row[0] if row else None

    def save_job(self, job: dict) -> None:
        with self.connect() as connection:
            connection.execute("INSERT OR REPLACE INTO stitch_jobs VALUES (?, ?, ?)",
                               (job["id"], json.dumps(job, ensure_ascii=False), time.time()))

    def get_job(self, job_id: str) -> dict | None:
        with self.connect() as connection:
            row = connection.execute("SELECT document FROM stitch_jobs WHERE id=?", (job_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def recover_jobs(self) -> None:
        with self.connect() as connection:
            for job_id, document in connection.execute("SELECT id, document FROM stitch_jobs").fetchall():
                job = json.loads(document)
                if job["status"] in {"queued", "running"}:
                    job.update(status="failed", progress=0,
                               error="Сшивка прервана перезапуском сервера. Загрузите серию повторно.")
                    connection.execute("UPDATE stitch_jobs SET document=?, updated_at=? WHERE id=?",
                                       (json.dumps(job, ensure_ascii=False), time.time(), job_id))
